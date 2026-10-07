import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve, isAbsolute } from 'node:path';

import { isSourceAttested } from './source-attestation.mts';
import { appendBrokerEvent } from './event-store.mjs';
import { unsafeContentReason } from './content-safety.mjs';

const SAFE_CLAIM_TYPES = new Set(['fact', 'decision', 'procedure', 'risk', 'result']);
const CLAIM_TYPES = new Set([
  ...SAFE_CLAIM_TYPES,
  'question',
  'hypothesis',
  'write'
]);
const AUTO_EVIDENCE = new Set(['canonical-artifact', 'observed-tool-result']);
const EVIDENCE_CLASSES = new Set([...AUTO_EVIDENCE, 'agent-handoff']);
const VERIFICATIONS = new Set(['verified', 'unverified']);
const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const RELATION = /^[a-z][a-z0-9-]{0,31}:[a-f0-9]{64}$/u;
const BATCH_FIELDS = new Set([
  'schemaVersion',
  'batchId',
  'expectedSnapshotHash',
  'scope',
  'relationKeys',
  'claims'
]);
const SCOPE_FIELDS = new Set(['kind', 'key']);
const CLAIM_FIELDS = new Set([
  'claimKey',
  'claimType',
  'subject',
  'predicate',
  'value',
  'observedAt',
  'confidence',
  'sensitivity',
  'evidenceClass',
  'verification',
  'freshness',
  'expectedCurrentClaimId',
  'canonicalRefs',
  'provenance'
]);
const REQUIRED_CLAIM_FIELDS = new Set(
  [...CLAIM_FIELDS].filter((field) => field !== 'freshness')
);
const PROVENANCE_FIELDS = new Set([
  'provider',
  'sessionKey',
  'recordKey',
  'sourceHash'
]);
const DEFAULTS = Object.freeze({
  confidenceThreshold: 0.9,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  lockStaleMs: 600000,
  processedBatchLimit: 256
});

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

export function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function withLock(path, options, action) {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  let descriptor;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx');
      writeFileSync(descriptor, JSON.stringify({
        processId: process.pid,
        acquiredAt: new Date().toISOString()
      }));
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }
      try {
        if (Date.now() - statSync(path).mtimeMs > options.lockStaleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error('Reconciliation state is busy.');
      }
      await delay(options.lockRetryMs);
    }
  }

  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function initialState() {
  return {
    schemaVersion: 1,
    revision: 0,
    updatedAt: new Date(0).toISOString(),
    scopes: {},
    batches: {},
    tombstones: {},
    pendingWithdrawals: []
  };
}

export function loadState(path) {
  const state = readJson(path, initialState());
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.revision) ||
    !state.scopes ||
    !state.batches ||
    (state.tombstones !== undefined && !isRecord(state.tombstones)) ||
    (state.pendingWithdrawals !== undefined && !Array.isArray(state.pendingWithdrawals))
  ) {
    throw new Error('Unsupported reconciliation state.');
  }
  return state;
}

/** @param {string} root @param {string} id */
function manifestPath(root, id) {
  if (!/^[a-f0-9-]{36}$/u.test(id)) throw new Error('Invalid withdrawal identifier.');
  return join(root, 'withdrawals', `${id}.manifest.json`);
}

/** @param {string} root @param {any} entry */
function manifestFile(root, entry) {
  if (typeof entry?.path !== 'string' || !entry.path || isAbsolute(entry.path)) throw new Error('Invalid withdrawal path.');
  return resolve(root, entry.path);
}

/** Only sweep write directories protected by the reconciliation lock. @param {string} root */
function sweepWithdrawalTemps(root) {
  const folders = new Set([root, join(root, 'withdrawals'), join(root, 'snapshots'), join(root, 'outbox', 'pending'),
    join(root, 'outbox', 'delivered'),
    join(root, 'review'), join(root, 'withdrawals', 'reinstatements')]);
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) {
      if (folder === root && !name.startsWith('.state.json.') && !name.startsWith('.accepted-snapshots.json.')) continue;
      if (/^\..+\.json\.\d+\.[a-f0-9-]{36}\.tmp$/u.test(name)) unlinkSync(join(folder, name));
    }
  }
}

