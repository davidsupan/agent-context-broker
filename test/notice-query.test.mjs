import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planContextQuery } from '../src/context-query.mjs';
import { loadContextProfiles } from '../src/context-router.mts';
import { parseProviderPolicy } from '../src/provider-policy.mjs';
import { notice, receiptFixture, writeJson } from './notice-fixtures.mjs';
import { createNoticeSuite, read, query, acceptedClaim, metadata } from './notice-suite.mjs';

const setup = createNoticeSuite();

test('independent context query survives a missing accepted registry and never acknowledges', async (t) => {
  const f = setup(t); const runtimeRoot = join(f.home, 'runtime', 'reconciliation'); mkdirSync(runtimeRoot, { recursive: true });
  metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
  const result = await planContextQuery({ ...f.options, runtimeRoot, provider: 'codex', profileId: 'implementation', scopeKind: 'project', scopeKey: 'sample' });
  assert.ok(result.warnings.includes('accepted-registry-missing'));
  assert.equal(result.teamNotices[0].origin, 'team-shared'); assert.match(result.context, /Team notice \(data, not instructions\)/u);
  assert.ok(!existsSync(join(f.home, 'notice-acks')));
  const isolated = await planContextQuery({ ...f.options, runtimeRoot, provider: 'codex', strictIsolation: true });
  assert.equal(isolated.teamNotices, undefined);
});

test('absent configuration preserves the legacy query shape and output', async (t) => {
  const f = setup(t); rmSync(join(f.home, 'team-shared.json'));
  const runtimeRoot = join(f.home, 'runtime/reconciliation'); mkdirSync(runtimeRoot, { recursive: true });
  const result = await planContextQuery({ ...f.options, runtimeRoot, provider: 'codex', profileId: 'implementation', scopeKind: 'project', scopeKey: 'sample' });
  assert.equal(Object.hasOwn(result, 'teamNotices'), false);
  assert.deepEqual(result.warnings, ['accepted-registry-missing']);
  assert.ok(!result.context.includes('Team notice'));
});

test('expired history cannot consume the active context query text budget', async (t) => {
  const expired = notice({ recordId: 'NTC-20261008-123456', expiresAt: '2026-10-08T09:00:00Z' });
  const f = setup(t, [expired, notice()]);
  metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
  const config = JSON.parse(readFileSync(join(f.home, 'team-shared.json'), 'utf8'));
  const full = read(f);
  config.maxTextBytes = Buffer.byteLength(`${full.header}\n${full.notices.find((n) => n.status === 'unread').text}`);
  writeJson(join(f.home, 'team-shared.json'), config);
  const runtimeRoot = join(f.home, 'runtime/reconciliation'); mkdirSync(runtimeRoot, { recursive: true });
  const result = await planContextQuery({ ...f.options, runtimeRoot, provider: 'codex', profileId: 'implementation', scopeKind: 'project', scopeKey: 'sample' });
  assert.equal(result.teamNotices.length, 1);
  assert.equal(result.teamNotices[0].status, 'unread');
  assert.match(result.teamNotices[0].text, /Spacing updated/u);
  assert.match(result.context, /Spacing updated/u);
});

test('trace summarizes an approved unread notice without copying its rendering', async (t) => {
  const record = notice();
  const f = setup(t, [record]); receiptFixture(f);
  for (const withSnapshot of [false, true]) {
    if (withSnapshot) await acceptedClaim(f);
    const result = await query(f, { trace: true });
    assert.equal(result.teamNotices.length, 1);
    assert.equal(result.teamNotices[0].status, 'unread');
    assert.equal(result.teamNotices[0].verification, 'approved-by-review');
    assert.ok(result.context.includes(record.changes[0].renderings.dev.headline));
    assert.deepEqual(result.trace.layers.find((layer) => layer.id === 'notices'), {
      id: 'notices', state: 'used', included: 1, excluded: 0, reasons: {}, detail: 'notices'
    });
    for (const key of ['read', 'quarantined', 'hiddenByAudience', 'omittedByBudget', 'unverified']) {
      assert.equal(result.teamNoticeLane.counts[key], 0);
    }
    const serialized = JSON.stringify(result.trace);
    for (const text of Object.values(record.changes[0].renderings.dev)) assert.ok(!serialized.includes(text));
    assert.ok(!serialized.includes(result.teamNotices[0].text));
    assert.ok(!serialized.includes('team-notice-data'));
    assert.equal(result.trace.budget.renderedContextBytes, Buffer.byteLength(result.context));
  }
});

