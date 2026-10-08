import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';

import { defaultRuntimeHome } from './platform-paths.mjs';
import { readNoticeApprovals } from './notice-receipts.mjs';
import { guardNotice, guardSupersedes, guardPolicySchema, DEFAULT_GUARD_POLICY, ROLE_ID } from './notice-guard.mjs';

const name = z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u);
const branch = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/u)
  .refine((v) => !v.includes('..') && !v.includes('//') && !v.endsWith('/') && !v.endsWith('.lock'));
export const sharedContextSchema = z.strictObject({
  schemaVersion: z.literal(1), sharedContextRoot: z.string().min(1).max(4096).optional(),
  repository: z.string().min(1).max(4096).optional(), remote: name.optional(), protectedBranch: branch.optional(),
  teamShared: z.strictObject({ receiptsDir: z.string().min(1).max(4096).optional() }).optional(),
  readerRoles: z.array(z.string().max(64).regex(ROLE_ID)).max(32).default([]),
  maxTextBytes: z.number().int().min(0).max(65536).default(16384)
}).refine((v) => !v.sharedContextRoot || Boolean(v.repository && v.remote && v.protectedBranch));
/** @typedef {z.infer<typeof sharedContextSchema>} SharedConfig */
/** @typedef {{repository: string, commit: string, checkoutAgeSeconds: number, stale: boolean}} Provenance */
/** @typedef {{runtimeHome?: string, runtimeRoot?: string, env?: NodeJS.ProcessEnv, sharedConfig?: SharedConfig, now?: string|Date}} SharedOptions */

/** Only configuration lives in the runtime home; nothing is inferred from a notice.
 * Explicit nonstandard stores inherit no ambient home.
 * @param {SharedOptions} options */
export function sharedRuntimeHome(options) {
  if (options.runtimeHome) return resolve(options.runtimeHome);
  if (options.runtimeRoot) {
    const parent = dirname(resolve(options.runtimeRoot));
    return parent.split(/[\\/]/u).at(-1)?.toLowerCase() === 'runtime' ? dirname(parent) : null;
  }
  return defaultRuntimeHome({ env: options.env ?? process.env });
}

/** @param {string} path @returns {unknown|null} */
export function readLocalPolicy(path) {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > 65536) throw new Error('Local notice policy is invalid.');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape');
    return value;
  }
  catch { throw new Error('Local notice policy is invalid.'); }
}

/** @param {SharedOptions} [options] */
export function loadSharedConfiguration(options = {}) {
  const home = sharedRuntimeHome(options);
  const input = options.sharedConfig ?? (home ? readLocalPolicy(join(home, 'team-shared.json')) : null);
  const parsed = sharedContextSchema.safeParse(input ?? { schemaVersion: 1 });
  if (!parsed.success) throw new Error('Team-shared configuration is invalid.');
  const config = parsed.data;
  if (config.sharedContextRoot) {
    if (!isAbsolute(config.sharedContextRoot) && !home) throw new Error('Team-shared relative root requires a runtime home.');
    config.sharedContextRoot = resolve(home ?? '.', config.sharedContextRoot);
  }
  if (config.teamShared?.receiptsDir) {
    if (!isAbsolute(config.teamShared.receiptsDir) && !home) throw new Error('Relative receipts directory requires a runtime home.');
    config.teamShared.receiptsDir = resolve(home ?? '.', config.teamShared.receiptsDir);
  }
  return { home, config };
}

/** Read Git objects only, with bounded output and no lazy partial-clone fetch or replacement objects.
 * @param {string} root @param {string[]} args @param {number} [maxBuffer] */
function git(root, args, maxBuffer = 1024 * 1024) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  return execFileSync('git', ['--no-replace-objects', '-c', 'protocol.allow=never', '-C', root, ...args], {
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_GRAFT_FILE: '/dev/null' },
    timeout: 5000, maxBuffer, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
}

