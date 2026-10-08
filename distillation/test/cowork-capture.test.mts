import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { COWORK_USER_PREFIX, coworkDialogue, planCoworkCapture, readCoworkCapture } from '../src/cowork-capture.mts';
import { LiveProbeOptionsSchema } from '../src/capability-probe.mts';
import { syntheticDistillationRequest } from '../src/distillation-probe.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('cleanup-boundary');
    rmSync(root, { recursive: true, force: true });
  }
});
function capture(rows: Array<{ index: number; text: string }>, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cowork-capture-test-'));
  roots.push(root);
  const path = join(root, 'transcript.json');
  writeFileSync(path, JSON.stringify({ session: 'cse_01TEST', title: 'Fixture', url: 'https://claude.ai/x', captured: '2026-10-06T12:52:07.234Z', rows, ...extra }));
  return path;
}
const rows = [
  { index: 0, text: `${COWORK_USER_PREFIX}Fictional question about a Beacon colour.` },
  { index: 1, text: 'Fictional answer: the Beacon colour stays blue.' },
  { index: 2, text: `${COWORK_USER_PREFIX}You said: nested prefix stays in the text.` },
];

test('rows become dialogue in order; the user prefix decides the role and is stripped once', () => {
  const { capture: parsed, fileSha256 } = readCoworkCapture(capture(rows));
  expect(fileSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(coworkDialogue(parsed)).toEqual([
    { role: 'user', text: 'Fictional question about a Beacon colour.' },
    { role: 'assistant', text: 'Fictional answer: the Beacon colour stays blue.' },
    { role: 'user', text: 'You said: nested prefix stays in the text.' },
  ]);
});

test('a capture with a gap, a wrong order, an unknown field or an empty row is refused', () => {
  expect(() => readCoworkCapture(capture([rows[0]!, { index: 2, text: 'gap' }]))).toThrow('capture-cowork-row-order');
  expect(() => readCoworkCapture(capture([rows[1]!, rows[0]!]))).toThrow('capture-cowork-row-order');
  expect(() => readCoworkCapture(capture(rows, { roles: [] }))).toThrow('capture-cowork-shape');
  expect(() => readCoworkCapture(capture([{ index: 0, text: '' }]))).toThrow('capture-cowork-shape');
});

test('the plan uses the session as source key, derives stable ids and redacts like transcripts', () => {
  const secret = `${COWORK_USER_PREFIX}token glpat-${'x'.repeat(20)} must not reach a slice.`;
  const plan = planCoworkCapture(capture([...rows, { index: 3, text: secret }]), 512);
  expect(plan.sourceKey).toBe('cowork-capture:cse_01TEST');
  expect(plan.rows).toBe(4); expect(plan.userRows).toBe(3); expect(plan.assistantRows).toBe(1);
  expect(plan.jobId).toMatch(/^[a-f0-9]{64}$/); expect(plan.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  const again = planCoworkCapture(capture([...rows, { index: 3, text: secret }]), 512);
  expect(again.jobId).toBe(plan.jobId); expect(again.plan.slices.map(s => s.sliceId)).toEqual(plan.plan.slices.map(s => s.sliceId));
  const text = plan.plan.slices.flatMap(s => s.segments.map(x => x.text)).join('\n');
  expect(text).not.toContain('glpat-');
  expect(Object.values(plan.plan.redactionKinds).reduce((n, c) => n + c, 0)).toBeGreaterThan(0);
  // Block numbers are the row indexes, so a source ref points back to one captured row.
  expect(plan.plan.slices[0]!.segments[0]!.block).toBe(0);
});

test('an approved real slice needs its own approval scope, a Claude provider and the slice', () => {
  const base = { provider: 'claude', executable: 'C:/fixture/claude.exe', executableSha256: 'a'.repeat(64),
    version: '2.1.263', model: 'haiku', home: 'C:/fixture', authHome: 'C:/auth',
    capabilityReceipt: { path: 'C:/fixture/capability.json', sha256: 'b'.repeat(64) } };
  const slice = syntheticDistillationRequest('claude').slice;
  const approval = { id: 'slice-test', scope: 'one-approved-slice-call', providers: ['claude'], maxCalls: 1,
    timeoutPerProviderMs: 60000, globalBudgetSeconds: 1800 };
  expect(LiveProbeOptionsSchema.safeParse({ ...base, purpose: 'approved-slice', slice, approval }).success).toBe(true);
  expect(LiveProbeOptionsSchema.safeParse({ ...base, purpose: 'approved-slice', approval }).success).toBe(false);
  expect(LiveProbeOptionsSchema.safeParse({ ...base, purpose: 'distillation', slice, approval }).success).toBe(false);
  expect(LiveProbeOptionsSchema.safeParse({ ...base, purpose: 'approved-slice', slice,
    approval: { ...approval, scope: 'one-synthetic-distillation-call' } }).success).toBe(false);
  expect(LiveProbeOptionsSchema.safeParse({ ...base, provider: 'codex', purpose: 'approved-slice', slice, approval }).success).toBe(false);
});
