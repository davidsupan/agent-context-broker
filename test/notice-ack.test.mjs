import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { ackContextNotice } from '../src/context-notices.mjs';
import { commitFixture, git, notice, noticeWorkers, writeJson } from './notice-fixtures.mjs';
import { createNoticeSuite, read, command } from './notice-suite.mjs';

const setup = createNoticeSuite();

function cli(f, args) {
  return spawnSync(process.execPath, ['src/cli.mjs', 'context-notices', ...args, '--runtime-home', f.home], {
    cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8', windowsHide: true,
    env: { ...process.env, AGENT_CONTEXT_BROKER_HOME: f.home, AGENT_CONTEXT_BROKER_PROVIDER_POLICY: '', AGENT_CONTEXT_BROKER_STRICT_ISOLATION: '' }
  });
}

test('acks plan without writes; execute, digest change and repository identity isolate read state', (t) => {
  const f = setup(t, undefined, true); const item = read(f).notices[0];
  const args = { ...f.options, recordId: item.recordId, contentDigest: item.contentDigest };
  assert.equal(ackContextNotice(args).writesEnabled, false); assert.ok(!existsSync(join(f.home, 'notice-acks')));
  assert.equal(ackContextNotice({ ...args, execute: true }).state, 'acknowledged');
  assert.equal(read(f).notices[0].status, 'read'); assert.equal(read(f, { unread: true }).notices.length, 0);
  assert.equal(readdirSync(join(f.home, 'notice-acks')).length, 1);
  const record = notice(); record.changes[0].renderings.dev.headline = 'New spacing';
  writeJson(join(f.checkout, 'records/notices/pack', `${record.recordId}.json`), record); commitFixture(f);
  assert.equal(read(f).notices[0].status, 'unread');
  assert.throws(() => ackContextNotice(args), /digest changed/u);
  const fresh = read(f).notices[0]; ackContextNotice({ ...args, contentDigest: fresh.contentDigest, execute: true });
  const config = JSON.parse(readFileSync(join(f.home, 'team-shared.json'), 'utf8'));
  config.repository = 'https://example.invalid/other/context.git'; writeJson(join(f.home, 'team-shared.json'), config);
  git(f.checkout, ['remote', 'set-url', 'origin', config.repository]);
  assert.equal(read(f).notices[0].status, 'unread');
});

test('command list/show/ack JSON and human forms; invalid input is nonzero', (t) => {
  const f = setup(t); const item = read(f).notices[0];
  let run = command(t, f, ['list', '--json']); assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).notices[0].recordId, item.recordId);
  run = command(t, f, ['show', item.recordId, '--detail', 'full']); assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /published specification/u);
  run = command(t, f, ['ack', item.recordId, '--content-digest', item.contentDigest]); assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /planned/u); assert.ok(!existsSync(join(f.home, 'notice-acks')));
  run = command(t, f, ['ack', item.recordId, '--content-digest', item.contentDigest, '--execute', '--json']);
  assert.equal(run.status, 0, run.stderr); assert.equal(JSON.parse(run.stdout).state, 'acknowledged');
  for (const args of [['show'], ['list', '--execute'], ['list', '--detail', 'verbose'], ['ack', item.recordId], ['list', '--bogus']]) {
    run = command(t, f, args); assert.equal(run.status, 1, run.stdout);
  }
});

test('CLI notice list smoke test', (t) => {
  const f = setup(t);
  const run = cli(f, ['list', '--json']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).notices[0].recordId, notice().recordId);
});

test('parallel library acknowledgements retain all independent keys and no temporary files', async (t) => {
  const f = setup(t, [notice(), notice({ recordId: 'NTC-20261008-123456' })]);
  const items = read(f).notices;
  await noticeWorkers(items.map((item) => ({ operation: 'ack', options: { ...f.options,
    recordId: item.recordId, contentDigest: item.contentDigest, execute: true } })));
  assert.ok(read(f).notices.every((n) => n.status === 'read'));
  assert.equal(readdirSync(join(f.home, 'notice-acks')).length, 2);
  assert.ok(readdirSync(join(f.home, 'notice-acks')).every((name) => name.endsWith('.json')));
});

test('acknowledgements cannot be stored inside the team checkout', (t) => {
  const f = setup(t, undefined, true); const item = read(f).notices[0];
  const nestedHome = join(f.checkout, 'reader-home'); mkdirSync(nestedHome);
  for (const file of ['team-shared.json', 'provider-policy.json', 'notice-policy.json']) {
    writeFileSync(join(nestedHome, file), readFileSync(join(f.home, file)));
  }
  assert.throws(() => ackContextNotice({ ...f.options, runtimeHome: nestedHome, recordId: item.recordId,
    contentDigest: item.contentDigest, execute: true }), /outside the shared checkout/u);
  assert.ok(!existsSync(join(nestedHome, 'notice-acks')));
});
