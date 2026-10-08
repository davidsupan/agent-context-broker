import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { runEmergencyCommand } from '../src/emergency-cli.mts';
import { openEmergency, closeEmergency, evaluateEmergency, verifyEmergency, emergencyReport, emergencyAdvisory, prepareEmergency, emergencyUse } from '../src/emergency.mts';
import { loadProviderPolicy, policyEntry, teamSharedReadable } from '../src/provider-policy.mjs';
import { runContextQuery, planContextQuery } from '../src/context-query.mjs';
import { publishContext, planContextPublication } from '../src/context-publish.mjs';
import { publishPeerProgress, planPeerProgressPublication } from '../src/peer-progress.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mts';
import { sha256 } from '../src/event-store.mjs';
import { withdrawClaims } from '../src/claims-withdraw.mts';
import { pruneInjectionAudit } from '../src/audit-prune.mts';
import { persistQueryInjection, createContextTrace } from '../src/context-trace.mts';
import { createLifecycleConsumer } from '../src/lifecycle-consumer.mjs';

const root = resolve(import.meta.dirname, '..');
const scratch = join(root, '.emergency-test-runtime');
const homes = [];
const now = '2026-10-08T10:00:00.000Z';
const until = '2026-10-08T15:00:00.000Z';
const scope = { kind: 'project', key: 'sample' };
const secret = 'PAYLOAD_TEXT_MUST_NOT_ENTER_THE_EMERGENCY_LEDGER';
function home() {
  const runtimeHome = join(scratch, randomUUID()); homes.push(runtimeHome); mkdirSync(runtimeHome, { recursive: true });
  writeFileSync(join(runtimeHome, 'provider-policy.json'), JSON.stringify({ schemaVersion: 1, providers: {
    codex: { read: { allow: [] }, publish: { allow: [] }, strictIsolation: true, sources: { teamShared: 'deny' } },
    'claude-code': { read: { allow: [] } }
  } }));
  return { runtimeHome, runtimeRoot: join(runtimeHome, 'runtime', 'reconciliation'), eventRuntimeRoot: join(runtimeHome, 'runtime', 'events'),
    globalAuditDirectory: join(runtimeHome, 'runtime', 'query-audit'), provider: 'codex', now, execute: true };
}
function open(h, extra = {}) { return openEmergency({ ...h, until, reason: 'Temporary capacity handover', ...extra }); }
function ledger(h) { return join(h.runtimeHome, 'emergency', 'grants.jsonl'); }
async function token(h) {
  const attestation = { schemaVersion: 1, provider: h.provider, sessionKey: sha256('session'), recordKey: sha256('record'),
    sourceHash: sha256('source'), inventoryHash: sha256('inventory'), observedAt: now,
    scope: { kind: scope.kind, keyHash: sha256(scope.key) }, sensitivity: 'private' };
  await attestSource({ runtimeRoot: h.eventRuntimeRoot, attestation, now, execute: true });
  return planSourceAttestation({ attestation }).subjectRef;
}
function proposal(sourceToken, extra = {}) {
  return { schemaVersion: 1, proposalId: 'fixture-publication', sourceToken, scope, claims: [{ claimKey: 'sample.rule',
    claimType: 'procedure', subject: 'review', predicate: 'requires', value: secret, observedAt: now, confidence: 1,
    sensitivity: 'shared', evidenceClass: 'canonical-artifact', verification: 'verified', canonicalRefs: ['repo://sample/rule'], ...extra }] };
}
function query(h, extra = {}) { return { ...h, profileId: 'review', scopeKind: scope.kind, scopeKey: scope.key, trace: true, ...extra }; }
function progress(sourceToken) {
  return { schemaVersion: 1, proposalId: 'fixture-progress', sourceToken, scope, work: { kind: 'thread', key: 'current' }, state: 'active', stage: 'implementation',
    summary: secret, nextSteps: [], limitations: [], changedSurfaces: [], canonicalRefs: ['repo://sample/rule'], relatedScopes: [],
    observedAt: now, ttlSeconds: 3600 };
}
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

