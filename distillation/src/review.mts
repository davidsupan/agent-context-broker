import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HashSchema, TokenSchema } from './schemas.mts';
import { noLinks, openStore } from './store.mts';
import { sha256 } from './capture.mts';
import { canonical, redactBlock } from './slicing.mts';
import { OutputSchema, SliceSchema } from './output.mts';

// Human review of pending-review results. A decision is one immutable file; a later
// decision for the same observation supersedes the earlier one by name. Decisions bind
// to the stored output hash, so a changed output is never covered by an old decision.

export const DECISIONS = 'review-decisions';
const Decision = z.enum(['accept', 'reject', 'defer']);
const Confidence = z.enum(['high', 'medium', 'low']);
// The suggestion shown when the decision was made; optional so older decision files stay valid.
const Suggested = z.strictObject({ action: Decision, confidence: Confidence, reasons: z.array(z.string().max(100)).max(20) });
const DecisionRecord = z.strictObject({
  schemaVersion: z.literal(1), attemptToken: TokenSchema, observationIndex: z.number().int().min(0).max(49),
  outputSha256: HashSchema, observationSha256: HashSchema, decision: Decision,
  reason: z.string().max(500).nullable(), decidedBy: z.enum(['operator', 'rule:whitespace-only']), decidedAt: z.iso.datetime(),
  supersedes: z.string().regex(/^[a-f0-9]{32}-\d{2}-\d{3}\.json$/).nullable(),
  suggested: Suggested.nullable().optional(),
});
type Suggested = z.infer<typeof Suggested>;
type DecisionRecord = z.infer<typeof DecisionRecord>;
const ReceiptHead = z.object({ attemptToken: TokenSchema, state: z.string(), outputJson: z.string().nullable(),
  outputSha256: HashSchema.nullable(), utcDay: z.iso.date(), sliceId: HashSchema, recordedAt: z.iso.datetime() });
const FILE = /^(?<token>[a-f0-9]{32})-(?<index>\d{2})-(?<seq>\d{3})\.json$/;

function decisionsDir(home: string) { return join(home, DECISIONS); }

// A missing directory is an empty set; any other read error must not look like "nothing decided".
function listNames(directory: string): string[] {
  noLinks(directory);
  try { return readdirSync(directory); } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return [];
    throw new Error('review-store-unreadable');
  }
}

function readDecisions(home: string): Array<{ name: string; record: DecisionRecord }> {
  const directory = decisionsDir(home);
  const names = listNames(directory);
  return names.filter(name => FILE.test(name)).sort().map(name => {
    const record = DecisionRecord.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
    const match = FILE.exec(name)!.groups!;
    if (match.token !== record.attemptToken || Number(match.index) !== record.observationIndex) throw new Error('review-decision-name');
    return { name, record };
  });
}

/** Latest decision per observation of one attempt, bound to its output hash. */
function latest(home: string, token: string, outputSha256: string) {
  const result = new Map<number, { name: string; record: DecisionRecord }>();
  for (const item of readDecisions(home)) {
    if (item.record.attemptToken !== token || item.record.outputSha256 !== outputSha256) continue;
    result.set(item.record.observationIndex, item);
  }
  return result;
}

export type ReviewGate = (token: string, outputSha256: string, observationCount: number) => { complete: boolean; accepted: number[] };

/** Publication gate: every observation needs a final accept or reject; defer keeps it open. */
export function reviewGate(home: string): ReviewGate {
  return (token, outputSha256, count) => {
    const decided = latest(home, token, outputSha256);
    const accepted: number[] = [];
    for (let index = 0; index < count; index++) {
      const item = decided.get(index);
      if (!item || item.record.decision === 'defer') return { complete: false, accepted: [] };
      if (item.record.decision === 'accept') accepted.push(index);
    }
    return { complete: true, accepted };
  };
}

