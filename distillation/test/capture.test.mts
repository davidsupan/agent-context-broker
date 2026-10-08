import { afterEach, expect, spyOn, test } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, existsSync, readFileSync, renameSync, statSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from '../src/sqlite.mts';
import { hooks, runCapture, sha256, verifyGeneration } from '../src/capture.mts';
import { windowsFileIdentity } from '../src/windows-file-identity.mts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(legacy: string[] = []) {
  const root = mkdtempSync(join(tmpdir(), 'acb-capture-')); roots.push(root);
  const source = join(root, 'source'), home = join(root, 'home'); mkdirSync(source);
  const registryPath = join(root, 'history.json');
  const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.',
    entries: legacy.map(relativePath => ({ provider: 'codex', relativePath, key: `codex:${relativePath}`, classification: 'legacy-unresolved' })) });
  writeFileSync(registryPath, registry);
  const config = { providerRoots: { codex: source }, historyRegistry: { path: registryPath, sha256: sha256(registry) }, reserveBytes: 1, retrySeconds: 1 };
  return { root, source, home, config };
}
function turn(text: string) { return JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'; }
function rows(home: string, table: string) {
  const db = new Database(join(home, 'queue.sqlite3'), { readonly: true });
  try { return db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]; } finally { db.close(); }
}
test('capture plan validates pinned history without creating queue', () => {
  const f = fixture(); expect(runCapture(f.config, f.home)).toMatchObject({ mode: 'plan', writes: false }); expect(existsSync(f.home)).toBe(false);
});

