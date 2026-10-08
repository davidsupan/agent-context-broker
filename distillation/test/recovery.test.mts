import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, renameSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { Database } from '../src/sqlite.mts';
import { runCapture, sha256 } from '../src/capture.mts';
import { prepareSlices, verifyStoredSlice } from '../src/slice-queue.mts';
import { coverage, canonical } from '../src/slicing.mts';
import { setup, reserve, markDispatch } from '../src/store.mts';
import { recover, type RecoveryProbes } from '../src/recovery.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const rel = relative(resolve(tmpdir()), resolve(root));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('cleanup-boundary');
    rmSync(root, { recursive: true, force: true });
  }
});
const policy = { claudeAvailable: true, sliceChars: 16000, attemptSeconds: 60 };
const owner = { platform: 'windows', pid: 4567, creationFiletime: '123456789012345678', machineIdSha256: '1'.repeat(64) };
const ended: RecoveryProbes = { ownerStatus: async () => 'dead' as const, containmentStatus: async () => 'empty' as const };
function inspect(home: string, sql: string) {
  using db = new Database(join(home, 'queue.sqlite3'), { readonly: true });
  return db.query(sql).all() as Record<string, unknown>[];
}
function mutate(home: string, sql: string, ...args: Array<string | number | null>) {
  using db = new Database(join(home, 'queue.sqlite3'));
  db.query(sql).run(...args);
}
function fixture(dispatched = true) {
  const root = mkdtempSync(join(tmpdir(), 'acb-recovery-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'history.json'); writeFileSync(path, registry);
  writeFileSync(join(source, 'a.jsonl'), JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'Synthetic bounded recovery fixture.' } }) + '\n');
  runCapture({ providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 }, home, true);
  prepareSlices(home, [], policy.sliceChars, true);
  const job = inspect(home, 'SELECT * FROM jobs')[0]!;
  const row = inspect(home, 'SELECT * FROM slices')[0]!;
  const item = verifyStoredSlice(row);
  using db = new Database(join(home, 'queue.sqlite3'));
  setup(db);
  const request = { jobId: String(job.id), sliceId: item.sliceId, payloadSha: String(row.payload_sha),
    sourceReceiptSha: String(job.receipt_hash), seconds: 60, claudeAvailable: true, owner,
    now: Date.UTC(2026, 8, 21, 12) / 1000 };
  const result = reserve(db, request);
  if (result.state !== 'reserved') throw new Error('fixture-reservation');
  const token = result.token;
  const containment = { schemaVersion: 1, platform: 'windows', jobName: `Local\\ACBCorpus-${token}`,
    attemptToken: token, machineIdSha256: owner.machineIdSha256 };
  db.query('UPDATE semantic_attempts SET containment_json=? WHERE token=?').run(JSON.stringify(containment), token);
  if (dispatched) markDispatch(db, token);
  const outputJson = canonical({ schemaVersion: 1, sliceId: item.sliceId, coverage: coverage(item),
    disposition: 'no-durable-findings', observations: [] });
  const receipt = { schemaVersion: 1, attemptToken: token, jobId: String(job.id), sliceId: item.sliceId,
    sourceReceiptSha256: String(job.receipt_hash), provider: 'claude', reason: 'primary', state: 'pending-review', accepted: false,
    reservedSeconds: 60, utcDay: '2026-09-21', completionProof: 'windows-atomic-job-empty-v1',
    outputJson, outputSha256: sha256(outputJson), usage: { input_tokens: 1 }, modelElapsedSeconds: 0.1,
    recordedAt: '2026-09-21T12:00:01.000Z' };
  const resultPath = join(home, 'semantic-results', `${token}.json`);
  const persist = (value: unknown = receipt) => {
    mkdirSync(join(home, 'semantic-results'), { recursive: true });
    writeFileSync(resultPath, canonical(value) + '\n');
  };
  return { root, home, token, job, item, request, containment, receipt, resultPath, persist };
}
function unchanged(home: string) {
  expect(inspect(home, 'SELECT state FROM semantic_attempts')[0]!.state).toBe('running');
  expect(inspect(home, 'SELECT state FROM slices')[0]!.state).toBe('pending');
  expect(inspect(home, 'SELECT seconds FROM semantic_budget')[0]!.seconds).toBe(60);
}