/** Run only while holding the reconciliation lock. A receipt makes retries harmless. */
/** @param {string} root */
export function resumeWithdrawalDeletes(root) {
  const statePath = join(root, 'state.json');
  const state = loadState(statePath);
  sweepWithdrawalTemps(root);
  for (const id of state.pendingWithdrawals ?? []) {
    const manifest = readJson(manifestPath(root, id), null);
    if (!manifest || manifest.withdrawalId !== id || !Array.isArray(manifest.claimFiles) ||
        !Array.isArray(manifest.reviews) || !Array.isArray(manifest.auditArtifacts)) {
      throw new Error('Pending withdrawal manifest is missing or invalid.');
    }
    const surviving = new Set(Object.values(state.scopes).flatMap(scope =>
      Object.values(scope.claimIndex).map(item => item.claimId)));
    for (const entry of manifest.claimFiles) {
      if (surviving.has(entry.claimId)) continue;
      const path = manifestFile(root, entry);
      if (existsSync(path)) {
        if (hash(readFileSync(path, 'utf8')) !== entry.fileHash) throw new Error('Withdrawal claim file changed.');
        unlinkSync(path);
      }
    }
    for (const entry of manifest.reviews) {
      const path = manifestFile(root, entry);
      if (!existsSync(path)) continue;
      const review = readJson(path, null);
      if (review?.scopeKey !== entry.scopeKey || !Array.isArray(review.candidateClaims)) throw new Error('Withdrawal review changed.');
      const keys = new Set(entry.claimKeyHashes);
      const keep = review.candidateClaims.filter((/** @type {any} */ candidate) => !keys.has(candidate?.claimKey));
      if (keep.length !== review.candidateClaims.length && hash(readFileSync(path, 'utf8')) !== entry.fileHash) {
        throw new Error('Withdrawal review changed.');
      }
      if (keep.length !== review.candidateClaims.length) writeJson(path, {
        ...review, candidateClaims: keep,
        withdrawnCandidateCount: (review.withdrawnCandidateCount ?? 0) + review.candidateClaims.length - keep.length
      });
    }
    for (const entry of manifest.auditArtifacts) {
      const path = manifestFile(root, entry);
      if (existsSync(path)) {
        if (hash(readFileSync(path, 'utf8')) !== entry.fileHash) throw new Error('Withdrawal audit artifact changed.');
        unlinkSync(path);
      }
    }
    if (manifest.claimFiles.some((/** @type {any} */ entry) => !surviving.has(entry.claimId) && existsSync(manifestFile(root, entry))) ||
        manifest.auditArtifacts.some((/** @type {any} */ entry) => existsSync(manifestFile(root, entry)))) throw new Error('Withdrawal cleanup incomplete.');
    sweepWithdrawalTemps(root);
    writeJson(join(root, 'withdrawals', `${id}.json`), {
      schemaVersion: 1, withdrawalId: id, withdrawnAt: manifest.withdrawnAt,
      reasonHash: manifest.reasonHash, claims: manifest.claims, deletes: manifest.deletes,
      ambiguousClaimIds: manifest.ambiguousClaimIds
    });
    state.pendingWithdrawals = state.pendingWithdrawals.filter((/** @type {string} */ pending) => pending !== id);
    writeJson(statePath, state);
  }
  return state;
}

/** Explicitly allow future claims for one withdrawn scope/key pair. */
/** @param {{ runtimeRoot: string; scopeKey: string; claimKeyHash: string; execute: boolean }} options */
export async function reinstateClaim({ runtimeRoot, scopeKey: key, claimKeyHash, execute }) {
  if (execute !== true || typeof key !== 'string' || !HASH.test(claimKeyHash ?? '')) throw new Error('Reinstatement requires execute and a scope/key hash.');
  const root = resolve(runtimeRoot);
  return withLock(join(root, 'state.lock'), DEFAULTS, async () => {
    const state = resumeWithdrawalDeletes(root);
    const tombstone = state.tombstones?.[key]?.[claimKeyHash];
    if (!tombstone) throw new Error('Tombstone not found.');
    delete state.tombstones[key][claimKeyHash];
    if (Object.keys(state.tombstones[key]).length === 0) delete state.tombstones[key];
    state.revision += 1;
    state.updatedAt = new Date().toISOString();
    writeJson(join(root, 'state.json'), state);
    const receipt = { schemaVersion: 1, scopeKey: key, claimKeyHash, withdrawalId: tombstone.withdrawalId, at: state.updatedAt };
    writeJson(join(root, 'withdrawals', 'reinstatements', `${randomUUID()}.json`), receipt);
    return receipt;
  });
}

