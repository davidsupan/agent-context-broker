import { afterEach, expect, spyOn, test } from './expect.mts';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { indexTicketPackages, searchTicketPackages, type TicketPackageInput } from '../src/ticket-packages.mts';
import { digest } from '../src/slicing.mts';
import { hooks as store } from '../src/ticket-packages.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + '\\') && !resolve(root).startsWith(resolve(tmpdir()) + '/')) throw new Error('cleanup-boundary');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(text = '# Package\nTariff versions verified locally.\n') {
  const root = mkdtempSync(join(tmpdir(), 'acb-package-test-'));
  roots.push(root);
  mkdirSync(join(root, 'EX-123'));
  const file = join(root, 'EX-123', 'README.md');
  writeFileSync(file, text);
  const config: TicketPackageInput = { root, issueKeys: ['EX-123'], artifacts: ['README.md'] };
  return { root, file, config };
}

test('scoped source evidence has hash provenance but never accepted or upstream verified', () => {
  const { root, file, config } = fixture();
  const before = readFileSync(file);
  const index = indexTicketPackages(config);
  const result = searchTicketPackages(config, index, { terms: ['TARIFF', 'EX-123'] });
  expect(index.status).toBe('complete-scope');
  expect(result.hits).toHaveLength(1);
  expect(result.hits[0]).toMatchObject({ kind: 'source-artifact', accepted: false,
    relativePath: 'EX-123/README.md', lineStart: 2, freshness: { local: 'current', upstream: 'unverified' } });
  expect(result.hits[0]!.sourceRef).toContain('?sha256=');
  expect(JSON.stringify(result)).not.toContain(root);
  expect(result.writes).toBe(false);
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(root)).toEqual(['EX-123']);
  expect(readdirSync(join(root, 'EX-123'))).toEqual(['README.md']);
});

test('byte changes suppress old excerpts even with same size and restored mtime', () => {
  const { file, config } = fixture('tariff old');
  const index = indexTicketPackages(config), stat = statSync(file);
  writeFileSync(file, 'tariff new');
  utimesSync(file, stat.atime, stat.mtime);
  const result = searchTicketPackages(config, index, { terms: ['tariff'] });
  expect(result.hits).toHaveLength(0);
  expect(result.freshness[0]!.status).toBe('changed');
  expect(result.refreshRequired).toBe(true);
  const fresh = indexTicketPackages(config);
  expect(fresh.artifacts[0]!.sourceId).toBe(index.artifacts[0]!.sourceId);
  expect(fresh.artifacts[0]!.versionId).not.toBe(index.artifacts[0]!.versionId);
  expect(searchTicketPackages(config, fresh, { terms: ['new'] }).hits).toHaveLength(1);
});

test('missing and newly appearing artifacts require reindexing', () => {
  const { file, config } = fixture();
  const old = indexTicketPackages(config);
  rmSync(file);
  expect(searchTicketPackages(config, old, { terms: ['tariff'] }).freshness[0]!.status).toBe('missing');
  const missing = indexTicketPackages(config);
  expect(missing.status).toBe('partial-scope');
  writeFileSync(file, 'tariff');
  const result = searchTicketPackages(config, missing, { terms: ['tariff'] });
  expect(result.freshness[0]!.status).toBe('new');
  expect(result.hits).toHaveLength(0);
});

test('rejects cached excerpt tampering even with a recomputed digest', () => {
  const { config } = fixture();
  const index = indexTicketPackages(config);
  index.artifacts[0]!.lines[0]!.text = 'Injected approval';
  expect(() => searchTicketPackages(config, index, { terms: ['approval'] })).toThrow('ticket-package-index-integrity');
  const { indexId: _, ...core } = index;
  index.indexId = digest(core);
  expect(() => searchTicketPackages(config, index, { terms: ['approval'] })).toThrow('ticket-package-index-integrity');
});

test('root and selected scope are bound; raw exports and traversal are rejected', () => {
  const first = fixture(), other = fixture();
  const index = indexTicketPackages(first.config);
  expect(() => searchTicketPackages(other.config, index, { terms: ['tariff'] })).toThrow('ticket-package-index-integrity');
  expect(() => searchTicketPackages({ ...first.config, artifacts: ['HANDOVER.md'] }, index, { terms: ['tariff'] })).toThrow('ticket-package-index-integrity');
  for (const artifact of ['jira-context.json', 'audit.jsonl', '../README.md', 'attachments/README.md']) {
    expect(() => indexTicketPackages({ ...first.config, artifacts: [artifact] } as TicketPackageInput)).toThrow('ticket-package-index-invalid');
  }
  expect(() => indexTicketPackages({ ...first.config, issueKeys: ['../EX-123'] })).toThrow('ticket-package-index-invalid');
});