test('valid persisted result recovers on restart, stays pending-review and never reruns or refunds', async () => {
  const f = fixture(); f.persist();
  const receiptBytes = readFileSync(f.resultPath);
  expect(await recover(f.home, policy, false, ended)).toMatchObject({ state: 'recoverable-result', writes: false });
  unchanged(f.home);
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'recovered-result', writes: true, accepted: false, refundSeconds: 0, invoked: false });
  expect(inspect(f.home, 'SELECT state,output_json,output_sha256 FROM semantic_attempts')[0])
    .toEqual({ state: 'pending-review', output_json: f.receipt.outputJson, output_sha256: f.receipt.outputSha256 });
  expect(inspect(f.home, 'SELECT state FROM slices')[0]!.state).toBe('pending-review');
  expect(inspect(f.home, 'SELECT state FROM jobs')[0]!.state).toBe('pending-review');
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'idle', writes: false });
  using db = new Database(join(f.home, 'queue.sqlite3'));
  expect(reserve(db, f.request).state).toBe('source-state-changed');
  expect(inspect(f.home, 'SELECT seconds FROM semantic_budget')[0]!.seconds).toBe(60);
  expect(readFileSync(f.resultPath).equals(receiptBytes)).toBe(true);
});

test('current Windows job proof recovers only after owner and containment checks', async () => {
  const f = fixture(); f.persist({ ...f.receipt, completionProof: 'windows-job-empty-v1' });
  expect(await recover(f.home, policy, false, ended)).toMatchObject({ state: 'recoverable-result', writes: false });
  expect(await recover(f.home, policy, true, { ...ended, containmentStatus: () => 'unknown' }))
    .toMatchObject({ state: 'containment-unresolved', writes: false });
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'recovered-result', writes: true });
});

test('proven dead predispatch releases only the lease, preserving the charged reservation', async () => {
  const f = fixture(false);
  expect(await recover(f.home, policy, false, ended)).toMatchObject({ state: 'recoverable-before-dispatch', writes: false });
  unchanged(f.home);
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'recovered-before-dispatch', writes: true, refundSeconds: 0 });
  expect(inspect(f.home, 'SELECT state FROM semantic_attempts')[0]!.state).toBe('interrupted-before-dispatch');
  expect(inspect(f.home, 'SELECT state FROM slices')[0]!.state).toBe('pending');
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'idle' });
  using db = new Database(join(f.home, 'queue.sqlite3'));
  expect(reserve(db, f.request).state).toBe('reserved');
  expect(inspect(f.home, 'SELECT seconds FROM semantic_budget')[0]!.seconds).toBe(120);
});

test('postdispatch missing results retire the slice only after definite empty containment', async () => {
  for (const containment of ['empty'] as const) {
    const f = fixture();
    const probes: RecoveryProbes = { ownerStatus: async () => 'dead' as const, containmentStatus: async () => containment };
    expect(await recover(f.home, policy, false, probes)).toMatchObject({ state: 'recoverable-unknown', writes: false });
    unchanged(f.home);
    expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'quarantined-unknown', writes: true });
    expect(inspect(f.home, 'SELECT state FROM slices')[0]!.state).toBe('interrupted-unknown');
    expect(inspect(f.home, 'SELECT state FROM semantic_attempts')[0]!.state).toBe('interrupted-unknown');
    expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'idle' });
    using db = new Database(join(f.home, 'queue.sqlite3'));
    expect(reserve(db, f.request).state).toBe('source-state-changed');
    expect(inspect(f.home, 'SELECT seconds FROM semantic_budget')[0]!.seconds).toBe(60);
  }
});

test('only the durable reserved phase can recover without a registry record', async () => {
  for (const dispatched of [false, true]) {
    const f = fixture(dispatched);
    const result = await recover(f.home, policy, true, { ...ended, containmentStatus: () => 'unknown' });
    expect(result).toMatchObject(dispatched ? { state: 'containment-unresolved', writes: false }
      : { state: 'recovered-before-dispatch', writes: true });
    if (dispatched) unchanged(f.home);
  }
});