test('plans write nothing; policy exemption is provider-specific, team notices included, and lazy expiry restores policy', async () => {
  const h = home();
  open(h, { execute: false });
  assert.equal(existsSync(join(h.runtimeHome, 'emergency')), false);
  const grant = open(h);
  assert.equal(policyEntry(loadProviderPolicy(h), h.provider), null);
  const prepared = prepareEmergency(h);
  assert.equal(policyEntry(prepared.providerPolicy, h.provider), null);
  assert.ok(policyEntry(prepared.providerPolicy, 'claude-code').read);
  assert.equal(teamSharedReadable(prepared.providerPolicy, h.provider), true);
  const before = readFileSync(ledger(h), 'utf8');
  await planContextQuery(query(h));
  closeEmergency({ ...h, execute: false });
  assert.equal(readFileSync(ledger(h), 'utf8'), before);
  const expired = prepareEmergency({ ...h, now: until });
  assert.equal(expired.emergency.grant, null);
  assert.equal(policyEntry(expired.providerPolicy, h.provider).strictIsolation, true);
  assert.equal(verifyEmergency(h.runtimeHome).records.at(-1).reason, 'expired');
  assert.equal(verifyEmergency(h.runtimeHome).records.at(-1).grantId, grant.grantId);
  prepareEmergency({ ...h, now: until });
  assert.equal(verifyEmergency(h.runtimeHome).records.length, 2);
});

test('tampering, deleting any line including the tail, reordering and missing ledger fail closed', async () => {
  for (const mutation of ['edit', 'middle', 'tail', 'reorder', 'missing']) {
    const h = home(); open(h); closeEmergency(h); open(h, { now: '2026-10-08T11:00:00.000Z' });
    const lines = readFileSync(ledger(h), 'utf8').trim().split('\n');
    if (mutation === 'edit') lines[0] = lines[0].replace('Temporary', 'Changed');
    if (mutation === 'middle') lines.splice(1, 1);
    if (mutation === 'tail') lines.pop();
    if (mutation === 'reorder') [lines[0], lines[1]] = [lines[1], lines[0]];
    if (mutation === 'missing') rmSync(ledger(h)); else writeFileSync(ledger(h), `${lines.join('\n')}\n`);
    const prepared = prepareEmergency(h);
    assert.equal(prepared.emergency.valid, false);
    assert.equal(policyEntry(prepared.providerPolicy, h.provider).strictIsolation, true);
    const result = await runContextQuery(query(h));
    assert.ok(result.warnings.includes('emergency-ledger-invalid'));
    assert.equal(result.claims.length, 0);
    const cli = spawnSync(process.execPath, ['scripts/agent-context.mjs', 'emergency', 'status', '--runtime-home', h.runtimeHome], { cwd: root, encoding: 'utf8' });
    assert.equal(cli.status, 3, cli.stderr);
  }
});

test('validates absolute expiry, cap, reason, extension and CLI usage errors', () => {
  const h = home();
  for (const extra of [{ until: 'tomorrow' }, { until: '2026-10-15T11:00:00.001Z' }, { until: now }, { reason: 'line\nbreak' }, { reason: 'x'.repeat(501) }])
    assert.throws(() => open(h, extra));
  const first = open(h);
  assert.throws(() => open(h));
  const second = open(h, { until: '2026-10-15T11:00:00.000Z' });
  assert.equal(second.supersedes, first.grantId);
  assert.equal(evaluateEmergency(h).grant.grantId, second.grantId);
  const cli = spawnSync(process.execPath, ['src/cli.mjs', 'emergency', 'open', '--runtime-home', h.runtimeHome], { cwd: root, encoding: 'utf8' });
  assert.equal(cli.status, 2);
});

