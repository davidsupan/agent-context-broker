import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, test } from 'node:test';
import { z } from 'zod';

import { planContextQuery, runContextQuery, scopeRelation } from '../src/context-query.mjs';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';
import { createLifecycleConsumer } from '../src/lifecycle-consumer.mjs';
import { publishPeerProgress } from '../src/peer-progress.mjs';
import { attestSource } from '../src/source-attestation.mts';
import { createContextTrace, traceLayers } from '../src/context-trace.mts';

const packageRoot = resolve(import.meta.dirname, '..');
const schema = JSON.parse(readFileSync(join(packageRoot, 'schemas/context-trace.schema.json'), 'utf8'));
const validator = z.fromJSONSchema(schema);
const roots = [];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const now = '2026-10-08T12:00:00.000Z';
const scope = { kind: 'project', key: 'sample' };
const providers = ['codex', 'claude-code'];
const marker = 'VALUE_MUST_NEVER_APPEAR_IN_TRACE';
const layerIds = ['accepted-primary', 'accepted-ambient-project', 'accepted-ambient-global',
  'accepted-related', 'peer-progress', 'notices', 'artifact-evidence', 'policy', 'budget'];

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function home() {
  const root = join(tmpdir(), `context-trace-${randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  return { root, runtime: join(root, 'reconciliation'), events: join(root, 'events'), audit: join(root, 'query-audit') };
}

function options(h, profile = {}) {
  return { provider: providers[0], runtimeRoot: h.runtime, profileId: 'trace-test',
    profiles: { 'trace-test': { id: 'trace-test', description: 'Trace fixture', taskKinds: [],
      keywords: ['review', 'contract'], claimTypes: ['procedure'], crossProvider: true,
      maxSnapshots: 5, maxClaims: 3, maxValueBytes: 4096, maxContextBytes: 16384, ...profile } },
    scopeKind: scope.kind, scopeKey: scope.key, terms: ['match'], now };
}

async function publish(h, claims, selectedScope = scope, relations = [scopeRelation(selectedScope.kind, selectedScope.key)]) {
  return reconcileClaimBatch({ runtimeRoot: h.runtime, execute: true, now: '2026-10-08T10:00:00.000Z',
    batch: { schemaVersion: 1, batchId: randomUUID(), scope: selectedScope, relationKeys: relations,
      expectedSnapshotHash: null, claims: claims.map((claim, index) => ({
        claimKey: `rule.${index}`, claimType: 'procedure', subject: 'sample', predicate: 'requires',
        value: `match ${marker}`, observedAt: '2026-10-08T10:00:00.000Z', confidence: 1,
        sensitivity: 'shared', evidenceClass: 'canonical-artifact', verification: 'verified',
        expectedCurrentClaimId: null, canonicalRefs: [`context://fixture/claim-${index}`],
        provenance: [{ provider: providers[0], sessionKey: hash('session'), recordKey: hash(`record-${index}`), sourceHash: hash(`source-${index}`) }],
        ...claim
      })) }
  });
}

function valid(trace) {
  const parsed = validator.safeParse(trace);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues, null, 2));
  assert.equal(JSON.stringify(trace).includes(marker), false);
  assert.equal(/"value"\s*:/.test(JSON.stringify(trace)), false);
  assert.deepEqual(trace.layers.map(item => item.id), layerIds);
  assert.deepEqual(trace.layers.at(-1), { id: 'budget', state: 'used',
    included: trace.budget.renderedContextBytes, excluded: 0, reasons: {}, detail: 'budget',
    limit: trace.budget.maxContextBytes });
}