(process.platform !== 'win32' ? test.skip : test)('Python full-volume identities resume without truncating identity evidence', () => {
  const f = fixture(); const path = join(f.source, 'a.jsonl');
  writeFileSync(path, turn('first')); runCapture(f.config, f.home, true);
  const [prefix, volume, id] = windowsFileIdentity(path).split(':');
  expect(prefix).toBe('win');
  using db = new Database(join(f.home, 'queue.sqlite3'));
  db.query('UPDATE sources SET identity=?').run(`[${volume}, ${id}]`);
  appendFileSync(path, turn('second'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(2);
  expect(rows(f.home, 'sources')[0]!.identity).toBe(windowsFileIdentity(path));
  db.query('UPDATE sources SET identity=?').run(`[${BigInt(volume!) + (1n << 32n)}, ${id}]`);
  appendFileSync(path, turn('third'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 1 });
  expect(rows(f.home, 'jobs')).toHaveLength(2);
  expect(rows(f.home, 'sources')[0]!.error).toBe('source-replaced');
});

(process.platform !== 'win32' ? test.skip : test)('idle verification upgrades old Bun identity without another job', () => {
  const f = fixture(); const path = join(f.source, 'a.jsonl');
  writeFileSync(path, turn('first')); runCapture(f.config, f.home, true);
  const stat = statSync(path, { bigint: true });
  using db = new Database(join(f.home, 'queue.sqlite3'));
  db.query('UPDATE sources SET identity=?').run(`${stat.dev}:${stat.ino}`);
  const before = rows(f.home, 'sources')[0]!;
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'sources')[0]).toMatchObject({ identity: windowsFileIdentity(path), offset: before.offset, prefix_hash: before.prefix_hash });
  expect(rows(f.home, 'jobs')).toHaveLength(1);
});
test('capture append and restart produce nonoverlapping immutable generations', () => {
  const f = fixture(); const path = join(f.source, 'a.jsonl'); const first = turn('one'); writeFileSync(path, first);
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(1);
  appendFileSync(path, turn('two'));
  runCapture(f.config, f.home, true);
  const jobs = rows(f.home, 'jobs'); expect(jobs).toHaveLength(2); expect(jobs[1]!.start_byte).toBe(Buffer.byteLength(first));
  for (const job of jobs) expect(verifyGeneration(f.home, String(job.generation), String(job.receipt_hash)).semanticState).toBe('pending');
});
test('incomplete tail is never granted a checkpoint', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one') + '{'); runCapture(f.config, f.home, true);
  expect(rows(f.home, 'sources')[0]).toMatchObject({ state: 'pending-tail', offset: Buffer.byteLength(turn('one')) });
});
test('source rewrite and truncation fail without advancing', () => {
  for (const changed of [turn('bad'), '']) {
    const f = fixture(); const path = join(f.source, 'a.jsonl'); writeFileSync(path, turn('one')); runCapture(f.config, f.home, true);
    const before = rows(f.home, 'sources')[0]!.offset; writeFileSync(path, changed); runCapture(f.config, f.home, true);
    expect(rows(f.home, 'sources')[0]).toMatchObject({ state: 'failed', offset: before }); expect(rows(f.home, 'jobs')).toHaveLength(1);
  }
});
test('known legacy membership without cutoff blocks only that source', () => {
  const f = fixture(['old.jsonl']); writeFileSync(join(f.source, 'old.jsonl'), turn('old')); writeFileSync(join(f.source, 'new.jsonl'), turn('new'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ legacyUnresolved: 1, errors: 0 }); expect(rows(f.home, 'jobs')).toHaveLength(1);
});
test('wrong registry pin blocks before creating queue', () => {
  const f = fixture(); expect(() => runCapture({ ...f.config, historyRegistry: { ...f.config.historyRegistry, sha256: '0'.repeat(64) } }, f.home, true)).toThrow('registry-integrity'); expect(existsSync(f.home)).toBe(false);
});
test('invalid event never advances or echoes source content', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), '{"type":"private-unknown-secret-content"}\n');
  const result = runCapture(f.config, f.home, true); expect(result).toMatchObject({ errors: 1 }); expect(rows(f.home, 'sources')[0]!.offset).toBe(0); expect(JSON.stringify(rows(f.home, 'events'))).not.toContain('secret-content');
});
test('committed generation corruption blocks subsequent capture', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one')); runCapture(f.config, f.home, true);
  const job = rows(f.home, 'jobs')[0]!; writeFileSync(join(f.home, String(job.generation), 'dialogue.private.jsonl'), 'tampered');
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 1 }); expect(rows(f.home, 'jobs')).toHaveLength(1);
});
test('file budget uses persisted directory cursor to reach later files', () => {
  const f = fixture(); for (const name of ['a','b','c']) writeFileSync(join(f.source, `${name}.jsonl`), turn(name));
  for (let i = 0; i < 3; i++) runCapture({ ...f.config, maxFiles: 1 }, f.home, true);
  expect(rows(f.home, 'jobs')).toHaveLength(3);
});
test('exact exclusions are skipped and no roots may overlap', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), 'not json');
  expect(runCapture({ ...f.config, excludedSources: ['codex:a.jsonl'] }, f.home, true)).toMatchObject({ processed: 0 });
  expect(rows(f.home, 'sources')).toHaveLength(0);
  expect(() => runCapture(f.config, join(f.source, 'runtime'), true)).toThrow('invalid-root-boundary');
});
test('orphan generation is verified and reused after database rollback', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one')); runCapture(f.config, f.home, true);
  const first = rows(f.home, 'jobs')[0]!; const receipt = readFileSync(join(f.home, String(first.generation), 'receipt.json'));
  const db = new Database(join(f.home, 'queue.sqlite3')); db.run('DELETE FROM jobs; DELETE FROM sources; DELETE FROM scan_dirs'); db.close();
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')[0]!.receipt_hash).toBe(first.receipt_hash);
  expect(readFileSync(join(f.home, String(first.generation), 'receipt.json')).equals(receipt)).toBe(true);
});

// Hooks only observe synthetic hashing in this process; no filesystem or module
// mocks leak into other workers/tests, and every hook is restored in finally.
function onHash(action: (text: string) => void) {
  const original = hooks.sha256Hasher;
  return spyOn(hooks, 'sha256Hasher').mockImplementation(() => {
    const hasher = original();
    return {
      update(input: string | Uint8Array) {
        hasher.update(input);
        action(typeof input === 'string' ? input : Buffer.from(input).toString('utf8'));
        return this;
      },
      digest(encoding: 'hex') { return hasher.digest(encoding); },
    };
  });
}

