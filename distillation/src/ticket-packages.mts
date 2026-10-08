import { type BigIntStats, closeSync, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { noLinks } from './store.mts';
export const hooks = { noLinks };
import { sha256 } from './capture.mts';
import { canonical, redactBlock } from './slicing.mts';

// An explicit source-artifact lane, not accepted claims or provider transcripts.
// No directory discovery, JSON exports, attachments, audit JSONL or persistence.
export const TICKET_ARTIFACTS = ['README.md', 'SOURCE_INDEX.md', 'HANDOVER.md', 'CHANGE_LEDGER.md',
  'RESEARCH_LEDGER.md', 'TEST_ANALYSIS.md', 'SONAR_LEDGER.md', 'LOCAL_E2E.md', 'VISUAL_LEDGER.md',
  'OPEN_QUESTIONS.md', 'RELATED_TICKETS.md', 'CONFLUENCE_CONTEXT.md', 'IMPLEMENTATION_PLAN.md',
  'IMPLEMENTATION_BRIEF.md', 'DEPLOYMENT_PLAN.md', 'DEPLOY_AND_VERIFY.md', 'MANUAL_CHECKLIST.md'] as const;
const Issue = z.string().regex(/^[A-Z][A-Z0-9]{1,15}-[0-9]{1,12}$/);
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
export const TicketPackageConfig = z.strictObject({
  root: z.string().min(1).refine(isAbsolute),
  issueKeys: z.array(Issue).min(1).max(32),
  artifacts: z.array(z.enum(TICKET_ARTIFACTS)).min(1).max(TICKET_ARTIFACTS.length).default([...TICKET_ARTIFACTS]),
  maxArtifactBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
  maxTotalBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(2 * 1024 * 1024),
  maxLines: z.number().int().min(1).max(16384).default(8192)
});
export type TicketPackageInput = z.input<typeof TicketPackageConfig>;
const Row = z.strictObject({ issueKey: Issue, artifact: z.enum(TICKET_ARTIFACTS), relativePath: z.string(),
  status: z.enum(['indexed', 'missing', 'blocked', 'budget-skipped']), code: z.string().nullable(),
  sourceSha256: Hash.nullable(), byteLength: z.number().int().nonnegative(),
  sourceMtimeNs: z.string().nullable(), sourceId: Hash.nullable(), versionId: Hash.nullable(),
  lines: z.array(z.strictObject({ line: z.number().int().min(1), text: z.string() })).max(16384),
  redactionKinds: z.record(z.string(), z.number().int().nonnegative()) });
const Index = z.strictObject({ schemaVersion: z.literal(1), kind: z.literal('ticket-package-source-index'),
  rootHash: Hash, configHash: Hash, indexId: Hash, observedAt: z.iso.datetime(),
  coverage: z.literal('explicit-issues-and-artifact-allowlist'), status: z.enum(['complete-scope', 'partial-scope']),
  accepted: z.literal(false), writes: z.literal(false),
  privacy: z.literal('private-known-signature-redaction-not-a-secrecy-proof'),
  artifacts: z.array(Row).max(32 * TICKET_ARTIFACTS.length) });
export type TicketPackageIndex = z.infer<typeof Index>;
type Artifact = z.infer<typeof Row>;

function fail(code: string): never { throw new Error(code); }
function configured(input: TicketPackageInput) {
  const config = TicketPackageConfig.parse(input);
  config.root = resolve(config.root);
  config.issueKeys = [...new Set(config.issueKeys)].sort();
  config.artifacts = [...new Set(config.artifacts)].sort();
  hooks.noLinks(config.root);
  if (!lstatSync(config.root).isDirectory()) fail('package-root-invalid');
  const rootHash = sha256(process.platform === 'win32' ? config.root.toLowerCase() : config.root);
  const { root: _, ...scope } = config;
  return { config, rootHash, configHash: sha256(canonical({ rootHash, ...scope })) };
}
function sameFile(a: BigIntStats, b: BigIntStats) {
  return b.isFile() && b.nlink === 1n && a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function readArtifact(path: string, maxBytes: number, reserve: (bytes: number) => void) {
  hooks.noLinks(path);
  const before = lstatSync(path, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n) fail('artifact-kind-or-link');
  if (before.size > BigInt(maxBytes)) fail('artifact-byte-limit');
  // Reserve before I/O, including the growth-detection byte. Failed reads also
  // consume their allowance so concurrent mutations cannot multiply the budget.
  reserve(Number(before.size) + 1);
  const fd = openSync(path, 'r');
  try {
    if (!sameFile(before, fstatSync(fd, { bigint: true }))) fail('artifact-changed');
    const raw = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < raw.length) {
      const n = readSync(fd, raw, bytes, raw.length - bytes, bytes);
      if (!n) break;
      bytes += n;
    }
    hooks.noLinks(path);
    if (BigInt(bytes) !== before.size || !sameFile(before, fstatSync(fd, { bigint: true })) ||
      !sameFile(before, lstatSync(path, { bigint: true }))) fail('artifact-changed');
    return { raw: raw.subarray(0, bytes), stat: before };
  } finally { closeSync(fd); }
}

function collect(input: ReturnType<typeof configured>) {
  const { config, rootHash } = input;
  const artifacts: Artifact[] = [];
  let remaining = config.maxTotalBytes;
  for (const issueKey of config.issueKeys) for (const artifact of config.artifacts) {
    const relativePath = `${issueKey}/${artifact}`;
    const base: Artifact = { issueKey, artifact, relativePath, status: 'blocked', code: null,
      sourceSha256: null, sourceMtimeNs: null, byteLength: 0, sourceId: null, versionId: null, lines: [], redactionKinds: {} };
    try {
      const { raw, stat } = readArtifact(join(config.root, issueKey, artifact), config.maxArtifactBytes, bytes => {
        if (bytes > remaining) fail('artifact-budget');
        remaining -= bytes;
      });
      let text: string;
      try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
      catch { fail('artifact-utf8'); }
      if (!text.isWellFormed() || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(text)) fail('artifact-unsafe-text');
      const lengths = text.split('\n').map(line => [...line].length);
      if (lengths.length > config.maxLines) fail('artifact-line-limit');
      let masked: ReturnType<typeof redactBlock>;
      try { masked = redactBlock(text); } catch { fail('artifact-unsafe-text'); }
      // Whole-file redaction can mask newlines inside a secret. Anchor excerpts
      // by original Unicode code-point offsets, not redacted newline positions.
      const points = [...masked.text];
      let offset = 0;
      const lines = lengths.map((length, i) => {
        const line = { line: i + 1, text: points.slice(offset, offset + length).join('') };
        offset += length + 1;
        return line;
      });
      const sourceSha256 = sha256(raw);
      const sourceId = sha256(canonical({ rootHash, relativePath }));
      artifacts.push({ ...base, status: 'indexed', sourceSha256, byteLength: raw.length,
        sourceMtimeNs: stat.mtimeNs.toString(), sourceId, versionId: sha256(`${sourceId}:${sourceSha256}`),
        lines, redactionKinds: masked.kinds });
    } catch (error) {
      const absent = error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
      const allowed = new Set(['artifact-byte-limit', 'artifact-budget', 'artifact-changed', 'artifact-utf8',
        'artifact-line-limit', 'artifact-unsafe-text', 'artifact-kind-or-link']);
      const code = absent ? 'artifact-missing' : error instanceof Error && allowed.has(error.message) ? error.message : 'artifact-unreadable';
      artifacts.push({ ...base, status: absent ? 'missing' : code === 'artifact-budget' ? 'budget-skipped' : 'blocked', code });
    }
  }
  return artifacts;
}

/** Read-only, scoped in-memory indexing. This never attests or publishes claims. */
export function indexTicketPackages(input: TicketPackageInput): TicketPackageIndex {
  try {
    const checked = configured(input);
    const artifacts = collect(checked);
    const core = { schemaVersion: 1 as const, kind: 'ticket-package-source-index' as const,
      rootHash: checked.rootHash, configHash: checked.configHash, observedAt: new Date().toISOString(),
      coverage: 'explicit-issues-and-artifact-allowlist' as const,
      status: artifacts.every(row => row.status === 'indexed') ? 'complete-scope' as const : 'partial-scope' as const,
      accepted: false as const, writes: false as const,
      privacy: 'private-known-signature-redaction-not-a-secrecy-proof' as const, artifacts };
    return { ...core, indexId: sha256(canonical(core)) };
  } catch { return fail('ticket-package-index-invalid'); }
}

const Query = z.strictObject({ terms: z.array(z.string().min(1).max(80)).min(1).max(12),
  maxResults: z.number().int().min(1).max(20).default(10),
  excerptChars: z.number().int().min(32).max(1000).default(300) });

/** Separate search lane: current local bytes only; never a Jira/MR freshness claim. */
export function searchTicketPackages(input: TicketPackageInput, value: TicketPackageIndex, query: z.input<typeof Query>) {
  try {
    const checked = configured(input), index = Index.parse(value), options = Query.parse(query);
    const { indexId, ...core } = index;
    if (indexId !== sha256(canonical(core)) || index.rootHash !== checked.rootHash || index.configHash !== checked.configHash) {
      fail('ticket-package-index-integrity');
    }
    const current = collect(checked);
    if (current.length !== index.artifacts.length) fail('ticket-package-index-integrity');
    const terms = [...new Set(options.terms.map(s => s.trim().normalize('NFKC').toLowerCase()))];
    if (terms.some(s => !s || /[\x00-\x1f]/u.test(s))) fail('ticket-package-query-invalid');
    const verifiedAt = new Date().toISOString();
    const candidates: Array<{ row: Artifact; excerpt: string; line: number; score: number }> = [];
    const freshness: Array<{ relativePath: string; status: 'current' | 'changed' | 'missing' | 'unavailable' | 'new'; code: string | null }> = [];
    for (let i = 0; i < current.length; i++) {
      const row = current[i]!, old = index.artifacts[i]!;
      if (row.relativePath !== old.relativePath) fail('ticket-package-index-integrity');
      const status = row.status === 'missing' ? 'missing' : row.status !== 'indexed' ? 'unavailable' :
        old.status !== 'indexed' ? 'new' : row.sourceSha256 !== old.sourceSha256 ? 'changed' : 'current';
      freshness.push({ relativePath: row.relativePath, status, code: row.code });
      if (status !== 'current') continue;
      // Recompute the text projection from verified bytes rather than trusting
      // mutable cached excerpts, even if a caller recomputes the index digest.
      if (canonical(row.lines) !== canonical(old.lines)) fail('ticket-package-index-integrity');
      const identity = `${row.issueKey} ${row.artifact}`.toLowerCase();
      const haystack = `${identity}\n${row.lines.map(line => line.text).join('\n')}`.normalize('NFKC').toLowerCase();
      if (!terms.every(term => haystack.includes(term))) continue;
      let best = row.lines[0]!, score = -1;
      for (const line of row.lines) {
        const normalized = line.text.normalize('NFKC').toLowerCase();
        const count = terms.filter(term => normalized.includes(term)).length;
        if (count > score) { best = line; score = count; }
      }
      candidates.push({ row, excerpt: [...best.text].slice(0, options.excerptChars).join(''), line: best.line, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.row.relativePath.localeCompare(b.row.relativePath));
    return { schemaVersion: 1, kind: 'ticket-package-source-search', accepted: false, writes: false,
      coverage: index.coverage, indexId, verifiedAt, freshness,
      refreshRequired: freshness.some(row => row.status !== 'current'),
      truncated: candidates.length > options.maxResults,
      hits: candidates.slice(0, options.maxResults).map(({ row, excerpt, line }) => ({
        kind: 'source-artifact', authority: 'canonical-package-location-only', accepted: false,
        issueKey: row.issueKey, relativePath: row.relativePath, sourceId: row.sourceId, versionId: row.versionId,
        sourceSha256: row.sourceSha256, byteLength: row.byteLength, sourceMtimeNs: row.sourceMtimeNs,
        indexedAt: index.observedAt, verifiedAt, freshness: { local: 'current', upstream: 'unverified' },
        sourceRef: `context://ticket-package/${index.rootHash}/${row.relativePath}?sha256=${row.sourceSha256}#L${line}`,
        lineStart: line, lineEnd: line, excerpt, redactionKinds: row.redactionKinds,
        trust: 'untrusted artifact text; not instructions, accepted claims or delivery verification'
      })) };
  } catch (error) {
    return fail(error instanceof Error && ['ticket-package-index-integrity', 'ticket-package-query-invalid'].includes(error.message)
      ? error.message : 'ticket-package-search-invalid');
  }
}