export function currentScopeContext(inputOptions = {}) {
  if (!inputOptions.runtimeRoot || !isRecord(inputOptions.scope)) {
    throw new Error('Current scope context requires runtimeRoot and scope.');
  }
  const state = loadState(join(resolve(inputOptions.runtimeRoot), 'state.json'));
  const current = state.scopes[scopeKey(inputOptions.scope)] ?? null;
  return {
    snapshotHash: current?.snapshotHash ?? null,
    claimIds: Object.fromEntries(
      Object.entries(current?.claimIndex ?? {}).map(([key, value]) => [key, value.claimId])
    )
  };
}

function scopeKey(scope) {
  return `${scope.kind}:${hash(scope.key)}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validateObjectShape(issues, value, allowed, required, prefix, claimKey = null) {
  if (!isRecord(value)) {
    issues.push(issue(`${prefix}-object`, 'blocked', claimKey));
    return false;
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    issues.push(issue(`${prefix}-unknown-fields`, 'blocked', claimKey));
  }
  if ([...required].some((key) => !hasOwn(value, key))) {
    issues.push(issue(`${prefix}-missing-fields`, 'blocked', claimKey));
  }
  return true;
}

function issue(code, disposition, claimKey = null) {
  return { code, disposition, claimKeyHash: claimKey ? hash(claimKey) : null };
}

function validateBatch(batch, confidenceThreshold) {
  const issues = [];
  const batchIsRecord = validateObjectShape(
    issues,
    batch,
    BATCH_FIELDS,
    BATCH_FIELDS,
    'batch'
  );
  const unsafeReason = unsafeContentReason(batch);
  if (unsafeReason) {
    issues.push(issue(`unsafe-${unsafeReason}`, 'blocked'));
  }
  if (!batchIsRecord) {
    return issues;
  }

  if (batch.schemaVersion !== 1) issues.push(issue('schema-version', 'blocked'));
  if (typeof batch.batchId !== 'string' || batch.batchId.length === 0) {
    issues.push(issue('batch-id', 'blocked'));
  }
  if (!(batch.expectedSnapshotHash === null || HASH.test(batch.expectedSnapshotHash ?? ''))) {
    issues.push(issue('expected-snapshot-hash', 'blocked'));
  }
  const scopeIsRecord = validateObjectShape(
    issues,
    batch.scope,
    SCOPE_FIELDS,
    SCOPE_FIELDS,
    'scope'
  );
  if (scopeIsRecord) {
    if (!['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(batch.scope.kind)) {
      issues.push(issue('scope-kind', 'blocked'));
    }
    if (typeof batch.scope.key !== 'string' || batch.scope.key.length === 0) {
      issues.push(issue('scope-key', 'blocked'));
    }
  }
  if (!Array.isArray(batch.relationKeys) ||
      batch.relationKeys.length === 0 ||
      batch.relationKeys.some((key) => !RELATION.test(key)) ||
      new Set(batch.relationKeys).size !== batch.relationKeys.length) {
    issues.push(issue('relation-keys', 'blocked'));
  }
  if (!Array.isArray(batch.claims) || batch.claims.length === 0) {
    issues.push(issue('claims-empty', 'blocked'));
    return issues;
  }

  const claimKeys = new Set();
  for (const claim of batch.claims) {
    const key = isRecord(claim) && typeof claim.claimKey === 'string'
      ? claim.claimKey
      : null;
    if (!validateObjectShape(
      issues,
      claim,
      CLAIM_FIELDS,
      REQUIRED_CLAIM_FIELDS,
      'claim',
      key
    )) {
      continue;
    }
    if (typeof key !== 'string' || key.length === 0) {
      issues.push(issue('claim-key', 'blocked'));
    } else if (claimKeys.has(key)) {
      issues.push(issue('duplicate-claim-key', 'blocked', key));
    } else {
      claimKeys.add(key);
    }
    if (!CLAIM_TYPES.has(claim.claimType)) {
      issues.push(issue('claim-type', 'blocked', key));
    } else if (!SAFE_CLAIM_TYPES.has(claim.claimType)) {
      issues.push(issue('claim-type-review', 'pending', key));
    }
    for (const field of ['subject', 'predicate']) {
      if (typeof claim[field] !== 'string' || claim[field].length === 0) {
        issues.push(issue(`claim-${field}`, 'blocked', key));
      }
    }
    if (Number.isNaN(Date.parse(claim.observedAt))) {
      issues.push(issue('claim-observed-at', 'blocked', key));
    }
    if (typeof claim.confidence !== 'number' || claim.confidence < 0 || claim.confidence > 1) {
      issues.push(issue('claim-confidence', 'blocked', key));
    } else if (claim.confidence < confidenceThreshold) {
      issues.push(issue('claim-confidence-review', 'pending', key));
    }
    if (!['shared', 'private', 'restricted'].includes(claim.sensitivity)) {
      issues.push(issue('claim-sensitivity', 'blocked', key));
    } else if (claim.sensitivity === 'restricted') {
      issues.push(issue('restricted-review', 'pending', key));
    }
    const evidenceClassIsValid = EVIDENCE_CLASSES.has(claim.evidenceClass);
    const verificationIsValid = VERIFICATIONS.has(claim.verification);
    if (!evidenceClassIsValid) {
      issues.push(issue('evidence-class', 'blocked', key));
    }
    if (!verificationIsValid) {
      issues.push(issue('verification', 'blocked', key));
    }
    if (claim.freshness !== undefined && claim.freshness !== null) {
      const freshness = claim.freshness;
      const freshnessFields = new Set(['policy', 'verifiedAt', 'expiresAt', 'sourceHeadHash']);
      if (!validateObjectShape(
        issues,
        freshness,
        freshnessFields,
        freshnessFields,
        'freshness',
        key
      )) {
        continue;
      }
      const verifiedAt = Date.parse(freshness.verifiedAt);
      const expiresAt = freshness.expiresAt === null ? null : Date.parse(freshness.expiresAt);
      if (!['immutable', 'ttl', 'canonical-head', 'manual'].includes(freshness.policy) ||
          Number.isNaN(verifiedAt) ||
          !(freshness.expiresAt === null || !Number.isNaN(expiresAt)) ||
          !(freshness.sourceHeadHash === null || HASH.test(freshness.sourceHeadHash ?? '')) ||
          (freshness.policy === 'ttl' && expiresAt === null) ||
          (expiresAt !== null && expiresAt <= verifiedAt) ||
          (freshness.policy === 'canonical-head' && freshness.sourceHeadHash === null)) {
        issues.push(issue('freshness-invalid', 'blocked', key));
      }
    }
    if (evidenceClassIsValid && verificationIsValid &&
        (!AUTO_EVIDENCE.has(claim.evidenceClass) || claim.verification !== 'verified')) {
      issues.push(issue('evidence-review', 'pending', key));
    }
    if (!(claim.expectedCurrentClaimId === null ||
          HASH.test(claim.expectedCurrentClaimId ?? ''))) {
      issues.push(issue('claim-expected-current-id', 'blocked', key));
    }
    if (!Array.isArray(claim.canonicalRefs) ||
        claim.canonicalRefs.length === 0 ||
        claim.canonicalRefs.some((reference) => !SAFE_REFERENCE.test(reference)) ||
        new Set(claim.canonicalRefs).size !== claim.canonicalRefs.length) {
      issues.push(issue('canonical-refs', 'blocked', key));
    }
    if (!Array.isArray(claim.provenance) || claim.provenance.length === 0) {
      issues.push(issue('provenance-empty', 'blocked', key));
    } else {
      for (const provenance of claim.provenance) {
        if (!validateObjectShape(
          issues,
          provenance,
          PROVENANCE_FIELDS,
          PROVENANCE_FIELDS,
          'provenance',
          key
        )) {
          continue;
        }
        if (!['codex', 'claude-code'].includes(provenance.provider) ||
            !HASH.test(provenance.sessionKey ?? '') ||
            !HASH.test(provenance.recordKey ?? '') ||
            !HASH.test(provenance.sourceHash ?? '')) {
          issues.push(issue('provenance-invalid', 'blocked', key));
        }
      }
    }
  }
  return issues;
}

function dispositionFor(issues) {
  if (issues.some((item) => item.disposition === 'blocked')) return 'blocked';
  if (issues.some((item) => item.disposition === 'conflicted')) return 'conflicted';
  if (issues.length > 0) return 'pending';
  return 'clean';
}

function analyze(batch, state, options) {
  const issues = validateBatch(batch, options.confidenceThreshold);
  const key = batch?.scope?.kind && batch?.scope?.key ? scopeKey(batch.scope) : null;
  const current = key ? state.scopes[key] : null;
  const expected = batch?.expectedSnapshotHash ?? null;
  const actual = current?.snapshotHash ?? null;

  if (key && expected !== actual) {
    issues.push(issue('snapshot-cas-mismatch', 'conflicted'));
  }

  const currentClaims = current?.claimIndex ?? {};
  const accepted = [];
  const duplicates = [];
  const claims = Array.isArray(batch?.claims) ? batch.claims : [];
  const tombstones = key ? state.tombstones?.[key] ?? {} : {};
  if (options.requireSourceAttestation) {
    if (!options.attestationRuntimeRoot) {
      issues.push(issue('source-attestation-root-missing', 'blocked'));
    } else {
      try {
        for (const claim of claims) {
          if (typeof claim?.claimKey !== 'string' || !Array.isArray(claim.provenance)) continue;
          for (const provenance of claim.provenance) {
            if (!isSourceAttested({
              runtimeRoot: options.attestationRuntimeRoot,
              provenance
            })) {
              issues.push(issue('source-attestation-missing', 'blocked', claim.claimKey));
              break;
            }
          }
        }
      } catch {
        issues.push(issue('source-attestation-store-invalid', 'blocked'));
      }
    }
  }
  for (const claim of claims) {
    if (typeof claim?.claimKey !== 'string') continue;
    if (tombstones[hash(claim.claimKey)]) {
      issues.push(issue('withdrawn', 'blocked', claim.claimKey));
      continue;
    }
    const previous = currentClaims[claim.claimKey];
    const valueHash = hash(stableJson(claim.value));
    const expectedCurrentClaimId = claim.expectedCurrentClaimId;
    if (!(expectedCurrentClaimId === null || HASH.test(expectedCurrentClaimId ?? ''))) {
      continue;
    }
    if (previous?.valueHash === valueHash) {
      if (expectedCurrentClaimId !== null && expectedCurrentClaimId !== previous.claimId) {
        issues.push(issue('claim-cas-mismatch', 'conflicted', claim.claimKey));
        continue;
      }
      duplicates.push(claim.claimKey);
      continue;
    }
    if ((!previous && expectedCurrentClaimId !== null) ||
        (previous && expectedCurrentClaimId !== previous.claimId)) {
      issues.push(issue('claim-cas-mismatch', 'conflicted', claim.claimKey));
      continue;
    }
    accepted.push({ claim, previous, valueHash });
  }

  return {
    scopeKey: key,
    current,
    issues,
    accepted,
    duplicates,
    withdrawnKeys: new Set(claims.filter((/** @type {any} */ claim) => typeof claim?.claimKey === 'string' && tombstones[hash(claim.claimKey)])
      .map((/** @type {any} */ claim) => hash(claim.claimKey))),
    state: dispositionFor(issues)
  };
}

function publicResult(batch, analysis, now, overrides = {}) {
  const reconciliationId = overrides.reconciliationId ?? randomUUID();
  return {
    schemaVersion: 1,
    reconciliationId,
    batchKey: hash(`batch:${batch?.batchId ?? 'invalid'}`),
    checkedAt: now.toISOString(),
    state: analysis.state,
    snapshotId: overrides.snapshotId ?? analysis.current?.snapshotId ?? null,
    snapshotHash: overrides.snapshotHash ?? analysis.current?.snapshotHash ?? null,
    snapshotVersion: overrides.snapshotVersion ?? analysis.current?.version ?? 0,
    acceptedClaimCount: overrides.acceptedClaimCount ?? 0,
    duplicateClaimCount: analysis.duplicates.length,
    issues: analysis.issues,
    automaticRetryAllowed: false,
    writesEnabled: overrides.writesEnabled ?? false
  };
}

function acceptedRegistry(state) {
  return {
    schemaVersion: 1,
    generatedFromRevision: state.revision,
    snapshots: Object.values(state.scopes)
      .sort((left, right) => left.scopeKey.localeCompare(right.scopeKey))
      .map((entry) => ({
        snapshotId: entry.snapshotId,
        state: 'clean',
        digest: entry.snapshotHash,
        relationKeys: entry.relationKeys,
        canonicalRefs: entry.canonicalRefs,
        snapshotHash: entry.snapshotHash,
        version: entry.version
      }))
  };
}

export function synchronizeRegistry(root, state) {
  const path = join(root, 'accepted-snapshots.json');
  const expected = acceptedRegistry(state);
  const current = readJson(path, null);
  if (stableJson(current) !== stableJson(expected)) {
    writeJson(path, expected);
  }
}

function eventFreshness(freshness, checkedAt) {
  if (!freshness) {
    return {
      status: 'unknown',
      policy: 'manual',
      verifiedAt: null,
      expiresAt: null,
      sourceHeadHash: null
    };
  }
  const expiresAt = freshness.expiresAt;
  return {
    status: expiresAt !== null && Date.parse(expiresAt) <= Date.parse(checkedAt)
      ? 'expired'
      : 'current',
    policy: freshness.policy,
    verifiedAt: freshness.verifiedAt,
    expiresAt,
    sourceHeadHash: freshness.sourceHeadHash
  };
}

function reconciliationEvents(batch, analysis, result, claimIndex) {
  if (result.state !== 'clean' || analysis.accepted.length === 0) return [];
  const scope = { kind: batch.scope.kind, keyHash: hash(batch.scope.key) };
  const snapshotRef = `acb://snapshot/${result.snapshotHash}`;
  const events = analysis.accepted.map(({ claim, previous }) => {
    const accepted = claimIndex[claim.claimKey];
    const claimRef = `acb://claim/${accepted.claimId}`;
    return {
      idempotencyKey: hash(`reconcile:${result.batchKey}:${accepted.claimId}`),
      eventType: 'claim.accepted',
      occurredAt: result.checkedAt,
      provider: 'system',
      scope,
      taskKeyHash: batch.scope.kind === 'ticket' ? scope.keyHash : null,
      threadKey: null,
      sourceRefs: [...new Set(
        claim.provenance.map((item) => `acb://source/${item.sourceHash}`)
      )],
      subjectRef: claimRef,
      replacesRef: previous ? `acb://claim/${previous.claimId}` : null,
      evidenceRefs: claim.canonicalRefs.map((item) => `acb://evidence/${hash(item)}`),
      confidence: claim.confidence,
      freshness: eventFreshness(claim.freshness, result.checkedAt),
      sensitivity: claim.sensitivity === 'shared' ? 'shared' : 'private',
      redactionResult: 'clean',
      approvalState: 'approved',
      payload: {
        claimType: claim.claimType,
        predicateHash: hash(claim.predicate),
        snapshotHash: result.snapshotHash,
        valueHash: accepted.valueHash
      }
    };
  });
  events.push({
    idempotencyKey: hash(`reconcile:${result.batchKey}:snapshot:${result.snapshotHash}`),
    eventType: 'snapshot.published',
    occurredAt: result.checkedAt,
    provider: 'system',
    scope,
    taskKeyHash: batch.scope.kind === 'ticket' ? scope.keyHash : null,
    threadKey: null,
    sourceRefs: Object.values(claimIndex).map((item) => `acb://claim/${item.claimId}`),
    subjectRef: snapshotRef,
    replacesRef: analysis.current
      ? `acb://snapshot/${analysis.current.snapshotHash}`
      : null,
    evidenceRefs: [`acb://audit/${hash(result.reconciliationId)}`],
    confidence: 1,
    freshness: {
      status: 'current',
      policy: 'immutable',
      verifiedAt: result.checkedAt,
      expiresAt: null,
      sourceHeadHash: null
    },
    sensitivity: analysis.accepted.some(({ claim }) => claim.sensitivity !== 'shared')
      ? 'private'
      : 'shared',
    redactionResult: 'clean',
    approvalState: 'approved',
    payload: {
      acceptedClaimCount: result.acceptedClaimCount,
      snapshotVersion: result.snapshotVersion
    }
  });
  return events;
}