test('query, publication and progress are ledgered with ids, report state and no payload text', async () => {
  const h = home(); open(h);
  const sourceToken = await token(h);
  const before = readFileSync(ledger(h), 'utf8');
  planContextPublication({ ...h, proposal: proposal(sourceToken) });
  planPeerProgressPublication({ ...h, proposal: progress(sourceToken) });
  assert.equal(readFileSync(ledger(h), 'utf8'), before);
  const publication = await publishContext({ ...h, proposal: proposal(sourceToken) });
  const peer = await publishPeerProgress({ ...h, proposal: progress(sourceToken) });
  const result = await runContextQuery(query(h));
  assert.equal(result.claims.length, 1);
  assert.equal(publication.publishedClaims.length, 1);
  const uses = verifyEmergency(h.runtimeHome).records.filter(r => r.type === 'used');
  assert.deepEqual(uses.map(r => r.command), ['publish', 'progress', 'query']);
  assert.deepEqual(uses[0].claimIds, [result.claims[0].claimId]);
  assert.deepEqual(uses[1].peerProgressIds, [peer.progressId]);
  assert.deepEqual(uses[2].claimIds, [result.claims[0].claimId]);
  assert.equal(readFileSync(ledger(h), 'utf8').includes(secret), false);
  assert.equal(emergencyReport(h).grants[0].writes[0].state, 'accepted');
  await withdrawClaims({ runtimeRoot: h.runtimeRoot, eventRuntimeRoot: h.eventRuntimeRoot, claimIds: [result.claims[0].claimId], reason: 'Review', execute: true });
  assert.equal(emergencyReport(h).grants[0].writes[0].state, 'withdrawn');
});

test('pending publication can be reviewed and withdrawn by the reported id', async () => {
  const h = home(); open(h); const sourceToken = await token(h);
  const result = await publishContext({ ...h, proposal: proposal(sourceToken, { evidenceClass: 'agent-handoff', verification: 'unverified', confidence: 0.5 }) });
  assert.notEqual(result.state, 'clean');
  const write = emergencyReport(h).grants[0].writes[0];
  assert.equal(write.state, 'pending');
  await withdrawClaims({ runtimeRoot: h.runtimeRoot, eventRuntimeRoot: h.eventRuntimeRoot, claimIds: [write.claimId], reason: 'Review', execute: true });
  assert.equal(emergencyReport(h).grants[0].writes[0].state, 'withdrawn');
});

test('unavailable ledger blocks writes before claim/progress artifacts, queries answer with warning', async () => {
  const h = home(); open(h); const sourceToken = await token(h);
  writeFileSync(join(h.runtimeHome, 'emergency', 'ledger.lock'), 'busy');
  await assert.rejects(publishContext({ ...h, proposal: proposal(sourceToken) }));
  await assert.rejects(publishPeerProgress({ ...h, proposal: progress(sourceToken) }));
  assert.equal(existsSync(join(h.runtimeRoot, 'claims')), false);
  assert.equal(existsSync(join(h.runtimeRoot, 'peer-progress', 'records')), false);
  const result = await runContextQuery(query(h));
  assert.ok(result.warnings.includes('emergency-ledger-append-failed'));
});

test('explicit strict isolation wins through flag, profile and environment', async () => {
  const h = home(); open(h); const sourceToken = await token(h);
  await publishContext({ ...h, proposal: proposal(sourceToken) });
  for (const extra of [{ strictIsolation: true }, { profileId: 'strict-isolation' }, { env: { AGENT_CONTEXT_BROKER_STRICT_ISOLATION: '1' } }]) {
    const result = await runContextQuery(query(h, extra));
    assert.equal(result.strictIsolation, true); assert.equal(result.claims.length, 0);
    assert.throws(() => planContextPublication({ ...h, ...extra, proposal: proposal(sourceToken) }));
    assert.throws(() => planPeerProgressPublication({ ...h, ...extra, proposal: progress(sourceToken) }));
    await assert.rejects(publishContext({ ...h, ...extra, proposal: proposal(sourceToken) }));
    await assert.rejects(publishPeerProgress({ ...h, ...extra, proposal: progress(sourceToken) }));
  }
});

