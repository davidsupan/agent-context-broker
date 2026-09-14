import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { lifecycleOutboxEntry, observedAtFor } from '../src/lifecycle-events.mjs';

const RUN_TIME = '2026-09-14T15:00:00.000Z';

function source(overrides = {}) {
  return {
    sourceId: 'a'.repeat(64),
    sessionIdHash: 'b'.repeat(64),
    parentSessionIdHash: null,
    generation: 1,
    sizeBytes: 1024,
    lastWriteAt: RUN_TIME,
    coverage: 'full',
    coverageStartOffset: 0,
    nextOffset: 1024,
    recordCounts: { message: 3 },
    malformedRecords: 0,
    firstEventAt: '2026-05-28T10:00:00.000Z',
    lastEventAt: '2026-05-28T10:08:29.993Z',
    threadState: 'completed',
    relationKeys: ['workspace:' + 'c'.repeat(64)],
    contentChainHash: 'd'.repeat(64),
    privacy: 'private',
    ...overrides
  };
}

function delta(sourceId) {
  return {
    schemaVersion: 1,
    deltaId: 'e'.repeat(64),
    sequence: 1,
    runId: 'f'.repeat(64),
    provider: 'claude-code',
    sourceId,
    observedAt: RUN_TIME,
    expiresAt: null,
    classification: 'candidate',
    threadState: 'completed',
    previousThreadState: null,
    relationKeys: ['workspace:' + 'c'.repeat(64)],
    appendedBytes: 1024,
    recordCountDelta: { message: 3 },
    coverage: 'full'
  };
}

function inventory(sources) {
  return {
    schemaVersion: 1,
    provider: 'claude-code',
    adapterVersion: '0.1.0',
    runId: 'f'.repeat(64),
    generatedAt: RUN_TIME,
    sources,
    skipped: []
  };
}

describe('valid time comes from the source, not the run', () => {
  test('observedAtFor prefers the source newest record over the run timestamp', () => {
    assert.equal(observedAtFor(source(), RUN_TIME), '2026-05-28T10:08:29.993Z');
  });

  test('observedAtFor falls back to the run timestamp when the source has no usable time', () => {
    assert.equal(observedAtFor(source({ lastEventAt: null }), RUN_TIME), RUN_TIME);
    assert.equal(observedAtFor(source({ lastEventAt: 'not a date' }), RUN_TIME), RUN_TIME);
    assert.equal(observedAtFor(undefined, RUN_TIME), RUN_TIME);
  });

  test('an ingested historical thread carries its own valid time, not the ingest time', () => {
    const historical = source();
    const entry = lifecycleOutboxEntry(inventory([historical]), [delta(historical.sourceId)]);

    assert.equal(entry.events.length, 1);
    // Without this, backfilling months of history would stamp every thread with the
    // moment it was imported, and old context would outrank current context.
    assert.equal(entry.events[0].occurredAt, '2026-05-28T10:08:29.993Z');
    assert.notEqual(entry.events[0].occurredAt, RUN_TIME);
    assert.equal(entry.attestations[0].observedAt, '2026-05-28T10:08:29.993Z');
  });

  test('sources ingested in one run keep distinct valid times', () => {
    const may = source({ sourceId: '1'.repeat(64), lastEventAt: '2026-05-28T10:08:29.993Z' });
    const september = source({ sourceId: '2'.repeat(64), lastEventAt: '2026-09-14T09:00:00.000Z' });
    const entry = lifecycleOutboxEntry(
      inventory([may, september]),
      [delta(may.sourceId), delta(september.sourceId)]
    );

    const observed = entry.attestations.map((attestation) => attestation.observedAt);
    assert.deepEqual(observed, ['2026-05-28T10:08:29.993Z', '2026-09-14T09:00:00.000Z']);
  });
});
