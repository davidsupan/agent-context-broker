import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/sqlite.mts';
import { runCapture, sha256 } from '../src/capture.mts';
import { prepareSlices } from '../src/slice-queue.mts';
import { consumeSlice, type ModelRequest, type ModelResult } from '../src/consumer.mts';
import { coverage } from '../src/slicing.mts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acb-consume-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'history.json'); writeFileSync(path, registry);
  writeFileSync(join(source, 'a.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use a single worker and retain evidence.' }] } }) + '\n');
  runCapture({ providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 }, home, true);
  prepareSlices(home, [], 16000, true);
  return { root, source, home };
}
function inspect(home: string, sql: string) { const db = new Database(join(home, 'queue.sqlite3'), { readonly: true }); try { return db.query(sql).all() as Record<string, unknown>[]; } finally { db.close(); } }
function answer(r: ModelRequest): Promise<ModelResult> {
  return Promise.resolve({ state: 'output', completionProof: 'synthetic-fixture', durationMs: 1,
    output: { schemaVersion: 1, sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: 'no-durable-findings', observations: [] },
    usage: { input_tokens: 10, cache_read_input_tokens: 5, accountEmail: 'must-not-persist' } });
}
const policy = { claudeAvailable: true, attemptSeconds: 60 };
const options = { synthetic: true, now: Date.UTC(2026, 8, 21, 12) / 1000 };
test('complete source-to-result flow stays pending and does not rerun after restart', async () => {
  const f = fixture(); let calls = 0;
  const runner = async (r: ModelRequest) => { calls++; return answer(r); };
  expect(await consumeSlice(f.home, policy, runner, options)).toMatchObject({ state: 'pending-review', accepted: false, provider: 'claude', refundSeconds: 0 });
  expect(await consumeSlice(f.home, policy, runner, options)).toMatchObject({ state: 'idle', invoked: false });
  expect(calls).toBe(1); expect(inspect(f.home, 'SELECT * FROM semantic_budget')[0]!.seconds).toBe(60);
  expect(inspect(f.home, 'SELECT state FROM jobs')[0]!.state).toBe('pending-review');
  const receipt = readFileSync(join(f.home, 'semantic-results', readdirSync(join(f.home, 'semantic-results'))[0]!), 'utf8');
  expect(receipt).toContain('cache_read_input_tokens'); expect(receipt).not.toContain('must-not-persist');
});
test('unverified adapter never dispatches', async () => {
  const f = fixture(); expect(await consumeSlice(f.home, policy)).toMatchObject({ state: 'adapter-unverified', invoked: false });
});

test('adapter preflight failure reserves no budget and dispatches nothing', async () => {
  const f = fixture(); let calls = 0;
  const runner = Object.assign(async (r: ModelRequest) => { calls++; return answer(r); }, {
    preflight: async () => { throw new Error('adapter-proof-expired'); }
  });
  await expect(consumeSlice(f.home, policy, runner, options)).rejects.toThrow('adapter-proof-expired');
  expect(calls).toBe(0);
  expect(inspect(f.home, 'SELECT * FROM semantic_attempts')).toHaveLength(0);
  expect(inspect(f.home, 'SELECT * FROM semantic_budget')).toHaveLength(0);
});
test('synthetic completion proof cannot release a production lease', async () => {
  const f = fixture(); expect(await consumeSlice(f.home, policy, answer, { now: options.now })).toMatchObject({ leaseRetained: true });
  expect(inspect(f.home, 'SELECT state FROM semantic_attempts')[0]!.state).toBe('running');
});
test('unknown runner failure retains lease and never falls back', async () => {
  const f = fixture(); let calls = 0;
  const runner = async () => { calls++; throw new Error('sensitive provider failure'); };
  expect(await consumeSlice(f.home, { ...policy, codexAvailable: true }, runner, options)).toMatchObject({ state: 'containment-unresolved', leaseRetained: true });
  expect(await consumeSlice(f.home, { ...policy, codexAvailable: true }, runner, options)).toMatchObject({ state: 'leased', invoked: false });
  expect(calls).toBe(1);
});
test('explicit quota result uses one shared allowance for fallback', async () => {
  const f = fixture(); const providers: string[] = [];
  const runner = async (r: ModelRequest): Promise<ModelResult> => {
    providers.push(r.provider);
    return r.provider === 'claude' ? { state: 'quota-unavailable', completionProof: 'synthetic-fixture', durationMs: 1 } : answer(r);
  };
  const p = { ...policy, codexAvailable: true };
  expect(await consumeSlice(f.home, p, runner, options)).toMatchObject({ state: 'quota-unavailable' });
  expect(await consumeSlice(f.home, p, runner, options)).toMatchObject({ state: 'pending-review', provider: 'codex' });
  expect(providers).toEqual(['claude', 'codex']); expect(inspect(f.home, 'SELECT * FROM semantic_budget')[0]!.seconds).toBe(120);
});
test('false accepted output is rejected without retry or raw output storage', async () => {
  const f = fixture();
  const runner = async (r: ModelRequest): Promise<ModelResult> => ({ ...await answer(r), output: { accepted: true, secret: 'not-persisted' } });
  expect(await consumeSlice(f.home, policy, runner, options)).toMatchObject({ state: 'invalid-output-or-source', accepted: false });
  expect(await consumeSlice(f.home, policy, runner, options)).toMatchObject({ state: 'idle' });
  expect(inspect(f.home, 'SELECT output_json FROM semantic_attempts')[0]!.output_json).toBeNull();
});
test('exclusion changed while a model ran blocks the result', async () => {
  const f = fixture();
  expect(await consumeSlice(f.home, policy, answer, { ...options, rereadPolicy: () => ({ ...policy, excludedSources: ['codex:a.jsonl'] }) }))
    .toMatchObject({ state: 'invalid-output-or-source' });
});
test('second concurrent consumer cannot dispatch while first owns lease', async () => {
  const f = fixture(); let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let called!: () => void; const started = new Promise<void>(resolve => { called = resolve; });
  const first = consumeSlice(f.home, policy, async r => { called(); await blocked; return answer(r); }, options);
  await started;
  try { expect(await consumeSlice(f.home, policy, answer, options)).toMatchObject({ state: 'leased', invoked: false }); }
  finally { release(); await first; }
  expect(await first).toMatchObject({ state: 'pending-review' });
});
