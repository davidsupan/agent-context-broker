import { sha256Hasher } from './platform.mts';
import { closeSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { sha256, verifyGeneration } from './capture.mts';
import { buildSlices, canonical, digest } from './slicing.mts';
import { noLinks, openStore } from './store.mts';
import { HashSchema } from './schemas.mts';
import { parseEvent } from './transcript.mts';
import { SliceSchema } from './output.mts';

const Job = z.object({ id: HashSchema, source_key: HashSchema, start_byte: z.number().int().nonnegative(),
  end_byte: z.number().int().nonnegative(), generation: z.string(), receipt_hash: HashSchema,
  provider: z.enum(['codex', 'claude-code']), relative_path: z.string(), state: z.literal('pending') });
export type PendingJob = z.infer<typeof Job>;

function* lines(path: string, maxBytes: number, maxLine: number) {
  noLinks(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.size > BigInt(maxBytes)) throw new Error('artifact-limit');
  const fd = openSync(path, 'r');
  const block = Buffer.alloc(65536);
  let pending: Buffer = Buffer.alloc(0), total = 0;
  try {
    while (true) {
      const n = readSync(fd, block, 0, block.length, total);
      if (!n) break;
      total += n;
      if (total > maxBytes) throw new Error('artifact-limit');
      pending = Buffer.concat([pending, block.subarray(0, n)]);
      let pos: number;
      while ((pos = pending.indexOf(10)) >= 0) {
        if (pos + 1 > maxLine) throw new Error('line-limit');
        yield pending.subarray(0, pos + 1);
        pending = pending.subarray(pos + 1);
      }
      if (pending.length > maxLine) throw new Error('line-limit');
    }
    if (pending.length) throw new Error('incomplete-artifact');
    noLinks(path);
    const after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== before.size) throw new Error('artifact-changed');
  } finally { closeSync(fd); }
}

export function checkedDialogue(home: string, value: unknown) {
  const job = Job.parse(value);
  const receipt = verifyGeneration(home, job.generation, job.receipt_hash);
  if (receipt.sourceKey !== job.source_key || receipt.provider !== job.provider || receipt.relativePath !== job.relative_path ||
    receipt.startByte !== job.start_byte || receipt.endByte !== job.end_byte || receipt.semanticState !== 'pending') throw new Error('receipt-identity');
  const directory = join(home, job.generation);
  const rawHash = sha256Hasher(), bodyHash = sha256Hasher();
  const body = lines(join(directory, 'dialogue.private.jsonl'), 64 * 1024 ** 2, 32 * 1024 ** 2);
  const rows = [];
  let offset = job.start_byte;
  try {
    for (const line of lines(join(directory, 'raw.private.jsonl'), 8 * 1024 ** 2, 4 * 1024 ** 2)) {
      rawHash.update(line);
      const event = parseEvent(line, job.provider);
      for (const text of event.texts) {
        const next = body.next();
        if (next.done) throw new Error('dialogue-provenance');
        bodyHash.update(next.value);
        const actual: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(next.value));
        const expected = { source: { provider: job.provider, relativePath: job.relative_path,
          startByte: offset, endByte: offset + line.length, eventSha256: sha256(line), pointer: text.pointer }, role: event.role, text: text.text };
        if (canonical(actual) !== canonical(expected)) throw new Error('dialogue-provenance');
        rows.push(expected);
        if (rows.length > 32768) throw new Error('dialogue-block-limit');
      }
      offset += line.length;
    }
    if (!body.next().done || !rows.length || rows.length !== receipt.dialogueBlocks || offset !== job.end_byte ||
      rawHash.digest('hex') !== receipt.rawSha256 || bodyHash.digest('hex') !== receipt.dialogueSha256) throw new Error('dialogue-provenance');
  } finally { body.return(); }
  return rows;
}

export function verifyStoredSlice(value: unknown) {
  const row = z.object({ id: HashSchema, job_id: HashSchema, ordinal: z.number().int().nonnegative(),
    payload_json: z.string(), payload_sha: HashSchema }).parse(value);
  const item = SliceSchema.parse(JSON.parse(row.payload_json));
  const { sliceId, ...unsigned } = item;
  if (digest(item) !== row.payload_sha || digest(unsigned) !== sliceId || sliceId !== row.id ||
    item.jobId !== row.job_id || item.index !== row.ordinal) throw new Error('slice-payload-integrity');
  return item;
}

