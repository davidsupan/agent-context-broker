import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { reconcileClaimBatch } from '../src/reconciliation.mjs';

const roots = [];

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function root(name) {
  const value = join(tmpdir(), `acb-handoff-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function claim(overrides = {}) {
  return {
    claimKey: 'decision.retry-policy',
    claimType: 'decision',
    subject: 'ingest-pipeline',
    predicate: 'decided',
    value: 'retry transient failures twice before escalating',
    observedAt: '2026-08-25T09:00:00.000Z',
    confidence: 1,
    sensitivity: 'shared',
    evidenceClass: 'agent-handoff',
    verification: 'unverified',
    expectedCurrentClaimId: null,
    canonicalRefs: ['context://agent-context-broker/decision.retry-policy'],
    provenance: [{
      provider: 'claude-code',
      sessionKey: hash('session'),
      recordKey: hash('record'),
      sourceHash: hash('source')
    }],
    ...overrides
  };
}

function batch(claims) {
  return {
    schemaVersion: 1,
    batchId: `handoff-${randomUUID()}`,
    expectedSnapshotHash: null,
    scope: { kind: 'project', key: 'example-project' },
    relationKeys: [`project:${hash('example-project')}`],
    claims
  };
}

// Reconciliation reports a batch verdict, not a per-claim disposition list. An earlier
// version of this helper looked for a claims array that does not exist, so it always
// returned null and every assertion built on it passed regardless of behaviour.
function acceptedCount(result) {
  return result.acceptedClaimCount;
}

function issueReasons(result) {
  return (result.issues ?? []).map((issue) => issue.reason ?? issue.code ?? JSON.stringify(issue));
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('the model-assisted lane cannot reach accepted context on its own', () => {
  test('an agent-handoff claim is held for review, never auto-accepted', async () => {
    const runtimeRoot = root('handoff');
    const result = await reconcileClaimBatch({
      runtimeRoot,
      batch: batch([claim()]),
      execute: true,
      now: '2026-08-25T09:00:00.000Z'
    });

    const serialised = JSON.stringify(result);
    // Whatever the reporting shape, an agent-handoff claim must not come back accepted,
    // and the reason must be an evidence review rather than a silent drop.
    assert.ok(serialised.includes('evidence-review'),
      'expected an evidence-review issue for an agent-handoff claim');
    assert.equal(acceptedCount(result), 0,
      'an agent-handoff claim must not be counted as accepted');
  });

  test('marking a handoff claim verified does not buy it acceptance', async () => {
    const runtimeRoot = root('handoff-verified');
    const result = await reconcileClaimBatch({
      runtimeRoot,
      batch: batch([claim({ verification: 'verified' })]),
      execute: true,
      now: '2026-08-25T09:00:00.000Z'
    });

    // The gate keys on evidence class, so an extractor cannot promote its own output
    // by asserting that it verified itself.
    assert.ok(JSON.stringify(result).includes('evidence-review'));
    assert.equal(acceptedCount(result), 0);
  });

  test('an unverified tool result is also held, so only real evidence promotes', async () => {
    const runtimeRoot = root('tool-unverified');
    const result = await reconcileClaimBatch({
      runtimeRoot,
      batch: batch([claim({
        evidenceClass: 'observed-tool-result',
        verification: 'unverified'
      })]),
      execute: true,
      now: '2026-08-25T09:00:00.000Z'
    });

    assert.ok(JSON.stringify(result).includes('evidence-review'));
    assert.equal(acceptedCount(result), 0);
  });

  test('a verified canonical artifact is the path that does promote', async () => {
    const runtimeRoot = root('canonical');
    const result = await reconcileClaimBatch({
      runtimeRoot,
      batch: batch([claim({
        evidenceClass: 'canonical-artifact',
        verification: 'verified'
      })]),
      execute: true,
      now: '2026-08-25T09:00:00.000Z'
    });

    // The contrast is the point: the same claim body promotes only when it carries
    // evidence the broker can check, which is what keeps the extractor out of the
    // trust path.
    assert.ok(!JSON.stringify(result).includes('evidence-review'));
    // Absence of the review issue is not acceptance. Without this the test would also
    // pass if the claim were silently dropped, which would make the whole contrast
    // meaningless.
    assert.equal(result.state, 'clean');
    assert.equal(acceptedCount(result), 1);
    assert.deepEqual(issueReasons(result), []);
  });
});
