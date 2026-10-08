import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowsHost } from '../distillation/src/windows-host.mts';

export const PENDING_NOTICE_NONCE = '0'.repeat(32);

/** @typedef {{platform?: NodeJS.Platform, spawn?: typeof execFileSync, link?: typeof linkSync,
 * host?: typeof windowsHost, open?: typeof openSync, waitMs?: number}} NonceDependencies */

/** Protect the empty file before it contains secret bytes.
 * @param {string} path @param {NonceDependencies} dependencies */
function protectWindowsSecret(path, dependencies) {
  const host = (dependencies.host ?? windowsHost)();
  const command = `
    $ErrorActionPreference = 'Stop'
    $owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = New-Object System.Security.AccessControl.FileSecurity
    $acl.SetOwner($owner)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($owner, 'FullControl', 'Allow')
    $acl.SetAccessRule($rule)
    [System.IO.File]::SetAccessControl($env:ACB_NONCE_SECRET_PATH, $acl)
  `;
  (dependencies.spawn ?? execFileSync)(host.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], {
    cwd: host.cwd, env: { ...host.env, ACB_NONCE_SECRET_PATH: path },
    windowsHide: true, timeout: 10000, stdio: 'pipe'
  });
}

/** Serialize secret creation; complete secrets can be read without the lock.
 * @param {string|null} home @param {string[]} warnings @param {NonceDependencies} dependencies */
function installationSecret(home, warnings, dependencies) {
  if (!home) throw new Error('nonce-home');
  const directory = join(home, 'team-shared');
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) throw new Error('nonce-directory');
  const path = join(directory, 'nonce-secret');
  const lock = join(directory, '.nonce-lock');
  const aclWarning = join(directory, 'nonce-secret.acl-unverified');
  const platform = dependencies.platform ?? process.platform;
  const deadline = Date.now() + (dependencies.waitMs ?? 15000);
  const pause = () => {
    if (Date.now() >= deadline) throw new Error('nonce-busy');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  };
  const secretInfo = () => {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (!info.isFile() || (info.size !== 0 && info.size !== 32))) throw new Error('nonce-file');
    return info;
  };
  // A complete secret is immutable: readers never touch or wait on the lock.
  if (secretInfo()?.size !== 32) {
    for (;;) {
      try { mkdirSync(lock); break; }
      catch (error) {
        if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error;
        const info = lstatSync(lock, { throwIfNoEntry: false });
        if (!info) continue;
        if (info.isDirectory() && Date.now() - info.mtimeMs > 60000) {
          try {
            // Another reader may already have replaced the stale directory.
            const current = lstatSync(lock, { throwIfNoEntry: false });
            if (!current || current.ino !== info.ino || current.mtimeMs !== info.mtimeMs) continue;
            rmdirSync(lock);
            warnings.push('team-shared-secret-lock-reclaimed');
          } catch (error) {
            const code = /** @type {NodeJS.ErrnoException} */ (error).code;
            // Windows can report access denied while another reader removes the
            // directory. Retry acquisition within the same bounded wait budget.
            if (code !== 'ENOENT') {
              if (code !== 'EPERM' && code !== 'EACCES') throw error;
              pause();
            }
          }
          // Removal does not grant ownership; compete through mkdir again.
          continue;
        }
        pause();
      }
    }
    try {
      const info = secretInfo();
      if (info?.size === 0) {
        unlinkSync(path);
        warnings.push('team-shared-secret-recreated');
      }
      if (!info || info.size === 0) {
        const temporary = join(directory, `.nonce-${randomUUID()}.tmp`);
        try {
          writeFileSync(temporary, '', { flag: 'wx', mode: 0o600 });
          let destination = temporary;
          let created = false;
          // Link the empty file while holding the publication lock, then protect and
          // populate it. A fallback gets its ACL on the actual destination exactly once.
          try { (dependencies.link ?? linkSync)(temporary, path); created = true; }
          catch (error) {
            const code = /** @type {NodeJS.ErrnoException} */ (error).code;
            if (code !== 'EEXIST') {
              if (!['EXDEV', 'EPERM', 'ENOTSUP'].includes(code ?? '')) throw error;
              try { writeFileSync(path, '', { flag: 'wx', mode: 0o600 }); created = true; }
              catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST') throw error; }
              destination = path;
            }
          }
          if (created) {
            if (platform === 'win32') {
              try { protectWindowsSecret(destination, dependencies); }
              catch {
                warnings.push('team-shared-secret-acl-unverified');
                // A diagnostic write must not discard a usable installation secret.
                try { writeFileSync(aclWarning, '', { flag: 'w', mode: 0o600 }); } catch { /* warning is still returned */ }
              }
            }
            writeFileSync(destination, randomBytes(32), { flag: 'r+' });
          }
        } finally { if (existsSync(temporary)) unlinkSync(temporary); }
      }
    } finally { rmdirSync(lock); }
  }
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('nonce-file');
  const fd = (dependencies.open ?? openSync)(path, constants.O_RDONLY | (platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== 32 || (platform !== 'win32' && (stat.mode & 0o077))) throw new Error('nonce-file');
    const secret = Buffer.alloc(33);
    if (readSync(fd, secret, 0, secret.length, 0) !== 32) throw new Error('nonce-size');
    if (existsSync(aclWarning) && !warnings.includes('team-shared-secret-acl-unverified')) warnings.push('team-shared-secret-acl-unverified');
    return secret.subarray(0, 32);
  } finally { closeSync(fd); }
}

/** Seal only the final included lane, after every budget filter. The placeholder and nonce have equal byte lengths.
 * @param {{header: string}} lane @param {import('./context-notices.mjs').NoticeView[]} notices
 * @param {string|null} home @param {string[]} snapshots @param {string[]} warnings
 * @param {NonceDependencies} [dependencies] */
export function sealNoticeLane(lane, notices, home, snapshots, warnings, dependencies = {}) {
  const included = notices.filter((n) => n.text);
  if (!included.length) return;
  let nonce;
  try {
    const secret = installationSecret(home, warnings, dependencies);
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
