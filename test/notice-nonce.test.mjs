import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { constants, existsSync, linkSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
