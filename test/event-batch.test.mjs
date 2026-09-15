import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  appendBrokerEvent,
  appendBrokerEvents,
  repairEventHead,
  sha256,
  verifyEventStore
} from '../src/event-store.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-batch-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function ref(kind, value) {
  return `acb://${kind}/${sha256(value)}`;
}

function candidate(overrides = {}) {
  return {
    idempotencyKey: sha256(randomUUID()),
    eventType: 'claim.proposed',
    occurredAt: '2026-08-25T10:00:00.000Z',
    provider: 'codex',
    scope: { kind: 'ticket', keyHash: sha256('APP-FIXTURE') },
    taskKeyHash: sha256('APP-FIXTURE'),
    threadKey: sha256('thread-a'),
    sourceRefs: [ref('source', 'source-a')],
    subjectRef: ref('claim', 'claim-a'),
    replacesRef: null,
    evidenceRefs: [ref('doc', 'evidence-a')],
    confidence: 0.95,
    freshness: {
      status: 'current',
      verifiedAt: '2026-08-25T10:00:00.000Z',
      expiresAt: null,
      sourceHeadHash: sha256('head-a'),
      policy: 'ticket-live'
    },
    sensitivity: 'private',
    redactionResult: 'clean',
    approvalState: 'pending',
    payload: { reason: 'candidate', evidenceCount: 1 },
    ...overrides
  };
}

