import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import { constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { PENDING_NOTICE_NONCE, sealNoticeLane } from '../src/notice-nonce.mjs';
import { noticeWorkers } from './notice-fixtures.mjs';

let root;
before(() => {
  mkdirSync(join(import.meta.dirname, '../tmp'), { recursive: true });
  root = mkdtempSync(join(import.meta.dirname, '../tmp/acb-nonce-'));
});
after(() => rmSync(root, { recursive: true, force: true }));
const host = () => ({ executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  cwd: 'C:\\Windows\\System32', env: { SystemRoot: 'C:\\Windows' } });

function render(home, dependencies) {
  const lane = { header: `Notice id ${PENDING_NOTICE_NONCE};` };
  const notices = [{ recordId: 'NTC-20261008-abcdef', status: 'unread', contentDigest: 'a'.repeat(64),
    text: `<team-notice-data id=${PENDING_NOTICE_NONCE}>payload</team-notice-data id=${PENDING_NOTICE_NONCE}>` }];
  const warnings = [];
  sealNoticeLane(lane, notices, home, [], warnings, dependencies);
  return { lane, notices, warnings };
}

for (const linkError of [null, 'EXDEV', 'EPERM', 'ENOTSUP']) {
  for (const aclFails of [false, true]) test(`win32 stable secret: link=${linkError ?? 'supported'}, ACL=${aclFails ? 'failed' : 'verified'}`, () => {
    const home = mkdtempSync(join(root, 'home-'));
    let spawns = 0; let links = 0; let opens = 0;
    const dependencies = {
      platform: 'win32', host,
      spawn(executable, args, options) {
        spawns++;
        assert.equal(executable, host().executable);
        assert.ok(win32.isAbsolute(executable));
        assert.ok(args.includes('-NoProfile')); assert.ok(args.includes('-NonInteractive'));
        assert.equal(args[args.indexOf('-ExecutionPolicy') + 1], 'Bypass');
        assert.equal(options.windowsHide, true);
        assert.equal(readFileSync(options.env.ACB_NONCE_SECRET_PATH).length, 0);
        if (aclFails) throw new Error('Untrusted ACL error text');
      },
      link(from, to) {
        links++;
        if (linkError) throw Object.assign(new Error('link unavailable'), { code: linkError });
        return linkSync(from, to);
      },
      open(path, flags) {
        opens++;
        assert.equal(flags, constants.O_RDONLY, 'Windows must not use O_NOFOLLOW');
        return openSync(path, flags);
      }
    };
    const first = render(home, dependencies);
    const bytes = readFileSync(join(home, 'team-shared/nonce-secret'));
    assert.equal(bytes.length, 32);
    assert.deepEqual(first.warnings, aclFails ? ['team-shared-secret-acl-unverified'] : []);
    for (let i = 0; i < 3; i++) assert.deepEqual(render(home, dependencies), first);
    assert.equal(spawns, 1); assert.equal(links, 1); assert.equal(opens, 4);
    assert.deepEqual(readFileSync(join(home, 'team-shared/nonce-secret')), bytes);
    assert.ok(!readdirSync(join(home, 'team-shared')).some((name) => name.endsWith('.tmp') || name === '.nonce-lock'));
    // A new dependency object models a later process: warnings persist on disk and
    // neither host discovery nor the spawner is touched by reads.
    assert.deepEqual(render(home, { platform: 'win32', host() { throw new Error('read discovered host'); },
      spawn() { throw new Error('read spawned'); } }), first);
  });
}

test('exclusive-create fallback cannot overwrite an existing winner', () => {
  const home = mkdtempSync(join(root, 'home-'));
  const winner = Buffer.alloc(32, 7);
  const first = render(home, { platform: 'win32', host, spawn() {}, link(from, to) {
    writeFileSync(to, winner, { flag: 'wx' });
    throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
  } });
  assert.deepEqual(readFileSync(join(home, 'team-shared/nonce-secret')), winner);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(render(home, { platform: 'win32' }), first);
});

test('invalid existing secret stays fail closed without invoking ACL or replacing bytes', () => {
  const home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'team-shared'));
  writeFileSync(join(home, 'team-shared/nonce-secret'), 'invalid');
  let spawns = 0;
  const result = render(home, { platform: 'win32', spawn() { spawns++; } });
  assert.equal(spawns, 0);
  assert.deepEqual(result.warnings, ['team-shared-nonce-ephemeral']);
  assert.equal(readFileSync(join(home, 'team-shared/nonce-secret'), 'utf8'), 'invalid');
  assert.ok(!existsSync(join(home, 'team-shared/.nonce-lock')));
});