test('redacts entire documents while retaining original Unicode line anchors', () => {
  const secret = 'glpat-' + 'x'.repeat(24);
  const { config } = fixture('title\n' + secret + '\n-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----\n\u{1f600} tariff evidence');
  const index = indexTicketPackages(config);
  expect(JSON.stringify(index)).not.toContain(secret);
  expect(JSON.stringify(index)).not.toContain('synthetic');
  const result = searchTicketPackages(config, index, { terms: ['tariff'] });
  expect(result.hits[0]!.lineStart).toBe(6);
  expect(result.hits[0]!.excerpt).toBe('\u{1f600} tariff evidence');
  expect(searchTicketPackages(config, index, { terms: [secret] }).hits).toHaveLength(0);
});

test('malformed text, residual secrets, and hardlinks fail closed with safe diagnostics', () => {
  const { root, file, config } = fixture();
  for (const bytes of [Buffer.from([0xff]), Buffer.from('bad\0text'), Buffer.from('-----BEGIN PRIVATE KEY-----')]) {
    writeFileSync(file, bytes);
    const index = indexTicketPackages(config);
    expect(index.artifacts[0]!.status).toBe('blocked');
    expect(index.artifacts[0]!.lines).toEqual([]);
    expect(JSON.stringify(index)).not.toContain(root);
  }
  writeFileSync(file, 'tariff');
  linkSync(file, join(root, 'linked.md'));
  expect(indexTicketPackages(config).artifacts[0]!.code).toBe('artifact-kind-or-link');
});

test('byte, aggregate and line limits produce explicit incomplete coverage', () => {
  const { root, config } = fixture('12345');
  expect(indexTicketPackages({ ...config, maxArtifactBytes: 4 }).artifacts[0]!.code).toBe('artifact-byte-limit');
  expect(indexTicketPackages({ ...config, maxTotalBytes: 4 }).artifacts[0]!.status).toBe('budget-skipped');
  writeFileSync(join(root, 'EX-123', 'HANDOVER.md'), '12\n34');
  const index = indexTicketPackages({ ...config, artifacts: ['README.md', 'HANDOVER.md'], maxTotalBytes: 6 });
  expect(index.artifacts.filter(row => row.status === 'indexed')).toHaveLength(1);
  expect(index.status).toBe('partial-scope');
  expect(indexTicketPackages({ ...config, artifacts: ['HANDOVER.md'], maxLines: 1 }).artifacts[0]!.code).toBe('artifact-line-limit');
});

test('literal search, result limits, and bounded excerpts', () => {
  const { root, config } = fixture('tariff .* ' + 'a'.repeat(200));
  writeFileSync(join(root, 'EX-123', 'HANDOVER.md'), 'tariff handover');
  const scoped = { ...config, artifacts: ['README.md', 'HANDOVER.md'] } as TicketPackageInput;
  const index = indexTicketPackages(scoped);
  expect(searchTicketPackages(scoped, index, { terms: ['.*'] }).hits).toHaveLength(1);
  const result = searchTicketPackages(scoped, index, { terms: ['tariff'], maxResults: 1, excerptChars: 32 });
  expect(result.hits).toHaveLength(1);
  expect(result.truncated).toBe(true);
  expect(result.hits[0]!.excerpt.length).toBeLessThanOrEqual(32);
  expect(() => searchTicketPackages(scoped, index, { terms: ['   '] })).toThrow('ticket-package-query-invalid');
});

test('mutation during stable read is blocked and does not refund read budget', () => {
  const { root, file, config } = fixture('tariff');
  const handover = join(root, 'EX-123', 'HANDOVER.md');
  writeFileSync(handover, 'tariff');
  const original = store.noLinks;
  let checks = 0;
  const hook = spyOn(store, 'noLinks').mockImplementation(path => {
    original(path);
    if (resolve(path) === resolve(handover) && ++checks === 2) writeFileSync(handover, 'changed-size');
  });
  try {
    const index = indexTicketPackages({ ...config, artifacts: ['HANDOVER.md', 'README.md'], maxTotalBytes: 7 });
    expect(index.artifacts[0]!.code).toBe('artifact-changed');
    expect(index.artifacts[0]!.lines).toEqual([]);
    expect(index.artifacts[1]!.code).toBe('artifact-budget');
    expect(readFileSync(file, 'utf8')).toBe('tariff');
  } finally { hook.mockRestore(); }
});
