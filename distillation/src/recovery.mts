import { type BigIntStats, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { WorkerPolicy, type WorkerPolicyInput } from './consumer.mts';
import { HashSchema, TokenSchema } from './schemas.mts';
import { noLinks, openStore } from './store.mts';
import { checkedDialogue, verifyStoredSlice } from './slice-queue.mts';
import { checkedDocument } from './documents.mts';
import { buildSlices, canonical } from './slicing.mts';
import { validateOutput } from './output.mts';
import { sha256 } from './capture.mts';

type MaybePromise<T> = T | Promise<T>;
export type RecoveryProbes = {
  /** Receives the parsed, validated persisted descriptor, never a PID alone. */
  ownerStatus(owner: unknown): MaybePromise<'alive' | 'dead' | 'unknown'>;
  /** Read-only probe under the named atomic-job contract; never terminate here. */
  containmentStatus(containment: unknown): MaybePromise<'empty' | 'absent' | 'active' | 'unknown'>;
};
const unavailable: RecoveryProbes = { ownerStatus: () => 'unknown', containmentStatus: () => 'unknown' };
const Owner = z.strictObject({ platform: z.literal('windows'), pid: z.number().int().min(1).max(0xffffffff),
  creationFiletime: z.string().regex(/^[1-9][0-9]{0,19}$/).refine(s => BigInt(s) <= 0xffffffffffffffffn),
  machineIdSha256: HashSchema });
const Containment = z.strictObject({ schemaVersion: z.literal(1), platform: z.literal('windows'),
  jobName: z.string(), attemptToken: TokenSchema, machineIdSha256: HashSchema });
const Attempt = z.object({ token: TokenSchema, job_id: HashSchema, slice_id: HashSchema,
  state: z.literal('running'), execution_phase: z.enum(['reserved', 'dispatch-intent']),
  owner_json: z.string(), containment_json: z.string(),
  provider: z.enum(['claude', 'codex']), reason: z.enum(['primary', 'claude-quota-unavailable']),
  day: z.iso.date(), reserved_seconds: z.number().int().min(1).max(1800) });
const Usage = z.strictObject({
  input_tokens: z.number().int().min(0).max(1e12).optional(),
  output_tokens: z.number().int().min(0).max(1e12).optional(),
  cache_creation_input_tokens: z.number().int().min(0).max(1e12).optional(),
  cache_read_input_tokens: z.number().int().min(0).max(1e12).optional()
});
const Receipt = z.strictObject({ schemaVersion: z.literal(1), attemptToken: TokenSchema,
  jobId: HashSchema, sliceId: HashSchema, sourceReceiptSha256: HashSchema,
  provider: z.enum(['claude', 'codex']), reason: z.enum(['primary', 'claude-quota-unavailable']),
  state: z.literal('pending-review'), accepted: z.literal(false),
  reservedSeconds: z.number().int().min(1).max(1800), utcDay: z.iso.date(),
  completionProof: z.literal('windows-atomic-job-empty-v1'), outputJson: z.string(), outputSha256: HashSchema,
  usage: Usage, modelElapsedSeconds: z.number().finite().min(0).max(3600), recordedAt: z.iso.datetime() });

function outcome(state: string, writes = false) {
  return { state, writes, accepted: false as const, refundSeconds: 0 as const, invoked: false as const };
}
function stop(code: string): never { throw new Error(code); }
function sameFile(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function missing(error: unknown) {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}
function resultFile(path: string) {
  try {
    noLinks(path);
    let before: BigIntStats;
    try { before = lstatSync(path, { bigint: true }); }
    catch (error) { if (missing(error)) return null; throw error; }
    if (!before.isFile() || before.size > 2n * 1024n * 1024n) stop('result-proof-invalid');
    const fd = openSync(path, 'r');
    try {
      if (!sameFile(before, fstatSync(fd, { bigint: true }))) stop('result-proof-invalid');
      const raw = Buffer.alloc(Number(before.size) + 1);
      let bytes = 0;
      while (bytes < raw.length) {
        const n = readSync(fd, raw, bytes, raw.length - bytes, bytes);
        if (!n) break;
        bytes += n;
      }
      noLinks(path);
      if (BigInt(bytes) !== before.size || !sameFile(before, fstatSync(fd, { bigint: true })) ||
        !sameFile(before, lstatSync(path, { bigint: true }))) stop('result-proof-invalid');
      return { raw: raw.subarray(0, bytes), stat: before };
    } finally { closeSync(fd); }
  } catch { return stop('result-proof-invalid'); }
}

function json(text: string): unknown {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) stop('invalid-json');
  const scopes: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      const key: unknown = JSON.parse(text.slice(start, i + 1));
      let next = i + 1;
      while (next < text.length && /[\t\r\n ]/.test(text[next]!)) next++;
      if (text[next] === ':') {
        const keys = scopes.at(-1);
        if (!keys || typeof key !== 'string' || keys.has(key)) stop('invalid-json');
        keys.add(key);
      }
    } else if (text[i] === '{' || text[i] === '[') {
      if (scopes.length >= 64) stop('invalid-json');
      scopes.push(text[i] === '{' ? new Set() : null);
    } else if (text[i] === '}' || text[i] === ']') scopes.pop();
  }
  const value: unknown = JSON.parse(text);
  const stack: Array<[unknown, number]> = [[value, 0]];
  while (stack.length) {
    const [child, depth] = stack.pop()!;
    if (depth > 64 || (typeof child === 'number' && !Number.isFinite(child)) ||
      (typeof child === 'string' && !child.isWellFormed())) stop('invalid-json');
    if (child !== null && typeof child === 'object') {
      for (const [key, item] of Object.entries(child)) {
        if (!key.isWellFormed()) stop('invalid-json');
        stack.push([item, depth + 1]);
      }
    }
  }
  return value;
}

