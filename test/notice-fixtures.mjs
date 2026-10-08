import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

export function notice(overrides = {}) {
  return {
    schemaVersion: 1, recordType: 'notice', recordId: 'NTC-20261008-abcdef', kind: 'release',
    subject: { type: 'pack', id: 'sample-pack', fromVersion: '1.0', toVersion: '1.1' },
    author: 'fixture-author', recordedAt: '2026-10-08T08:00:00Z', sensitivity: 'shared',
    audience: ['dev'], publishedAt: '2026-10-08T08:00:00Z',
    artifact: { href: 'https://example.invalid/releases/1.1', digest: 'a'.repeat(64) },
    expiresAt: null, supersedes: [], changes: [{
      changeId: 'CHG-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', category: 'fix', target: 'sample',
      before: 'Previous spacing', after: 'Updated spacing',
      renderings: { dev: { headline: 'Spacing updated', summary: 'The sample has updated spacing.', full: 'The sample spacing now follows the published specification.' } }
    }], links: [], ...overrides
  };
}

export function git(root, args, input) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['-C', root, '-c', 'user.name=fixture-agent', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], {
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input, windowsHide: true
  }).trim();
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

export function fixture(records = [notice()]) {
  const temporary = join(import.meta.dirname, '..', 'tmp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(join(temporary, 'acb-notices-'));
  const home = join(root, 'home');
  const checkout = join(root, 'checkout');
  mkdirSync(home); mkdirSync(checkout);
  git(checkout, ['init', '--initial-branch=main']);
  // This URL is only an identity; no fetch or clone is ever performed.
  const repository = 'https://example.invalid/team/context.git';
  git(checkout, ['remote', 'add', 'origin', repository]);
  for (const record of records) writeJson(join(checkout, 'records', 'notices', record.subject.type, `${record.recordId}.json`), record);
  git(checkout, ['add', 'records']);
  git(checkout, ['commit', '-m', 'Fixture records']);
  const commit = git(checkout, ['rev-parse', 'HEAD']);
  git(checkout, ['update-ref', 'refs/remotes/origin/main', commit]);
  writeJson(join(home, 'team-shared.json'), { schemaVersion: 1, sharedContextRoot: checkout, repository,
    remote: 'origin', protectedBranch: 'main', readerRoles: ['dev'] });
  writeJson(join(home, 'notice-policy.json'), { schemaVersion: 1, allowedHosts: ['example.invalid'] });
  writeJson(join(home, 'provider-policy.json'), { schemaVersion: 1, providers: { codex: { sources: { teamShared: 'allow' } } } });
  return { root, home, checkout, repository, commit, options: { runtimeHome: home, env: {}, now: '2026-10-09T08:00:00Z' } };
}

export function commitFixture(f) {
  git(f.checkout, ['add', 'records']);
  git(f.checkout, ['commit', '-m', 'Updated fixture']);
  const commit = git(f.checkout, ['rev-parse', 'HEAD']);
  git(f.checkout, ['update-ref', 'refs/remotes/origin/main', commit]);
  return commit;
}

export function receiptFixture(f, approvedBy = { 'NTC-20261008-abcdef': ['fixture-reviewer'] }, directory) {
  const commit = git(f.checkout, ['rev-parse', 'HEAD']);
  const paths = git(f.checkout, ['ls-tree', '-r', '--name-only', commit, '--', 'records/notices']).split('\n');
  const notices = paths.map((path) => {
    const bytes = execFileSync('git', ['-C', f.checkout, 'cat-file', 'blob', `${commit}:${path}`], { windowsHide: true });
    const record = JSON.parse(bytes);
    return { recordId: record.recordId, contentDigest: createHash('sha256').update(bytes).digest('hex'),
      mergeRequest: { iid: 1 }, approvers: approvedBy[record.recordId] ?? [], mergedAt: '2026-10-08T09:00:00Z', pipeline: { id: 7 } };
  }).filter((n) => n.approvers.length);
  const receipt = { schemaVersion: 1, projectId: 1, commit, notices };
  const trust = { schemaVersion: 1, repository: f.repository, artifactDigest: '', projectId: 1, commit, pipelineId: 7,
    verified: true, protectedRef: true, status: 'success', ref: 'main', jobName: 'approval-receipts' };
  const path = join(directory ?? join(f.home, 'team-shared', 'receipts'),
    createHash('sha256').update(f.repository).digest('hex'), commit);
  const save = () => {
    const bytes = `${JSON.stringify(receipt)}\n`;
    trust.artifactDigest = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'approvals.json'), bytes);
    writeJson(join(path, 'trust.json'), trust);
  };
  save();
  return { path, receipt, trust, save };
}