const indexPath = (runtimeRoot) => join(runtimeRoot, 'events', 'idempotency.jsonl');
const recordCount = (runtimeRoot) =>
  readdirSync(join(runtimeRoot, 'events', 'records')).length;

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('batched event ingestion', () => {
  test('a batch produces the same chain a sequence of single appends would', async () => {
    const batchRoot = root('batch');
    const singleRoot = root('single');
    const inputs = Array.from({ length: 5 }, () => candidate());

    await appendBrokerEvents({ runtimeRoot: batchRoot, events: inputs, execute: true, now: '2026-08-25T11:00:00.000Z' });
    for (const input of inputs) {
      await appendBrokerEvent({ runtimeRoot: singleRoot, event: input, execute: true, now: '2026-08-25T11:00:00.000Z' });
    }

    const batched = verifyEventStore({ runtimeRoot: batchRoot });
    const singly = verifyEventStore({ runtimeRoot: singleRoot });

    assert.equal(batched.events.length, 5);
    assert.deepEqual(
      batched.events.map((event) => event.eventId),
      singly.events.map((event) => event.eventId)
    );
    assert.deepEqual(batched.head, singly.head);
  });

  test('replaying a batch returns idempotent replays and writes nothing new', async () => {
    const runtimeRoot = root('replay');
    const inputs = Array.from({ length: 4 }, () => candidate());

    const first = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });
    assert.deepEqual(first.map((event) => event.idempotentReplay), [false, false, false, false]);
    const afterFirst = recordCount(runtimeRoot);

    const second = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });
    assert.deepEqual(second.map((event) => event.idempotentReplay), [true, true, true, true]);
    assert.equal(recordCount(runtimeRoot), afterFirst);
    assert.deepEqual(
      second.map((event) => event.eventId),
      first.map((event) => event.eventId)
    );
  });

  test('a batch mixing new and already-seen events appends only the new ones', async () => {
    const runtimeRoot = root('mixed');
    const existing = candidate();
    await appendBrokerEvent({ runtimeRoot, event: existing, execute: true });

    const fresh = candidate();
    const results = await appendBrokerEvents({
      runtimeRoot, events: [existing, fresh], execute: true
    });

    assert.deepEqual(results.map((event) => event.idempotentReplay), [true, false]);
    assert.equal(recordCount(runtimeRoot), 2);
    assert.equal(verifyEventStore({ runtimeRoot }).head.sequence, 2);
  });

  test('a batch that repeats an idempotency key is rejected before anything is written', async () => {
    const runtimeRoot = root('repeat');
    const duplicated = candidate();

    await assert.rejects(
      appendBrokerEvents({ runtimeRoot, events: [duplicated, duplicated], execute: true }),
      /repeats an idempotency key/u
    );
    assert.equal(existsSync(join(runtimeRoot, 'events', 'records')), false);
  });

  test('a deleted index is rebuilt and idempotency still holds', async () => {
    const runtimeRoot = root('missing-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    unlinkSync(indexPath(runtimeRoot));
    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true, true]);
    assert.equal(recordCount(runtimeRoot), 3);
    assert.ok(existsSync(indexPath(runtimeRoot)));
  });

  test('an index missing entries behind an intact tip is rebuilt, not trusted', async () => {
    const runtimeRoot = root('holed-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    // Drop a middle line but keep the last one, so the index still reaches the committed
    // tip while no longer describing every event. Checking only the tip accepted this and
    // appended a duplicate for the key that fell in the hole.
    const lines = readFileSync(indexPath(runtimeRoot), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    writeFileSync(indexPath(runtimeRoot), [lines[0], lines[2]].join('\n') + '\n', 'utf8');

    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true, true]);
    assert.equal(recordCount(runtimeRoot), 3,
      'a replayed event must not be appended twice because the index lost its entry');
  });

  test('an index with a duplicated row cannot make a replay append twice', async () => {
    const runtimeRoot = root('dup-row-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    // Same line count as an intact index, same tip, but one key appears twice and one
    // key is gone. A count check accepts this; the replay of the missing key was appended
    // as a new event.
    const lines = readFileSync(indexPath(runtimeRoot), 'utf8').split('\n').filter(Boolean);
    writeFileSync(indexPath(runtimeRoot), [lines[0], lines[0], lines[2]].join('\n') + '\n', 'utf8');

    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });
    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true, true]);
    assert.equal(recordCount(runtimeRoot), 3, 'a replay must never increase the record count');
  });

  test('an index with two keys swapped cannot acknowledge the wrong event', async () => {
    const runtimeRoot = root('swapped-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    // Right count, right tip, distinct keys and sequences, and still wrong: key A points
    // at record B and vice versa. Only checking the loaded record's own key catches it.
    const rows = readFileSync(indexPath(runtimeRoot), 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line));
    const swapped = [
      { ...rows[0], sequence: rows[1].sequence },
      { ...rows[1], sequence: rows[0].sequence },
      rows[2]
    ];
    writeFileSync(indexPath(runtimeRoot), swapped.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });
    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true, true]);
    for (let index = 0; index < inputs.length; index += 1) {
      assert.equal(replay[index].idempotencyKey, inputs[index].idempotencyKey,
        'a replay must return the event that carries the requested key');
    }
    assert.equal(recordCount(runtimeRoot), 3);
  });

  test('a stale index is rebuilt rather than trusted', async () => {
    const runtimeRoot = root('stale-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    // Truncate the index so it no longer describes the committed tip.
    writeFileSync(indexPath(runtimeRoot), '', 'utf8');
    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true, true]);
    assert.equal(recordCount(runtimeRoot), 3);
  });

  test('a corrupt index line is rebuilt rather than failing the append', async () => {
    const runtimeRoot = root('corrupt-index');
    const inputs = Array.from({ length: 2 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    writeFileSync(indexPath(runtimeRoot), 'not json at all\n', 'utf8');
    const replay = await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    assert.deepEqual(replay.map((event) => event.idempotentReplay), [true, true]);
    assert.equal(recordCount(runtimeRoot), 2);
  });

  test('repair rebuilds the index alongside the head', async () => {
    const runtimeRoot = root('repair-index');
    const inputs = Array.from({ length: 3 }, () => candidate());
    await appendBrokerEvents({ runtimeRoot, events: inputs, execute: true });

    unlinkSync(indexPath(runtimeRoot));
    const repaired = await repairEventHead({ runtimeRoot, execute: true });

    assert.equal(repaired.eventCount, 3);
    assert.ok(existsSync(indexPath(runtimeRoot)));
    const lines = readFileSync(indexPath(runtimeRoot), 'utf8').trim().split('\n');
    assert.equal(lines.length, 3);
  });

  test('an empty batch is rejected', async () => {
    const runtimeRoot = root('empty-batch');
    await assert.rejects(
      appendBrokerEvents({ runtimeRoot, events: [], execute: true }),
      /at least one event/u
    );
  });
});
