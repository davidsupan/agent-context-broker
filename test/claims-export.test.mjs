import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { capabilities, exportClaims, IntegrityError, refMatches, statementOf } from '../src/claims-export.mts';
import { EXIT, runClaimsCommand } from '../src/claims-export-cli.mts';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';

const roots = [];
const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function runtime() {
  const root = join(tmpdir(), `claims-export-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return join(root, 'runtime');
}

async function accept(runtimeRoot, {
  claimKey = 'design.button-colour', value = 'primary buttons use the brand blue', provider = 'claude-code',
  sensitivity = 'shared', scope = { kind: 'project', key: 'example-project' }, canonicalRefs = null,
  observedAt = '2026-10-07T09:00:00.000Z', expectedCurrentClaimId = null, claimType = 'decision', expectedSnapshotHash = null,
} = {}) {
  return reconcileClaimBatch({
    runtimeRoot, execute: true, now: observedAt,
    batch: {
      schemaVersion: 1, batchId: `export-${randomUUID()}`, expectedSnapshotHash, scope,
      relationKeys: [`${scope.kind}:${hash(scope.key.toLowerCase())}`],
      claims: [{
        claimKey, claimType, subject: 'portal', predicate: 'decides', value, observedAt, confidence: 1, sensitivity,
        evidenceClass: 'canonical-artifact', verification: 'verified', expectedCurrentClaimId,
        canonicalRefs: canonicalRefs ?? [`context://agent-context-broker/${claimKey}`],
        provenance: [{ provider, sessionKey: hash(`${provider}-s`), recordKey: hash(`${provider}-${claimKey}-r`), sourceHash: hash(`${provider}-${claimKey}-${value}`) }],
      }],
    },
  });
}

const base = (runtimeRoot, extra = {}) => ({ runtimeRoot, provider: 'claude-code', scopes: [{ kind: 'project', key: 'example-project' }], ...extra });

describe('claims-export', () => {
  test('returns an accepted claim in scope with a statement and no native provenance', async () => {
    const root = runtime();
    await accept(root);
    const result = exportClaims(base(root));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.records.length, 1);
    const [record] = result.records;
    assert.equal(record.claimType, 'decision');
    assert.equal(record.statement, 'portal — decides: primary buttons use the brand blue');
    assert.deepEqual(record.acceptance.providers, ['claude-code']);
    assert.ok(!JSON.stringify(result).includes(hash('claude-code-s')), 'session keys never leave the broker');
    assert.deepEqual(exportClaims(base(root, { scopes: [{ kind: 'project', key: 'other-project' }] })).records, []);
  });

  test('a private claim comes back only for the provider that recorded it', async () => {
    const root = runtime();
    await accept(root, { provider: 'codex', sensitivity: 'private' });
    assert.equal(exportClaims(base(root)).records.length, 0);
    assert.equal(exportClaims(base(root, { provider: 'codex' })).records.length, 1);
  });

  test('refs match by prefix, ignore the query, and narrow to a named Figma node', async () => {
    const file = 'https://www.figma.com/design/AbC123/Portal';
    const root = runtime();
    await accept(root, { scope: { kind: 'workstream', key: 'design' }, canonicalRefs: [`${file}?node-id=10-2`] });
    const byRef = (ref) => exportClaims({ runtimeRoot: root, provider: 'claude-code', scopes: [], refs: [ref] }).records.length;
    assert.equal(byRef(file), 1);
    assert.equal(byRef(`${file}?node-id=10:2`), 1);
    assert.equal(byRef(`${file}?node-id=10-3`), 0);
    assert.equal(byRef('https://www.figma.com/design/Other'), 0);
    assert.equal(refMatches('https://x.example/wiki/spaces/A/pages/42/Title', 'https://x.example/wiki/spaces/A/pages/42'), true);
  });

  test('a superseded claim is not current', async () => {
    const root = runtime();
    const first = await accept(root);
    const old = first.accepted?.[0]?.claimId ?? first.claims?.[0]?.claimId ?? readdirSync(join(root, 'claims'))[0].replace('.json', '');
    await accept(root, { value: 'primary buttons use the new brand blue', expectedCurrentClaimId: old,
      observedAt: '2026-10-07T10:00:00.000Z', expectedSnapshotHash: first.snapshotHash ?? first.snapshot?.snapshotHash ?? null });
    const records = exportClaims(base(root)).records;
    assert.equal(records.length, 1);
    assert.match(records[0].statement, /new brand blue/);
  });

  test('pages are ordered by acceptance time and continue from a cursor', async () => {
    const root = runtime();
    let snapshotHash = null;
    for (const [i, key] of ['a.one', 'b.two', 'c.three'].entries()) {
      const r = await accept(root, { claimKey: key, value: `value ${i}`, observedAt: `2026-10-07T0${i + 1}:00:00.000Z`, expectedSnapshotHash: snapshotHash });
      snapshotHash = r.snapshotHash ?? r.snapshot?.snapshotHash ?? null;
    }
    const first = exportClaims(base(root, { limit: 2 }));
    assert.equal(first.records.length, 2);
    assert.equal(first.truncated, true);
    const second = exportClaims(base(root, { limit: 2, after: first.nextCursor }));
    assert.equal(second.truncated, false);
    assert.deepEqual([...first.records, ...second.records].map(r => r.claimKey), ['a.one', 'b.two', 'c.three']);
  });

  test('a tampered claim is an integrity failure, and the command exits 3 with nothing on stdout', async () => {
    const root = runtime();
    await accept(root);
    const claimFile = join(root, 'claims', readdirSync(join(root, 'claims'))[0]);
    const claim = JSON.parse(readFileSync(claimFile, 'utf8'));
    writeFileSync(claimFile, JSON.stringify({ ...claim, value: 'changed' }));
    assert.throws(() => exportClaims(base(root)), IntegrityError);
    let stdout = '';
    const code = runClaimsCommand('claims-export', ['--provider', 'claude-code', '--runtime-root', root, '--include-project', 'example-project', '--json'], (t) => { stdout += t; }, () => {});
    assert.equal(code, EXIT.integrity);
    assert.equal(stdout, '');
  });

  test('strict isolation and denied scopes return nothing, with a warning', async () => {
    const root = runtime();
    await accept(root);
    const strict = exportClaims(base(root, { providerPolicy: { providers: { 'claude-code': { strictIsolation: true } } } }));
    assert.deepEqual(strict.records, []);
    assert.ok(strict.warnings.includes('provider-policy-strict-isolation'));
    const denied = exportClaims(base(root, { providerPolicy: { providers: { 'claude-code': { read: { allow: ['workstream:*'] } } } } }));
    assert.deepEqual(denied.records, []);
    assert.ok(denied.warnings.includes('provider-policy-denied-scope'));
  });

  test('usage errors exit 2, capabilities name the command, statements are bounded', () => {
    assert.equal(runClaimsCommand('claims-export', ['--provider', 'nobody'], () => {}, () => {}), EXIT.usage);
    assert.ok(capabilities().commands.includes('claims-export'));
    const long = statementOf({ subject: 's', predicate: 'p', value: 'x'.repeat(2000) });
    assert.equal(long.length, 600);
    assert.ok(long.endsWith('…'));
  });
});
