import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ClaimReason = 'stale' | 'expired' | 'claim-type' | 'provider' |
  'private-other-provider' | 'relation' | 'term-miss' | 'claim-cap' | 'tombstoned';
export type ClaimDecision = {
  claimId: string; claimKey: string | null; claimType: string | null;
  subject: string | null; predicate: string | null; snapshotId: string;
  score: number | null; decision: 'included' | 'excluded'; reason?: ClaimReason;
};
export type ReadLimitDecision = {
  snapshotId: string; count: number; score: null; decision: 'excluded'; reason: 'read-limit';
};
export type PeerDecision = {
  progressId: string; score: number | null; decision: 'included' | 'excluded';
  reason?: 'expired' | 'stale-relation' | 'cap' | 'provider' | 'relation' | 'term-miss' | 'already-delivered';
};
export type Layer = {
  id: 'accepted-primary' | 'accepted-ambient-project' | 'accepted-ambient-global' | 'accepted-related' |
    'suggested-scopes' | 'peer-progress' | 'notices' | 'artifact-evidence' | 'policy' | 'budget';
  state: 'used' | 'empty' | 'off' | 'denied' | 'error';
  included: number; excluded: number; reasons: Record<string, number>;
  detail: 'candidates' | 'suggestedScopes' | 'peerProgress' | 'policy' | 'budget' | 'notices' | 'artifacts' | null;
  limit?: number;
};
export type TeamNoticeLane = {
  state: Layer['state'] | 'ready' | 'disabled-by-policy' | 'untrusted-or-unavailable';
  counts: { included: number; read?: number; quarantined?: number; hiddenByAudience?: number;
    omittedByBudget?: number; unverified?: number };
};
export type ContextTrace = {
  schemaVersion: 1;
  scopes: { relationKey: string; role: string }[];
  snapshots: { snapshotId: string; scopeKind: string | null; role: string; rank: number;
    selected: boolean; reason?: 'snapshot-cap' | 'unreadable' }[];
  candidates: (ClaimDecision | ReadLimitDecision)[];
  nearMisses: ClaimDecision[];
  peerProgress: PeerDecision[];
  suggestedScopes: { kind: 'ticket' | 'merge-request'; keyHash: string; reason: 'no-local-evidence' }[];
  policy: { relationKey: string; reason: 'query-denied' | 'ambient-project-denied' | 'ambient-global-denied' | 'scope-denied' }[];
  budget: { maxSnapshots: number; maxClaims: number; maxContextBytes: number; renderedContextBytes: number };
  lifecycle?: { advisoryReferences: number; claimsInjected: 0 };
  layers: Layer[];
};

export function createContextTrace(profile?: {
  maxSnapshots: number; maxClaims: number; maxContextBytes: number;
} | null): ContextTrace {
  const trace: ContextTrace = {
    schemaVersion: 1, scopes: [], snapshots: [], candidates: [], nearMisses: [], peerProgress: [], policy: [],
    layers: [], suggestedScopes: [],
    budget: { maxSnapshots: profile?.maxSnapshots ?? 0, maxClaims: profile?.maxClaims ?? 0,
      maxContextBytes: profile?.maxContextBytes ?? 1024, renderedContextBytes: 0 }
  };
  trace.layers = traceLayers(trace);
  return trace;
}

