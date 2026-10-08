import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ackContextNotice } from '../src/context-notices.mjs';
import { writeJson } from './notice-fixtures.mjs';
import { createNoticeSuite, read, query, acceptedClaim, metadata } from './notice-suite.mjs';

const setup = createNoticeSuite();

for (const cause of ['audience policy', 'audience false', 'reader role', 'guard policy', 'guard null', 'ack directory', 'ack JSON', 'ack shape', 'ack file directory']) {
  test(`query isolates ${cause} failure and still injects accepted claims`, async (t) => {
    const f = setup(t);
    metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
    await acceptedClaim(f);
    const item = read(f).notices[0];
    if (cause === 'audience policy') writeJson(join(f.home, 'audience-policy.json'), { secret: 'ERROR_PAYLOAD' });
    if (cause === 'audience false') writeJson(join(f.home, 'audience-policy.json'), false);
    if (cause === 'reader role') writeJson(join(f.home, 'audience-policy.json'), { schemaVersion: 1, roles: ['qa'], matrix: {} });
    if (cause === 'guard policy') writeJson(join(f.home, 'notice-policy.json'), { secret: 'ERROR_PAYLOAD' });
    if (cause === 'guard null') writeJson(join(f.home, 'notice-policy.json'), null);
    if (cause === 'ack directory') writeFileSync(join(f.home, 'notice-acks'), 'ERROR_PAYLOAD');
    if (['ack JSON', 'ack shape', 'ack file directory'].includes(cause)) {
      ackContextNotice({ ...f.options, recordId: item.recordId, contentDigest: item.contentDigest, execute: true });
      const file = join(f.home, 'notice-acks', readdirSync(join(f.home, 'notice-acks'))[0]);
      if (cause === 'ack file directory') { rmSync(file); mkdirSync(file); }
      else writeFileSync(file, cause === 'ack JSON' ? 'ERROR_PAYLOAD' : JSON.stringify({ secret: 'ERROR_PAYLOAD' }));
    }
    const result = await query(f);
    assert.deepEqual(result.teamNotices, []);
    assert.deepEqual(result.warnings, ['team-shared-error']);
    assert.equal(result.teamNoticeLane.state, 'error');
    assert.equal(result.claims.length, 1);
    assert.match(result.context, /Accepted implementation guidance/u);
    assert.ok(!JSON.stringify(result).includes('ERROR_PAYLOAD'));
    assert.ok(!existsSync(join(f.home, 'notice-acks')) || cause.startsWith('ack'));
  });
}
