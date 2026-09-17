#!/usr/bin/env bun
// Measures what one append costs as the store grows. appendBrokerEvent verifies the
// whole chain before writing, so building a store of N events is quadratic. This is
// the number that decides whether backfilling thousands of events is feasible.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { appendBrokerEvent, sha256 } from '../src/event-store.mjs';

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

const runtimeRoot = join(tmpdir(), `acb-append-bench-${randomUUID()}`);
mkdirSync(runtimeRoot, { recursive: true });
const checkpoints = new Set([50, 100, 200, 400, 600, 800]);
const total = 800;
let cumulative = 0;

console.log('store size | this append | cumulative');
console.log('-----------|-------------|-----------');
try {
  for (let index = 1; index <= total; index += 1) {
    const started = performance.now();
    await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    const elapsed = performance.now() - started;
    cumulative += elapsed;
    if (checkpoints.has(index)) {
      console.log(
        String(index).padStart(10) + ' | ' +
        (elapsed.toFixed(1) + ' ms').padStart(11) + ' | ' +
        (cumulative / 1000).toFixed(1) + ' s'
      );
    }
  }
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}
