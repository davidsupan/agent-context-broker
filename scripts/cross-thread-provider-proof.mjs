#!/usr/bin/env bun

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planContextQuery, runContextQuery } from '../src/context-query.mjs';
import { publishContext } from '../src/context-publish.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const scope = { kind: 'project', key: 'example-project' };
const root = mkdtempSync(join(tmpdir(), 'agent-context-cross-thread-'));
const runtimeRoot = join(root, 'runtime');

async function publish({ provider, thread, claimKey, value, sensitivity = 'shared' }) {
  const attestation = {
    schemaVersion: 1,
    provider,
    sessionKey: hash(`${provider}:${thread}`),
    recordKey: hash(`${provider}:${thread}:${claimKey}:record`),
    sourceHash: hash(`${provider}:${thread}:${claimKey}:source`),
    inventoryHash: hash(`${provider}:${thread}:${claimKey}:inventory`),
    observedAt: '2026-08-25T10:00:00.000Z',
    scope: { kind: 'project', keyHash: hash(scope.key) },
    sensitivity: 'private'
  };
  await attestSource({ runtimeRoot, attestation, execute: true });
  return publishContext({
    provider,
    runtimeRoot,
    eventRuntimeRoot: runtimeRoot,
    execute: true,
    now: '2026-08-25T10:00:00.000Z',
    proposal: {
      schemaVersion: 1,
      proposalId: `proof-${provider}-${claimKey}`,
      sourceToken: planSourceAttestation({ attestation }).subjectRef,
      scope,
      claims: [{
        claimKey,
        claimType: 'procedure',
        subject: 'agent-context-cross-thread-proof',
        predicate: 'shares-reconciled-context',
        value,
        observedAt: '2026-08-25T10:00:00.000Z',
        confidence: 1,
        sensitivity,
        evidenceClass: 'canonical-artifact',
        verification: 'verified',
        canonicalRefs: [`context://agent-context-broker/proof/${claimKey}`],
      }]
    }
  });
}

async function query({ provider, profileId, term }) {
  return planContextQuery({
    provider,
    runtimeRoot,
    profileId,
    terms: [term],
    scopeKind: scope.kind,
    scopeKey: scope.key,
    now: '2026-08-25T10:05:00.000Z'
  });
}

function positiveRow({ id, producerProvider, producerThread, consumerProvider, consumerThread, claimKey, result }) {
  assert.equal(result.claims.length, 1, `${id} must expose exactly one matching accepted claim.`);
  assert.equal(result.claims[0].claimKey, claimKey, `${id} returned the wrong claim.`);
  return {
    id,
    expected: 'visible',
    result: 'passed',
    producerProvider,
    producerThreadKey: hash(`${producerProvider}:${producerThread}`),
    consumerProvider,
    consumerThreadKey: hash(`${consumerProvider}:${consumerThread}`),
    claimKeyHash: hash(claimKey),
    returnedProviders: result.claims[0].providers,
    snapshotHash: result.claims[0].snapshot.snapshotHash
  };
}

try {
  const codexClaim = 'review.codex-thread-a';
  const claudeClaim = 'build.claude-thread-a';
  const privateClaim = 'review.codex-private-thread-a';
  await publish({
    provider: 'codex',
    thread: 'thread-a',
    claimKey: codexClaim,
    value: 'refresh the exact merge request head before review',
  });
  await publish({
    provider: 'claude-code',
    thread: 'thread-a',
    claimKey: claudeClaim,
    value: 'use the current head pipeline for build evidence',
  });
  await publish({
    provider: 'codex',
    thread: 'thread-a',
    claimKey: privateClaim,
    value: 'provider-private note',
    sensitivity: 'private',
  });

  const rows = [];
  rows.push(positiveRow({
    id: 'codex-thread-a-to-codex-thread-b',
    producerProvider: 'codex', producerThread: 'thread-a',
    consumerProvider: 'codex', consumerThread: 'thread-b', claimKey: codexClaim,
    result: await query({ provider: 'codex', profileId: 'review', term: codexClaim })
  }));
  rows.push(positiveRow({
    id: 'claude-thread-a-to-claude-thread-b',
    producerProvider: 'claude-code', producerThread: 'thread-a',
    consumerProvider: 'claude-code', consumerThread: 'thread-b', claimKey: claudeClaim,
    result: await query({ provider: 'claude-code', profileId: 'build', term: claudeClaim })
  }));
  rows.push(positiveRow({
    id: 'codex-thread-a-to-claude-thread-b',
    producerProvider: 'codex', producerThread: 'thread-a',
    consumerProvider: 'claude-code', consumerThread: 'thread-b', claimKey: codexClaim,
    result: await query({ provider: 'claude-code', profileId: 'review', term: codexClaim })
  }));
  rows.push(positiveRow({
    id: 'claude-thread-a-to-codex-thread-b',
    producerProvider: 'claude-code', producerThread: 'thread-a',
    consumerProvider: 'codex', consumerThread: 'thread-b', claimKey: claudeClaim,
    result: await query({ provider: 'codex', profileId: 'build', term: claudeClaim })
  }));

  const privateCrossProvider = await query({
    provider: 'claude-code', profileId: 'review', term: privateClaim
  });
  assert.equal(privateCrossProvider.claims.length, 0, 'Private claim crossed the provider boundary.');
  rows.push({
    id: 'private-codex-claim-to-claude-suppressed',
    expected: 'suppressed',
    result: 'passed',
    producerProvider: 'codex',
    producerThreadKey: hash('codex:thread-a'),
    consumerProvider: 'claude-code',
    consumerThreadKey: hash('claude-code:thread-b'),
    claimKeyHash: hash(privateClaim),
    returnedClaimCount: 0
  });

  const invalidRuntime = join(root, 'invalid-runtime');
  mkdirSync(invalidRuntime, { recursive: true });
  writeFileSync(join(invalidRuntime, 'accepted-snapshots.json'), '{broken', 'utf8');
  for (const provider of ['codex', 'claude-code']) {
    const auditRoot = join(root, `strict-${provider}-audit`);
    const isolated = await runContextQuery({
      provider,
      runtimeRoot: invalidRuntime,
      profileId: 'review',
      strictIsolation: true,
      globalAuditDirectory: auditRoot,
      execute: true
    });
    assert.equal(isolated.claims.length, 0);
    assert.equal(isolated.audit.persisted, false);
    rows.push({
      id: `strict-isolation-${provider}`,
      expected: 'no-read-no-write',
      result: 'passed',
      consumerProvider: provider,
      consumerThreadKey: hash(`${provider}:isolated-thread`),
      returnedClaimCount: 0,
      auditPersisted: false
    });
  }

  const serialized = JSON.stringify(rows);
  for (const forbidden of [
    'refresh the exact merge request head before review',
    'use the current head pipeline for build evidence',
    'provider-private note',
    root
  ]) {
    assert.equal(serialized.includes(forbidden), false, 'Proof evidence leaked a raw value or path.');
  }

  console.log(JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    result: 'passed',
    matrixCases: rows.length,
    passed: rows.filter((row) => row.result === 'passed').length,
    rows,
    privacy: {
      rawPromptCount: 0,
      rawResponseCount: 0,
      rawClaimValueCount: 0,
      nativeThreadIdentifierCount: 0,
      nativePathCount: 0
    }
  }, null, 2));
} finally {
  rmSync(root, { recursive: true, force: true });
}
