import { afterEach, expect, test } from './expect.mts';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/sqlite.mts';
import { CaptureConfig, runCapture, sha256 } from '../src/capture.mts';
import { checkedDocument, deniedFile, deniedSegment, DocumentSource, documentRoots, documentSensitivity, prepareDocumentSlices,
  privateFloor, sectionize, trivialEdit, walkDocuments, type DocumentSourceConfig } from '../src/documents.mts';
import { buildSlices, coverage, DOCUMENT_BOUNDARY } from '../src/slicing.mts';
import { SliceSchema } from '../src/output.mts';
import { prepareSlices, verifyStoredSlice } from '../src/slice-queue.mts';
import { consumeSlice, type ModelRequest, type ModelResult } from '../src/consumer.mts';
import { markDispatch, reserve, setup } from '../src/store.mts';
import { recover, type RecoveryProbes } from '../src/recovery.mts';
import { publishPending, type BrokerTransport } from '../src/publication.mts';
import { decide, listForReview } from '../src/review.mts';
import { runDaily } from '../src/daily.mts';
import { canonical } from '../src/slicing.mts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const REGISTRY = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
let clock = Math.floor(Date.now() / 1000) - 7200;
/** Writes with a distinct past mtime, so a same-size edit is still a visible change and nothing is settling. */
function put(path: string, text: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); clock += 2; utimesSync(path, clock, clock);
}
function world(layout: { home?: string; docs?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acb-documents-')); roots.push(root);
  const codex = join(root, 'codex'), home = join(root, layout.home ?? 'home'), docs = join(root, layout.docs ?? 'docs');
  mkdirSync(codex); mkdirSync(docs, { recursive: true });
  const registry = join(root, 'history.json'); writeFileSync(registry, REGISTRY);
  const source = (overrides: Record<string, unknown> = {}) => ({ id: 'notes', root: docs, enabled: true, sensitivity: 'private', settleSeconds: 0, ...overrides });
  const config = (documentSources: unknown[] = [source()], extra: Record<string, unknown> = {}) => ({ providerRoots: { codex },
    historyRegistry: { path: registry, sha256: sha256(REGISTRY) }, reserveBytes: 1, retrySeconds: 1, documentSources, ...extra });
  return { root, codex, home, docs, registry, source, config };
}
function query(home: string, sql: string, ...args: string[]) {
  using db = new Database(join(home, 'queue.sqlite3'), { readonly: true });
  return db.query(sql).all(...args) as Record<string, unknown>[];
}
function tableNames(home: string) { return query(home, "SELECT name FROM sqlite_master WHERE type='table'").map(row => String(row.name)); }
const turn = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n';
const parsed = (value: Record<string, unknown>) => DocumentSource.parse(value);

test('document source schema is strict, disabled by default and bounded', () => {
  const value = parsed({ id: 'notes', root: 'C:/x', sensitivity: 'private' });
  expect(value).toMatchObject({ enabled: false, allowSharedPublication: false, include: ['**/*'], exclude: [], extensions: ['.md'],
    initial: 'baseline', maxFileBytes: 256 * 1024, maxFilesPerTick: 8, maxBytesPerTick: 1024 * 1024, settleSeconds: 120, maxDepth: 8 });
  expect(value.kinds).toBeUndefined();
  expect(() => parsed({ id: 'notes', root: 'C:/x' })).toThrow();
  expect(() => parsed({ id: 'notes', root: 'C:/x', sensitivity: 'private', follow: true })).toThrow();
  expect(() => parsed({ id: 'Bad_Id', root: 'C:/x', sensitivity: 'private' })).toThrow();
  expect(() => parsed({ id: 'notes', root: 'C:/x', sensitivity: 'public' })).toThrow();
  expect(() => parsed({ id: 'notes', root: 'C:/x', sensitivity: 'private', maxFileBytes: 2048, maxBytesPerTick: 1024 })).toThrow();
  expect(() => parsed({ id: 'notes', root: 'C:/x', sensitivity: 'private', include: ['../outside/**'] })).toThrow();
  const w = world();
  expect(CaptureConfig.parse(w.config([])).documentSources).toEqual([]);
  expect(CaptureConfig.parse({ ...w.config(), documentSources: undefined }).documentSources).toEqual([]);
  expect(() => CaptureConfig.parse(w.config([w.source(), w.source()]))).toThrow('document-source-duplicate-id');
});

test('empty or disabled document sources leave capture, daily and the queue schema unchanged', async () => {
  for (const sources of [[], undefined, 'disabled'] as const) {
    const w = world();
    put(join(w.codex, 'a.jsonl'), turn('Keep evidence private.'));
    // Invalid UTF-8 would fail loudly if a disabled source were ever read.
    put(join(w.docs, 'broken.md'), Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
    const documentSources = sources === 'disabled' ? [w.source({ enabled: false })] : sources;
    const capture = { ...w.config([]), ...(documentSources === undefined ? { documentSources: undefined } : { documentSources }) };
    expect(runCapture(capture, w.home)).toEqual({ mode: 'plan', writes: false, providerCount: 1, fullyCurrent: false, rootBinding: 'would-bind-new-queue' });
    const result = await runDaily({ capture, semantic: { claudeAvailable: true, attemptSeconds: 60, documentMaxSecondsPerDay: 600 } }, w.home, true,
      async (r: ModelRequest): Promise<ModelResult> => ({ state: 'output', completionProof: 'synthetic-fixture', durationMs: 1,
        output: { schemaVersion: 1, sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: 'no-durable-findings', observations: [] } }),
      { synthetic: true, now: Date.UTC(2026, 9, 5, 12) / 1000 }) as { capture: unknown[]; attempts: unknown[] };
    expect(Object.keys(result)).not.toContain('preparedDocuments');
    expect(result.capture[0]).toEqual({ state: 'complete-tick', processed: 1, errors: 0, legacyUnresolved: 0, fullyCurrent: false });
    expect(result.attempts[0]).toMatchObject({ state: 'pending-review' });
    expect(result.attempts[0]).not.toHaveProperty('lane');
    expect(tableNames(w.home).filter(name => name.startsWith('document_'))).toEqual([]);
    expect(query(w.home, 'PRAGMA table_info(semantic_attempts)').map(row => row.name)).not.toContain('lane');
    expect(query(w.home, "SELECT count(*) AS n FROM capture_settings WHERE key LIKE 'document-%'")[0]!.n).toBe(0);
  }
});

test('hard denylist: segments, file patterns, links, hardlinks, depth, extension and globs', () => {
  expect(['.git', 'node_modules', 'runtime', 'credentials', 'secrets', '.claude', '.codex', 'worktrees', 'backups', '.home-skill-backups',
    'archives', 'tmp', '.tmp', 'dist', 'attachments', 'TestResults', '.venv', 'Runtime'].every(deniedSegment)).toBe(true);
  expect(['docs', 'notes', 'runtimes', 'temp'].some(deniedSegment)).toBe(false);
  expect(['.env', '.env.local', '.env.md', 'cert.pem', 'key', 'server.key', 'id.pfx', 'id.p12', 'oauth-auth.json', 'auth.json',
    'my-credentials.md', 'Credential-notes.md', 'queue.sqlite3', 'a.sqlite', 'settings.local.json'].every(deniedFile)).toBe(true);
  expect(['notes.md', 'keys.md', 'author.md', 'settings.json', 'monkey.md'].some(deniedFile)).toBe(false);
  const w = world();
  for (const rel of ['a.md', 'sub/b.md', 'plans/p.md', 'drafts/d.md', '.git/x.md', 'node_modules/m.md', 'runtime/r.md', 'TestResults/t.md',
    'secrets/s.md', 'nested/.claude/c.md', '.env.md', 'my-credentials.md', 'notes.txt', 'l1/l2/l3/deep.md', 'Big.md'])
    put(join(w.docs, ...rel.split('/')), rel === 'Big.md' ? '# big\n' + 'x'.repeat(4096) : `# ${rel}\nbody\n`);
  put(join(w.root, 'outside', 'o.md'), '# outside\n');
  symlinkSync(join(w.root, 'outside'), join(w.docs, 'junction'), 'junction');
  put(join(w.root, 'outside', 'linked-original.md'), '# linked\n');
  linkSync(join(w.root, 'outside', 'linked-original.md'), join(w.docs, 'linked.md'));
  const source = parsed(w.source({ exclude: ['drafts/**'], kinds: { plan: ['plans/**'] }, maxDepth: 2, maxFileBytes: 1024 }));
  const walk = walkDocuments(source, w.docs);
  expect(walk.complete).toBe(true);
  expect(walk.files.map(file => [file.rel, file.kind, file.tooLarge])).toEqual([
    ['Big.md', 'default', true], ['a.md', 'default', false], ['plans/p.md', 'plan', false], ['sub/b.md', 'default', false]]);
  // `dir/**` prunes the directory before it is opened.
  expect(walk.denied).toEqual({ 'denied-segment': 6, 'denied-file': 2, extension: 1, 'excluded-directory': 1, depth: 1, link: 1, hardlink: 1, 'too-large': 1 });
  // Other patterns filter files only, after the hard denylist.
  const filtered = walkDocuments(parsed(w.source({ exclude: ['drafts/*.md', 'sub/b.md'], include: ['**/*.md'], maxDepth: 2, maxFileBytes: 1024 })), w.docs);
  expect(filtered.denied).toMatchObject({ excluded: 2 });
  expect(filtered.denied).not.toHaveProperty('excluded-directory');
  expect(filtered.files.map(file => file.rel)).toEqual(['Big.md', 'a.md', 'plans/p.md']);
});

test('root boundary rules: runtime home, auth homes, registry, receipts, provider and document roots', () => {
  const ok = world({ docs: 'ws', home: 'ws/runtime/home' });
  const context = (w: ReturnType<typeof world>, guard = {}) => ({ home: w.home, providerRoots: [w.codex], registry: w.registry, guard });
  const one = (w: ReturnType<typeof world>, overrides: Record<string, unknown> = {}) => [parsed(w.source(overrides))];
  // The runtime home may sit below a root only behind a denied segment, and then the floor is private.
  expect(documentRoots(one(ok), context(ok))).toHaveLength(1);
  expect(privateFloor(ok.docs, ok.home)).toBe(true);
  expect(documentSensitivity(parsed(ok.source({ sensitivity: 'shared', allowSharedPublication: true })), ok.home)).toBe('private');
  const plain = world();
  expect(documentSensitivity(parsed(plain.source({ sensitivity: 'shared', allowSharedPublication: true })), plain.home)).toBe('shared');
  expect(documentSensitivity(parsed(plain.source({ sensitivity: 'shared' })), plain.home)).toBe('private');
  expect(documentSensitivity(parsed(plain.source()), plain.home)).toBe('private');
  const exposed = world({ docs: 'ws', home: 'ws/state/home' });
  expect(() => documentRoots(one(exposed), context(exposed))).toThrow('document-root-boundary');
  const inside = world({ docs: 'home/docs' });
  expect(() => documentRoots(one(inside), context(inside))).toThrow('document-root-boundary');
  expect(() => documentRoots(one(plain, { root: plain.root }), context(plain))).toThrow('document-root-boundary');
  expect(() => documentRoots(one(plain, { root: join(plain.codex) }), context(plain))).toThrow('document-root-boundary');
  expect(() => documentRoots(one(plain), context(plain, { authHomes: [join(plain.docs, 'auth')] }))).toThrow('document-root-boundary');
  expect(() => documentRoots(one(plain), context(plain, { authHomes: [plain.root] }))).toThrow('document-root-boundary');
  expect(() => documentRoots(one(plain), context(plain, { receipts: [join(plain.docs, 'capability.json')] }))).toThrow('document-root-boundary');
  expect(documentRoots(one(plain), context(plain, { receipts: [join(plain.docs, 'runtime', 'capability.json')] }))).toHaveLength(1);
  expect(() => documentRoots(one(plain), { ...context(plain), registry: join(plain.docs, 'history.json') })).toThrow('document-root-boundary');
  expect(documentRoots(one(plain), { ...context(plain), registry: join(plain.docs, 'runtime', 'history.json') })).toHaveLength(1);
  mkdirSync(join(plain.docs, 'sub'));
  const nested = [parsed(plain.source()), parsed(plain.source({ id: 'sub', root: join(plain.docs, 'sub') }))];
  expect(() => documentRoots(nested, context(plain))).toThrow('document-roots-overlap');
  expect(documentRoots([nested[0]!, { ...nested[1]!, enabled: false }], context(plain))).toHaveLength(1);
  mkdirSync(join(plain.root, 'tmp', 'docs'), { recursive: true });
  expect(() => documentRoots(one(plain, { root: join(plain.root, 'tmp', 'docs') }), context(plain))).toThrow('document-root-denied-segment');
  symlinkSync(plain.docs, join(plain.root, 'docs-junction'), 'junction');
  expect(() => documentRoots(one(plain, { root: join(plain.root, 'docs-junction') }), context(plain))).toThrow('document-root-invalid-or-unreadable');
  expect(() => documentRoots(one(plain, { root: join(plain.root, 'missing') }), context(plain))).toThrow('document-root-invalid-or-unreadable');
  // A disabled source is inert: no boundary check, no read.
  expect(documentRoots(one(plain, { root: plain.root, enabled: false }), context(plain))).toEqual([]);
  // runCapture applies the same rules before creating anything.
  expect(() => runCapture(exposed.config(), exposed.home)).toThrow('document-root-boundary');
  expect(existsSync(exposed.home)).toBe(false);
});

test('each source id stays bound to its root; rebinding fails closed for that source only', () => {
  const w = world(); put(join(w.docs, 'a.md'), '# A\nalpha\n');
  const other = join(w.root, 'other'); put(join(other, 'b.md'), '# B\nbeta\n');
  put(join(w.codex, 'a.jsonl'), turn('transcripts keep flowing'));
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ state: 'complete-tick', documents: { errors: 0, baseline: 1 } });
  expect(runCapture(w.config([w.source({ root: other })]), w.home, true)).toMatchObject({ state: 'partial', errors: 0, documents: { errors: 1, read: 0 } });
  expect(runCapture(w.config([w.source({ id: 'renamed' })]), w.home, true)).toMatchObject({ documents: { errors: 1, read: 0 } });
  expect(query(w.home, "SELECT detail FROM events WHERE kind='document-failed'").map(row => row.detail))
    .toEqual(['document-root-binding-mismatch', 'document-root-rebound']);
  expect(query(w.home, 'SELECT * FROM jobs')).toHaveLength(1);
});