/** Summarize existing decisions only; never re-run selection or inspect claim values. */
export function traceLayers(trace: ContextTrace, result?: { teamNoticeLane?: TeamNoticeLane; [key: string]: unknown }): Layer[] {
  const summarize = (id: Layer['id'], detail: Layer['detail'],
    items: { decision: string; reason?: string; count?: number }[], off = false): Layer => {
    const layer: Layer = { id, state: off ? 'off' : items.length ? 'used' : 'empty',
      included: 0, excluded: 0, reasons: {}, detail };
    if (off) return layer;
    for (const item of items) {
      const count = item.count ?? 1;
      if (item.decision === 'included') layer.included += count;
      else {
        layer.excluded += count;
        if (item.reason) layer.reasons[item.reason] = (layer.reasons[item.reason] ?? 0) + count;
      }
    }
    return layer;
  };
  const roleFor = new Map(trace.snapshots.map(item => [item.snapshotId, item.role]));
  const roles = ['primary', 'ambient-project', 'ambient-global', 'related'] as const;
  const layers = roles.map(role => summarize(`accepted-${role}`, 'candidates',
    trace.candidates.filter(item => {
      const actual = roleFor.get(item.snapshotId) ?? 'related';
      return role === 'related' ? !roles.slice(0, 3).some(known => known === actual) : actual === role;
    }), Boolean(trace.lifecycle)));
  layers.push(summarize('suggested-scopes', 'suggestedScopes',
    trace.suggestedScopes.map(item => ({ ...item, decision: 'excluded' }))));
  layers.push(summarize('peer-progress', 'peerProgress', trace.peerProgress));
  const notices = summarize('notices', null, [], true);
  if (result?.teamNoticeLane) {
    const lane = result.teamNoticeLane;
    notices.state = lane.state === 'ready' ? (lane.counts.included ? 'used' : 'empty')
      : lane.state === 'disabled-by-policy' ? 'denied'
      : lane.state === 'untrusted-or-unavailable' ? 'error' : lane.state;
    notices.detail = 'notices';
    notices.included = lane.counts.included;
    for (const reason of ['read', 'quarantined', 'hiddenByAudience', 'omittedByBudget', 'unverified'] as const) {
      const count = lane.counts[reason] ?? 0;
      if (count) notices.reasons[reason] = count;
      notices.excluded += count;
    }
  }
  layers.push(notices, summarize('artifact-evidence', null, [], true));
  const policy = summarize('policy', 'policy', trace.policy.map(item => ({ ...item, decision: 'excluded' })));
  if (trace.policy.some(item => item.reason === 'query-denied')) policy.state = 'denied';
  layers.push(policy, { id: 'budget', state: 'used', included: trace.budget.renderedContextBytes,
    excluded: 0, reasons: {}, detail: 'budget', limit: trace.budget.maxContextBytes });
  return layers;
}

/** Explicit allowlist: never copy values, provenance, or free-form progress text. */
export function claimDecision(claim: {
  claimId: string; claimKey?: string; claimType?: string; subject?: string; predicate?: string;
}, snapshotId: string, score: number | null, reason?: ClaimReason): ClaimDecision {
  return {
    claimId: claim.claimId, claimKey: claim.claimKey ?? null, claimType: claim.claimType ?? null,
    subject: claim.subject ?? null, predicate: claim.predicate ?? null, snapshotId, score,
    decision: reason ? 'excluded' : 'included', ...(reason ? { reason } : {})
  };
}

export function traceCounts(trace: ContextTrace) {
  const excludedByReason: Record<string, number> = {};
  let included = 0;
  for (const item of [...trace.candidates, ...trace.peerProgress]) {
    if (item.decision === 'included') included++;
    else if (item.reason) excludedByReason[item.reason] = (excludedByReason[item.reason] ?? 0) +
      ('count' in item ? item.count : 1);
  }
  return { included, excludedByReason, nearMisses: trace.nearMisses.length };
}

export type InjectionRecord = {
  generatedAt: string; profile: string | null; routeReason: string; provider: string;
  threadRef?: string | null; payload: string; trace: ContextTrace; eventName?: string;
};

/** Both entry points persist the exact rendered payload, beside a metadata-only record. */
export function persistQueryInjection(directory: string, record: InjectionRecord, auditId = randomUUID()) {
  const name = `${record.generatedAt.replaceAll(':', '').replaceAll('.', '')}-${auditId}.json`;
  const digest = createHash('sha256').update(record.payload, 'utf8').digest('hex');
  const artifact = `injections/${name}`;
  const path = join(resolve(directory), artifact);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: 1, auditId, ...record, digest }, null, 2)}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  return { artifact, digest, auditId };
}
