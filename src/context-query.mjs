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

import { normalizeAgentDescriptor } from './agent-identity.mts';
import { claimDecision, createContextTrace, persistQueryInjection, traceCounts, traceLayers } from './context-trace.mts';
import { loadContextProfiles, routeContextProfile } from './context-router.mts';
import { readPeerProgress } from './peer-progress.mjs';
import { listContextNotices, noticeCounts } from './context-notices.mjs';
import { sealNoticeLane } from './notice-nonce.mjs';
import { sharedRuntimeHome } from './shared-context.mjs';
import { policyEntry, scopeReadable } from './provider-policy.mjs';
import { loadState } from './reconciliation.mjs';
import { relationsForScope, reviewLedgerContext } from './work-ledgers.mts';

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

function acceptedScopeRelations(options) {
  const primary = scopeRelation(options.scopeKind, options.scopeKey);
  const keys = new Map([[primary, 'primary']]);
  if (!options.scopeKind || !options.scopeKey) return keys;
  // Standing practice is recorded once, at the project the operator configured, and a
  // ticket or review is work inside that project. Without this, a ticket-scoped query
  // reaches parent and linked tickets but never the rules that govern all of them, and
  // the same convention has to be re-recorded per ticket to be readable. The widening is
  // bounded and comes from operator configuration, never from prompt text: exactly one
  // extra scope, always a project, and only for a scope narrower than a project.
  const ambient = options.ambientProjectKey;
  if (ambient && ['ticket', 'merge-request', 'workstream'].includes(options.scopeKind)) {
    const ambientKey = scopeRelation('project', ambient);
    if (!keys.has(ambientKey)) keys.set(ambientKey, 'ambient-project');
  }
  // Related scopes are recorded as hashes, so read rules cannot be checked against them;
  // a provider with read rules sees only the scopes it asked for.
  if (options.scopeExpansion === false) return keys;
  let related = [];
  try {
    related = relationsForScope(
      { kind: options.scopeKind, key: options.scopeKey },
      {
        ticketPackagesRoot: options.ticketPackagesRoot,
        reviewLedgersRoot: options.reviewLedgersRoot,
        requireReviewLedger: false
      }
    ) ?? [];
  } catch {
    // Relation expansion is an enrichment, never a gate: a missing or unreadable
    // ledger must not remove the primary scope from the query.
    related = [];
  }
  for (const relation of related) {
    if (!relation?.kind || !relation?.key) continue;
    const key = scopeRelation(relation.kind, relation.key);
    if (!keys.has(key)) keys.set(key, relation.relationship ?? 'related');
  }
  return keys;
}

