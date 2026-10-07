import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { exportClaims } from '../src/claims-export.mts';
import { planClaimWithdrawal, withdrawClaims } from '../src/claims-withdraw.mts';
import { runWithdrawCommand } from '../src/claims-withdraw-cli.mts';
import { planContextQuery } from '../src/context-query.mjs';
import { verifyEventStore } from '../src/event-store.mjs';
import { reconcileClaimBatch, reinstateClaim, stableJson } from '../src/reconciliation.mjs';

const roots = [];
const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function home() {
  const root = join(tmpdir(), `claims-withdraw-${randomUUID()}`);
  roots.push(root);
  const runtime = join(root, 'runtime', 'reconciliation');
  const events = join(root, 'runtime', 'events');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(events, { recursive: true });
  return { root, runtime, events, audit: join(root, 'runtime', 'query-audit') };
}

const scope = { kind: 'project', key: 'example-project' };
async function accept(h, { claimKey, value, observedAt, expectedCurrentClaimId = null, expectedSnapshotHash = null, selectedScope = scope,
  batchId = `w-${randomUUID()}`, testFailPoint }) {
  return reconcileClaimBatch({
    runtimeRoot: h.runtime, eventRuntimeRoot: h.events, execute: true, now: observedAt, testFailPoint,
    batch: {
      schemaVersion: 1, batchId, expectedSnapshotHash, scope: selectedScope,
      relationKeys: [`project:${hash(selectedScope.key.toLowerCase())}`],
      claims: [{
        claimKey, claimType: 'decision', subject: 'portal', predicate: 'decides', value, observedAt, confidence: 1, sensitivity: 'shared',
        evidenceClass: 'canonical-artifact', verification: 'verified', expectedCurrentClaimId,
        canonicalRefs: [`context://agent-context-broker/${claimKey}`],
        provenance: [{ provider: 'claude-code', sessionKey: hash('s'), recordKey: hash(`${claimKey}-${value}`), sourceHash: hash(`${claimKey}-${value}-src`) }],
      }],
    },
  });
}
const current = (h) => exportClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, provider: 'claude-code', scopes: [scope] }).records;