export function persistOutbox(root, batchKey, result, events) {
  if (events.length === 0) return;
  writeJson(join(root, 'outbox', 'pending', `${batchKey}.json`), {
    schemaVersion: 1,
    batchKey,
    committedResultHash: hash(stableJson(result)),
    events
  });
}

export async function deliverCommittedOutbox(root, state, eventRuntimeRoot) {
  const pendingRoot = join(root, 'outbox', 'pending');
  if (!existsSync(pendingRoot)) return 0;
  let delivered = 0;
  const entries = readdirSync(pendingRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const outbox = readJson(join(pendingRoot, entry.name), null);
    const committed = state.batches[outbox?.batchKey];
    if (!committed || hash(stableJson(committed)) !== outbox.committedResultHash) continue;
    const receiptPath = join(root, 'outbox', 'delivered', entry.name);
    if (existsSync(receiptPath)) continue;
    const eventIds = [];
    for (const event of outbox.events) {
      const appended = await appendBrokerEvent({
        runtimeRoot: eventRuntimeRoot,
        event,
        execute: true
      });
      eventIds.push(appended.eventId);
    }
    writeJson(receiptPath, {
      schemaVersion: 1,
      batchKey: outbox.batchKey,
      committedResultHash: outbox.committedResultHash,
      eventIds
    });
    delivered += 1;
  }
  return delivered;
}

