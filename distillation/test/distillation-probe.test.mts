import { expect, test } from './expect.mts';
import { syntheticDistillationRequest, validateSyntheticDistillation } from '../src/distillation-probe.mts';
import { LiveProbeOptionsSchema } from '../src/capability-probe.mts';

function valid() {
  const request = syntheticDistillationRequest('claude');
  const spans = request.slice.segments.map(({ block, startChar, endChar }) => ({ block, startChar, endChar }));
  // The model reports findings only; the runner adds the slice's coverage.
  return { schemaVersion: 1, sliceId: request.slice.sliceId,
    observations: [{ kind: 'correction', summary: 'Beacon retention changed from 7 to 14 days.', sourceRefs: [spans[2]!] }] };
}

test('synthetic probe uses the production serializer and schema without a contradictory toy instruction', () => {
  const request = syntheticDistillationRequest('claude');
  const input = JSON.parse(request.input);
  expect(input.untrustedDialogue).toEqual(request.slice.segments);
  expect(input.untrustedSlice).toEqual(request.slice);
  expect(input.syntheticProbe).toBeUndefined();
  expect(JSON.parse(request.schemaText)).toEqual(request.outputSchema);
  expect(JSON.parse(request.schemaText).$schema).toBe('http://json-schema.org/draft-07/schema#');
  expect(request.slice.segments).toHaveLength(3);
});

test('successful distillation is still unverified and awaiting review', () => {
  expect(validateSyntheticDistillation(valid(), 'claude')).toMatchObject({ accepted: false, state: 'pending-review', verification: 'unverified' });
});

test('schema-valid silence, wrong semantics, model-echoed coverage and invented references fail', () => {
  const empty = { ...valid(), observations: [] };
  expect(() => validateSyntheticDistillation(empty, 'claude')).toThrow('probe-distillation-correction-missing');
  const stale = valid(); stale.observations[0]!.summary = 'Beacon retention is 7 days.';
  expect(() => validateSyntheticDistillation(stale, 'claude')).toThrow('probe-distillation-correction-missing');
  const echoed = { ...valid(), coverage: [] };
  expect(() => validateSyntheticDistillation(echoed, 'claude')).toThrow('Unrecognized key');
  const invented = valid(); invented.observations[0]!.sourceRefs[0] = { block: 99, startChar: 0, endChar: 1 };
  expect(() => validateSyntheticDistillation(invented, 'claude')).toThrow('ref-outside-slice');
});

test('single Claude approval cannot authorize Codex or a different purpose', () => {
  const options = { provider: 'claude', executable: 'C:/fixture/claude.exe', executableSha256: 'a'.repeat(64),
    version: '2.1.263', model: 'haiku', home: 'C:/fixture', authHome: 'C:/auth', purpose: 'distillation',
    capabilityReceipt: { path: 'C:/fixture/capability.json', sha256: 'b'.repeat(64) },
    approval: { id: 'synthetic-test', scope: 'one-synthetic-distillation-call', providers: ['claude'], maxCalls: 1,
      timeoutPerProviderMs: 60000, globalBudgetSeconds: 1800 } };
  expect(LiveProbeOptionsSchema.safeParse(options).success).toBe(true);
  expect(LiveProbeOptionsSchema.safeParse({ ...options, provider: 'codex' }).success).toBe(false);
  expect(LiveProbeOptionsSchema.safeParse({ ...options, purpose: 'boolean-smoke' }).success).toBe(false);
});
