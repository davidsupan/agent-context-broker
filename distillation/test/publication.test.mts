import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/sqlite.mts';
import { runDaily } from '../src/daily.mts';
import { sha256 } from '../src/capture.mts';
import { coverage } from '../src/slicing.mts';
import { publishPending, type BrokerTransport } from '../src/publication.mts';
import { decide, listForReview } from '../src/review.mts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
async function fixture(findings = true, review: 'accept' | 'reject' | 'none' = 'accept') {
  const root = mkdtempSync(join(tmpdir(), 'acb-publish-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'history.json'); writeFileSync(path, registry);
  writeFileSync(join(source, 'a.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Keep evidence private.' }] } }) + '\n');
  const config = { capture: { providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 }, semantic: { claudeAvailable: true, attemptSeconds: 60 } };
  await runDaily(config, home, true, async r => ({ state: 'output', completionProof: 'synthetic-fixture', durationMs: 1,
    output: { schemaVersion: 1, sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: findings ? 'findings' : 'no-durable-findings',
      observations: findings ? [{ kind: 'constraint', summary: 'Evidence should remain private.', sourceRefs: coverage(r.slice) }] : [] } }), { synthetic: true });
  if (review !== 'none') for (const item of listForReview(home).items) decide(home, { attemptToken: item.attemptToken,
    observationIndex: item.observationIndex, outputSha256: item.outputSha256, decision: review });
  return { root, home, broker: { toolRoot: process.env.BROKER_TEST_TOOL_ROOT ?? join(root, 'not-configured'), claimsRoot: join(root, 'claims'), eventsRoot: join(root, 'events') } };
}
test('publication plan revalidates but never calls a transport', async () => {
  const f = await fixture(); let calls = 0;
  expect(await publishPending(f.home, {}, f.broker, false, async () => { calls++; throw new Error(); })).toMatchObject({ state: 'plan', claimCount: 1, writes: false, accepted: false });
  expect(calls).toBe(0);
});
test('empty output is recorded once with no broker call', async () => {
  const f = await fixture(false);
  const transport = async () => { throw new Error('must-not-call'); };
  expect(await publishPending(f.home, {}, f.broker, true, transport)).toMatchObject({ state: 'no-findings', accepted: false });
  expect(await publishPending(f.home, {}, f.broker, true, transport)).toMatchObject({ state: 'idle' });
});
test('unexpected accepted broker result is rejected and never recorded as success', async () => {
  const f = await fixture();
  await expect(publishPending(f.home, {}, f.broker, true, async () => ({ state: 'accepted', acceptedClaimCount: 1 }))).rejects.toThrow();
  const db = new Database(join(f.home, 'queue.sqlite3'), { readonly: true });
  try { expect(db.query("SELECT 1 FROM sqlite_master WHERE name='broker_publications'").get()).toBeNull(); } finally { db.close(); }
});
test('proposals remain private, unverified and lack a fabricated source token', async () => {
  const f = await fixture();
  const transport: BrokerTransport = async input => {
    const candidate = input.candidate as { proposalId: string; claims: Array<Record<string, unknown>>; sourceToken?: string };
    expect(candidate.sourceToken).toBeUndefined();
    expect(candidate.claims[0]).toMatchObject({ sensitivity: 'private', verification: 'unverified', evidenceClass: 'agent-handoff' });
    return { state: 'pending', acceptedClaimCount: 0, snapshotHash: null, automaticRetryAllowed: false,
      proposalId: candidate.proposalId, sourceToken: `acb://source/${'a'.repeat(64)}` };
  };
  expect(await publishPending(f.home, {}, f.broker, true, transport)).toMatchObject({ state: 'pending', accepted: false });
  expect(await publishPending(f.home, {}, f.broker, true, transport)).toMatchObject({ state: 'idle' });
});
(!process.env.BROKER_TEST_TOOL_ROOT ? test.skip : test)('real broker modules attest the synthetic artifact and keep it pending', { timeout: 30000 }, async () => {
  const f = await fixture();
  expect(await publishPending(f.home, {}, f.broker, true)).toMatchObject({ state: 'pending', accepted: false, claimCount: 1 });
  expect(await publishPending(f.home, {}, f.broker, true)).toMatchObject({ state: 'idle' });
});

const passing: BrokerTransport = async input => {
  const candidate = input.candidate as { proposalId: string };
  return { state: 'pending', acceptedClaimCount: 0, snapshotHash: null, automaticRetryAllowed: false,
    proposalId: candidate.proposalId, sourceToken: `acb://source/${'a'.repeat(64)}` };
};
test('unreviewed or deferred results are never published', async () => {
  const f = await fixture(true, 'none'); let calls = 0;
  const counting: BrokerTransport = async input => { calls++; return passing(input, f.broker as never); };
  expect(await publishPending(f.home, {}, f.broker, true, counting)).toMatchObject({ state: 'idle', writes: false });
  const [item] = listForReview(f.home).items;
  decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256, decision: 'defer' });
  expect(await publishPending(f.home, {}, f.broker, true, counting)).toMatchObject({ state: 'idle' });
  expect(calls).toBe(0);
  decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: item!.outputSha256, decision: 'accept' });
  expect(await publishPending(f.home, {}, f.broker, true, counting)).toMatchObject({ state: 'pending', claimCount: 1 });
  expect(calls).toBe(1);
});
test('rejected observations are recorded without a broker call', async () => {
  const f = await fixture(true, 'reject');
  expect(await publishPending(f.home, {}, f.broker, true, async () => { throw new Error('must-not-call'); }))
    .toMatchObject({ state: 'no-findings', claimCount: 0 });
});
test('a decision bound to another output hash does not count', async () => {
  const f = await fixture(true, 'none');
  const [item] = listForReview(f.home).items;
  expect(() => decide(f.home, { attemptToken: item!.attemptToken, observationIndex: 0, outputSha256: 'f'.repeat(64), decision: 'accept' }))
    .toThrow('review-output-changed');
  expect(await publishPending(f.home, {}, f.broker, true, passing)).toMatchObject({ state: 'idle' });
});
