import { glob, sha256Hasher } from './platform.mts';
import { type BigIntStats, type Dirent, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync,
  readSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Database } from './sqlite.mts';
import { z } from 'zod';
import { HashSchema } from './schemas.mts';
import { noLinks, openStore } from './store.mts';
import { buildSlices, canonical, digest } from './slicing.mts';

// Workbench documents are a second, opt-in capture lane. Nothing here runs unless a
// source is enabled; the transcript lane, its tables and its slice digests are untouched.

const KiB = 1024, MiB = 1024 * KiB;
const Glob = z.string().min(1).max(256).refine(v => !v.includes('\\') && !v.startsWith('/') && !v.split('/').includes('..'), 'glob-shape');
export const DocumentSource = z.strictObject({
  id: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/), root: z.string().min(1),
  enabled: z.boolean().default(false), sensitivity: z.enum(['private', 'shared']),
  allowSharedPublication: z.boolean().default(false),
  include: z.array(Glob).min(1).max(64).default(['**/*']), exclude: z.array(Glob).max(64).default([]),
  kinds: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), z.array(Glob).min(1).max(32)).optional(),
  extensions: z.array(z.string().regex(/^\.[a-z0-9]{1,10}$/)).min(1).max(16).default(['.md']),
  initial: z.enum(['baseline', 'distill']).default('baseline'),
  maxFileBytes: z.number().int().min(1).max(4 * MiB).default(256 * KiB),
  maxFilesPerTick: z.number().int().min(1).max(256).default(8),
  maxBytesPerTick: z.number().int().min(1).max(64 * MiB).default(MiB),
  settleSeconds: z.number().int().min(0).max(86400).default(120),
  maxDepth: z.number().int().min(0).max(32).default(8)
}).refine(s => s.maxFileBytes <= s.maxBytesPerTick, 'document-file-exceeds-tick-budget');
export type DocumentSourceConfig = z.output<typeof DocumentSource>;
export const DocumentSources = z.array(DocumentSource).max(16)
  .refine(items => new Set(items.map(item => item.id)).size === items.length, 'document-source-duplicate-id').default([]);

// Hard denylist: configuration can narrow it with exclude globs, never widen it.
export const DENIED_SEGMENTS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'runtime', 'credentials', 'secrets', '.claude', '.codex',
  'worktrees', 'backups', '.home-skill-backups', 'archives', 'tmp', '.tmp', 'dist', 'attachments', 'testresults', '.venv']);
const DENIED_FILES = [/^\.env/, /\.pem$/, /(?:^|\.)key$/, /(?:^|\.)pfx$/, /(?:^|\.)p12$/, /auth.*\.json$/, /credential/, /\.sqlite/, /^settings\.local\.json$/];
export const deniedSegment = (name: string) => DENIED_SEGMENTS.has(name.toLowerCase());
export const deniedFile = (name: string) => DENIED_FILES.some(pattern => pattern.test(name.toLowerCase()));

function stop(code: string): never { throw new Error(code); }
function sha256(raw: string | Uint8Array) { return sha256Hasher().update(raw).digest('hex'); }
function deadlineCheck(deadline: number) { if (performance.now() > deadline) stop('time-budget-exhausted'); }
const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path).normalize('NFC');
function within(root: string, path: string) {
  const r = relative(root, path);
  return !r || (!r.startsWith(`..${sep}`) && r !== '..' && !isAbsolute(r));
}
const overlap = (a: string, b: string) => within(a, b) || within(b, a);
/** Long, final spelling of the deepest existing ancestor plus the rest, so 8.3 aliases cannot slip
 * past a lexical check and an existing and a not-yet-created path compare in the same spelling. */
