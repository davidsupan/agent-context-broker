import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSharedConfiguration } from '../src/shared-context.mjs';
import { commitFixture, git, notice, receiptFixture, writeJson } from './notice-fixtures.mjs';
import { createNoticeSuite, read, query } from './notice-suite.mjs';

const setup = createNoticeSuite();

test('receipts require exact record id and raw byte digest; missing receipts retain enveloped unverified text', async (t) => {
  const f = setup(t);
  // Legacy metadata may supply freshness but never approval authority.
  writeJson(join(f.home, 'team-shared-metadata.json'), { schemaVersion: 1, repository: f.repository,
    commit: f.commit, approvedBy: { [notice().recordId]: ['fixture-reviewer'] } });
  assert.equal(read(f).notices[0].verification, 'unverified');
  const cache = receiptFixture(f);
  assert.deepEqual(read(f).notices[0].approvedBy, ['fixture-reviewer']);
  for (const change of [
    () => { cache.receipt.notices[0].contentDigest = '0'.repeat(64); },
    () => { cache.receipt.notices[0].recordId = 'NTC-20261008-123456'; }
  ]) {
    change(); cache.save();
    for (const extra of [{}, { recordId: notice().recordId }]) {
      const item = read(f, extra).notices[0];
      assert.equal(item.verification, 'unverified'); assert.equal(item.approvedBy, undefined);
      assert.match(item.text, /Spacing updated\n<\/team-notice-data/u);
    }
    assert.deepEqual((await query(f)).teamNotices, []);
  }
});

test('superseded-record receipt never approves its replacement or enables old injection', async (t) => {
  const a = notice(); const b = notice({ recordId: 'NTC-20261008-123456', supersedes: [a.recordId] });
  const f = setup(t, [a, b]); receiptFixture(f, { [a.recordId]: ['fixture-reviewer'] });
  const result = read(f);
  assert.equal(result.notices.find((n) => n.recordId === a.recordId).status, 'superseded');
  assert.equal(result.notices.find((n) => n.recordId === b.recordId).verification, 'unverified');
  assert.deepEqual((await query(f)).teamNotices, []);
});

test('receipt cache is configurable, identity-bound, outside checkout, and requires host trust', (t) => {
  const f = setup(t, undefined, true); const config = JSON.parse(readFileSync(join(f.home, 'team-shared.json'), 'utf8'));
  config.teamShared = { receiptsDir: 'custom-receipts' }; writeJson(join(f.home, 'team-shared.json'), config);
  const directory = join(f.home, 'custom-receipts'); const cache = receiptFixture(f, undefined, directory);
  assert.equal(loadSharedConfiguration(f.options).config.teamShared.receiptsDir, directory);
  assert.equal(read(f).notices[0].verification, 'approved-by-review');
  rmSync(join(cache.path, 'trust.json'));
  assert.equal(read(f).notices[0].verification, 'unverified'); cache.save();
  config.repository = 'https://other.invalid/team/context.git'; writeJson(join(f.home, 'team-shared.json'), config);
  git(f.checkout, ['remote', 'set-url', 'origin', config.repository]);
  assert.equal(read(f).notices[0].verification, 'unverified');
  config.repository = f.repository; config.teamShared.receiptsDir = join(f.checkout, 'receipts');
  writeJson(join(f.home, 'team-shared.json'), config); git(f.checkout, ['remote', 'set-url', 'origin', f.repository]);
  receiptFixture(f, undefined, config.teamShared.receiptsDir);
  assert.equal(read(f).notices[0].status, 'quarantined');
});

test('receipt commit must match the checkout and be reachable from the protected branch', (t) => {
  const f = setup(t, undefined, true); const cache = receiptFixture(f);
  const record = notice({ recordId: 'NTC-20261008-123456' });
  writeJson(join(f.checkout, 'records/notices/pack', `${record.recordId}.json`), record);
  const newer = commitFixture(f);
  // An older artifact does not transfer to a new checkout, even with unchanged notice bytes.
  assert.ok(read(f).notices.every((n) => n.verification === 'unverified'));
  receiptFixture(f); git(f.checkout, ['update-ref', 'refs/remotes/origin/main', f.commit]);
  assert.equal(read(f).state, 'untrusted-or-unavailable');
  git(f.checkout, ['update-ref', 'refs/remotes/origin/main', newer]);
  git(f.checkout, ['checkout', '--detach', f.commit]);
  assert.equal(read(f).notices[0].verification, 'approved-by-review');
  assert.ok(existsSync(join(cache.path, 'approvals.json')));
});
