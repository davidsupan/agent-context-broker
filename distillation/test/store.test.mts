import { test, expect, beforeEach, afterEach } from './expect.mts';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, setup, reserve, markDispatch, status } from '../src/store.mts';
import type { Database } from '../src/sqlite.mts';

let root: string, path: string, db: Database;
const payload = 'a'.repeat(64), receipt = 'b'.repeat(64);
const now = Date.parse('2026-09-18T12:00:00Z') / 1000;
const input = { jobId: 'j', sliceId: 's', payloadSha: payload, sourceReceiptSha: receipt,
  claudeAvailable: true, seconds: 300, now };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bun-corpus-'));
  path = join(root, 'queue.sqlite3');
  db = openStore(path, { readonly: false, create: true });
  setup(db);
  db.run(`CREATE TABLE jobs(id TEXT PRIMARY KEY,state TEXT,receipt_hash TEXT);
    CREATE TABLE slices(id TEXT PRIMARY KEY,job_id TEXT,state TEXT,payload_sha TEXT);
    INSERT INTO jobs VALUES('j','pending','${receipt}');
    INSERT INTO slices VALUES('s','j','pending','${payload}');`);
});
afterEach(() => { db.close(); rmSync(root, { recursive: true, force: true }); });

test('reservation persists across reopen and shares the global lease', () => {
  expect(reserve(db, input)).toMatchObject({ state: 'reserved', provider: 'claude' });
  db.close(); db = openStore(path, { readonly: false });
  expect(reserve(db, { ...input, codexAvailable: true, claudeUnavailableReason: 'quota-unavailable' }).state).toBe('leased');
  expect(status(db, now).reservedSeconds).toBe(300);
});

test('both providers consume one persistent 1800-second allowance', () => {
  for (let i = 0; i < 6; i++) {
    const result = reserve(db, { ...input, codexAvailable: true,
      claudeUnavailableReason: i % 2 ? 'quota-unavailable' : undefined });
    if (!('token' in result)) throw new Error('expected reservation');
    expect(result.provider).toBe(i % 2 ? 'codex' : 'claude');
    db.query("UPDATE semantic_attempts SET state='failed' WHERE token=?").run(result.token);
  }
  expect(reserve(db, input).state).toBe('paused-budget');
  expect(status(db, now).reservedSeconds).toBe(1800);
});

test('unknown unavailability does not authorize fallback', () => {
  expect(reserve(db, { ...input, claudeAvailable: false, codexAvailable: true,
    claudeUnavailableReason: 'network-error' }).state).toBe('paused-unavailable');
  expect(status(db, now).reservedSeconds).toBe(0);
});

test('recorded quota pause permits only the explicit fallback', () => {
  db.run("INSERT INTO semantic_settings VALUES('quota-paused','true')");
  expect(reserve(db, input).state).toBe('paused-quota');
  expect(reserve(db, { ...input, codexAvailable: true })).toMatchObject({ state: 'reserved', provider: 'codex' });
});

test('UTC boundary rejects work that cannot fit before midnight', () => {
  expect(reserve(db, { ...input, now: Date.parse('2026-09-18T23:59:00Z')/1000 }).state).toBe('paused-day-boundary');
  expect(status(db, now).reservedSeconds).toBe(0);
});

test('changed slice/source cannot consume a reservation', () => {
  expect(reserve(db, { ...input, sourceReceiptSha: 'c'.repeat(64) }).state).toBe('source-state-changed');
  expect(reserve(db, { ...input, payloadSha: 'c'.repeat(64) }).state).toBe('source-state-changed');
  expect(status(db, now).reservedSeconds).toBe(0);
});

test('dispatch intent requires the exact reserved token and cannot repeat', () => {
  const result = reserve(db, input);
  if (!('token' in result)) throw new Error('expected reservation');
  markDispatch(db, result.token);
  expect(() => markDispatch(db, result.token)).toThrow('dispatch-ownership-changed');
  expect(reserve(db, input).state).toBe('leased');
});

test('read-only status does not modify the database', () => {
  db.close();
  const before = readFileSync(path);
  db = openStore(path);
  expect(status(db, now).productionEnabled).toBe(false);
  expect(() => reserve(db, input)).toThrow();
  expect(readFileSync(path)).toEqual(before);
});

test('separate connection lock returns busy without spending budget', () => {
  using other = openStore(path, { readonly: false });
  other.run('BEGIN IMMEDIATE');
  expect(reserve(db, input).state).toBe('busy');
  other.run('ROLLBACK');
  expect(status(db, now).reservedSeconds).toBe(0);
});