function canon(path: string) {
  const tail: string[] = [];
  for (let head = resolve(path); ; ) {
    try { return join(realpathSync.native(head), ...tail.toReversed()); } catch {
      const parent = dirname(head);
      if (parent === head) return resolve(path);
      tail.push(basename(head)); head = parent;
    }
  }
}
function crossesDenied(root: string, target: string, file: boolean) {
  const parts = relative(root, target).split(sep);
  return (file ? parts.slice(0, -1) : parts).some(deniedSegment);
}
const validName = (name: string) => name.length > 0 && name.length <= 255 && !/[\\/:<>"|?*\x00-\x1f]/u.test(name) && !/[ .]$/u.test(name) &&
  !/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/iu.test(name) && name !== '.' && name !== '..';

export type DocumentGuard = { authHomes?: string[]; receipts?: string[] };
export type BoundaryContext = { home: string; providerRoots: string[]; registry: string; guard?: DocumentGuard };
export type ResolvedSource = { source: DocumentSourceConfig; root: string };

/** Static root rules, checked before any read. Throws a document-* code. */
export function documentRoot(source: DocumentSourceConfig, others: DocumentSourceConfig[], context: BoundaryContext): string {
  // Links are refused on the configured spelling before canon() could resolve one away.
  try { noLinks(resolve(source.root)); if (!lstatSync(resolve(source.root)).isDirectory()) stop('document-root-invalid-or-unreadable'); }
  catch { stop('document-root-invalid-or-unreadable'); }
  const root = canon(source.root);
  try { noLinks(root); } catch { stop('document-root-invalid-or-unreadable'); }
  if (root.split(sep).some(deniedSegment)) stop('document-root-denied-segment');
  const home = canon(context.home);
  // The runtime home may sit below a root only behind a segment the walk never enters.
  if (within(home, root) || (within(root, home) && !crossesDenied(root, home, false))) stop('document-root-boundary');
  const authHomes = [join(homedir(), '.claude'), join(homedir(), '.codex'), ...(context.guard?.authHomes ?? [])].map(canon);
  if (authHomes.some(path => overlap(root, path))) stop('document-root-boundary');
  if (context.providerRoots.map(canon).some(path => overlap(root, path))) stop('document-root-boundary');
  for (const file of [context.registry, ...(context.guard?.receipts ?? [])].map(canon)) {
    if (within(root, file) && !crossesDenied(root, file, true)) stop('document-root-boundary');
  }
  if (others.some(other => other.id !== source.id && overlap(root, canon(other.root)))) stop('document-roots-overlap');
  return root;
}
export function documentRoots(sources: DocumentSourceConfig[], context: BoundaryContext): ResolvedSource[] {
  const enabled = sources.filter(source => source.enabled);
  const resolved = enabled.map(source => ({ source, root: documentRoot(source, enabled, context) }));
  if (new Set(resolved.map(item => fold(item.root))).size !== resolved.length) stop('document-roots-overlap');
  return resolved;
}
/** Private floor: a root that contains the runtime home never publishes as shared. */
export function privateFloor(root: string, home: string) { return within(canon(root), canon(home)); }
export function documentSensitivity(source: DocumentSourceConfig, home: string): 'private' | 'shared' {
  return source.sensitivity === 'shared' && source.allowSharedPublication && !privateFloor(source.root, home) ? 'shared' : 'private';
}

export type WalkedFile = { rel: string; kind: string; size: number; mtimeNs: bigint; identity: string; tooLarge: boolean };
const WALK_ENTRY_CAP = 50000;
/** Bounded, sorted, link-free walk; reports deny reasons as counts only. */
export function walkDocuments(source: DocumentSourceConfig, root: string, deadline = Infinity) {
  const files: WalkedFile[] = [];
  const denied: Record<string, number> = {};
  const deny = (reason: string) => { denied[reason] = (denied[reason] ?? 0) + 1; };
  const globs = (items: string[]) => items.map(item => glob(fold(item)));
  const include = globs(source.include), exclude = globs(source.exclude);
  // An exclude of the form `dir/**` prunes the directory itself, so large excluded trees cost no walk budget.
  const prune = globs(source.exclude.filter(item => item.endsWith('/**') && item.length > 3).map(item => item.slice(0, -3)));
  const kinds = Object.keys(source.kinds ?? {}).sort().map(kind => [kind, globs(source.kinds![kind]!)] as const);
  let complete = true, entries = 0;
  const stack: Array<[string, number]> = [['', 0]];
  while (stack.length) {
    deadlineCheck(deadline);
    const [dir, depth] = stack.pop()!;
    const folder = dir ? join(root, ...dir.split('/')) : root;
    const list: Dirent[] = [];
    try {
      noLinks(folder);
      const stat = lstatSync(folder);
      if (stat.isSymbolicLink() || !stat.isDirectory()) { deny('link'); continue; }
      const handle = opendirSync(folder);
      try {
        let entry;
        while ((entry = handle.readSync())) {
          deadlineCheck(deadline);
          if (++entries > WALK_ENTRY_CAP) stop('document-walk-cap');
          list.push(entry);
        }
      } finally { handle.closeSync(); }
    } catch (error) {
      if (error instanceof Error && error.message === 'time-budget-exhausted') throw error;
      complete = false;
      if (error instanceof Error && error.message === 'document-walk-cap') { deny('walk-cap'); break; }
      deny('unreadable'); continue;
    }
    list.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of list.toReversed()) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (!validName(entry.name)) { deny('invalid-name'); continue; }
      // A junction or symlink is never followed, whatever it points at.
      if (entry.isSymbolicLink()) { deny('link'); continue; }
      if (entry.isDirectory()) {
        if (deniedSegment(entry.name)) deny('denied-segment');
        else if (prune.some(glob => glob.match(fold(rel)))) deny('excluded-directory');
        else if (depth + 1 > source.maxDepth) deny('depth');
        else stack.push([rel, depth + 1]);
        continue;
      }
      if (!entry.isFile()) { deny('not-file'); continue; }
      if (deniedFile(entry.name)) { deny('denied-file'); continue; }
      if (!source.extensions.includes(extname(entry.name).toLowerCase())) { deny('extension'); continue; }
      const folded = fold(rel);
      if (!include.some(glob => glob.match(folded))) { deny('not-included'); continue; }
      if (exclude.some(glob => glob.match(folded))) { deny('excluded'); continue; }
      let stat: BigIntStats;
      try { stat = lstatSync(join(folder, entry.name), { bigint: true }); } catch { deny('unreadable'); complete = false; continue; }
      if (stat.isSymbolicLink() || !stat.isFile()) { deny('link'); continue; }
      if (stat.nlink !== 1n) { deny('hardlink'); continue; }
      const tooLarge = stat.size > BigInt(source.maxFileBytes);
      if (tooLarge) deny('too-large');
      files.push({ rel, kind: kinds.find(([, items]) => items.some(glob => glob.match(folded)))?.[0] ?? 'default',
        size: Number(stat.size), mtimeNs: stat.mtimeNs, identity: `${stat.dev}:${stat.ino}`, tooLarge });
    }
  }
  files.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
  return { files, denied, complete };
}