test('case-only source alias is rejected without rewriting keys or duplicating jobs', () => {
  const f = fixture(); const original = join(f.source, 'a.jsonl');
  writeFileSync(original, turn('one')); runCapture(f.config, f.home, true);
  const sources = rows(f.home, 'sources'), jobs = rows(f.home, 'jobs');
  renameSync(original, join(f.source, 'A.jsonl'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 1, state: 'partial' });
  expect(rows(f.home, 'sources')).toEqual(sources);
  expect(rows(f.home, 'jobs')).toEqual(jobs);
  expect(rows(f.home, 'events').at(-1)).toMatchObject({ kind: 'failed', detail: 'source-case-alias' });
  const diagnostic = JSON.stringify(rows(f.home, 'events'));
  expect(diagnostic).not.toContain(f.source);
  expect(diagnostic).not.toContain('A.jsonl');
  renameSync(join(f.source, 'A.jsonl'), original);
  appendFileSync(original, turn('two'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(2);
  expect(rows(f.home, 'jobs')[1]!.start_byte).toBe(Buffer.byteLength(turn('one')));
});

test('vanished queued directory records a safe failure without rolling back healthy siblings', () => {
  const f = fixture(); mkdirSync(join(f.source, 'a')); writeFileSync(join(f.source, 'z.jsonl'), turn('one'));
  runCapture({ ...f.config, maxDiscovered: 1 }, f.home, true);
  expect(rows(f.home, 'scan_dirs').some(row => row.relative === 'a')).toBe(true);
  renameSync(join(f.source, 'a'), join(f.source, 'b'));
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 1, state: 'partial' });
  expect(rows(f.home, 'jobs')).toHaveLength(1);
  expect(rows(f.home, 'scan_dirs')).toHaveLength(0);
  const failures = rows(f.home, 'events').filter(row => row.kind === 'failed');
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ detail: 'directory-vanished' });
  expect(JSON.stringify(failures)).not.toContain(f.root);
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(1);
});

test('artifact verification rejects append, same-size rewrite and path replacement during reading', { timeout: 30000 }, () => {
  for (const name of ['receipt.json', 'raw.private.jsonl', 'dialogue.private.jsonl']) {
    for (const change of ['append', 'rewrite', 'replace']) {
      const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one'));
      runCapture(f.config, f.home, true);
      const job = rows(f.home, 'jobs')[0]!;
      const path = join(f.home, String(job.generation), name);
      const bytes = readFileSync(path), before = statSync(path);
      let injected = false;
      const hook = onHash(text => {
        if (injected || text !== bytes.toString('utf8')) return;
        injected = true;
        if (change === 'append') appendFileSync(path, 'PRIVATE_SENTINEL\n');
        else if (change === 'rewrite') {
          const altered = Buffer.from(bytes); altered[0] = 32;
          writeFileSync(path, altered);
          utimesSync(path, before.atime, before.mtime);
        } else {
          renameSync(path, path + '.old');
          writeFileSync(path, bytes);
        }
      });
      try {
        expect(() => verifyGeneration(f.home, String(job.generation), String(job.receipt_hash)))
          .toThrow(new Error('generation-integrity'));
        expect(injected).toBe(true);
      } finally { hook.mockRestore(); }
    }
  }
});

