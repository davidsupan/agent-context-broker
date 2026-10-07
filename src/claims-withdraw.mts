// A withdrawn claim leaves current reads on state commit. A durable manifest drives deletion of registered copies;
// ambiguous files are retained and reported. Readers consult current state even when the registry is stale.
//
// The event chain is append-only and keeps hashes only, as it always has: one `claim.superseded` event per claim,
// with `disposition: withdrawn` and no replacement, plus `snapshot.published` for the new snapshot. Both are event
// types older brokers already verify. A pending job resumes deletion after a crash.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  deliverCommittedOutbox, hash, loadState, persistOutbox, readJson, resumeWithdrawalDeletes, stableJson, synchronizeRegistry, withLock, writeJson,
} from './reconciliation.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const MIN_VALUE_TEXT = 12;
const LOCK = { lockTimeoutMs: 5000, lockRetryMs: 50, lockStaleMs: 600000 };

type IndexEntry = { claimId: string; valueHash: string; canonicalRefs?: string[] };
type ScopeEntry = { scopeKey: string; snapshotId: string; snapshotHash: string; version: number; claimIndex: Record<string, IndexEntry>; relationKeys: string[]; canonicalRefs: string[] };
type State = { schemaVersion: 1; revision: number; updatedAt: string; scopes: Record<string, ScopeEntry>; batches: Record<string, unknown>;
  tombstones?: Record<string, Record<string, { withdrawalId: string; at: string }>>; pendingWithdrawals?: string[];
  historicalBatches?: Record<string, true> };
type StoredClaim = { claimId: string; claimKey: string; valueHash: string; value: unknown; supersedes: string | null; [field: string]: unknown };

export type WithdrawOptions = {
  runtimeRoot: string;
  eventRuntimeRoot?: string;
  claimIds: string[];
  /** Why, in a few words; only its hash is stored. */
  reason: string;
  /** Folders whose JSON artifacts may carry rendered claim text (query, ticket and thread audits). */
  auditRoots?: string[];
  execute?: boolean;
  now?: Date;
  /** Test-only failure after the durable state write. */
  testFailPoint?: 'after-state';
  afterStateWrite?: () => void;
};

export type WithdrawPlan = {
  schemaVersion: 1;
  writesEnabled: boolean;
  // On a retry of a committed withdrawal the key is gone: claimKey is empty and claimKeyHash names it.
  claims: Array<{ claimId: string; claimKey: string; claimKeyHash?: string; scopeKey: string; versions: string[] }>;
  scopes: Array<{ scopeKey: string; remainingClaims: number; scopeRemoved: boolean }>;
  deletes: { claimFiles: number; reviewCandidates: number; auditArtifacts: number };
  ambiguousClaimIds: string[];
};

function storedClaim(root: string, claimId: string): StoredClaim | null {
  return HASH.test(claimId) ? (readJson(join(root, 'claims', `${claimId}.json`), null) as StoredClaim | null) : null;
}

/** The claim and every earlier version it supersedes, newest first. */
function versionChain(root: string, claimId: string): StoredClaim[] {
  const chain: StoredClaim[] = [];
  const seen = new Set<string>();
  let next: string | null = claimId;
  while (next && !seen.has(next)) {
    seen.add(next);
    const claim = storedClaim(root, next);
    if (!claim) break;
    chain.push(claim);
    next = typeof claim.supersedes === 'string' ? claim.supersedes : null;
  }
  return chain;
}

const valueText = (value: unknown) => (typeof value === 'string' ? value : stableJson(value));
const squash = (text: string) => text.replace(/\s+/gu, ' ').trim().toLowerCase();
const PROBE_CHARS = 48;

/** The text that identifies a value in rendered output: its first 48 characters, whitespace collapsed. */
export function probeOf(value: unknown): string | null {
  const text = squash(valueText(value));
  return text.length >= MIN_VALUE_TEXT ? text.slice(0, PROBE_CHARS) : null;
}