function boundedBatches(batches, limit) {
  const entries = Object.entries(batches)
    .sort((left, right) => left[1].checkedAt.localeCompare(right[1].checkedAt))
    .slice(-limit);
  return Object.fromEntries(entries);
}

function projectKnownFields(value, fields) {
  if (!isRecord(value)) {
    return {};
  }
  return Object.fromEntries(
    [...fields]
      .filter((key) => hasOwn(value, key))
      .map((key) => [key, value[key]])
  );
}

function reviewClaim(claim) {
  const projected = projectKnownFields(claim, CLAIM_FIELDS);
  projected.claimKey = hash(isRecord(claim) ? claim.claimKey ?? 'invalid' : 'invalid');
  if (Array.isArray(projected.provenance)) {
    projected.provenance = projected.provenance.map((item) =>
      projectKnownFields(item, PROVENANCE_FIELDS)
    );
  }
  return projected;
}

function persistReview(root, batch, result, analysis) {
  const containsUnsafe = analysis.issues.some((item) => item.code.startsWith('unsafe-'));
  const relationKeys = Array.isArray(batch?.relationKeys) ? batch.relationKeys : [];
  const claims = Array.isArray(batch?.claims) ? batch.claims : [];
  const review = {
    schemaVersion: 1,
    reviewId: result.reconciliationId,
    checkedAt: result.checkedAt,
    state: result.state,
    batchKey: result.batchKey,
    scopeKey: analysis.scopeKey,
    relationKeys: relationKeys.filter((key) => RELATION.test(key)),
    issues: result.issues,
    candidateClaims: containsUnsafe
      ? []
      : claims.filter((/** @type {any} */ claim) => !analysis.withdrawnKeys.has(hash(claim?.claimKey ?? 'invalid'))).map(reviewClaim),
    payloadSuppressed: containsUnsafe || analysis.withdrawnKeys.size > 0
  };
  writeJson(join(root, 'review', `${review.reviewId}.json`), review);
}

