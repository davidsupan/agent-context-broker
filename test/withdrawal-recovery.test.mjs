import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { withdrawClaims } from '../src/claims-withdraw.mts';
import { exportClaims } from '../src/claims-export.mts';
import { planContextQuery } from '../src/context-query.mjs';
import { hash, reconcileClaimBatch } from '../src/reconciliation.mjs';

const scope = { kind: 'project', key: 'sample' };
const key = `project:${hash(scope.key)}`;
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'withdraw-recovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function batch(overrides = {}) {
  return {
    schemaVersion: 1, batchId: randomUUID(), expectedSnapshotHash: null, scope,
    relationKeys: [key],
    claims: [{
      claimKey: 'sample.rule', claimType: 'fact', subject: 'sample', predicate: 'requires',
      value: 'A distinctive statement for withdrawal recovery.', observedAt: '2026-10-01T00:00:00Z',
      confidence: 1, sensitivity: 'shared', evidenceClass: 'canonical-artifact', verification: 'verified',
      expectedCurrentClaimId: null, canonicalRefs: ['context://sample/rule'],
      provenance: [{ provider: 'codex', sessionKey: hash('session'), recordKey: hash('record'), sourceHash: hash('source') }],
    }], ...overrides,
  };
}
async function seed(root, input = batch()) {
  const result = await reconcileClaimBatch({ runtimeRoot: root, batch: input, execute: true });
  const state = read(join(root, 'state.json'));
  return { input, result, id: state.scopes[key].claimIndex['sample.rule'].claimId };
}
const withdraw = (root, id, extra = {}) => withdrawClaims({ runtimeRoot: root, claimIds: [id], reason: 'removed', execute: true, ...extra });

test('a prepared but uncommitted manifest cannot masquerade as a completed withdrawal', async t => {
  const root = fixture(t);
  const { id } = await seed(root);
  const original = readFileSync(join(root, 'state.json'), 'utf8');
  await assert.rejects(withdraw(root, id, { testFailPoint: 'after-state' }), /Injected failure/);
  // Simulate the earlier crash boundary: the manifest exists, but publication did not happen.
  writeFileSync(join(root, 'state.json'), original);
  await withdraw(root, id);
  const state = read(join(root, 'state.json'));
  assert.ok(state.tombstones?.[key]?.[hash('sample.rule')]);
  assert.equal(existsSync(join(root, 'claims', `${id}.json`)), false);
});

test('legacy batch replays are historical after withdrawal', async t => {
  const root = fixture(t);
  const { input, result, id } = await seed(root);
  const state = read(join(root, 'state.json'));
  // Results written by the prior version have no accepted-key metadata.
  delete state.batches[result.batchKey].acceptedClaimKeys;
  delete state.batches[result.batchKey].acceptedScopeKey;
  write(join(root, 'state.json'), state);
  await withdraw(root, id);
  const replay = await reconcileClaimBatch({ runtimeRoot: root, batch: input, execute: true });
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.historical, true);
});

test('duplicate batch replays are historical after withdrawal', async t => {
  const root = fixture(t);
  const { result, id } = await seed(root);
  const duplicate = batch({ expectedSnapshotHash: result.snapshotHash });
  const accepted = await reconcileClaimBatch({ runtimeRoot: root, batch: duplicate, execute: true });
  assert.equal(accepted.duplicateClaimCount, 1);
  await withdraw(root, id);
  const replay = await reconcileClaimBatch({ runtimeRoot: root, batch: duplicate, execute: true });
  assert.equal(replay.historical, true);
});

test('shared current claim files survive while registered render copies are cleaned', async t => {
  const root = fixture(t);
  const { id, input } = await seed(root);
  const state = read(join(root, 'state.json'));
  const otherKey = `project:${hash('other-sample')}`;
  state.scopes[otherKey] = { ...state.scopes[key], scopeKey: otherKey };
  write(join(root, 'state.json'), state);
  const audit = join(root, 'query-audit');
  mkdirSync(audit);
  write(join(audit, 'render.json'), { payload: input.claims[0].value });
  await withdraw(root, id, { auditRoots: [audit] });
  assert.equal(existsSync(join(root, 'claims', `${id}.json`)), true);
  assert.equal(existsSync(join(audit, 'render.json')), false);
});

test('an unrelated non-current file with the same value survives', async t => {
  const root = fixture(t);
  const { id, result, input } = await seed(root);
  const other = batch({ expectedSnapshotHash: result.snapshotHash });
  other.claims[0].claimKey = 'other.rule';
  const first = await reconcileClaimBatch({ runtimeRoot: root, batch: other, execute: true });
  const oldId = read(join(root, 'state.json')).scopes[key].claimIndex['other.rule'].claimId;
  const replacement = batch({ expectedSnapshotHash: first.snapshotHash });
  replacement.claims[0] = { ...other.claims[0], expectedCurrentClaimId: oldId, value: 'A different replacement statement.' };
  await reconcileClaimBatch({ runtimeRoot: root, batch: replacement, execute: true });
  await withdraw(root, id);
  assert.equal(read(join(root, 'claims', `${oldId}.json`)).value, input.claims[0].value);
});

test('readers fail closed when a stale registry has no readable state', async t => {
  const root = fixture(t);
  await seed(root);
  const query = () => planContextQuery({ runtimeRoot: root, provider: 'codex', profileId: 'review', scopeKind: 'project', scopeKey: scope.key });
  const exported = () => exportClaims({ runtimeRoot: root, provider: 'codex', scopes: [scope] });
  for (const content of [null, '{broken']) {
    if (content === null) rmSync(join(root, 'state.json'));
    else writeFileSync(join(root, 'state.json'), content);
    assert.throws(exported);
    await assert.rejects(query());
  }
});

test('recovery removes broker write temporaries and preserves unrelated audit temporaries', async t => {
  const root = fixture(t);
  const { id } = await seed(root);
  await assert.rejects(withdraw(root, id, { afterStateWrite() { throw new Error('interrupted'); } }), /interrupted/);
  const suffix = `${process.pid}.${randomUUID()}.tmp`;
  const stateTemp = join(root, `.state.json.${suffix}`);
  const reviewRoot = join(root, 'review');
  mkdirSync(reviewRoot, { recursive: true });
  const reviewTemp = join(reviewRoot, `.review.json.${suffix}`);
  const auditRoot = join(root, 'query-audit');
  mkdirSync(auditRoot);
  const unrelatedTemp = join(auditRoot, `.render.json.${suffix}`);
  for (const path of [stateTemp, reviewTemp, unrelatedTemp]) writeFileSync(path, 'leftover text');
  await withdraw(root, id);
  assert.equal(existsSync(stateTemp), false);
  assert.equal(existsSync(reviewTemp), false);
  assert.equal(existsSync(unrelatedTemp), true);
});