test('sectionizer is heading-aware and ignores headings inside fenced code', () => {
  const sections = sectionize('preamble line\r\n\r\n# Top\nintro\n```\n# not a heading\n```\n## Child ##\nchild text\n### Leaf\nleaf\n# Next\n\n\nnext text\n');
  expect(sections.map(item => [item.headingPath, item.text])).toEqual([
    [[], 'preamble line'], [['Top'], '# Top\nintro\n```\n# not a heading\n```'], [['Top', 'Child'], '## Child ##\nchild text'],
    [['Top', 'Child', 'Leaf'], '### Leaf\nleaf'], [['Next'], '# Next\n\n\nnext text']]);
  expect(new Set(sections.map(item => item.sha)).size).toBe(5);
  expect(sectionize('   \n\n')).toEqual([]);
  expect(trivialEdit('beta text two', 'beta text too')).toBe(true);
  expect(trivialEdit('a  b\nc', 'a b c')).toBe(true);
  expect(trivialEdit('retain logs for 7 days', 'retain logs for 14 days')).toBe(false);
  expect(trivialEdit('you must deploy on friday', 'you must not deploy on friday')).toBe(false);
  expect(trivialEdit('short', 'a completely different sentence about another subject')).toBe(false);
});

test('baseline marks first sight as seen; later deltas emit only unseen non-trivial sections', () => {
  const w = world();
  const a = join(w.docs, 'a.md');
  put(a, '# A\nretain logs for 7 days in the archive\n\n## B\nbeta text two about the queue\n');
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ state: 'complete-tick', documents: { read: 1, baseline: 2, emitted: 0, jobs: 0 } });
  expect(query(w.home, "SELECT key FROM capture_settings WHERE key='document-baseline:notes'")).toHaveLength(1);
  put(a, '# A\nretain logs for 7 days in the archive\n\n## B\nbeta text two about the queue\n\n## C\ngamma is a brand new section\n');
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ documents: { read: 1, emitted: 1, seen: 2, jobs: 1 } });
  const [job] = query(w.home, 'SELECT d.*,f.source_id,f.relative_path FROM document_jobs d JOIN document_files f ON f.key=d.file_key');
  const rows = checkedDocument(w.home, job);
  expect(rows.map(row => [row.source.headingPath, row.text, row.role])).toEqual([[['A', 'C'], '## C\ngamma is a brand new section', 'document']]);
  // A typo is recorded as trivial-edit, a changed number is a new claim.
  put(a, '# A\nretain logs for 7 days in the archive\n\n## B\nbeta text too about the queue\n\n## C\ngamma is a brand new section\n');
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ documents: { trivialEdits: 1, emitted: 0, jobs: 0 } });
  put(a, '# A\nretain logs for 14 days in the archive\n\n## B\nbeta text too about the queue\n\n## C\ngamma is a brand new section\n');
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ documents: { emitted: 1, jobs: 1 } });
  // Restoring an older version re-emits nothing: every section hash was already seen.
  put(a, '# A\nretain logs for 7 days in the archive\n\n## B\nbeta text two about the queue\n');
  expect(runCapture(w.config(), w.home, true)).toMatchObject({ documents: { emitted: 0, jobs: 0, seen: 2 } });
  // A new file after the baseline pass is distilled; a copied section, here or in another source, is not.
  put(join(w.docs, 'n.md'), '# N\nfresh notes written after the baseline\n\n## C\ngamma is a brand new section\n');
  const other = join(w.root, 'other'); put(join(other, 'copy.md'), '## C\ngamma is a brand new section\n');
  const both = [w.source(), w.source({ id: 'other', root: other, initial: 'distill' })];
  expect(runCapture(w.config(both), w.home, true)).toMatchObject({ documents: { emitted: 1, seen: 2, jobs: 1 } });
  expect(query(w.home, 'SELECT disposition,count(*) AS n FROM document_sections_seen GROUP BY disposition ORDER BY disposition'))
    .toEqual([{ disposition: 'baseline', n: 2 }, { disposition: 'emitted', n: 3 }, { disposition: 'trivial-edit', n: 1 }]);
  // Deleting marks the file; its jobs and seen sections stay.
  unlinkSync(a);
  expect(runCapture(w.config(both), w.home, true)).toMatchObject({ documents: { deleted: 1 } });
  expect(query(w.home, 'SELECT state FROM document_files WHERE relative_path=?', 'a.md')).toEqual([{ state: 'deleted' }]);
  expect(query(w.home, 'SELECT * FROM document_jobs')).toHaveLength(3);
});

