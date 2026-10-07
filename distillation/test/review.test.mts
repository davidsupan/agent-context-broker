import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaily } from '../src/daily.mts';
import { sha256 } from '../src/capture.mts';
import { coverage } from '../src/slicing.mts';
import { applyAutomatic, decide, decideBatch, knowledgeChange, listForReview, reviewGate, reviewHistory, reviewStats, similarity,
  suggest } from '../src/review.mts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

const DEFAULT_OBSERVATIONS = [{ kind: 'decision', summary: 'Keep the review log local.' },
  { kind: 'open-question', summary: 'Who reviews later?' }];
async function fixture({ observations = DEFAULT_OBSERVATIONS, files = ['a.jsonl'] }:
  { observations?: Array<{ kind: string; summary: string }>; files?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acb-review-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'history.json'); writeFileSync(path, registry);
  for (const file of files) writeFileSync(join(source, file), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
    content: [{ type: 'input_text', text: `Synthetic decision from ${file}: keep the review log local.` }] } }) + '\n');
  const config = { capture: { providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 },
    semantic: { claudeAvailable: true, attemptSeconds: 60 } };
  await runDaily(config, home, true, async r => ({ state: 'output', completionProof: 'synthetic-fixture', durationMs: 1,
    output: { schemaVersion: 1, sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: 'findings',
      observations: observations.map(item => ({ ...item, sourceRefs: coverage(r.slice) })) } }), { synthetic: true });
  return { home };
}

test('listing resolves source excerpts and hides decided observations by default', async () => {
  const f = await fixture();
  const listed = listForReview(f.home);
  expect(listed.items).toHaveLength(2);
  expect(listed.items[0]).toMatchObject({ kind: 'decision', observationIndex: 0, decision: null });
  expect(listed.items[0]!.sources[0]!.text).toContain('keep the review log local');
  const item = listed.items[0]!;
  decide(f.home, { attemptToken: item.attemptToken, observationIndex: 0, outputSha256: item.outputSha256, decision: 'accept' });
  expect(listForReview(f.home).items.map(i => i.observationIndex)).toEqual([1]);
  expect(listForReview(f.home, { includeDecided: true }).items[0]!.decision).toMatchObject({ decision: 'accept' });
});

test('decisions are immutable files and a later one supersedes by name', async () => {
  const f = await fixture();
  const [item] = listForReview(f.home).items;
  const first = decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256, decision: 'defer', reason: 'check later' });
  const second = decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256, decision: 'reject' });
  expect(first.supersedes).toBeNull();
  expect(second.supersedes).toBe(first.name);
  const files = readdirSync(join(f.home, 'review-decisions')).sort();
  expect(files).toEqual([first.name, second.name]);
  expect(JSON.parse(readFileSync(join(f.home, 'review-decisions', first.name), 'utf8')).decision).toBe('defer');
});

test('the gate needs a final decision for every observation and returns only accepted ones', async () => {
  const f = await fixture();
  const items = listForReview(f.home).items;
  const gate = reviewGate(f.home);
  const token = items[0]!.attemptToken, hash = items[0]!.outputSha256;
  expect(gate(token, hash, 2)).toEqual({ complete: false, accepted: [] });
  decide(f.home, { attemptToken: token, observationIndex: 0, outputSha256: hash, decision: 'accept' });
  decide(f.home, { attemptToken: token, observationIndex: 1, outputSha256: hash, decision: 'defer' });
  expect(gate(token, hash, 2).complete).toBe(false);
  decide(f.home, { attemptToken: token, observationIndex: 1, outputSha256: hash, decision: 'reject' });
  expect(gate(token, hash, 2)).toEqual({ complete: true, accepted: [0] });
  expect(gate(token, 'e'.repeat(64), 2).complete).toBe(false);
});

test('changed outputs, missing observations and sensitive reasons are refused', async () => {
  const f = await fixture();
  const [item] = listForReview(f.home).items;
  const base = { attemptToken: item!.attemptToken, outputSha256: item!.outputSha256, decision: 'accept' as const };
  expect(() => decide(f.home, { ...base, observationIndex: 0, outputSha256: '0'.repeat(64) })).toThrow('review-output-changed');
  expect(() => decide(f.home, { ...base, observationIndex: 9 })).toThrow('review-observation-missing');
  expect(() => decide(f.home, { ...base, observationIndex: 0, reason: 'token glpat-' + 'Q'.repeat(32) })).toThrow('review-reason-sensitive');
  expect(() => decide(f.home, { ...base, observationIndex: 0, decision: 'maybe' as never })).toThrow();
});

