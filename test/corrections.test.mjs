import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  decideCorrection,
  planCorrectionDecision,
  planCorrectionProposal,
  proposeCorrection
} from '../src/corrections.mjs';
import { sha256, verifyEventStore } from '../src/event-store.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-correction-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function ref(kind, value) {
  return `acb://${kind}/${sha256(value)}`;
}

function proposal(overrides = {}) {
  return {
    schemaVersion: 1,
    proposalKey: sha256(randomUUID()),
    targetRef: ref('doc', 'guidance-a'),
    targetRevisionHash: sha256('old-revision'),
    correctionKind: 'guidance',
    disposition: 'replace',
    replacementHash: sha256('new-revision'),
    evidenceRefs: [ref('evidence', 'canonical-a')],
    confidence: 1,
    scope: { kind: 'project', keyHash: sha256('example-project') },
    requestedBy: 'codex',
    approvalClass: 'explicit',
    sensitivity: 'shared',
    occurredAt: '2026-08-25T10:00:00.000Z',
    ...overrides
  };
}

function decision(created, proposed, overrides = {}) {
  return {
    schemaVersion: 1,
    correctionRef: created.correctionRef,
    expectedProposalEventId: created.proposalEventId,
    decision: 'accept',
    observedRevisionHash: proposed.replacementHash,
    evidenceRefs: [ref('evidence', 'readback-a')],
    decidedBy: 'claude-code',
    occurredAt: '2026-08-25T10:05:00.000Z',
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('evidence-bearing correction lifecycle', () => {
  test('proposal plan is read-only', () => {
    const runtimeRoot = root('plan');
    const plan = planCorrectionProposal({ proposal: proposal() });
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(join(runtimeRoot, 'events')), false);
  });

  test('accepted correction requires proposal and observed replacement hashes', async () => {
    const runtimeRoot = root('accept');
    const proposed = proposal();
    const created = await proposeCorrection({ runtimeRoot, proposal: proposed, execute: true });
    const accepted = await decideCorrection({
      runtimeRoot,
      decision: decision(created, proposed),
      execute: true
    });
    const events = verifyEventStore({ runtimeRoot }).events;
    assert.equal(accepted.writesEnabled, true);
    assert.deepEqual(events.map((event) => event.eventType), [
      'correction.proposed',
      'correction.accepted'
    ]);
  });

  test('stale proposal or wrong observed hash cannot create a decision', async () => {
    const runtimeRoot = root('cas');
    const proposed = proposal();
    const created = await proposeCorrection({ runtimeRoot, proposal: proposed, execute: true });
    assert.throws(() => planCorrectionDecision({
      runtimeRoot,
      decision: decision(created, proposed, {
        expectedProposalEventId: sha256('stale-event')
      })
    }), /proposal CAS mismatch/u);
    await assert.rejects(
      decideCorrection({
        runtimeRoot,
        decision: decision(created, proposed, {
          observedRevisionHash: sha256('unexpected-revision')
        }),
        execute: true
      }),
      /target revision CAS mismatch/u
    );
    assert.equal(verifyEventStore({ runtimeRoot }).events.length, 1);
  });

  test('a rejected correction proves the target stayed at its original hash', async () => {
    const runtimeRoot = root('reject');
    const proposed = proposal();
    const created = await proposeCorrection({ runtimeRoot, proposal: proposed, execute: true });
    const rejected = await decideCorrection({
      runtimeRoot,
      decision: decision(created, proposed, {
        decision: 'reject',
        observedRevisionHash: proposed.targetRevisionHash
      }),
      execute: true
    });
    assert.equal(rejected.decision, 'reject');
    assert.equal(verifyEventStore({ runtimeRoot }).events.at(-1).eventType, 'correction.rejected');
  });
});