test('initial distill emits first sight; settle, per-tick limits and too-large files are respected', () => {
  const w = world();
  for (const name of ['a', 'b', 'c']) put(join(w.docs, `${name}.md`), `# ${name}\nsection body for ${name} with enough words\n`);
  const config = (overrides = {}) => w.config([w.source({ initial: 'distill', maxFilesPerTick: 1, ...overrides })]);
  expect(runCapture(config(), w.home, true)).toMatchObject({ state: 'partial', documents: { read: 1, deferred: 2, jobs: 1 } });
  expect(runCapture(config(), w.home, true)).toMatchObject({ documents: { read: 1, deferred: 1, jobs: 1 } });
  expect(runCapture(config(), w.home, true)).toMatchObject({ state: 'complete-tick', documents: { read: 1, deferred: 0, jobs: 1 } });
  writeFileSync(join(w.docs, 'd.md'), '# d\njust written, still settling\n');
  expect(runCapture(config({ settleSeconds: 3600 }), w.home, true)).toMatchObject({ documents: { read: 0, settling: 1 } });
  expect(query(w.home, 'SELECT state FROM document_files WHERE relative_path=?', 'd.md')).toEqual([{ state: 'settling' }]);
  utimesSync(join(w.docs, 'd.md'), clock - 7200, clock - 7200);
  expect(runCapture(config({ settleSeconds: 3600 }), w.home, true)).toMatchObject({ documents: { read: 1, jobs: 1, settling: 0 } });
  put(join(w.docs, 'e.md'), '# e\n' + 'y'.repeat(2048));
  expect(runCapture(config({ maxFileBytes: 1024, maxBytesPerTick: 4096 }), w.home, true)).toMatchObject({ documents: { read: 0, tooLarge: 1 } });
  expect(query(w.home, 'SELECT state FROM document_files WHERE relative_path=?', 'e.md')).toEqual([{ state: 'too-large' }]);
});