test('byte cap marks affected claims in trace layers and persisted injection without marking uncut claims', async () => {
  const h = home(); open(h); const sourceToken = await token(h);
  await publishContext({ ...h, proposal: proposal(sourceToken) });
  const profiles = { small: { id: 'small', description: 'Fixture', taskKinds: [], keywords: [], claimTypes: ['procedure'],
    crossProvider: true, maxSnapshots: 5, maxClaims: 5, maxValueBytes: 4096, maxContextBytes: 180 } };
  const result = await runContextQuery(query(h, { profileId: 'small', profiles }));
  const candidate = result.trace.candidates.find(c => c.decision === 'included');
  assert.equal(candidate.truncated, true); assert.ok(candidate.omittedBytes > 0);
  assert.equal(result.trace.layers[0].claims[0].truncated, true);
  const audit = JSON.parse(readFileSync(join(h.globalAuditDirectory, result.injection.artifact), 'utf8'));
  assert.equal(audit.trace.layers[0].claims[0].omittedBytes, candidate.omittedBytes);
  const full = await runContextQuery(query(h));
  assert.equal('truncated' in full.trace.candidates[0], false);
});

test('retention plans then deletes only matching old regular injection files', () => {
  const h = home();
  for (const generatedAt of ['2026-08-01T10:00:00.000Z', '2026-10-07T10:00:00.000Z'])
    persistQueryInjection(h.globalAuditDirectory, { generatedAt, profile: null, routeReason: 'fixture', provider: h.provider, payload: secret, trace: createContextTrace() });
  const directory = join(h.globalAuditDirectory, 'injections');
  writeFileSync(join(directory, 'unrelated.json'), 'keep');
  mkdirSync(join(directory, 'nested')); writeFileSync(join(directory, 'nested', 'keep.json'), 'keep');
  const plan = pruneInjectionAudit({ ...h, execute: false });
  assert.equal(plan.oldestKept, '2026-10-07T10:00:00.000Z');
  assert.equal(plan.newestKept, plan.oldestKept);
  assert.equal(plan.candidates, 1); assert.equal(plan.kept, 1); assert.ok(plan.bytesFreed > 0); assert.equal(plan.deleted, 0);
  const result = pruneInjectionAudit(h); assert.equal(result.deleted, 1);
  assert.equal(readdirSync(directory).length, 3);
  const linkHome = home();
  mkdirSync(join(linkHome.runtimeHome, 'runtime', 'query-audit'), { recursive: true });
  symlinkSync(directory, join(linkHome.globalAuditDirectory, 'injections'), 'junction');
  assert.throws(() => pruneInjectionAudit(linkHome), /regular directory/);
  assert.equal(readdirSync(directory).length, 3);
});

test('primary SessionStart advisory appears once, including an open grant', async () => {
  const h = home(); const grant = open(h);
  const transcript = join(h.runtimeHome, 'active.jsonl'); copyFileSync(join(root, 'fixtures', 'claude-active.jsonl'), transcript);
  const consumer = createLifecycleConsumer({ provider: 'claude-code', adapterRoot: root, adapterModule: 'claude-inventory.mjs',
    runtimeRoot: join(h.runtimeHome, 'runtime', 'lifecycle'), eventRuntimeRoot: h.eventRuntimeRoot, contextRuntimeRoot: h.runtimeRoot,
    globalAuditDirectory: h.globalAuditDirectory, supportedEvents: ['SessionStart'], advisoryEvents: ['SessionStart'], allowedTranscriptRoots: () => [] });
  const event = { hook_event_name: 'SessionStart', session_id: 'fixture-session', transcript_path: transcript };
  const first = await consumer.handleHookEvent(event, { testMode: true, now, runtimeHome: h.runtimeHome });
  assert.match(first.hookSpecificOutput.additionalContext, /Emergency access: codex had full access/);
  assert.ok(first.hookSpecificOutput.additionalContext.includes(grant.grantId));
  const second = await consumer.handleHookEvent(event, { testMode: true, now, runtimeHome: h.runtimeHome });
  assert.equal((second.hookSpecificOutput?.additionalContext ?? '').includes('Emergency access:'), false);
  assert.deepEqual(JSON.parse(readFileSync(join(h.runtimeHome, 'emergency', 'summarised.json'), 'utf8')), [grant.grantId]);
});