export type Section = { ordinal: number; headingPath: string[]; text: string; sha: string };
const MAX_SECTIONS = 4096;
/** Heading-aware split: ATX headings outside fenced code start a section that owns its heading line. */
export function sectionize(input: string): Section[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let fence: { char: string; size: number } | null = null;
  let path: string[] = [], body: string[] = [];
  const flush = () => {
    const text = body.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
    if (text.trim()) {
      if (sections.length >= MAX_SECTIONS) stop('document-section-limit');
      sections.push({ ordinal: sections.length, headingPath: path, text, sha: sha256('document-section-v1\n' + text) });
    }
    body = [];
  };
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const run = marker[1]!;
      if (!fence) fence = { char: run[0]!, size: run.length };
      else if (run[0] === fence.char && run.length >= fence.size && !line.slice(marker[0].length).trim()) fence = null;
    }
    const heading = fence || marker ? null : /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length, title = [...(heading[2] ?? '').trim()].slice(0, 200).join('');
      while (stack.length && stack.at(-1)!.level >= level) stack.pop();
      stack.push({ level, title });
      path = stack.map(item => item.title);
    }
    body.push(line);
  }
  flush();
  return sections;
}
const headingKey = (section: Section) => section.headingPath.join('\u0000');
const squash = (text: string) => text.replace(/\s+/gu, ' ').trim();
const numbers = (text: string) => (text.match(/\d+(?:[.,]\d+)?/g) ?? []).sort().join(' ');
const NEGATIONS = /\b(?:not|no|never|none|cannot|can't|don't|doesn't|won't|must|should|may|ne|nikoli|brez|mora|ni)\b/giu;
const negations = (text: string) => (text.toLowerCase().match(NEGATIONS) ?? []).sort().join(' ');
export const TRIVIAL_CHARS = 24;
/** A small edit of the same heading's section: whitespace only, or one short window with the same numbers and modal words. */
export function trivialEdit(before: string, after: string) {
  if (squash(before) === squash(after)) return true;
  if (numbers(before) !== numbers(after) || negations(before) !== negations(after)) return false;
  const a = [...before], b = [...after];
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const changed = Math.max(a.length - head - tail, b.length - head - tail);
  return changed <= TRIVIAL_CHARS && changed * 10 <= Math.max(a.length, b.length);
}

const DocumentReceipt = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('document'), generationId: HashSchema,
  fileKey: HashSchema, sourceId: z.string(), relativePath: z.string(), contentSha256: HashSchema,
  contentBytes: z.number().int().nonnegative(), previousGeneration: z.string().nullable(), sectionCount: z.number().int().nonnegative(),
  sectionsSha256: HashSchema, emittedSha256: HashSchema, emittedBlocks: z.number().int().nonnegative(),
  trivialEdits: z.number().int().nonnegative(), baseline: z.boolean(), semanticState: z.enum(['pending', 'no-delta']),
  privacy: z.literal('private-unredacted-document-derived; NOT a human/search index or broker input'), createdAt: z.number().finite().nonnegative() });
type DocumentReceipt = z.infer<typeof DocumentReceipt>;
const GENERATION = /^document-generations\/[a-f0-9]{64}$/u;

function same(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
/** Read the whole file once with path and handle stat checks before and after; an extra byte proves the end. */
function stableRead(path: string, limit: number, deadline: number, single = false) {
  noLinks(path);
  const before = lstatSync(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) stop('document-link');
  if (single && before.nlink !== 1n) stop('document-hardlink');
  if (before.size > BigInt(limit)) stop('document-limit');
  const fd = openSync(path, 'r');
  try {
    if (!same(before, fstatSync(fd, { bigint: true }))) stop('document-changed-during-read');
    const size = Number(before.size), raw = Buffer.alloc(size + 1);
    let bytes = 0;
    while (bytes <= size) {
      deadlineCheck(deadline);
      const n = readSync(fd, raw, bytes, size + 1 - bytes, bytes);
      if (!n) break;
      bytes += n;
    }
    noLinks(path);
    if (bytes !== size || !same(before, fstatSync(fd, { bigint: true })) || !same(before, lstatSync(path, { bigint: true }))) {
      stop('document-changed-during-read');
    }
    return { raw: raw.subarray(0, size), stat: before };
  } finally { closeSync(fd); }
}
const decode = (raw: Uint8Array) => {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return stop('document-invalid-utf8'); }
};
function writeDurable(path: string, bytes: string | Uint8Array) {
  noLinks(path);
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}

