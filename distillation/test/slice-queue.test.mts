import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/sqlite.mts';
import { runCapture, sha256 } from '../src/capture.mts';
import { prepareSlices, checkedDialogue, verifyStoredSlice } from '../src/slice-queue.mts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup(text = 'A durable decision about tests') {
  const root = mkdtempSync(join(tmpdir(), 'acb-queue-')); dirs.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
  const path = join(root, 'registry.json'); writeFileSync(path, registry);
  writeFileSync(join(source, 'a.jsonl'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n');
  runCapture({ providerRoots: { codex: source }, historyRegistry: { path, sha256: sha256(registry) }, reserveBytes: 1 }, home, true);
  return { root, source, home };
}
function withDb<T>(home: string, fn: (db: Database) => T): T {
  const db = new Database(join(home, 'queue.sqlite3')); try { return fn(db); } finally { db.close(); }
}
function job(home: string) {
  return withDb(home, db => db.query('SELECT j.*,s.provider,s.relative_path FROM jobs j JOIN sources s ON j.source_key=s.key').get()) as Record<string, unknown>;
}
test('plan is read-only; prepare redacts before persisting and restart is idle', () => {
  const f = setup('Never publish password=synthetic-fixture-credential');
  expect(prepareSlices(f.home)).toEqual({ state: 'plan', writes: false });
  expect(prepareSlices(f.home, [], 16000, true)).toMatchObject({ state: 'prepared', slices: 1, accepted: false });
  expect(prepareSlices(f.home, [], 16000, true)).toMatchObject({ state: 'idle' });
  const stored = withDb(f.home, db => db.query('SELECT * FROM slices').get()) as Record<string, unknown>;
  expect(String(stored.payload_json)).not.toContain('synthetic-fixture-credential');
  expect(verifyStoredSlice(stored).segments).toHaveLength(1);
});
test('source provenance is regenerated, not trusted from matching receipt hashes', () => {
  const f = setup(); const j = job(f.home);
  const path = join(f.home, String(j.generation), 'dialogue.private.jsonl');
  const row = JSON.parse(readFileSync(path, 'utf8'));
  row.text = 'invented'; const body = JSON.stringify(row) + '\n'; writeFileSync(path, body);
  const rp = join(f.home, String(j.generation), 'receipt.json');
  const receipt = JSON.parse(readFileSync(rp, 'utf8')); receipt.dialogueSha256 = sha256(body);
  const encoded = JSON.stringify(receipt) + '\n'; writeFileSync(rp, encoded);
  withDb(f.home, db => db.query('UPDATE jobs SET receipt_hash=?').run(sha256(encoded)));
  expect(() => checkedDialogue(f.home, job(f.home))).toThrow('dialogue-provenance');
  expect(prepareSlices(f.home, [], 16000, true)).toMatchObject({ state: 'blocked', accepted: false });
});
test('excluded source cannot be prepared', () => {
  const f = setup(); expect(prepareSlices(f.home, ['codex:a.jsonl'], 16000, true)).toMatchObject({ state: 'idle' });
});
test('missing slices are an integrity failure rather than a completed plan', () => {
  const f = setup(); prepareSlices(f.home, [], 16000, true);
  withDb(f.home, db => db.run('DELETE FROM slices'));
  expect(() => prepareSlices(f.home, [], 16000, true)).toThrow('slice-plan-integrity');
});
test('stored payload mutation is rejected even when its payload hash is refreshed', () => {
  const f = setup(); prepareSlices(f.home, [], 16000, true);
  const stored = withDb(f.home, db => db.query('SELECT * FROM slices').get()) as Record<string, unknown>;
  const item = JSON.parse(String(stored.payload_json)); item.index = 42;
  expect(() => verifyStoredSlice({ ...stored, payload_json: JSON.stringify(item) })).toThrow('slice-payload-integrity');
});