test('lifecycle injections record refresh metadata and included peer ids', async () => {
  const h = home(); open(h);
  const transcript = join(h.runtimeHome, 'active.jsonl'); copyFileSync(join(root, 'fixtures', 'codex-active.jsonl'), transcript);
  const consumer = createLifecycleConsumer({ provider: h.provider, adapterRoot: root, adapterModule: 'codex-inventory-v2.mjs',
    runtimeRoot: join(h.runtimeHome, 'runtime', 'lifecycle'), eventRuntimeRoot: h.eventRuntimeRoot, contextRuntimeRoot: h.runtimeRoot,
    globalAuditDirectory: h.globalAuditDirectory, supportedEvents: ['UserPromptSubmit'], advisoryEvents: ['UserPromptSubmit'], allowedTranscriptRoots: () => [] });
  await consumer.handleHookEvent({ hook_event_name: 'UserPromptSubmit', session_id: 'fixture-session', transcript_path: transcript, prompt: 'review' },
    { testMode: true, now, runtimeHome: h.runtimeHome });
  assert.equal(verifyEmergency(h.runtimeHome).records.filter(r => r.type === 'used')[0].command, 'refresh');
});

test('host fixture is the exact report JSON for one closed and one open grant', async () => {
  const h = home(); open(h, { grantId: 'fixture-closed' }); const sourceToken = await token(h);
  await publishContext({ ...h, proposal: proposal(sourceToken) });
  await publishPeerProgress({ ...h, proposal: progress(sourceToken) });
  await runContextQuery(query(h)); await runContextQuery(query(h));
  closeEmergency({ ...h, now: '2026-10-08T11:00:00.000Z', reason: 'primary-restored' });
  open(h, { grantId: 'fixture-open', now: '2026-10-08T12:00:00.000Z' });
  let output = '';
  const original = console.log;
  try {
    console.log = value => { output += `${value}\n`; };
    assert.equal(runEmergencyCommand('emergency', ['report', '--runtime-home', h.runtimeHome], new Date('2026-10-08T13:00:00.000Z')), 0);
  } finally { console.log = original; }
  const fixture = join(root, 'test', 'fixtures', 'emergency-report.json');
  mkdirSync(join(root, 'test', 'fixtures'), { recursive: true });
  if (process.env.UPDATE_EMERGENCY_FIXTURE === '1') writeFileSync(fixture, output);
  assert.equal(output, readFileSync(fixture, 'utf8'));
  const parsed = JSON.parse(output);
  assert.equal(parsed.grants[0].counts.queries, 2); assert.equal(parsed.grants[0].counts.publishes, 1); assert.equal(parsed.grants[0].counts.progress, 1);
  assert.equal(parsed.grants[1].state, 'open');
});

