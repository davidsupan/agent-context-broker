import { Database } from './sqlite.mts';
import { lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BudgetRowSchema, ColumnRowsSchema, CountRowsSchema, DAILY_SECONDS,
  DailySeconds, OpenOptionsSchema, ReservationSchema, SliceRowSchema, StatusSchema, TokenSchema, UnixSecondsSchema } from './schemas.mts';
import type { ReservationInput, ReservationResult, StoreStatus } from './schemas.mts';

export { DAILY_SECONDS } from './schemas.mts';

/** Both pilot probes and corpus attempts read this same setting and ledger. */
export function dailyBudgetLimit(db: Database): number {
  if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='semantic_settings'").get()) return DAILY_SECONDS;
  const row = db.query("SELECT value FROM semantic_settings WHERE key='daily-limit-seconds'").get() as { value: string } | null;
  return row ? DailySeconds.parse(Number(row.value)) : DAILY_SECONDS;
}

export function noLinks(path: string) {
  let part = resolve(path);
  while (true) {
    try {
      if (lstatSync(part).isSymbolicLink()) throw new Error('linked-runtime-path');
    } catch (error) {
      if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}

export function openStore(path: string, options: { readonly?: boolean; create?: boolean } = {}) {
  const { readonly, create } = OpenOptionsSchema.parse(options);
  noLinks(path);
  const db = new Database(resolve(path), { readonly, create, strict: true });
  db.run('PRAGMA busy_timeout=200');
  return db;
}

export function setup(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS semantic_budget(day TEXT PRIMARY KEY, seconds INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_attempts(
      job_id TEXT, token TEXT PRIMARY KEY, state TEXT, day TEXT,
      reserved_seconds INTEGER, started_at REAL, finished_at REAL,
      error TEXT, output_json TEXT, output_sha256 TEXT, provider TEXT, reason TEXT);
    CREATE TABLE IF NOT EXISTS semantic_settings(key TEXT PRIMARY KEY, value TEXT);`);
  const columns = new Set(ColumnRowsSchema.parse(db.query('PRAGMA table_info(semantic_attempts)').all()).map(r => r.name));
  for (const [name, type] of [
    ['slice_id', 'TEXT'], ['usage_json', 'TEXT'], ['model_elapsed_seconds', 'REAL'],
    ['owner_json', 'TEXT'], ['execution_phase', 'TEXT'], ['containment_json', 'TEXT']
  ] as const) {
    if (!columns.has(name)) db.run(`ALTER TABLE semantic_attempts ADD COLUMN ${name} ${type}`);
  }
}

// The lane column is added on the first document reservation only; NULL means transcript.
function hasLane(db: Database) {
  return ColumnRowsSchema.parse(db.query('PRAGMA table_info(semantic_attempts)').all()).some(r => r.name === 'lane');
}
export function documentLaneSeconds(db: Database, day: string) {
  if (!hasLane(db)) return 0;
  const row = db.query("SELECT coalesce(sum(reserved_seconds),0) AS seconds FROM semantic_attempts WHERE day=? AND lane='document'").get(day);
  return BudgetRowSchema.parse(row).seconds;
}
/** Lane of the latest corpus attempt today; pilots are not corpus work. */
export function lastLane(db: Database, day: string): 'transcript' | 'document' | null {
  const row = db.query(`SELECT ${hasLane(db) ? 'lane' : 'NULL AS lane'} FROM semantic_attempts WHERE day=?
    AND reason IN ('primary','claude-quota-unavailable') ORDER BY started_at DESC,rowid DESC LIMIT 1`).get(day) as { lane: unknown } | null;
  return row === null ? null : row.lane === 'document' ? 'document' : 'transcript';
}
export function utcDay(now: number) { return moment(now).day; }

function moment(now: number) {
  UnixSecondsSchema.parse(now);
  const date = new Date(now * 1000);
  if (!Number.isFinite(date.getTime())) throw new Error('invalid-time');
  return { day: date.toISOString().slice(0, 10), secondsLeft: 86400 - now % 86400 };
}

export function reserve(db: Database, input: ReservationInput): ReservationResult {
  const { jobId, sliceId, payloadSha, sourceReceiptSha, owner, containment,
    claudeAvailable = false, codexAvailable = false, claudeUnavailableReason,
    seconds, now, lane, laneCapSeconds } = ReservationSchema.parse(input);
  const { day, secondsLeft } = moment(now);
  if (secondsLeft < seconds) return { state: 'paused-day-boundary', invoked: false };
  // The transaction is shared with the old schema, so two runtimes cannot reserve
  // independent budgets or workers. Production runners must stop using the old one.
  const transaction = db.transaction((): ReservationResult => {
    if (db.query("SELECT 1 FROM semantic_attempts WHERE state='running' LIMIT 1").get()) {
      return { state: 'leased', invoked: false };
    }
    const quota = claudeUnavailableReason === 'quota-unavailable' ||
      Boolean(db.query("SELECT 1 FROM semantic_settings WHERE key='quota-paused'").get());
    if (quota && !codexAvailable) return { state: 'paused-quota', invoked: false };
    if (!quota && !claudeAvailable) return { state: 'paused-unavailable', invoked: false };
    const provider = quota ? 'codex' : 'claude';
    const reason = quota ? 'claude-quota-unavailable' : 'primary';
    const budget = db.query('SELECT seconds FROM semantic_budget WHERE day=?').get(day);
    const used = budget === null ? 0 : BudgetRowSchema.parse(budget).seconds;
    if (used + seconds > dailyBudgetLimit(db)) return { state: 'paused-budget', invoked: false };
    if (lane === 'document') {
      // The lane cap is checked under the same lock as the global budget, never before it.
      if (!hasLane(db)) db.run('ALTER TABLE semantic_attempts ADD COLUMN lane TEXT');
      if (documentLaneSeconds(db, day) + seconds > laneCapSeconds) return { state: 'paused-lane-budget', invoked: false };
    }
    const row = lane === 'document'
      ? db.query(`SELECT w.payload_sha,d.receipt_hash FROM slices w JOIN document_jobs d ON d.id=w.job_id
      WHERE w.id=? AND w.job_id=? AND w.state='pending' AND d.state='pending'`).get(sliceId, jobId)
      : db.query(`SELECT w.payload_sha,j.receipt_hash FROM slices w JOIN jobs j ON j.id=w.job_id
      WHERE w.id=? AND w.job_id=? AND w.state='pending' AND j.state='pending'`).get(sliceId, jobId);
    const slice = row === null ? null : SliceRowSchema.parse(row);
    if (!slice || slice.payload_sha !== payloadSha || slice.receipt_hash !== sourceReceiptSha) {
      return { state: 'source-state-changed', invoked: false };
    }
    const token = randomBytes(16).toString('hex');
    // Null legacy ownership never grants automatic recovery. OS-specific identity
    // and containment validation belongs to the transport before dispatch.
    db.query(`INSERT INTO semantic_attempts(job_id,token,state,day,reserved_seconds,started_at,
      provider,reason,slice_id,owner_json,execution_phase,containment_json)
      VALUES(?,?,'running',?,?,?,?,?,?,?,'reserved',?)`).run(
      jobId, token, day, seconds, now, provider, reason, sliceId,
      JSON.stringify(owner ?? null), JSON.stringify(containment ?? null));
    if (lane === 'document') db.query("UPDATE semantic_attempts SET lane='document' WHERE token=?").run(token);
    db.query(`INSERT INTO semantic_budget(day,seconds) VALUES(?,?)
      ON CONFLICT(day) DO UPDATE SET seconds=seconds+excluded.seconds`).run(day, seconds);
    return { state: 'reserved', token, provider, reason, reservedSeconds: seconds, utcDay: day, invoked: false };
  });
  try {
    return transaction.immediate();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'SQLITE_BUSY') {
      return { state: 'busy', invoked: false };
    }
    throw error;
  }
}

export function markDispatch(db: Database, token: string) {
  TokenSchema.parse(token);
  const changed = db.query(`UPDATE semantic_attempts SET execution_phase='dispatch-intent'
    WHERE token=? AND state='running' AND execution_phase='reserved'`).run(token);
  if (changed.changes !== 1) throw new Error('dispatch-ownership-changed');
}

export function status(db: Database, now = Date.now() / 1000): StoreStatus {
  const { day } = moment(now);
  const tables = new Set(ColumnRowsSchema.parse(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).map(r => r.name));
  const result: StoreStatus = { schemaVersion: 1, runtime: 'bun', utcDay: day, dailyLimitSeconds: dailyBudgetLimit(db),
    reservedSeconds: 0, fullyCurrent: false, productionEnabled: false,
    acceptedState: 'not-observed',
    boundary: 'Queue metadata only; not live-source, model or broker verification' };
  if (tables.has('sources')) result.sourcesByState = Object.fromEntries(
    CountRowsSchema.parse(db.query('SELECT state,count(*) AS n FROM sources GROUP BY state').all()).map(r => [r.state, r.n]));
  if (tables.has('jobs')) result.jobsByState = Object.fromEntries(
    CountRowsSchema.parse(db.query('SELECT state,count(*) AS n FROM jobs GROUP BY state').all()).map(r => [r.state, r.n]));
  if (tables.has('jobs') && ColumnRowsSchema.parse(db.query('PRAGMA table_info(jobs)').all()).some(r => r.name === 'created_at')) {
    const row = db.query("SELECT min(created_at) AS oldest FROM jobs WHERE state='pending'").get() as { oldest: unknown };
    result.oldestPendingAt = row.oldest === null ? null : UnixSecondsSchema.parse(row.oldest);
  }
  if (tables.has('slices')) result.slicesByState = Object.fromEntries(
    CountRowsSchema.parse(db.query('SELECT state,count(*) AS n FROM slices GROUP BY state').all()).map(r => [r.state, r.n]));
  if (tables.has('broker_publications')) result.brokerPublicationsByState = Object.fromEntries(
    CountRowsSchema.parse(db.query('SELECT state,count(*) AS n FROM broker_publications GROUP BY state').all()).map(r => [r.state, r.n]));
  if (tables.has('semantic_budget')) {
    const row = db.query('SELECT seconds FROM semantic_budget WHERE day=?').get(day);
    result.reservedSeconds = row === null ? 0 : BudgetRowSchema.parse(row).seconds;
  }
  if (tables.has('semantic_attempts')) result.attemptsByState = Object.fromEntries(
    CountRowsSchema.parse(db.query('SELECT state,count(*) AS n FROM semantic_attempts GROUP BY state').all()).map(r => [r.state, r.n]));
  return StatusSchema.parse(result);
}
