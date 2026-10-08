import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { HashSchema } from './schemas.mts';
import { noLinks } from './store.mts';
import { sha256 } from './capture.mts';
import { canonical, redactBlock } from './slicing.mts';

// Operator claims: agreements David makes outside agent sessions (email, Teams, meetings,
// verbal) that agents must know. Every record is one immutable file written once; a
// revocation or a publication receipt is its own file beside the claim. Nothing here calls
// a model or writes to the broker: claimProposal only prepares a context-publication
// proposal that the broker validates and reconciles itself.

export const CLAIMS = 'operator-claims';
const ID = /^CLM-(?<day>\d{8})-[a-f0-9]{6}$/;
const CLAIM_FILE = /^(CLM-\d{8}-[a-f0-9]{6})\.json$/;
const REVOCATION_FILE = /^(CLM-\d{8}-[a-f0-9]{6})\.revocation\.json$/;
const PUBLISHED_FILE = /^(CLM-\d{8}-[a-f0-9]{6})\.published\.json$/;
const MAX_FILE = 64 * 1024;
export const ClaimIdSchema = z.string().regex(ID);

// Broker scope rules (peer-progress.mjs validScope, context-query.mjs validateScope).
const BROKER_KINDS = ['global', 'project', 'workstream', 'ticket', 'merge-request'] as const;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/!-]{0,127}$/u;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/u;
const MERGE_REQUEST_KEY = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}!\d{1,12}$/u;
// Local-only scope of the work assistant; stored, never published to the broker.
const ASSISTANT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
// The project an unscoped operator claim belongs to: the broker's configured default project.
export const PROJECT_SCOPE = Object.freeze({ kind: 'project' as const,
  key: (process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT ?? '').trim() || 'default-project' });

