import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  planReconciliation,
  reconcileClaimBatch
} from '../src/reconciliation.mjs';
import { attestSource } from '../src/source-attestation.mjs';
import { verifyEventStore } from '../src/event-store.mjs';

const temporaryRoots = [];
const relation = `workspace:${'a'.repeat(64)}`;
const provenance = [{
  provider: 'codex',
  sessionKey: 'b'.repeat(64),
  recordKey: 'c'.repeat(64),
  sourceHash: 'd'.repeat(64)
}];

function tempRoot(name) {
  const root = join(tmpdir(), `agent-context-reconcile-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function batch(overrides = {}) {
  return {
    schemaVersion: 1,
    batchId: randomUUID(),
    expectedSnapshotHash: null,
    scope: { kind: 'ticket', key: 'APP-FIXTURE' },
    relationKeys: [relation],
    claims: [{
      claimKey: 'ticket.status',
      claimType: 'fact',
      subject: 'ticket',
      predicate: 'status',
      value: 'prepared',
      observedAt: '2026-08-24T11:00:00.000Z',
      confidence: 1,
      sensitivity: 'private',
      evidenceClass: 'canonical-artifact',
      verification: 'verified',
      expectedCurrentClaimId: null,
      canonicalRefs: ['repo://tickets/APP-FIXTURE/HANDOVER.md'],
      provenance: provenance.map((item) => ({ ...item }))
    }],
    ...overrides
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('claim reconciliation', () => {
  test('plan is read-only and execute is explicit', async () => {
    const root = tempRoot('plan');
    const candidate = batch();
    const plan = planReconciliation({ runtimeRoot: root, batch: candidate });

    assert.equal(plan.state, 'clean');
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(join(root, 'state.json')), false);
    await assert.rejects(
      reconcileClaimBatch({ runtimeRoot: root, batch: candidate }),
      /execute: true/u
    );
  });

  test('strict runtime contract blocks missing and unknown fields', async () => {
    const missingValue = batch();
    delete missingValue.claims[0].value;
    const unknownFields = batch({ unexpected: true });
    unknownFields.scope.unexpected = true;
    unknownFields.claims[0].unexpected = true;
    unknownFields.claims[0].provenance[0] = {
      ...unknownFields.claims[0].provenance[0],
      unexpected: true
    };

    const missing = planReconciliation({
      runtimeRoot: tempRoot('missing-fields'),
      batch: missingValue
    });
    const unknownRoot = tempRoot('unknown-fields');
    const unknown = await reconcileClaimBatch({
      runtimeRoot: unknownRoot,
      batch: unknownFields,
      execute: true
    });

    assert.equal(missing.state, 'blocked');
    assert.ok(missing.issues.some((item) => item.code === 'claim-missing-fields'));
    assert.equal(unknown.state, 'blocked');
    assert.deepEqual(
      new Set(unknown.issues.map((item) => item.code)),
      new Set([
        'batch-unknown-fields',
        'scope-unknown-fields',
        'claim-unknown-fields',
        'provenance-unknown-fields'
      ])
    );
    const review = readFileSync(
      join(unknownRoot, 'review', `${unknown.reconciliationId}.json`),
      'utf8'
    );
    assert.equal(review.includes('"unexpected"'), false);
  });

  test('duplicate claim keys and invalid replacement identifiers cannot publish', async () => {
    const duplicateRoot = tempRoot('duplicate-keys');
    const duplicateBatch = batch();
    duplicateBatch.claims.push({
      ...duplicateBatch.claims[0],
      value: 'implemented'
    });
    const duplicate = await reconcileClaimBatch({
      runtimeRoot: duplicateRoot,
      batch: duplicateBatch,
      execute: true
    });
    const malformed = planReconciliation({
      runtimeRoot: tempRoot('malformed-replacement'),
      batch: batch({
        claims: [{ ...batch().claims[0], expectedCurrentClaimId: 'not-a-hash' }]
      })
    });
    const unexpected = planReconciliation({
      runtimeRoot: tempRoot('unexpected-replacement'),
      batch: batch({
        claims: [{ ...batch().claims[0], expectedCurrentClaimId: 'e'.repeat(64) }]
      })
    });

    assert.equal(duplicate.state, 'blocked');
    assert.ok(duplicate.issues.some((item) => item.code === 'duplicate-claim-key'));
    assert.equal(existsSync(join(duplicateRoot, 'claims')), false);
    assert.equal(malformed.state, 'blocked');
    assert.ok(malformed.issues.some((item) => item.code === 'claim-expected-current-id'));
    assert.equal(unexpected.state, 'conflicted');
    assert.ok(unexpected.issues.some((item) => item.code === 'claim-cas-mismatch'));
  });

  test('malformed structures fail closed without breaking review persistence', async () => {
    const malformedClaimRoot = tempRoot('malformed-claim');
    const malformedClaim = await reconcileClaimBatch({
      runtimeRoot: malformedClaimRoot,
      batch: batch({ claims: [null] }),
      execute: true
    });
    const malformedBatchRoot = tempRoot('malformed-batch');
    const malformedBatch = await reconcileClaimBatch({
      runtimeRoot: malformedBatchRoot,
      batch: null,
      execute: true
    });

    assert.equal(malformedClaim.state, 'blocked');
    assert.ok(malformedClaim.issues.some((item) => item.code === 'claim-object'));
    assert.equal(
      existsSync(join(malformedClaimRoot, 'review', `${malformedClaim.reconciliationId}.json`)),
      true
    );
    assert.equal(malformedBatch.state, 'blocked');
    assert.ok(malformedBatch.issues.some((item) => item.code === 'batch-object'));
    assert.equal(
      existsSync(join(malformedBatchRoot, 'review', `${malformedBatch.reconciliationId}.json`)),
      true
    );
  });

  test('email and raw JWT payloads are blocked and suppressed from review artifacts', async () => {
    const unsafeValues = [
      ['email-address', 'owner@example.invalid'],
      ['jwt', [
        'eyJhbGciOiJIUzI1NiJ9',
        'eyJzdWIiOiJzZW5zaXRpdmUifQ',
        'signature123456'
      ].join('.')]
    ];

    for (const [reason, unsafeValue] of unsafeValues) {
      const root = tempRoot(reason);
      const candidate = batch();
      candidate.claims[0].value = reason === 'email-address'
        ? { [unsafeValue]: 'must-not-persist' }
        : { nested: unsafeValue };
      const result = await reconcileClaimBatch({
        runtimeRoot: root,
        batch: candidate,
        execute: true
      });
      const persisted = [
        readFileSync(join(root, 'review', `${result.reconciliationId}.json`), 'utf8'),
        readFileSync(join(root, 'audit', `${result.reconciliationId}.json`), 'utf8')
      ].join('\n');

      assert.equal(result.state, 'blocked');
      assert.ok(result.issues.some((item) => item.code === `unsafe-${reason}`));
      assert.equal(persisted.includes(unsafeValue), false);
    }
  });

  test('publishes versioned claims and accepted registry atomically under CAS', async () => {
    const root = tempRoot('clean');
    const result = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: batch(),
      execute: true,
      now: '2026-08-24T11:01:00.000Z'
    });
    const registry = JSON.parse(readFileSync(join(root, 'accepted-snapshots.json'), 'utf8'));
    const snapshot = JSON.parse(readFileSync(
      join(root, 'snapshots', `${result.snapshotId}.json`),
      'utf8'
    ));

    assert.equal(result.state, 'clean');
    assert.equal(result.snapshotVersion, 1);
    assert.match(result.snapshotHash, /^[a-f0-9]{64}$/u);
    assert.equal(snapshot.baseSnapshotHash, null);
    assert.equal(registry.snapshots[0].snapshotHash, result.snapshotHash);
    assert.equal(registry.snapshots[0].state, 'clean');
  });

  test('duplicate batches and values are idempotent', async () => {
    const root = tempRoot('duplicate');
    const candidate = batch();
    const first = await reconcileClaimBatch({ runtimeRoot: root, batch: candidate, execute: true });
    const replay = await reconcileClaimBatch({ runtimeRoot: root, batch: candidate, execute: true });
    const duplicateValue = batch({
      expectedSnapshotHash: first.snapshotHash,
      claims: candidate.claims
    });
    const duplicateResult = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: duplicateValue,
      execute: true
    });

    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.snapshotHash, first.snapshotHash);
    assert.equal(duplicateResult.state, 'clean');
    assert.equal(duplicateResult.acceptedClaimCount, 0);
    assert.equal(duplicateResult.duplicateClaimCount, 1);
    assert.equal(duplicateResult.snapshotHash, first.snapshotHash);
    assert.equal(duplicateResult.snapshotVersion, first.snapshotVersion);
  });

  test('stale snapshot and claim replacement without expected id enter review', async () => {
    const root = tempRoot('conflict');
    const first = await reconcileClaimBatch({ runtimeRoot: root, batch: batch(), execute: true });
    const stale = batch({
      expectedSnapshotHash: null,
      claims: [{ ...batch().claims[0], value: 'implemented' }]
    });
    const result = await reconcileClaimBatch({ runtimeRoot: root, batch: stale, execute: true });

    assert.equal(result.state, 'conflicted');
    assert.ok(result.issues.some((item) => item.code === 'snapshot-cas-mismatch'));
    assert.ok(result.issues.some((item) => item.code === 'claim-cas-mismatch'));
    assert.equal(result.snapshotHash, first.snapshotHash);
    assert.equal(existsSync(join(root, 'review', `${result.reconciliationId}.json`)), true);
  });

  test('verified replacement supersedes the current claim in the next snapshot', async () => {
    const root = tempRoot('replace');
    const originalBatch = batch();
    const first = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: originalBatch,
      execute: true
    });
    const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
    const currentClaimId = Object.values(state.scopes)[0].claimIndex['ticket.status'].claimId;
    const replacementClaim = {
      ...originalBatch.claims[0],
      value: 'implemented',
      expectedCurrentClaimId: currentClaimId,
      canonicalRefs: ['context://agent-context-broker/ticket/APP-FIXTURE/change-history']
    };
    const replacement = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: batch({
        expectedSnapshotHash: first.snapshotHash,
        claims: [replacementClaim]
      }),
      execute: true
    });
    const snapshot = JSON.parse(readFileSync(
      join(root, 'snapshots', `${replacement.snapshotId}.json`),
      'utf8'
    ));
    const acceptedClaim = JSON.parse(readFileSync(
      join(root, 'claims', `${snapshot.claimIds[0]}.json`),
      'utf8'
    ));

    assert.equal(replacement.state, 'clean');
    assert.equal(replacement.snapshotVersion, 2);
    assert.equal(snapshot.baseSnapshotHash, first.snapshotHash);
    assert.equal(snapshot.claimIds.length, 1);
    assert.notEqual(snapshot.claimIds[0], currentClaimId);
    assert.equal(acceptedClaim.supersedes, currentClaimId);
    assert.equal(acceptedClaim.status, 'accepted');
  });

  test('unverified handoff remains pending and unsafe payload is suppressed', async () => {
    const pendingRoot = tempRoot('pending');
    const pendingCandidate = batch();
    pendingCandidate.claims[0].evidenceClass = 'agent-handoff';
    pendingCandidate.claims[0].verification = 'unverified';
    const pending = await reconcileClaimBatch({
      runtimeRoot: pendingRoot,
      batch: pendingCandidate,
      execute: true
    });
    assert.equal(pending.state, 'pending');

    const blockedRoot = tempRoot('blocked');
    const blockedCandidate = batch();
    blockedCandidate.claims[0].value = 'AppToken=do-not-persist';
    const blocked = await reconcileClaimBatch({
      runtimeRoot: blockedRoot,
      batch: blockedCandidate,
      execute: true
    });
    const review = readFileSync(
      join(blockedRoot, 'review', `${blocked.reconciliationId}.json`),
      'utf8'
    );
    const audit = readFileSync(
      join(blockedRoot, 'audit', `${blocked.reconciliationId}.json`),
      'utf8'
    );
    assert.equal(blocked.state, 'blocked');
    assert.equal(review.includes('do-not-persist'), false);
    assert.equal(audit.includes('do-not-persist'), false);
  });

  test('parallel CAS allows one publication and queues the stale contender', async () => {
    const root = tempRoot('parallel');
    const [left, right] = await Promise.all([
      reconcileClaimBatch({ runtimeRoot: root, batch: batch(), execute: true }),
      reconcileClaimBatch({ runtimeRoot: root, batch: batch(), execute: true })
    ]);
    const states = [left.state, right.state].sort();
    assert.deepEqual(states, ['clean', 'conflicted']);
  });

  test('next invocation repairs a registry interrupted after state publication', async () => {
    const root = tempRoot('repair');
    const candidate = batch();
    await assert.rejects(
      reconcileClaimBatch({
        runtimeRoot: root,
        batch: candidate,
        execute: true,
        testFailPoint: 'after-state'
      }),
      /Injected failure/u
    );
    const interruptedRegistry = JSON.parse(readFileSync(
      join(root, 'accepted-snapshots.json'),
      'utf8'
    ));
    assert.equal(interruptedRegistry.snapshots.length, 0);

    const replay = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: candidate,
      execute: true
    });
    assert.equal(replay.idempotentReplay, true);
    const repairedRegistry = JSON.parse(readFileSync(
      join(root, 'accepted-snapshots.json'),
      'utf8'
    ));
    assert.equal(repairedRegistry.snapshots.length, 1);
    assert.equal(repairedRegistry.snapshots[0].snapshotHash, replay.snapshotHash);
    const events = verifyEventStore({ runtimeRoot: root }).events;
    assert.deepEqual(events.map((event) => event.eventType), [
      'claim.accepted',
      'snapshot.published'
    ]);
  });

  test('outbox publishes only committed state and replays idempotently', async () => {
    const root = tempRoot('outbox');
    const candidate = batch();
    await assert.rejects(
      reconcileClaimBatch({
        runtimeRoot: root,
        batch: candidate,
        execute: true,
        testFailPoint: 'after-state'
      }),
      /Injected failure/u
    );
    assert.equal(existsSync(join(root, 'events')), false);

    const replay = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: candidate,
      execute: true
    });
    const firstEvents = verifyEventStore({ runtimeRoot: root }).events;
    assert.equal(replay.idempotentReplay, true);
    assert.equal(firstEvents.length, 2);

    await reconcileClaimBatch({ runtimeRoot: root, batch: candidate, execute: true });
    assert.equal(verifyEventStore({ runtimeRoot: root }).events.length, 2);
  });

  test('required source attestation fails closed until provenance is attested', async () => {
    const root = tempRoot('attestation-required');
    const attestationRoot = tempRoot('attestation-events');
    const candidate = batch();
    const missing = planReconciliation({
      runtimeRoot: root,
      batch: candidate,
      requireSourceAttestation: true,
      attestationRuntimeRoot: attestationRoot
    });
    assert.equal(missing.state, 'blocked');
    assert.ok(missing.issues.some((item) => item.code === 'source-attestation-missing'));

    const item = candidate.claims[0].provenance[0];
    await attestSource({
      runtimeRoot: attestationRoot,
      execute: true,
      attestation: {
        schemaVersion: 1,
        ...item,
        inventoryHash: 'e'.repeat(64),
        observedAt: candidate.claims[0].observedAt,
        scope: { kind: 'ticket', keyHash: 'f'.repeat(64) },
        sensitivity: 'private'
      }
    });
    const accepted = await reconcileClaimBatch({
      runtimeRoot: root,
      batch: candidate,
      requireSourceAttestation: true,
      attestationRuntimeRoot: attestationRoot,
      execute: true
    });
    assert.equal(accepted.state, 'clean');
  });
});
