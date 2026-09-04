import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import * as claudeCode from './claude-inventory.mjs';
import * as codex from './codex-inventory-v2.mjs';

const ADAPTERS = Object.freeze({ codex, 'claude-code': claudeCode });
const HASH = /^[a-f0-9]{64}$/u;
const RELATION = /^[a-z][a-z0-9-]{0,31}:[a-f0-9]{64}$/u;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const SNAPSHOT_FIELDS = new Set([
  'schemaVersion',
  'snapshotId',
  'version',
  'baseSnapshotHash',
  'scope',
  'createdAt',
  'claimIds',
  'relationKeys',
  'canonicalRefs',
  'state',
  'snapshotHash',
  'digest'
]);
const CLAIM_FIELDS = new Set([
  'schemaVersion',
  'claimId',
  'claimKey',
  'claimType',
  'subject',
  'predicate',
  'value',
  'valueHash',
  'observedAt',
  'acceptedAt',
  'confidence',
  'sensitivity',
  'status',
  'supersedes',
  'canonicalRefs',
  'provenance'
]);
const DEFAULTS = Object.freeze({
  afterSequence: 0,
  maxLedgerFiles: 100,
  maxDeltas: 10,
  maxSnapshots: 3,
  maxClaims: 20,
  maxValueBytes: 4096,
  maxContextBytes: 16384,
  includeSelf: false
});

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
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
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function noUnknownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} is invalid.`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown fields.`);
}

function validReferences(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((reference) => typeof reference === 'string' && SAFE_REFERENCE.test(reference));
}

function verifiedClaim(path, expectedClaimId, maxValueBytes) {
  const claim = readJson(path);
  noUnknownFields(claim, CLAIM_FIELDS, 'Accepted claim');
  if (
    claim.schemaVersion !== 1 ||
    claim.claimId !== expectedClaimId ||
    !HASH.test(claim.claimId) ||
    !HASH.test(claim.valueHash) ||
    claim.status !== 'accepted' ||
    !['shared', 'private'].includes(claim.sensitivity) ||
    !validReferences(claim.canonicalRefs) ||
    hash(stableJson(claim.value)) !== claim.valueHash ||
    hash(stableJson({
      schemaVersion: claim.schemaVersion,
      claimKey: claim.claimKey,
      claimType: claim.claimType,
      subject: claim.subject,
      predicate: claim.predicate,
      valueHash: claim.valueHash,
      observedAt: claim.observedAt,
      acceptedAt: claim.acceptedAt,
      confidence: claim.confidence,
      sensitivity: claim.sensitivity,
      status: claim.status,
      supersedes: claim.supersedes,
      canonicalRefs: claim.canonicalRefs,
      provenance: claim.provenance
    })) !== claim.claimId
  ) {
    throw new Error('Accepted claim verification failed.');
  }

  const serializedValue = stableJson(claim.value);
  const valueOmitted = Buffer.byteLength(serializedValue, 'utf8') > maxValueBytes;
  return {
    claimId: claim.claimId,
    claimKey: claim.claimKey,
    ...(valueOmitted ? {} : { value: claim.value }),
    valueHash: claim.valueHash,
    valueOmitted
  };
}