/** Verify one stored snapshot: receipt pin, content and emitted rows. Any doubt is generation-integrity. */
export function verifyDocumentGeneration(home: string, generation: string, receiptHash: string, deadline = Infinity) {
  try {
    if (!GENERATION.test(generation)) stop('generation-path');
    const directory = join(home, ...generation.split('/'));
    const raw = stableRead(join(directory, 'receipt.json'), 16384, deadline).raw;
    if (sha256(raw) !== HashSchema.parse(receiptHash)) stop('generation-integrity');
    const receipt = DocumentReceipt.parse(JSON.parse(decode(raw)));
    if (`document-generations/${receipt.generationId}` !== generation) stop('generation-integrity');
    const content = stableRead(join(directory, 'content.private'), 4 * MiB, deadline).raw;
    const body = stableRead(join(directory, 'sections.private.jsonl'), 8 * MiB, deadline).raw;
    if (content.length !== receipt.contentBytes || sha256(content) !== receipt.contentSha256 || sha256(body) !== receipt.emittedSha256) {
      stop('generation-integrity');
    }
    return { receipt, content, body };
  } catch (error) {
    throw new Error(error instanceof Error && error.message === 'time-budget-exhausted' ? 'time-budget-exhausted' : 'generation-integrity');
  }
}

function documentRow(receipt: { sourceId: string; relativePath: string; contentSha256: string }, section: Section) {
  return { source: { kind: 'document', sourceId: receipt.sourceId, relativePath: receipt.relativePath, contentSha256: receipt.contentSha256,
    ordinal: section.ordinal, headingPath: section.headingPath, sectionSha256: section.sha }, role: 'document' as const, text: section.text };
}

const DocumentJob = z.object({ id: HashSchema, file_key: HashSchema, generation: z.string(), receipt_hash: HashSchema,
  source_id: z.string(), relative_path: z.string(), state: z.literal('pending') });
/** Rows of one document job, proved against its verified snapshot by re-sectioning the content. */
export function checkedDocument(home: string, value: unknown) {
  const job = DocumentJob.parse(value);
  const { receipt, content, body } = verifyDocumentGeneration(home, job.generation, job.receipt_hash);
  // The file key binds identity; a case-only rename keeps the key, so compare folded spellings.
  if (receipt.generationId !== job.id || receipt.fileKey !== job.file_key || receipt.sourceId !== job.source_id ||
    fold(receipt.relativePath) !== fold(job.relative_path) || receipt.semanticState !== 'pending') stop('receipt-identity');
  const sections = sectionize(decode(content));
  if (sections.length !== receipt.sectionCount || digest(sections.map(section => section.sha)) !== receipt.sectionsSha256) stop('document-provenance');
  const rows = decode(body).split('\n').filter(Boolean).map(line => {
    const actual: unknown = JSON.parse(line);
    const ordinal = z.object({ source: z.object({ ordinal: z.number().int().nonnegative() }) }).parse(actual).source.ordinal;
    const section = sections[ordinal] ?? stop('document-provenance');
    const expected = documentRow(receipt, section);
    if (canonical(actual) !== canonical(expected) || canonical(expected) !== line) stop('document-provenance');
    return expected;
  });
  if (!rows.length || rows.length !== receipt.emittedBlocks) stop('document-provenance');
  return rows;
}

export function ensureDocumentTables(db: Database) {
  db.run(`CREATE TABLE IF NOT EXISTS capture_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,at REAL,source_key TEXT,kind TEXT,detail TEXT);
    CREATE TABLE IF NOT EXISTS document_files(key TEXT PRIMARY KEY,source_id TEXT NOT NULL,relative_path TEXT NOT NULL,kind TEXT NOT NULL,
      identity TEXT,observed_size INTEGER,observed_mtime TEXT,content_sha TEXT,generation TEXT,receipt_hash TEXT,state TEXT NOT NULL,
      error TEXT,retry_at REAL NOT NULL DEFAULT 0,checked_at REAL);
    CREATE TABLE IF NOT EXISTS document_jobs(id TEXT PRIMARY KEY,file_key TEXT NOT NULL,generation TEXT NOT NULL,receipt_hash TEXT NOT NULL,
      state TEXT NOT NULL,created_at REAL NOT NULL);
    CREATE TABLE IF NOT EXISTS document_sections_seen(section_sha TEXT PRIMARY KEY,file_key TEXT NOT NULL,generation TEXT NOT NULL,
      disposition TEXT NOT NULL,at REAL NOT NULL);`);
}
const FileRow = z.object({ key: HashSchema, source_id: z.string(), relative_path: z.string(), observed_size: z.number().int().nullable(),
  observed_mtime: z.string().nullable(), content_sha: HashSchema.nullable(), generation: z.string().nullable(),
  receipt_hash: HashSchema.nullable(), state: z.string(), retry_at: z.number() });
type FileRow = z.infer<typeof FileRow>;
const Binding = z.strictObject({ schemaVersion: z.literal(1), rootSha256: HashSchema, boundAt: z.number().finite().nonnegative() });
export const documentFileKey = (id: string, rel: string) => sha256(`document:${id}:${fold(rel)}`);

type Totals = { files: number; read: number; emitted: number; baseline: number; trivialEdits: number; seen: number; jobs: number;
  deleted: number; settling: number; deferred: number; tooLarge: number; errors: number };