test('a snapshot that fails verification fails closed: no delta, no job, no advance', () => {
  const w = world(); const a = join(w.docs, 'a.md');
  put(a, '# A\nfirst version of the document body\n');
  runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true);
  const [before] = query(w.home, 'SELECT generation,content_sha FROM document_files');
  appendFileSync(join(w.home, String(before!.generation), 'content.private'), 'tampered');
  put(a, '# A\nfirst version of the document body\n\n## B\na new section that must not be emitted\n');
  expect(runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true)).toMatchObject({ state: 'partial', documents: { errors: 1, jobs: 0 } });
  expect(query(w.home, 'SELECT state,error,generation,content_sha FROM document_files')).toEqual([{ state: 'failed', error: 'document-base-unverified',
    generation: before!.generation, content_sha: before!.content_sha }]);
  expect(query(w.home, 'SELECT * FROM document_jobs')).toHaveLength(1);
  expect(query(w.home, 'SELECT count(*) AS n FROM document_sections_seen')[0]!.n).toBe(1);
});

test('document slices carry the document boundary and role and are proved against the snapshot', () => {
  const w = world(); put(join(w.docs, 'a.md'), '# A\nDecision: keep one worker for the queue.\n\n## B\nRetention is 14 days.\n');
  runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true);
  expect(prepareDocumentSlices(w.home, ['notes'], 16000, true)).toMatchObject({ state: 'prepared', lane: 'document', slices: 1 });
  expect(prepareDocumentSlices(w.home, ['notes'], 16000, true)).toMatchObject({ state: 'idle' });
  expect(prepareSlices(w.home, [], 16000, true)).toMatchObject({ state: 'idle' });
  const [row] = query(w.home, 'SELECT * FROM slices');
  const item = verifyStoredSlice(row);
  expect(item.contextBoundary).toBe(DOCUMENT_BOUNDARY);
  expect(item.segments.map(segment => segment.role)).toEqual(['document', 'document']);
  expect(JSON.stringify(item)).not.toContain('a.md');
  expect(() => SliceSchema.parse({ ...item, contextBoundary: 'partial historical dialogue; no inferred earlier context' })).toThrow();
  expect(() => buildSlices([{ role: 'document', text: 'x' }, { role: 'user', text: 'y' }], 'a'.repeat(64), 'b'.repeat(64))).toThrow('dialogue-shape');
  const [job] = query(w.home, 'SELECT d.*,f.source_id,f.relative_path FROM document_jobs d JOIN document_files f ON f.key=d.file_key');
  writeFileSync(join(w.home, String(job!.generation), 'sections.private.jsonl'), '{}\n');
  expect(() => checkedDocument(w.home, job)).toThrow('generation-integrity');
});

