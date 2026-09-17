import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { appendBrokerEvent, sha256, verifyEventStore } from '../src/event-store.mjs';
import { deliverLifecycleOutbox } from '../src/lifecycle-events.mjs';
import { planPeerProgressPublication, publishPeerProgress } from '../src/peer-progress.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-parallel-${name}-${randomUUID()}`);
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
    evidenceRefs: [],
    confidence: 0.9,
    freshness: {
      status: 'current', verifiedAt: '2026-08-25T10:00:00.000Z', expiresAt: null,
      sourceHeadHash: null, policy: 'test'
    },
    sensitivity: 'shared',
    redactionResult: 'clean',
    approvalState: 'not-required',
    payload: { schema: 'test-v1' },
    ...overrides
  };
}

const recordsDir = (runtimeRoot) => join(runtimeRoot, 'events', 'records');

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { force: true, recursive: true });
});

describe('a second genesis written beside the real chain is named, not mistaken for corruption', () => {
  test('duplicate sequence records fail verification with the sequences called out', async () => {
    const live = root('live');
    for (let index = 0; index < 4; index += 1) {
      await appendBrokerEvent({ runtimeRoot: live, event: candidate(), execute: true });
    }
    // A writer that could not see the committed head starts again at sequence 1. Its
    // records land in the same directory with different eventIds, so the filenames share
    // the 12-digit sequence prefix but nothing else.
    const fork = root('fork');
    await appendBrokerEvent({ runtimeRoot: fork, event: candidate(), execute: true });
    await appendBrokerEvent({ runtimeRoot: fork, event: candidate(), execute: true });
    for (const name of readdirSync(recordsDir(fork))) {
      copyFileSync(join(recordsDir(fork), name), join(recordsDir(live), name));
    }

    assert.throws(() => verifyEventStore({ runtimeRoot: live }),
      /duplicate sequence records \(a parallel chain\) at: 1, 2\./u);
  });

  test('moving the foreign records out restores verification without touching the head', async () => {
    const live = root('live-repair');
    for (let index = 0; index < 3; index += 1) {
      await appendBrokerEvent({ runtimeRoot: live, event: candidate(), execute: true });
    }
    const headBefore = readFileSync(join(live, 'events', 'head.json'), 'utf8');
    const legit = new Set(readdirSync(recordsDir(live)));

    const fork = root('fork-repair');
    await appendBrokerEvent({ runtimeRoot: fork, event: candidate(), execute: true });
    const [foreign] = readdirSync(recordsDir(fork));
    copyFileSync(join(recordsDir(fork), foreign), join(recordsDir(live), foreign));
    assert.throws(() => verifyEventStore({ runtimeRoot: live }), /parallel chain/u);

    // The repair used on the shared runtime: quarantine what the committed chain does not
    // reference. The head is never rewritten, so nothing about the real history changes.
    const quarantine = root('quarantine');
    renameSync(join(recordsDir(live), foreign), join(quarantine, foreign));

    const verified = verifyEventStore({ runtimeRoot: live });
    assert.equal(verified.events.length, 3);
    assert.deepEqual(new Set(readdirSync(recordsDir(live))), legit);
    assert.equal(readFileSync(join(live, 'events', 'head.json'), 'utf8'), headBefore);
  });
});