/** Whether any string inside a parsed JSON artifact renders one of the values (truncated renders included). */
export function rendersValue(json: unknown, probes: readonly string[]): boolean {
  if (!probes.length) return false;
  const stack: unknown[] = [json];
  while (stack.length) {
    const item = stack.pop();
    if (typeof item === 'string') { const text = squash(item); if (probes.some(p => text.includes(p))) return true; }
    else if (Array.isArray(item)) stack.push(...item);
    else if (item && typeof item === 'object') stack.push(...Object.values(item));
  }
  return false;
}

function jsonFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsonFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.json') && statSync(path).size <= 8 * 1024 * 1024) out.push(path);
  }
  return out;
}

/** Everything a withdrawal would change, computed without writing. */
function analyse(root: string, state: State, options: WithdrawOptions) {
  const ids = [...new Set(options.claimIds)];
  if (!ids.length || ids.some(id => !HASH.test(id))) throw new Error('Claim withdrawal needs one or more claim ids.');
  if (typeof options.reason !== 'string' || !options.reason.trim()) throw new Error('Claim withdrawal needs a reason.');
  const targets: Array<{ claimId: string; claimKey: string; scopeKey: string; chain: StoredClaim[] }> = [];
  for (const claimId of ids) {
    const scope = Object.values(state.scopes).find(entry => Object.values(entry.claimIndex).some(item => item.claimId === claimId));
    if (!scope) throw new Error(`Claim ${claimId.slice(0, 12)} is not a current accepted claim.`);
    const claimKey = Object.entries(scope.claimIndex).find(([, item]) => item.claimId === claimId)![0];
    targets.push({ claimId, claimKey, scopeKey: scope.scopeKey, chain: versionChain(root, claimId) });
  }
  const removedKeys = new Map<string, Set<string>>();
  for (const t of targets) { if (!removedKeys.has(t.scopeKey)) removedKeys.set(t.scopeKey, new Set()); removedKeys.get(t.scopeKey)!.add(t.claimKey); }
  const scopes = [...removedKeys.entries()].map(([scopeKey, keys]) => {
    const entry = state.scopes[scopeKey]!;
    const remaining = Object.fromEntries(Object.entries(entry.claimIndex).filter(([key]) => !keys.has(key)));
    return { scopeKey, entry, remaining };
  });
  const surviving = new Set(Object.entries(state.scopes).flatMap(([scopeKey, entry]) =>
    Object.values(scopes.find(s => s.scopeKey === scopeKey)?.remaining ?? entry.claimIndex).map(item => item.claimId)));
  // Historical snapshots establish ownership for otherwise unlinked files. A matching key alone does not.
  const historical = new Map<string, Set<string>>();
  for (const path of jsonFiles(join(root, 'snapshots'))) {
    const snapshot = readJson(path, null) as { scope?: { kind?: string; key?: string }; claimIds?: string[] } | null;
    if (!snapshot?.scope || !Array.isArray(snapshot.claimIds) || typeof snapshot.scope.key !== 'string') continue;
    const full = snapshot as Record<string, unknown>;
    const core = Object.fromEntries(Object.entries(full).filter(([key]) => key !== 'snapshotHash' && key !== 'digest'));
    const digest = hash(stableJson(core));
    if (full.snapshotHash !== digest || full.digest !== digest) continue;
    const scopeKey = `${snapshot.scope.kind}:${hash(snapshot.scope.key)}`;
    for (const id of snapshot.claimIds) {
      if (!historical.has(id)) historical.set(id, new Set());
      historical.get(id)!.add(scopeKey);
    }
  }
  const deleteIds = new Set(targets.flatMap(t => t.chain.map(c => c.claimId)));
  const ambiguousClaimIds: string[] = [];
  for (const path of jsonFiles(join(root, 'claims'))) {
    const claim = readJson(path, null) as StoredClaim | null;
    if (!claim || !HASH.test(claim.claimId ?? '') || deleteIds.has(claim.claimId)) continue;
    const matchingScopes = targets.filter(t => t.claimKey === claim.claimKey).map(t => t.scopeKey);
    if (!matchingScopes.length) continue;
    const owners = historical.get(claim.claimId);
    if (owners && matchingScopes.some(scopeKey => owners.has(scopeKey))) deleteIds.add(claim.claimId);
    else if (!surviving.has(claim.claimId)) ambiguousClaimIds.push(claim.claimId);
  }
  const selected = [...deleteIds].map(id => storedClaim(root, id)).filter((claim): claim is StoredClaim => claim !== null);
  for (const id of surviving) deleteIds.delete(id);
  const probes = [...new Set(selected.map(c => probeOf(c.value)).filter((p): p is string => p !== null))];

  // Rejected-batch reviews keep candidate claims with their values.
  const reviews: Array<{ path: string; review: Record<string, any>; keep: unknown[]; removed: number }> = [];
  for (const path of jsonFiles(join(root, 'review'))) {
    const review = readJson(path, null) as Record<string, any> | null;
    if (!review || !Array.isArray(review.candidateClaims)) continue;
    const keyHashes = new Set([...(removedKeys.get(review.scopeKey) ?? [])].map(key => hash(key)));
    const keep = review.candidateClaims.filter((c: Record<string, any>) => !keyHashes.has(c?.claimKey));
    if (keep.length !== review.candidateClaims.length) reviews.push({ path, review, keep, removed: review.candidateClaims.length - keep.length });
  }
  // Audit artifacts that rendered the value into an injected context.
  const artifacts = (options.auditRoots ?? []).flatMap(dir => jsonFiles(dir)).filter(path => {
    try { return rendersValue(JSON.parse(readFileSync(path, 'utf8')), probes); } catch { return false; }
  });

  return { targets, deleteIds, reviews, artifacts, scopes, ambiguousClaimIds, removedKeys,
    selected, valueHashes: [...new Set(selected.map(claim => claim.valueHash))] };
}