test('suggestions are deterministic advice with reason codes', () => {
  const src = [{ text: 'synthetic source' }];
  const add = knowledgeChange({ kind: 'decision', summary: 'Keep review decisions in immutable local files.' }, []);
  expect(add.change).toBe('add');
  expect(suggest({ kind: 'decision', summary: 'Keep review decisions in immutable local files.' }, src, add))
    .toEqual({ action: 'accept', confidence: 'medium', reasons: ['durable-decision'] });
  expect(suggest({ kind: 'decision', summary: 'Keep review decisions in immutable local files.' }, [{ text: null }], add).action).toBe('defer');
  expect(suggest({ kind: 'open-question', summary: 'Who reviews the deferred observations later on?' }, src, add).reasons).toEqual(['open-question']);
  expect(suggest({ kind: 'verification', summary: 'Pipeline 138740 was green on every required job.' }, src, add))
    .toMatchObject({ action: 'reject', reasons: ['transient-state'] });
  expect(suggest({ kind: 'failure', summary: 'The build failed because the schema draft was 2020-12.' }, src, add).action).toBe('accept');
  expect(suggest({ kind: 'constraint', summary: 'Short.' }, src, add).reasons).toEqual(['too-vague']);
});

test('the knowledge diff is a unified hunk: add, replace or duplicate', () => {
  const known = [{ attemptToken: 'a'.repeat(32), observationIndex: 0, kind: 'decision', decidedAt: '2026-10-05T10:00:00.000Z',
    summary: 'Beacon retention is 7 days for all records.', sourceKey: null }];
  const replace = knowledgeChange({ kind: 'correction', summary: 'Beacon retention is 14 days for all records.' }, known);
  expect(replace.change).toBe('replace');
  expect(replace.hunk).toBe('@@ -1,1 +1,1 @@\n-[decision] Beacon retention is 7 days for all records.\n+[correction] Beacon retention is 14 days for all records.');
  expect(suggest({ kind: 'correction', summary: 'Beacon retention is 14 days for all records.' }, [{ text: 'x' }], replace).reasons)
    .toEqual(['correction', 'supersedes-accepted']);
  const duplicate = knowledgeChange({ kind: 'decision', summary: 'Beacon retention is 7 days for all records!' }, known);
  expect(duplicate.change).toBe('duplicate');
  expect(duplicate.hunk.split('\n')[1]).toStartWith(' ');
  expect(suggest({ kind: 'decision', summary: 'Beacon retention is 7 days for all records!' }, [{ text: 'x' }], duplicate).action).toBe('reject');
  expect(knowledgeChange({ kind: 'decision', summary: 'Unrelated deployment naming rule for workers.' }, known).hunk).toBe(
    '@@ -1,0 +2,1 @@\n+[decision] Unrelated deployment naming rule for workers.');
  expect(similarity('', 'x')).toBe(0);
});

test('accepted observations become the knowledge later items are diffed against', async () => {
  const f = await fixture();
  const [first] = listForReview(f.home).items;
  decide(f.home, { attemptToken: first!.attemptToken, observationIndex: 0, outputSha256: first!.outputSha256, decision: 'accept' });
  const listed = listForReview(f.home, { includeDecided: true });
  expect(listed.acceptedCount).toBe(1);
  expect(listed.items[0]!.change.change).toBe('add');
  expect(listed.items[0]!.decision?.name).toMatch(/-00-001\.json$/);
});

test('undo names the decision it reverses and refuses a newer one', async () => {
  const f = await fixture();
  const [item] = listForReview(f.home).items;
  const base = { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256 };
  const first = decide(f.home, { ...base, decision: 'accept' });
  decide(f.home, { ...base, decision: 'reject' });
  expect(() => decide(f.home, { ...base, decision: 'defer', expectedLatest: first.name })).toThrow('review-decision-changed');
  const latestName = readdirSync(join(f.home, 'review-decisions')).sort().at(-1)!;
  expect(decide(f.home, { ...base, decision: 'defer', expectedLatest: latestName }).supersedes).toBe(latestName);
});