test('alive, unknown, throwing or unavailable probes never expire old leases', async () => {
  const f = fixture(); f.persist();
  mutate(f.home, 'UPDATE semantic_attempts SET started_at=1');
  for (const state of ['alive', 'unknown'] as const) {
    let containmentCalls = 0;
    const probes: RecoveryProbes = { ownerStatus: async () => state, containmentStatus: async () => { containmentCalls++; return 'empty' as const; } };
    expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'owner-not-proved-ended', writes: false });
    expect(containmentCalls).toBe(0); unchanged(f.home);
  }
  for (const state of ['active', 'unknown', 'absent'] as const) {
    expect(await recover(f.home, policy, true, { ...ended, containmentStatus: async () => state })).toMatchObject({ state: 'containment-unresolved', writes: false });
    unchanged(f.home);
  }
  expect(await recover(f.home, policy, true)).toMatchObject({ writes: false });
  const result = await recover(f.home, policy, true, { ...ended, ownerStatus: async () => { throw new Error('PRIVATE_PATH_AND_RAW'); } });
  expect(result.writes).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE'); unchanged(f.home);
});

test('null, legacy and synthetic identities cannot be certified by careless probes', async () => {
  const f = fixture(false); let calls = 0;
  const probes: RecoveryProbes = { ownerStatus: async () => { calls++; return 'dead' as const; }, containmentStatus: async () => { calls++; return 'absent' as const; } };
  for (const field of ['owner_json', 'containment_json']) {
    const original = inspect(f.home, `SELECT ${field} FROM semantic_attempts`)[0]![field] as string;
    for (const value of [null, 'null', '{}', '[]', '{bad', JSON.stringify({ platform: 'synthetic', pid: 4567 }),
      JSON.stringify({ pid: 4567, hostHash: owner.machineIdSha256, runtime: 'bun' })]) {
      calls = 0; mutate(f.home, `UPDATE semantic_attempts SET ${field}=?`, value);
      expect((await recover(f.home, policy, true, probes)).writes).toBe(false);
      expect(calls).toBe(0); unchanged(f.home);
    }
    mutate(f.home, `UPDATE semantic_attempts SET ${field}=?`, original);
  }
});

test('containment token, exact job namespace, platform and owner machine are bound before probing', async () => {
  const f = fixture(); let calls = 0;
  const probes: RecoveryProbes = { ownerStatus: async () => { calls++; return 'dead' as const; }, containmentStatus: async () => { calls++; return 'empty' as const; } };
  for (const patch of [{ attemptToken: '0'.repeat(32) }, { jobName: 'Local\\ACBCorpus-' + '0'.repeat(32) },
    { jobName: 'Global\\ACBCorpus-' + f.token }, { machineIdSha256: '2'.repeat(64) }, { platform: 'synthetic' }, { schemaVersion: 2 }]) {
    mutate(f.home, 'UPDATE semantic_attempts SET containment_json=?', JSON.stringify({ ...f.containment, ...patch }));
    expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'containment-unresolved', writes: false });
    expect(calls).toBe(0); unchanged(f.home);
  }
});

test('invalid persisted receipts never downgrade to a missing result', { timeout: 30000 }, async () => {
  const f = fixture();
  for (const patch of [{ attemptToken: '0'.repeat(32) }, { jobId: '0'.repeat(64) }, { sliceId: '0'.repeat(64) },
    { sourceReceiptSha256: '0'.repeat(64) }, { outputSha256: '0'.repeat(64) }, { provider: 'codex' },
    { reason: 'claude-quota-unavailable' }, { reservedSeconds: 1 }, { utcDay: '2026-09-20' },
    { completionProof: 'synthetic-fixture' }, { accepted: true }, { state: 'quota-unavailable' },
    { outputJson: f.receipt.outputJson + ' ' }, { modelElapsedSeconds: -1 }, { usage: { secret: 'PRIVATE_RAW' } }]) {
    f.persist({ ...f.receipt, ...patch });
    expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'result-proof-invalid', writes: false });
    unchanged(f.home);
  }
  for (const text of ['', '{bad PRIVATE_RAW', canonical(f.receipt).replace('"accepted":false', '"accepted":true,"accepted":false') + '\n']) {
    writeFileSync(f.resultPath, text);
    expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'result-proof-invalid', writes: false });
    unchanged(f.home);
  }
});

