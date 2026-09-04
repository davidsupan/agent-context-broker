import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { loadContextProfiles, routeContextProfile } from './context-router.mjs';
import { readPeerProgress } from './peer-progress.mjs';
import { reviewLedgerContext } from './work-ledgers.mjs';

const PROVIDERS = new Set(['codex', 'claude-code']);
const HASH = /^[a-f0-9]{64}$/u;
const SNAPSHOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const THREAD_REF = /^context:\/\/thread\/(?<key>[a-f0-9]{64})$/u;
const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const SNAPSHOT_FIELDS = new Set([
  'schemaVersion', 'snapshotId', 'version', 'baseSnapshotHash', 'scope',
  'createdAt', 'claimIds', 'relationKeys', 'canonicalRefs', 'state',
  'snapshotHash', 'digest'
]);
const CLAIM_FIELDS = new Set([
  'schemaVersion', 'claimId', 'claimKey', 'claimType', 'subject',
  'predicate', 'value', 'valueHash', 'observedAt', 'acceptedAt',
  'confidence', 'sensitivity', 'status', 'supersedes', 'canonicalRefs',
  'provenance', 'freshness'
]);
const DEFAULTS = Object.freeze({
  maxTerms: 12,
  maxTermLength: 80,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  lockStaleMs: 600000
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

function scopeRelation(scopeKind, scopeKey) {
  return `${scopeKind}:${hash(String(scopeKey).toLowerCase())}`;
}

function validateScope(options) {
  if (!['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(options.scopeKind) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/!-]{0,127}$/u.test(options.scopeKey ?? '') ||
      (options.scopeKind === 'ticket' && !/^[A-Z][A-Z0-9]{1,15}-\d+$/u.test(options.scopeKey)) ||
      (options.scopeKind === 'merge-request' &&
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}!\d{1,12}$/u.test(options.scopeKey))) {
    throw new Error('Context query requires a bounded explicit scope.');
  }
}

function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function noUnknownFields(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} is invalid.`);
  }
}

function validReferences(value) {
  return Array.isArray(value) && value.length > 0 &&
    value.every((reference) => typeof reference === 'string' && SAFE_REFERENCE.test(reference));
}

function validFreshness(value) {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 4 ||
      !['immutable', 'ttl', 'canonical-head', 'manual'].includes(value.policy) ||
      Number.isNaN(Date.parse(value.verifiedAt)) ||
      !(value.expiresAt === null || !Number.isNaN(Date.parse(value.expiresAt))) ||
      !(value.sourceHeadHash === null || HASH.test(value.sourceHeadHash ?? ''))) {
    return false;
  }
  const verifiedAt = Date.parse(value.verifiedAt);
  const expiresAt = value.expiresAt === null ? null : Date.parse(value.expiresAt);
  return !(value.policy === 'ttl' && expiresAt === null) &&
    !(expiresAt !== null && expiresAt <= verifiedAt) &&
    !(value.policy === 'canonical-head' && value.sourceHeadHash === null);
}

function freshnessStatus(freshness, now) {
  if (!freshness) return 'unknown';
  if (freshness.expiresAt && Date.parse(freshness.expiresAt) <= now.getTime()) {
    return 'expired';
  }
  return 'current';
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function withFileLock(path, options, action) {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx');
      writeFileSync(descriptor, JSON.stringify({ processId: process.pid, acquiredAt: new Date().toISOString() }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > options.lockStaleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error('Context audit ledger is busy.');
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
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function normalizedTerms(values, options) {
  const terms = [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value).trim().toLowerCase())
    .filter(Boolean))];
  if (terms.length > options.maxTerms ||
      terms.some((term) => term.length > options.maxTermLength)) {
    throw new Error('Context query terms exceed the bounded input limits.');
  }
  return terms;
}

function verifiedClaim(root, expectedClaimId, maxValueBytes, now) {
  const claim = readJson(join(root, 'claims', `${expectedClaimId}.json`));
  noUnknownFields(claim, CLAIM_FIELDS, 'Accepted claim');
  if (claim.schemaVersion !== 1 || claim.claimId !== expectedClaimId ||
      !HASH.test(claim.claimId) || !HASH.test(claim.valueHash) ||
      claim.status !== 'accepted' || !['shared', 'private'].includes(claim.sensitivity) ||
      !validReferences(claim.canonicalRefs) || !Array.isArray(claim.provenance) ||
      !validFreshness(claim.freshness) ||
      claim.provenance.length === 0 ||
      claim.provenance.some((item) => !PROVIDERS.has(item?.provider) ||
        !HASH.test(item?.sessionKey ?? '') || !HASH.test(item?.recordKey ?? '') ||
        !HASH.test(item?.sourceHash ?? '')) ||
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
        ...(Object.hasOwn(claim, 'freshness') ? { freshness: claim.freshness } : {}),
        supersedes: claim.supersedes,
        canonicalRefs: claim.canonicalRefs,
        provenance: claim.provenance
      })) !== claim.claimId) {
    throw new Error('Accepted claim verification failed.');
  }
  const valueBytes = Buffer.byteLength(stableJson(claim.value), 'utf8');
  return {
    ...claim,
    providers: [...new Set(claim.provenance.map((item) => item.provider))].sort(),
    freshnessStatus: freshnessStatus(claim.freshness, now),
    valueOmitted: valueBytes > maxValueBytes
  };
}

function verifiedSnapshot(root, registryEntry, profile, options, now) {
  if (!SNAPSHOT_ID.test(String(registryEntry?.snapshotId ?? ''))) {
    throw new Error('Accepted snapshot registry contains an invalid identifier.');
  }
  const snapshot = readJson(join(root, 'snapshots', `${registryEntry.snapshotId}.json`));
  noUnknownFields(snapshot, SNAPSHOT_FIELDS, 'Accepted snapshot');
  const snapshotCore = Object.fromEntries(
    Object.entries(snapshot).filter(([key]) => !['snapshotHash', 'digest'].includes(key))
  );
  const computedHash = hash(stableJson(snapshotCore));
  if (snapshot.schemaVersion !== 1 || snapshot.snapshotId !== registryEntry.snapshotId ||
      snapshot.state !== 'clean' || !HASH.test(snapshot.snapshotHash) ||
      snapshot.digest !== snapshot.snapshotHash || computedHash !== snapshot.snapshotHash ||
      registryEntry.digest !== snapshot.snapshotHash ||
      registryEntry.snapshotHash !== snapshot.snapshotHash ||
      registryEntry.version !== snapshot.version || !Array.isArray(snapshot.claimIds) ||
      !snapshot.claimIds.every((claimId) => HASH.test(claimId)) ||
      !validReferences(snapshot.canonicalRefs)) {
    throw new Error('Accepted snapshot verification failed.');
  }
  if (!snapshot.relationKeys.includes(scopeRelation(options.scopeKind, options.scopeKey))) {
    throw new Error('Accepted snapshot relations do not match the query scope.');
  }
  const claimReadLimit = Math.min(Math.max(profile.maxClaims * 4, profile.maxClaims), 100);
  return {
    ...snapshot,
    claims: snapshot.claimIds.slice(0, claimReadLimit)
      .map((claimId) => verifiedClaim(root, claimId, profile.maxValueBytes, now)),
    omittedClaimReadCount: Math.max(snapshot.claimIds.length - claimReadLimit, 0)
  };
}

function claimHaystack(claim, snapshot) {
  return [
    claim.claimKey,
    claim.claimType,
    claim.subject,
    claim.predicate,
    stableJson(claim.value),
    ...claim.canonicalRefs,
    snapshot.scope?.kind,
    snapshot.scope?.key
  ].join(' ').toLowerCase();
}

function relevance(claim, snapshot, profile, queryTerms, options) {
  if (!profile.claimTypes.includes(claim.claimType)) return -1;
  if (!profile.crossProvider && !claim.providers.includes(options.provider)) return -1;
  if (!claim.providers.includes(options.provider) && claim.sensitivity !== 'shared') return -1;
  const requiredRelation = options.scopeKind && options.scopeKey
    ? scopeRelation(options.scopeKind, options.scopeKey)
    : null;
  if (requiredRelation && !snapshot.relationKeys.includes(requiredRelation)) return -1;

  const haystack = claimHaystack(claim, snapshot);
  const profileMatches = profile.keywords.filter((term) => haystack.includes(term)).length;
  const queryMatches = queryTerms.filter((term) => haystack.includes(term)).length;
  const exactScope = options.scopeKey && snapshot.scope?.key === options.scopeKey ? 4 : 2;
  if (queryTerms.length > 0 && queryMatches === 0) return -1;
  if (queryTerms.length === 0 && profileMatches === 0 && exactScope === 0) return -1;
  return (queryMatches * 8) + (profileMatches * 2) + exactScope +
    (claim.providers.includes(options.provider) ? 0 : 1);
}

function publicClaim(claim, snapshot, score) {
  return {
    claimId: claim.claimId,
    claimKey: claim.claimKey,
    claimType: claim.claimType,
    subject: claim.subject,
    predicate: claim.predicate,
    ...(claim.valueOmitted ? {} : { value: claim.value }),
    valueHash: claim.valueHash,
    valueOmitted: claim.valueOmitted,
    providers: claim.providers,
    canonicalRefs: claim.canonicalRefs,
    acceptedAt: claim.acceptedAt,
    freshness: claim.freshness ?? null,
    freshnessStatus: claim.freshnessStatus,
    snapshot: {
      snapshotHash: snapshot.snapshotHash,
      version: snapshot.version,
      scope: snapshot.scope
    },
    relevance: score
  };
}

function boundedContext(lines, maxBytes) {
  const accepted = [];
  let bytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(`${line}\n`, 'utf8');
    if (bytes + lineBytes > maxBytes) break;
    accepted.push(line);
    bytes += lineBytes;
  }
  return accepted.join('\n');
}

function renderContext(result, maxBytes) {
  if (result.strictIsolation) {
    return 'Agent Context Broker strict isolation is active. No cross-task or peer-provider context was read or injected.';
  }
  if (!result.profile) {
    return 'No project context profile was selected. No broker context was read or injected.';
  }
  const lines = [
    `Agent Context Broker profile: ${result.profile}.`,
    'Use only the accepted, hash-verified claims below and re-check canonical sources when freshness matters.'
  ];
  for (const claim of result.claims) {
    const value = claim.valueOmitted ? '<value omitted by size limit>' : stableJson(claim.value);
    lines.push(`- ${claim.claimKey}: ${value} [${claim.providers.join('+')}] (${claim.canonicalRefs.join(', ')})`);
  }
  if (result.claims.length === 0) lines.push('No matching accepted claims were found.');
  if (result.peerProgress.length > 0) {
    lines.push('Live peer progress (unverified; verify canonical sources before acting):');
    for (const progress of result.peerProgress) {
      const conflict = progress.conflicted ? ' CONFLICTED' : '';
      lines.push(`- ${progress.work.kind} ${progress.work.key}: ${progress.state}/${progress.stage}${conflict} [${progress.provider}]`);
      lines.push(`  summary: ${progress.summary}`);
      if (progress.changedSurfaces.length > 0) {
        lines.push(`  changed surfaces: ${progress.changedSurfaces.join('; ')}`);
      }
      if (progress.limitations.length > 0) {
        lines.push(`  limitations: ${progress.limitations.join('; ')}`);
      }
      if (progress.nextSteps.length > 0) {
        lines.push(`  next: ${progress.nextSteps.join('; ')}`);
      }
      if (progress.canonicalRefs.length > 0) {
        lines.push(`  verify: ${progress.canonicalRefs.join(', ')}`);
      }
      lines.push(`  freshness: observed ${progress.observedAt}, expires ${progress.expiresAt}`);
    }
  } else {
    lines.push('No matching live peer progress was found.');
  }
  lines.push('No raw peer conversation, prompt, response, transcript, tool argument, tool result, or native session identifier was imported.');
  return boundedContext(lines, maxBytes);
}

function queryAudit(result, options, auditId) {
  return {
    schemaVersion: 1,
    auditId,
    generatedAt: result.generatedAt,
    mode: 'context-query',
    provider: result.provider,
    profile: result.profile,
    strictIsolation: result.strictIsolation,
    routeReason: result.routeReason,
    scopeKind: options.scopeKind ?? null,
    scopeKeyHash: options.scopeKey ? hash(options.scopeKey) : null,
    termDigests: normalizedTerms(options.terms, options).map((term) => hash(term)),
    acceptedClaimCount: result.claims.length,
    peerProgressCount: result.peerProgress.length,
    peerProviderClaimCount: result.claims.filter((claim) =>
      claim.providers.some((provider) => provider !== result.provider)
    ).length,
    peerProviderProgressCount: result.peerProgress.filter((progress) =>
      progress.provider !== result.provider
    ).length,
    peerProgressDigests: result.peerProgress.map((progress) => progress.progressId).sort(),
    snapshotHashes: [...new Set(result.claims.map((claim) => claim.snapshot.snapshotHash))].sort(),
    warningCodes: result.warnings,
    contextDigest: hash(result.context)
  };
}

function ticketLedgerPath(ticketPackageRoot, ticketPackagesRoot, ticketAuditRoot) {
  if (!ticketPackageRoot) return null;
  if (!ticketPackagesRoot) throw new Error('Ticket package auditing requires ticketPackagesRoot.');
  if (!ticketAuditRoot) throw new Error('Ticket package auditing requires a private ticketAuditRoot.');
  const allowedRoot = realpathSync(resolve(ticketPackagesRoot));
  const root = realpathSync(resolve(ticketPackageRoot));
  const pathFromRoot = relative(allowedRoot, root);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('Ticket package root escapes the allowed ticket package directory.');
  }
  if (!/^[A-Z][A-Z0-9]{1,15}-\d+$/u.test(basename(root)) || !existsSync(join(root, 'README.md'))) {
    throw new Error('Ticket package root must be an existing ticket package.');
  }
  const auditRoot = resolve(ticketAuditRoot);
  mkdirSync(auditRoot, { recursive: true });
  const ticketAuditDirectory = resolve(auditRoot, basename(root));
  const auditPathFromRoot = relative(auditRoot, ticketAuditDirectory);
  if (!auditPathFromRoot || auditPathFromRoot.startsWith('..') || isAbsolute(auditPathFromRoot)) {
    throw new Error('Ticket audit root escaped its configured directory.');
  }
  mkdirSync(ticketAuditDirectory, { recursive: true });
  return join(ticketAuditDirectory, 'CONTEXT_LEDGER.jsonl');
}

function reviewLedgerPath(reviewLedgersRoot, scopeKind, scopeKey) {
  if (scopeKind !== 'merge-request') return null;
  if (!reviewLedgersRoot) throw new Error('Merge request auditing requires reviewLedgersRoot.');
  const context = reviewLedgerContext(reviewLedgersRoot, scopeKey, { required: true });
  return join(context.directory, 'CONTEXT_LEDGER.jsonl');
}

function threadLedgerPath(threadAuditRoot, threadRef) {
  if (!threadRef) return null;
  const match = THREAD_REF.exec(threadRef);
  if (!match) throw new Error('Thread audit reference is invalid.');
  if (!threadAuditRoot) throw new Error('Thread auditing requires threadAuditRoot.');
  const root = resolve(threadAuditRoot);
  mkdirSync(root, { recursive: true });
  const directory = resolve(root, match.groups.key);
  const pathFromRoot = relative(root, directory);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error('Thread audit root escaped its configured directory.');
  }
  mkdirSync(directory, { recursive: true });
  return join(directory, 'CONTEXT_LEDGER.jsonl');
}

async function buildContextQuery(inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (!PROVIDERS.has(options.provider)) throw new Error(`Unsupported provider: ${options.provider}.`);
  const profiles = options.profiles ?? loadContextProfiles(options.profilesPath);
  const route = routeContextProfile({
    profiles,
    profileId: options.profileId,
    taskKind: options.taskKind,
    projectScope: options.projectScope,
    strictIsolation: options.strictIsolation
  });
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Context query time is invalid.');
  const terms = normalizedTerms(options.terms, options);
  const base = {
    schemaVersion: 1,
    mode: 'context-query',
    provider: options.provider,
    generatedAt: now.toISOString(),
    profile: route.profile?.id ?? null,
    routeReason: route.reason,
    strictIsolation: route.profile?.id === 'strict-isolation',
    claims: [],
    peerProgress: [],
    warnings: [],
    context: '',
    injection: { payload: '', digest: null, persisted: false, artifact: null },
    audit: {
      persisted: false,
      auditId: null,
      digest: null,
      ticketLedgerPersisted: false,
      reviewLedgerPersisted: false,
      threadLedgerPersisted: false
    }
  };

  if (!route.shouldQuery) {
    base.context = renderContext(base, route.profile?.maxContextBytes ?? 1024);
    base.injection = { payload: base.context, digest: hash(base.context), persisted: false, artifact: null };
    return base;
  }
  if (!options.runtimeRoot) throw new Error('Context query requires runtimeRoot.');
  validateScope(options);
  const root = resolve(options.runtimeRoot);
  if (options.eventRuntimeRoot) {
    const progress = readPeerProgress({
      runtimeRoot: root,
      eventRuntimeRoot: options.eventRuntimeRoot,
      provider: options.provider,
      crossProvider: route.profile.crossProvider,
      scopeKind: options.scopeKind,
      scopeKey: options.scopeKey,
      ticketPackagesRoot: options.ticketPackagesRoot,
      reviewLedgersRoot: options.reviewLedgersRoot,
      terms,
      now,
      maxProgress: Math.min(route.profile.maxClaims, 8)
    });
    base.peerProgress = progress.progress;
    base.warnings.push(...progress.warnings);
  }
  const registry = readJson(join(root, 'accepted-snapshots.json'));
  if (!registry) {
    base.warnings.push('accepted-registry-missing');
    base.context = renderContext(base, route.profile.maxContextBytes);
    base.injection = { payload: base.context, digest: hash(base.context), persisted: false, artifact: null };
    return base;
  }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) {
    throw new Error('Accepted snapshot registry is invalid.');
  }

  const requiredRelation = scopeRelation(options.scopeKind, options.scopeKey);
  const entries = registry.snapshots
    .filter((entry) => entry?.state === 'clean')
    .filter((entry) => Array.isArray(entry.relationKeys) && entry.relationKeys.includes(requiredRelation))
    .sort((left, right) => Number(right.version ?? 0) - Number(left.version ?? 0));
  const selectedEntries = entries.slice(0, route.profile.maxSnapshots);
  if (entries.length > selectedEntries.length) base.warnings.push('accepted-snapshot-limit-reached');
  let claimReadLimitReached = false;
  const candidates = selectedEntries.flatMap((entry) => {
    const snapshot = verifiedSnapshot(root, entry, route.profile, options, now);
    claimReadLimitReached ||= snapshot.omittedClaimReadCount > 0;
    return snapshot.claims.map((claim) => ({
      claim,
      snapshot,
      score: relevance(claim, snapshot, route.profile, terms, options)
    }));
  });
  const staleCandidates = candidates.filter((item) =>
    ['stale', 'expired'].includes(item.claim.freshnessStatus)
  );
  if (staleCandidates.length > 0) base.warnings.push('stale-claim-excluded');
  const currentCandidates = candidates.filter((item) =>
    !['stale', 'expired'].includes(item.claim.freshnessStatus)
  ).filter((item) => item.score >= 0);
  if (claimReadLimitReached) base.warnings.push('accepted-claim-read-limit-reached');
  currentCandidates.sort((left, right) =>
    right.score - left.score ||
    String(right.claim.acceptedAt).localeCompare(String(left.claim.acceptedAt)) ||
    left.claim.claimKey.localeCompare(right.claim.claimKey)
  );
  if (currentCandidates.length > route.profile.maxClaims) base.warnings.push('accepted-claim-limit-reached');
  base.claims = currentCandidates.slice(0, route.profile.maxClaims)
    .map((item) => publicClaim(item.claim, item.snapshot, item.score));
  if (base.claims.some((claim) => claim.valueOmitted)) {
    base.warnings.push('accepted-claim-value-omitted');
  }
  base.context = renderContext(base, route.profile.maxContextBytes);
  base.injection = { payload: base.context, digest: hash(base.context), persisted: false, artifact: null };
  return base;
}

export async function planContextQuery(options) {
  return buildContextQuery(options);
}

export async function runContextQuery(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true || !options.globalAuditDirectory) {
    throw new Error('Audited context query requires execute: true and globalAuditDirectory.');
  }
  const result = await buildContextQuery(options);
  if (result.strictIsolation) {
    return result;
  }
  const auditId = randomUUID();
  const audit = queryAudit(result, options, auditId);
  const timestamp = result.generatedAt.replaceAll(':', '').replaceAll('.', '');
  const globalPath = join(resolve(options.globalAuditDirectory), `${timestamp}-${auditId}.json`);
  atomicWrite(globalPath, `${JSON.stringify(audit, null, 2)}\n`);
  const injectionName = `${timestamp}-${auditId}.json`;
  const injectionPath = join(resolve(options.globalAuditDirectory), 'injections', injectionName);
  atomicWrite(injectionPath, `${JSON.stringify({
    schemaVersion: 1,
    auditId,
    generatedAt: result.generatedAt,
    provider: result.provider,
    profile: result.profile,
    payload: result.context,
    digest: hash(result.context)
  }, null, 2)}\n`);

  const ledgerPath = ticketLedgerPath(options.ticketPackageRoot, options.ticketPackagesRoot, options.ticketAuditRoot);
  if (ledgerPath) {
    await withFileLock(`${ledgerPath}.lock`, options, async () => {
      appendFileSync(ledgerPath, `${JSON.stringify({
        ...audit,
        issueKey: basename(resolve(options.ticketPackageRoot))
      })}\n`, 'utf8');
    });
  }
  const reviewPath = reviewLedgerPath(options.reviewLedgersRoot, options.scopeKind, options.scopeKey);
  if (reviewPath) {
    await withFileLock(`${reviewPath}.lock`, options, async () => {
      appendFileSync(reviewPath, `${JSON.stringify({
        ...audit,
        reviewKey: options.scopeKey
      })}\n`, 'utf8');
    });
  }
  const threadPath = threadLedgerPath(options.threadAuditRoot, options.threadRef);
  if (threadPath) {
    await withFileLock(`${threadPath}.lock`, options, async () => {
      appendFileSync(threadPath, `${JSON.stringify({
        ...audit,
        threadRefHash: hash(options.threadRef)
      })}\n`, 'utf8');
    });
  }

  return {
    ...result,
    injection: {
      payload: result.context,
      digest: hash(result.context),
      persisted: true,
      artifact: `injections/${injectionName}`
    },
    audit: {
      persisted: true,
      auditId,
      digest: hash(stableJson(audit)),
      ticketLedgerPersisted: Boolean(ledgerPath),
      reviewLedgerPersisted: Boolean(reviewPath),
      threadLedgerPersisted: Boolean(threadPath)
    }
  };
}
