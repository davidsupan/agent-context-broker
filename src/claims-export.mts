// Read-only export of accepted, hash-verified claims for host applications that seal their own snapshots, for
// example a desktop assistant building its "settled" file at refresh time. It never writes, never ranks by
// relevance and never returns pending, rejected or superseded claims. Access follows the same rules as a context
// query: the provider policy's read rules and strict isolation, and private claims only for the provider that
// recorded them. Any integrity failure throws an IntegrityError, so a caller seals nothing partial.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { scopeRelation, verifiedClaim, verifiedSnapshotFile } from './context-query.mjs';
import { verifyEventStore } from './event-store.mjs';
import { policyEntry, scopeReadable } from './provider-policy.mjs';

export const EXPORT_SCHEMA_VERSION = 1;
export const DEFAULT_LIMIT = 200;
export const MAX_LIMIT = 500;
const STATEMENT_MAX = 600;
const MAX_VALUE_BYTES = 65536;
const SCOPE_KINDS = ['global', 'project', 'workstream', 'ticket', 'merge-request'] as const;

export type ScopeKind = (typeof SCOPE_KINDS)[number];
export type Scope = { kind: ScopeKind; key: string };
export type ExportOptions = {
  runtimeRoot: string;
  /** The event store root; defaults to runtimeRoot. Its head is verified and reported. */
  eventRuntimeRoot?: string;
  provider: 'codex' | 'claude-code';
  scopes: Scope[];
  /** Whole-string prefixes matched against a claim's canonicalRefs (query and fragment ignored, see refMatches). */
  refs?: string[];
  /** A project key whose project-wide claims are added. */
  includeProject?: string | null;
  after?: string | null;
  limit?: number;
  providerPolicy?: unknown;
  now?: Date;
};
export type ExportedClaim = {
  claimKey: string; claimId: string; claimType: string; subject: string; predicate: string; value: unknown; valueHash: string;
  statement: string; observedAt: string; acceptedAt: string; confidence: number; sensitivity: string; freshness: string;
  scope: unknown; supersedes: string | null; canonicalRefs: string[]; acceptance: { acceptedAt: string; providers: string[] };
};
export type ExportResult = {
  schemaVersion: 1;
  broker: { version: string | null; headHash: string | null; eventCount: number };
  records: ExportedClaim[];
  truncated: boolean;
  nextCursor: string | null;
  warnings: string[];
};

/** Thrown when a hash, the event head or a stored record does not verify. Callers must seal nothing. */
export class IntegrityError extends Error {
  constructor(message: string) { super(message); this.name = 'IntegrityError'; }
}

type OrderKey = { acceptedAt: string; claimKey: string; claimId: string };
// A verified claim as context-query returns it (JavaScript): the named fields this export reads, plus the rest.
type Claim = OrderKey & { subject: unknown; predicate: unknown; value: unknown; providers: string[]; freshnessStatus: string; [field: string]: any };

function readJson(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}

/** "subject — predicate: value", whitespace collapsed, at most 600 characters. */
export function statementOf(claim: { subject: unknown; predicate: unknown; value: unknown }): string {
  const value = typeof claim.value === 'string' ? claim.value : JSON.stringify(claim.value);
  const text = `${String(claim.subject)} — ${String(claim.predicate)}: ${value}`.replace(/\s+/gu, ' ').trim();
  return text.length > STATEMENT_MAX ? `${text.slice(0, STATEMENT_MAX - 1)}…` : text;
}

const stripQuery = (ref: string) => ref.replace(/[?#].*$/u, '');
const figmaNode = (ref: string) => /[?&]node-id=([0-9]+[-:][0-9]+)/u.exec(ref)?.[1]?.replace(':', '-') ?? null;

/**
 * Whether a canonical ref matches a requested prefix. Query and fragment are ignored on both sides, so every
 * Figma node of a file matches the file URL; a requested URL that names a Figma node narrows to that node
 * (`-` and `:` in node ids are the same).
 */
export function refMatches(ref: string, prefix: string): boolean {
  if (!stripQuery(ref).startsWith(stripQuery(prefix))) return false;
  const wanted = figmaNode(prefix);
  return wanted === null || figmaNode(ref) === wanted;
}

function encodeCursor(claim: { acceptedAt: string; claimKey: string; claimId: string }): string {
  return Buffer.from(JSON.stringify([claim.acceptedAt, claim.claimKey, claim.claimId]), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): [string, string, string] {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(value) && value.length === 3 && value.every(v => typeof v === 'string')) return value as [string, string, string];
  } catch { /* fall through */ }
  throw new Error('claims-export cursor is invalid.');
}

const order = (a: OrderKey, b: OrderKey) =>
  String(a.acceptedAt).localeCompare(String(b.acceptedAt)) || String(a.claimKey).localeCompare(String(b.claimKey)) ||
  String(a.claimId).localeCompare(String(b.claimId));

function validateScopes(scopes: Scope[]): void {
  for (const scope of scopes) {
    if (!SCOPE_KINDS.includes(scope?.kind) || typeof scope.key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/!-]{0,127}$/u.test(scope.key)) {
      throw new Error('claims-export scopes must be bounded kind:key pairs.');
    }
  }
}