function answer(r: ModelRequest, summary?: string): Promise<ModelResult> {
  return Promise.resolve({ state: 'output', completionProof: 'synthetic-fixture', durationMs: 1,
    output: { schemaVersion: 1, sliceId: r.slice.sliceId, coverage: coverage(r.slice), disposition: summary ? 'findings' : 'no-durable-findings',
      observations: summary ? [{ kind: 'constraint', summary, sourceRefs: coverage(r.slice).filter(span => span.endChar > span.startChar) }] : [] } });
}
const NOW = Date.UTC(2026, 9, 5, 12) / 1000;
function lanes(count = 2) {
  const w = world();
  for (let i = 0; i < count; i++) {
    put(join(w.codex, `t${i}.jsonl`), turn(`Transcript decision number ${i} keeps the queue single-writer.`));
    put(join(w.docs, `d${i}.md`), `# D${i}\nDocument decision number ${i} keeps the archive private.\n`);
  }
  runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true);
  while (prepareSlices(w.home, [], 16000, true).state === 'prepared');
  while (prepareDocumentSlices(w.home, ['notes'], 16000, true).state === 'prepared');
  return w;
}

test('lane cap: zero means no document attempts; a cap allows alternation until it is spent', async () => {
  const off = lanes(1);
  const policy = { claudeAvailable: true, attemptSeconds: 60 };
  const documents = { sourceIds: ['notes'] };
  expect(await consumeSlice(off.home, policy, answer, { synthetic: true, now: NOW, documents })).not.toHaveProperty('lane');
  expect(await consumeSlice(off.home, policy, answer, { synthetic: true, now: NOW, documents })).toMatchObject({ state: 'idle' });
  expect(query(off.home, "SELECT state FROM slices WHERE state='pending'")).toHaveLength(1);
  const on = lanes(3);
  const order: string[] = [];
  for (let i = 0; i < 7; i++) {
    const result = await consumeSlice(on.home, { ...policy, documentMaxSecondsPerDay: 120 }, answer, { synthetic: true, now: NOW, documents });
    order.push(result.state === 'idle' ? 'idle' : 'lane' in result ? String(result.lane) : 'transcript');
  }
  expect(order).toEqual(['transcript', 'document', 'transcript', 'document', 'transcript', 'idle', 'idle']);
  expect(query(on.home, "SELECT lane,sum(reserved_seconds) AS s FROM semantic_attempts GROUP BY lane ORDER BY lane"))
    .toEqual([{ lane: null, s: 180 }, { lane: 'document', s: 120 }]);
  expect(query(on.home, "SELECT state FROM document_jobs ORDER BY state")).toEqual([{ state: 'pending' }, { state: 'pending-review' }, { state: 'pending-review' }]);
  // Without the document option the lane does not exist, whatever the policy says.
  const none = lanes(1);
  await consumeSlice(none.home, { ...policy, documentMaxSecondsPerDay: 600 }, answer, { synthetic: true, now: NOW });
  expect(await consumeSlice(none.home, { ...policy, documentMaxSecondsPerDay: 600 }, answer, { synthetic: true, now: NOW })).toMatchObject({ state: 'idle' });
});