type Store = ReturnType<typeof openStore>;
function snapshot(db: Store) {
  const rows = db.query("SELECT * FROM semantic_attempts WHERE state='running' LIMIT 2").all();
  if (!rows.length) return null;
  if (rows.length !== 1) stop('lease-integrity-unknown');
  const attempt = Attempt.parse(rows[0]);
  const lane = (rows[0] as { lane?: unknown }).lane === 'document' ? 'document' as const : 'transcript' as const;
  const job = lane === 'document'
    ? db.query(`SELECT d.*,f.source_id,f.relative_path,w.ordinal,w.payload_json,w.payload_sha,w.state AS slice_state
    FROM document_jobs d JOIN document_files f ON f.key=d.file_key JOIN slices w ON w.job_id=d.id
    WHERE d.id=? AND w.id=?`).get(attempt.job_id, attempt.slice_id)
    : db.query(`SELECT j.*,s.provider,s.relative_path,w.ordinal,w.payload_json,w.payload_sha,w.state AS slice_state
    FROM jobs j JOIN sources s ON s.key=j.source_key JOIN slices w ON w.job_id=j.id
    WHERE j.id=? AND w.id=?`).get(attempt.job_id, attempt.slice_id);
  const row = z.record(z.string(), z.unknown()).parse(job);
  if (row.state !== 'pending' || row.slice_state !== 'pending') stop('slice-state-unresolved');
  return { attempt, row, lane, fingerprint: canonical({ attempt: rows[0], job }) };
}
type Snapshot = NonNullable<ReturnType<typeof snapshot>>;
type Policy = z.output<typeof WorkerPolicy>;
function checkedSlice(home: string, snap: Snapshot, policy: Policy) {
  const { row, attempt } = snap;
  const key = `${row.provider}:${row.relative_path}`.normalize('NFC').toLowerCase();
  if (snap.lane === 'transcript' && policy.excludedSources.some(s => s.normalize('NFC').toLowerCase() === key)) stop('excluded');
  const item = verifyStoredSlice({ ...row, id: attempt.slice_id, job_id: attempt.job_id });
  const rebuilt = buildSlices(snap.lane === 'document' ? checkedDocument(home, row) : checkedDialogue(home, row),
    attempt.job_id, HashSchema.parse(row.receipt_hash), policy.sliceChars);
  if (canonical(rebuilt.slices[item.index]) !== canonical(item)) stop('source-or-policy-changed');
  return item;
}