test('deadline after publication keeps earlier jobs but grants nothing for the unfinished source', () => {
  const f = fixture();
  for (const name of ['a', 'b']) writeFileSync(join(f.source, `${name}.jsonl`), turn(name));
  let now = 0, expired = false;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const hook = onHash(text => {
    if (text.includes('"relativePath":"b.jsonl"') && text.includes('"state":"extracted"')) {
      expired = true; now = 2000;
    }
  });
  try {
    expect(runCapture({ ...f.config, maxSeconds: 1 }, f.home, true)).toMatchObject({ state: 'partial', errors: 0 });
  } finally { hook.mockRestore(); clock.mockRestore(); }
  expect(expired).toBe(true);
  expect(rows(f.home, 'jobs')).toHaveLength(1);
  expect(rows(f.home, 'sources')).toHaveLength(1);
  expect(rows(f.home, 'sources')[0]).toMatchObject({ relative_path: 'a.jsonl', offset: Buffer.byteLength(turn('a')) });
  expect(rows(f.home, 'scan_dirs')[0]).toMatchObject({ after_name: 'a.jsonl' });
  expect(readdirSync(join(f.home, 'generations'))).toHaveLength(2);
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(2);
  expect(rows(f.home, 'sources')).toHaveLength(2);
});

test('deadline during append extraction leaves the existing checkpoint and retry state unchanged', () => {
  const f = fixture(); const path = join(f.source, 'a.jsonl'); writeFileSync(path, turn('one'));
  runCapture(f.config, f.home, true);
  const before = rows(f.home, 'sources'), jobs = rows(f.home, 'jobs');
  const delta = turn('two'); appendFileSync(path, delta);
  let now = 0, hashes = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const hook = onHash(text => { if (text === delta && ++hashes === 4) now = 2000; });
  try {
    expect(runCapture({ ...f.config, maxSeconds: 1 }, f.home, true)).toMatchObject({ state: 'partial', errors: 0 });
  } finally { hook.mockRestore(); clock.mockRestore(); }
  expect(hashes).toBe(4);
  expect(rows(f.home, 'sources')).toEqual(before);
  expect(rows(f.home, 'jobs')).toEqual(jobs);
  expect(rows(f.home, 'scan_dirs')[0]).toMatchObject({ after_name: '' });
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  expect(rows(f.home, 'jobs')).toHaveLength(2);
});

test('event hashing is constant per line rather than per dialogue block', () => {
  const counts: number[] = [];
  for (const count of [1, 1000]) {
    const f = fixture();
    const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user',
      content: Array.from({ length: count }, () => ({ type: 'input_text', text: 'synthetic' })) } }) + '\n';
    writeFileSync(join(f.source, 'a.jsonl'), line);
    let hashes = 0;
    const hook = onHash(text => { if (text === line) hashes++; });
    try { expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 }); }
    finally { hook.mockRestore(); }
    counts.push(hashes);
    const job = rows(f.home, 'jobs')[0]!;
    expect(verifyGeneration(f.home, String(job.generation), String(job.receipt_hash)).dialogueBlocks).toBe(count);
    const dialogue = readFileSync(join(f.home, String(job.generation), 'dialogue.private.jsonl'), 'utf8')
      .trimEnd().split('\n').map(line => JSON.parse(line));
    expect(new Set(dialogue.map(row => row.source.eventSha256))).toEqual(new Set([sha256(line)]));
  }
  expect(counts[0]).toBeGreaterThan(0);
  expect(counts[1]).toBe(counts[0]);
  expect(counts[1]).toBeLessThan(12);
});

test('root and registry errors expose stable codes, not paths or raw data', () => {
  const f = fixture();
  expect(() => runCapture({ ...f.config, providerRoots: { codex: join(f.root, 'PRIVATE_SOURCE_PATH') } }, f.home))
    .toThrow(new Error('provider-root-invalid-or-unreadable'));
  const content = '{"PRIVATE_RAW_SENTINEL":';
  writeFileSync(f.config.historyRegistry.path, content);
  expect(() => runCapture({ ...f.config, historyRegistry: { ...f.config.historyRegistry, sha256: sha256(content) } }, f.home))
    .toThrow(new Error('registry-invalid'));
  expect(() => verifyGeneration(f.home, `generations/${'0'.repeat(64)}`, '0'.repeat(64)))
    .toThrow(new Error('generation-integrity'));
  expect(existsSync(f.home)).toBe(false);
});