test('the lane cap is enforced inside the reservation transaction, under the global budget', () => {
  const w = lanes(2);
  using db = new Database(join(w.home, 'queue.sqlite3')); setup(db);
  const slices = db.query("SELECT w.id,w.job_id,w.payload_sha,d.receipt_hash FROM slices w JOIN document_jobs d ON d.id=w.job_id ORDER BY w.id").all() as Array<Record<string, string>>;
  const request = (index: number, extra = {}) => ({ jobId: slices[index]!.job_id!, sliceId: slices[index]!.id!, payloadSha: slices[index]!.payload_sha!,
    sourceReceiptSha: slices[index]!.receipt_hash!, seconds: 60, claudeAvailable: true, now: NOW, lane: 'document' as const, laneCapSeconds: 60, ...extra });
  expect(reserve(db, { ...request(0), lane: 'transcript' })).toMatchObject({ state: 'source-state-changed' });
  const first = reserve(db, request(0));
  expect(first).toMatchObject({ state: 'reserved' });
  db.query("UPDATE semantic_attempts SET state='pending-review'").run();
  expect(reserve(db, request(1))).toEqual({ state: 'paused-lane-budget', invoked: false });
  expect(db.query('SELECT seconds FROM semantic_budget').get()).toEqual({ seconds: 60 });
  db.query('UPDATE semantic_budget SET seconds=1790').run();
  expect(reserve(db, request(1, { laneCapSeconds: 1800 }))).toEqual({ state: 'paused-budget', invoked: false });
  expect(reserve(db, request(1, { laneCapSeconds: 0, seconds: 1 }))).toEqual({ state: 'paused-lane-budget', invoked: false });
});

const owner = { platform: 'windows', pid: 4567, creationFiletime: '123456789012345678', machineIdSha256: '1'.repeat(64) };
const ended: RecoveryProbes = { ownerStatus: async () => 'dead' as const, containmentStatus: async () => 'empty' as const };
test('a crashed document attempt is recovered against its document snapshot', async () => {
  for (const dispatched of [false, true]) {
    const w = lanes(1);
    using db = new Database(join(w.home, 'queue.sqlite3')); setup(db);
    const row = db.query('SELECT w.*,d.receipt_hash FROM slices w JOIN document_jobs d ON d.id=w.job_id').get() as Record<string, string>;
    const item = verifyStoredSlice(row);
    const result = reserve(db, { jobId: row.job_id!, sliceId: item.sliceId, payloadSha: row.payload_sha!, sourceReceiptSha: row.receipt_hash!,
      seconds: 60, claudeAvailable: true, owner, now: NOW, lane: 'document', laneCapSeconds: 600 });
    if (result.state !== 'reserved') throw new Error('fixture-reservation');
    db.query('UPDATE semantic_attempts SET containment_json=? WHERE token=?').run(JSON.stringify({ schemaVersion: 1, platform: 'windows',
      jobName: `Local\\ACBCorpus-${result.token}`, attemptToken: result.token, machineIdSha256: owner.machineIdSha256 }), result.token);
    const policy = { claudeAvailable: true, attemptSeconds: 60 };
    if (!dispatched) {
      expect(await recover(w.home, policy, true, ended)).toMatchObject({ state: 'recovered-before-dispatch', writes: true });
      continue;
    }
    markDispatch(db, result.token);
    const outputJson = canonical({ schemaVersion: 1, sliceId: item.sliceId, coverage: coverage(item), disposition: 'no-durable-findings', observations: [] });
    mkdirSync(join(w.home, 'semantic-results'), { recursive: true });
    writeFileSync(join(w.home, 'semantic-results', `${result.token}.json`), canonical({ schemaVersion: 1, attemptToken: result.token, jobId: row.job_id,
      sliceId: item.sliceId, sourceReceiptSha256: row.receipt_hash, provider: 'claude', reason: 'primary', state: 'pending-review', accepted: false,
      reservedSeconds: 60, utcDay: '2026-10-05', completionProof: 'windows-atomic-job-empty-v1', outputJson, outputSha256: sha256(outputJson),
      usage: { input_tokens: 1 }, modelElapsedSeconds: 0.1, recordedAt: '2026-10-05T12:00:01.000Z' }) + '\n');
    expect(await recover(w.home, policy, true, ended)).toMatchObject({ state: 'recovered-result', writes: true });
    expect(query(w.home, 'SELECT state FROM document_jobs')).toEqual([{ state: 'pending-review' }]);
  }
});

