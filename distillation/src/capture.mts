import { sha256Hasher } from './platform.mts';
export const hooks = { sha256Hasher };
import { type BigIntStats, type Dirent, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, renameSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { HashSchema } from './schemas.mts';
import { noLinks, openStore } from './store.mts';
import { captureDocuments, DocumentSources, documentRoots, type DocumentGuard } from './documents.mts';
import { parseEvent } from './transcript.mts';
import { windowsFileIdentity } from './windows-file-identity.mts';

const MiB = 1024 * 1024;
const Provider = z.enum(['codex', 'claude-code']);
const Bound = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CaptureConfig = z.strictObject({
  providerRoots: z.partialRecord(Provider, z.string().min(1)),
  // Explicit operator review of roots for an existing, unbound queue only.
  // This never authorizes rebinding; changed roots need a separate migration.
  allowInitialRootBinding: z.boolean().default(false),
  historyRegistry: z.strictObject({ path: z.string().min(1), sha256: HashSchema }),
  excludedSources: z.array(z.string()).default([]),
  maxFiles: z.number().int().min(1).max(32).default(4),
  maxDeltaBytes: z.number().int().min(4 * MiB + 1).max(16 * MiB).default(8 * MiB),
  reserveBytes: z.number().int().min(1).default(5 * 1024 ** 3),
  maxSeconds: z.number().int().min(1).max(60).default(15),
  maxDiscovered: z.number().int().min(1).max(10000).default(10000),
  retrySeconds: z.number().int().min(1).max(86400).default(300),
  // Opt-in workbench documents; each source is disabled unless it says enabled.
  documentSources: DocumentSources
});
const SourceRow = z.object({ offset: Bound, prefix_hash: HashSchema.nullable(),
  identity: z.string().nullable(), generation: z.string().nullable(), retry_at: z.number() });
const Receipt = z.object({ schemaVersion: z.literal(1), sourceKey: HashSchema, provider: Provider,
  relativePath: z.string(), startByte: Bound, endByte: Bound, prefixSha256: HashSchema,
  rawSha256: HashSchema, dialogueSha256: HashSchema, dialogueBlocks: Bound,
  semanticState: z.enum(['pending', 'no-dialogue']) });
const Registry = z.object({ schemaVersion: z.literal(1), boundary: z.literal(
  'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.'),
  entries: z.array(z.object({ provider: Provider, relativePath: z.string(), key: z.string(),
    classification: z.literal('legacy-unresolved') })).max(20000) });
const RootBinding = z.strictObject({ schemaVersion: z.literal(1), rootsSha256: HashSchema,
  firstBind: z.enum(['new-queue', 'reviewed-existing-queue']), boundAt: z.number().finite().nonnegative() });

function storedRootBinding(db: ReturnType<typeof openStore>, expected: string) {
  let binding: z.infer<typeof RootBinding> | null = null;
  try {
    if (db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='capture_settings'").get()) {
      const row = db.query("SELECT value FROM capture_settings WHERE key='provider-roots-v1'").get();
      if (row) binding = RootBinding.parse(JSON.parse(z.object({ value: z.string() }).parse(row).value));
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') throw error;
    throw new Error('capture-root-binding-invalid');
  }
  if (binding && binding.rootsSha256 !== expected) throw new Error('capture-root-binding-mismatch');
  return binding;
}

export function sha256(raw: string | Uint8Array) { return hooks.sha256Hasher().update(raw).digest('hex'); }
function within(root: string, path: string) {
  const r = relative(root, path);
  return !r || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
function safeRelative(path: string) {
  if (!path || path.length > 4096 || path.split('/').some(p => !p || p === '.' || p === '..' ||
    /[\\:<>"|?*\x00-\x1f]/u.test(p) || /[ .]$/u.test(p) || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/iu.test(p))) {
    throw new Error('invalid-relative-path');
  }
  return path;
}
function keyOf(provider: string, path: string) { return `${provider}:${safeRelative(path).normalize('NFC').toLowerCase()}`; }
function deadlineCheck(deadline: number) { if (performance.now() > deadline) throw new Error('time-budget-exhausted'); }
function identity(path: string) {
  noLinks(path);
  const s = lstatSync(path, { bigint: true });
  if (!s.isFile()) throw new Error('source-kind');
  // Decimal strings avoid rounding Windows file IDs through JavaScript doubles.
  const compatId = `${s.dev}:${s.ino}`;
  const id = process.platform === 'win32' ? windowsFileIdentity(path) : compatId;
  noLinks(path);
  const after = lstatSync(path, { bigint: true });
  if (after.dev !== s.dev || after.ino !== s.ino || after.size < s.size) throw new Error('source-changed-during-capture');
  return { id, compatId, size: Number(s.size), mtime: s.mtimeNs.toString() };
}
function sameIdentity(stored: string, actual: string, compatId: string) {
  if (stored === actual || stored === compatId) return true;
  // Imported Python identities use a JSON integer tuple. Compare lexical integers.
  const match = /^\[\s*(\d+)\s*,\s*(\d+)\s*\]$/u.exec(stored);
  return Boolean(match && (process.platform === 'win32' ? `win:${match[1]}:${match[2]}` : `${match[1]}:${match[2]}`) === actual);
}
function prefix(path: string, cutoff: number, deadline: number, suffixStart = cutoff) {
  noLinks(path);
  const handle = openSync(path, 'r');
  const full = hooks.sha256Hasher();
  const suffix = hooks.sha256Hasher();
  const buffer = Buffer.alloc(Math.min(MiB, Math.max(1, cutoff)));
  let offset = 0;
  try {
    while (offset < cutoff) {
      deadlineCheck(deadline);
      const n = readSync(handle, buffer, 0, Math.min(buffer.length, cutoff - offset), offset);
      if (!n) throw new Error('source-truncated');
      full.update(buffer.subarray(0, n));
      if (offset + n > suffixStart) suffix.update(buffer.subarray(Math.max(0, suffixStart - offset), n));
      offset += n;
    }
  } finally { closeSync(handle); }
  return { full: full.digest('hex'), suffix: suffix.digest('hex') };
}
function sameArtifact(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function readArtifact(path: string, limit: number, deadline: number, collect: boolean) {
  try {
    deadlineCheck(deadline);
    noLinks(path);
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error('artifact-limit');
    const fd = openSync(path, 'r');
    try {
      if (!sameArtifact(before, fstatSync(fd, { bigint: true }))) throw new Error('artifact-changed');
      const size = Number(before.size);
      const buffer = Buffer.alloc(Math.min(MiB, size + 1));
      const chunks: Buffer[] = [];
      const hash = hooks.sha256Hasher();
      let bytes = 0;
      // Read one extra byte as well as comparing path and handle metadata. A
      // prefix matching the receipt must not authenticate an appended artifact.
      while (bytes <= size) {
        deadlineCheck(deadline);
        const n = readSync(fd, buffer, 0, Math.min(buffer.length, size + 1 - bytes), bytes);
        if (!n) break;
        bytes += n;
        hash.update(buffer.subarray(0, n));
        if (collect) chunks.push(Buffer.from(buffer.subarray(0, n)));
      }
      noLinks(path);
      if (bytes !== size || !sameArtifact(before, fstatSync(fd, { bigint: true })) ||
        !sameArtifact(before, lstatSync(path, { bigint: true }))) throw new Error('artifact-changed');
      deadlineCheck(deadline);
      return { raw: collect ? Buffer.concat(chunks, bytes) : Buffer.alloc(0), hash: hash.digest('hex') };
    } finally { closeSync(fd); }
  } catch (error) {
    const code = error instanceof Error && ['artifact-limit', 'artifact-changed', 'time-budget-exhausted'].includes(error.message)
      ? error.message : 'artifact-invalid-or-unreadable';
    throw new Error(code);
  }
}
function boundedRead(path: string, limit: number, deadline = Infinity) {
  return readArtifact(path, limit, deadline, true).raw;
}
function writeDurable(path: string, bytes: string | Uint8Array) {
  noLinks(path);
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function verifyGeneration(home: string, generation: string, receiptHash: string, deadline = Infinity) {
  if (!/^generations\/[a-f0-9]{64}$/u.test(generation)) throw new Error('generation-path');
  try {
    const directory = join(home, generation);
    const raw = boundedRead(join(directory, 'receipt.json'), 16384, deadline);
    if (sha256(raw) !== HashSchema.parse(receiptHash)) throw new Error('generation-integrity');
    const receipt = Receipt.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)));
    for (const [name, expected] of [['raw.private.jsonl', receipt.rawSha256], ['dialogue.private.jsonl', receipt.dialogueSha256]]) {
      const path = join(directory, name!);
      if (readArtifact(path, 128 * MiB, deadline, false).hash !== expected) {
        throw new Error('generation-integrity');
      }
    }
    return receipt;
  } catch (error) {
    throw new Error(error instanceof Error && error.message === 'time-budget-exhausted'
      ? 'time-budget-exhausted' : 'generation-integrity');
  }
}

export function runCapture(input: unknown, runtimeHome: string, execute = false, guard: DocumentGuard = {}) {
  const config = CaptureConfig.parse(input);
  const home = resolve(runtimeHome);
  noLinks(home);
  const roots = Object.entries(config.providerRoots).map(([provider, path]) => [Provider.parse(provider), resolve(path!)] as const);
  if (!roots.length) throw new Error('missing-provider-roots');
  for (const [, root] of roots) {
    let directory: boolean;
    try { noLinks(root); directory = lstatSync(root).isDirectory(); }
    catch { throw new Error('provider-root-invalid-or-unreadable'); }
    if (!directory || within(root, home) || within(home, root)) throw new Error('invalid-root-boundary');
    if (roots.some(([, other]) => other !== root && (within(root, other) || within(other, root)))) throw new Error('overlapping-roots');
  }
  if (new Set(roots.map(([, r]) => r.toLowerCase())).size !== roots.length) throw new Error('overlapping-roots');
  // Static document root rules fail before any queue, registry or document read.
  const documents = documentRoots(config.documentSources, { home, providerRoots: roots.map(([, root]) => root),
    registry: resolve(config.historyRegistry.path), guard });
  const rootsHash = sha256(JSON.stringify({ schemaVersion: 1, providerRoots: roots
    .map(([provider, root]) => [provider, process.platform === 'win32' ? root.toLowerCase() : root])
    .sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0) }));
  const database = join(home, 'queue.sqlite3');
  noLinks(database);
  let existed: boolean;
  try { if (!lstatSync(database).isFile()) throw new Error('capture-root-binding-invalid'); existed = true; }
  catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') existed = false;
    else throw new Error('capture-root-binding-unreadable');
  }
  let binding: z.infer<typeof RootBinding> | null = null;
  if (existed) {
    try {
      using checked = openStore(database);
      binding = storedRootBinding(checked, rootsHash);
      if (!binding && !config.allowInitialRootBinding) throw new Error('capture-root-binding-review-required');
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') {
        return { state: 'busy', writes: false, fullyCurrent: false };
      }
      throw error;
    }
  }
  const registryRaw = boundedRead(resolve(config.historyRegistry.path), 32 * MiB);
  if (sha256(registryRaw) !== config.historyRegistry.sha256) throw new Error('registry-integrity');
  let registry: z.infer<typeof Registry>;
  try { registry = Registry.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(registryRaw))); }
  catch { throw new Error('registry-invalid'); }
  const history = new Map<string, string>();
  for (const row of registry.entries) {
    const key = keyOf(row.provider, row.relativePath);
    // Unsupported Unicode casefold aliases fail closed rather than granting a fresh start.
    if (key !== row.key || history.has(key)) throw new Error('registry-entry');
    history.set(key, row.relativePath);
  }
  const excluded = new Set(config.excludedSources.map(entry => {
    const colon = entry.indexOf(':');
    const provider = Provider.parse(entry.slice(0, colon));
    return keyOf(provider, entry.slice(colon + 1));
  }));
  if (!execute) return { mode: 'plan', writes: false, providerCount: roots.length, fullyCurrent: false,
    rootBinding: binding ? 'verified' : existed ? 'would-bind-reviewed-existing-queue' : 'would-bind-new-queue',
    ...(documents.length ? { documentSourceCount: documents.length } : {}) };
  mkdirSync(home, { recursive: true });
  const disk = statfsSync(home);
  if (disk.bavail * disk.bsize < config.reserveBytes + config.maxDeltaBytes * 12) throw new Error('paused-disk');
  const db = openStore(database, { readonly: false, create: true });
  const deadline = performance.now() + config.maxSeconds * 1000;
  let processed = 0, errors = 0, legacyUnresolved = 0, visited = 0;
  try {
    db.run('BEGIN IMMEDIATE');
    // Recheck under the capture lock. Plan/preflight is not write authority if
    // another process bound or initialized this database in the meantime.
    const currentBinding = storedRootBinding(db, rootsHash);
    let firstBind: 'new-queue' | 'reviewed-existing-queue' | null = null;
    if (!currentBinding) {
      const existingQueue = existed || Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get());
      if (existingQueue && !config.allowInitialRootBinding) throw new Error('capture-root-binding-review-required');
      firstBind = existingQueue ? 'reviewed-existing-queue' : 'new-queue';
      db.run('CREATE TABLE IF NOT EXISTS capture_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
      db.query('INSERT INTO capture_settings(key,value) VALUES(?,?)').run('provider-roots-v1',
        JSON.stringify({ schemaVersion: 1, rootsSha256: rootsHash, firstBind, boundAt: Date.now() / 1000 }));
    }
    db.run(`CREATE TABLE IF NOT EXISTS sources(key TEXT PRIMARY KEY,provider TEXT,relative_path TEXT,offset INTEGER NOT NULL DEFAULT 0,prefix_hash TEXT,identity TEXT,observed_size INTEGER,observed_mtime INTEGER,state TEXT,error TEXT,retry_at REAL DEFAULT 0,checked_at REAL,generation TEXT);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,source_key TEXT,start_byte INTEGER,end_byte INTEGER,generation TEXT,receipt_hash TEXT,state TEXT,created_at REAL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at REAL,source_key TEXT,kind TEXT,detail TEXT);
      CREATE TABLE IF NOT EXISTS scan_dirs(provider TEXT,relative TEXT,after_name TEXT,PRIMARY KEY(provider,relative));`);
    if (firstBind) db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,NULL,?,?)')
      .run(Date.now() / 1000, 'configuration', `capture-root-first-bind:${firstBind}`);
    if (!db.query('SELECT 1 FROM scan_dirs LIMIT 1').get()) {
      for (const [provider] of roots) db.query('INSERT INTO scan_dirs VALUES(?,?,?)').run(provider, '', '');
    }
    let stopped = false;
    // Keep original keys intact; a differently spelled path cannot start again
    // at byte zero under a second identity on a case-insensitive filesystem.
    const aliases = new Map<string, Set<string>>();
    const remember = (provider: string, path: string) => {
      const canonical = keyOf(provider, path);
      const paths = aliases.get(canonical) ?? new Set<string>();
      paths.add(path); aliases.set(canonical, paths);
    };
    for (const row of registry.entries) remember(row.provider, row.relativePath);
    for (const value of db.query('SELECT provider,relative_path FROM sources').iterate()) {
      if (performance.now() > deadline) { stopped = true; break; }
      const row = z.object({ provider: Provider, relative_path: z.string() }).parse(value);
      remember(row.provider, row.relative_path);
    }
    scan: while (!stopped) {
      if (performance.now() > deadline) { stopped = true; break; }
      const value = db.query('SELECT * FROM scan_dirs ORDER BY provider,relative LIMIT 1').get();
      if (!value) break;
      const cursor = z.object({ provider: Provider, relative: z.string(), after_name: z.string() }).parse(value);
      const root = roots.find(([p]) => p === cursor.provider)?.[1];
      if (!root) throw new Error('provider-policy-changed');
      if (cursor.relative) safeRelative(cursor.relative);
      const folder = join(root, cursor.relative);
      const entries: Dirent[] = [];
      try {
        noLinks(folder);
        const directoryHandle = opendirSync(folder);
        try {
          let entry;
          while ((entry = directoryHandle.readSync())) {
            deadlineCheck(deadline);
            if (entries.length === 10000) throw new Error('directory-entry-cap');
            entries.push(entry);
          }
        } finally { directoryHandle.closeSync(); }
      } catch (error) {
        if (error instanceof Error && error.message === 'time-budget-exhausted') { stopped = true; break; }
        const missing = error && typeof error === 'object' && 'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR');
        const code = missing ? 'directory-vanished' : 'directory-invalid-or-unreadable';
        errors++;
        db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,?,?,?)')
          .run(Date.now() / 1000, sha256(`directory:${cursor.provider}:${cursor.relative}`), 'failed', code);
        db.query('DELETE FROM scan_dirs WHERE provider=? AND relative=?').run(cursor.provider, cursor.relative);
        continue;
      }
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        if (entry.name <= cursor.after_name) continue;
        if (processed >= config.maxFiles || visited >= config.maxDiscovered || performance.now() > deadline) { stopped = true; break scan; }
        visited++;
        const rel = safeRelative(cursor.relative ? `${cursor.relative}/${entry.name}` : entry.name);
        const path = join(root, rel);
        if (excluded.has(keyOf(cursor.provider, rel))) {
          // Exclusions are checked before opening or statting the source.
        } else if (entry.isDirectory()) {
          db.query('INSERT OR IGNORE INTO scan_dirs VALUES(?,?,?)').run(cursor.provider, rel, '');
        } else if (entry.name.endsWith('.jsonl')) {
          const provider = cursor.provider;
          const key = sha256(`${provider}:${rel}`);
          const oldValue = db.query('SELECT * FROM sources WHERE key=?').get(key);
          const old = oldValue ? SourceRow.parse(oldValue) : null;
          const now = Date.now() / 1000;
          if (!old || old.retry_at <= now) {
            processed++;
            db.run('SAVEPOINT capture_source');
            try {
              if ([...(aliases.get(keyOf(provider, rel)) ?? [])].some(path => path !== rel)) throw new Error('source-case-alias');
              db.query('INSERT OR IGNORE INTO sources(key,provider,relative_path) VALUES(?,?,?)').run(key, provider, rel);
              const before = identity(path);
              const start = old?.offset ?? 0;
              if (old?.identity && !sameIdentity(old.identity, before.id, before.compatId)) throw new Error('source-replaced');
              if (before.size < start) throw new Error('source-truncated');
              if (history.has(keyOf(provider, rel))) {
                const exists = db.query("SELECT 1 FROM sqlite_master WHERE name='bootstrap_evidence'").get();
                const evidence = exists ? db.query('SELECT cutoff,prefix_sha FROM bootstrap_evidence WHERE source_key=?').get(key) : null;
                const proof = evidence ? z.object({ cutoff: Bound, prefix_sha: HashSchema }).parse(evidence) : null;
                if (!proof || history.get(keyOf(provider, rel)) !== rel || start < proof.cutoff ||
                  prefix(path, proof.cutoff, deadline).full !== proof.prefix_sha) throw new Error('historical-cutoff-unverified');
              }
              if (old?.generation) {
                const job = z.object({ receipt_hash: HashSchema }).parse(db.query('SELECT receipt_hash FROM jobs WHERE generation=?').get(old.generation));
                verifyGeneration(home, old.generation, job.receipt_hash, deadline);
              }
              if (start && prefix(path, start, deadline).full !== old?.prefix_hash) throw new Error('source-prefix-rewritten');
              const fd = openSync(path, 'r');
              let raw: Buffer;
              try {
                const buffer = Buffer.alloc(Math.min(config.maxDeltaBytes, before.size - start));
                let n = 0;
                while (n < buffer.length) { deadlineCheck(deadline); const count = readSync(fd, buffer, n, buffer.length - n, start + n); if (!count) break; n += count; }
                const tail = buffer.subarray(0, n).lastIndexOf(10) + 1;
                if (!tail && n > 4 * MiB) throw new Error('oversized-event');
                raw = buffer.subarray(0, tail);
              } finally { closeSync(fd); }
              const end = start + raw.length;
              const checked = prefix(path, end, deadline, start);
              const repeated = prefix(path, end, deadline, start);
              const after = identity(path);
              if (checked.full !== repeated.full || checked.suffix !== sha256(raw) || repeated.suffix !== checked.suffix ||
                before.id !== after.id || after.size < before.size) throw new Error('source-changed-during-capture');
              if (start && prefix(path, start, deadline).full !== old?.prefix_hash) throw new Error('source-prefix-rewritten');
              if (raw.length) {
                const dialogue = [];
                let offset = 0;
                while (offset < raw.length) {
                  deadlineCheck(deadline);
                  const next = raw.indexOf(10, offset) + 1;
                  const line = raw.subarray(offset, next);
                  if (line.length > 4 * MiB) throw new Error('oversized-event');
                  const parsed = parseEvent(line, provider);
                  deadlineCheck(deadline);
                  const eventSha256 = sha256(line);
                  for (const text of parsed.texts) {
                    deadlineCheck(deadline);
                    dialogue.push({ source: { provider, relativePath: rel,
                      startByte: start + offset, endByte: start + next, eventSha256, pointer: text.pointer }, role: parsed.role, text: text.text });
                  }
                  offset = next;
                }
                const job = sha256(`${key}:${start}:${checked.full}`);
                const generation = `generations/${job}`;
                const directory = join(home, generation);
                let receiptHash: string;
                if (existsSync(directory)) {
                  const existingBytes = boundedRead(join(directory, 'receipt.json'), 16384, deadline);
                  receiptHash = sha256(existingBytes);
                  const saved = verifyGeneration(home, generation, receiptHash, deadline);
                  if (saved.sourceKey !== key || saved.provider !== provider || saved.relativePath !== rel ||
                    saved.startByte !== start || saved.endByte !== end || saved.prefixSha256 !== checked.full || saved.rawSha256 !== sha256(raw)) throw new Error('generation-integrity');
                  const previousDialogue = new TextDecoder('utf-8', { fatal: true }).decode(boundedRead(join(directory, 'dialogue.private.jsonl'), 128 * MiB, deadline))
                    .split('\n').filter(Boolean).map(line => { deadlineCheck(deadline); return JSON.parse(line); });
                  if (JSON.stringify(previousDialogue) !== JSON.stringify(dialogue) || saved.dialogueBlocks !== dialogue.length ||
                    saved.semanticState !== (dialogue.length ? 'pending' : 'no-dialogue')) throw new Error('generation-integrity');
                } else {
                  const body = dialogue.map(row => { deadlineCheck(deadline); return JSON.stringify(row) + '\n'; }).join('');
                  const receipt = { schemaVersion: 1, sourceKey: key, provider, relativePath: rel, startByte: start, endByte: end,
                    prefixSha256: checked.full, rawSha256: sha256(raw), dialogueSha256: sha256(body), dialogueBlocks: dialogue.length,
                    privacy: 'private-unredacted-raw-derived; NOT a human/search index or broker input', state: 'extracted',
                    semanticState: dialogue.length ? 'pending' : 'no-dialogue', acceptedState: 'not-submitted', createdAt: now };
                  const encoded = JSON.stringify(receipt) + '\n';
                  const stage = join(home, 'staging', `${job}-${randomUUID()}`);
                  noLinks(stage); mkdirSync(stage, { recursive: true });
                  writeDurable(join(stage, 'raw.private.jsonl'), raw);
                  writeDurable(join(stage, 'dialogue.private.jsonl'), body);
                  writeDurable(join(stage, 'receipt.json'), encoded);
                  noLinks(directory); mkdirSync(dirname(directory), { recursive: true });
                  renameSync(stage, directory);
                  receiptHash = sha256(encoded);
                }
                const saved = verifyGeneration(home, generation, receiptHash, deadline);
                deadlineCheck(deadline);
                db.query('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?,?)').run(job, key, start, end, generation, receiptHash, saved.semanticState, now);
                db.query('UPDATE sources SET offset=?,prefix_hash=?,identity=?,generation=? WHERE key=?').run(end, checked.full, before.id, generation, key);
              }
              const pending = end < before.size;
              // Even an idle successful verification upgrades a legacy identity;
              // offsets and hashes remain unchanged unless new bytes were committed.
              db.query('UPDATE sources SET identity=?,observed_size=?,observed_mtime=?,state=?,error=NULL,retry_at=?,checked_at=? WHERE key=?')
                .run(before.id, before.size, before.mtime, pending ? 'pending-tail' : 'extracted', pending && !raw.length ? now + config.retrySeconds : 0, now, key);
              db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,?,?,?)').run(now, key, 'checked', pending ? 'pending-tail' : 'cutoff-reached');
              db.run('RELEASE capture_source');
              remember(provider, rel);
            } catch (error) {
              db.run('ROLLBACK TO capture_source');
              db.run('RELEASE capture_source');
              if (error instanceof Error && error.message === 'time-budget-exhausted') {
                stopped = true;
                break scan;
              }
              const known = new Set(['source-replaced','source-truncated','source-prefix-rewritten','source-changed-during-capture',
                'oversized-event','historical-cutoff-unverified','generation-integrity','source-case-alias']);
              const code = error instanceof Error && known.has(error.message) ? error.message : 'capture-invalid-or-unreadable';
              const state = code === 'historical-cutoff-unverified' ? 'legacy-unresolved' : 'failed';
              if (state === 'legacy-unresolved') legacyUnresolved++; else errors++;
              if (code !== 'source-case-alias') {
                db.query('INSERT OR IGNORE INTO sources(key,provider,relative_path) VALUES(?,?,?)').run(key, provider, rel);
                db.query('UPDATE sources SET state=?,error=?,retry_at=?,checked_at=? WHERE key=?').run(state, code, now + config.retrySeconds, now, key);
                remember(provider, rel);
              }
              db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,?,?,?)').run(now, key, state, code);
            }
          }
        }
        db.query('UPDATE scan_dirs SET after_name=? WHERE provider=? AND relative=?').run(entry.name, cursor.provider, cursor.relative);
      }
      db.query('DELETE FROM scan_dirs WHERE provider=? AND relative=?').run(cursor.provider, cursor.relative);
    }
    // Documents run after transcripts, on the remaining time, under the same capture lock.
    const documentTick = documents.length
      ? captureDocuments(db, documents, home, { retrySeconds: config.retrySeconds, deadline }) : null;
    db.run('COMMIT');
    const documentPartial = Boolean(documentTick && (documentTick.stopped || documentTick.errors));
    return { state: stopped || errors || legacyUnresolved || documentPartial ? 'partial' : 'complete-tick', processed, errors, legacyUnresolved, fullyCurrent: false,
      ...(documentTick ? { documents: documentTick } : {}) };
  } catch (error) {
    if (db.inTransaction) db.run('ROLLBACK');
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') return { state: 'busy', fullyCurrent: false };
    throw error;
  } finally { db.close(); }
}