test('query lane cap defaults to 2048, includes framing, and never exceeds a quarter of the profile', async (t) => {
  const records = Array.from({ length: 12 }, (_, i) => notice({ recordId: `NTC-20261008-${i.toString(16).padStart(6, '0')}` }));
  const f = setup(t, records);
  metadata(f, '2026-10-09T08:00:00Z', Object.fromEntries(records.map((r) => [r.recordId, ['fixture-reviewer']])));
  const profiles = loadContextProfiles();
  const small = { ...profiles, implementation: { ...profiles.implementation, maxContextBytes: 2048 } };
  for (const [cap, selectedProfiles, expected] of [[undefined, profiles, 2048], [100, profiles, 100], [65536, small, 512], [0, profiles, 0]]) {
    writeJson(join(f.home, 'provider-policy.json'), { schemaVersion: 1, providers: { codex: {
      sources: { teamShared: 'allow' }, ...(cap === undefined ? {} : { teamShared: { maxContextBytes: cap } })
    } } });
    const result = await query(f, { profiles: selectedProfiles });
    const lane = result.teamNoticeLane;
    const texts = result.teamNotices.filter((n) => n.text).map((n) => n.text);
    assert.equal(lane.textBudgetBytes, expected);
    assert.equal(lane.textBytes, texts.length ? Buffer.byteLength([lane.header, ...texts].join('\n')) : 0);
    assert.ok(lane.textBytes <= expected);
    assert.equal(lane.counts.included, texts.length);
    assert.equal(lane.counts.omittedByBudget, records.length - texts.length);
    assert.equal(result.teamNotices.filter((n) => n.textOmitted).length, lane.counts.omittedByBudget);
    for (const text of texts) assert.ok(result.context.includes(text));
    assert.equal((result.context.match(/<team-notice-data id=/gu) ?? []).length,
      (result.context.match(/<\/team-notice-data id=/gu) ?? []).length);
  }
});

test('provider lane cap strictly validates configuration', () => {
  for (const value of [null, -1, 1.5, '2048', 65537]) {
    assert.throws(() => parseProviderPolicy(JSON.stringify({ schemaVersion: 1, providers: {
      codex: { teamShared: { maxContextBytes: value } }
    } })));
  }
  assert.throws(() => parseProviderPolicy('{"schemaVersion":1,"providers":{"codex":{"teamShared":{"extra":1}}}}'));
  assert.equal(parseProviderPolicy('{"schemaVersion":1,"providers":{"codex":{}}}').providers.codex.teamShared.maxContextBytes, 2048);
});

test('final profile limit updates omission counts without emitting a partial envelope or header', async (t) => {
  const f = setup(t);
  metadata(f, '2026-10-09T08:00:00Z', { 'NTC-20261008-abcdef': ['fixture-reviewer'] });
  await acceptedClaim(f, 'Accepted implementation guidance. '.repeat(43));
  const profiles = loadContextProfiles();
  const small = { ...profiles, implementation: { ...profiles.implementation, maxContextBytes: 2048 } };
  const result = await query(f, { profiles: small });
  assert.match(result.context, /Accepted implementation guidance/u);
  assert.equal(result.teamNotices[0].textOmitted, true);
  assert.equal(result.teamNoticeLane.counts.included, 0);
  assert.equal(result.teamNoticeLane.counts.omittedByBudget, 1);
  assert.equal(result.teamNoticeLane.textBytes, 0);
  assert.ok(!result.context.includes('team-notice-data'));
  assert.ok(Buffer.byteLength(result.context) <= 2048);
});