async function reviewed(layout: { home?: string; docs?: string }, sourceOverrides: Record<string, unknown>) {
  const w = world(layout);
  put(join(w.docs, 'a.md'), '# A\nEvidence must remain private for every reviewed run.\n');
  const source = w.source({ initial: 'distill', ...sourceOverrides });
  runCapture(w.config([source]), w.home, true);
  prepareDocumentSlices(w.home, ['notes'], 16000, true);
  await consumeSlice(w.home, { claudeAvailable: true, attemptSeconds: 60, documentMaxSecondsPerDay: 60 },
    r => answer(r, 'Evidence must remain private for every reviewed run.'), { synthetic: true, now: NOW, documents: { sourceIds: ['notes'] } });
  for (const item of listForReview(w.home).items) decide(w.home, { attemptToken: item.attemptToken, observationIndex: item.observationIndex,
    outputSha256: item.outputSha256, decision: 'accept' });
  return { w, source: parsed(source) };
}
test('document claims publish under their own scope and subject; shared needs the source, the flag and no private floor', async () => {
  const cases = [[{}, { sensitivity: 'shared', allowSharedPublication: true }, 'shared'], [{}, { sensitivity: 'shared' }, 'private'], [{}, {}, 'private'],
    [{ docs: 'ws', home: 'ws/runtime/home' }, { sensitivity: 'shared', allowSharedPublication: true }, 'private']] as const;
  for (const [layout, overrides, expected] of cases) {
    const { w, source } = await reviewed(layout, overrides);
    const seen: Array<{ attestation: Record<string, unknown>; candidate: Record<string, unknown> }> = [];
    const transport: BrokerTransport = async input => {
      seen.push(input as never);
      return { state: 'pending', acceptedClaimCount: 0, snapshotHash: null, automaticRetryAllowed: false,
        proposalId: (input.candidate as { proposalId: string }).proposalId, sourceToken: `acb://source/${'a'.repeat(64)}` };
    };
    const broker = { toolRoot: join(w.root, 'none'), claimsRoot: join(w.root, 'claims'), eventsRoot: join(w.root, 'events') };
    expect(await publishPending(w.home, {}, broker, true, transport)).toMatchObject({ state: 'idle' });
    expect(await publishPending(w.home, {}, broker, true, transport, undefined, [{ ...source, enabled: false }])).toMatchObject({ state: 'idle' });
    expect(await publishPending(w.home, {}, broker, true, transport, undefined, [source])).toMatchObject({ state: 'pending', claimCount: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.candidate).toMatchObject({ scope: { kind: 'workstream', key: 'corpus-documents-notes' } });
    expect((seen[0]!.candidate.claims as Array<Record<string, unknown>>)[0]).toMatchObject({ subject: 'workbench-document', sensitivity: expected,
      verification: 'unverified', evidenceClass: 'agent-handoff' });
    expect(seen[0]!.attestation).toMatchObject({ sensitivity: expected, scope: { kind: 'workstream', keyHash: sha256('corpus-documents-notes') } });
  }
});

test('a document observation similar to an accepted transcript observation is suggested reject: duplicate-of-transcript', async () => {
  const w = lanes(1);
  const summary = 'The queue keeps exactly one writer and evidence stays private.';
  const policy = { claudeAvailable: true, attemptSeconds: 60, documentMaxSecondsPerDay: 60 };
  const documents = { sourceIds: ['notes'] };
  await consumeSlice(w.home, policy, r => answer(r, summary), { synthetic: true, now: NOW, documents });
  const [transcript] = listForReview(w.home).items;
  expect(transcript!.suggestion.reasons).not.toContain('duplicate-of-transcript');
  decide(w.home, { attemptToken: transcript!.attemptToken, observationIndex: 0, outputSha256: transcript!.outputSha256, decision: 'accept' });
  expect(await consumeSlice(w.home, policy, r => answer(r, 'The queue keeps exactly one writer, and evidence stays private.'),
    { synthetic: true, now: NOW, documents })).toMatchObject({ lane: 'document' });
  const [item] = listForReview(w.home).items;
  expect(item!.suggestion).toEqual({ action: 'reject', confidence: 'high', reasons: ['duplicate-of-transcript'] });
  expect(item!.sources[0]!.role).toBe('document');
});

test('daily wires capture, preparation, the lane and a mid-run disable of the source', async () => {
  const w = world();
  put(join(w.codex, 'a.jsonl'), turn('Transcript keeps one writer.'));
  put(join(w.docs, 'a.md'), '# A\nDocument says the archive stays private.\n');
  const config = { capture: w.config([w.source({ initial: 'distill' })]), semantic: { claudeAvailable: true, attemptSeconds: 60, documentMaxSecondsPerDay: 60 } };
  const result = await runDaily(config, w.home, true, r => answer(r), { synthetic: true, now: NOW }) as Record<string, unknown> & {
    capture: Array<Record<string, unknown>>; preparedDocuments: Array<Record<string, unknown>>; attempts: Array<Record<string, unknown>> };
  expect(result.capture[0]).toMatchObject({ state: 'complete-tick', documents: { read: 1, jobs: 1 } });
  expect(result.preparedDocuments[0]).toMatchObject({ state: 'prepared', lane: 'document' });
  expect(result.attempts.map(attempt => [attempt.state, attempt.lane ?? 'transcript'])).toEqual([['pending-review', 'transcript'],
    ['pending-review', 'document'], ['idle', 'transcript']]);
  const late = world();
  put(join(late.docs, 'a.md'), '# A\nDocument says the archive stays private.\n');
  runCapture(late.config([late.source({ initial: 'distill' })]), late.home, true);
  prepareDocumentSlices(late.home, ['notes'], 16000, true);
  expect(await consumeSlice(late.home, config.semantic, r => answer(r), { synthetic: true, now: NOW, documents: { sourceIds: ['notes'], reread: () => [] } }))
    .toMatchObject({ state: 'invalid-output-or-source', lane: 'document' });
});

(process.platform !== 'win32' ? test.skip : test)('a case-only rename keeps the file identity and its pending job provable', () => {
  const w = world(); put(join(w.docs, 'a.md'), '# A\nOne section that becomes a job.\n');
  runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true);
  renameSync(join(w.docs, 'a.md'), join(w.docs, 'A.md')); utimesSync(join(w.docs, 'A.md'), clock - 100, clock - 100);
  expect(runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true)).toMatchObject({ documents: { errors: 0, deleted: 0, jobs: 0 } });
  expect(query(w.home, 'SELECT relative_path,state FROM document_files')).toEqual([{ relative_path: 'A.md', state: 'current' }]);
  expect(prepareDocumentSlices(w.home, ['notes'], 16000, true)).toMatchObject({ state: 'prepared' });
});

