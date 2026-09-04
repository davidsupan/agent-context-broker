import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { planContextQuery, runContextQuery } from '../src/context-query.mjs';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';

const temporaryRoots = [];

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function tempRoot(name) {
  const root = join(tmpdir(), `agent-context-query-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function relation(value = 'project') {
  return `project:${hash(value)}`;
}

async function publishClaim(runtimeRoot, {
  provider = 'codex',
  claimKey = 'review.merge-request-rules',
  value = 'refresh current MR head before review',
  expectedSnapshotHash = null,
  scope = { kind: 'project', key: 'example-project' },
  observedAt = '2026-08-25T09:00:00.000Z',
  sensitivity = 'shared',
  freshness
} = {}) {
  const batch = {
    schemaVersion: 1,
    batchId: `query-${randomUUID()}`,
    expectedSnapshotHash,
    scope,
    relationKeys: [relation(scope.key)],
    claims: [{
      claimKey,
      claimType: 'procedure',
      subject: 'project-agent-workflow',
      predicate: 'requires',
      value,
      observedAt,
      confidence: 1,
      sensitivity,
      evidenceClass: 'canonical-artifact',
      verification: 'verified',
      ...(freshness !== undefined ? { freshness } : {}),
      expectedCurrentClaimId: null,
      canonicalRefs: [`context://agent-context-broker/${claimKey}`],
      provenance: [{
        provider,
        sessionKey: hash(`${provider}-session`),
        recordKey: hash(`${provider}-${claimKey}-record`),
        sourceHash: hash(`${provider}-${claimKey}-source`)
      }]
    }]
  };
  return reconcileClaimBatch({
    runtimeRoot,
    batch,
    execute: true,
    now: observedAt
  });
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('profiled context query', () => {
  test('returns a relevant accepted claim without native provenance identifiers', async () => {
    const root = tempRoot('review');
    const runtimeRoot = join(root, 'runtime');
    await publishClaim(runtimeRoot);

    const result = await planContextQuery({
      provider: 'codex',
      runtimeRoot,
      profileId: 'review',
      terms: ['review'],
      scopeKind: 'project',
      scopeKey: 'example-project',
      now: '2026-08-25T09:01:00.000Z'
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].providers[0], 'codex');
    assert.equal(serialized.includes(hash('codex-session')), false);
    assert.equal(serialized.includes(hash('codex-review.merge-request-rules-record')), false);
  });

  test('lets Claude Code consume an accepted Codex claim', async () => {
    const root = tempRoot('claude-consumes');
    const runtimeRoot = join(root, 'runtime');
    const first = await publishClaim(runtimeRoot);
    await publishClaim(runtimeRoot, {
      claimKey: 'review.private-only',
      value: 'provider-private review note',
      expectedSnapshotHash: first.snapshotHash,
      observedAt: '2026-08-25T09:01:30.000Z',
      sensitivity: 'private'
    });

    const result = await planContextQuery({
      provider: 'claude-code', runtimeRoot, profileId: 'review', terms: ['review'],
      scopeKind: 'project', scopeKey: 'example-project'
    });

    assert.equal(result.claims.length, 1);
    assert.equal(result.claims[0].claimKey, 'review.merge-request-rules');
    assert.deepEqual(result.claims[0].providers, ['codex']);
    assert.match(result.context, /\[codex\]/u);
  });

  test('lets Codex consume a later accepted Claude Code claim', async () => {
    const root = tempRoot('codex-consumes');
    const runtimeRoot = join(root, 'runtime');
    const first = await publishClaim(runtimeRoot);
    await publishClaim(runtimeRoot, {
      provider: 'claude-code',
      claimKey: 'review.pipeline-evidence',
      value: 'use only the current head pipeline',
      expectedSnapshotHash: first.snapshotHash,
      observedAt: '2026-08-25T09:02:00.000Z'
    });

    const result = await planContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'review', terms: ['pipeline'],
      scopeKind: 'project', scopeKey: 'example-project'
    });

    assert.equal(result.claims.length, 1);
    assert.deepEqual(result.claims[0].providers, ['claude-code']);
  });

  test('strict isolation returns before reading an invalid runtime store', async () => {
    const root = tempRoot('isolated');
    const runtimeRoot = join(root, 'runtime');
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(join(runtimeRoot, 'accepted-snapshots.json'), '{broken', 'utf8');

    const auditRoot = join(root, 'audit');
    const result = await runContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'review', strictIsolation: true,
      globalAuditDirectory: auditRoot, execute: true
    });

    assert.equal(result.strictIsolation, true);
    assert.deepEqual(result.claims, []);
    assert.match(result.context, /No cross-task or peer-provider context was read/u);
    assert.equal(existsSync(auditRoot), false);
  });

  test('an unrelated custom task does not read the broker store', async () => {
    const result = await planContextQuery({
      provider: 'codex',
      runtimeRoot: 'Z:\\intentionally-missing',
      projectScope: false
    });

    assert.equal(result.profile, null);
    assert.deepEqual(result.claims, []);
    assert.equal(result.routeReason, 'unscoped-unrouted');
  });

  test('fails closed when accepted claim content is tampered', async () => {
    const root = tempRoot('tampered');
    const runtimeRoot = join(root, 'runtime');
    await publishClaim(runtimeRoot);
    const claimPath = join(runtimeRoot, 'claims', readdirSync(join(runtimeRoot, 'claims'))[0]);
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    claim.subject = 'tampered';
    writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, 'utf8');

    await assert.rejects(
      planContextQuery({
        provider: 'codex', runtimeRoot, profileId: 'review',
        scopeKind: 'project', scopeKey: 'example-project'
      }),
      /Accepted claim verification failed/u
    );
  });

  test('filters accepted claims by explicit query terms', async () => {
    const root = tempRoot('terms');
    const runtimeRoot = join(root, 'runtime');
    const first = await publishClaim(runtimeRoot);
    await publishClaim(runtimeRoot, {
      claimKey: 'build.sonar-workdir',
      value: 'keep Sonar work directories outside source control',
      expectedSnapshotHash: first.snapshotHash,
      observedAt: '2026-08-25T09:03:00.000Z'
    });

    const result = await planContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'build', terms: ['sonar'],
      scopeKind: 'project', scopeKey: 'example-project'
    });

    assert.deepEqual(result.claims.map((claim) => claim.claimKey), ['build.sonar-workdir']);
  });

  test('omits oversized accepted values while preserving their hashes', async () => {
    const root = tempRoot('bounded');
    const runtimeRoot = join(root, 'runtime');
    await publishClaim(runtimeRoot, {
      claimKey: 'implementation.large-contract',
      value: `implementation ${'x'.repeat(5000)}`
    });

    const result = await planContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'implementation', terms: ['implementation'],
      scopeKind: 'project', scopeKey: 'example-project'
    });

    assert.equal(result.claims[0].valueOmitted, true);
    assert.equal('value' in result.claims[0], false);
    assert.match(result.claims[0].valueHash, /^[a-f0-9]{64}$/u);
  });

  test('writes metadata-only global and ticket audit ledgers', async () => {
    const root = tempRoot('audit');
    const runtimeRoot = join(root, 'runtime');
    const auditRoot = join(root, 'audit');
    const ticketRoot = join(root, 'APP-99999');
    const ticketAuditRoot = join(root, 'private-records');
    mkdirSync(ticketRoot, { recursive: true });
    writeFileSync(join(ticketRoot, 'README.md'), '# Test ticket\n', 'utf8');
    const marker = 'private-query-value-marker';
    await publishClaim(runtimeRoot, { value: marker });

    const result = await runContextQuery({
      provider: 'claude-code',
      runtimeRoot,
      profileId: 'review',
      terms: ['review'],
      scopeKind: 'project',
      scopeKey: 'example-project',
      globalAuditDirectory: auditRoot,
      ticketPackageRoot: ticketRoot,
      ticketPackagesRoot: root,
      ticketAuditRoot,
      execute: true,
      now: '2026-08-25T09:04:00.000Z'
    });
    const globalText = readFileSync(join(auditRoot, readdirSync(auditRoot)[0]), 'utf8');
    const ticketText = readFileSync(join(ticketAuditRoot, 'APP-99999', 'CONTEXT_LEDGER.jsonl'), 'utf8');

    assert.equal(result.audit.persisted, true);
    assert.equal(result.audit.ticketLedgerPersisted, true);
    assert.equal(globalText.includes(marker), false);
    assert.equal(ticketText.includes(marker), false);
    assert.equal(existsSync(join(ticketRoot, 'CONTEXT_LEDGER.jsonl')), false);
    assert.match(ticketText, /"issueKey":"APP-99999"/u);
  });

  test('writes metadata-only query audit into a first-class review ledger', async () => {
    const root = tempRoot('review-audit');
    const runtimeRoot = join(root, 'runtime');
    const auditRoot = join(root, 'audit');
    const reviewLedgersRoot = join(root, 'reviews');
    const reviewRoot = join(reviewLedgersRoot, 'mr-8466');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, 'metadata.json'), `${JSON.stringify({
      references: { full: 'acme/widgets!8466' },
      iid: 8466,
      title: 'APP-19979 review',
      source_branch: 'feature/APP-19979-review'
    })}\n`, 'utf8');
    const marker = 'review-finding-must-not-enter-audit';
    writeFileSync(join(reviewRoot, 'REVIEW_SUMMARY.md'), marker, 'utf8');

    const result = await runContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'review', terms: ['review'],
      scopeKind: 'merge-request', scopeKey: 'acme/widgets!8466',
      reviewLedgersRoot, globalAuditDirectory: auditRoot, execute: true,
      now: '2026-09-02T08:00:00.000Z'
    });
    const ledgerText = readFileSync(join(reviewRoot, 'CONTEXT_LEDGER.jsonl'), 'utf8');
    const row = JSON.parse(ledgerText.trim());

    assert.equal(result.audit.persisted, true);
    assert.equal(result.audit.ticketLedgerPersisted, false);
    assert.equal(result.audit.reviewLedgerPersisted, true);
    assert.equal(row.reviewKey, 'acme/widgets!8466');
    assert.equal(ledgerText.includes(marker), false);
  });

  test('writes a metadata-only audit for a standalone thread without a ticket or review package', async () => {
    const root = tempRoot('thread-audit');
    const runtimeRoot = join(root, 'runtime');
    const auditRoot = join(root, 'audit');
    const threadAuditRoot = join(root, 'thread-audit');
    const threadKey = hash('standalone-thread');
    const threadRef = `context://thread/${threadKey}`;
    await publishClaim(runtimeRoot);

    const result = await runContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'custom-project', terms: ['review'],
      scopeKind: 'project', scopeKey: 'example-project',
      globalAuditDirectory: auditRoot, threadAuditRoot, threadRef, execute: true,
      now: '2026-09-03T08:00:00.000Z'
    });
    const ledgerPath = join(threadAuditRoot, threadKey, 'CONTEXT_LEDGER.jsonl');
    const row = JSON.parse(readFileSync(ledgerPath, 'utf8').trim());

    assert.equal(result.audit.persisted, true);
    assert.equal(result.audit.ticketLedgerPersisted, false);
    assert.equal(result.audit.reviewLedgerPersisted, false);
    assert.equal(result.audit.threadLedgerPersisted, true);
    assert.equal(row.threadRefHash, hash(threadRef));
  });

  test('reports a missing accepted registry without creating it', async () => {
    const root = tempRoot('missing');
    const runtimeRoot = join(root, 'runtime');

    const result = await planContextQuery({
      provider: 'codex', runtimeRoot, taskKind: 'bugfix', projectScope: true,
      scopeKind: 'project', scopeKey: 'example-project'
    });

    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.warnings, ['accepted-registry-missing']);
    assert.equal(existsSync(runtimeRoot), false);
  });

  test('excludes an accepted claim after its freshness TTL expires', async () => {
    const root = tempRoot('expired');
    const runtimeRoot = join(root, 'runtime');
    await publishClaim(runtimeRoot, {
      freshness: {
        policy: 'ttl',
        verifiedAt: '2026-08-25T09:00:00.000Z',
        expiresAt: '2026-08-25T09:05:00.000Z',
        sourceHeadHash: hash('jira-head')
      }
    });
    const result = await planContextQuery({
      provider: 'codex', runtimeRoot, profileId: 'review', terms: ['review'],
      scopeKind: 'project', scopeKey: 'example-project',
      now: '2026-08-25T09:06:00.000Z'
    });
    assert.deepEqual(result.claims, []);
    assert.ok(result.warnings.includes('stale-claim-excluded'));
  });
});