test('a whitespace-only change against accepted knowledge from the same source is accepted by rule, nothing else is', async () => {
  const S = 'f'.repeat(64);
  const known = [{ attemptToken: 'a'.repeat(32), observationIndex: 0, kind: 'decision', decidedAt: '2026-10-05T10:00:00.000Z',
    summary: 'Keep the review log local.', sourceKey: S }];
  const src = [{ text: 'synthetic source' }];
  const change = knowledgeChange({ kind: 'decision', summary: 'Keep  the review\nlog local. ', sourceKey: S }, known);
  expect(change.change).toBe('whitespace');
  expect(change.hunk).toBe('@@ -1,1 +1,1 @@\n-[decision] Keep the review log local.\n+[decision] Keep··the review⏎log local.·');
  expect(suggest({ kind: 'decision', summary: 'Keep  the review\nlog local. ' }, src, change))
    .toEqual({ action: 'accept', confidence: 'high', reasons: ['whitespace-only'], automatic: true });
  // An unresolved source is checked before the rule, so it is never accepted automatically.
  expect(suggest({ kind: 'decision', summary: 'Keep  the review\nlog local. ' }, [], change))
    .toEqual({ action: 'defer', confidence: 'low', reasons: ['source-unresolved'] });
  expect(suggest({ kind: 'decision', summary: 'Keep  the review\nlog local. ' }, [{ text: ' ' }], change).automatic).toBeUndefined();
  expect(knowledgeChange({ kind: 'constraint', summary: 'Keep the review log local.', sourceKey: S }, known).change).not.toBe('whitespace');
  // Whitespace runs collapse but never vanish: joining words is a change of text.
  const spaced = [{ ...known[0]!, summary: 'The worker is now here.' }];
  expect(knowledgeChange({ kind: 'decision', summary: 'The worker is nowhere.', sourceKey: S }, spaced).change).not.toBe('whitespace');
  expect(knowledgeChange({ kind: 'decision', summary: 'The worker is\n\tnow   here.', sourceKey: S }, spaced).change).toBe('whitespace');
  expect(knowledgeChange({ kind: 'decision', summary: 'Keep the review log local!', sourceKey: S }, known).change).toBe('duplicate');
  expect(suggest({ kind: 'decision', summary: 'Keep the review log local!' }, src,
    knowledgeChange({ kind: 'decision', summary: 'Keep the review log local!', sourceKey: S }, known)).automatic).toBeUndefined();
  // Exactly identical text is a duplicate, not a whitespace change.
  const identical = knowledgeChange({ kind: 'decision', summary: 'Keep the review log local.', sourceKey: S }, known);
  expect(identical).toMatchObject({ change: 'duplicate', related: { attemptToken: 'a'.repeat(32), similarity: 1 } });
  expect(identical.hunk).toBe('@@ -1,1 +1,2 @@\n [decision] Keep the review log local.\n+[decision] Keep the review log local.');
  expect(suggest({ kind: 'decision', summary: 'Keep the review log local.' }, src, identical))
    .toEqual({ action: 'reject', confidence: 'high', reasons: ['duplicate-of-accepted'] });
  // A twin from another source, or with an unresolved source on either side, is only a duplicate.
  for (const [mine, theirs] of [['e'.repeat(64), S], [null, S], [S, null], [null, null]] as const) {
    expect(knowledgeChange({ kind: 'decision', summary: 'Keep  the review\nlog local. ', sourceKey: mine },
      [{ ...known[0]!, sourceKey: theirs }]).change).toBe('duplicate');
  }
  expect(knowledgeChange({ kind: 'decision', summary: 'Keep  the review\nlog local. ' }, known).change).toBe('duplicate');
  // A same-source twin is preferred over an earlier match from another source.
  const mixed = [{ ...known[0]!, sourceKey: 'e'.repeat(64), observationIndex: 3 }, known[0]!];
  expect(knowledgeChange({ kind: 'decision', summary: 'Keep the review  log local.', sourceKey: S }, mixed))
    .toMatchObject({ change: 'whitespace', related: { observationIndex: 0 } });

  const f = await fixture();
  expect(applyAutomatic(f.home).accepted).toBe(0);
  const [item] = listForReview(f.home).items;
  decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256, decision: 'accept' });
  // Nothing in the fixture differs only by whitespace, so the rule still writes nothing.
  expect(applyAutomatic(f.home).accepted).toBe(0);
  expect(listForReview(f.home).items.every(one => !one.suggestion.automatic)).toBe(true);
});

