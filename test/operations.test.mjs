import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { verifyEventStore } from '../src/event-store.mjs';
import { projectReadModel } from '../src/read-model.mjs';
import {
  diagnoseBroker,
  migrateLifecycleLedger,
  planLifecycleMigration
} from '../src/operations.mjs';

const roots = [];
function root(name) {
  const path = join(tmpdir(), `acb-operations-${name}-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

function ledgerPair(ledger, runId, provider = 'codex') {
  const sourceId = 'a'.repeat(64);
  const inventory = {
    schemaVersion: 1,
    runId,
    provider,
    adapterVersion: 'fixture',
    generatedAt: '2026-08-25T12:00:00.000Z',
    mode: 'observe',
    outputClass: 'private-metadata',
    sources: [{
      sourceId,
      sessionIdHash: 'b'.repeat(64),
      parentSessionIdHash: null,
      generation: 1,
      sizeBytes: 100,
      lastWriteAt: '2026-08-25T12:00:00.000Z',
      coverage: 'complete',
      coverageStartOffset: 0,
      nextOffset: 100,
      recordCounts: { event: 1 },
      malformedRecords: 0,
      firstEventAt: '2026-08-25T12:00:00.000Z',
      lastEventAt: '2026-08-25T12:00:00.000Z',
      threadState: 'completed',
      relationKeys: [`ticket:${'c'.repeat(64)}`],
      contentChainHash: 'd'.repeat(64),
      privacy: 'private'
    }],
    skipped: []
  };
  const delta = {
    schemaVersion: 1,
    deltaId: 'e'.repeat(64),
    sequence: 1,
    runId,
    provider,
    sourceId,
    observedAt: inventory.generatedAt,
    expiresAt: '2026-08-26T12:00:00.000Z',
    classification: 'candidate',
    threadState: 'completed',
    previousThreadState: null,
    relationKeys: inventory.sources[0].relationKeys,
    appendedBytes: 100,
    recordCountDelta: { event: 1 },
    coverage: 'complete'
  };
  writeFileSync(join(ledger, `${runId}.inventory.json`), `${JSON.stringify(inventory)}\n`, 'utf8');
  writeFileSync(join(ledger, `${runId}.deltas.jsonl`), `${JSON.stringify(delta)}\n`, 'utf8');
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('broker operations', () => {
  test('migration plan is read-only and execute is incremental', async () => {
    const base = root('migration');
    const ledger = join(base, 'ledger');
    const runtime = join(base, 'runtime');
    const events = join(base, 'events');
    mkdirSync(ledger, { recursive: true });
    ledgerPair(ledger, 'run-a');

    const plan = planLifecycleMigration({ ledgerDirectory: ledger, runtimeRoot: runtime });
    assert.equal(plan.pendingPairs, 1);
    assert.equal(existsSync(runtime), false);
    const first = await migrateLifecycleLedger({
      ledgerDirectory: ledger,
      runtimeRoot: runtime,
      eventRuntimeRoot: events,
      execute: true
    });
    const replay = await migrateLifecycleLedger({
      ledgerDirectory: ledger,
      runtimeRoot: runtime,
      eventRuntimeRoot: events,
      execute: true
    });
    assert.equal(first.migratedPairs, 1);
    assert.equal(replay.migratedPairs, 0);
    assert.equal(verifyEventStore({ runtimeRoot: events }).events.length, 2);
  });

  test('doctor is read-only and reports verified event state', async () => {
    const base = root('doctor');
    const ledger = join(base, 'ledger');
    const runtime = join(base, 'runtime');
    const events = join(base, 'events');
    const readModel = join(base, 'read-model');
    mkdirSync(ledger, { recursive: true });
    ledgerPair(ledger, 'run-a');
    await migrateLifecycleLedger({
      ledgerDirectory: ledger,
      runtimeRoot: runtime,
      eventRuntimeRoot: events,
      execute: true
    });
    projectReadModel({ runtimeRoot: events, outputRoot: readModel, execute: true });
    const result = diagnoseBroker({
      runtimeRoot: runtime,
      eventRuntimeRoot: events,
      readModelRoot: readModel
    });
    assert.equal(result.writesEnabled, false);
    assert.equal(result.eventStore.status, 'verified');
    assert.equal(result.eventStore.eventCount, 2);
    assert.equal(result.lifecycle.migratedInputs, 1);
    assert.equal(result.lifecycle.pendingOutbox, 0);
    assert.equal(result.lifecycle.deliveredOutbox, 1);
    assert.equal(result.readModel.eventHeadHash, result.eventStore.headHash);
  });
});