describe('claims-withdraw', () => {
  test('a withdrawn claim and its earlier versions are gone from every reader and from disk', async () => {
    const h = home();
    const first = await accept(h, { claimKey: 'rule.consult', value: 'a consult is mandatory before every push', observedAt: '2026-10-01T09:00:00.000Z' });
    const v1 = current(h)[0].claimId;
    const second = await accept(h, { claimKey: 'rule.consult', value: 'a consult is mandatory before planning', observedAt: '2026-10-02T09:00:00.000Z', expectedCurrentClaimId: v1, expectedSnapshotHash: first.snapshotHash });
    await accept(h, { claimKey: 'rule.keep', value: 'keep this one around', observedAt: '2026-10-03T09:00:00.000Z', expectedSnapshotHash: second.snapshotHash });
    const v2 = current(h).find(r => r.claimKey === 'rule.consult').claimId;
    // An audit artifact that rendered the value, as a context query writes one.
    mkdirSync(h.audit, { recursive: true });
    writeFileSync(join(h.audit, 'injection-1.json'), JSON.stringify({ payload: '- portal decides: a consult is mandatory before planning' }));
    writeFileSync(join(h.audit, 'injection-old.json'), JSON.stringify({ payload: '- portal decides: a consult is mandatory before every push' }));
    writeFileSync(join(h.audit, 'injection-2.json'), JSON.stringify({ payload: '- portal decides: keep this one around' }));
    const rejected = await accept(h, { claimKey: 'rule.consult', value: 'a separate rejected candidate wording',
      observedAt: '2026-10-03T10:00:00.000Z', expectedSnapshotHash: second.snapshotHash });
    assert.equal(rejected.state, 'conflicted');

    const plan = planClaimWithdrawal({ runtimeRoot: h.runtime, claimIds: [v2], reason: 'rule removed', auditRoots: [h.audit] });
    assert.equal(plan.writesEnabled, false);
    assert.deepEqual(plan.claims[0].versions, [v2, v1]);
    assert.deepEqual(plan.deletes, { claimFiles: 2, reviewCandidates: 1, auditArtifacts: 2 });
    assert.ok(existsSync(join(h.runtime, 'claims', `${v2}.json`)), 'planning writes nothing');

    const done = await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [v2], reason: 'rule removed', auditRoots: [h.audit], execute: true });
    assert.equal(done.writesEnabled, true);
    assert.deepEqual(current(h).map(r => r.claimKey), ['rule.keep']);
    const query = await planContextQuery({ provider: 'claude-code', runtimeRoot: h.runtime, profileId: 'review', terms: ['consult'], scopeKind: 'project', scopeKey: scope.key });
    assert.ok(!JSON.stringify(query).includes('mandatory'), 'context-query no longer sees it');
    assert.ok(!existsSync(join(h.runtime, 'claims', `${v1}.json`)) && !existsSync(join(h.runtime, 'claims', `${v2}.json`)), 'both versions deleted');
    assert.ok(readdirSync(join(h.runtime, 'review')).every(name =>
      !readFileSync(join(h.runtime, 'review', name), 'utf8').includes('a separate rejected candidate wording')),
    'review candidates for the withdrawn key were removed even with different wording');
    assert.ok(!existsSync(join(h.audit, 'injection-1.json')) && !existsSync(join(h.audit, 'injection-old.json')) &&
      existsSync(join(h.audit, 'injection-2.json')), 'all rendered versions were removed');
    // Nothing on disk under the runtime still carries the value text.
    const all = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]);
    assert.ok(all(h.root).every(path => !readFileSync(path, 'utf8').includes('a consult is mandatory')), 'no copy of the text is left');
    // The event chain still verifies and records the withdrawal with hashes only.
    const { events } = verifyEventStore({ runtimeRoot: h.events });
    const withdrawn = events.filter(e => e.eventType === 'claim.superseded' && e.payload?.disposition === 'withdrawn');
    assert.equal(withdrawn.length, 1);
    assert.equal(withdrawn[0].subjectRef, `acb://claim/${v2}`);
  });

  test('unlinked earlier versions and truncated renders are deleted too', async () => {
    const h = home();
    await accept(h, { claimKey: 'rule.baselines', value: 'Visual baselines are deferred to a dedicated umbrella ticket after the page settles', observedAt: '2026-10-01T09:00:00.000Z' });
    const id = current(h)[0].claimId;
    // An older stored version of the same key that no supersedes link reaches, as a replaced snapshot leaves it.
    const stored = JSON.parse(readFileSync(join(h.runtime, 'claims', `${id}.json`), 'utf8'));
    const orphanId = 'f'.repeat(64);
    writeFileSync(join(h.runtime, 'claims', `${orphanId}.json`), JSON.stringify({ ...stored, claimId: orphanId, value: 'Visual baselines are deferred (older wording)', valueHash: 'e'.repeat(64) }));
    const historical = { schemaVersion: 1, snapshotId: randomUUID(), version: 0, baseSnapshotHash: null,
      scope, createdAt: '2026-09-30T09:00:00.000Z', claimIds: [orphanId], relationKeys: [], canonicalRefs: [], state: 'clean' };
    const snapshotHash = hash(stableJson(historical));
    writeFileSync(join(h.runtime, 'snapshots', `${historical.snapshotId}.json`), JSON.stringify({ ...historical, snapshotHash, digest: snapshotHash }));
    mkdirSync(h.audit, { recursive: true });
    writeFileSync(join(h.audit, 'truncated.json'), JSON.stringify({ payload: { text: '- portal decides: Visual baselines are deferred to a dedicated umbrella…' } }));
    await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'stale', auditRoots: [h.audit], execute: true });
    assert.ok(!existsSync(join(h.runtime, 'claims', `${orphanId}.json`)), 'unlinked version of the key deleted');
    assert.ok(!existsSync(join(h.audit, 'truncated.json')), 'truncated render deleted');
  });

  test('withdrawing the last claim of a scope removes the scope; an unknown id is refused', async () => {
    const h = home();
    await accept(h, { claimKey: 'only.one', value: 'the only accepted claim', observedAt: '2026-10-01T09:00:00.000Z' });
    const id = current(h)[0].claimId;
    await assert.rejects(withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: ['0'.repeat(64)], reason: 'x', execute: true }), /not a current accepted claim/);
    await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'gone', execute: true });
    assert.deepEqual(current(h), []);
    const registry = JSON.parse(readFileSync(join(h.runtime, 'accepted-snapshots.json'), 'utf8'));
    assert.deepEqual(registry.snapshots, []);
    // A new claim in the same scope starts a fresh snapshot.
    await accept(h, { claimKey: 'only.two', value: 'a later claim', observedAt: '2026-10-02T09:00:00.000Z' });
    assert.deepEqual(current(h).map(r => r.claimKey), ['only.two']);
  });

  test('the command plans by default, needs a reason, and executes with --execute', async () => {
    const h = home();
    await accept(h, { claimKey: 'cmd.one', value: 'withdraw me through the command', observedAt: '2026-10-01T09:00:00.000Z' });
    const id = current(h)[0].claimId;
    let out = '';
    assert.equal(await runWithdrawCommand(['--home', h.root, '--claim', id], () => {}, () => {}), 2);
    assert.equal(await runWithdrawCommand(['--home', h.root, '--claim', id, '--reason', 'stale', '--json'], (t) => { out += t; }, () => {}), 0);
    assert.equal(JSON.parse(out).writesEnabled, false);
    assert.equal(current(h).length, 1);
    assert.equal(await runWithdrawCommand(['--home', h.root, '--claim', id, '--reason', 'stale', '--execute', '--json'], () => {}, () => {}), 0);
    assert.equal(current(h).length, 0);
  });

  test('same value under another key survives, and an ambiguous unlinked file is reported', async () => {
    const h = home();
    const first = await accept(h, { claimKey: 'alpha', value: 'a shared neutral value', observedAt: '2026-10-01T09:00:00.000Z' });
    await accept(h, { claimKey: 'beta', value: 'a shared neutral value', observedAt: '2026-10-02T09:00:00.000Z', expectedSnapshotHash: first.snapshotHash });
    const id = current(h).find(claim => claim.claimKey === 'alpha').claimId;
    const ambiguousId = 'e'.repeat(64);
    const stored = JSON.parse(readFileSync(join(h.runtime, 'claims', `${id}.json`), 'utf8'));
    writeFileSync(join(h.runtime, 'claims', `${ambiguousId}.json`), JSON.stringify({ ...stored, claimId: ambiguousId }));
    const plan = planClaimWithdrawal({ runtimeRoot: h.runtime, claimIds: [id], reason: 'retire' });
    assert.deepEqual(plan.ambiguousClaimIds, [ambiguousId]);
    await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'retire', execute: true });
    assert.deepEqual(current(h).map(claim => claim.claimKey), ['beta']);
    assert.ok(existsSync(join(h.runtime, 'claims', `${ambiguousId}.json`)));
  });

  test('shared current file remains for its surviving scope', async () => {
    const h = home();
    const other = { kind: 'project', key: 'second-area' };
    const input = { claimKey: 'shared', value: 'a shared accepted value', observedAt: '2026-10-01T09:00:00.000Z' };
    await accept(h, input);
    await accept(h, { ...input, selectedScope: other });
    const id = current(h)[0].claimId;
    const secondId = exportClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, provider: 'claude-code', scopes: [other] }).records[0].claimId;
    assert.equal(secondId, id);
    await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'one scope only', execute: true });
    assert.ok(existsSync(join(h.runtime, 'claims', `${id}.json`)));
    assert.equal(exportClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, provider: 'claude-code', scopes: [other] }).records.length, 1);
  });

  test('committed withdrawal resumes on reconciliation and blocks later candidates without review values', async () => {
    const h = home();
    await accept(h, { claimKey: 'retired', value: 'old neutral wording', observedAt: '2026-10-01T09:00:00.000Z' });
    const id = current(h)[0].claimId;
    const oldRegistry = readFileSync(join(h.runtime, 'accepted-snapshots.json'), 'utf8');
    await assert.rejects(withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'retire',
      execute: true, testFailPoint: 'after-state' }), /Injected failure/);
    const pending = JSON.parse(readFileSync(join(h.runtime, 'state.json'), 'utf8')).pendingWithdrawals;
    assert.equal(pending.length, 1);
    writeFileSync(join(h.runtime, 'accepted-snapshots.json'), oldRegistry);
    // The old registry can still exist after a crash; readers consult current state.
    assert.deepEqual(current(h), []);
    const query = await planContextQuery({ provider: 'claude-code', runtimeRoot: h.runtime, profileId: 'review',
      terms: ['neutral'], scopeKind: 'project', scopeKey: scope.key });
    assert.equal(query.claims.length, 0);
    const blocked = await accept(h, { claimKey: 'retired', value: 'new neutral private wording', observedAt: '2026-10-02T09:00:00.000Z' });
    assert.equal(blocked.state, 'blocked');
    assert.ok(blocked.issues.some(item => item.code === 'withdrawn'));
    assert.ok(!existsSync(join(h.runtime, 'claims', `${id}.json`)));
    assert.deepEqual(JSON.parse(readFileSync(join(h.runtime, 'state.json'), 'utf8')).pendingWithdrawals, []);
    for (const name of readdirSync(join(h.runtime, 'review'))) {
      assert.ok(!readFileSync(join(h.runtime, 'review', name), 'utf8').includes('new neutral private wording'));
    }
    const retry = await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'retire', execute: true });
    assert.equal(retry.withdrawalId, pending[0]);
  });

  test('replayed accepted batch is historical, and reinstatement permits the key again', async () => {
    const h = home();
    const batchId = 'replay-one';
    await accept(h, { claimKey: 'replay', value: 'replayable neutral wording', observedAt: '2026-10-01T09:00:00.000Z', batchId });
    const id = current(h)[0].claimId;
    await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [id], reason: 'retire', execute: true });
    const replay = await accept(h, { claimKey: 'replay', value: 'replayable neutral wording', observedAt: '2026-10-01T09:00:00.000Z', batchId });
    assert.equal(replay.idempotentReplay, true);
    assert.equal(replay.historical, true);
    const scopeKey = `${scope.kind}:${hash(scope.key)}`;
    const receipt = await reinstateClaim({ runtimeRoot: h.runtime, scopeKey, claimKeyHash: hash('replay'), execute: true });
    assert.equal(receipt.withdrawalId, JSON.parse(readFileSync(join(h.runtime, 'withdrawals', `${receipt.withdrawalId}.json`), 'utf8')).withdrawalId);
    const later = await accept(h, { claimKey: 'replay', value: 'later neutral wording', observedAt: '2026-10-03T09:00:00.000Z' });
    assert.equal(later.state, 'clean');
  });
});

test('the deletion manifest and the receipt carry no claim key or value in plain text', async () => {
  const h = home();
  await accept(h, { claimKey: 'rule.secret-key-name', value: 'a value that must leave the memory entirely', observedAt: '2026-10-02T08:00:00.000Z' });
  const claimId = current(h)[0].claimId;
  await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [claimId], reason: 'test', execute: true });
  const folder = join(h.runtime, 'withdrawals');
  const files = readdirSync(folder).filter(name => name.endsWith('.json'));
  assert.ok(files.some(name => name.endsWith('.manifest.json')));
  for (const name of files) {
    const text = readFileSync(join(folder, name), 'utf8');
    assert.ok(!text.includes('rule.secret-key-name'), name + ' names the key');
    assert.ok(!text.includes('must leave the memory'), name + ' holds the value');
  }
  // A retry of the committed withdrawal resumes it and names the key by its hash.
  const again = await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [claimId], reason: 'test', execute: true });
  assert.equal(again.claims[0].claimKeyHash, hash('rule.secret-key-name'));
});

