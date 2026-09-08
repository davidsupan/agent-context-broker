import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  appendBrokerEvent,
  planBrokerEvent,
  repairEventHead,
  sha256,
  verifyEventStore
} from '../src/event-store.mjs';

const roots = [];
const cliPath = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function root(name) {
  const value = join(tmpdir(), `acb-event-${name}-${randomUUID()}`);
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

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('append-only broker event store', () => {
  test('an append between record and head publication is busy, not corrupt', async () => {
    const runtimeRoot = root('pending-head');
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const headPath = join(runtimeRoot, 'events', 'head.json');
    const firstHead = readFileSync(headPath, 'utf8');
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const secondHead = readFileSync(headPath, 'utf8');
    const lockPath = join(runtimeRoot, 'events', 'event-store.lock');
    // Recreate the real writer window: the new record exists but its head
    // has not been published yet, and the writer still owns the lock.
    writeFileSync(lockPath, JSON.stringify({ processId: process.pid }));
    writeFileSync(headPath, firstHead);
    assert.throws(() => verifyEventStore({ runtimeRoot }), { name: 'LockBusy' });
    assert.equal(readFileSync(headPath, 'utf8'), firstHead);
    writeFileSync(headPath, secondHead);
    unlinkSync(lockPath);
    assert.equal(verifyEventStore({ runtimeRoot }).events.length, 2);
  });

  test('a stable incorrect head still fails integrity verification', async () => {
    const runtimeRoot = root('incorrect-head');
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const headPath = join(runtimeRoot, 'events', 'head.json');
    const head = JSON.parse(readFileSync(headPath, 'utf8'));
    head.headHash = '0'.repeat(64);
    writeFileSync(headPath, JSON.stringify(head));
    assert.throws(() => verifyEventStore({ runtimeRoot }), /head verification failed/u);
  });

  test('planning validates without creating runtime files', () => {
    const runtimeRoot = root('plan');
    const plan = planBrokerEvent({ event: candidate() });
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(join(runtimeRoot, 'events')), false);
  });

  test('append creates a verified hash chain and idempotent replay', async () => {
    const runtimeRoot = root('append');
    const firstCandidate = candidate();
    const first = await appendBrokerEvent({
      runtimeRoot,
      event: firstCandidate,
      execute: true,
      now: '2026-08-25T10:01:00.000Z'
    });
    const replay = await appendBrokerEvent({
      runtimeRoot,
      event: firstCandidate,
      execute: true,
      now: '2026-08-25T10:02:00.000Z'
    });
    const second = await appendBrokerEvent({
      runtimeRoot,
      event: candidate({ eventType: 'claim.accepted', approvalState: 'approved' }),
      execute: true,
      now: '2026-08-25T10:03:00.000Z'
    });
    const verified = verifyEventStore({ runtimeRoot });

    assert.equal(first.sequence, 1);
    assert.equal(replay.eventId, first.eventId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(second.previousEventHash, first.eventId);
    assert.equal(verified.events.length, 2);
    assert.equal(verified.head.eventId, second.eventId);
  });

  test('rejects free-form or unsafe payload values before persistence', async () => {
    const runtimeRoot = root('unsafe');
    await assert.rejects(
      appendBrokerEvent({
        runtimeRoot,
        event: candidate({ payload: { note: 'raw free form sentence' } }),
        execute: true
      }),
      /policy metadata/u
    );
    assert.equal(existsSync(join(runtimeRoot, 'events')), false);
  });

  test('tampered immutable records fail closed', async () => {
    const runtimeRoot = root('tamper');
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const records = join(runtimeRoot, 'events', 'records');
    const path = join(records, readdirSync(records)[0]);
    const event = JSON.parse(readFileSync(path, 'utf8'));
    event.payload.evidenceCount = 2;
    writeFileSync(path, `${JSON.stringify(event, null, 2)}\n`, 'utf8');
    assert.throws(() => verifyEventStore({ runtimeRoot }), /chain verification/u);
  });

  test('missing event head can be rebuilt without changing records', async () => {
    const runtimeRoot = root('repair');
    const event = await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const records = join(runtimeRoot, 'events', 'records');
    const path = join(records, readdirSync(records)[0]);
    const before = readFileSync(path, 'utf8');
    unlinkSync(join(runtimeRoot, 'events', 'head.json'));
    const repaired = await repairEventHead({ runtimeRoot, execute: true });
    const after = readFileSync(path, 'utf8');

    assert.equal(repaired.eventCount, 1);
    assert.equal(repaired.head.eventId, event.eventId);
    assert.equal(after, before);
    assert.equal(verifyEventStore({ runtimeRoot }).events.length, 1);
  });

  test('parallel appends serialize into one gap-free chain', async () => {
    const runtimeRoot = root('parallel');
    const [left, right] = await Promise.all([
      appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true }),
      appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true })
    ]);
    const verified = verifyEventStore({ runtimeRoot });
    assert.deepEqual([left.sequence, right.sequence].sort(), [1, 2]);
    assert.equal(verified.events[1].previousEventHash, verified.events[0].eventId);
  });

  test('reclaims a lock owned by a process that has exited', async () => {
    const runtimeRoot = root('orphan-lock');
    const lockPath = join(runtimeRoot, 'events', 'event-store.lock');
    mkdirSync(join(runtimeRoot, 'events'), { recursive: true });
    const exitedProcess = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], {
      encoding: 'utf8'
    });
    assert.equal(exitedProcess.status, 0, exitedProcess.stderr);
    writeFileSync(lockPath, JSON.stringify({
      processId: Number(exitedProcess.stdout),
      acquiredAt: new Date().toISOString()
    }), 'utf8');

    const appended = await appendBrokerEvent({
      runtimeRoot,
      event: candidate(),
      execute: true,
      lockTimeoutMs: 100,
      lockRetryMs: 5
    });

    assert.equal(appended.sequence, 1);
    assert.equal(existsSync(lockPath), false);
  });

  test('does not reclaim a lock owned by a live process', async () => {
    const runtimeRoot = root('live-lock');
    const lockPath = join(runtimeRoot, 'events', 'event-store.lock');
    mkdirSync(join(runtimeRoot, 'events'), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({
      processId: process.pid,
      acquiredAt: '2026-01-01T00:00:00.000Z'
    }), 'utf8');

    await assert.rejects(
      appendBrokerEvent({
        runtimeRoot,
        event: candidate(),
        execute: true,
        lockTimeoutMs: 20,
        lockRetryMs: 5,
        lockStaleMs: 0
      }),
      /event store is busy/u
    );
    assert.equal(existsSync(lockPath), true);
  });

  test('reclaims malformed lock metadata only after the stale timeout', async () => {
    const runtimeRoot = root('malformed-lock');
    const lockPath = join(runtimeRoot, 'events', 'event-store.lock');
    mkdirSync(join(runtimeRoot, 'events'), { recursive: true });
    writeFileSync(lockPath, '{malformed', 'utf8');

    await assert.rejects(
      appendBrokerEvent({
        runtimeRoot,
        event: candidate(),
        execute: true,
        lockTimeoutMs: 20,
        lockRetryMs: 5,
        lockStaleMs: 600000
      }),
      /event store is busy/u
    );

    const old = new Date(Date.now() - 600001);
    utimesSync(lockPath, old, old);
    const appended = await appendBrokerEvent({
      runtimeRoot,
      event: candidate(),
      execute: true,
      lockTimeoutMs: 100,
      lockRetryMs: 5,
      lockStaleMs: 600000
    });
    assert.equal(appended.sequence, 1);
  });

  test('CLI event append plan is read-only', () => {
    const runtimeRoot = root('cli');
    const eventPath = join(runtimeRoot, 'candidate.json');
    writeFileSync(eventPath, `${JSON.stringify(candidate(), null, 2)}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      cliPath, 'event-append', '--event', eventPath, '--runtime-root',
      join(runtimeRoot, 'runtime')
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).writesEnabled, false);
    assert.equal(existsSync(join(runtimeRoot, 'runtime')), false);
  });
});