// Broker content-safety (content-safety.mjs unsafeContentReason): reconciliation blocks a whole
// batch when any string matches, so a claim that would trip it is refused at record time.
const BROKER_UNSAFE = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,63}\b/iu,
  /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/u,
  /\b(?:bearer\s+eyJ|apptoken\s*[:=]|password\s*[:=]|secret\s*[:=])\S+/iu,
  /(?:^|[\s"'])(?:[A-Za-z]:\\|\\\\)[^\s"']+/u,
  /(?:^|[\s"'])\/(?:home|Users|private|var\/lib)\//u,
];
function sensitive(text: string) {
  try { if (redactBlock(text).text !== text) return true; } catch { return true; }
  return BROKER_UNSAFE.some(pattern => pattern.test(text));
}

const Kind = z.enum(['agreement', 'decision', 'constraint', 'correction', 'fact']);
const Channel = z.enum(['email', 'teams', 'meeting', 'verbal', 'other']);
const Confidence = z.enum(['confirmed', 'tentative']);
const IsoDate = z.iso.date();
// Assistant scopes and chapters belong to the work assistant: stored, never published.
const ASSISTANT_KINDS = ['assistant-scope', 'assistant-chapter'] as const;
const Scope = z.strictObject({ kind: z.enum([...BROKER_KINDS, ...ASSISTANT_KINDS]), key: z.string().min(1).max(128) });
// The person who recorded it, or 'operator' when not given; never an agent.
const RecordedBy = z.string().min(1).max(80);
type Scope = z.infer<typeof Scope>;
const Participants = z.array(z.string().min(1).max(80)).max(12);
const sourceFields = { channel: Channel, reference: z.string().min(1).max(200).optional(), occurredAt: IsoDate };
const Source = z.strictObject({ ...sourceFields, participants: Participants });
const Statement = z.string().min(10).max(600);

const ClaimRecord = z.strictObject({
  schemaVersion: z.literal(1), claimId: ClaimIdSchema, statement: Statement, kind: Kind,
  scopes: z.array(Scope).max(8), source: Source, recordedBy: RecordedBy, recordedAt: z.iso.datetime(),
  confidence: Confidence, supersedes: z.array(ClaimIdSchema).max(8),
  reviewBy: IsoDate.optional(), validUntil: IsoDate.optional(), status: z.literal('active'),
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;
const Revocation = z.strictObject({ schemaVersion: z.literal(1), revokes: ClaimIdSchema, reason: z.string().min(10).max(300),
  recordedBy: RecordedBy, recordedAt: z.iso.datetime() });
type Revocation = z.infer<typeof Revocation>;
// Bounded broker result fields; a 'blocked' or 'conflicted' result recorded nothing, so it is no receipt.
const Receipt = z.strictObject({ proposalId: z.string().regex(/^operator-claim-CLM-\d{8}-[a-f0-9]{6}-\d$/),
  state: z.enum(['clean', 'pending']), acceptedClaimCount: z.number().int().min(0).max(1),
  snapshotHash: HashSchema.nullable(), eventId: HashSchema.optional() });
const Published = z.strictObject({ schemaVersion: z.literal(1), claimId: ClaimIdSchema, recordedAt: z.iso.datetime(),
  receipts: z.array(Receipt).min(1).max(8) });
type Published = z.infer<typeof Published>;

export const AddClaimInput = z.strictObject({
  statement: Statement, kind: Kind, scopes: z.array(Scope).max(8).default([]),
  source: z.strictObject({ ...sourceFields, participants: Participants.default([]) }),
  confidence: Confidence, supersedes: z.array(ClaimIdSchema).max(8).default([]),
  reviewBy: IsoDate.optional(), validUntil: IsoDate.optional(),
});
const RevokeInput = z.strictObject({ reason: z.string().min(10).max(300) });
// The broker's publish result carries many more fields; only these bind, the rest are dropped.
const BrokerResult = z.object({ state: z.enum(['clean', 'pending', 'conflicted', 'blocked']),
  acceptedClaimCount: z.number().int().min(0).max(1), snapshotHash: HashSchema.nullable(),
  eventId: HashSchema.nullable().optional(), proposalIdHash: HashSchema.optional() });

// Strict mirror of context-publication-proposal.schema.json, plus the reconciliation rules
// (reconciliation.mjs validateBatch) on freshness and canonical references.
const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const Freshness = z.strictObject({ policy: z.enum(['immutable', 'ttl', 'canonical-head', 'manual']),
  verifiedAt: z.iso.datetime(), expiresAt: z.iso.datetime().nullable(), sourceHeadHash: HashSchema.nullable() })
  .refine(f => (f.policy !== 'ttl' || f.expiresAt !== null) && (f.policy !== 'canonical-head' || f.sourceHeadHash !== null) &&
    (f.expiresAt === null || Date.parse(f.expiresAt) > Date.parse(f.verifiedAt)), 'freshness-invalid');
export const ProposalClaimSchema = z.strictObject({
  claimKey: z.string().min(1),
  claimType: z.enum(['fact', 'decision', 'procedure', 'question', 'risk', 'hypothesis', 'write', 'result']),
  subject: z.string().min(1), predicate: z.string().min(1), value: z.unknown().refine(v => v !== undefined, 'value-required'),
  observedAt: z.iso.datetime(), confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['shared', 'private', 'restricted']),
  evidenceClass: z.enum(['canonical-artifact', 'observed-tool-result', 'agent-handoff']),
  verification: z.enum(['verified', 'unverified']), freshness: Freshness.nullable().optional(),
  canonicalRefs: z.array(z.string().min(1).regex(SAFE_REFERENCE)).min(1).refine(refs => new Set(refs).size === refs.length, 'unique'),
});
export const ProposalSchema = z.strictObject({
  schemaVersion: z.literal(1), proposalId: z.string().min(1).max(200),
  sourceToken: z.string().regex(/^acb:\/\/source\/[a-f0-9]{64}$/),
  scope: z.strictObject({ kind: z.enum(BROKER_KINDS), key: z.string().min(1).max(200) }),
  claims: z.array(ProposalClaimSchema).min(1).max(50),
});
export type Proposal = z.infer<typeof ProposalSchema>;

// The broker claimType enum has no agreement, constraint or correction type. The mapping keeps
// every type inside reconciliation's safe set (fact, decision, procedure, risk, result), so the
// type alone never sends a claim to review:
//   agreement, decision -> decision   (a settled choice)
//   constraint          -> procedure  (a rule for how work must be done)
//   correction          -> risk       (a known-wrong belief that agents must not repeat)
//   fact                -> fact
export const CLAIM_TYPE = { agreement: 'decision', decision: 'decision', constraint: 'procedure',
  correction: 'risk', fact: 'fact' } as const satisfies Record<z.infer<typeof Kind>, Proposal['claims'][number]['claimType']>;

const fail = (code: string): never => { throw new Error(code); };
const directoryOf = (home: string) => join(home, CLAIMS);
const utcDay = (date: Date) => date.toISOString().slice(0, 10);

const isAssistant = (scope: Scope) => (ASSISTANT_KINDS as readonly string[]).includes(scope.kind);

function validScope(scope: Scope) {
  if (isAssistant(scope)) return ASSISTANT_KEY.test(scope.key);
  return SAFE_KEY.test(scope.key) && (scope.kind !== 'ticket' || ISSUE_KEY.test(scope.key)) &&
    (scope.kind !== 'merge-request' || MERGE_REQUEST_KEY.test(scope.key));
}

/** The broker scopes a claim publishes to; an empty scope list means the whole project. */
export function brokerScopes(record: Pick<ClaimRecord, 'scopes'>) {
  if (record.scopes.length === 0) return [{ ...PROJECT_SCOPE }];
  return record.scopes.filter(scope => !isAssistant(scope))
    .map(scope => ({ kind: scope.kind as (typeof BROKER_KINDS)[number], key: scope.key }));
}

// A missing directory is an empty store; any other read error must not look like "no claims".
function listNames(directory: string): string[] {
  noLinks(directory);
  try { return readdirSync(directory); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw new Error('claims-store-unreadable');
  }
}

function readFile<T>(path: string, schema: z.ZodType<T>): T {
  noLinks(path);
  const bytes = readFileSync(path);
  if (bytes.length > MAX_FILE) fail('claims-store-invalid');
  const parsed = schema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  return parsed.success ? parsed.data : fail('claims-store-invalid');
}

// Where claims live: by default `<home>/operator-claims`. With `claimsRoot`, claims and
// revocations are read from that folder (for example an assistant project's `claims/`), which
// this module never writes; publication receipts then stay in `<home>/operator-claims`.
export type ClaimsLocation = { home: string; claimsRoot?: string };
const locationOf = (where: string | ClaimsLocation): ClaimsLocation => typeof where === 'string' ? { home: where } : where;

type Store = { claims: Map<string, ClaimRecord>; revocations: Map<string, Revocation>; published: Map<string, Published> };
function readStore(where: string | ClaimsLocation): Store {
  const location = locationOf(where);
  const directory = location.claimsRoot ?? directoryOf(location.home);
  const store: Store = { claims: new Map(), revocations: new Map(), published: new Map() };
  if (location.claimsRoot) {
    // Receipts for external claims are ours; receipts for other claims in our folder are ignored.
    const receipts = directoryOf(location.home);
    for (const name of listNames(receipts).sort()) {
      const match = PUBLISHED_FILE.exec(name);
      if (!match) continue;
      const published = readFile(join(receipts, name), Published);
      if (published.claimId !== match[1]) fail('claims-record-name');
      store.published.set(published.claimId, published);
    }
  }
  for (const name of listNames(directory).sort()) {
    const path = join(directory, name);
    let match: RegExpExecArray | null;
    if ((match = CLAIM_FILE.exec(name))) {
      const record = readFile(path, ClaimRecord);
      // The name binds the id, and the id's day binds the recording day.
      if (record.claimId !== match[1] || ID.exec(record.claimId)!.groups!.day !== record.recordedAt.slice(0, 10).replaceAll('-', '')) {
        fail('claims-record-name');
      }
      store.claims.set(record.claimId, record);
    } else if ((match = REVOCATION_FILE.exec(name))) {
      const revocation = readFile(path, Revocation);
      if (revocation.revokes !== match[1]) fail('claims-record-name');
      store.revocations.set(revocation.revokes, revocation);
    } else if (!location.claimsRoot && (match = PUBLISHED_FILE.exec(name))) {
      const published = readFile(path, Published);
      if (published.claimId !== match[1]) fail('claims-record-name');
      store.published.set(published.claimId, published);
    }
    // Anything else (README.md, schema files) is not part of the store.
  }
  for (const id of store.revocations.keys()) if (!store.claims.has(id)) fail('claims-store-invalid');
  for (const id of store.published.keys()) {
    if (store.claims.has(id)) continue;
    if (location.claimsRoot) store.published.delete(id); else fail('claims-store-invalid');
  }
  return store;
}

function writable(where: string | ClaimsLocation) {
  const location = locationOf(where);
  if (location.claimsRoot) fail('claims-root-read-only');
  return location.home;
}

/** Writes one immutable file; false when the name is already taken. */
function writeOnce(path: string, value: unknown): boolean {
  noLinks(path);
  let fd: number;
  try { fd = openSync(path, 'wx', 0o600); } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;
    throw error;
  }
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
  return true;
}

function ensureDirectory(home: string) {
  const directory = directoryOf(home);
  noLinks(directory); mkdirSync(directory, { recursive: true });
  return directory;
}

/** Current: not revoked, not superseded by another unrevoked claim, and not past validUntil (inclusive). */
function statusOf(store: Store, record: ClaimRecord, today: string) {
  const revoked = store.revocations.has(record.claimId);
  const superseded = [...store.claims.values()].some(other => other.claimId !== record.claimId &&
    other.supersedes.includes(record.claimId) && !store.revocations.has(other.claimId));
  const expired = record.validUntil !== undefined && today > record.validUntil;
  const reviewDue = record.reviewBy !== undefined && today > record.reviewBy;
  return { current: !revoked && !superseded && !expired, revoked, reviewDue };
}

function publishedOf(store: Store, claimId: string) {
  const published = store.published.get(claimId);
  if (!published) return null;
  return { state: published.receipts.every(receipt => receipt.state === 'clean') ? 'clean' as const : 'pending' as const,
    at: published.recordedAt };
}

function requireClaim(store: Store, claimId: string) {
  if (!ClaimIdSchema.safeParse(claimId).success) fail('claims-id-invalid');
  return store.claims.get(claimId) ?? fail('claims-not-found');
}

const randomSuffix = () => randomBytes(3).toString('hex');

/** Records one claim. The id carries the recording day and a random suffix; a collision retries. */
export function addClaim(where: string | ClaimsLocation, input: unknown, now = new Date(), random: () => string = randomSuffix) {
  const home = writable(where);
  const parsed = AddClaimInput.safeParse(input);
  if (!parsed.success) fail('claims-input-invalid');
  const value = parsed.data!;
  if (!value.scopes.every(validScope)) fail('claims-scope-invalid');
  if (new Set(value.scopes.map(scope => `${scope.kind}:${scope.key}`)).size !== value.scopes.length) fail('claims-scope-duplicate');
  const texts = [value.statement, ...value.source.participants, ...(value.source.reference === undefined ? [] : [value.source.reference])];
  if (texts.some(sensitive)) fail('claims-sensitive-text');
  // A link reference must be https; a subject line or thread title is free text.
  if (value.source.reference !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(value.source.reference) &&
      !/^https:\/\/\S+$/.test(value.source.reference)) fail('claims-reference-invalid');
  if (value.validUntil !== undefined && value.validUntil < value.source.occurredAt) fail('claims-valid-until-invalid');
  if (new Set(value.supersedes).size !== value.supersedes.length) fail('claims-input-invalid');
  const store = readStore(home);
  if (value.supersedes.some(id => !store.claims.has(id))) fail('claims-supersedes-unknown');
  const directory = ensureDirectory(home);
  const recordedAt = now.toISOString();
  const day = recordedAt.slice(0, 10).replaceAll('-', '');
  for (let attempt = 0; attempt < 8; attempt++) {
    const claimId = `CLM-${day}-${random()}`;
    if (!ID.test(claimId)) fail('claims-id-invalid');
    const record = ClaimRecord.parse({ schemaVersion: 1, claimId, statement: value.statement, kind: value.kind,
      scopes: value.scopes, source: { channel: value.source.channel,
        ...(value.source.reference === undefined ? {} : { reference: value.source.reference }),
        occurredAt: value.source.occurredAt, participants: value.source.participants },
      recordedBy: 'operator', recordedAt, confidence: value.confidence, supersedes: value.supersedes,
      ...(value.reviewBy === undefined ? {} : { reviewBy: value.reviewBy }),
      ...(value.validUntil === undefined ? {} : { validUntil: value.validUntil }), status: 'active' });
    if (writeOnce(join(directory, `${claimId}.json`), record)) return { state: 'recorded' as const, claimId, record };
  }
  return fail('claims-id-contention');
}

/** Revokes a claim with a separate immutable record; the claim file is never modified. */
export function revokeClaim(where: string | ClaimsLocation, claimId: string, input: unknown, now = new Date()) {
  const home = writable(where);
  const store = readStore(home);
  requireClaim(store, claimId);
  const parsed = RevokeInput.safeParse(input);
  if (!parsed.success) fail('claims-input-invalid');
  if (sensitive(parsed.data!.reason)) fail('claims-sensitive-text');
  const revocation = Revocation.parse({ schemaVersion: 1, revokes: claimId, reason: parsed.data!.reason,
    recordedBy: 'operator', recordedAt: now.toISOString() });
  if (!writeOnce(join(ensureDirectory(home), `${claimId}.revocation.json`), revocation)) fail('claims-already-revoked');
  return { state: 'revoked' as const, claimId, revocation };
}

/** Every claim, newest first, with its derived state. */
export function listClaims(where: string | ClaimsLocation, now = new Date()) {
  const store = readStore(where);
  const today = utcDay(now);
  const items = [...store.claims.values()]
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt) || b.claimId.localeCompare(a.claimId))
    .map(record => ({ ...record, ...statusOf(store, record, today), published: publishedOf(store, record.claimId) }));
  return { schemaVersion: 1 as const, items };
}

/** One context-publication proposal per broker scope: an object for one scope, an array for several. */
export function claimProposal(where: string | ClaimsLocation, claimId: string, sourceToken: string, now = new Date()): Proposal | Proposal[] {
  const store = readStore(where);
  const record = requireClaim(store, claimId);
  if (!/^acb:\/\/source\/[a-f0-9]{64}$/.test(sourceToken)) fail('claims-source-token-invalid');
  if (!statusOf(store, record, utcDay(now)).current) fail('claims-not-current');
  // Records from another writer were not checked here, so check again before anything leaves.
  const texts = [record.statement, record.recordedBy, ...record.source.participants,
    ...(record.source.reference === undefined ? [] : [record.source.reference])];
  if (texts.some(sensitive)) fail('claims-sensitive-text');
  const scopes = brokerScopes(record);
  if (scopes.length === 0) fail('claims-not-publishable');
  const participants = record.source.participants;
  const value = participants.length ? `${record.statement} (with: ${participants.join(', ')})` : record.statement;
  const confirmed = record.confidence === 'confirmed';
  // validUntil is inclusive, so the claim expires at the start of the next UTC day.
  const freshness = record.validUntil === undefined
    ? { policy: 'manual' as const, verifiedAt: record.recordedAt, expiresAt: null, sourceHeadHash: null }
    : { policy: 'ttl' as const, verifiedAt: record.recordedAt,
      expiresAt: new Date(Date.parse(`${record.validUntil}T00:00:00Z`) + 86400000).toISOString(), sourceHeadHash: null };
  const proposals = scopes.map((scope, index) => {
    const parsed = ProposalSchema.safeParse({ schemaVersion: 1, proposalId: `operator-claim-${claimId}-${index + 1}`, sourceToken,
      scope, claims: [{ claimKey: `operator.${claimId}`, claimType: CLAIM_TYPE[record.kind], subject: 'operator-agreement',
        predicate: `agreed-via-${record.source.channel}`, value, observedAt: `${record.source.occurredAt}T00:00:00Z`,
        confidence: confirmed ? 0.9 : 0.6, sensitivity: 'private', evidenceClass: 'canonical-artifact',
        verification: confirmed ? 'verified' : 'unverified', freshness,
        canonicalRefs: [`context://operator-claim/${claimId}`] }] });
    return parsed.success ? parsed.data : fail('claims-proposal-invalid');
  });
  return proposals.length === 1 ? proposals[0]! : proposals;
}

/** Stores the broker publication result(s) once: one receipt per proposal, in proposal order. */
export function markPublished(where: string | ClaimsLocation, claimId: string, receipt: unknown, now = new Date()) {
  const home = locationOf(where).home;
  const store = readStore(where);
  const record = requireClaim(store, claimId);
  const expected = brokerScopes(record).map((_, index) => `operator-claim-${claimId}-${index + 1}`);
  if (expected.length === 0) fail('claims-not-publishable');
  const parsed = z.union([BrokerResult, z.array(BrokerResult).min(1).max(8)]).safeParse(receipt);
  if (!parsed.success) fail('claims-receipt-invalid');
  const results = Array.isArray(parsed.data) ? parsed.data : [parsed.data!];
  if (results.length !== expected.length) fail('claims-receipt-count');
  const receipts = results.map((result, index) => {
    const proposalId = expected[index]!;
    if (result.proposalIdHash !== undefined && result.proposalIdHash !== sha256(proposalId)) fail('claims-receipt-mismatch');
    if (result.state !== 'clean' && result.state !== 'pending') fail('claims-receipt-not-recorded');
    return { proposalId, state: result.state as 'clean' | 'pending', acceptedClaimCount: result.acceptedClaimCount,
      snapshotHash: result.snapshotHash, ...(typeof result.eventId === 'string' ? { eventId: result.eventId } : {}) };
  });
  const published = Published.parse({ schemaVersion: 1, claimId, recordedAt: now.toISOString(), receipts });
  if (!writeOnce(join(ensureDirectory(home), `${claimId}.published.json`), published)) fail('claims-already-published');
  return { state: 'published' as const, claimId, published: publishedOf({ ...store, published: new Map([[claimId, published]]) }, claimId) };
}

/** Bounded JSON from stdin for the claims CLI. */
export function parseClaimsInput(text: string): unknown {
  if (Buffer.byteLength(text) > MAX_FILE) fail('claims-input-limit');
  try { return JSON.parse(text); } catch { return fail('claims-input-invalid'); }
}