function persistAudit(root, result, batch, analysis) {
  const claims = Array.isArray(batch?.claims) ? batch.claims : [];
  const audit = {
    schemaVersion: 1,
    reconciliationId: result.reconciliationId,
    batchKey: result.batchKey,
    checkedAt: result.checkedAt,
    state: result.state,
    scopeKey: analysis.scopeKey,
    snapshotHash: result.snapshotHash,
    snapshotVersion: result.snapshotVersion,
    claimCount: claims.length,
    acceptedClaimCount: result.acceptedClaimCount,
    duplicateClaimCount: result.duplicateClaimCount,
    issueCodes: result.issues.map((item) => item.code),
    claimFingerprints: claims.map((claim) => hash(stableJson({
      claimKey: claim?.claimKey,
      value: claim?.value,
      provenance: claim?.provenance
    })))
  };
  writeJson(join(root, 'audit', `${audit.reconciliationId}.json`), audit);
}

export function planReconciliation(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  const root = resolve(options.runtimeRoot);
  const state = loadState(join(root, 'state.json'));
  const analysis = analyze(options.batch, state, options);
  return publicResult(options.batch, analysis, options.now ? new Date(options.now) : new Date());
}

export async function reconcileClaimBatch(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true) {
    throw new Error('Reconciliation writes require execute: true.');
  }
  const root = resolve(options.runtimeRoot);
  const statePath = join(root, 'state.json');

  return withLock(join(root, 'state.lock'), options, async () => {
    const state = resumeWithdrawalDeletes(root);
    synchronizeRegistry(root, state);
    await deliverCommittedOutbox(root, state, options.eventRuntimeRoot ?? root);
    const batchKey = hash(`batch:${options.batch?.batchId ?? 'invalid'}`);
    if (state.batches[batchKey]) {
      const replay = state.batches[batchKey];
      const historical = state.historicalBatches?.[batchKey] === true;
      return { ...replay, idempotentReplay: true, ...(historical ? { historical: true } : {}) };
    }

    const now = options.now ? new Date(options.now) : new Date();
    const analysis = analyze(options.batch, state, options);
    let result;

    if (analysis.state !== 'clean') {
      result = publicResult(options.batch, analysis, now, { writesEnabled: true });
      persistReview(root, options.batch, result, analysis);
      persistAudit(root, result, options.batch, analysis);
    } else {
      const previousIndex = analysis.current?.claimIndex ?? {};
      const claimIndex = { ...previousIndex };

      for (const item of analysis.accepted) {
        const acceptedCore = {
          schemaVersion: 1,
          claimKey: item.claim.claimKey,
          claimType: item.claim.claimType,
          subject: item.claim.subject,
          predicate: item.claim.predicate,
          valueHash: item.valueHash,
          observedAt: item.claim.observedAt,
          acceptedAt: now.toISOString(),
          confidence: item.claim.confidence,
          sensitivity: item.claim.sensitivity,
          status: 'accepted',
          ...(item.claim.freshness !== undefined
            ? { freshness: item.claim.freshness }
            : {}),
          supersedes: item.previous?.claimId ?? null,
          canonicalRefs: item.claim.canonicalRefs,
          provenance: item.claim.provenance
        };
        const claimId = hash(stableJson(acceptedCore));
        const acceptedClaim = {
          ...acceptedCore,
          claimId,
          value: item.claim.value,
        };
        writeJson(join(root, 'claims', `${claimId}.json`), acceptedClaim);
        claimIndex[item.claim.claimKey] = {
          claimId,
          valueHash: item.valueHash,
          canonicalRefs: item.claim.canonicalRefs
        };
      }

      if (analysis.accepted.length === 0 && analysis.current) {
        result = publicResult(options.batch, analysis, now, {
          acceptedClaimCount: 0,
          writesEnabled: true
        });
        persistAudit(root, result, options.batch, analysis);
      } else {
        const version = (analysis.current?.version ?? 0) + 1;
        const snapshotCore = {
          schemaVersion: 1,
          snapshotId: randomUUID(),
          version,
          baseSnapshotHash: analysis.current?.snapshotHash ?? null,
          scope: options.batch.scope,
          createdAt: now.toISOString(),
          claimIds: Object.values(claimIndex).map((entry) => entry.claimId).sort(),
          relationKeys: [...new Set(options.batch.relationKeys)].sort(),
          canonicalRefs: [...new Set(
            Object.values(claimIndex).flatMap((entry) => entry.canonicalRefs ?? [])
          )].sort(),
          state: 'clean'
        };
        const snapshotHash = hash(stableJson(snapshotCore));
        const snapshot = { ...snapshotCore, snapshotHash, digest: snapshotHash };
        writeJson(join(root, 'snapshots', `${snapshot.snapshotId}.json`), snapshot);

        result = publicResult(options.batch, analysis, now, {
          snapshotId: snapshot.snapshotId,
          snapshotHash,
          snapshotVersion: version,
          acceptedClaimCount: analysis.accepted.length,
          writesEnabled: true
        });
        persistAudit(root, result, options.batch, analysis);

        state.scopes[analysis.scopeKey] = {
          scopeKey: analysis.scopeKey,
          snapshotId: snapshot.snapshotId,
          snapshotHash,
          version,
          claimIndex,
          relationKeys: snapshot.relationKeys,
          canonicalRefs: snapshot.canonicalRefs
        };
      }
    }

    state.revision += 1;
    state.updatedAt = now.toISOString();
    state.batches[batchKey] = result;
    state.batches = boundedBatches(state.batches, options.processedBatchLimit);
    persistOutbox(
      root,
      batchKey,
      result,
      reconciliationEvents(options.batch, analysis, result, state.scopes[analysis.scopeKey]?.claimIndex ?? {})
    );
    writeJson(statePath, state);
    if (options.testFailPoint === 'after-state') {
      throw new Error('Injected failure after state publication.');
    }
    await deliverCommittedOutbox(root, state, options.eventRuntimeRoot ?? root);
    synchronizeRegistry(root, state);
    return result;
  });
}
