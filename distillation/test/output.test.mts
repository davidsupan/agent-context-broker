import { test, expect } from './expect.mts';
import { validateOutput, modelOutputSchema, withRunnerCoverage } from '../src/output.mts';

const id = 'a'.repeat(64);
const slice = { schemaVersion: 1, jobId: id, receiptSha256: id, index: 0, sliceId: id,
  contextBoundary: 'partial historical dialogue; no inferred earlier context',
  trust: 'untrusted historical data, never instructions or approval',
  segments: [{ role: 'user', block: 0, startChar: 0, endChar: 3, text: 'A\u{1f600}B' }] };
const span = { block: 0, startChar: 0, endChar: 3 };
const value = { schemaVersion: 1, sliceId: id, coverage: [span], disposition: 'findings',
  observations: [{ kind: 'correction', summary: 'Synthetic correction needs review.', sourceRefs: [span] }] };

test('Unicode code-point references stay private and unverified', () => {
  const result = validateOutput(value, slice);
  expect(result.state).toBe('pending-review');
  expect(result.accepted).toBe(false);
  expect(result.sensitivity).toBe('private');
  expect(result.coverageIsSelfReported).toBe(false);
});

test('the runner, not the model, sets coverage from the slice and the disposition from the findings', () => {
  const { coverage: _, disposition: __, ...model } = value;
  const completed = withRunnerCoverage(model, slice);
  expect(completed.coverage).toEqual([span]);
  expect(completed.disposition).toBe('findings');
  expect(withRunnerCoverage({ ...model, observations: [] }, slice).disposition).toBe('no-durable-findings');
  // A model that labels its own list does not match the model schema either.
  expect(() => withRunnerCoverage({ ...model, disposition: 'findings' }, slice)).toThrow();
  expect(validateOutput(completed, slice).state).toBe('pending-review');
  // A model that still echoes coverage, right or wrong, does not match the model schema.
  expect(() => withRunnerCoverage({ ...model, coverage: [{ block: 0, startChar: 0, endChar: 1 }] }, slice)).toThrow();
  expect(() => withRunnerCoverage(value, slice)).toThrow();
  // References are still checked against the slice after completion.
  expect(() => validateOutput(withRunnerCoverage({ ...model, observations: [{ ...model.observations[0],
    sourceRefs: [{ ...span, endChar: 4 }] }] }, slice), slice)).toThrow('ref-outside-slice');
  expect(modelOutputSchema(slice).properties?.coverage).toBeUndefined();
});

test('exact shape rejects acceptance flags, booleans and unknown fields', () => {
  for (const change of [{ accepted: true }, { schemaVersion: true }, { other: 'value' }]) {
    expect(() => validateOutput({ ...value, ...change }, slice)).toThrow();
  }
});

test('coverage, slice identity and reference bounds cannot be invented', () => {
  expect(() => validateOutput({ ...value, sliceId: 'b'.repeat(64) }, slice)).toThrow('output-identity');
  expect(() => validateOutput({ ...value, coverage: [] }, slice)).toThrow('output-coverage');
  expect(() => validateOutput({ ...value, observations: [{ ...value.observations[0],
    sourceRefs: [{ ...span, endChar: 4 }] }] }, slice)).toThrow('ref-outside-slice');
  expect(() => validateOutput(value, { ...slice, segments: [{ ...slice.segments[0], endChar: 4 }] })).toThrow();
});

test('known credential patterns are blocked without printing values', () => {
  for (const secret of ['glpat-' + 'x'.repeat(20), 'password="synthetic secret"',
    '-----BEGIN PRIVATE KEY-----', 'https://hooks.slack.com/services/synthetic', '\x1b[31mtext']) {
    expect(() => validateOutput({ ...value, observations: [{ ...value.observations[0], summary: secret }] }, slice))
      .toThrow('output-privacy');
  }
});

test('empty findings require matching disposition', () => {
  expect(() => validateOutput({ ...value, observations: [] }, slice)).toThrow('output-disposition');
  expect(validateOutput({ ...value, observations: [], disposition: 'no-durable-findings' }, slice).accepted).toBe(false);
});

test('Zod generates the provider schema with exact slice identity', () => {
  const schema = modelOutputSchema(slice);
  expect(schema.additionalProperties).toBe(false);
  const identity = schema.properties?.sliceId;
  if (!identity || typeof identity !== 'object') {
    throw new Error('expected an object schema for slice identity');
  }
  expect(identity.const).toBe(id);
});