test('withdrawing a pending update preserves the prior accepted claim and supports replay', async () => {
  const h = home(); open(h); const sourceToken = await token(h);
  const accepted = await publishContext({ ...h, proposal: proposal(sourceToken) });
  const pending = proposal(sourceToken, { value: 'Pending replacement', evidenceClass: 'agent-handoff', verification: 'unverified', confidence: 0.5 });
  pending.proposalId = 'pending-update';
  await publishContext({ ...h, proposal: pending });
  const write = emergencyReport(h).grants[0].writes.find(w => w.state === 'pending');
  const options = { runtimeRoot: h.runtimeRoot, eventRuntimeRoot: h.eventRuntimeRoot, claimIds: [write.claimId], reason: 'Review', execute: true };
  const withdrawn = await withdrawClaims(options);
  const replay = await withdrawClaims(options);
  assert.equal(replay.withdrawalId, withdrawn.withdrawalId);
  const result = await runContextQuery(query(h));
  assert.equal(result.claims[0].claimId, accepted.publishedClaims[0].claimId);
  assert.equal(emergencyReport(h).grants[0].writes.find(w => w.claimId === write.claimId).state, 'withdrawn');
});

test('included notice use records retain record ids and counts without text', () => {
  const h = home(); open(h);
  emergencyUse(h, evaluateEmergency(h), 'query', { teamNotices: [
    { recordId: 'NTC-20261008-abcdef', text: secret }, { recordId: 'NTC-20261008-000000', textOmitted: true }
  ] });
  const used = verifyEmergency(h.runtimeHome).records.at(-1);
  assert.deepEqual(used.teamNoticeIds, ['NTC-20261008-abcdef']);
  assert.equal(used.counts.teamNotices, 1);
  assert.equal(readFileSync(ledger(h), 'utf8').includes(secret), false);
});

test('a checkpoint one valid record behind is accepted with a warning and healed by the next append; two behind fails closed', () => {
  const h = home(); open(h); closeEmergency(h);
  const headPath = join(h.runtimeHome, 'emergency', 'head.json');
  const lines = readFileSync(ledger(h), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  writeFileSync(headPath, `${JSON.stringify({ hash: lines[0].hash, records: 1 })}\n`);
  const behind = verifyEmergency(h.runtimeHome);
  assert.equal(behind.valid, true);
  assert.deepEqual(behind.warnings, ['emergency-head-behind']);
  open(h, { now: '2026-10-08T11:00:00.000Z' });
  const healed = verifyEmergency(h.runtimeHome);
  assert.equal(healed.valid, true);
  assert.deepEqual(healed.warnings, []);
  const first = home(); open(first); closeEmergency(first); open(first, { now: '2026-10-08T11:00:00.000Z' });
  const firstLines = readFileSync(ledger(first), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  writeFileSync(join(first.runtimeHome, 'emergency', 'head.json'), `${JSON.stringify({ hash: firstLines[0].hash, records: 1 })}\n`);
  assert.equal(verifyEmergency(first.runtimeHome).valid, false);
  const lone = home(); open(lone); rmSync(join(lone.runtimeHome, 'emergency', 'head.json'));
  assert.deepEqual(verifyEmergency(lone.runtimeHome).warnings, ['emergency-head-behind']);
});

test('a ledger lock left by an exited or long-gone writer is reclaimed; the ledger stays usable', () => {
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  for (const owner of [{ pid: Number(exited.stdout), at: now }, { pid: process.pid, at: '2026-01-01T00:00:00.000Z' }, null]) {
    const h = home(); open(h);
    const lock = join(h.runtimeHome, 'emergency', 'ledger.lock');
    writeFileSync(lock, owner ? `${JSON.stringify({ ...owner, at: owner.at === now ? new Date().toISOString() : owner.at })}\n` : '');
    if (!owner) { const old = new Date(Date.now() - 120000); utimesSync(lock, old, old); }
    const start = Date.now();
    closeEmergency(h);
    assert.ok(Date.now() - start < 2000, 'reclaiming a stale lock must not wait for the full budget');
    assert.equal(existsSync(lock), false);
    const ledgerState = verifyEmergency(h.runtimeHome);
    assert.equal(ledgerState.valid, true);
    assert.deepEqual(ledgerState.records.map((r) => r.type), ['opened', 'closed']);
  }
});