function planOf(a: ReturnType<typeof analyse>, writesEnabled: boolean): WithdrawPlan {
  return {
    schemaVersion: 1,
    writesEnabled,
    claims: a.targets.map(t => ({ claimId: t.claimId, claimKey: t.claimKey, scopeKey: t.scopeKey, versions: t.chain.map(c => c.claimId) })),
    scopes: a.scopes.map(s => ({ scopeKey: s.scopeKey, remainingClaims: Object.keys(s.remaining).length, scopeRemoved: Object.keys(s.remaining).length === 0 })),
    deletes: { claimFiles: a.deleteIds.size, reviewCandidates: a.reviews.reduce((n, r) => n + r.removed, 0), auditArtifacts: a.artifacts.length },
    ambiguousClaimIds: a.ambiguousClaimIds,
  };
}

/** What a withdrawal would do; writes nothing. */
export function planClaimWithdrawal(options: WithdrawOptions): WithdrawPlan {
  const root = resolve(options.runtimeRoot);
  const state = loadState(join(root, 'state.json')) as State;
  return planOf(analyse(root, state, options), false);
}

/** Withdraws the claims and deletes their stored content; requires execute: true. */
export async function withdrawClaims(options: WithdrawOptions): Promise<WithdrawPlan & { withdrawalId: string; snapshots: Array<{ scopeKey: string; snapshotHash: string | null }> }> {
  if (options.execute !== true) throw new Error('Claim withdrawal writes require execute: true.');
  const root = resolve(options.runtimeRoot);
  const statePath = join(root, 'state.json');
  return withLock(join(root, 'state.lock'), LOCK, async () => {
    const state = resumeWithdrawalDeletes(root) as State;
    synchronizeRegistry(root, state);
    await deliverCommittedOutbox(root, state, options.eventRuntimeRoot ?? root);
    const previous = jsonFiles(join(root, 'withdrawals')).filter(path => path.endsWith('.manifest.json'))
      .map(path => readJson(path, null) as { claimIds?: string[]; plan?: WithdrawPlan; withdrawalId?: string; snapshots?: Array<{ scopeKey: string; snapshotHash: string | null }> } | null)
      .find(manifest => manifest?.claimIds && options.claimIds.every(id => manifest.claimIds!.includes(id)) && manifest.claimIds.length === options.claimIds.length &&
        manifest.plan?.claims.every(claim => state.tombstones?.[claim.scopeKey]?.[claim.claimKeyHash ?? '']?.withdrawalId === manifest.withdrawalId));
    if (previous?.plan && previous.withdrawalId && previous.snapshots) return { ...previous.plan, withdrawalId: previous.withdrawalId, snapshots: previous.snapshots };
    const a = analyse(root, state, options);
    const now = (options.now ?? new Date()).toISOString();
    const withdrawalId = randomUUID();
    const batchKey = hash(`withdraw:${withdrawalId}`);
    const events: unknown[] = [];
    const snapshots: Array<{ scopeKey: string; snapshotHash: string | null }> = [];

    for (const scope of a.scopes) {
      const claimIds = Object.values(scope.remaining).map(item => item.claimId).sort();
      const canonicalRefs = [...new Set(Object.values(scope.remaining).flatMap(item => item.canonicalRefs ?? []))].sort();
      const old = readJson(join(root, 'snapshots', `${scope.entry.snapshotId}.json`), null) as Record<string, any> | null;
      if (!claimIds.length || !canonicalRefs.length) {
        // Nothing left in the scope: it leaves the registry altogether.
        delete state.scopes[scope.scopeKey];
        snapshots.push({ scopeKey: scope.scopeKey, snapshotHash: null });
        continue;
      }
      const snapshotCore = {
        schemaVersion: 1, snapshotId: randomUUID(), version: scope.entry.version + 1, baseSnapshotHash: scope.entry.snapshotHash,
        scope: old?.scope ?? null, createdAt: now, claimIds, relationKeys: scope.entry.relationKeys, canonicalRefs, state: 'clean',
      };
      const snapshotHash = hash(stableJson(snapshotCore));
      writeJson(join(root, 'snapshots', `${snapshotCore.snapshotId}.json`), { ...snapshotCore, snapshotHash, digest: snapshotHash });
      state.scopes[scope.scopeKey] = { ...scope.entry, snapshotId: snapshotCore.snapshotId, snapshotHash, version: snapshotCore.version, claimIndex: scope.remaining, canonicalRefs };
      snapshots.push({ scopeKey: scope.scopeKey, snapshotHash });
      const scopeRef = old?.scope && typeof old.scope.kind === 'string' && typeof old.scope.key === 'string'
        ? { kind: old.scope.kind, keyHash: hash(old.scope.key) } : null;
      if (scopeRef) {
        events.push({
          idempotencyKey: hash(`withdraw:${withdrawalId}:snapshot:${snapshotHash}`), eventType: 'snapshot.published', occurredAt: now,
          provider: 'system', scope: scopeRef, taskKeyHash: scopeRef.kind === 'ticket' ? scopeRef.keyHash : null, threadKey: null,
          sourceRefs: claimIds.map(id => `acb://claim/${id}`), subjectRef: `acb://snapshot/${snapshotHash}`,
          replacesRef: `acb://snapshot/${scope.entry.snapshotHash}`, evidenceRefs: [`acb://audit/${hash(withdrawalId)}`], confidence: 1,
          freshness: { status: 'current', policy: 'immutable', verifiedAt: now, expiresAt: null, sourceHeadHash: null },
          sensitivity: 'private', redactionResult: 'clean', approvalState: 'approved',
          payload: { snapshotVersion: snapshotCore.version, withdrawnClaimCount: a.targets.filter(t => t.scopeKey === scope.scopeKey).length },
        });
      }
    }
    for (const t of a.targets) {
      const snapshot = readJson(join(root, 'snapshots', `${a.scopes.find(s => s.scopeKey === t.scopeKey)!.entry.snapshotId}.json`), null) as Record<string, any> | null;
      const scopeRef = snapshot?.scope && typeof snapshot.scope.key === 'string' ? { kind: snapshot.scope.kind, keyHash: hash(snapshot.scope.key) } : null;
      if (!scopeRef) continue;
      events.push({
        idempotencyKey: hash(`withdraw:${withdrawalId}:${t.claimId}`), eventType: 'claim.superseded', occurredAt: now, provider: 'system',
        scope: scopeRef, taskKeyHash: scopeRef.kind === 'ticket' ? scopeRef.keyHash : null, threadKey: null, sourceRefs: [],
        subjectRef: `acb://claim/${t.claimId}`, replacesRef: null, evidenceRefs: [`acb://audit/${hash(withdrawalId)}`], confidence: 1,
        freshness: { status: 'current', policy: 'immutable', verifiedAt: now, expiresAt: null, sourceHeadHash: null },
        sensitivity: 'private', redactionResult: 'clean', approvalState: 'approved',
        payload: { disposition: 'withdrawn', reasonHash: hash(options.reason.trim()), versionCount: t.chain.length },
      });
    }

    const result = { schemaVersion: 1, withdrawalId, checkedAt: now, state: 'clean', withdrawnClaimCount: a.targets.length,
      deletedClaimFiles: a.deleteIds.size, writesEnabled: true };
    const manifest = {
      schemaVersion: 1, withdrawalId, withdrawnAt: now, reasonHash: hash(options.reason.trim()),
      claimIds: a.targets.map(t => t.claimId),
      claims: a.targets.map(t => ({ claimId: t.claimId, claimKeyHash: hash(t.claimKey), scopeKey: t.scopeKey, versions: t.chain.length })),
      claimFiles: [...a.deleteIds].map(id => ({ claimId: id, path: relative(root, join(root, 'claims', `${id}.json`)),
        fileHash: hash(readFileSync(join(root, 'claims', `${id}.json`), 'utf8')) })),
      reviews: a.reviews.map(r => ({ path: relative(root, r.path), fileHash: hash(readFileSync(r.path, 'utf8')), scopeKey: r.review.scopeKey,
        claimKeyHashes: [...a.removedKeys.get(r.review.scopeKey)!].map(key => hash(key)) })),
      auditArtifacts: a.artifacts.map(path => ({ path: relative(root, path), fileHash: hash(readFileSync(path, 'utf8')) })),
      deletes: planOf(a, true).deletes, ambiguousClaimIds: a.ambiguousClaimIds, valueHashes: a.valueHashes,
      // No claim key in plain text: the manifest outlives the content it deletes.
      plan: { ...planOf(a, true), claims: planOf(a, true).claims.map(claim => ({ ...claim, claimKey: '', claimKeyHash: hash(claim.claimKey) })) }, snapshots,
    };
    writeJson(join(root, 'withdrawals', `${withdrawalId}.manifest.json`), manifest);
    state.revision += 1;
    state.updatedAt = now;
    state.tombstones ??= {};
    for (const [scopeKey, keys] of a.removedKeys) {
      state.tombstones[scopeKey] ??= {};
      for (const key of keys) state.tombstones[scopeKey][hash(key)] = { withdrawalId, at: now };
    }
    state.pendingWithdrawals = [...(state.pendingWithdrawals ?? []), withdrawalId];
    // Keep stored results byte-for-byte for outbox verification; record history alongside them.
    state.historicalBatches ??= {};
    for (const [key, stored] of Object.entries(state.batches)) {
      const batch = stored as { snapshotId?: string };
      if (!batch.snapshotId) continue;
      const snapshot = readJson(join(root, 'snapshots', `${batch.snapshotId}.json`), null);
      if (!snapshot?.scope || !Array.isArray(snapshot.claimIds)) continue;
      const owner = `${snapshot.scope.kind}:${hash(snapshot.scope.key)}`;
      if (a.targets.some(target => target.scopeKey === owner && snapshot.claimIds.some((id: string) =>
        id === target.claimId || a.selected.some(claim => claim.claimId === id && claim.claimKey === target.claimKey)))) {
        state.historicalBatches[key] = true;
      }
    }
    state.batches[batchKey] = result;
    persistOutbox(root, batchKey, result, events);
    writeJson(statePath, state);
    options.afterStateWrite?.();
    if (options.testFailPoint === 'after-state') throw new Error('Injected failure after state publication.');
    synchronizeRegistry(root, state);
    resumeWithdrawalDeletes(root);
    await deliverCommittedOutbox(root, state, options.eventRuntimeRoot ?? root);
    return { ...planOf(a, true), withdrawalId, snapshots };
  });
}