test('records claim gates and ranked near misses without changing selection, rendering, or digest', async () => {
  const h = home();
  await publish(h, [
    { claimKey: 'included.a', subject: 'review contract' },
    { claimKey: 'included.b', subject: 'review contract' },
    { claimKey: 'included.c', subject: 'review contract' },
    { claimKey: 'cap', subject: 'review' },
    { claimKey: 'miss.high', subject: 'review contract', value: marker },
    { claimKey: 'miss.low', value: marker },
    { claimKey: 'type', claimType: 'fact' },
    { claimKey: 'private', sensitivity: 'private', provenance: [{ provider: providers[1], sessionKey: hash('peer'), recordKey: hash('peer-record'), sourceHash: hash('peer-source') }] },
    { claimKey: 'expired', freshness: { policy: 'ttl', verifiedAt: '2026-10-08T09:00:00.000Z', expiresAt: '2026-10-08T11:00:00.000Z', sourceHeadHash: null } },
    { claimKey: 'withdrawn' }
  ]);
  const statePath = join(h.runtime, 'state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.tombstones = { [scopeRelation(scope.kind, scope.key)]: { [hash('withdrawn')]: { withdrawalId: hash('withdrawal') } } };
  writeFileSync(statePath, JSON.stringify(state));
  const plain = await planContextQuery(options(h));
  const traced = await planContextQuery({ ...options(h), trace: true });
  const { trace, ...withoutTrace } = traced;
  assert.deepEqual(withoutTrace, plain);
  assert.equal('trace' in plain, false);
  assert.deepEqual(traced.claims.map((claim) => claim.claimKey), ['included.a', 'included.b', 'included.c']);
  assert.deepEqual(trace.nearMisses.map((item) => [item.claimKey, item.score]), [['cap', 14], ['miss.high', 8], ['miss.low', 4]]);
  for (const [key, reason] of Object.entries({ cap: 'claim-cap', 'miss.high': 'term-miss', type: 'claim-type', private: 'private-other-provider', expired: 'expired' })) {
    assert.equal(trace.candidates.find((item) => item.claimKey === key)?.reason, reason);
  }
  assert.equal(trace.candidates.find((item) => item.claimKey === 'miss.high').score, -1);
  assert.equal(trace.candidates.find((item) => item.claimKey === 'type').score, null);
  // A withdrawn claim is named by its id only; its key and wording are not copied into the trace.
  const withdrawn = trace.candidates.filter((item) => item.reason === 'tombstoned');
  assert.equal(withdrawn.length, 1);
  assert.equal(withdrawn[0].score, null);
  assert.deepEqual([withdrawn[0].claimKey, withdrawn[0].subject, withdrawn[0].predicate], [null, null, null]);
  assert.equal(JSON.stringify(trace).includes('"withdrawn"'), false);
  assert.ok(traced.warnings.includes('stale-claim-excluded'));
  assert.equal(trace.candidates.some((item) => item.reason === 'stale'), false, 'the current freshness evaluator only produces expired');
  assert.equal(trace.budget.renderedContextBytes, Buffer.byteLength(traced.context));
  valid(trace);
  const isolatedProvider = await planContextQuery({ ...options(h, { crossProvider: false }), trace: true });
  assert.equal(isolatedProvider.trace.candidates.find((item) => item.claimKey === 'private').reason, 'provider');
  valid(isolatedProvider.trace);
});

test('snapshot rank and cap include unreadable capped files; selected corrupt files still fail closed', async () => {
  const h = home();
  await publish(h, [{}]);
  for (const key of ['one', 'two']) await publish(h, [{}], { kind: 'workstream', key }, [scopeRelation(scope.kind, scope.key)]);
  const registry = JSON.parse(readFileSync(join(h.runtime, 'accepted-snapshots.json'), 'utf8'));
  const missing = registry.snapshots.find((entry) => JSON.parse(readFileSync(join(h.runtime, 'snapshots', `${entry.snapshotId}.json`), 'utf8')).scope.key === 'two');
  rmSync(join(h.runtime, 'snapshots', `${missing.snapshotId}.json`));
  const result = await planContextQuery({ ...options(h, { maxSnapshots: 1 }), trace: true });
  assert.deepEqual(result.trace.snapshots.map((item) => item.rank), [0, 1, 2]);
  assert.equal(result.trace.snapshots[0].role, 'primary');
  assert.equal(result.trace.snapshots[0].selected, true);
  assert.equal(result.trace.snapshots[1].reason, 'snapshot-cap');
  assert.equal(result.trace.snapshots[2].reason, 'unreadable');
  assert.equal(result.trace.snapshots[2].scopeKind, null);
  valid(result.trace);
  for (const trace of [false, true]) await assert.rejects(planContextQuery({ ...options(h), trace }), /snapshot/i);
});

test('read limit is counted without inventing claim identities; near misses stop at five', async () => {
  const h = home();
  await publish(h, Array.from({ length: 12 }, () => ({})));
  const limited = await planContextQuery({ ...options(h, { maxClaims: 1 }), trace: true });
  assert.deepEqual(limited.trace.candidates.find((item) => item.reason === 'read-limit'), {
    snapshotId: limited.trace.snapshots[0].snapshotId, decision: 'excluded', reason: 'read-limit', score: null, count: 8
  });
  valid(limited.trace);
  assert.equal(limited.trace.layers[0].excluded, 11);
  assert.deepEqual(limited.trace.layers[0].reasons, { 'read-limit': 8, 'claim-cap': 3 });
  const result = await planContextQuery({ ...options(h), trace: true });
  assert.equal(result.trace.nearMisses.length, 5);
  valid(result.trace);
  const executed = await runContextQuery({ ...options(h, { maxClaims: 1 }), execute: true, globalAuditDirectory: h.audit });
  const ledger = JSON.parse(readFileSync(join(h.audit, executed.injection.artifact.split('/')[1]), 'utf8'));
  assert.deepEqual(ledger.traceCounts, { included: 1, excludedByReason: { 'read-limit': 8, 'claim-cap': 3 }, nearMisses: 3 });
});

test('accepted scope roles and provider policy denials use only relation hashes', async () => {
  const h = home();
  await publish(h, [{}]);
  await publish(h, [{}], { kind: 'global', key: 'rules' });
  const primary = await planContextQuery({ ...options(h), trace: true });
  assert.deepEqual(primary.trace.layers.map(item => item.state),
    ['used', 'empty', 'used', 'empty', 'empty', 'off', 'off', 'empty', 'used']);
  assert.equal(primary.trace.layers[0].included, 1);
  assert.equal(primary.trace.layers[2].included, 1);
  valid(primary.trace);
  const base = { ...options(h), trace: true, scopeKind: 'ticket', scopeKey: 'TASK-1', ambientProjectKey: scope.key };
  const result = await planContextQuery(base);
  assert.deepEqual(result.trace.scopes.map((item) => item.role), ['primary', 'ambient-project', 'ambient-global']);
  valid(result.trace);
  const restricted = await planContextQuery({ ...base, providerPolicy: { schemaVersion: 1, providers: { [providers[0]]: { read: { allow: ['ticket:*'] } } } } });
  assert.deepEqual(restricted.trace.policy.map((item) => item.reason), ['ambient-project-denied', 'ambient-global-denied']);
  assert.deepEqual(restricted.trace.layers[7], { id: 'policy', state: 'used', included: 0,
    excluded: 2, reasons: { 'ambient-project-denied': 1, 'ambient-global-denied': 1 }, detail: 'policy' });
  valid(restricted.trace);
  const denied = await planContextQuery({ ...base, providerPolicy: { schemaVersion: 1, providers: { [providers[0]]: { strictIsolation: true } } } });
  assert.deepEqual(denied.trace.policy, [{ relationKey: scopeRelation('ticket', 'TASK-1'), reason: 'query-denied' }]);
  assert.deepEqual(denied.trace.layers.map(item => item.state),
    ['empty', 'empty', 'empty', 'empty', 'empty', 'off', 'off', 'denied', 'used']);
  assert.equal(denied.trace.layers[7].reasons['query-denied'], 1);
  valid(denied.trace);
});

test('injection artifacts always carry trace, route metadata and thread ref; ledgers only add counts', async () => {
  const h = home();
  await publish(h, [{}]);
  const threadRef = `context://thread/${hash('thread')}`;
  for (const trace of [false, true]) {
    const result = await runContextQuery({ ...options(h), trace, execute: true, globalAuditDirectory: h.audit,
      threadRef, threadAuditRoot: join(h.root, 'thread-audit') });
    assert.equal('trace' in result, trace);
    const artifact = JSON.parse(readFileSync(join(h.audit, result.injection.artifact), 'utf8'));
    assert.equal(artifact.threadRef, threadRef);
    assert.equal(artifact.generatedAt, now);
    assert.equal(artifact.profile, result.profile);
    assert.equal(artifact.provider, result.provider);
    assert.equal(artifact.routeReason, result.routeReason);
    assert.equal(artifact.digest, result.injection.digest);
    assert.equal(artifact.payload, result.context);
    valid(artifact.trace);
    const ledgerText = readFileSync(join(h.audit, result.injection.artifact.split('/')[1]), 'utf8');
    const ledger = JSON.parse(ledgerText);
    assert.deepEqual(ledger.traceCounts, { included: 1, excludedByReason: {}, nearMisses: 0 });
    assert.equal('trace' in ledger, false);
    assert.equal(ledgerText.includes(marker), false);
  }
});

test('CLI --trace is opt-in and produces a schema-valid trace', async () => {
  const h = home();
  await publish(h, [{}]);
  const args = ['src/cli.mjs', 'context-query', '--provider', providers[0], '--runtime-root', h.runtime,
    '--scope-kind', scope.kind, '--scope-key', scope.key, '--profile', 'custom-project'];
  const invoke = (extra) => {
    const child = spawnSync(process.execPath, [...args, ...extra], { cwd: packageRoot, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const plain = invoke([]);
  const traced = invoke(['--trace']);
  assert.equal('trace' in plain, false);
  assert.deepEqual(traced.claims, plain.claims);
  assert.equal(traced.context, plain.context);
  assert.equal(traced.injection.digest, plain.injection.digest);
  valid(traced.trace);
});

test('schema rejects values, missing decision reasons and unknown fields', async () => {
  const h = home();
  await publish(h, [{}]);
  const { trace } = await planContextQuery({ ...options(h), trace: true });
  valid(trace);
  for (const mutate of [
    (copy) => { copy.candidates[0].value = marker; },
    (copy) => { copy.candidates[0].decision = 'excluded'; },
    (copy) => { copy.snapshots[0].selected = false; },
    (copy) => { copy.schemaVersion = 2; },
    (copy) => { copy.extra = 1; },
    (copy) => { delete copy.layers; },
    (copy) => { copy.layers.reverse(); },
    (copy) => { copy.layers[0].state = 'unknown'; },
    (copy) => { copy.layers[0].included = -1; },
    (copy) => { delete copy.layers[8].limit; },
    (copy) => { copy.lifecycle = { advisoryReferences: 1, claimsInjected: 1 }; }
  ]) {
    const copy = structuredClone(trace);
    mutate(copy);
    assert.equal(validator.safeParse(copy).success, false, mutate.toString());
  }
  const resultSchema = JSON.parse(readFileSync(join(packageRoot, 'schemas/context-query-result.schema.json'), 'utf8'));
  assert.equal(resultSchema.properties.trace.$ref, 'context-trace.schema.json');
});

test('both lifecycle adapters preserve the exact origin/main advisory with accepted claims in scope', async () => {
  for (const [index, provider] of providers.entries()) {
    const h = home();
    await publish(h, [{}]);
    const fixture = index === 0 ? 'codex-active.jsonl' : 'claude-active.jsonl';
    const transcript = join(h.root, fixture);
    copyFileSync(join(packageRoot, 'fixtures', fixture), transcript);
    const adapter = await import(index === 0 ? '../src/codex-inventory-v2.mts' : '../src/claude-inventory.mts');
    const identity = await adapter.readSourceIdentity(transcript);
    const notices = join(h.root, 'accepted-notices.json');
    writeFileSync(notices, JSON.stringify({ schemaVersion: 1, snapshots: [{ snapshotId: 'notice',
      state: 'clean', digest: 'notice-digest', relationKeys: identity.relationKeys,
      canonicalRefs: ['context://accepted/fixture'] }] }));
    const consumer = createLifecycleConsumer({ provider, adapterRoot: packageRoot,
      adapterModule: index === 0 ? 'codex-inventory-v2.mjs' : 'claude-inventory.mjs',
      runtimeRoot: join(h.root, 'lifecycle'), eventRuntimeRoot: h.events,
      contextRuntimeRoot: h.runtime, globalAuditDirectory: h.audit, defaultProjectKey: scope.key,
      supportedEvents: ['UserPromptSubmit'], advisoryEvents: ['UserPromptSubmit'], allowedTranscriptRoots: () => [] });
    const refs = [];
    for (const minute of ['00', '01']) {
      const result = await consumer.handleHookEvent({ hook_event_name: 'UserPromptSubmit',
        session_id: 'fixture-session', transcript_path: transcript, prompt: 'match' }, {
        testMode: true, now: `2026-10-08T12:${minute}:00.000Z`, ticketPackagesRoot: join(h.root, 'tickets'),
        acceptedSnapshots: notices
      });
      const name = readdirSync(join(h.audit, 'injections')).sort().at(-1);
      const artifact = JSON.parse(readFileSync(join(h.audit, 'injections', name), 'utf8'));
      assert.equal(artifact.payload, result.hookSpecificOutput?.additionalContext ?? '');
      const state = JSON.parse(readFileSync(join(h.root, 'lifecycle', 'state', `${hash(`${provider}-consumer:fixture-session`)}.json`), 'utf8'));
      const expected = minute === '00'
        ? `Context broker advisory: accepted context: context://accepted/fixture; source token: ${state.sourceToken}; thread ref: ${artifact.threadRef}. For context-aware work, invoke the installed broker integration, retrieve the narrowest accepted context profile, and publish bounded progress after material findings, blockers, validation changes, and final handoff. No raw peer conversation content was imported. Verify candidate state against canonical sources before acting.`
        : '';
      assert.equal(artifact.payload, expected);
      assert.equal(artifact.payload.includes(marker), false);
      assert.equal(artifact.digest, hash(artifact.payload));
      assert.match(artifact.threadRef, /^context:\/\/thread\/[a-f0-9]{64}$/);
      assert.deepEqual(artifact.trace.candidates, []);
      assert.deepEqual(artifact.trace.lifecycle, { advisoryReferences: minute === '00' ? 1 : 0, claimsInjected: 0 });
      assert.deepEqual(artifact.trace.layers.map(item => item.state),
        ['off', 'off', 'off', 'off', 'empty', 'off', 'off', 'empty', 'used']);
      assert.equal(artifact.trace.budget.renderedContextBytes, Buffer.byteLength(artifact.payload));
      refs.push(artifact.threadRef);
      valid(artifact.trace);
      const ledger = JSON.parse(readFileSync(join(h.audit, name), 'utf8'));
      assert.equal(ledger.traceCounts.included, 0);
      assert.equal('trace' in ledger, false);
    }
    assert.equal(refs[0], refs[1]);
    assert.equal(readdirSync(join(h.audit, 'injections')).length, 2);
  }
});

async function progress(h, suffix, overrides = {}) {
  const provider = providers[1];
  const attestation = { schemaVersion: 1, provider, sessionKey: hash(`session-${suffix}`), recordKey: hash(`record-${suffix}`),
    sourceHash: hash(`source-${suffix}`), inventoryHash: hash(`inventory-${suffix}`), observedAt: '2026-10-08T10:00:00.000Z',
    scope: { kind: 'project', keyHash: hash(scope.key) }, sensitivity: 'private' };
  const source = await attestSource({ runtimeRoot: h.events, attestation, execute: true });
  return publishPeerProgress({ runtimeRoot: h.runtime, eventRuntimeRoot: h.events, provider, execute: true, now,
    ticketPackagesRoot: join(h.root, 'tickets'),
    proposal: { schemaVersion: 1, proposalId: `progress-${suffix}`, sourceToken: source.subjectRef,
      scope, work: { kind: 'custom', key: `stream-${suffix}` }, state: 'active', stage: 'implementation',
      summary: `match ${marker}`, nextSteps: [], limitations: [], changedSurfaces: [], canonicalRefs: ['context://fixture/progress'],
      relatedScopes: [], observedAt: '2026-10-08T10:00:00.000Z', ttlSeconds: 14400, ...overrides } });
}

test('lifecycle layers describe peer delivery, deduplication and policy without claim candidates', async () => {
  const h = home();
  await publish(h, [{}]);
  await progress(h, 'lifecycle', { summary: 'match peer progress' });
  const consumer = createLifecycleConsumer({ provider: providers[0], adapterRoot: packageRoot,
    adapterModule: 'codex-inventory-v2.mjs', runtimeRoot: join(h.root, 'lifecycle'),
    eventRuntimeRoot: h.events, contextRuntimeRoot: h.runtime, globalAuditDirectory: h.audit,
    defaultProjectKey: scope.key, supportedEvents: ['UserPromptSubmit'], advisoryEvents: ['UserPromptSubmit'],
    allowedTranscriptRoots: () => [] });
  const event = { hook_event_name: 'UserPromptSubmit', session_id: 'peer-fixture',
    transcript_path: join(h.root, 'missing.jsonl'), prompt: 'match' };
  for (const minute of ['00', '01', '02']) {
    const result = await consumer.handleHookEvent(event, { testMode: true, now: `2026-10-08T12:${minute}:00.000Z`,
      ...(minute === '02' ? { providerPolicy: { schemaVersion: 1, providers: {
        codex: { read: { allow: ['ticket:*'] } }
      } } } : {}) });
    const name = readdirSync(join(h.audit, 'injections')).sort().at(-1);
    const artifact = JSON.parse(readFileSync(join(h.audit, 'injections', name), 'utf8'));
    const trace = artifact.trace;
    valid(trace);
    assert.deepEqual(trace.candidates, []);
    assert.deepEqual(trace.lifecycle, { advisoryReferences: 0, claimsInjected: 0 });
    assert.deepEqual(trace.layers.map(item => item.state),
      ['off', 'off', 'off', 'off', minute === '02' ? 'empty' : 'used', 'off', 'off',
        minute === '02' ? 'denied' : 'empty', 'used']);
    assert.equal(artifact.payload.includes(marker), false);
    if (minute === '00') {
      const id = trace.peerProgress[0].progressId;
      assert.equal(artifact.payload, [
        'Agent Context Broker scope: project sample.',
        'Live peer progress (unverified; verify canonical sources before acting):',
        `- custom stream-lifecycle: active/implementation [claude-code] progress:${id}`,
        '  match peer progress',
        'Accepted claims are separate from this live/unverified section.',
        'The installed broker integration provides deeper queries and semantic checkpoint publication for this task.',
        'No raw peer conversation content was imported.'
      ].join('\n'));
      assert.equal(result.hookSpecificOutput.additionalContext, artifact.payload);
      assert.equal(trace.layers[4].included, 1);
      assert.deepEqual(trace.scopes, [{ relationKey: scopeRelation(scope.kind, scope.key), role: 'primary' }]);
    } else {
      assert.deepEqual(result, { continue: true });
      assert.equal(artifact.payload, '');
      if (minute === '01') {
        assert.equal(trace.peerProgress[0].reason, 'already-delivered');
        assert.deepEqual(trace.layers[4].reasons, { 'already-delivered': 1 });
        assert.equal(trace.layers[4].excluded, 1);
      }
    }
  }
});

test('notice layer remains off until a lane is present, then maps its state and counts', () => {
  const trace = createContextTrace();
  assert.deepEqual(trace.layers[5], { id: 'notices', state: 'off', included: 0, excluded: 0, reasons: {}, detail: null });
  for (const state of ['used', 'empty', 'off', 'denied', 'error']) {
    trace.layers = traceLayers(trace, { teamNoticeLane: { state, counts: {
      included: 2, read: 1, quarantined: 2, hiddenByAudience: 3, omittedByBudget: 4, unverified: 5
    } } });
    assert.deepEqual(trace.layers[5], { id: 'notices', state, included: 2, excluded: 15,
      reasons: { read: 1, quarantined: 2, hiddenByAudience: 3, omittedByBudget: 4, unverified: 5 }, detail: 'notices' });
    valid(trace);
  }
});

test('peer progress traces included, capped, expired and provider-excluded items without values', async () => {
  const h = home();
  await progress(h, 'one');
  await progress(h, 'two');
  await progress(h, 'old', { ttlSeconds: 60 });
  const query = { ...options(h, { maxClaims: 1 }), eventRuntimeRoot: h.events, trace: true };
  const result = await planContextQuery(query);
  assert.equal(result.trace.peerProgress.filter((item) => item.decision === 'included').length, 1);
  assert.deepEqual(result.trace.peerProgress.filter((item) => item.reason).map((item) => item.reason).sort(), ['cap', 'expired']);
  valid(result.trace);
  const excluded = await planContextQuery({ ...query, profiles: options(h, { crossProvider: false }).profiles });
  assert.ok(excluded.trace.peerProgress.every((item) => item.reason === 'provider'));
  valid(excluded.trace);
});

test('peer trace explains a stale relation after its ledger link disappears', async () => {
  const h = home();
  const directory = join(h.root, 'tickets', 'TASK-2');
  mkdirSync(directory, { recursive: true });
  const ledger = join(directory, 'jira-context.json');
  writeFileSync(ledger, JSON.stringify({ issue: { key: 'TASK-2' }, relatedTickets: {
    parent: null, subtasks: [], issueLinks: [{ linkType: 'Blocks', direction: 'inward', key: 'TASK-1' }]
  } }));
  await progress(h, 'linked', {
    scope: { kind: 'ticket', key: 'TASK-2' }, work: { kind: 'ticket', key: 'TASK-2' }
  });
  writeFileSync(ledger, JSON.stringify({ issue: { key: 'TASK-2' }, relatedTickets: { parent: null, subtasks: [], issueLinks: [] } }));
  const result = await planContextQuery({ ...options(h), trace: true, eventRuntimeRoot: h.events,
    scopeKind: 'ticket', scopeKey: 'TASK-1', ticketPackagesRoot: join(h.root, 'tickets') });
  assert.deepEqual(result.peerProgress, []);
  assert.equal(result.trace.peerProgress[0].reason, 'stale-relation');
  valid(result.trace);
});

test('empty routes, strict isolation, and byte truncation retain their existing behavior', async () => {
  const h = home();
  const missing = await planContextQuery({ ...options(h), trace: true });
  assert.equal(missing.trace.scopes.length, 1);
  valid(missing.trace);
  const isolated = await planContextQuery({ provider: providers[0], strictIsolation: true, trace: true });
  assert.deepEqual(isolated.trace.candidates, []);
  assert.deepEqual(isolated.trace.scopes, []);
  valid(isolated.trace);
  const unrouted = await planContextQuery({ provider: providers[0], trace: true });
  assert.equal(unrouted.profile, null);
  valid(unrouted.trace);
  await publish(h, [{ value: `${marker} match ${'long '.repeat(200)}` }]);
  const plain = await planContextQuery(options(h, { maxContextBytes: 256 }));
  const traced = await planContextQuery({ ...options(h, { maxContextBytes: 256 }), trace: true });
  assert.equal(traced.trace.candidates[0].decision, 'included');
  assert.equal(traced.context.includes(marker), false);
  assert.equal(traced.context, plain.context);
  assert.equal(traced.injection.digest, plain.injection.digest);
  assert.ok(traced.trace.budget.renderedContextBytes <= 256);
  valid(traced.trace);
});
