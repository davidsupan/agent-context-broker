import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planContextRefresh, runContextRefresh } from '../src/context-refresh.mjs';
import * as codex from '../src/codex-inventory-v2.mjs';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(packageRoot, 'fixtures');
const temporaryRoots = [];

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function tempRoot(name) {
  const root = join(tmpdir(), `agent-context-refresh-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function fixture(root) {
  const path = join(root, 'current.jsonl');
  copyFileSync(join(fixtures, 'codex-active.jsonl'), path);
  return path;
}

function claudeFixture(root) {
  const path = join(root, 'claude-current.jsonl');
  copyFileSync(join(fixtures, 'claude-active.jsonl'), path);
  return path;
}

async function publishAcceptedContext(runtimeRoot, source, value = 'refresh-ready') {
  const identity = await codex.readSourceIdentity(source);
  const batch = {
    schemaVersion: 1,
    batchId: `refresh-${randomUUID()}`,
    expectedSnapshotHash: null,
    scope: { kind: 'workstream', key: 'agent-context-broker' },
    relationKeys: identity.relationKeys,
    claims: [{
      claimKey: 'broker.manual-refresh',
      claimType: 'decision',
      subject: 'agent-context-broker',
      predicate: 'supports-manual-refresh',
      value,
      observedAt: '2026-08-25T07:30:00.000Z',
      confidence: 1,
      sensitivity: 'private',
      evidenceClass: 'canonical-artifact',
      verification: 'verified',
      expectedCurrentClaimId: null,
      canonicalRefs: ['context://agent-context-broker/manual-refresh'],
      provenance: [{
        provider: 'codex',
        sessionKey: hash('refresh-session'),
        recordKey: hash('refresh-record'),
        sourceHash: hash('refresh-source')
      }]
    }]
  };
  await reconcileClaimBatch({
    runtimeRoot,
    batch,
    execute: true,
    now: '2026-08-25T07:31:00.000Z'
  });
  return identity;
}

function writeLedger(ledgerDir, identity) {
  mkdirSync(ledgerDir, { recursive: true });
  const base = {
    schemaVersion: 1,
    provider: 'codex',
    observedAt: '2026-08-25T07:32:00.000Z',
    expiresAt: null,
    classification: 'candidate',
    threadState: 'completed',
    previousThreadState: 'active',
    relationKeys: identity.relationKeys,
    appendedBytes: 128,
    recordCountDelta: { event_msg: 1 },
    coverage: 'incremental'
  };
  const deltas = [
    {
      ...base,
      deltaId: hash('self-delta'),
      sequence: 1,
      runId: 'self-run',
      sourceId: identity.sourceId
    },
    {
      ...base,
      deltaId: hash('peer-delta'),
      sequence: 2,
      runId: 'peer-run',
      sourceId: hash('peer-source')
    }
  ];
  writeFileSync(
    join(ledgerDir, 'fixture.deltas.jsonl'),
    `${deltas.map((delta) => JSON.stringify(delta)).join('\n')}\n`,
    'utf8'
  );
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('manual context refresh', () => {
  test('returns verified accepted claims and metadata-only peer deltas', async () => {
    const root = tempRoot('clean');
    const source = fixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');
    const identity = await publishAcceptedContext(runtimeRoot, source);
    writeLedger(ledgerDir, identity);

    const result = await planContextRefresh({
      provider: 'codex',
      source,
      ledgerDir,
      runtimeRoot,
      now: '2026-08-25T07:33:00.000Z'
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.acceptedSnapshots.length, 1);
    assert.equal(result.acceptedSnapshots[0].claims[0].value, 'refresh-ready');
    assert.equal(result.relatedDeltas.length, 1);
    assert.equal(result.relatedDeltas[0].sourceId, hash('peer-source'));
    assert.match(result.context, /broker\.manual-refresh: "refresh-ready"/u);
    assert.equal(result.audit.persisted, false);
    assert.equal(serialized.includes(source), false);
    assert.equal(serialized.includes('self-run'), false);
  });

  test('audited execution persists counts and digests without context values', async () => {
    const root = tempRoot('audit');
    const source = fixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');
    const auditDir = join(root, 'audit');
    const sensitiveAcceptedValue = 'accepted-private-value-marker';
    const identity = await publishAcceptedContext(runtimeRoot, source, sensitiveAcceptedValue);
    writeLedger(ledgerDir, identity);

    const result = await runContextRefresh({
      provider: 'codex',
      source,
      ledgerDir,
      runtimeRoot,
      auditDir,
      execute: true,
      now: '2026-08-25T07:34:00.000Z'
    });
    const auditFiles = readdirSync(auditDir);
    const auditText = readFileSync(join(auditDir, auditFiles[0]), 'utf8');

    assert.equal(result.audit.persisted, true);
    assert.equal(auditFiles.length, 1);
    assert.equal(auditText.includes(sensitiveAcceptedValue), false);
    assert.equal(auditText.includes(source), false);
    assert.match(auditText, /"acceptedClaimCount": 1/u);
  });

  test('fails closed when an accepted claim value no longer matches its hash', async () => {
    const root = tempRoot('tamper');
    const source = fixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');
    await publishAcceptedContext(runtimeRoot, source);
    const claimPath = join(
      runtimeRoot,
      'claims',
      readdirSync(join(runtimeRoot, 'claims'))[0]
    );
    const claim = JSON.parse(readFileSync(claimPath, 'utf8'));
    claim.value = 'tampered';
    writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`, 'utf8');

    await assert.rejects(
      planContextRefresh({ provider: 'codex', source, ledgerDir, runtimeRoot }),
      /Accepted claim verification failed/u
    );
  });

  test('reports an absent registry without creating runtime or audit files', async () => {
    const root = tempRoot('missing');
    const source = fixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');

    const result = await planContextRefresh({
      provider: 'codex',
      source,
      ledgerDir,
      runtimeRoot,
      now: '2026-08-25T07:35:00.000Z'
    });

    assert.deepEqual(result.acceptedSnapshots, []);
    assert.deepEqual(result.relatedDeltas, []);
    assert.deepEqual(result.warnings, ['accepted-registry-missing']);
    assert.match(result.context, /No related accepted snapshot/u);
    assert.equal(existsSync(runtimeRoot), false);
  });

  test('omits oversized accepted values from the reinjected packet', async () => {
    const root = tempRoot('bounded');
    const source = fixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');
    await publishAcceptedContext(runtimeRoot, source, 'x'.repeat(200));

    const result = await planContextRefresh({
      provider: 'codex',
      source,
      ledgerDir,
      runtimeRoot,
      maxValueBytes: 32
    });

    assert.equal(result.acceptedSnapshots[0].claims[0].valueOmitted, true);
    assert.equal('value' in result.acceptedSnapshots[0].claims[0], false);
    assert.ok(result.warnings.includes('accepted-claim-value-omitted'));
    assert.match(result.context, /value omitted by size limit/u);
  });

  test('uses the same read-only refresh contract for Claude Code sources', async () => {
    const root = tempRoot('claude');
    const source = claudeFixture(root);
    const runtimeRoot = join(root, 'reconciliation');
    const ledgerDir = join(root, 'ledger');

    const result = await planContextRefresh({
      provider: 'claude-code',
      source,
      ledgerDir,
      runtimeRoot,
      now: '2026-08-25T07:36:00.000Z'
    });
    const serialized = JSON.stringify(result);

    assert.equal(result.provider, 'claude-code');
    assert.match(result.sessionKey, /^[a-f0-9]{64}$/u);
    assert.ok(result.warnings.includes('accepted-registry-missing'));
    assert.equal(serialized.includes(source), false);
  });
});