type CaptureOptions = { retrySeconds: number; deadline: number };

/** One bounded document tick inside the caller's capture transaction. Returns counts, never paths. */
export function captureDocuments(db: Database, sources: ResolvedSource[], home: string, options: CaptureOptions) {
  ensureDocumentTables(db);
  const totals: Totals = { files: 0, read: 0, emitted: 0, baseline: 0, trivialEdits: 0, seen: 0, jobs: 0, deleted: 0,
    settling: 0, deferred: 0, tooLarge: 0, errors: 0 };
  const event = (key: string | null, kind: string, detail: string) =>
    db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,?,?,?)').run(Date.now() / 1000, key, kind, detail);
  let stopped = false;
  outer: for (const { source, root } of sources) {
    const sourceKey = sha256(`document-source:${source.id}`);
    const refused = bindRoot(db, source.id, root);
    if (refused) { totals.errors++; event(sourceKey, 'document-failed', refused); continue; }
    if (refused === null) event(sourceKey, 'configuration', 'document-root-first-bind');
    let walk: ReturnType<typeof walkDocuments>;
    try { walk = walkDocuments(source, root, options.deadline); } catch (error) {
      if (error instanceof Error && error.message === 'time-budget-exhausted') { stopped = true; break; }
      totals.errors++; event(sourceKey, 'document-failed', 'document-walk-failed'); continue;
    }
    const baselineKey = `document-baseline:${source.id}`;
    const baseline = source.initial === 'baseline' && !db.query('SELECT 1 FROM capture_settings WHERE key=?').get(baselineKey);
    const present = new Set<string>();
    let reads = 0, bytes = 0, deferred = false;
    for (const file of walk.files) {
      const key = documentFileKey(source.id, file.rel);
      present.add(key); totals.files++;
      const value = db.query('SELECT * FROM document_files WHERE key=?').get(key);
      const old = value ? FileRow.parse(value) : null;
      const now = Date.now() / 1000;
      const upsert = (state: string, error: string | null, retryAt: number) => {
        db.query('INSERT OR IGNORE INTO document_files(key,source_id,relative_path,kind,state) VALUES(?,?,?,?,?)').run(key, source.id, file.rel, file.kind, state);
        db.query('UPDATE document_files SET kind=?,state=?,error=?,retry_at=?,checked_at=? WHERE key=?').run(file.kind, state, error, retryAt, now, key);
      };
      if (file.tooLarge) { totals.tooLarge++; if (old?.state !== 'too-large') upsert('too-large', null, 0); continue; }
      if (old && old.state === 'current' && old.observed_size === file.size && old.observed_mtime === file.mtimeNs.toString()) continue;
      // A failure waits for its retry time; settling is re-judged from the current mtime on every tick.
      if (old && old.state === 'failed' && old.retry_at > now) continue;
      const settleAt = Number(file.mtimeNs) / 1e9 + source.settleSeconds;
      if (settleAt > now) { totals.settling++; upsert('settling', null, settleAt); continue; }
      if (reads >= source.maxFilesPerTick || bytes + file.size > source.maxBytesPerTick) { deferred = true; totals.deferred++; continue; }
      reads++; bytes += file.size; totals.read++;
      db.run('SAVEPOINT document_file');
      try {
        const result = captureFile(db, home, source, root, file, key, old, baseline, options.deadline);
        db.run('RELEASE document_file');
        totals.emitted += result.emitted; totals.baseline += result.baseline; totals.trivialEdits += result.trivialEdits;
        totals.seen += result.seen; totals.jobs += result.job ? 1 : 0;
      } catch (error) {
        db.run('ROLLBACK TO document_file'); db.run('RELEASE document_file');
        if (error instanceof Error && error.message === 'time-budget-exhausted') { stopped = true; break outer; }
        const known = new Set(['document-base-unverified', 'document-invalid-utf8', 'generation-integrity', 'document-limit',
          'document-hardlink', 'document-link', 'document-section-limit']);
        const code = error instanceof Error && known.has(error.message) ? error.message : 'document-invalid-or-unreadable';
        // A file that moved under the read is unsettled, not broken: retry after it settles.
        if (error instanceof Error && error.message === 'document-changed-during-read') {
          totals.settling++; upsert('settling', null, now + Math.max(1, source.settleSeconds));
        } else {
          totals.errors++; upsert('failed', code, now + options.retrySeconds); event(key, 'document-failed', code);
        }
      }
    }
    // Only a complete walk proves absence. Deleted is a state; nothing is retracted.
    if (walk.complete) {
      const live = db.query("SELECT key FROM document_files WHERE source_id=? AND state!='deleted'").all(source.id) as Array<{ key: string }>;
      for (const { key } of live) {
        if (present.has(key)) continue;
        db.query("UPDATE document_files SET state='deleted',checked_at=? WHERE key=?").run(Date.now() / 1000, key);
        event(key, 'document-checked', 'deleted'); totals.deleted++;
      }
    }
    if (baseline && walk.complete && !deferred) {
      db.query('INSERT OR IGNORE INTO capture_settings(key,value) VALUES(?,?)').run(baselineKey, JSON.stringify({ schemaVersion: 1, completedAt: Date.now() / 1000 }));
      event(sourceKey, 'configuration', 'document-baseline-complete');
    }
    // Only deferred work asks for another tick; an incomplete walk is reported, not retried in a loop.
    if (deferred) stopped = true;
  }
  return { ...totals, stopped };
}

