#!/usr/bin/env bun
// Measures what a per-prompt peer-progress read costs as the event store grows:
// a full chain verification versus a bounded tail read. Not a test; run manually.
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendBrokerEvent,
  sha256,
  verifyEventStore,
  verifyEventTail
} from '../src/event-store.mjs';

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

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

function time(runs, action) {
  const samples = [];
  for (let index = 0; index < runs; index += 1) {
    const started = performance.now();
    action();
    samples.push(performance.now() - started);
  }
  return median(samples);
}

const sizes = [100, 500, 1000, 2000];
console.log('events |  full verify |  tail(512) | ratio');
console.log('-------|--------------|------------|------');
for (const size of sizes) {
  const runtimeRoot = join(tmpdir(), `acb-bench-${randomUUID()}`);
  mkdirSync(runtimeRoot, { recursive: true });
  try {
    for (let index = 0; index < size; index += 1) {
      await appendBrokerEvent({ runtimeRoot, event: candidate(), execute: true });
    }
    const full = time(5, () => verifyEventStore({ runtimeRoot }));
    const tail = time(5, () => verifyEventTail({ runtimeRoot, count: 512 }));
    console.log(
      String(size).padStart(6) + ' | ' +
      (full.toFixed(1) + ' ms').padStart(12) + ' | ' +
      (tail.toFixed(1) + ' ms').padStart(10) + ' | ' +
      (full / tail).toFixed(1) + 'x'
    );
  } finally {
    rmSync(runtimeRoot, { recursive: true, force: true });
  }
}