export function scopeRelation(scopeKind, scopeKey) {
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

/** One accepted claim, hash-verified; throws when any field or hash does not hold. */
export function verifiedClaim(root, expectedClaimId, maxValueBytes, now) {
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

/**
 * One accepted snapshot file, hash-verified against its registry entry; no scope check, no claims read.
 * @param {string} root
 * @param {any} registryEntry an entry of accepted-snapshots.json, validated here
 * @param {((claimId: string) => void) | null} onFiltered
 */
export function verifiedSnapshotFile(root, registryEntry, onFiltered = null) {
  const statePath = join(root, 'state.json');
  if (!existsSync(statePath)) throw new Error('Reconciliation state is missing.');
  const state = loadState(statePath);
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
  const key = snapshot.scope && typeof snapshot.scope.kind === 'string' && typeof snapshot.scope.key === 'string'
    ? `${snapshot.scope.kind}:${hash(snapshot.scope.key)}` : null;
  if (!key) throw new Error('Accepted snapshot scope is invalid.');
  const current = state.scopes[key]?.claimIndex ?? {};
  const allowed = new Set(Object.entries(current)
    .filter(([claimKey]) => !state.tombstones?.[key]?.[hash(claimKey)])
    .map(([, item]) => item.claimId));
  return { ...snapshot, claimIds: snapshot.claimIds.filter((/** @type {string} */ claimId) => {
    if (allowed.has(claimId)) return true;
    onFiltered?.(claimId);
    return false;
  }) };
}

const SNAPSHOT_ROLE_RANK = { primary: 0, 'ambient-project': 1, 'ambient-global': 2 };

/** Local routing evidence only; never render or query accepted values.
 * @param {string} registryPath @param {string} provider @param {Date} now
 * @returns {Set<string>}
 */
export function acceptedTicketKeysForProvider(registryPath, provider, now) {
  const keys = new Set();
  const registry = readJson(registryPath);
  if (registry?.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) return keys;
  const root = dirname(registryPath);
  for (const entry of registry.snapshots) {
    try {
      const snapshot = verifiedSnapshotFile(root, entry);
      if (snapshot.scope.kind !== 'ticket') continue;
      if (snapshot.claimIds.some((/** @type {string} */ id) =>
        verifiedClaim(root, id, 0, now).providers.includes(provider))) keys.add(snapshot.scope.key);
    } catch {
      // Unverifiable records cannot establish ownership of a prompt-derived key.
    }
  }
  return keys;
}

/**
 * Where a related snapshot ranks before the snapshot cap: by its own scope's role in the query (the requested scope,
 * then the ambient project, then global rules, then any other related scope, then a snapshot related only through
 * its relation keys),
 * then by when it was created. Unreadable snapshots rank last; verification still rejects them if selected.
 * @param {string} root @param {any} entry @param {Map<string, string>} scopeRelations
 */
function snapshotRank(root, entry, scopeRelations) {
  const id = String(entry?.snapshotId ?? '');
  let snapshot = null;
  try { snapshot = SNAPSHOT_ID.test(id) ? readJson(join(root, 'snapshots', `${id}.json`)) : null; } catch { /* Ranks last. */ }
  const scope = snapshot?.scope;
  const own = scope && typeof scope.kind === 'string' && typeof scope.key === 'string'
    ? scopeRelations.get(scopeRelation(scope.kind, scope.key)) : undefined;
  const role = own === undefined ? 4 : (SNAPSHOT_ROLE_RANK[/** @type {keyof typeof SNAPSHOT_ROLE_RANK} */ (own)] ?? 3);
  return { role, scopeRole: own ?? 'related', scopeKind: scope?.kind ?? null,
    unreadable: snapshot === null, createdAt: typeof snapshot?.createdAt === 'string' ? snapshot.createdAt : '' };
}

/**
 * Global rules apply everywhere, so the global-scope snapshots of the registry join every query as ambient scopes,
 * unless the caller turns that off or a provider's read rules do not allow the scope. Their keys are read from the
 * snapshot files; verification still happens on the selected ones.
 * @param {string} root @param {any[]} snapshots @param {any} rule
 * @param {import('./context-trace.mts').ContextTrace | null} trace
 */
function ambientGlobalRelations(root, snapshots, rule, trace) {
  /** @type {string[]} */
  const relations = [];
  for (const entry of snapshots) {
    if (entry?.state !== 'clean' || !SNAPSHOT_ID.test(String(entry?.snapshotId ?? ''))) continue;
    let scope = null;
    try { scope = readJson(join(root, 'snapshots', `${entry.snapshotId}.json`))?.scope ?? null; } catch { continue; }
    if (scope?.kind !== 'global' || typeof scope.key !== 'string') continue;
    if (rule?.read && !scopeReadable(rule, { kind: 'global', key: scope.key })) {
      const relationKey = scopeRelation('global', scope.key);
      if (!trace?.policy.some((item) => item.relationKey === relationKey)) {
        trace?.policy.push({ relationKey, reason: 'ambient-global-denied' });
      }
      continue;
    }
    relations.push(scopeRelation('global', scope.key));
  }
  return relations;
}

/** @param {any} root @param {any} registryEntry @param {any} profile @param {any} options
 * @param {any} now @param {import('./context-trace.mts').ContextTrace | null} trace */
function verifiedSnapshot(root, registryEntry, profile, options, now, trace) {
  const snapshot = verifiedSnapshotFile(root, registryEntry, trace ? (claimId) => {
    // A withdrawn claim is named by its id only: its key and wording left the memory with the withdrawal, and
    // reading a file still awaiting deletion would copy them into the audit.
    trace.candidates.push(claimDecision({ claimId }, registryEntry.snapshotId, null, 'tombstoned'));
  } : null);
  // Fail-closed: the snapshot must still carry a relation the query accepts. The accepted
  // set is the primary scope plus relations derived from trusted ledger files, so this
  // broadens what is in scope without weakening the gate itself.
  const acceptedRelations = options.scopeRelations ?? null;
  const relationMatches = acceptedRelations
    ? snapshot.relationKeys.some((relationKey) => acceptedRelations.has(relationKey))
    : snapshot.relationKeys.includes(scopeRelation(options.scopeKind, options.scopeKey));
  if (!relationMatches) {
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
  const result = relevanceDecision(claim, snapshot, profile, queryTerms, options);
  return result.reason ? -1 : result.score;
}

/** @param {any} claim @param {any} snapshot @param {any} profile @param {any} queryTerms @param {any} options
 * @returns {{ score: number | null, reason: import('./context-trace.mts').ClaimReason | null }} */
function relevanceDecision(claim, snapshot, profile, queryTerms, options) {
  if (!profile.claimTypes.includes(claim.claimType)) return { score: null, reason: 'claim-type' };
  if (!profile.crossProvider && !claim.providers.includes(options.provider)) return { score: null, reason: 'provider' };
  if (!claim.providers.includes(options.provider) && claim.sensitivity !== 'shared') return { score: null, reason: 'private-other-provider' };
  const scopeRelations = options.scopeRelations ?? null;
  if (scopeRelations) {
    if (!snapshot.relationKeys.some((relationKey) => scopeRelations.has(relationKey))) return { score: null, reason: 'relation' };
  } else if (options.scopeKind && options.scopeKey) {
    if (!snapshot.relationKeys.includes(scopeRelation(options.scopeKind, options.scopeKey))) return { score: null, reason: 'relation' };
  }

  const haystack = claimHaystack(claim, snapshot);
  const profileMatches = profile.keywords.filter((term) => haystack.includes(term)).length;
  const queryMatches = queryTerms.filter((term) => haystack.includes(term)).length;
  // Every query carries a bounded explicit scope (validateScope) and a claim reaches this
  // point only through a relation to it, so a claim is either in the exact scope or in a
  // related one; there is no unscoped case left to drop here.
  const exactScope = snapshot.scope?.key === options.scopeKey ? 4 : 2;
  // Terms that match nothing must not silently empty the result for the narrow scope
  // the agent is actually working. This floor is deliberately limited to ticket and
  // merge-request scopes, mirroring progressScore: a project or workstream scope is
  // broad enough that term filtering is what keeps the result usable, and related
  // scopes still require a term match so a parent ticket cannot flood the query.
  const narrowScope = ['ticket', 'merge-request'].includes(options.scopeKind);
  // Global rules are ambient: they apply whatever the task is about, so they skip the term filter and rank below
  // every claim that matched a term.
  const ambientGlobal = snapshot.scope?.kind === 'global' && options.scopeKind !== 'global';
  const score = (queryMatches * 8) + (profileMatches * 2) + exactScope +
    (claim.providers.includes(options.provider) ? 0 : 1);
  if (queryTerms.length > 0 && queryMatches === 0 && !(narrowScope && exactScope >= 4) && !ambientGlobal) {
    return { score, reason: 'term-miss' };
  }
  return { score, reason: null };
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
    // Readers decide what may be copied into shared artifacts, so the label travels with the claim.
    sensitivity: claim.sensitivity,
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

export function renderContext(result, maxBytes, includePeerProgress = true, noticeHome = /** @type {string|null} */ (null)) {
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
  if (result.claims.some((claim) => claim.sensitivity === 'private')) {
    lines.push('Claims marked (private) must not be copied into shared artifacts such as merge requests, issues or wikis.');
  }
  for (const claim of result.claims) {
    const value = claim.valueOmitted ? '<value omitted by size limit>' : stableJson(claim.value);
    const label = claim.sensitivity === 'private' ? ' (private)' : '';
    lines.push(`- ${claim.claimKey}${label}: ${value} [${claim.providers.join('+')}] (${claim.canonicalRefs.join(', ')})`);
  }
  if (result.claims.length === 0) lines.push('No matching accepted claims were found.');
  if (result.teamNotices?.some((/** @type {import('./context-notices.mjs').NoticeView} */ notice) => notice.text)) {
    const lane = result.teamNoticeLane;
    let remaining = maxBytes - lines.reduce((sum, line) => sum + Buffer.byteLength(`${line}\n`), 0);
    const envelopes = [];
    for (const notice of result.teamNotices) {
      if (!notice.text) continue;
      const block = `${envelopes.length ? '' : `${lane.header}\n`}${notice.text}`;
      const bytes = Buffer.byteLength(`${block}\n`);
      if (bytes > remaining) {
        delete notice.text;
        notice.textOmitted = true;
        lane.counts.included--;
        lane.counts.omittedByBudget++;
      } else {
        remaining -= bytes;
        envelopes.push(notice.text);
      }
    }
    if (!envelopes.length) lane.header = '';
    lane.textBytes = envelopes.length ? Buffer.byteLength([lane.header, ...envelopes].join('\n')) : 0;
    sealNoticeLane(lane, result.teamNotices, noticeHome,
      result.claims.map((/** @type {{snapshot: {snapshotHash: string}}} */ claim) => claim.snapshot.snapshotHash), result.warnings);
    let first = true;
    for (const notice of result.teamNotices) {
      if (!notice.text) continue;
      // The first header and envelope form one indivisible boundedContext entry.
      lines.push(`${first ? `${lane.header}\n` : ''}${notice.text}`);
      first = false;
    }
  }
  if (includePeerProgress && result.peerProgress.length > 0) {
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
  } else if (includePeerProgress) {
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
    // Which agent read this context. The audit trail previously recorded the provider but
    // not the reader, so concurrent agents on one machine were indistinguishable after the
    // fact. Self-declared and descriptive: it never affects what the query returns.
    agent: normalizeAgentDescriptor(options.agent),
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
    contextDigest: hash(result.context),
    ...(result.trace ? { traceCounts: traceCounts(result.trace) } : {})
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

/** @param {any} inputOptions */
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
  const trace = options.trace ? createContextTrace(route.profile) : null;
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
    ...(trace ? { trace } : {}),
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

  function finish() {
    base.context = renderContext(base, route.profile?.maxContextBytes ?? 1024, true,
      sharedRuntimeHome(/** @type {import('./shared-context.mjs').SharedOptions} */ (options)));
    base.injection = { payload: base.context, digest: hash(base.context), persisted: false, artifact: null };
    if (trace) {
      trace.budget.renderedContextBytes = Buffer.byteLength(base.context, 'utf8');
      trace.layers = traceLayers(trace, base);
    }
    return base;
  }

  const rule = policyEntry(options.providerPolicy, options.provider);
  if (rule && route.shouldQuery && (rule.strictIsolation ||
      !scopeReadable(rule, { kind: options.scopeKind, key: options.scopeKey }))) {
    base.warnings.push('provider-policy-denied');
    trace?.policy.push({ relationKey: scopeRelation(options.scopeKind, options.scopeKey), reason: 'query-denied' });
    return finish();
  }
  if (rule?.read) {
    options.scopeExpansion = false;
    if (options.ambientProjectKey && !scopeReadable(rule, { kind: 'project', key: options.ambientProjectKey })) {
      trace?.policy.push({ relationKey: scopeRelation('project', options.ambientProjectKey), reason: 'ambient-project-denied' });
      options.ambientProjectKey = null;
    }
  }
  if (!route.shouldQuery) {
    return finish();
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
      ambientProjectKey: options.ambientProjectKey,
      ticketPackagesRoot: options.ticketPackagesRoot,
      reviewLedgersRoot: options.reviewLedgersRoot,
      providerPolicy: options.providerPolicy,
      terms,
      now,
      maxProgress: Math.min(route.profile.maxClaims, 8)
    });
    base.peerProgress = progress.progress;
    if (trace) trace.peerProgress = progress.decisions;
    base.warnings.push(...progress.warnings);
  }
  // This independent source must run before the missing accepted-registry return.
  try {
    const notices = listContextNotices({ ...options, activeOnly: true, injectionOnly: true, deferNonce: true,
      maxTextBytes: Math.floor(route.profile.maxContextBytes / 4) });
    if (notices.state !== 'not-configured') {
      /** @type {any} */ (base).teamNotices = notices.notices;
      /** @type {any} */ (base).teamNoticeLane = { state: notices.state, counts: notices.counts,
        header: notices.header, textBytes: notices.textBytes, textBudgetBytes: notices.textBudgetBytes };
      if (notices.state !== 'ready') /** @type {string[]} */ (base.warnings).push(`team-shared-${notices.state}`);
      if (notices.notices.some((n) => n.provenance?.stale)) /** @type {string[]} */ (base.warnings).push('team-shared-stale');
    }
  } catch {
    /** @type {any} */ (base).teamNotices = [];
    /** @type {any} */ (base).teamNoticeLane = { state: 'error', counts: noticeCounts(), header: '', textBytes: 0, textBudgetBytes: 0 };
    /** @type {string[]} */ (base.warnings).push('team-shared-error');
  }
  const scopeRelations = acceptedScopeRelations(options);
  if (trace) trace.scopes = [...scopeRelations].map(([relationKey, role]) => ({ relationKey, role }));
  const registry = readJson(join(root, 'accepted-snapshots.json'));
  if (!registry) {
    base.warnings.push('accepted-registry-missing');
    return finish();
  }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) {
    throw new Error('Accepted snapshot registry is invalid.');
  }
  if (!existsSync(join(root, 'state.json'))) throw new Error('Reconciliation state is missing.');
  loadState(join(root, 'state.json'));

  const { ambientGlobal, scopeKind } = /** @type {any} */ (options);
  if (ambientGlobal !== false && scopeKind !== 'global') {
    for (const relationKey of ambientGlobalRelations(root, registry.snapshots, rule, trace)) {
      if (!scopeRelations.has(relationKey)) scopeRelations.set(relationKey, 'ambient-global');
    }
  }
  if (trace) trace.scopes = [...scopeRelations].map(([relationKey, role]) => ({ relationKey, role }));
  const scopedOptions = { ...options, scopeRelations };
  if (scopeRelations.size > 1) base.warnings.push('scope-relations-expanded');
  const entries = registry.snapshots
    .filter((entry) => entry?.state === 'clean')
    .filter((entry) => Array.isArray(entry.relationKeys) &&
      entry.relationKeys.some((relationKey) => scopeRelations.has(relationKey)))
    .map((/** @type {any} */ entry) => ({ entry, rank: snapshotRank(root, entry, scopeRelations) }))
    .sort((left, right) =>
      left.rank.role - right.rank.role ||
      right.rank.createdAt.localeCompare(left.rank.createdAt) ||
      Number(right.entry.version ?? 0) - Number(left.entry.version ?? 0))
    .map((/** @type {{entry: any, rank: ReturnType<typeof snapshotRank>}} */ { entry, rank }, /** @type {number} */ index) => {
      trace?.snapshots.push({ snapshotId: entry.snapshotId, scopeKind: rank.scopeKind,
        role: rank.scopeRole, rank: index, selected: index < route.profile.maxSnapshots && !rank.unreadable,
        ...(rank.unreadable ? { reason: 'unreadable' } : index >= route.profile.maxSnapshots ? { reason: 'snapshot-cap' } : {}) });
      return entry;
    });
  const selectedEntries = entries.slice(0, route.profile.maxSnapshots);
  if (entries.length > selectedEntries.length) base.warnings.push('accepted-snapshot-limit-reached');
  let claimReadLimitReached = false;
  const candidates = selectedEntries.flatMap((entry) => {
    const snapshot = verifiedSnapshot(root, entry, route.profile, scopedOptions, now, trace);
    claimReadLimitReached ||= snapshot.omittedClaimReadCount > 0;
    if (snapshot.omittedClaimReadCount > 0) trace?.candidates.push({ snapshotId: snapshot.snapshotId,
      decision: 'excluded', reason: 'read-limit', score: null, count: snapshot.omittedClaimReadCount });
    return snapshot.claims.map((claim) => ({
      claim,
      snapshot,
      score: relevance(claim, snapshot, route.profile, terms, scopedOptions)
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
  if (trace) {
    const included = new Set(currentCandidates.slice(0, route.profile.maxClaims));
    for (const item of candidates) {
      const detail = relevanceDecision(item.claim, item.snapshot, route.profile, terms, scopedOptions);
      const reason = ['stale', 'expired'].includes(item.claim.freshnessStatus)
        ? item.claim.freshnessStatus : detail.reason ?? (included.has(item) ? undefined : 'claim-cap');
      const candidate = claimDecision(item.claim, item.snapshot.snapshotId,
        detail.reason === 'term-miss' ? -1 : detail.score, reason);
      trace.candidates.push(candidate);
      if (reason === 'claim-cap' || reason === 'term-miss') {
        trace.nearMisses.push({ ...candidate, score: detail.score });
      }
    }
    trace.nearMisses.sort((left, right) => (right.score ?? -1) - (left.score ?? -1));
    trace.nearMisses = trace.nearMisses.slice(0, 5);
  }
  if (base.claims.some((claim) => claim.valueOmitted)) {
    base.warnings.push('accepted-claim-value-omitted');
  }
  return finish();
}

export async function planContextQuery(options) {
  return buildContextQuery(options);
}

export async function runContextQuery(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true || !options.globalAuditDirectory) {
    throw new Error('Audited context query requires execute: true and globalAuditDirectory.');
  }
  const result = await buildContextQuery({ ...options, trace: true });
  const output = { ...result };
  if (!options.trace) delete output.trace;
  if (result.strictIsolation) {
    return output;
  }
  if (options.threadRef && !THREAD_REF.test(options.threadRef)) {
    throw new Error('Thread audit reference is invalid.');
  }
  const auditId = randomUUID();
  const audit = queryAudit(result, options, auditId);
  const timestamp = result.generatedAt.replaceAll(':', '').replaceAll('.', '');
  const globalPath = join(resolve(options.globalAuditDirectory), `${timestamp}-${auditId}.json`);
  atomicWrite(globalPath, `${JSON.stringify(audit, null, 2)}\n`);
  const injection = persistQueryInjection(options.globalAuditDirectory, {
    generatedAt: result.generatedAt,
    provider: result.provider,
    profile: result.profile,
    routeReason: result.routeReason,
    ...(options.threadRef ? { threadRef: options.threadRef } : {}),
    payload: result.context,
    trace: /** @type {import('./context-trace.mts').ContextTrace} */ (result.trace)
  }, auditId);

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
    ...output,
    injection: {
      payload: result.context,
      digest: hash(result.context),
      persisted: true,
      artifact: injection.artifact
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
