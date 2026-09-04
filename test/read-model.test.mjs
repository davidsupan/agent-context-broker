import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { appendBrokerEvent, sha256 } from '../src/event-store.mjs';
import { planReadModel, projectReadModel } from '../src/read-model.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-read-model-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function ref(kind, value) {
  return `acb://${kind}/${sha256(value)}`;
}

function event(overrides = {}) {
  return {
    idempotencyKey: sha256(randomUUID()),
    eventType: 'claim.accepted',
    occurredAt: '2026-08-25T10:00:00.000Z',
    provider: 'claude-code',
    scope: { kind: 'project', keyHash: sha256('example-project') },
    taskKeyHash: sha256('task-a'),
    threadKey: sha256('thread-a'),
    sourceRefs: [ref('source', 'source-a')],
    subjectRef: ref('claim', 'claim-a'),
    replacesRef: null,
    evidenceRefs: [ref('doc', 'doc-a')],
    confidence: 1,
    freshness: {
      status: 'current',
      verifiedAt: '2026-08-25T10:00:00.000Z',
      expiresAt: null,
      sourceHeadHash: sha256('head-a'),
      policy: 'canonical-head'
    },
    sensitivity: 'shared',
    redactionResult: 'clean',
    approvalState: 'approved',
    payload: { claimCount: 1 },
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('deterministic broker read model', () => {
  test('strict isolation returns before reading invalid runtime state', () => {
    const result = projectReadModel({
      strictIsolation: true,
      runtimeRoot: 'Z:\\definitely-unavailable',
      execute: true
    });
    assert.deepEqual(result, {
      schemaVersion: 1,
      mode: 'read-model',
      strictIsolation: true,
      reads: 0,
      writes: 0
    });
  });

  test('plan is read-only and requires no event-store read', () => {
    const runtimeRoot = root('plan');
    const plan = planReadModel({ runtimeRoot });
    assert.equal(plan.writesEnabled, false);
    assert.equal(plan.strictIsolation, false);
  });

  test('projects deterministic nodes, edges, indexes, and manifest', async () => {
    const runtimeRoot = root('project');
    await appendBrokerEvent({
      runtimeRoot,
      event: event(),
      execute: true,
      now: '2026-08-25T10:01:00.000Z'
    });
    const first = projectReadModel({ runtimeRoot, execute: true });
    const outputRoot = join(runtimeRoot, 'read-model');
    const files = ['nodes.jsonl', 'edges.jsonl', 'indexes.json', 'manifest.json'];
    const firstBytes = Object.fromEntries(files.map((file) => [
      file,
      readFileSync(join(outputRoot, file), 'utf8')
    ]));
    rmSync(outputRoot, { recursive: true, force: true });
    const rebuilt = projectReadModel({ runtimeRoot, execute: true });
    const rebuiltBytes = Object.fromEntries(files.map((file) => [
      file,
      readFileSync(join(outputRoot, file), 'utf8')
    ]));

    assert.equal(first.nodeCount, 3);
    assert.equal(first.edgeCount, 2);
    assert.equal(rebuilt.projectionHash, first.projectionHash);
    assert.deepEqual(rebuiltBytes, firstBytes);
  });

  test('unchanged event head produces zero projection writes', async () => {
    const runtimeRoot = root('unchanged');
    await appendBrokerEvent({ runtimeRoot, event: event(), execute: true });
    projectReadModel({ runtimeRoot, execute: true });
    const second = projectReadModel({ runtimeRoot, execute: true });
    assert.equal(second.unchanged, true);
    assert.equal(second.writes, 0);
  });
});
