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
import { reconcileClaimBatch } from '../src/reconciliation.mjs';

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
async function accept(h, { claimKey, value, observedAt, expectedCurrentClaimId = null, expectedSnapshotHash = null }) {
  return reconcileClaimBatch({
    runtimeRoot: h.runtime, eventRuntimeRoot: h.events, execute: true, now: observedAt,
    batch: {
      schemaVersion: 1, batchId: `w-${randomUUID()}`, expectedSnapshotHash, scope,
      relationKeys: [`project:${hash(scope.key.toLowerCase())}`],
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
    writeFileSync(join(h.audit, 'injection-2.json'), JSON.stringify({ payload: '- portal decides: keep this one around' }));

    const plan = planClaimWithdrawal({ runtimeRoot: h.runtime, claimIds: [v2], reason: 'rule removed', auditRoots: [h.audit] });
    assert.equal(plan.writesEnabled, false);
    assert.deepEqual(plan.claims[0].versions, [v2, v1]);
    assert.deepEqual(plan.deletes, { claimFiles: 2, reviewCandidates: 0, auditArtifacts: 1 });
    assert.ok(existsSync(join(h.runtime, 'claims', `${v2}.json`)), 'planning writes nothing');

    const done = await withdrawClaims({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, claimIds: [v2], reason: 'rule removed', auditRoots: [h.audit], execute: true });
    assert.equal(done.writesEnabled, true);
    assert.deepEqual(current(h).map(r => r.claimKey), ['rule.keep']);
    const query = await planContextQuery({ provider: 'claude-code', runtimeRoot: h.runtime, profileId: 'review', terms: ['consult'], scopeKind: 'project', scopeKey: scope.key });
    assert.ok(!JSON.stringify(query).includes('mandatory'), 'context-query no longer sees it');
    assert.ok(!existsSync(join(h.runtime, 'claims', `${v1}.json`)) && !existsSync(join(h.runtime, 'claims', `${v2}.json`)), 'both versions deleted');
    assert.ok(!existsSync(join(h.audit, 'injection-1.json')) && existsSync(join(h.audit, 'injection-2.json')), 'only the artifact that carried it');
    // Nothing on disk under the runtime still carries the value text.
    const all = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? all(join(dir, e.name)) : [join(dir, e.name)]);
    assert.ok(all(h.root).every(path => !readFileSync(path, 'utf8').includes('a consult is mandatory')), 'no copy of the text is left');
    // The event chain still verifies and records the withdrawal with hashes only.
    const { events } = verifyEventStore({ runtimeRoot: h.events });
    const withdrawn = events.filter(e => e.eventType === 'claim.superseded' && e.payload?.disposition === 'withdrawn');
    assert.equal(withdrawn.length, 1);
    assert.equal(withdrawn[0].subjectRef, `acb://claim/${v2}`);
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
});