export function exportClaims(options: ExportOptions): ExportResult {
  const scopes = [...options.scopes];
  if (options.includeProject) scopes.push({ kind: 'project', key: options.includeProject });
  validateScopes(scopes);
  const refs = options.refs ?? [];
  if (!scopes.length && !refs.length) throw new Error('claims-export needs at least one --scope, --ref or --include-project.');
  if (refs.some(ref => typeof ref !== 'string' || !ref || ref.length > 500)) throw new Error('claims-export refs must be bounded strings.');
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
  const now = options.now ?? new Date();
  const root = resolve(options.runtimeRoot);
  const warnings: string[] = [];

  let head: { headHash?: string } | null = null;
  let eventCount = 0;
  try {
    const verified = verifyEventStore({ runtimeRoot: options.eventRuntimeRoot ?? root }) as { head: { headHash?: string } | null; events: unknown[] };
    head = verified.head;
    eventCount = verified.events.length;
  } catch (error) {
    throw new IntegrityError(`event store: ${(error as Error).message}`);
  }
  const version = (() => {
    try { return String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); } catch { return null; }
  })();
  const empty = (): ExportResult => ({ schemaVersion: 1, broker: { version, headHash: head?.headHash ?? null, eventCount }, records: [], truncated: false, nextCursor: null, warnings });

  const rule = policyEntry(options.providerPolicy, options.provider) as { strictIsolation?: boolean } | null;
  if (rule?.strictIsolation) { warnings.push('provider-policy-strict-isolation'); return empty(); }
  const readable = scopes.filter(scope => scopeReadable(rule, scope));
  if (readable.length < scopes.length) warnings.push('provider-policy-denied-scope');
  const relations = new Set(readable.map(scope => scopeRelation(scope.kind, scope.key)));

  const registry = readJson(join(root, 'accepted-snapshots.json')) as { schemaVersion?: number; snapshots?: unknown[] } | null;
  if (!registry) { warnings.push('accepted-registry-missing'); return empty(); }
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) throw new IntegrityError('accepted snapshot registry is invalid');

  const byId = new Map<string, Claim & { snapshotScope: unknown }>();
  for (const entry of registry.snapshots as Array<Record<string, any>>) {
    if (entry?.state !== 'clean') continue;
    let snapshot: Record<string, any>;
    try { snapshot = verifiedSnapshotFile(root, entry); } catch (error) { throw new IntegrityError((error as Error).message); }
    const inScope = Array.isArray(snapshot.relationKeys) && snapshot.relationKeys.some((key: string) => relations.has(key));
    // A ref match still needs a scope the policy lets this provider read.
    const scopeAllowed = !snapshot.scope || scopeReadable(rule, snapshot.scope);
    if (!inScope && !(refs.length && scopeAllowed)) continue;
    for (const claimId of snapshot.claimIds as string[]) {
      if (byId.has(claimId)) continue;
      let claim: Claim;
      try { claim = verifiedClaim(root, claimId, MAX_VALUE_BYTES, now) as Claim; } catch (error) { throw new IntegrityError((error as Error).message); }
      if (!inScope && !claim.canonicalRefs.some((ref: string) => refs.some(prefix => refMatches(ref, prefix)))) continue;
      // Private claims stay with the provider that recorded them.
      if (claim.sensitivity !== 'shared' && !claim.providers.includes(options.provider)) continue;
      byId.set(claimId, { ...claim, snapshotScope: snapshot.scope ?? null });
    }
  }
  // A claim another returned claim supersedes is not current.
  const superseded = new Set([...byId.values()].map(claim => claim.supersedes).filter((id): id is string => typeof id === 'string'));
  let current = [...byId.values()].filter(claim => !superseded.has(claim.claimId)).sort(order);
  if (options.after) {
    const [acceptedAt, claimKey, claimId] = decodeCursor(options.after);
    current = current.filter(claim => order(claim, { acceptedAt, claimKey, claimId }) > 0);
  }
  const page = current.slice(0, limit);
  const truncated = current.length > page.length;
  return {
    ...empty(),
    records: page.map(claim => ({
      claimKey: claim.claimKey, claimId: claim.claimId, claimType: claim.claimType, subject: String(claim.subject), predicate: String(claim.predicate),
      value: claim.valueOmitted ? null : claim.value, valueHash: claim.valueHash, statement: statementOf(claim),
      observedAt: claim.observedAt, acceptedAt: claim.acceptedAt, confidence: claim.confidence, sensitivity: claim.sensitivity,
      freshness: claim.freshnessStatus, scope: claim.snapshotScope, supersedes: claim.supersedes ?? null,
      canonicalRefs: claim.canonicalRefs, acceptance: { acceptedAt: claim.acceptedAt, providers: claim.providers },
    })),
    truncated,
    nextCursor: truncated ? encodeCursor(page.at(-1)!) : null,
  };
}

/** What this broker can do, for a caller that must not depend on a newer command being there. */
export function capabilities(): { schemaVersion: 1; version: string | null; commands: string[] } {
  let version: string | null = null;
  try { version = String(JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); } catch { /* unknown */ }
  return { schemaVersion: 1, version, commands: ['capabilities', 'claims-export', 'claims-withdraw', 'context-query', 'context-publish', 'progress-publish', 'doctor'] };
}