export function prepareSlices(home: string, excludedSources: string[] = [], maxChars = 16000, execute = false) {
  if (!execute) return { state: 'plan', writes: false };
  const excluded = new Set(excludedSources.map(s => s.normalize('NFC').toLowerCase()));
  using db = openStore(join(home, 'queue.sqlite3'), { readonly: false });
  db.run(`CREATE TABLE IF NOT EXISTS slice_plans(job_id TEXT PRIMARY KEY,plan_sha TEXT,version INTEGER,slice_count INTEGER,created_at REAL);
    CREATE TABLE IF NOT EXISTS slices(id TEXT PRIMARY KEY,job_id TEXT,ordinal INTEGER,payload_json TEXT,payload_sha TEXT,state TEXT,UNIQUE(job_id,ordinal));
    CREATE TABLE IF NOT EXISTS slice_failures(job_id TEXT PRIMARY KEY,code TEXT,at REAL);`);
  const broken = db.query(`SELECT p.job_id FROM slice_plans p LEFT JOIN slices s ON p.job_id=s.job_id
    GROUP BY p.job_id HAVING count(s.id)!=p.slice_count OR min(s.ordinal)!=0 OR max(s.ordinal)!=p.slice_count-1 LIMIT 1`).get();
  if (broken) throw new Error('slice-plan-integrity');
  let job: PendingJob | undefined;
  // Iteration is bounded by metadata, not by loading the whole source corpus.
  const selection = db.prepare(`SELECT j.*,s.provider,s.relative_path FROM jobs j JOIN sources s ON j.source_key=s.key
    WHERE j.state='pending' AND NOT EXISTS(SELECT 1 FROM slice_plans p WHERE p.job_id=j.id)
    AND NOT EXISTS(SELECT 1 FROM slice_failures f WHERE f.job_id=j.id) ORDER BY j.created_at,j.id`);
  try {
    for (const row of selection.iterate()) {
      const candidate = Job.parse(row);
      if (!excluded.has(`${candidate.provider}:${candidate.relative_path}`.normalize('NFC').toLowerCase())) { job = candidate; break; }
    }
  } finally { selection.finalize(); }
  if (!job) return { state: 'idle', writes: false };
  try {
    const plan = buildSlices(checkedDialogue(home, job), job.id, job.receipt_hash, maxChars);
    return db.transaction(() => {
      const current = db.query('SELECT receipt_hash,state FROM jobs WHERE id=?').get(job!.id);
      const checked = z.object({ receipt_hash: HashSchema, state: z.string() }).parse(current);
      if (checked.receipt_hash !== job!.receipt_hash || checked.state !== 'pending') throw new Error('source-job-changed');
      const existing = db.query('SELECT plan_sha FROM slice_plans WHERE job_id=?').get(job!.id);
      if (existing) {
        if (z.object({ plan_sha: HashSchema }).parse(existing).plan_sha !== plan.planSha256) throw new Error('slice-plan-conflict');
        return { state: 'already-planned', writes: false };
      }
      for (const item of plan.slices) db.query('INSERT INTO slices VALUES(?,?,?,?,?,?)').run(item.sliceId, job!.id, item.index, canonical(item), digest(item), 'pending');
      db.query('INSERT INTO slice_plans VALUES(?,?,?,?,?)').run(job!.id, plan.planSha256, 1, plan.sliceCount, Date.now() / 1000);
      return { state: 'prepared', jobId: job!.id, slices: plan.sliceCount, accepted: false, redactionKinds: plan.redactionKinds };
    }).immediate();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') return { state: 'busy', writes: false };
    db.query('INSERT OR IGNORE INTO slice_failures VALUES(?,?,?)').run(job.id, 'preparation-blocked', Date.now() / 1000);
    return { state: 'blocked', jobId: job.id, code: 'preparation-blocked', accepted: false };
  }
}
