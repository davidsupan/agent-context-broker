import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaily } from '../src/daily.mts';
import { sha256 } from '../src/capture.mts';
import { coverage } from '../src/slicing.mts';
import type { ModelRequest, ModelResult } from '../src/consumer.mts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function line(text: string) { return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'acb-daily-')); dirs.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'history.json'); writeFileSync(path, registry);
  const transcript = join(source, 'a.jsonl'); writeFileSync(transcript, line('Keep the output private.'));
  return { home, transcript, config: { capture: { providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 }, semantic: { claudeAvailable: true, attemptSeconds: 300 } } };
}
async function reply(r: ModelRequest): Promise<ModelResult> {
  return { state: 'output', completionProof: 'synthetic-fixture', durationMs: 1, output: { schemaVersion: 1,
    sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: 'no-durable-findings', observations: [] } };
}
const options = { synthetic: true, now: Date.UTC(2026, 8, 21, 12) / 1000 };
test('daily plan has no writes or calls', async () => {
  const f = fixture(); expect(await runDaily(f.config, f.home)).toMatchObject({ writes: false, modelCalls: 0 }); expect(existsSync(f.home)).toBe(false);
});
test('new transcript, restart and append are incrementally distilled without repeats', async () => {
  const f = fixture();
  expect(await runDaily(f.config, f.home, true, reply, options)).toMatchObject({ modelCalls: 1, fullyCurrent: false, productionEnabled: false });
  expect(await runDaily(f.config, f.home, true, reply, options)).toMatchObject({ modelCalls: 0 });
  appendFileSync(f.transcript, line('Retain crash receipts.'));
  expect(await runDaily(f.config, f.home, true, reply, options)).toMatchObject({ modelCalls: 1, status: { reservedSeconds: 600 } });
});
test('no adapter allows deterministic capture only', async () => {
  const f = fixture(); expect(await runDaily(f.config, f.home, true)).toMatchObject({ state: 'capture-only-adapter-unverified', modelCalls: 0 });
});
test('mismatched privacy policy fails before any writes', async () => {
  const f = fixture(); await expect(runDaily({ ...f.config, semantic: { ...f.config.semantic, excludedSources: ['codex:a.jsonl'] } }, f.home, true)).rejects.toThrow('exclusion-policy-mismatch'); expect(existsSync(f.home)).toBe(false);
});
test('quota-only fallback stays inside one durable shared budget', async () => {
  const f = fixture(); const providers: string[] = [];
  const runner = async (r: ModelRequest): Promise<ModelResult> => { providers.push(r.provider); return r.provider === 'claude'
    ? { state: 'quota-unavailable', completionProof: 'synthetic-fixture', durationMs: 1 } : reply(r); };
  const result = await runDaily({ ...f.config, semantic: { ...f.config.semantic, codexAvailable: true } }, f.home, true, runner, options);
  expect(result).toMatchObject({ modelCalls: 2, status: { reservedSeconds: 600 } }); expect(providers).toEqual(['claude', 'codex']);
});
test('budget survives separate invocations and stops at 1800 seconds', async () => {
  const f = fixture(); const config = { ...f.config, semantic: { ...f.config.semantic, attemptSeconds: 900 } };
  await runDaily(config, f.home, true, reply, options);
  appendFileSync(f.transcript, line('second')); await runDaily(config, f.home, true, reply, options);
  appendFileSync(f.transcript, line('third'));
  expect(await runDaily(config, f.home, true, reply, options)).toMatchObject({ state: 'paused-budget', modelCalls: 0, status: { reservedSeconds: 1800 } });
});