test('an orphan document generation from a rolled-back tick is verified and reused', () => {
  const w = world(); put(join(w.docs, 'a.md'), '# A\nOne section that becomes a job.\n');
  runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true);
  const [first] = query(w.home, 'SELECT * FROM document_jobs');
  { using db = new Database(join(w.home, 'queue.sqlite3')); db.run('DELETE FROM document_files; DELETE FROM document_jobs; DELETE FROM document_sections_seen'); }
  expect(runCapture(w.config([w.source({ initial: 'distill' })]), w.home, true)).toMatchObject({ documents: { errors: 0, jobs: 1 } });
  const jobs = query(w.home, 'SELECT * FROM document_jobs');
  expect(typeof jobs[0]?.created_at).toBe('number');
  expect(jobs).toEqual([{ ...first!, created_at: jobs[0]?.created_at }]);
});

test('documents CLI prints counts by source, kind, size and deny reason, never paths', async () => {
  const w = world();
  put(join(w.docs, 'plans', 'secret-plan-name.md'), '# Plan\nbody\n');
  put(join(w.docs, 'small.md'), '# S\nx\n');
  put(join(w.docs, '.env.md'), 'x');
  put(join(w.docs, 'node_modules', 'pkg.md'), 'x');
  const configPath = join(w.root, 'capture.json');
  writeFileSync(configPath, JSON.stringify(w.config([w.source({ kinds: { plan: ['plans/**'] } }), w.source({ id: 'off', root: join(w.root, 'codex'), enabled: false })])));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mts', import.meta.url)), 'documents', '--home', w.home, '--config', configPath],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on('data', chunk => output.push(chunk));
  child.stderr.on('data', chunk => errors.push(chunk));
  const exit = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const text = Buffer.concat(output).toString('utf8');
  expect(exit).toBe(0);
  const report = JSON.parse(text);
  expect(report).toMatchObject({ schemaVersion: 1, writes: false, sectionsSeen: {} });
  expect(report.sources[0]).toMatchObject({ id: 'notes', enabled: true, state: 'inventoried', files: 2, byKind: { plan: 1, default: 1 },
    bySize: { '<1KiB': 2 }, denied: { 'denied-file': 1, 'denied-segment': 1 }, effectiveSensitivity: 'private', privateFloor: false, queue: { files: {}, jobs: {} } });
  expect(report.sources[1]).toEqual({ id: 'off', enabled: false, configuredSensitivity: 'private', state: 'boundary-refused', code: 'document-root-boundary' });
  // JSON escapes backslashes, so look for the escaped spelling as well as the raw one.
  for (const leak of [w.root, JSON.stringify(w.root).slice(1, -1), 'acb-documents-', 'secret-plan-name', 'small.md', 'pkg.md']) expect(text).not.toContain(leak);
  expect(existsSync(join(w.home, 'queue.sqlite3'))).toBe(false);
});
