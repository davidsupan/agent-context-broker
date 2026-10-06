import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sha256, verifyEventStore } from '../src/event-store.mjs';
import { planContextQuery } from '../src/context-query.mjs';
import { createLifecycleConsumer } from '../src/lifecycle-consumer.mjs';
import { planPeerProgressPublication, publishPeerProgress, readPeerProgress } from '../src/peer-progress.mjs';
import {
  assertPublishable,
  describeProviderPolicy,
  loadProviderPolicy,
  parseProviderPolicy,
  providerPolicyPath,
  readRestricted,
  scopeReadable
} from '../src/provider-policy.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-provider-policy-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function policy(providers) {
  return parseProviderPolicy(JSON.stringify({ schemaVersion: 1, providers }));
}

async function source(eventRuntimeRoot, provider, suffix) {
  const attestation = {
    schemaVersion: 1,
    provider,
    sessionKey: sha256(`${provider}:${suffix}:session`),
    recordKey: sha256(`${provider}:${suffix}:record`),
    sourceHash: sha256(`${provider}:${suffix}:source`),
    inventoryHash: sha256(`${provider}:${suffix}:inventory`),
    observedAt: '2026-08-26T08:00:00.000Z',
    scope: { kind: 'workstream', keyHash: sha256('research-inbox') },
    sensitivity: 'private'
  };
  await attestSource({ runtimeRoot: eventRuntimeRoot, attestation, execute: true });
  return planSourceAttestation({ attestation }).subjectRef;
}