/** Each id is bound to one root; a different root, or this root under another id, fails closed.
 * Returns null for a first bind, '' for a verified bind, else the refusal code. */
function bindRoot(db: Database, id: string, root: string): string | null {
  const rootSha256 = sha256(`document-root-v1:${fold(root)}`);
  try {
    const bound = db.query('SELECT value FROM capture_settings WHERE key=?').get(`document-root:${id}`) as { value?: unknown } | null;
    if (bound) return Binding.parse(JSON.parse(String(bound.value))).rootSha256 === rootSha256 ? '' : 'document-root-binding-mismatch';
    const taken = db.query("SELECT value FROM capture_settings WHERE key LIKE 'document-root:%'").all() as Array<{ value: string }>;
    if (taken.some(row => Binding.parse(JSON.parse(row.value)).rootSha256 === rootSha256)) return 'document-root-rebound';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') throw error;
    return 'document-root-binding-invalid';
  }
  db.query('INSERT INTO capture_settings(key,value) VALUES(?,?)').run(`document-root:${id}`,
    JSON.stringify({ schemaVersion: 1, rootSha256, boundAt: Date.now() / 1000 }));
  return null;
}

function captureFile(db: Database, home: string, source: DocumentSourceConfig, root: string, file: WalkedFile, key: string,
  old: FileRow | null, baselinePass: boolean, deadline: number) {
  const now = Date.now() / 1000;
  const { raw, stat } = stableRead(join(root, ...file.rel.split('/')), source.maxFileBytes, deadline, true);
  if (Number(stat.mtimeNs) / 1e9 + source.settleSeconds > now) stop('document-changed-during-read');
  const contentSha256 = sha256(raw);
  let previous: Section[] | null = null;
  if (old?.generation) {
    // The base must verify before any delta is computed from it; failure fails closed.
    let base: ReturnType<typeof verifyDocumentGeneration>;
    try { base = verifyDocumentGeneration(home, old.generation, HashSchema.parse(old.receipt_hash), deadline); }
    catch (error) { throw new Error(error instanceof Error && error.message === 'time-budget-exhausted' ? error.message : 'document-base-unverified'); }
    if (base.receipt.fileKey !== key || base.receipt.contentSha256 !== old.content_sha) stop('document-base-unverified');
    previous = sectionize(decode(base.content));
  }
  const update = (generation: string | null, receiptHash: string | null) => {
    db.query('INSERT OR IGNORE INTO document_files(key,source_id,relative_path,kind,state) VALUES(?,?,?,?,?)').run(key, source.id, file.rel, file.kind, 'current');
    db.query(`UPDATE document_files SET relative_path=?,kind=?,identity=?,observed_size=?,observed_mtime=?,content_sha=coalesce(?,content_sha),
      generation=coalesce(?,generation),receipt_hash=coalesce(?,receipt_hash),state='current',error=NULL,retry_at=0,checked_at=? WHERE key=?`)
      .run(file.rel, file.kind, `${stat.dev}:${stat.ino}`, Number(stat.size), stat.mtimeNs.toString(), generation ? contentSha256 : null, generation, receiptHash, now, key);
  };
  if (old?.content_sha === contentSha256) { update(null, null); return { emitted: 0, baseline: 0, trivialEdits: 0, seen: 0, job: false }; }
  const sections = sectionize(decode(raw));
  const generationId = sha256(`document-generation-v1:${key}:${contentSha256}:${old?.generation ?? 'none'}`);
  const generation = `document-generations/${generationId}`;
  const baseline = baselinePass && !old?.generation;
  const seenQuery = db.query('SELECT 1 FROM document_sections_seen WHERE section_sha=?');
  const mark = db.query('INSERT OR IGNORE INTO document_sections_seen(section_sha,file_key,generation,disposition,at) VALUES(?,?,?,?,?)');
  const emitted: Section[] = [];
  let trivialEdits = 0, seen = 0, baselineCount = 0;
  for (const section of sections) {
    deadlineCheck(deadline);
    // Cross-source: a section hash seen anywhere, in any source, is never emitted again.
    if (seenQuery.get(section.sha)) { seen++; continue; }
    if (baseline) { mark.run(section.sha, key, generation, 'baseline', now); baselineCount++; continue; }
    const prior = (previous ?? []).filter(item => headingKey(item) === headingKey(section));
    const match = prior.find(item => item.ordinal === section.ordinal) ?? prior[0];
    if (match && trivialEdit(match.text, section.text)) { mark.run(section.sha, key, generation, 'trivial-edit', now); trivialEdits++; continue; }
    mark.run(section.sha, key, generation, 'emitted', now);
    emitted.push(section);
  }
  const identity = { sourceId: source.id, relativePath: file.rel, contentSha256 };
  const body = emitted.map(section => canonical(documentRow(identity, section)) + '\n').join('');
  const expected = { schemaVersion: 1 as const, kind: 'document' as const, generationId, fileKey: key, sourceId: source.id, relativePath: file.rel,
    contentSha256, contentBytes: raw.length, previousGeneration: old?.generation ?? null, sectionCount: sections.length,
    sectionsSha256: digest(sections.map(section => section.sha)), emittedSha256: sha256(body), emittedBlocks: emitted.length, trivialEdits, baseline,
    semanticState: emitted.length ? 'pending' as const : 'no-delta' as const,
    privacy: 'private-unredacted-document-derived; NOT a human/search index or broker input' as const };
  const directory = join(home, ...generation.split('/'));
  let receiptHash: string;
  if (existsSync(directory)) {
    // An orphan from a rolled-back tick is reused only if it is exactly this snapshot.
    const existing = stableRead(join(directory, 'receipt.json'), 16384, deadline).raw;
    receiptHash = sha256(existing);
    const { createdAt: _, ...saved } = verifyDocumentGeneration(home, generation, receiptHash, deadline).receipt;
    if (canonical(saved) !== canonical(expected)) stop('generation-integrity');
  } else {
    const encoded = JSON.stringify({ ...expected, createdAt: now }) + '\n';
    const stage = join(home, 'staging', `document-${generationId}-${randomUUID()}`);
    noLinks(stage); mkdirSync(stage, { recursive: true });
    writeDurable(join(stage, 'content.private'), raw);
    writeDurable(join(stage, 'sections.private.jsonl'), body);
    writeDurable(join(stage, 'receipt.json'), encoded);
    noLinks(directory); mkdirSync(dirname(directory), { recursive: true });
    renameSync(stage, directory);
    receiptHash = sha256(encoded);
  }
  verifyDocumentGeneration(home, generation, receiptHash, deadline);
  if (emitted.length) db.query('INSERT OR IGNORE INTO document_jobs VALUES(?,?,?,?,?,?)').run(generationId, key, generation, receiptHash, 'pending', now);
  update(generation, receiptHash);
  db.query('INSERT INTO events(at,source_key,kind,detail) VALUES(?,?,?,?)').run(now, key, 'document-checked',
    baseline ? 'baseline' : emitted.length ? 'delta' : trivialEdits ? 'trivial-edit' : 'no-delta');
  return { emitted: emitted.length, baseline: baselineCount, trivialEdits, seen, job: emitted.length > 0 };
}