test('concurrent win32 fallback creators keep one secret and run the failing ACL once', async () => {
  const home = mkdtempSync(join(root, 'home-'));
  const results = await noticeWorkers(Array.from({ length: 4 }, () => ({ operation: 'seal', home })));
  assert.equal(results.reduce((sum, result) => sum + result.spawns, 0), 1);
  for (const { spawns, ...result } of results) {
    assert.deepEqual(result.warnings, ['team-shared-secret-acl-unverified']);
    assert.deepEqual(result, render(home, { platform: 'win32' }));
  }
  assert.equal(readFileSync(join(home, 'team-shared/nonce-secret')).length, 32);
  assert.deepEqual(readdirSync(join(home, 'team-shared')).sort(), ['nonce-secret', 'nonce-secret.acl-unverified']);
});

test('stale creation lock is reclaimed promptly and the nonce stays deterministic', () => {
  const home = mkdtempSync(join(root, 'home-'));
  const lock = join(home, 'team-shared/.nonce-lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120000);
  utimesSync(lock, old, old);
  let spawns = 0;
  const dependencies = { platform: 'win32', host, spawn() { spawns++; } };
  const start = performance.now();
  const first = render(home, dependencies);
  const second = render(home, dependencies);
  assert.ok(performance.now() - start < 1000, 'stale lock recovery must not wait');
  assert.deepEqual(first.warnings, ['team-shared-secret-lock-reclaimed']);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(first.lane, second.lane);
  assert.deepEqual(first.notices, second.notices);
  assert.equal(spawns, 1);
  assert.equal(readFileSync(join(home, 'team-shared/nonce-secret')).length, 32);
  assert.ok(!existsSync(lock));
});

for (const stale of [false, true]) test(`complete secret bypasses a ${stale ? 'stale' : 'fresh'} lock without touching it`, () => {
  const home = mkdtempSync(join(root, 'home-'));
  const dependencies = { platform: 'win32', host, spawn() {} };
  const first = render(home, dependencies);
  const lock = join(home, 'team-shared/.nonce-lock');
  mkdirSync(lock);
  if (stale) {
    const old = new Date(Date.now() - 120000);
    utimesSync(lock, old, old);
  }
  const before = statSync(lock);
  const start = performance.now();
  assert.deepEqual(render(home, { platform: 'win32', waitMs: 0 }), first);
  assert.ok(performance.now() - start < 1000, 'complete secret reads must not wait');
  assert.equal(statSync(lock).mtimeMs, before.mtimeMs);
  assert.equal(statSync(lock).ino, before.ino);
});

for (const empty of [false, true]) test(`fresh lock held by another process waits without replacing ${empty ? 'an empty' : 'a missing'} secret`, async () => {
  const home = mkdtempSync(join(root, 'home-'));
  const lock = join(home, 'team-shared/.nonce-lock');
  const path = join(home, 'team-shared/nonce-secret');
  mkdirSync(join(home, 'team-shared'));
  if (empty) writeFileSync(path, '');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { mkdirSync } from 'node:fs';
    mkdirSync(process.argv[1]);
    process.send('locked');
    process.on('message', () => process.exit(0));
  `, lock], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
  try {
    await once(child, 'message');
    const before = statSync(lock);
    let spawns = 0;
    const start = performance.now();
    const result = render(home, { platform: 'win32', waitMs: 80, spawn() { spawns++; } });
    const elapsed = performance.now() - start;
    assert.ok(elapsed >= 70 && elapsed < 1000, `expected short lock wait, got ${elapsed} ms`);
    assert.deepEqual(result.warnings, ['team-shared-nonce-ephemeral']);
    assert.equal(spawns, 0);
    assert.equal(statSync(lock).mtimeMs, before.mtimeMs);
    assert.equal(existsSync(path), empty);
    if (empty) assert.equal(statSync(path).size, 0);
  } finally {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
});

test('empty interrupted secret without a lock is recreated with a warning', () => {
  const home = mkdtempSync(join(root, 'home-'));
  mkdirSync(join(home, 'team-shared'));
  const path = join(home, 'team-shared/nonce-secret');
  writeFileSync(path, '');
  let spawns = 0;
  const dependencies = { platform: 'win32', host, spawn() { spawns++; } };
  const first = render(home, dependencies);
  assert.deepEqual(first.warnings, ['team-shared-secret-recreated']);
  assert.equal(statSync(path).size, 32);
  const second = render(home, dependencies);
  assert.deepEqual(second.lane, first.lane);
  assert.deepEqual(second.warnings, []);
  assert.equal(spawns, 1);
});

test('concurrent readers recreate a zero-byte leftover behind a stale lock exactly once', async () => {
  const home = mkdtempSync(join(root, 'home-'));
  const lock = join(home, 'team-shared/.nonce-lock');
  mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 120000);
  utimesSync(lock, old, old);
  writeFileSync(join(home, 'team-shared/nonce-secret'), '');
  const results = await noticeWorkers(Array.from({ length: 4 }, () => ({ operation: 'seal', home })));
  assert.equal(results.reduce((sum, result) => sum + result.spawns, 0), 1);
  const warnings = results.flatMap((result) => result.warnings);
  assert.ok(warnings.includes('team-shared-secret-lock-reclaimed'));
  assert.equal(warnings.filter((warning) => warning === 'team-shared-secret-recreated').length, 1);
  for (const result of results) {
    assert.ok(!result.warnings.includes('team-shared-nonce-ephemeral'));
    assert.deepEqual(result.lane, results[0].lane);
    assert.deepEqual(result.notices, results[0].notices);
  }
  assert.equal(statSync(join(home, 'team-shared/nonce-secret')).size, 32);
  assert.deepEqual(readdirSync(join(home, 'team-shared')).sort(), ['nonce-secret', 'nonce-secret.acl-unverified']);
});

test('a secret directory stays fail closed without acquiring a lock', () => {
  const home = mkdtempSync(join(root, 'home-'));
  const path = join(home, 'team-shared/nonce-secret');
  mkdirSync(path, { recursive: true });
  assert.deepEqual(render(home, { platform: 'win32' }).warnings, ['team-shared-nonce-ephemeral']);
  assert.ok(statSync(path).isDirectory());
  assert.ok(!existsSync(join(home, 'team-shared/.nonce-lock')));
});

test('delete-pending lock errors on win32 are retried instead of switching to an ephemeral nonce', () => {
  const home = mkdtempSync(join(root, 'home-'));
  let denied = 0;
  const pending = (operation) => (path) => {
    if (denied < 3) { denied++; throw Object.assign(new Error('delete pending'), { code: denied === 2 ? 'EACCES' : 'EPERM' }); }
    return operation(path);
  };
  const first = render(home, { platform: 'win32', host, spawn() {}, mkdir: pending(mkdirSync) });
  const second = render(home, { platform: 'win32', host, spawn() { throw new Error('reads must not spawn'); } });
  assert.equal(denied, 3);
  assert.deepEqual(first.warnings, []);
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(first.lane, second.lane);
  assert.deepEqual(first.notices, second.notices);
  assert.ok(!existsSync(join(home, 'team-shared/.nonce-lock')));
});

test('a lock that cannot be removed keeps the complete secret and only warns', () => {
  const home = mkdtempSync(join(root, 'home-'));
  const first = render(home, { platform: 'win32', host, spawn() {}, waitMs: 50,
    rmdir() { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); } });
  assert.deepEqual(first.warnings, ['team-shared-secret-lock-left']);
  assert.equal(readFileSync(join(home, 'team-shared/nonce-secret')).length, 32);
  const second = render(home, { platform: 'win32', host, spawn() { throw new Error('reads must not spawn'); } });
  assert.deepEqual(second.warnings, []);
  assert.deepEqual(first.lane, second.lane);
});