function receipts(home: string) {
  const directory = join(home, 'semantic-results');
  const names = listNames(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)).sort();
  return names.map(name => ReceiptHead.parse(JSON.parse(readFileSync(join(directory, name), 'utf8'))))
    .filter(receipt => receipt.state === 'pending-review' && receipt.outputJson !== null && receipt.outputSha256 !== null);
}

const MAX_EXCERPT = 600;
function excerpt(slice: z.infer<typeof SliceSchema>, ref: { block: number; startChar: number; endChar: number }) {
  const segment = slice.segments.find(item => item.block === ref.block && item.startChar <= ref.startChar && item.endChar >= ref.endChar);
  if (!segment) return { ...ref, role: null, text: null };
  const text = [...segment.text].slice(ref.startChar - segment.startChar, ref.endChar - segment.startChar).join('');
  return { ...ref, role: segment.role, text: text.length > MAX_EXCERPT ? text.slice(0, MAX_EXCERPT) + '…' : text };
}

// What accepting an observation would change in the accepted corpus knowledge, and a
// suggested decision. Both are deterministic advice for the reviewer: the suggestion is
// never applied without an explicit press, and the knowledge is the local accepted set.

// sourceKey is the capture source (sources.key) the observation came from; null when it cannot be resolved.
type Known = { attemptToken: string; observationIndex: number; kind: string; summary: string; decidedAt: string; sourceKey: string | null;
  lane?: 'transcript' | 'document' };
export type KnowledgeChange = {
  change: 'add' | 'replace' | 'duplicate' | 'whitespace';
  related: { attemptToken: string; observationIndex: number; similarity: number; decidedAt: string } | null;
  path: string; hunk: string;
};
export type Suggestion = { action: z.infer<typeof Decision>; confidence: z.infer<typeof Confidence>; reasons: string[]; automatic?: true };

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'not', 'but', 'its', 'has',
  'have', 'will', 'should', 'must', 'when', 'than', 'then', 'only', 'also', 'any', 'all']);