function checkedReceipt(file: NonNullable<ReturnType<typeof resultFile>>, snap: Snapshot,
  item: ReturnType<typeof checkedSlice>) {
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(file.raw);
  const value = json(text);
  // Consumer durable() writes canonical JSON plus a newline. Requiring that
  // exact encoding also rejects duplicate keys instead of trusting last-wins JSON.
  if (canonical(value) + '\n' !== text) stop('result-proof-invalid');
  const receipt = Receipt.parse(value), a = snap.attempt;
  if (receipt.attemptToken !== a.token || receipt.jobId !== a.job_id || receipt.sliceId !== a.slice_id ||
    receipt.sourceReceiptSha256 !== snap.row.receipt_hash || receipt.provider !== a.provider || receipt.reason !== a.reason ||
    receipt.reservedSeconds !== a.reserved_seconds || receipt.utcDay !== a.day ||
    (a.provider === 'claude' ? a.reason !== 'primary' : a.reason !== 'claude-quota-unavailable')) stop('result-proof-invalid');
  if (Buffer.byteLength(receipt.outputJson) > 1024 * 1024 || sha256(receipt.outputJson) !== receipt.outputSha256) stop('result-proof-invalid');
  const output = validateOutput(json(receipt.outputJson), item).result;
  if (canonical(output) !== receipt.outputJson) stop('result-proof-invalid');
  return receipt;
}