function progress(sourceToken, scope, summary) {
  return {
    schemaVersion: 1,
    proposalId: `${scope.key}-progress`,
    sourceToken,
    scope,
    work: { kind: 'implementation', key: `${scope.key}-work` },
    state: 'active',
    stage: 'research',
    summary,
    observedAt: '2026-08-26T08:01:00.000Z',
    ttlSeconds: 3600
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('provider policy document', () => {
  test('parses strictly and rejects unknown fields, providers and patterns', () => {
    const parsed = policy({ codex: { read: { allow: ['workstream:research-*'] } } });
    assert.equal(parsed.schemaVersion, 1);
    assert.match(parsed.sha256, /^[a-f0-9]{64}$/u);
    for (const document of [
      { schemaVersion: 2, providers: {} },
      { schemaVersion: 1, providers: {}, extra: true },
      { schemaVersion: 1, providers: { other: {} } },
      { schemaVersion: 1, providers: { codex: { read: { allow: ['team:x'] } } } },
      { schemaVersion: 1, providers: { codex: { read: { allow: ['workstream:has space'] } } } },
      { schemaVersion: 1, providers: { codex: { read: { allow: 'workstream:x' } } } },
      { schemaVersion: 1, providers: { codex: { read: { only: [] } } } },
      { schemaVersion: 1, providers: { codex: { publish: { maxSensitivity: 'secret' } } } },
      { schemaVersion: 1, providers: { codex: { publish: { evidenceClasses: ['rumour'] } } } },
      { schemaVersion: 1, providers: { codex: { strictIsolation: 'yes' } } },
      { schemaVersion: 1, providers: { codex: { defaultProject: '../other' } } }
    ]) {
      assert.throws(() => parseProviderPolicy(JSON.stringify(document)), /Provider policy is invalid/u);
    }
    assert.throws(() => parseProviderPolicy('{'), /Provider policy is invalid/u);
  });

  test('an absent file means no policy and a present invalid file fails closed', () => {
    const home = root('load');
    assert.equal(loadProviderPolicy({ runtimeHome: home, env: {} }), null);
    writeFileSync(join(home, 'provider-policy.json'), '{"schemaVersion":1,"providers":{"codex":{"bogus":1}}}');
    assert.throws(() => loadProviderPolicy({ runtimeHome: home, env: {} }), /Provider policy is invalid/u);
    const explicit = join(home, 'explicit.json');
    writeFileSync(explicit, JSON.stringify({ schemaVersion: 1, providers: { codex: { strictIsolation: true } } }));
    assert.equal(loadProviderPolicy({ env: { AGENT_CONTEXT_BROKER_PROVIDER_POLICY: explicit } }).providers.codex.strictIsolation, true);
    assert.equal(describeProviderPolicy(null).state, 'absent');
  });

  test('explicit runtime roots select the policy of their own runtime home', () => {
    const home = root('store-home');
    const ambient = root('ambient-home');
    const file = join(home, 'provider-policy.json');
    const standard = [join(home, 'runtime', 'reconciliation'), join(home, 'runtime', 'events')];
    assert.equal(providerPolicyPath({ runtimeRoots: standard, env: { AGENT_CONTEXT_BROKER_HOME: ambient } }), file);
    // Roots outside one standard home inherit no policy, so an ambient home cannot leak in.
    assert.equal(providerPolicyPath({ runtimeRoots: [root('custom-runtime')], env: { AGENT_CONTEXT_BROKER_HOME: ambient } }), null);
    assert.equal(providerPolicyPath({ runtimeRoots: [standard[0], join(ambient, 'runtime', 'events')], env: {} }), null);
    assert.equal(loadProviderPolicy({ runtimeRoots: [root('custom-only')], env: {} }), null);
    // Explicit settings still win, and no roots keep the default home.
    assert.equal(providerPolicyPath({ runtimeRoots: [root('custom-runtime-2')],
      env: { AGENT_CONTEXT_BROKER_PROVIDER_POLICY: join(ambient, 'p.json') } }), resolve(join(ambient, 'p.json')));
    assert.equal(providerPolicyPath({ runtimeRoots: [], env: { AGENT_CONTEXT_BROKER_HOME: ambient } }), join(ambient, 'provider-policy.json'));
  });

  test('read rules are an allow-list with deny precedence and case-insensitive globs', () => {
    const rules = policy({ codex: { read: { allow: ['workstream:research-*', 'project:personal'],
      deny: ['workstream:research-secret'] } } });
    assert.equal(scopeReadable(rules, { kind: 'workstream', key: 'Research-Inbox' }, 'codex'), true);
    assert.equal(scopeReadable(rules, { kind: 'project', key: 'personal' }, 'codex'), true);
    assert.equal(scopeReadable(rules, { kind: 'workstream', key: 'research-secret' }, 'codex'), false);
    assert.equal(scopeReadable(rules, { kind: 'project', key: 'example-project' }, 'codex'), false);
    assert.equal(scopeReadable(rules, { kind: 'ticket', key: 'APP-1' }, 'codex'), false);
    assert.equal(scopeReadable(rules, { kind: 'workstream', key: 'research.' }, 'codex'), false);
    assert.equal(scopeReadable(rules, { kind: 'project', key: 'example-project' }, 'claude-code'), true);
    assert.equal(readRestricted(rules, 'codex'), true);
    assert.equal(readRestricted(rules, 'claude-code'), false);
    const denyOnly = policy({ codex: { read: { deny: ['ticket:*', '*:example-project'] } } });
    assert.equal(scopeReadable(denyOnly, { kind: 'workstream', key: 'anything' }, 'codex'), true);
    assert.equal(scopeReadable(denyOnly, { kind: 'ticket', key: 'APP-1' }, 'codex'), false);
    assert.equal(scopeReadable(denyOnly, { kind: 'project', key: 'example-project' }, 'codex'), false);
  });

  test('publication checks scope, sensitivity, evidence class and isolation', () => {
    const rules = policy({
      codex: { publish: { allow: ['workstream:research-inbox'], maxSensitivity: 'private', evidenceClasses: ['agent-handoff'] } },
      'claude-code': { strictIsolation: true }
    });
    const inbox = { kind: 'workstream', key: 'research-inbox' };
    assert.doesNotThrow(() => assertPublishable(rules, 'codex', inbox, [{ sensitivity: 'private', evidenceClass: 'agent-handoff' }]));
    assert.throws(() => assertPublishable(rules, 'codex', { kind: 'project', key: 'example-project' }), /denies publication to this scope/u);
    assert.throws(() => assertPublishable(rules, 'codex', inbox, [{ sensitivity: 'restricted' }]), /sensitivity/u);
    assert.throws(() => assertPublishable(rules, 'codex', inbox, [{ evidenceClass: 'canonical-artifact' }]), /evidence class/u);
    assert.throws(() => assertPublishable(rules, 'claude-code', inbox), /isolates/u);
    assert.doesNotThrow(() => assertPublishable(null, 'codex', { kind: 'project', key: 'example-project' }));
  });
});

describe('provider policy enforcement', () => {
  test('peer progress publication is refused outside the allowed scopes before any write', async () => {
    const runtimeRoot = root('publish-runtime');
    const eventRuntimeRoot = root('publish-events');
    const sourceToken = await source(eventRuntimeRoot, 'codex', 'publish');
    const rules = policy({ codex: { publish: { allow: ['workstream:research-inbox'] } } });
    const denied = { runtimeRoot, eventRuntimeRoot, provider: 'codex', providerPolicy: rules,
      proposal: progress(sourceToken, { kind: 'project', key: 'example-project' }, 'Denied research note') };
    assert.throws(() => planPeerProgressPublication(denied), /denies publication to this scope/u);
    await assert.rejects(publishPeerProgress({ ...denied, execute: true }), /denies publication to this scope/u);
    // Only the publication lock directory may exist; no artifact or event was written.
    const written = readdirSync(join(runtimeRoot, 'peer-progress'), { recursive: true })
      .filter((name) => String(name).endsWith('.json'));
    assert.deepEqual(written, []);
    assert.equal(verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events
      .filter((event) => event.eventType === 'peer-progress.published').length, 0);
    const allowed = await publishPeerProgress({ runtimeRoot, eventRuntimeRoot, provider: 'codex', providerPolicy: rules,
      execute: true, proposal: progress(sourceToken, { kind: 'workstream', key: 'research-inbox' }, 'Allowed research note') });
    assert.equal(allowed.writesEnabled, true);
  });

  test('peer progress reads honour read rules and stay unchanged without a policy', async () => {
    const runtimeRoot = root('read-runtime');
    const eventRuntimeRoot = root('read-events');
    const sourceToken = await source(eventRuntimeRoot, 'claude-code', 'read');
    await publishPeerProgress({ runtimeRoot, eventRuntimeRoot, provider: 'claude-code', execute: true,
      proposal: progress(sourceToken, { kind: 'workstream', key: 'work-stream' }, 'Work progress note') });
    const read = (providerPolicy) => readPeerProgress({ runtimeRoot, eventRuntimeRoot, provider: 'codex',
      crossProvider: true, scopeKind: 'workstream', scopeKey: 'work-stream', terms: [],
      now: '2026-08-26T08:02:00.000Z', providerPolicy });
    assert.equal(read(undefined).progress.length, 1);
    assert.equal(read(policy({ 'claude-code': { read: { allow: ['workstream:other'] } } })).progress.length, 1);
    const restricted = read(policy({ codex: { read: { allow: ['workstream:research-*'] } } }));
    assert.deepEqual(restricted, { progress: [], warnings: ['provider-policy-denied'] });
    assert.deepEqual(read(policy({ codex: { strictIsolation: true } })).progress, []);
  });

  test('context query returns no claims for a denied scope', async () => {
    const result = await planContextQuery({
      provider: 'codex',
      profileId: 'review',
      terms: ['review'],
      scopeKind: 'project',
      scopeKey: 'example-project',
      providerPolicy: policy({ codex: { read: { allow: ['workstream:research-*'] } } }),
      now: '2026-08-25T09:01:00.000Z'
    });
    assert.deepEqual(result.claims, []);
    assert.deepEqual(result.peerProgress, []);
    assert.ok(result.warnings.includes('provider-policy-denied'));
  });

  test('the hook withholds peer context the policy denies and fails closed on an invalid file', async () => {
    const runtime = root('hook-runtime');
    const eventRuntime = root('hook-events');
    const contextRuntime = root('hook-context');
    const sourceToken = await source(eventRuntime, 'codex', 'hook');
    await publishPeerProgress({ runtimeRoot: contextRuntime, eventRuntimeRoot: eventRuntime, provider: 'codex',
      execute: true, proposal: progress(sourceToken, { kind: 'workstream', key: 'shared-proof' }, 'Peer note for the hook') });
    const policyPath = join(root('hook-policy'), 'provider-policy.json');
    const lifecycle = createLifecycleConsumer({
      provider: 'claude-code',
      adapterModule: 'claude-inventory.mjs',
      adapterRoot: packageRoot,
      runtimeRoot: runtime,
      eventRuntimeRoot: eventRuntime,
      contextRuntimeRoot: contextRuntime,
      providerPolicyPath: policyPath,
      supportedEvents: ['UserPromptSubmit'],
      advisoryEvents: ['UserPromptSubmit'],
      allowedTranscriptRoots: () => []
    });
    const hookEvent = (session) => ({
      session_id: session,
      transcript_path: join(runtime, 'not-created-yet.jsonl'),
      hook_event_name: 'UserPromptSubmit',
      cwd: 'C:\\work\\sample-project',
      prompt: 'Continue workstream shared-proof.'
    });
    const hookOptions = { testMode: true, now: '2026-08-26T08:02:00.000Z' };

    const open = await lifecycle.handleHookEvent(hookEvent('no-policy'), hookOptions);
    assert.match(open.hookSpecificOutput.additionalContext, /Peer note for the hook/u);

    writeFileSync(policyPath, JSON.stringify({ schemaVersion: 1, providers: { 'claude-code': { read: { allow: ['workstream:research-*'] } } } }));
    const denied = await lifecycle.handleHookEvent(hookEvent('denied'), hookOptions);
    assert.equal(JSON.stringify(denied).includes('Peer note for the hook'), false);

    writeFileSync(policyPath, '{"schemaVersion":1,"providers":{"claude-code":{"unknown":true}}}');
    const invalid = await lifecycle.handleHookEvent(hookEvent('invalid'), hookOptions);
    assert.deepEqual(invalid, { continue: true });
    const outcomes = readdirSync(join(runtime, 'audit')).map((name) =>
      JSON.parse(readFileSync(join(runtime, 'audit', name), 'utf8')).outcome);
    assert.ok(outcomes.includes('provider-policy-invalid'));
  });
});