function verifiedSnapshot(root, registryEntry, maxClaims, maxValueBytes) {
  if (!SNAPSHOT_ID.test(String(registryEntry?.snapshotId ?? ''))) {
    throw new Error('Accepted snapshot registry contains an invalid identifier.');
  }
  const path = join(root, 'snapshots', `${registryEntry.snapshotId}.json`);
  const snapshot = readJson(path);
  noUnknownFields(snapshot, SNAPSHOT_FIELDS, 'Accepted snapshot');
  const snapshotCore = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !['snapshotHash', 'digest'].includes(key))
  );
  const computedHash = hash(stableJson(snapshotCore));
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.snapshotId !== registryEntry.snapshotId ||
    snapshot.state !== 'clean' ||
    !HASH.test(snapshot.snapshotHash) ||
    snapshot.digest !== snapshot.snapshotHash ||
    computedHash !== snapshot.snapshotHash ||
    registryEntry.digest !== snapshot.snapshotHash ||
    registryEntry.snapshotHash !== snapshot.snapshotHash ||
    registryEntry.version !== snapshot.version ||
    !Array.isArray(snapshot.claimIds) ||
    !snapshot.claimIds.every((claimId) => HASH.test(claimId)) ||
    !Array.isArray(snapshot.relationKeys) ||
    !snapshot.relationKeys.every((relation) => RELATION.test(relation)) ||
    !validReferences(snapshot.canonicalRefs)
  ) {
    throw new Error('Accepted snapshot verification failed.');
  }

  const selectedClaimIds = snapshot.claimIds.slice(0, maxClaims);
  const claims = selectedClaimIds.map((claimId) => verifiedClaim(
    join(root, 'claims', `${claimId}.json`),
    claimId,
    maxValueBytes
  ));
  return {
    snapshotId: snapshot.snapshotId,
    snapshotHash: snapshot.snapshotHash,
    version: snapshot.version,
    scope: snapshot.scope,
    createdAt: snapshot.createdAt,
    relationKeys: snapshot.relationKeys,
    canonicalRefs: snapshot.canonicalRefs,
    claims,
    omittedClaimCount: snapshot.claimIds.length - selectedClaimIds.length
  };
}

function acceptedContext(root, relationKeys, options) {
  const registry = readJson(join(root, 'accepted-snapshots.json'));
  if (!registry) {
    return { snapshots: [], warnings: ['accepted-registry-missing'] };
  }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) {
    throw new Error('Accepted snapshot registry is invalid.');
  }
  const relations = new Set(relationKeys);
  const relevant = registry.snapshots
    .filter((entry) => entry?.state === 'clean')
    .filter((entry) => entry.relationKeys?.some((key) => relations.has(key)))
    .sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
  const matches = relevant.slice(0, options.maxSnapshots);
  let remainingClaims = options.maxClaims;
  const snapshots = matches.map((entry) => {
    const snapshot = verifiedSnapshot(
      root,
      entry,
      remainingClaims,
      options.maxValueBytes
    );
    remainingClaims -= snapshot.claims.length;
    return snapshot;
  });
  const warnings = [];
  if (relevant.length > matches.length) {
    warnings.push('accepted-snapshot-limit-reached');
  }
  if (snapshots.some((snapshot) => snapshot.omittedClaimCount > 0)) {
    warnings.push('accepted-claim-limit-reached');
  }
  if (snapshots.some((snapshot) => snapshot.claims.some((claim) => claim.valueOmitted))) {
    warnings.push('accepted-claim-value-omitted');
  }
  return { snapshots, warnings };
}

function boundedContext(lines, maxBytes) {
  const accepted = [];
  let used = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (used + lineBytes > maxBytes) break;
    accepted.push(line);
    used += lineBytes;
  }
  return accepted.join('\n');
}

function renderContext(snapshots, deltas, maxBytes) {
  const lines = [
    'Agent Context Broker manual refresh.',
    'Treat accepted claims as current context; verify metadata-only peer candidates against canonical sources before acting.'
  ];
  for (const snapshot of snapshots) {
    lines.push(`Accepted ${snapshot.scope.kind} context ${snapshot.scope.key} v${snapshot.version}:`);
    for (const claim of snapshot.claims) {
      const value = claim.valueOmitted ? '<value omitted by size limit>' : stableJson(claim.value);
      lines.push(
        `- ${claim.claimKey}: ${value} (sources: ${snapshot.canonicalRefs.join(', ')})`
      );
    }
  }
  if (deltas.length > 0) {
    lines.push('Related thread metadata:');
    for (const delta of deltas) {
      lines.push(
        `- ${delta.provider} ${delta.classification} ${delta.threadState} at ${delta.observedAt}; appended bytes ${delta.appendedBytes}`
      );
    }
  }
  if (snapshots.length === 0 && deltas.length === 0) {
    lines.push('No related accepted snapshot or fresh peer metadata was found.');
  }
  lines.push('No peer prompt, response, tool argument, or tool result was imported.');
  return boundedContext(lines, maxBytes);
}