/** @param {string} root @param {string} ref @param {number} now */
function checkoutAge(root, ref, now) {
  // Ref/HEAD mtimes do not lie about an old checkout just because its commit is recent.
  // FETCH_HEAD is a conservative freshness hint; a host may maintain a commit-bound receipt below.
  const paths = ['HEAD', ref, 'FETCH_HEAD', 'packed-refs'].map((p) => git(root, ['rev-parse', '--git-path', p]).toString().trim());
  const times = paths.map((p) => resolve(root, p)).filter(existsSync).map((p) => statSync(p).mtimeMs);
  return Math.max(0, Math.floor((now - Math.max(...times)) / 1000));
}

const metadataSchema = z.strictObject({
  schemaVersion: z.literal(1), repository: z.string(), commit: z.string().regex(/^[a-f0-9]{40,64}$/u),
  checkedOutAt: z.iso.datetime().optional(),
  approvedBy: z.record(z.string().regex(/^NTC-\d{8}-[a-f0-9]{6}$/u), z.array(name).max(32)).default({})
});

/** Read a verified snapshot. Protection is an operator assertion about the configured remote ref,
 * not a fact Git can prove offline. Remote identity must still match exactly.
 * @param {SharedOptions & {config: SharedConfig, home: string|null}} options
 * @returns {{state: string, notices: import('./notice-guard.mjs').GuardedNotice[], provenance?: Provenance, approvedBy?: Record<string,string[]>}} */
export function readSharedContext(options) {
  const { config, home } = options;
  if (!config.sharedContextRoot) return { state: 'not-configured', notices: [] };
  const root = config.sharedContextRoot;
  const now = new Date(options.now ?? Date.now()).getTime();
  if (!Number.isFinite(now)) throw new Error('Notice query time is invalid.');
  const policyInput = home ? readLocalPolicy(join(home, 'notice-policy.json')) : null;
  const parsedPolicy = guardPolicySchema.safeParse(policyInput ?? DEFAULT_GUARD_POLICY);
  if (!parsedPolicy.success) throw new Error('Notice guard policy is invalid.');
  try {
    const remote = config.remote ?? '';
    const identity = git(root, ['config', '--local', '--get', `remote.${remote}.url`]).toString().trim();
    if (identity !== config.repository) throw new Error('identity');
    const commit = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).toString().trim();
    const ref = `refs/remotes/${remote}/${config.protectedBranch}`;
    const tip = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim();
    git(root, ['merge-base', '--is-ancestor', commit, tip]);
    let age = checkoutAge(root, ref, now);
    const metadata = home ? readLocalPolicy(join(home, 'team-shared-metadata.json')) : null;
    if (metadata) {
      const parsed = metadataSchema.safeParse(metadata);
      if (!parsed.success) throw new Error('metadata');
      if (parsed.data.repository === identity && parsed.data.commit === commit) {
        if (parsed.data.checkedOutAt) {
          const checkedOut = Date.parse(parsed.data.checkedOutAt);
          if (checkedOut > now) throw new Error('metadata');
          age = Math.floor((now - checkedOut) / 1000);
        }
      }
    }
    const provenance = { repository: identity, commit, checkoutAgeSeconds: age, stale: age > 86400 };
    const tree = git(root, ['ls-tree', '-r', '-z', '-l', commit, '--', 'records/notices/']).toString('utf8').split('\0').filter(Boolean);
    if (tree.length > 512) throw new Error('size');
    let bytesRead = 0;
    const notices = [];
    for (const entry of tree) {
      const match = /^(\d+) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/u.exec(entry);
      if (!match || match[1] !== '100644') throw new Error('unsafe tree');
      const size = Number(match[3]);
      bytesRead += size;
      if (size > 256 * 1024 || bytesRead > 8 * 1024 * 1024) throw new Error('size');
      const bytes = git(root, ['cat-file', 'blob', match[2]], 256 * 1024);
      notices.push(guardNotice(bytes, match[4], parsedPolicy.data));
    }
    const approvedBy = readNoticeApprovals({
      directory: config.teamShared?.receiptsDir ?? (home ? join(home, 'team-shared', 'receipts') : null),
      root, repository: identity, commit, protectedBranch: config.protectedBranch ?? ''
    }, notices);
    return { state: 'ready', provenance, approvedBy, notices: guardSupersedes(notices) };
  } catch {
    // Do not forward Git errors: they can contain untrusted filenames, URLs or credentials.
    return { state: 'untrusted-or-unavailable', notices: [] };
  }
}