describe('a lifecycle hook may not start a chain, a deliberate backfill may', () => {
  function outbox(lifecycleRoot) {
    const pending = join(lifecycleRoot, 'event-outbox', 'pending');
    mkdirSync(pending, { recursive: true });
    const entry = {
      schemaVersion: 1,
      runId: randomUUID(),
      inventoryHash: sha256('inventory'),
      attestations: [],
      events: [candidate({ eventType: 'thread.delta', payload: { schema: 'thread-delta-v1' } })]
    };
    writeFileSync(join(pending, `${sha256(entry.runId)}.json`), JSON.stringify(entry), 'utf8');
    return pending;
  }
  const atomicWriter = (path, value) => writeFileSync(path, value, 'utf8');

  test('a lifecycle that has delivered before refuses an empty store and stays pending', async () => {
    const lifecycle = root('hook-lifecycle');
    const events = root('hook-events');
    const pending = outbox(lifecycle);
    // Prior activity: a receipt from an earlier delivery. Together with a store that now
    // shows no head, this is the contradiction that proves the hook is looking at the
    // wrong directory. It is what forked the shared store.
    const delivered = join(lifecycle, 'event-outbox', 'delivered');
    mkdirSync(delivered, { recursive: true });
    writeFileSync(join(delivered, `${sha256('earlier-run')}.json`),
      JSON.stringify({ schemaVersion: 1, eventIds: [sha256('earlier-event')] }), 'utf8');

    await assert.rejects(() => deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter
    }), /refused to start a new event chain/u);

    assert.equal(readdirSync(pending).length, 1, 'the outbox entry must remain for a later, correct delivery');
    assert.equal(verifyEventStore({ runtimeRoot: events }).events.length, 0, 'nothing may be written');
  });

  test('the first hook run after activation may seed a genuinely empty store', async () => {
    const lifecycle = root('first-lifecycle');
    const events = root('first-events');
    outbox(lifecycle);

    // No receipts anywhere: nothing has ever been delivered, so an empty store is exactly
    // what a fresh activation looks like and seeding it is correct.
    const result = await deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter
    });
    assert.equal(result.deliveredEvents, 1);
    assert.equal(verifyEventStore({ runtimeRoot: events }).events.length, 1);
  });

  test('a deliberate backfill opts in and seeds the store', async () => {
    const lifecycle = root('backfill-lifecycle');
    const events = root('backfill-events');
    outbox(lifecycle);

    const result = await deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter, allowGenesis: true
    });
    assert.equal(result.deliveredEvents, 1);
    assert.equal(verifyEventStore({ runtimeRoot: events }).events.length, 1);
  });

  test('delivery onto a store that already has a head needs no opt-in', async () => {
    const lifecycle = root('live-lifecycle');
    const events = root('live-events');
    await appendBrokerEvent({ runtimeRoot: events, event: candidate(), execute: true });
    outbox(lifecycle);

    const result = await deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter
    });
    assert.equal(result.deliveredEvents, 1);
    assert.equal(verifyEventStore({ runtimeRoot: events }).events.length, 2);
  });

  test('a receipt that delivered nothing does not prove a chain', async () => {
    const lifecycle = root('empty-receipt-lifecycle');
    const events = root('empty-receipt-events');
    outbox(lifecycle);
    const delivered = join(lifecycle, 'event-outbox', 'delivered');
    mkdirSync(delivered, { recursive: true });
    // The guard reads receipts, not file names: an entry that delivered no events left no
    // chain behind, so an empty store after it is not a contradiction.
    writeFileSync(join(delivered, `${sha256('empty-run')}.json`),
      JSON.stringify({ schemaVersion: 1, eventIds: [], headEventId: null }), 'utf8');

    const result = await deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter
    });
    assert.equal(result.deliveredEvents, 1);
  });

  test('an unreadable receipt counts as proof, so the guard fails closed', async () => {
    const lifecycle = root('garbage-receipt-lifecycle');
    const events = root('garbage-receipt-events');
    outbox(lifecycle);
    const delivered = join(lifecycle, 'event-outbox', 'delivered');
    mkdirSync(delivered, { recursive: true });
    writeFileSync(join(delivered, `${sha256('garbage-run')}.json`), 'not json', 'utf8');

    await assert.rejects(() => deliverLifecycleOutbox({
      lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter
    }), /refused to start a new event chain/u);
  });

  test('a receipt records the chain head it left behind', async () => {
    const lifecycle = root('receipt-head-lifecycle');
    const events = root('receipt-head-events');
    outbox(lifecycle);
    await deliverLifecycleOutbox({ lifecycleRuntimeRoot: lifecycle, eventRuntimeRoot: events, atomicWriter });

    const delivered = join(lifecycle, 'event-outbox', 'delivered');
    const [receipt] = readdirSync(delivered).map((name) => JSON.parse(readFileSync(join(delivered, name), 'utf8')));
    const verified = verifyEventStore({ runtimeRoot: events });
    assert.equal(receipt.headEventId, verified.head.eventId);
    assert.deepEqual(receipt.eventIds, [verified.head.eventId]);
  });
});

describe('a plain publish stays readable by a tool that predates the agent field', () => {
  async function source(eventRuntimeRoot) {
    const attestation = {
      schemaVersion: 1, provider: 'codex',
      sessionKey: sha256('s'), recordKey: sha256('r'), sourceHash: sha256('h'), inventoryHash: sha256('i'),
      observedAt: '2026-08-26T08:00:00.000Z',
      scope: { kind: 'project', keyHash: sha256('example-project') }, sensitivity: 'private'
    };
    await attestSource({ runtimeRoot: eventRuntimeRoot, attestation, execute: true });
    return planSourceAttestation({ attestation }).subjectRef;
  }

  test('the stored artifact has no agent key at all when none was declared', async () => {
    const runtimeRoot = root('compat-runtime');
    const eventRuntimeRoot = root('compat-events');
    const token = await source(eventRuntimeRoot);
    const proposal = {
      schemaVersion: 1, proposalId: 'compat-progress', sourceToken: token,
      scope: { kind: 'ticket', key: 'APP-60001' }, work: { kind: 'ticket', key: 'APP-60001' },
      state: 'active', stage: 'implementation', summary: 'No descriptor declared',
      nextSteps: [], limitations: [], changedSurfaces: [], canonicalRefs: [], relatedScopes: [],
      observedAt: '2026-08-26T08:05:00.000Z', ttlSeconds: 3600
    };
    const published = await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true, proposal, now: '2026-08-26T08:05:00.000Z'
    });
    const artifact = JSON.parse(readFileSync(
      join(runtimeRoot, 'peer-progress', 'records', `${published.progressId}.json`), 'utf8'));

    // An exact-field-set verifier in an older deployed tool rejects any unknown key, so
    // even `agent: null` would break every reader that has not been upgraded.
    assert.equal(Object.hasOwn(artifact, 'agent'), false);

    const plan = planPeerProgressPublication({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', now: '2026-08-26T08:05:00.000Z',
      proposal: { ...proposal, agent: { kind: 'interactive' } }
    });
    assert.ok(plan.progressId, 'declaring a descriptor still plans normally');
  });
});