test('empty dialogue artifacts still receive full stable verification', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), '{"type":"session_meta"}\n');
  expect(runCapture(f.config, f.home, true)).toMatchObject({ errors: 0 });
  const job = rows(f.home, 'jobs')[0]!;
  expect(verifyGeneration(f.home, String(job.generation), String(job.receipt_hash)))
    .toMatchObject({ dialogueBlocks: 0, semanticState: 'no-dialogue', dialogueSha256: sha256('') });
});

test('provider root binding is durable, order-independent and stores no plaintext roots', () => {
  const f = fixture(); const claude = join(f.root, 'claude'); mkdirSync(claude);
  const config = { ...f.config, providerRoots: { codex: f.source, 'claude-code': claude } };
  expect(runCapture(config, f.home)).toMatchObject({ writes: false, rootBinding: 'would-bind-new-queue' });
  expect(existsSync(f.home)).toBe(false);
  expect(runCapture(config, f.home, true)).toMatchObject({ errors: 0 });
  const settings = rows(f.home, 'capture_settings');
  expect(settings).toHaveLength(1);
  const binding = JSON.parse(String(settings[0]!.value));
  expect(binding).toMatchObject({ schemaVersion: 1, firstBind: 'new-queue' });
  expect(binding.rootsSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(String(settings[0]!.value)).not.toContain('source');
  expect(String(settings[0]!.value)).not.toContain('acb-capture-');
  expect(runCapture({ ...config, providerRoots: { 'claude-code': claude, codex: f.source } }, f.home))
    .toMatchObject({ writes: false, rootBinding: 'verified' });
  if (process.platform === 'win32') {
    expect(runCapture({ ...config, providerRoots: { codex: f.source.toUpperCase(), 'claude-code': claude } }, f.home))
      .toMatchObject({ rootBinding: 'verified' });
  }
  expect(rows(f.home, 'capture_settings')).toEqual(settings);
});

test('root switches fail closed in plan and execute even with first-bind approval', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one'));
  runCapture(f.config, f.home, true);
  const replacement = join(f.root, 'replacement'); mkdirSync(replacement);
  writeFileSync(join(replacement, 'b.jsonl'), turn('MUST_NOT_CAPTURE'));
  const before = readFileSync(join(f.home, 'queue.sqlite3'));
  for (const execute of [false, true]) {
    for (const allowInitialRootBinding of [false, true]) {
      expect(() => runCapture({ ...f.config, providerRoots: { codex: replacement }, allowInitialRootBinding }, f.home, execute))
        .toThrow(new Error('capture-root-binding-mismatch'));
    }
    expect(() => runCapture({ ...f.config, providerRoots: { 'claude-code': f.source } }, f.home, execute))
      .toThrow(new Error('capture-root-binding-mismatch'));
    expect(() => runCapture({ ...f.config, providerRoots: { codex: f.source, 'claude-code': replacement } }, f.home, execute))
      .toThrow(new Error('capture-root-binding-mismatch'));
  }
  expect(readFileSync(join(f.home, 'queue.sqlite3')).equals(before)).toBe(true);
  expect(rows(f.home, 'jobs')).toHaveLength(1);
  expect(runCapture(f.config, f.home)).toMatchObject({ rootBinding: 'verified' });
});

test('an existing unbound queue requires explicit reviewed first binding without rewriting history', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one'));
  runCapture(f.config, f.home, true);
  const source = rows(f.home, 'sources')[0]!, jobs = rows(f.home, 'jobs');
  { using db = new Database(join(f.home, 'queue.sqlite3')); db.run('DROP TABLE capture_settings'); }
  const before = readFileSync(join(f.home, 'queue.sqlite3'));
  for (const execute of [false, true]) {
    expect(() => runCapture(f.config, f.home, execute)).toThrow(new Error('capture-root-binding-review-required'));
  }
  const reviewed = { ...f.config, allowInitialRootBinding: true };
  expect(runCapture(reviewed, f.home)).toMatchObject({ writes: false, rootBinding: 'would-bind-reviewed-existing-queue' });
  expect(readFileSync(join(f.home, 'queue.sqlite3')).equals(before)).toBe(true);
  expect(runCapture(reviewed, f.home, true)).toMatchObject({ errors: 0 });
  expect(JSON.parse(String(rows(f.home, 'capture_settings')[0]!.value))).toMatchObject({ firstBind: 'reviewed-existing-queue' });
  expect(rows(f.home, 'events').some(row => row.detail === 'capture-root-first-bind:reviewed-existing-queue')).toBe(true);
  expect(rows(f.home, 'jobs')).toEqual(jobs);
  expect(rows(f.home, 'sources')[0]).toMatchObject({ key: source.key, offset: source.offset,
    prefix_hash: source.prefix_hash, identity: source.identity, generation: source.generation });
  expect(runCapture(f.config, f.home)).toMatchObject({ rootBinding: 'verified' });
});