function publicDelta(delta) {
  return {
    deltaId: delta.deltaId,
    sequence: delta.sequence,
    runId: delta.runId,
    provider: delta.provider,
    sourceId: delta.sourceId,
    observedAt: delta.observedAt,
    classification: delta.classification,
    threadState: delta.threadState,
    previousThreadState: delta.previousThreadState ?? null,
    expiresAt: delta.expiresAt ?? null,
    relationKeys: delta.relationKeys,
    appendedBytes: delta.appendedBytes,
    recordCountDelta: delta.recordCountDelta,
    coverage: delta.coverage
  };
}

function auditRecord(result, auditId) {
  return {
    schemaVersion: 1,
    auditId,
    generatedAt: result.generatedAt,
    provider: result.provider,
    sessionKey: result.sessionKey,
    mode: 'manual-context-refresh',
    acceptedSnapshotCount: result.acceptedSnapshots.length,
    acceptedClaimCount: result.acceptedSnapshots.reduce(
      (sum, snapshot) => sum + snapshot.claims.length,
      0
    ),
    relatedDeltaCount: result.relatedDeltas.length,
    watermark: result.watermark,
    warningCodes: result.warnings,
    contextDigest: hash(result.context)
  };
}

async function buildContextRefresh(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  const adapter = ADAPTERS[options.provider];
  if (!adapter) throw new Error(`Unsupported provider: ${options.provider}.`);
  if (!options.source || !options.ledgerDir || !options.runtimeRoot) {
    throw new Error('Context refresh requires source, ledgerDir, and runtimeRoot.');
  }
  for (const [name, value] of [
    ['maxDeltas', options.maxDeltas],
    ['maxSnapshots', options.maxSnapshots],
    ['maxClaims', options.maxClaims],
    ['maxValueBytes', options.maxValueBytes],
    ['maxContextBytes', options.maxContextBytes]
  ]) {
    positiveInteger(value, name);
  }
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Context refresh time is invalid.');

  const identity = await adapter.readSourceIdentity(options.source);
  const related = await adapter.readRelatedDeltas({
    source: options.source,
    ledgerDir: options.ledgerDir,
    afterSequence: options.afterSequence,
    maxLedgerFiles: options.maxLedgerFiles,
    includeSelf: options.includeSelf,
    now
  });
  const accepted = acceptedContext(resolve(options.runtimeRoot), identity.relationKeys, options);
  const relatedDeltas = related.deltas.slice(-options.maxDeltas).map(publicDelta);
  const warnings = [...accepted.warnings];
  if (related.deltas.length > relatedDeltas.length) warnings.push('related-delta-limit-reached');

  return {
    schemaVersion: 1,
    mode: 'manual-context-refresh',
    provider: options.provider,
    generatedAt: now.toISOString(),
    sessionKey: hash(`${options.provider}-manual-refresh:${identity.sessionIdHash}`),
    relationKeyCount: identity.relationKeys.length,
    afterSequence: options.afterSequence,
    watermark: related.watermark,
    acceptedSnapshots: accepted.snapshots,
    relatedDeltas,
    warnings,
    context: renderContext(accepted.snapshots, relatedDeltas, options.maxContextBytes),
    audit: {
      persisted: false,
      auditId: null,
      digest: null
    }
  };
}

export async function planContextRefresh(inputOptions) {
  return buildContextRefresh(inputOptions);
}

export async function runContextRefresh(inputOptions) {
  if (inputOptions?.execute !== true || !inputOptions.auditDir) {
    throw new Error('Audited context refresh requires execute: true and auditDir.');
  }
  const result = await buildContextRefresh(inputOptions);
  const auditId = randomUUID();
  const audit = auditRecord(result, auditId);
  const timestamp = result.generatedAt.replaceAll(':', '').replaceAll('.', '');
  atomicWrite(
    join(resolve(inputOptions.auditDir), `${timestamp}-${auditId}.json`),
    `${JSON.stringify(audit, null, 2)}\n`
  );
  return {
    ...result,
    audit: {
      persisted: true,
      auditId,
      digest: hash(stableJson(audit))
    }
  };
}