test('the rule accepts a whitespace twin from the same source and leaves identical or other-source twins', async () => {
  const observations = [{ kind: 'decision', summary: 'Keep the review log local.' },
    { kind: 'open-question', summary: 'Who reviews later?' }, { kind: 'decision', summary: 'Keep  the review\nlog local.' }];
  const f = await fixture({ observations, files: ['a.jsonl', 'b.jsonl'] });
  const listed = listForReview(f.home).items;
  const tokens = [...new Set(listed.map(item => item.attemptToken))];
  expect(tokens).toHaveLength(2);
  expect(applyAutomatic(f.home).accepted).toBe(0);
  const first = listed.find(item => item.attemptToken === tokens[0] && item.observationIndex === 0)!;
  decide(f.home, { attemptToken: first.attemptToken, observationIndex: 0, outputSha256: first.outputSha256, decision: 'accept' });
  const before = listForReview(f.home).items;
  const changeOf = (token: string, index: number) => before.find(i => i.attemptToken === token && i.observationIndex === index)!.change.change;
  expect(changeOf(tokens[0]!, 2)).toBe('whitespace');
  expect(changeOf(tokens[1]!, 0)).toBe('duplicate');
  expect(changeOf(tokens[1]!, 2)).toBe('duplicate');
  expect(applyAutomatic(f.home).accepted).toBe(1);
  const history = reviewHistory(f.home).items;
  expect(history[0]).toMatchObject({ attemptToken: tokens[0], observationIndex: 2, decision: 'accept', decidedBy: 'rule:whitespace-only' });
  expect(listForReview(f.home).items.filter(item => item.attemptToken === tokens[1]).map(item => item.observationIndex)).toEqual([0, 1, 2]);
  expect(applyAutomatic(f.home).accepted).toBe(0);
});

test('a missing review directory is empty, an unreadable one is an error', async () => {
  const f = await fixture();
  expect(listForReview(f.home).items).toHaveLength(2);
  expect(reviewHistory(f.home).items).toEqual([]);
  writeFileSync(join(f.home, 'review-decisions'), 'not a directory');
  expect(() => listForReview(f.home)).toThrow('review-store-unreadable');
  expect(() => reviewHistory(f.home)).toThrow('review-store-unreadable');
  expect(() => reviewStats(f.home)).toThrow('review-store-unreadable');
  rmSync(join(f.home, 'review-decisions'));
  const [item] = listForReview(f.home).items;
  rmSync(join(f.home, 'semantic-results'), { recursive: true });
  expect(listForReview(f.home).items).toEqual([]);
  writeFileSync(join(f.home, 'semantic-results'), 'not a directory');
  expect(() => listForReview(f.home)).toThrow('review-store-unreadable');
  expect(() => applyAutomatic(f.home)).toThrow('review-store-unreadable');
  expect(() => decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256,
    decision: 'accept' })).toThrow('review-store-unreadable');
});

test('a batch records each decision independently and reports refusals per item', async () => {
  const f = await fixture();
  const [a, b] = listForReview(f.home).items;
  const result = decideBatch(f.home, { decisions: [
    { attemptToken: a!.attemptToken, observationIndex: 0, outputSha256: a!.outputSha256, decision: 'accept' },
    { attemptToken: b!.attemptToken, observationIndex: 1, outputSha256: '0'.repeat(64), decision: 'reject' },
    { attemptToken: b!.attemptToken, observationIndex: 1, outputSha256: b!.outputSha256, decision: 'defer' }] });
  expect([result.recorded, result.refused]).toEqual([2, 1]);
  expect(result.results[1]).toMatchObject({ state: 'refused', code: 'review-output-changed' });
  expect(listForReview(f.home).items.map(i => i.observationIndex)).toEqual([1]);
  expect(() => decideBatch(f.home, { decisions: [] })).toThrow();
});

const stored = (home: string, name: string) => JSON.parse(readFileSync(join(home, 'review-decisions', name), 'utf8'));
const at = (minute: number) => new Date(Date.UTC(2026, 9, 5, 10, minute));

test('the suggestion shown at decision time is stored with the decision, single and batch', async () => {
  const f = await fixture();
  const [a, b] = listForReview(f.home).items;
  const single = decide(f.home, { attemptToken: a!.attemptToken, observationIndex: 0, outputSha256: a!.outputSha256, decision: 'accept' });
  expect(stored(f.home, single.name).suggested).toEqual({ action: 'defer', confidence: 'low', reasons: ['too-vague'] });
  expect(stored(f.home, single.name).decision).toBe('accept');
  const batch = decideBatch(f.home, { decisions: [
    { attemptToken: a!.attemptToken, observationIndex: 0, outputSha256: a!.outputSha256, decision: 'reject' },
    { attemptToken: b!.attemptToken, observationIndex: 1, outputSha256: b!.outputSha256, decision: 'defer' }] });
  const names = batch.results.map(r => (r as { name: string }).name);
  expect(stored(f.home, names[0]!).suggested).toEqual({ action: 'defer', confidence: 'low', reasons: ['too-vague'] });
  expect(stored(f.home, names[1]!).suggested).toEqual({ action: 'defer', confidence: 'medium', reasons: ['open-question'] });
});