test('output coverage, source artifacts, stored slice and current policy are revalidated', async () => {
  const f = fixture(); f.persist();
  const outputJson = canonical({ ...JSON.parse(f.receipt.outputJson), coverage: [] });
  f.persist({ ...f.receipt, outputJson, outputSha256: sha256(outputJson) });
  expect((await recover(f.home, policy, true, ended)).writes).toBe(false); unchanged(f.home);
  f.persist();
  expect(await recover(f.home, { ...policy, excludedSources: ['CODEX:A.JSONL'] }, true, ended)).toMatchObject({ state: 'excluded', writes: false });
  expect((await recover(f.home, { ...policy, sliceChars: 4 }, true, ended)).writes).toBe(false); unchanged(f.home);
  const artifact = join(f.home, String(f.job.generation), 'dialogue.private.jsonl');
  const original = readFileSync(artifact); appendFileSync(artifact, ' ');
  expect((await recover(f.home, policy, true, ended)).writes).toBe(false); unchanged(f.home);
  writeFileSync(artifact, original);
  mutate(f.home, "UPDATE slices SET payload_sha=?", '0'.repeat(64));
  expect((await recover(f.home, policy, true, ended)).writes).toBe(false); unchanged(f.home);
});

test('awaited probes cannot race a changed attempt, slice, job or policy into recovery', async () => {
  for (const change of ['owner', 'phase', 'slice', 'job', 'policy', 'source']) {
    const f = fixture(); f.persist(); const currentPolicy = { ...policy };
    let calls = 0;
    const probes: RecoveryProbes = { ...ended, containmentStatus: async () => {
      if (++calls === 2) {
        if (change === 'owner') mutate(f.home, 'UPDATE semantic_attempts SET owner_json=?', JSON.stringify({ ...owner, pid: 9999 }));
        if (change === 'phase') mutate(f.home, "UPDATE semantic_attempts SET execution_phase='reserved'");
        if (change === 'slice') mutate(f.home, 'UPDATE slices SET payload_sha=?', '0'.repeat(64));
        if (change === 'job') mutate(f.home, 'UPDATE jobs SET receipt_hash=?', '0'.repeat(64));
        if (change === 'policy') currentPolicy.sliceChars = 4;
        if (change === 'source') appendFileSync(join(f.home, String(f.job.generation), 'raw.private.jsonl'), ' ');
      }
      return 'empty' as const;
    } };
    expect((await recover(f.home, currentPolicy, true, probes)).writes).toBe(false);
    unchanged(f.home);
  }
});

test('late, changed or deleted result between probes never grants missing-result quarantine', async () => {
  for (const change of ['appear', 'change', 'delete', 'replace']) {
    const f = fixture(); if (change !== 'appear') f.persist();
    let calls = 0;
    const probes: RecoveryProbes = { ...ended, containmentStatus: async () => {
      if (++calls === 2) {
        if (change === 'appear') f.persist();
        if (change === 'change') f.persist({ ...f.receipt, outputSha256: '0'.repeat(64) });
        if (change === 'delete') renameSync(f.resultPath, f.resultPath + '.old');
        if (change === 'replace') { renameSync(f.resultPath, f.resultPath + '.old'); f.persist(); }
      }
      return 'empty' as const;
    } };
    expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'result-changed', writes: false });
    unchanged(f.home);
  }
});