// Numbers count whatever their length: "7 days" and "14 days" are different claims.
function words(text: string) {
  const lower = text.toLowerCase();
  return new Set([...(lower.match(/[\p{L}][\p{L}\p{N}._-]{2,}/gu) ?? []).filter(word => !STOP.has(word)),
    ...(lower.match(/\d+(?:[.,]\d+)?/g) ?? [])]);
}
const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(' ');
const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export function similarity(a: string, b: string) {
  const left = words(a), right = words(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / (left.size + right.size - shared);
}
const line = (kind: string, summary: string) => `[${kind}] ${summary.replace(/\s+/g, ' ').trim()}`;
// Runs of whitespace collapse to one space; they are never removed, so "now here" never equals "nowhere".
const squash = (text: string) => text.replace(/\s+/gu, ' ').trim();
// Whitespace drawn visibly, so a whitespace-only hunk shows what differs.
const visible = (kind: string, summary: string) => `[${kind}] ` + summary.replace(/\r\n|\r|\n/g, '⏎').replace(/\t/g, '→')
  .replace(/ {2,}/g, run => '·'.repeat(run.length)).replace(/^ | $/g, '·');

/** One unified-diff hunk against the accepted knowledge file of the observation's kind. */
export function knowledgeChange(observation: { kind: string; summary: string; sourceKey?: string | null },
  known: Known[]): KnowledgeChange {
  const sameKind = known.filter(item => item.kind === observation.kind);
  const path = `korpus/${observation.kind}.md`;
  const related = (item: Known, score: number) => ({ attemptToken: item.attemptToken, observationIndex: item.observationIndex,
    similarity: score, decidedAt: item.decidedAt });
  // Whitespace-only means: same kind, same source, raw text differs, equal once whitespace runs collapse.
  // The same sentence about another source may be about another ticket or period, so it is only a duplicate.
  const source = observation.sourceKey ?? null;
  const equal = sameKind.filter(item => squash(item.summary) === squash(observation.summary));
  const twin = source === null ? undefined : equal.find(item => item.sourceKey === source && item.summary !== observation.summary);
  if (twin) {
    const at = sameKind.indexOf(twin) + 1;
    return { change: 'whitespace', path, related: related(twin, 1),
      hunk: `@@ -${at},1 +${at},1 @@\n-${visible(twin.kind, twin.summary)}\n+${visible(observation.kind, observation.summary)}` };
  }
  if (equal[0]) {
    const at = sameKind.indexOf(equal[0]) + 1;
    return { change: 'duplicate', path, related: related(equal[0], 1),
      hunk: `@@ -${at},1 +${at},2 @@\n ${line(equal[0].kind, equal[0].summary)}\n+${line(observation.kind, observation.summary)}` };
  }
  let best: { item: Known; score: number; position: number } | null = null;
  known.forEach(item => {
    const score = similarity(item.summary, observation.summary);
    if (score >= 0.5 && (!best || score > best.score)) best = { item, score, position: sameKind.indexOf(item) };
  });
  const proposed = line(observation.kind, observation.summary);
  const found = best as { item: Known; score: number; position: number } | null;
  if (!found) {
    const at = sameKind.length;
    return { change: 'add', related: null, path, hunk: `@@ -${at},0 +${at + 1},1 @@\n+${proposed}` };
  }
  const near = related(found.item, Math.round(found.score * 100) / 100);
  const existing = line(found.item.kind, found.item.summary);
  const at = Math.max(found.position, 0) + 1;
  // A correction, or any change in the stated numbers, is a replacement unless the text is identical.
  const sameText = normalized(found.item.summary) === normalized(observation.summary);
  const material = observation.kind === 'correction' || numbers(found.item.summary) !== numbers(observation.summary);
  if (sameText || (found.score >= 0.8 && !material)) {
    return { change: 'duplicate', related: near, path, hunk: `@@ -${at},1 +${at},2 @@\n ${existing}\n+${proposed}` };
  }
  return { change: 'replace', related: near, path, hunk: `@@ -${at},1 +${at},1 @@\n-${existing}\n+${proposed}` };
}

const TRANSIENT = /\b(pipeline|job|ci|green|zelen\w*|passed|failed|build|deploy\w*|run\s?\d+|rerun|retry|tests?\s+pass\w*)\b/i;
const CAUSAL = /\b(because|cause[sd]?|root cause|vzrok|zato|always|never|must|vedno|nikoli|requires?|zahteva)\b/i;

/** Deterministic default decision with reason codes; the reviewer confirms or overrides it. */
export function suggest(observation: { kind: string; summary: string }, sources: Array<{ text: string | null }>,
  change: KnowledgeChange, context: { transcriptDuplicate?: boolean } = {}): Suggestion {
  const summary = observation.summary.trim();
  // Checked first: no rule, automatic or not, accepts what cannot be traced to its source.
  if (!sources.some(source => source.text && source.text.trim())) return { action: 'defer', confidence: 'low', reasons: ['source-unresolved'] };
  // A document restating what a transcript already established adds nothing new.
  if (context.transcriptDuplicate) return { action: 'reject', confidence: 'high', reasons: ['duplicate-of-transcript'] };
  if (change.change === 'whitespace') return { action: 'accept', confidence: 'high', reasons: ['whitespace-only'], automatic: true };
  if (change.change === 'duplicate') return { action: 'reject', confidence: 'high', reasons: ['duplicate-of-accepted'] };
  if (observation.kind === 'open-question') return { action: 'defer', confidence: 'medium', reasons: ['open-question'] };
  if (['verification', 'failure'].includes(observation.kind) && TRANSIENT.test(summary) && !CAUSAL.test(summary)) {
    return { action: 'reject', confidence: 'medium', reasons: ['transient-state'] };
  }
  if ([...summary].length < 30) return { action: 'defer', confidence: 'low', reasons: ['too-vague'] };
  if (observation.kind === 'correction') {
    return { action: 'accept', confidence: change.change === 'replace' ? 'high' : 'medium',
      reasons: change.change === 'replace' ? ['correction', 'supersedes-accepted'] : ['correction'] };
  }
  if (observation.kind === 'decision' || observation.kind === 'constraint') {
    return { action: 'accept', confidence: [...summary].length >= 60 ? 'high' : 'medium',
      reasons: [`durable-${observation.kind}`, ...(change.change === 'replace' ? ['overlaps-accepted'] : [])] };
  }
  if (observation.kind === 'failure') return { action: 'accept', confidence: 'medium', reasons: ['durable-failure'] };
  return { action: 'defer', confidence: 'low', reasons: ['verification-needs-check'] };
}

export type ReviewItem = {
  attemptToken: string; observationIndex: number; utcDay: string; outputSha256: string;
  kind: string; summary: string; sources: ReturnType<typeof excerpt>[];
  decision: { decision: z.infer<typeof Decision>; decidedAt: string; reason: string | null; name: string } | null;
  change: KnowledgeChange; suggestion: Suggestion;
};

/** Local review listing: observations with resolved, already redacted source excerpts. */
export function listForReview(home: string, options: { includeDecided?: boolean } = {}) {
  using db = openStore(join(home, 'queue.sqlite3'), { readonly: true });
  const items: ReviewItem[] = [];
  // The capture source of an attempt, through its slice and job; internal, used only for the whitespace rule.
  const pending = receipts(home);
  const sourceOf = pending.length ? db.query(`SELECT j.source_key FROM semantic_attempts a JOIN slices w ON w.id=a.slice_id
    JOIN jobs j ON j.id=w.job_id WHERE a.token=? AND a.slice_id=?`) : null;
  // The lane column exists only once a document attempt was reserved; NULL is transcript.
  const lanes = pending.length && (db.query('PRAGMA table_info(semantic_attempts)').all() as Array<{ name: string }>).some(r => r.name === 'lane')
    ? db.query('SELECT lane FROM semantic_attempts WHERE token=?') : null;
  const all = pending.map(receipt => {
    if (sha256(receipt.outputJson!) !== receipt.outputSha256) throw new Error('review-output-integrity');
    const row = sourceOf!.get(receipt.attemptToken, receipt.sliceId) as { source_key?: unknown } | null;
    const lane = (lanes?.get(receipt.attemptToken) as { lane?: unknown } | null)?.lane === 'document' ? 'document' as const : 'transcript' as const;
    return { receipt, output: OutputSchema.parse(JSON.parse(receipt.outputJson!)), lane,
      sourceKey: row && typeof row.source_key === 'string' && row.source_key ? row.source_key : null,
      decided: latest(home, receipt.attemptToken, receipt.outputSha256!) };
  });
  const known: Known[] = all.flatMap(({ receipt, output, decided, sourceKey, lane }) => output.observations.flatMap((observation, index) => {
    const record = decided.get(index)?.record;
    return record?.decision === 'accept' ? [{ attemptToken: receipt.attemptToken, observationIndex: index,
      kind: observation.kind, summary: observation.summary, decidedAt: record.decidedAt, sourceKey, lane }] : [];
  })).sort((a, b) => a.decidedAt.localeCompare(b.decidedAt));
  const transcriptKnown = known.filter(item => item.lane !== 'document');
  for (const { receipt, output, decided, sourceKey, lane } of all) {
    const row = db.query('SELECT payload_json FROM slices WHERE id=?').get(receipt.sliceId) as { payload_json?: unknown } | null;
    const slice = row && typeof row.payload_json === 'string' ? SliceSchema.parse(JSON.parse(row.payload_json)) : null;
    output.observations.forEach((observation, index) => {
      const entry = decided.get(index) ?? null;
      const current = entry?.record ?? null;
      if (!options.includeDecided && current && current.decision !== 'defer') return;
      const sources = slice ? observation.sourceRefs.map(ref => excerpt(slice, ref)) : [];
      const others = known.filter(item => item.attemptToken !== receipt.attemptToken || item.observationIndex !== index);
      const change = knowledgeChange({ kind: observation.kind, summary: observation.summary, sourceKey }, others);
      // Cross-source dedup: the same similarity rules as accepted knowledge, against transcript results only.
      const transcriptDuplicate = lane === 'document' && ['duplicate', 'whitespace'].includes(knowledgeChange(
        { kind: observation.kind, summary: observation.summary, sourceKey: null }, transcriptKnown).change);
      items.push({ attemptToken: receipt.attemptToken, observationIndex: index, utcDay: receipt.utcDay,
        outputSha256: receipt.outputSha256!, kind: observation.kind, summary: observation.summary, sources,
        decision: current ? { decision: current.decision, decidedAt: current.decidedAt, reason: current.reason, name: entry!.name } : null,
        change, suggestion: suggest(observation, sources, change, transcriptDuplicate ? { transcriptDuplicate } : {}) });
    });
  }
  return { schemaVersion: 1, boundary: 'Local review only; nothing here is accepted knowledge.', acceptedCount: known.length, items };
}

export const DecideInput = z.strictObject({ attemptToken: TokenSchema, observationIndex: z.number().int().min(0).max(49),
  outputSha256: HashSchema, decision: Decision, reason: z.string().max(500).optional(),
  // Undo names the decision it reverses, so it never overrides a later one it has not seen.
  expectedLatest: z.string().regex(/^[a-f0-9]{32}-\d{2}-\d{3}\.json$/).optional() });

type Suggestions = Map<string, Suggested>;
const suggestionKey = (token: string, index: number, outputSha256: string) => `${token}:${index}:${outputSha256}`;
function toSuggestions(items: ReviewItem[]): Suggestions {
  return new Map(items.map(item => [suggestionKey(item.attemptToken, item.observationIndex, item.outputSha256),
    { action: item.suggestion.action, confidence: item.suggestion.confidence, reasons: [...item.suggestion.reasons] }]));
}
// The suggestion is advice recorded for later calibration: failing to compute it stores
// null and never changes or blocks the decision itself.
function currentSuggestions(home: string): Suggestions {
  try { return toSuggestions(listForReview(home, { includeDecided: true }).items); } catch { return new Map(); }
}

/** Write one immutable decision file. Returns the decision and its file name. */
export function decide(home: string, input: z.input<typeof DecideInput>, now = new Date(),
  decidedBy: 'operator' | 'rule:whitespace-only' = 'operator') {
  return writeDecision(home, input, now, decidedBy, currentSuggestions(home));
}

function writeDecision(home: string, input: z.input<typeof DecideInput>, now: Date,
  decidedBy: 'operator' | 'rule:whitespace-only', suggestions: Suggestions) {
  const value = DecideInput.parse(input);
  const receipt = receipts(home).find(item => item.attemptToken === value.attemptToken);
  if (!receipt || receipt.outputSha256 !== value.outputSha256 || sha256(receipt.outputJson!) !== value.outputSha256) {
    throw new Error('review-output-changed');
  }
  const output = OutputSchema.parse(JSON.parse(receipt.outputJson!));
  const observation = output.observations[value.observationIndex];
  if (!observation) throw new Error('review-observation-missing');
  const reason = value.reason?.trim() ? value.reason.trim() : null;
  if (reason !== null && redactBlock(reason).text !== reason) throw new Error('review-reason-sensitive');
  const directory = decisionsDir(home);
  noLinks(directory); mkdirSync(directory, { recursive: true });
  const previous = latest(home, value.attemptToken, value.outputSha256).get(value.observationIndex) ?? null;
  if (value.expectedLatest !== undefined && previous?.name !== value.expectedLatest) throw new Error('review-decision-changed');
  const prefix = `${value.attemptToken}-${String(value.observationIndex).padStart(2, '0')}-`;
  const taken = readdirSync(directory).filter(name => name.startsWith(prefix)).length;
  const record = DecisionRecord.parse({ schemaVersion: 1, attemptToken: value.attemptToken,
    observationIndex: value.observationIndex, outputSha256: value.outputSha256,
    observationSha256: sha256(canonical(observation)), decision: value.decision, reason,
    decidedBy, decidedAt: now.toISOString(), supersedes: previous?.name ?? null,
    suggested: suggestions.get(suggestionKey(value.attemptToken, value.observationIndex, value.outputSha256)) ?? null });
  for (let attempt = 0; attempt < 8; attempt++) {
    const name = `${prefix}${String(taken + attempt + 1).padStart(3, '0')}.json`;
    const path = join(directory, name);
    noLinks(path);
    let fd: number;
    try { fd = openSync(path, 'wx', 0o600); } catch (error) {
      if ((error as { code?: string }).code === 'EEXIST') continue;
      throw error;
    }
    try { writeFileSync(fd, canonical(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    return { state: 'recorded' as const, name, decision: record.decision, supersedes: record.supersedes };
  }
  throw new Error('review-decision-contention');
}

/** Applies the one automatic rule: a whitespace-only change against accepted knowledge is
 * accepted without a press. Every other observation waits for the reviewer. */
export function applyAutomatic(home: string, now = new Date()) {
  const written = [];
  if (!existsSync(join(home, 'queue.sqlite3'))) return { state: 'applied' as const, rule: 'whitespace-only', accepted: 0 };
  const items = listForReview(home).items;
  const suggestions = toSuggestions(items);
  for (const item of items) {
    if (!item.suggestion.automatic || item.change.change !== 'whitespace') continue;
    written.push(writeDecision(home, { attemptToken: item.attemptToken, observationIndex: item.observationIndex,
      outputSha256: item.outputSha256, decision: 'accept', reason: 'whitespace-only change against accepted knowledge' },
      now, 'rule:whitespace-only', suggestions));
  }
  return { state: 'applied' as const, rule: 'whitespace-only', accepted: written.length };
}

const BatchInput = z.strictObject({ decisions: z.array(DecideInput).min(1).max(200) });

/** Many decisions in one process. Each is its own immutable file, so a refused item never
 * blocks or rolls back the others; the result says per item what happened. */
export function decideBatch(home: string, input: unknown, now = new Date()) {
  const { decisions } = BatchInput.parse(input);
  // One listing for the whole batch: each item records the suggestion shown before the batch.
  const suggestions = currentSuggestions(home);
  const results = decisions.map(value => {
    const key = `${value.attemptToken}:${value.observationIndex}`;
    try { return { key, ...writeDecision(home, value, now, 'operator', suggestions) }; }
    catch (error) {
      const message = error instanceof Error && /^review-[a-z-]+$/.test(error.message) ? error.message : 'review-decision-failed';
      return { key, state: 'refused' as const, code: message };
    }
  });
  return { state: 'batch' as const, recorded: results.filter(r => r.state === 'recorded').length,
    refused: results.filter(r => r.state === 'refused').length, results };
}

// History and stats read observation text from receipts in any state, so a decision whose
// output was since published still names what it decided. An unreadable receipt gives null.
function observationsByOutput(home: string) {
  const directory = join(home, 'semantic-results');
  noLinks(directory);
  const result = new Map<string, Array<{ kind: string; summary: string }>>();
  let names: string[];
  try { names = readdirSync(directory).filter(name => /^[a-f0-9]{32}\.json$/.test(name)); } catch { return result; }
  for (const name of names) {
    try {
      const receipt = ReceiptHead.parse(JSON.parse(readFileSync(join(directory, name), 'utf8')));
      if (receipt.outputJson === null || receipt.outputSha256 === null || sha256(receipt.outputJson) !== receipt.outputSha256) continue;
      result.set(`${receipt.attemptToken}:${receipt.outputSha256}`,
        OutputSchema.parse(JSON.parse(receipt.outputJson)).observations.map(({ kind, summary }) => ({ kind, summary })));
    } catch { continue; }
  }
  return result;
}
const observationKey = (r: DecisionRecord) => `${r.attemptToken}:${r.observationIndex}:${r.outputSha256}`;
const observationOf = (texts: ReturnType<typeof observationsByOutput>, r: DecisionRecord) =>
  texts.get(`${r.attemptToken}:${r.outputSha256}`)?.[r.observationIndex] ?? null;
const MAX_SUMMARY = 300;
const bounded = (text: string) => { const chars = [...text]; return chars.length > MAX_SUMMARY ? chars.slice(0, MAX_SUMMARY - 1).join('') + '…' : text; };

/** Every decision ever recorded, newest first, with the suggestion it followed or overrode. */
export function reviewHistory(home: string, { limit = 500 }: { limit?: number } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error('review-history-limit');
  const decisions = readDecisions(home);
  // Names sort by sequence within one observation, so the last name per key is the latest.
  const last = new Map(decisions.map(item => [observationKey(item.record), item.name]));
  const texts = observationsByOutput(home);
  const items = decisions.map(({ name, record }) => {
    const observation = observationOf(texts, record);
    const suggested = record.suggested ?? null;
    return { name, decidedAt: record.decidedAt, decision: record.decision, decidedBy: record.decidedBy,
      attemptToken: record.attemptToken, observationIndex: record.observationIndex,
      kind: observation?.kind ?? null, summary: observation ? bounded(observation.summary) : null, reason: record.reason,
      suggested, followed: suggested ? suggested.action === record.decision : null,
      superseded: last.get(observationKey(record)) !== name };
  // Parsed, not string-compared: ISO strings with and without milliseconds do not sort lexically.
  }).sort((a, b) => Date.parse(b.decidedAt) - Date.parse(a.decidedAt) || b.name.localeCompare(a.name)).slice(0, limit);
  return { schemaVersion: 1 as const, items };
}

/** Counts over the latest decision per observation; a defer is both decided and still open. */
export function reviewStats(home: string) {
  const level = () => ({ high: 0, medium: 0, low: 0 });
  const decided = { accept: 0, reject: 0, defer: 0 };
  const suggestions = { followed: 0, overridden: 0, unknown: 0 };
  const openBySuggestion = { accept: level(), reject: level(), defer: level() };
  const byKind = new Map<string, { open: number; accept: number; reject: number; defer: number }>();
  const byReason = new Map<string, { followed: number; overridden: number }>();
  const kindOf = (kind: string) => byKind.get(kind) ?? byKind.set(kind, { open: 0, accept: 0, reject: 0, defer: 0 }).get(kind)!;
  let auto = 0, open = 0;
  const texts = observationsByOutput(home);
  const last = new Map(readDecisions(home).map(item => [observationKey(item.record), item.record]));
  for (const record of last.values()) {
    decided[record.decision]++;
    kindOf(observationOf(texts, record)?.kind ?? 'unknown')[record.decision]++;
    if (record.decidedBy === 'rule:whitespace-only') auto++;
    const suggested = record.suggested ?? null;
    if (!suggested) { suggestions.unknown++; continue; }
    const outcome = suggested.action === record.decision ? 'followed' : 'overridden';
    suggestions[outcome]++;
    for (const reason of suggested.reasons) {
      (byReason.get(reason) ?? byReason.set(reason, { followed: 0, overridden: 0 }).get(reason)!)[outcome]++;
    }
  }
  const listed = existsSync(join(home, 'queue.sqlite3')) ? listForReview(home).items : [];
  for (const item of listed) {
    open++; kindOf(item.kind).open++;
    openBySuggestion[item.suggestion.action][item.suggestion.confidence]++;
  }
  return { schemaVersion: 1 as const, open, decided, auto, byKind: Object.fromEntries(byKind), suggestions,
    byReason: Object.fromEntries(byReason), openBySuggestion };
}