test('history is newest first and marks followed suggestions and superseded decisions', async () => {
  const f = await fixture();
  const [a] = listForReview(f.home).items;
  const base = { attemptToken: a!.attemptToken, outputSha256: a!.outputSha256 };
  decide(f.home, { ...base, observationIndex: 0, decision: 'defer', reason: 'check later' }, at(1));
  decide(f.home, { ...base, observationIndex: 0, decision: 'accept' }, at(2));
  decide(f.home, { ...base, observationIndex: 1, decision: 'defer' }, at(3));
  const history = reviewHistory(f.home);
  expect(history.schemaVersion).toBe(1);
  expect(history.items.map(i => [i.observationIndex, i.decision, i.followed, i.superseded])).toEqual([
    [1, 'defer', true, false], [0, 'accept', false, false], [0, 'defer', true, true]]);
  expect(history.items[1]).toMatchObject({ kind: 'decision', summary: 'Keep the review log local.', decidedBy: 'operator',
    reason: null, suggested: { action: 'defer', reasons: ['too-vague'] }, decidedAt: at(2).toISOString() });
  expect(history.items[2]!.reason).toBe('check later');
  expect(reviewHistory(f.home, { limit: 1 }).items.map(i => i.observationIndex)).toEqual([1]);
  expect(() => reviewHistory(f.home, { limit: 0 })).toThrow('review-history-limit');
});

test('stats count latest decisions, a defer as decided and open, and overrides by reason', async () => {
  const f = await fixture();
  const empty = reviewStats(f.home);
  expect(empty).toMatchObject({ open: 2, decided: { accept: 0, reject: 0, defer: 0 }, auto: 0,
    suggestions: { followed: 0, overridden: 0, unknown: 0 }, byReason: {} });
  expect(empty.openBySuggestion.defer).toEqual({ high: 0, medium: 1, low: 1 });
  const [a] = listForReview(f.home).items;
  const base = { attemptToken: a!.attemptToken, outputSha256: a!.outputSha256 };
  decide(f.home, { ...base, observationIndex: 0, decision: 'reject' }, at(1));
  decide(f.home, { ...base, observationIndex: 0, decision: 'accept' }, at(2));
  decide(f.home, { ...base, observationIndex: 1, decision: 'defer' }, at(3));
  expect(reviewStats(f.home)).toEqual({ schemaVersion: 1, open: 1, decided: { accept: 1, reject: 0, defer: 1 }, auto: 0,
    byKind: { decision: { open: 0, accept: 1, reject: 0, defer: 0 }, 'open-question': { open: 1, accept: 0, reject: 0, defer: 1 } },
    suggestions: { followed: 1, overridden: 1, unknown: 0 },
    byReason: { 'too-vague': { followed: 0, overridden: 1 }, 'open-question': { followed: 1, overridden: 0 } },
    openBySuggestion: { accept: { high: 0, medium: 0, low: 0 }, reject: { high: 0, medium: 0, low: 0 },
      defer: { high: 0, medium: 1, low: 0 } } });
});

test('decision files written before suggestions were recorded still parse', async () => {
  const f = await fixture();
  const [a] = listForReview(f.home).items;
  const base = { attemptToken: a!.attemptToken, outputSha256: a!.outputSha256 };
  const old = decide(f.home, { ...base, observationIndex: 0, decision: 'accept' }, at(1));
  const { suggested: _, ...legacy } = stored(f.home, old.name);
  writeFileSync(join(f.home, 'review-decisions', old.name), JSON.stringify(legacy) + '\n');
  expect(listForReview(f.home, { includeDecided: true }).items[0]!.decision).toMatchObject({ decision: 'accept' });
  expect(reviewHistory(f.home).items[0]).toMatchObject({ name: old.name, suggested: null, followed: null, superseded: false });
  expect(reviewStats(f.home).suggestions).toEqual({ followed: 0, overridden: 0, unknown: 1 });
  expect(decide(f.home, { ...base, observationIndex: 0, decision: 'reject' }, at(2)).supersedes).toBe(old.name);
  expect(reviewHistory(f.home).items.map(i => i.superseded)).toEqual([false, true]);
});
