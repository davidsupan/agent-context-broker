import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before } from 'node:test';
import { createHash } from 'node:crypto';
import { listContextNotices, runContextNoticesCommand } from '../src/context-notices.mjs';
import { planContextQuery } from '../src/context-query.mjs';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';
import { fixture, git, receiptFixture, writeJson } from './notice-fixtures.mjs';

/** Register per-file hooks, also when the runner shares its module cache across files. */
export function createNoticeSuite() {
  let base;
  before(() => {
    base = fixture();
    // Most cases exercise an existing installation. Fresh creation and the real
    // Windows ACL are covered separately by the nonce integration tests.
    mkdirSync(join(base.home, 'team-shared'));
    writeFileSync(join(base.home, 'team-shared', 'nonce-secret'), Buffer.alloc(32, 0xa1), { flag: 'wx', mode: 0o600 });
  });
  after(() => { if (base) rmSync(base.root, { recursive: true, force: true }); });
  return (t, records, mutable = false) => {
    const f = fixture(records, base, mutable);
    t.after(() => rmSync(f.root, { recursive: true, force: true }));
    return f;
  };
}

export function read(f, extra = {}) { return listContextNotices({ ...f.options, ...extra }); }
export function metadata(f, checkedOutAt, approvedBy = {}) {
  writeJson(join(f.home, 'team-shared-metadata.json'), { schemaVersion: 1, repository: f.repository,
    commit: git(f.checkout, ['rev-parse', 'HEAD']), checkedOutAt, approvedBy });
  receiptFixture(f, approvedBy);
}

export function matrix(f, cell) {
  writeJson(join(f.home, 'audience-policy.json'), { schemaVersion: 1, roles: ['dev', 'qa', 'design'], matrix: { dev: { dev: cell } } });
}

export function command(t, f, args) {
  let stdout = ''; let stderr = '';
  const out = t.mock.method(process.stdout, 'write', (chunk) => { stdout += chunk; return true; });
  const err = t.mock.method(process.stderr, 'write', (chunk) => { stderr += chunk; return true; });
  try { return { status: runContextNoticesCommand([...args, '--runtime-home', f.home]), get stdout() { return stdout; }, get stderr() { return stderr; } }; }
  finally { out.mock.restore(); err.mock.restore(); }
}

export function query(f, extra = {}) {
  const runtimeRoot = join(f.home, 'runtime', 'reconciliation');
  mkdirSync(runtimeRoot, { recursive: true });
  return planContextQuery({ ...f.options, runtimeRoot, provider: 'codex', profileId: 'implementation',
    scopeKind: 'project', scopeKey: 'sample', ...extra });
}

export async function acceptedClaim(f, value = 'Accepted implementation guidance') {
  const runtimeRoot = join(f.home, 'runtime', 'reconciliation');
  const hash = (v) => createHash('sha256').update(v).digest('hex');
  await reconcileClaimBatch({ runtimeRoot, execute: true, now: f.options.now, batch: {
    schemaVersion: 1, batchId: 'notice-lane-claim', expectedSnapshotHash: null,
    scope: { kind: 'project', key: 'sample' }, relationKeys: [`project:${hash('sample')}`],
    claims: [{ claimKey: 'implementation.guidance', claimType: 'procedure', subject: 'sample', predicate: 'requires',
      value, observedAt: f.options.now, confidence: 1, sensitivity: 'shared', evidenceClass: 'canonical-artifact',
      verification: 'verified', expectedCurrentClaimId: null, canonicalRefs: ['context://sample/guidance'],
      provenance: [{ provider: 'codex', sessionKey: hash('session'), recordKey: hash('record'), sourceHash: hash('source') }] }]
  } });
}