test('two concurrent recoverers cannot both finalize the same lease', async () => {
  const f = fixture(); f.persist();
  let release!: () => void, arrived!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const waiting = new Promise<void>(resolve => { arrived = resolve; });
  const slow: RecoveryProbes = { ...ended, containmentStatus: async () => {
    if (++calls === 2) { arrived(); await gate; }
    return 'empty' as const;
  } };
  const first = recover(f.home, policy, true, slow); await waiting;
  try { expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'recovered-result', writes: true }); }
  finally { release(); }
  expect(await first).toMatchObject({ state: 'attempt-changed', writes: false });
  expect(inspect(f.home, 'SELECT seconds FROM semantic_budget')[0]!.seconds).toBe(60);
});

test('failed slice write rolls back attempt finalization atomically', async () => {
  const f = fixture(); f.persist();
  mutate(f.home, "CREATE TRIGGER reject_recovery BEFORE UPDATE OF state ON slices BEGIN SELECT RAISE(ABORT,'PRIVATE_SENTINEL'); END");
  const result = await recover(f.home, policy, true, ended);
  expect(result.writes).toBe(false); expect(JSON.stringify(result)).not.toContain('PRIVATE'); unchanged(f.home);
});

test('a present invalid receipt disappearing during the first probe cannot become missing', async () => {
  const f = fixture(); f.persist({ invalid: 'PRIVATE_RAW' });
  const probes: RecoveryProbes = { ...ended, ownerStatus: async () => {
    renameSync(f.resultPath, f.resultPath + '.old'); return 'dead' as const;
  } };
  expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'result-proof-invalid', writes: false });
  unchanged(f.home);
});

test('a second liveness or containment check becoming unknown retains the lease', async () => {
  const f = fixture(); f.persist();
  let calls = 0;
  expect(await recover(f.home, policy, true, { ...ended, ownerStatus: async () => ++calls === 1 ? 'dead' as const : 'alive' as const }))
    .toMatchObject({ state: 'owner-not-proved-ended', writes: false });
  unchanged(f.home); calls = 0;
  expect(await recover(f.home, policy, true, { ...ended, containmentStatus: async () => ++calls === 1 ? 'empty' as const : 'unknown' as const }))
    .toMatchObject({ state: 'containment-unresolved', writes: false });
  unchanged(f.home);
});

test('duplicate descriptor keys, non-file results and predispatch receipts fail closed', async () => {
  const f = fixture(false);
  f.persist();
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'result-proof-invalid', writes: false });
  unchanged(f.home);
  renameSync(f.resultPath, f.resultPath + '.old'); mkdirSync(f.resultPath);
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'result-proof-invalid', writes: false });
  unchanged(f.home);
  mutate(f.home, 'UPDATE semantic_attempts SET owner_json=?', JSON.stringify(owner).replace('"pid":4567', '"pid":1,"pid":4567'));
  let called = false;
  expect(await recover(f.home, policy, true, { ...ended, ownerStatus: async () => { called = true; return 'dead' as const; } }))
    .toMatchObject({ state: 'owner-not-proved-ended', writes: false });
  expect(called).toBe(false); unchanged(f.home);
});

test('foreign machine owner remains blocked when the trusted probe cannot certify this host', async () => {
  const f = fixture(); f.persist();
  let containmentCalls = 0;
  const probes: RecoveryProbes = {
    ownerStatus: async value => (value as typeof owner).machineIdSha256 === '2'.repeat(64) ? 'dead' as const : 'unknown' as const,
    containmentStatus: async () => { containmentCalls++; return 'absent' as const; }
  };
  expect(await recover(f.home, policy, true, probes)).toMatchObject({ state: 'owner-not-proved-ended', writes: false });
  expect(containmentCalls).toBe(0); unchanged(f.home);
});

test('plan on absent home creates nothing, legacy and duplicate running leases fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'acb-recovery-')); roots.push(root);
  const absent = join(root, 'absent');
  expect(await recover(absent, policy, false, ended)).toMatchObject({ state: 'not-initialized', writes: false });
  expect(existsSync(absent)).toBe(false);
  const f = fixture();
  mutate(f.home, `INSERT INTO semantic_attempts(job_id,token,state) VALUES(?,'${'f'.repeat(32)}','running')`, String(f.job.id));
  expect(await recover(f.home, policy, true, ended)).toMatchObject({ state: 'lease-integrity-unknown', writes: false });
});