function tables(db: Database) {
  return new Set((db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(row => row.name));
}
const PendingDocumentJob = DocumentJob.extend({ created_at: z.number() });
/** Slice one pending document job of an enabled source. Mirrors prepareSlices; transcript jobs are never selected. */
export function prepareDocumentSlices(home: string, sourceIds: string[], maxChars = 16000, execute = false) {
  if (!execute) return { state: 'plan', writes: false };
  using db = openStore(join(home, 'queue.sqlite3'), { readonly: false });
  if (!tables(db).has('document_jobs') || !sourceIds.length) return { state: 'idle', writes: false };
  db.run(`CREATE TABLE IF NOT EXISTS slice_plans(job_id TEXT PRIMARY KEY,plan_sha TEXT,version INTEGER,slice_count INTEGER,created_at REAL);
    CREATE TABLE IF NOT EXISTS slices(id TEXT PRIMARY KEY,job_id TEXT,ordinal INTEGER,payload_json TEXT,payload_sha TEXT,state TEXT,UNIQUE(job_id,ordinal));
    CREATE TABLE IF NOT EXISTS slice_failures(job_id TEXT PRIMARY KEY,code TEXT,at REAL);`);
  const broken = db.query(`SELECT p.job_id FROM slice_plans p LEFT JOIN slices s ON p.job_id=s.job_id
    GROUP BY p.job_id HAVING count(s.id)!=p.slice_count OR min(s.ordinal)!=0 OR max(s.ordinal)!=p.slice_count-1 LIMIT 1`).get();
  if (broken) throw new Error('slice-plan-integrity');
  const enabled = new Set(sourceIds);
  let job: z.infer<typeof PendingDocumentJob> | undefined;
  const selection = db.prepare(`SELECT d.*,f.source_id,f.relative_path FROM document_jobs d JOIN document_files f ON f.key=d.file_key
    WHERE d.state='pending' AND NOT EXISTS(SELECT 1 FROM slice_plans p WHERE p.job_id=d.id)
    AND NOT EXISTS(SELECT 1 FROM slice_failures x WHERE x.job_id=d.id) ORDER BY d.created_at,d.id`);
  try {
    for (const row of selection.iterate()) {
      const candidate = PendingDocumentJob.parse(row);
      if (enabled.has(candidate.source_id)) { job = candidate; break; }
    }
  } finally { selection.finalize(); }
  if (!job) return { state: 'idle', writes: false };
  try {
    const plan = buildSlices(checkedDocument(home, job), job.id, job.receipt_hash, maxChars);
    return db.transaction(() => {
      const current = z.object({ receipt_hash: HashSchema, state: z.string() }).parse(db.query('SELECT receipt_hash,state FROM document_jobs WHERE id=?').get(job!.id));
      if (current.receipt_hash !== job!.receipt_hash || current.state !== 'pending') stop('source-job-changed');
      const existing = db.query('SELECT plan_sha FROM slice_plans WHERE job_id=?').get(job!.id);
      if (existing) {
        if (z.object({ plan_sha: HashSchema }).parse(existing).plan_sha !== plan.planSha256) stop('slice-plan-conflict');
        return { state: 'already-planned', writes: false };
      }
      for (const item of plan.slices) db.query('INSERT INTO slices VALUES(?,?,?,?,?,?)').run(item.sliceId, job!.id, item.index, canonical(item), digest(item), 'pending');
      db.query('INSERT INTO slice_plans VALUES(?,?,?,?,?)').run(job!.id, plan.planSha256, 1, plan.sliceCount, Date.now() / 1000);
      return { state: 'prepared', lane: 'document', jobId: job!.id, slices: plan.sliceCount, accepted: false, redactionKinds: plan.redactionKinds };
    }).immediate();
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'SQLITE_BUSY') return { state: 'busy', writes: false };
    db.query('INSERT OR IGNORE INTO slice_failures VALUES(?,?,?)').run(job.id, 'preparation-blocked', Date.now() / 1000);
    return { state: 'blocked', lane: 'document', jobId: job.id, code: 'preparation-blocked', accepted: false };
  }
}

