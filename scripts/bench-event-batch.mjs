#!/usr/bin/env bun
// Compares one-at-a-time appends with batched appends at a size that matters for
// backfill. A batch verifies the tip once, reads the idempotency index once, and
// publishes one head, so the per-event cost stops depending on the store size.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendBrokerEvent, appendBrokerEvents, sha256 } from '../src/event-store.mjs';

function ref(kind, value) {
  return `acb://${kind}/${sha256(value)}`;
}

function candidate() {
  return {
    idempotencyKey: sha256(randomUUID()),
    eventType: 'peer-progress.published',
    occurredAt: '2026-08-25T10:00:00.000Z',
    provider: 'codex',
    scope: { kind: 'ticket', keyHash: sha256('APP-BENCH') },
    taskKeyHash: sha256('APP-BENCH'),
    threadKey: sha256('thread-bench'),
    sourceRefs: [ref('source', 'source-bench')],
    subjectRef: ref('progress', randomUUID()),
    replacesRef: null,
    evidenceRefs: [ref('doc', 'evidence-bench')],
    confidence: 0.95,
    freshness: {
      status: 'current',
      verifiedAt: '2026-08-25T10:00:00.000Z',
      expiresAt: null,
      sourceHeadHash: sha256('head-bench'),
      policy: 'ticket-live'
    },
    sensitivity: 'private',
    redactionResult: 'clean',
    approvalState: 'pending',
    payload: { actorKey: sha256(randomUUID()), reason: 'bench' }
  };
}

async function run(label, total, batchSize) {
  const runtimeRoot = join(tmpdir(), `acb-batch-bench-${randomUUID()}`);
  mkdirSync(runtimeRoot, { recursive: true });
  const started = performance.now();
  try {
    if (batchSize === 1) {
      for (let index = 0; index < total; index += 1) {
        await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
      }
    } else {
      for (let index = 0; index < total; index += batchSize) {
        const size = Math.min(batchSize, total - index);
        const events = Array.from({ length: size }, () => candidate());
        await appendBrokerEvents({ runtimeRoot, events, execute: true });
      }
    }
    const elapsed = performance.now() - started;
    console.log(
      label.padEnd(22) + ' | ' +
      (elapsed / 1000).toFixed(1).padStart(7) + ' s | ' +
      (elapsed / total).toFixed(2).padStart(8) + ' ms/event'
    );
    return elapsed;
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}

const total = 2000;
console.log(`ingesting ${total} events`);
console.log('mode                   |   total | per event');
console.log('-----------------------|---------|----------');
const single = await run('one at a time', total, 1);
const batched = await run('batches of 250', total, 250);
console.log('');
console.log(`batching is ${(single / batched).toFixed(1)}x faster at ${total} events`);