/** Recover one durable lease. No model calls, OS probes, migrations or refunds. */
export async function recover(home: string, input: WorkerPolicyInput, execute = false, probes: RecoveryProbes = unavailable) {
  try {
    const policy = WorkerPolicy.parse(input), policyFingerprint = canonical(policy);
    home = resolve(home);
    const database = join(home, 'queue.sqlite3');
    noLinks(database);
    try { if (!lstatSync(database).isFile()) return outcome('not-initialized'); }
    catch (error) { if (missing(error)) return outcome('not-initialized'); throw error; }
    let initial: Snapshot;
    {
      using db = openStore(database);
      const tables = new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name));
      if (!['semantic_attempts', 'jobs', 'sources', 'slices'].every(name => tables.has(name))) return outcome('legacy-or-uninitialized');
      const columns = new Set((db.query('PRAGMA table_info(semantic_attempts)').all() as Array<{ name: string }>).map(r => r.name));
      if (!['owner_json', 'containment_json', 'execution_phase', 'slice_id'].every(name => columns.has(name))) return outcome('legacy-unknown');
      const value = snapshot(db);
      if (!value) return outcome('idle');
      initial = value;
    }
    let owner: z.infer<typeof Owner>, containment: z.infer<typeof Containment>;
    try { owner = Owner.parse(json(initial.attempt.owner_json)); }
    catch { return outcome('owner-not-proved-ended'); }
    try {
      containment = Containment.parse(json(initial.attempt.containment_json));
      if (containment.jobName !== `Local\\ACBCorpus-${initial.attempt.token}` ||
        containment.attemptToken !== initial.attempt.token || containment.machineIdSha256 !== owner.machineIdSha256) stop('containment-unresolved');
    } catch { return outcome('containment-unresolved'); }
    const proof = async () => {
      // Fresh copies prevent a probe from mutating the descriptors being checked.
      if (await probes.ownerStatus({ ...owner }) !== 'dead') stop('owner-not-proved-ended');
      const state = await probes.containmentStatus({ ...containment });
      if (state !== 'empty' && state !== 'absent') stop('containment-unresolved');
    };
    const path = join(home, 'semantic-results', `${initial.attempt.token}.json`);
    const file = resultFile(path);
    await proof();
    let receipt: z.infer<typeof Receipt> | null = null;
    const item = checkedSlice(home, initial, policy);
    if (file) {
      if (initial.attempt.execution_phase !== 'dispatch-intent') return outcome('result-proof-invalid');
      try { receipt = checkedReceipt(file, initial, item); }
      catch { return outcome('result-proof-invalid'); }
    }
    const beforeDispatch = initial.attempt.execution_phase === 'reserved';
    const planned = receipt ? 'recoverable-result' : beforeDispatch ? 'recoverable-before-dispatch' : 'recoverable-unknown';
    if (!execute) return outcome(planned);
    await proof();
    if (canonical(WorkerPolicy.parse(input)) !== policyFingerprint) return outcome('policy-changed');
    using db = openStore(database, { readonly: false });
    return db.transaction(() => {
      const current = snapshot(db);
      if (!current || current.fingerprint !== initial.fingerprint) stop('attempt-changed');
      // Re-read inside the write transaction: a late/changed result must never
      // be downgraded to missing, and no async gap may follow the final checks.
      checkedSlice(home, current, policy);
      const latest = resultFile(path);
      if ((file === null) !== (latest === null) || (file && latest &&
        (!file.raw.equals(latest.raw) || !sameFile(file.stat, latest.stat)))) stop('result-changed');
      if (receipt && latest) checkedReceipt(latest, current, item);
      const state = receipt ? 'pending-review' : beforeDispatch ? 'interrupted-before-dispatch' : 'interrupted-unknown';
      const phase = receipt ? 'recovered-result' : beforeDispatch ? 'recovered' : 'quarantined-unknown';
      const changed = db.query(`UPDATE semantic_attempts SET state=?,execution_phase=?,finished_at=?,error=?,
        output_json=?,output_sha256=?,usage_json=?,model_elapsed_seconds=? WHERE token=? AND state='running'`)
        .run(state, phase, Date.now() / 1000, receipt ? null : beforeDispatch ? 'owner-ended-before-dispatch' : 'remote-outcome-unknown',
          receipt?.outputJson ?? null, receipt?.outputSha256 ?? null, receipt ? canonical(receipt.usage) : null,
          receipt?.modelElapsedSeconds ?? null, initial.attempt.token);
      if (changed.changes !== 1) stop('attempt-changed');
      if (!beforeDispatch) {
        const changedSlice = db.query("UPDATE slices SET state=? WHERE id=? AND job_id=? AND state='pending' AND payload_sha=?")
          .run(state, initial.attempt.slice_id, initial.attempt.job_id, HashSchema.parse(initial.row.payload_sha));
        if (changedSlice.changes !== 1) stop('slice-state-unresolved');
      }
      if (receipt && !db.query("SELECT 1 FROM slices WHERE job_id=? AND state!='pending-review' LIMIT 1").get(initial.attempt.job_id)) {
        db.query(`UPDATE ${initial.lane === 'document' ? 'document_jobs' : 'jobs'} SET state='pending-review' WHERE id=? AND state='pending'`).run(initial.attempt.job_id);
      }
      return outcome(receipt ? 'recovered-result' : beforeDispatch ? 'recovered-before-dispatch' : 'quarantined-unknown', true);
    }).immediate();
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') return outcome('busy');
    const safe = new Set(['lease-integrity-unknown', 'slice-state-unresolved', 'owner-not-proved-ended', 'containment-unresolved',
      'excluded', 'source-or-policy-changed', 'result-proof-invalid', 'result-changed', 'attempt-changed', 'policy-changed']);
    return outcome(error instanceof Error && safe.has(error.message) ? error.message : 'recovery-unresolved');
  }
}