/** The first pending document slice of an enabled source, in job order. */
export function selectDocumentSlice(db: Database, sourceIds: string[]) {
  if (!sourceIds.length || !tables(db).has('document_jobs') || !tables(db).has('slices')) return undefined;
  const enabled = new Set(sourceIds);
  const selection = db.prepare(`SELECT d.*,f.source_id,f.relative_path,w.id AS slice_id,w.ordinal,w.payload_json,w.payload_sha
    FROM slices w JOIN document_jobs d ON w.job_id=d.id JOIN document_files f ON d.file_key=f.key
    WHERE w.state='pending' AND d.state='pending' ORDER BY d.created_at,d.id,w.ordinal`);
  try {
    for (const value of selection.iterate()) {
      const row = z.record(z.string(), z.unknown()).parse(value);
      if (enabled.has(String(row.source_id))) return row;
    }
  } finally { selection.finalize(); }
  return undefined;
}

const sizeBucket = (size: number) => size < KiB ? '<1KiB' : size < 16 * KiB ? '1-16KiB' : size < 64 * KiB ? '16-64KiB' : size < 256 * KiB ? '64-256KiB' : '>=256KiB';
const countBy = <T,>(items: T[], key: (item: T) => string) => items.reduce<Record<string, number>>((acc, item) => {
  const name = key(item); acc[name] = (acc[name] ?? 0) + 1; return acc; }, {});

/** Read-only inventory: counts by source, kind, size bucket and deny reason. Never prints a path. */
export function documentsReport(sources: DocumentSourceConfig[], context: BoundaryContext) {
  const enabled = sources.filter(source => source.enabled);
  const database = join(context.home, 'queue.sqlite3');
  let queue: Database | null = null;
  try { noLinks(database); if (existsSync(database)) queue = openStore(database, { readonly: true }); } catch { queue = null; }
  try {
    const known = queue ? tables(queue) : new Set<string>();
    const rows = (sql: string, ...args: string[]) => queue && known.has('document_files')
      ? Object.fromEntries((queue.query(sql).all(...args) as Array<{ state: string; n: number }>).map(row => [row.state, row.n])) : {};
    const report = sources.map(source => {
      const base = { id: source.id, enabled: source.enabled, configuredSensitivity: source.sensitivity };
      let root: string;
      try { root = documentRoot(source, source.enabled ? enabled : [...enabled, source], context); }
      catch (error) { return { ...base, state: 'boundary-refused', code: error instanceof Error && /^document-[a-z-]+$/.test(error.message) ? error.message : 'document-root-invalid' }; }
      const walk = walkDocuments(source, root);
      const eligible = walk.files.filter(file => !file.tooLarge);
      return { ...base, state: walk.complete ? 'inventoried' : 'partial-inventory', privateFloor: privateFloor(root, context.home),
        effectiveSensitivity: documentSensitivity(source, context.home), files: eligible.length,
        byKind: countBy(eligible, file => file.kind), bySize: countBy(eligible, file => sizeBucket(file.size)), denied: walk.denied,
        queue: { files: rows('SELECT state,count(*) AS n FROM document_files WHERE source_id=? GROUP BY state', source.id),
          jobs: known.has('document_jobs') ? rows(`SELECT d.state,count(*) AS n FROM document_jobs d JOIN document_files f ON f.key=d.file_key
            WHERE f.source_id=? GROUP BY d.state`, source.id) : {} } };
    });
    const seen = queue && known.has('document_sections_seen')
      ? Object.fromEntries((queue.query('SELECT disposition AS state,count(*) AS n FROM document_sections_seen GROUP BY disposition').all() as Array<{ state: string; n: number }>)
        .map(row => [row.state, row.n])) : {};
    return { schemaVersion: 1 as const, boundary: 'Read-only document inventory; counts only, no paths, no reads of file content.',
      sources: report, sectionsSeen: seen, writes: false as const };
  } finally { queue?.close(); }
}
