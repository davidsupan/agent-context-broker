import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ackContextNotice } from '../src/context-notices.mjs';
import { createNoticeSuite, read, matrix, query, metadata } from './notice-suite.mjs';

const setup = createNoticeSuite();

test('only recorded commit-bound approvals enable injection; list/show mark missing approvals unverified', async (t) => {
  const f = setup(t);
  for (const approvedBy of [undefined, {}, { 'NTC-20261008-abcdef': [] }]) {
    if (approvedBy) metadata(f, '2026-10-09T08:00:00Z', approvedBy);
    for (const extra of [{}, { recordId: 'NTC-20261008-abcdef' }]) {
      const item = read(f, extra).notices[0];
      assert.equal(item.verification, 'unverified');
      assert.match(item.text, /<team-notice-data id=[a-f0-9]{32}>/u);
    }
    const result = await query(f);
    assert.deepEqual(result.teamNotices, []);
    assert.equal(result.teamNoticeLane.counts.unverified, 1);
    assert.ok(!JSON.stringify(result).includes('Spacing updated'));
  }
  metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
  assert.equal((await query(f)).teamNotices[0].verification, 'approved-by-review');
  rmSync(join(f.home, 'team-shared', 'receipts'), { recursive: true });
  assert.equal((await query(f)).teamNoticeLane.counts.unverified, 1);
});

test('query injects only unread primary/visible notices; list/show retain acknowledged text', async (t) => {
  const f = setup(t);
  metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
  for (const cell of ['primary', 'visible', 'advice', 'notice', 'hidden']) {
    matrix(f, cell);
    const result = await query(f);
    const eligible = ['primary', 'visible'].includes(cell);
    assert.equal(result.teamNoticeLane.counts.included, eligible ? 1 : 0);
    assert.equal(result.teamNotices.length, eligible ? 1 : 0);
    assert.equal(result.context.includes('Spacing updated'), eligible);
    if (cell === 'advice' || cell === 'notice') assert.equal(result.teamNoticeLane.counts[cell], 1);
    if (cell === 'hidden') assert.equal(result.teamNoticeLane.counts.hiddenByAudience, 1);
  }
  matrix(f, 'primary');
  const item = read(f).notices[0];
  ackContextNotice({ ...f.options, recordId: item.recordId, contentDigest: item.contentDigest, execute: true });
  const result = await query(f);
  assert.deepEqual(result.teamNotices, []);
  assert.equal(result.teamNoticeLane.counts.read, 1);
  assert.equal(result.teamNoticeLane.counts.included, 0);
  assert.ok(!result.context.includes('Spacing updated'));
  for (const extra of [{}, { recordId: item.recordId }]) {
    const shown = read(f, extra).notices[0];
    assert.equal(shown.status, 'read'); assert.match(shown.text, /Spacing updated/u);
  }
});
