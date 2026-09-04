import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { planContextQuery } from '../src/context-query.mjs';
import { planContextPublication, publishContext } from '../src/context-publish.mjs';
import { sha256 } from '../src/event-store.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-context-publish-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

async function source(eventRuntimeRoot, provider = 'codex') {
  const attestation = {
    schemaVersion: 1,
    provider,
    sessionKey: sha256(`${provider}:session`),
    recordKey: sha256(`${provider}:record`),
    sourceHash: sha256(`${provider}:source`),
    inventoryHash: sha256(`${provider}:inventory`),
    observedAt: '2026-08-25T10:00:00.000Z',
    scope: { kind: 'project', keyHash: sha256('example-project') },
    sensitivity: 'private'
  };
  await attestSource({ runtimeRoot: eventRuntimeRoot, attestation, execute: true });
  return planSourceAttestation({ attestation }).subjectRef;
}

function proposal(sourceToken, value = 'refresh exact head') {
  return {
    schemaVersion: 1,
    proposalId: 'review-guidance',
    sourceToken,
    scope: { kind: 'project', key: 'example-project' },
    claims: [{
      claimKey: 'review.refresh-head',
      claimType: 'procedure',
      subject: 'merge-request-review',
      predicate: 'requires',
      value,
      observedAt: '2026-08-25T10:00:00.000Z',
      confidence: 1,
      sensitivity: 'shared',
      evidenceClass: 'canonical-artifact',
      verification: 'verified',
      canonicalRefs: ['repo://integrations/agent-context/SKILL.md']
    }]
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('context publication', () => {
  test('plans and publishes from an attested task token for the peer provider', async () => {
    const runtimeRoot = root('runtime');
    const eventRuntimeRoot = root('events');
    const sourceToken = await source(eventRuntimeRoot);
    const input = {
      provider: 'codex', runtimeRoot, eventRuntimeRoot,
      proposal: proposal(sourceToken), now: '2026-08-25T10:01:00.000Z'
    };
    const plan = planContextPublication(input);
    assert.equal(plan.state, 'clean');
    assert.equal(plan.writesEnabled, false);

    const published = await publishContext({ ...input, execute: true });
    assert.equal(published.state, 'clean');
    assert.equal(published.acceptedClaimCount, 1);
    const queried = await planContextQuery({
      provider: 'claude-code', runtimeRoot, profileId: 'review',
      scopeKind: 'project', scopeKey: 'example-project',
      terms: ['review.refresh-head'], now: '2026-08-25T10:02:00.000Z'
    });
    assert.equal(queried.claims.length, 1);
    assert.deepEqual(queried.claims[0].providers, ['codex']);
  });

  test('derives update CAS and treats an identical proposal as idempotent', async () => {
    const runtimeRoot = root('update-runtime');
    const eventRuntimeRoot = root('update-events');
    const sourceToken = await source(eventRuntimeRoot);
    const firstInput = {
      provider: 'codex', runtimeRoot, eventRuntimeRoot,
      proposal: proposal(sourceToken), now: '2026-08-25T10:01:00.000Z', execute: true
    };
    const first = await publishContext(firstInput);
    const replay = await publishContext(firstInput);
    assert.equal(replay.idempotentReplay, true);
    const updated = await publishContext({
      ...firstInput,
      proposal: proposal(sourceToken, 'refresh exact head and target'),
      now: '2026-08-25T10:03:00.000Z'
    });
    assert.equal(updated.state, 'clean');
    assert.equal(updated.snapshotVersion, first.snapshotVersion + 1);
  });

  test('makes review-scoped accepted context available to its ledger-linked ticket', async () => {
    const runtimeRoot = root('review-runtime');
    const eventRuntimeRoot = root('review-events');
    const reviewLedgersRoot = root('review-ledgers');
    const reviewRoot = join(reviewLedgersRoot, 'mr-8466');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, 'metadata.json'), `${JSON.stringify({
      references: { full: 'acme/widgets!8466' },
      iid: 8466,
      title: 'APP-19979 contract review'
    })}\n`, 'utf8');
    const sourceToken = await source(eventRuntimeRoot);
    const reviewProposal = proposal(sourceToken, 'preserve the existing enum wire contract');
    reviewProposal.scope = { kind: 'merge-request', key: 'acme/widgets!8466' };

    const published = await publishContext({
      provider: 'codex', runtimeRoot, eventRuntimeRoot, reviewLedgersRoot,
      proposal: reviewProposal, now: '2026-09-02T08:00:00.000Z', execute: true
    });
    assert.equal(published.state, 'clean');
    const queried = await planContextQuery({
      provider: 'claude-code', runtimeRoot, profileId: 'review',
      scopeKind: 'ticket', scopeKey: 'APP-19979',
      terms: ['review.refresh-head'], now: '2026-09-02T08:01:00.000Z'
    });
    assert.equal(queried.claims.length, 1);
    assert.deepEqual(queried.claims[0].snapshot.scope, {
      kind: 'merge-request',
      key: 'acme/widgets!8466'
    });
  });

  test('rejects an unattested token and a provider mismatch', async () => {
    const runtimeRoot = root('reject-runtime');
    const eventRuntimeRoot = root('reject-events');
    assert.throws(() => planContextPublication({
      provider: 'codex', runtimeRoot, eventRuntimeRoot,
      proposal: proposal(`acb://source/${sha256('missing')}`)
    }), /not attested/u);
    const sourceToken = await source(eventRuntimeRoot, 'claude-code');
    assert.throws(() => planContextPublication({
      provider: 'codex', runtimeRoot, eventRuntimeRoot,
      proposal: proposal(sourceToken)
    }), /does not match/u);
  });
});
