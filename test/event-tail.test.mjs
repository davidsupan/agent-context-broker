import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  appendBrokerEvent,
  sha256,
  verifyEventStore,
  verifyEventTail
} from '../src/event-store.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-tail-${name}-${randomUUID()}`);
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

async function storeWith(runtimeRoot, count) {
  for (let index = 0; index < count; index += 1) {
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
  }
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('bounded event tail reads', () => {
  test('an empty store reports an empty tail', () => {
    const runtimeRoot = root('empty');
    const tail = verifyEventTail({ runtimeRoot });
    assert.deepEqual(tail.events, []);
    assert.equal(tail.head.sequence, 0);
    assert.equal(tail.truncated, false);
  });

  test('a tail smaller than the store returns only the newest records and the committed head', async () => {
    const runtimeRoot = root('window');
    await storeWith(runtimeRoot, 6);

    const tail = verifyEventTail({ runtimeRoot, count: 2 });
    const full = verifyEventStore({ runtimeRoot });

    assert.equal(tail.events.length, 2);
    assert.equal(tail.truncated, true);
    assert.deepEqual(tail.events.map((event) => event.sequence), [5, 6]);
    // The head a bounded read reports must be identical to the fully verified head.
    assert.deepEqual(tail.head, full.head);
  });

  test('a tail covering the whole store matches a full verification', async () => {
    const runtimeRoot = root('whole');
    await storeWith(runtimeRoot, 3);

    const tail = verifyEventTail({ runtimeRoot, count: 50 });
    const full = verifyEventStore({ runtimeRoot });

    assert.equal(tail.truncated, false);
    assert.deepEqual(tail.events.map((event) => event.eventId), full.events.map((event) => event.eventId));
    assert.deepEqual(tail.head, full.head);
  });

  test('a tampered record inside the window fails closed', async () => {
    const runtimeRoot = root('tampered');
    await storeWith(runtimeRoot, 4);

    const recordsRoot = join(runtimeRoot, 'events', 'records');
    const { readdirSync } = await import('node:fs');
    const newest = readdirSync(recordsRoot).sort().at(-1);
    const path = join(recordsRoot, newest);
    const event = JSON.parse(readFileSync(path, 'utf8'));
    event.payload = { reason: 'tampered', evidenceCount: 99 };
    writeFileSync(path, JSON.stringify(event));

    assert.throws(() => verifyEventTail({ runtimeRoot, count: 2 }));
  });

  test('a broken link between the anchor and the window fails closed', async () => {
    const runtimeRoot = root('unlinked');
    await storeWith(runtimeRoot, 4);

    const recordsRoot = join(runtimeRoot, 'events', 'records');
    const { readdirSync } = await import('node:fs');
    const names = readdirSync(recordsRoot).sort();
    // Break the anchor the window links back to.
    const anchorPath = join(recordsRoot, names[1]);
    const anchor = JSON.parse(readFileSync(anchorPath, 'utf8'));
    anchor.eventId = '0'.repeat(64);
    writeFileSync(anchorPath, JSON.stringify(anchor));

    assert.throws(() => verifyEventTail({ runtimeRoot, count: 2 }));
  });

  test('a stable incorrect head fails closed even for a bounded read', async () => {
    const runtimeRoot = root('bad-head');
    await storeWith(runtimeRoot, 3);

    const headPath = join(runtimeRoot, 'events', 'head.json');
    const head = JSON.parse(readFileSync(headPath, 'utf8'));
    head.headHash = '0'.repeat(64);
    writeFileSync(headPath, JSON.stringify(head));

    assert.throws(() => verifyEventTail({ runtimeRoot, count: 2 }),
      /Broker event head verification failed/u);
  });

  test('a missing head fails closed rather than reporting an empty store', async () => {
    const runtimeRoot = root('missing-head');
    await storeWith(runtimeRoot, 2);
    unlinkSync(join(runtimeRoot, 'events', 'head.json'));

    assert.throws(() => verifyEventTail({ runtimeRoot, count: 2 }),
      /Broker event head is missing/u);
  });

  test('a bounded read touches fewer records than a full verification', async () => {
    const runtimeRoot = root('cost');
    await storeWith(runtimeRoot, 40);

    const full = verifyEventStore({ runtimeRoot });
    const tail = verifyEventTail({ runtimeRoot, count: 5 });

    assert.equal(full.events.length, 40);
    assert.equal(tail.events.length, 5);
    assert.deepEqual(tail.head, full.head);
  });
});