test('corrupt existing binding is never automatically replaced', () => {
  const f = fixture(); runCapture(f.config, f.home, true);
  { using db = new Database(join(f.home, 'queue.sqlite3')); db.query('UPDATE capture_settings SET value=?').run('{PRIVATE_RAW'); }
  for (const execute of [false, true]) {
    expect(() => runCapture({ ...f.config, allowInitialRootBinding: true }, f.home, execute))
      .toThrow(new Error('capture-root-binding-invalid'));
  }
  expect(rows(f.home, 'capture_settings')[0]!.value).toBe('{PRIVATE_RAW');
});

test('root binding is checked again under the capture transaction after preflight', () => {
  const f = fixture(); writeFileSync(join(f.source, 'a.jsonl'), turn('one'));
  runCapture(f.config, f.home, true);
  appendFileSync(join(f.source, 'a.jsonl'), turn('two'));
  const source = rows(f.home, 'sources'), jobs = rows(f.home, 'jobs');
  const registry = readFileSync(f.config.historyRegistry.path, 'utf8');
  let changed = false;
  const hook = onHash(text => {
    if (text !== registry || changed) return;
    changed = true;
    using db = new Database(join(f.home, 'queue.sqlite3'));
    const binding = JSON.parse(String(rows(f.home, 'capture_settings')[0]!.value));
    db.query('UPDATE capture_settings SET value=?').run(JSON.stringify({ ...binding, rootsSha256: '0'.repeat(64) }));
  });
  try { expect(() => runCapture(f.config, f.home, true)).toThrow(new Error('capture-root-binding-mismatch')); }
  finally { hook.mockRestore(); }
  expect(changed).toBe(true);
  expect(rows(f.home, 'sources')).toEqual(source);
  expect(rows(f.home, 'jobs')).toEqual(jobs);
});

test('a queue initialized between preflight and capture cannot receive an unreviewed binding', () => {
  const f = fixture(); const registry = readFileSync(f.config.historyRegistry.path, 'utf8');
  let created = false;
  const hook = onHash(text => {
    if (text !== registry || created) return;
    created = true; mkdirSync(f.home);
    using db = new Database(join(f.home, 'queue.sqlite3'));
    db.run('CREATE TABLE legacy_marker(value TEXT)');
  });
  try { expect(() => runCapture(f.config, f.home, true)).toThrow(new Error('capture-root-binding-review-required')); }
  finally { hook.mockRestore(); }
  expect(created).toBe(true);
  using db = new Database(join(f.home, 'queue.sqlite3'), { readonly: true });
  expect(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'legacy_marker' }]);
});

test('a locked queue is busy, not an invalid or unbound root configuration', () => {
  const f = fixture(); runCapture(f.config, f.home, true);
  const binding = rows(f.home, 'capture_settings');
  using db = new Database(join(f.home, 'queue.sqlite3'));
  db.run('BEGIN EXCLUSIVE');
  try {
    expect(runCapture(f.config, f.home)).toMatchObject({ state: 'busy', writes: false });
    expect(runCapture(f.config, f.home, true)).toMatchObject({ state: 'busy', writes: false });
  } finally { db.run('ROLLBACK'); }
  expect(rows(f.home, 'capture_settings')).toEqual(binding);
});
