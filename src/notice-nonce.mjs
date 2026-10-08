import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PENDING_NOTICE_NONCE = '0'.repeat(32);

/** Atomic, exclusive publication: concurrent first readers cannot overwrite a secret.
 * @param {string|null} home */
function installationSecret(home) {
  if (!home) throw new Error('nonce-home');
  const directory = join(home, 'team-shared');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('nonce-directory');
  const path = join(directory, 'nonce-secret');
  if (!existsSync(path)) {
    const temporary = join(directory, `.nonce-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, randomBytes(32), { flag: 'wx', mode: 0o600 });
      try { linkSync(temporary, path); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; }
    } finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('nonce-file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('nonce-file');
    const secret = Buffer.alloc(33);
    if (readSync(fd, secret, 0, secret.length, 0) !== 32) throw new Error('nonce-size');
    return secret.subarray(0, 32);
  } finally { closeSync(fd); }
}

/** Seal only the final included lane, after every budget filter. The placeholder and nonce have equal byte lengths.
 * @param {{header: string}} lane @param {import('./context-notices.mjs').NoticeView[]} notices
 * @param {string|null} home @param {string[]} snapshots @param {string[]} warnings */
export function sealNoticeLane(lane, notices, home, snapshots, warnings) {
  const included = notices.filter((n) => n.text);
  if (!included.length) return;
  let nonce;
  try {
    const secret = installationSecret(home);
    try {
      nonce = createHmac('sha256', secret).update(JSON.stringify([
        'team-shared-envelope-v1', included.map((n) => n.contentDigest).sort(), [...new Set(snapshots)].sort()
      ])).digest('hex').slice(0, 32);
    } finally { secret.fill(0); }
  } catch {
    nonce = randomBytes(16).toString('hex');
    warnings.push('team-shared-nonce-ephemeral');
  }
  lane.header = lane.header.replace(`id ${PENDING_NOTICE_NONCE};`, `id ${nonce};`);
  for (const notice of included) notice.text = notice.text?.replaceAll(`id=${PENDING_NOTICE_NONCE}>`, `id=${nonce}>`);
}
