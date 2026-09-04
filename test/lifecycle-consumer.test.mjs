import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLifecycleConsumer } from '../src/lifecycle-consumer.mjs';
import { verifyEventStore } from '../src/event-store.mjs';
import { publishPeerProgress } from '../src/peer-progress.mjs';
import {
  attestSource,
  planSourceAttestation,
  provenanceForSourceToken
} from '../src/source-attestation.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(packageRoot, 'fixtures');
const temporaryRoots = [];

function tempRoot(name) {
  const root = join(tmpdir(), `agent-context-lifecycle-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function fixture(root, name) {
  const path = join(root, name);
  copyFileSync(join(fixtures, name), path);
  return path;
}

function runtimeText(root) {
  const output = [];
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else output.push(readFileSync(child, 'utf8'));
    }
  }
  if (existsSync(root)) visit(root);
  return output.join('\n');
}

function consumer(provider, runtimeRoot) {
  const isClaude = provider === 'claude-code';
  return createLifecycleConsumer({
    provider,
    adapterModule: isClaude ? 'claude-inventory.mjs' : 'codex-inventory-v2.mjs',
    adapterRoot: packageRoot,
    runtimeRoot,
    supportedEvents: isClaude
      ? ['SessionStart', 'UserPromptSubmit', 'SessionEnd']
      : ['SessionStart', 'UserPromptSubmit'],
    advisoryEvents: ['SessionStart', 'UserPromptSubmit'],
    lifecycleForEvent: (eventName) => ({
      SessionStart: isClaude ? 'session_start' : null,
      SessionEnd: isClaude ? 'session_end' : null
    })[eventName] ?? null,
    allowedTranscriptRoots: () => []
  });
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('provider-neutral lifecycle consumer', () => {
  test('Codex advisory ignores prompt content and consumes a clean snapshot once', async () => {
    const root = tempRoot('codex');
    const runtime = join(root, 'runtime', 'codex');
    const source = fixture(root, 'codex-active.jsonl');
    const codex = await import('../src/codex-inventory-v2.mjs');
    const identity = await codex.readSourceIdentity(source);
    const accepted = join(root, 'accepted.json');
    writeFileSync(accepted, `${JSON.stringify({
      schemaVersion: 1,
      snapshots: [{
        snapshotId: 'fixture-snapshot',
        state: 'clean',
        digest: 'fixture-digest',
        relationKeys: [identity.relationKeys[0]],
        canonicalRefs: ['context://accepted/fixture']
      }]
    })}\n`, 'utf8');
    const hook = {
      session_id: 'fixture-session',
      transcript_path: source,
      hook_event_name: 'UserPromptSubmit',
      prompt: 'PROMPT_MUST_NOT_PERSIST'
    };
    const instance = consumer('codex', runtime);
    const first = await instance.handleHookEvent(hook, {
      testMode: true,
      acceptedSnapshots: accepted,
      now: '2026-08-24T12:30:00.000Z'
    });
    const replay = await instance.handleHookEvent(hook, {
      testMode: true,
      acceptedSnapshots: accepted,
      now: '2026-08-24T12:31:00.000Z'
    });

    assert.match(first.hookSpecificOutput.additionalContext, /context:\/\/accepted\/fixture/u);
    assert.match(first.hookSpecificOutput.additionalContext, /source token: acb:\/\/source\/[a-f0-9]{64}/u);
    assert.match(first.hookSpecificOutput.additionalContext, /thread ref: context:\/\/thread\/[a-f0-9]{64}/u);
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /invoke the installed broker integration/u
    );
    assert.match(
      first.hookSpecificOutput.additionalContext,
      /retrieve the narrowest accepted context profile/u
    );
    assert.match(first.hookSpecificOutput.additionalContext, /publish bounded progress/u);
    assert.match(first.hookSpecificOutput.additionalContext, /No raw peer conversation content/u);
    const sourceToken = first.hookSpecificOutput.additionalContext.match(
      /acb:\/\/source\/[a-f0-9]{64}/u
    )[0];
    assert.equal(
      provenanceForSourceToken({ runtimeRoot: join(runtime, '..', 'events'), sourceToken }).provider,
      'codex'
    );
    const injectionPath = readdirSync(join(runtime, 'injections'))
      .map((name) => join(runtime, 'injections', name))[0];
    const injection = JSON.parse(readFileSync(injectionPath, 'utf8'));
    assert.equal(injection.payload, first.hookSpecificOutput.additionalContext);
    assert.deepEqual(replay, { continue: true });
    assert.match(runtimeText(join(runtime, 'audit')), /"sourceTokenState":"confirmed-delivery"/u);
    assert.equal(runtimeText(runtime).includes('PROMPT_MUST_NOT_PERSIST'), false);
    assert.equal(runtimeText(runtime).includes('fixture-session'), false);
  });

  test('Claude SessionEnd records terminal metadata without injecting context', async () => {
    const root = tempRoot('claude');
    const runtime = join(root, 'runtime', 'claude');
    const source = fixture(root, 'claude-active.jsonl');
    const instance = consumer('claude-code', runtime);
    const result = await instance.handleHookEvent({
      session_id: 'fixture-claude-session',
      transcript_path: source,
      hook_event_name: 'SessionEnd',
      reason: 'other',
      prompt: 'CLAUDE_PROMPT_MUST_NOT_PERSIST'
    }, {
      testMode: true,
      now: '2026-08-24T12:32:00.000Z'
    });
    const inventory = JSON.parse(readFileSync(
      readdirSync(join(runtime, 'current'), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(runtime, 'current', entry.name, 'inventory.json'))[0],
      'utf8'
    ));

    assert.deepEqual(result, { continue: true });
    assert.equal(inventory.sources[0].threadState, 'completed');
    assert.equal(runtimeText(runtime).includes('CLAUDE_PROMPT_MUST_NOT_PERSIST'), false);
  });

  test('missing source fails open with classified metadata-only audit', async () => {
    const root = tempRoot('missing');
    const runtime = join(root, 'runtime');
    const instance = consumer('claude-code', runtime);
    const result = await instance.handleHookEvent({
      session_id: 'private-native-id',
      transcript_path: join(root, 'missing.jsonl'),
      hook_event_name: 'SessionStart'
    }, { testMode: true });

    assert.deepEqual(result, { continue: true });
    assert.match(runtimeText(runtime), /TranscriptUnavailable/u);
    assert.equal(runtimeText(runtime).includes('private-native-id'), false);
  });

  test('injects scoped peer progress when a fresh Claude print transcript is unavailable', async () => {
    const runtime = tempRoot('natural-print-runtime');
    const contextRuntime = tempRoot('natural-print-context');
    const eventRuntime = tempRoot('natural-print-events');
    const ticketPackages = tempRoot('natural-print-tickets');
    const attestation = {
      schemaVersion: 1,
      provider: 'codex',
      sessionKey: '1'.repeat(64),
      recordKey: '2'.repeat(64),
      sourceHash: '3'.repeat(64),
      inventoryHash: '4'.repeat(64),
      observedAt: '2026-08-26T08:00:00.000Z',
      scope: { kind: 'workstream', keyHash: '5'.repeat(64) },
      sensitivity: 'shared'
    };
    await attestSource({ runtimeRoot: eventRuntime, attestation, execute: true });
    const sourceToken = planSourceAttestation({ attestation }).subjectRef;
    const published = await publishPeerProgress({
      runtimeRoot: contextRuntime,
      eventRuntimeRoot: eventRuntime,
      provider: 'codex',
      execute: true,
      proposal: {
        schemaVersion: 1,
        proposalId: 'natural-print-progress',
        sourceToken,
        scope: { kind: 'workstream', key: 'agent-context-broker-live-proof-20260826' },
        work: { kind: 'implementation', key: 'agent-context-broker-protocol-0.7' },
        state: 'active',
        stage: 'validation',
        summary: 'Codex canonical validation passed.',
        observedAt: '2026-08-26T08:01:00.000Z',
        ttlSeconds: 3600
      }
    });
    const lifecycle = createLifecycleConsumer({
      provider: 'claude-code',
      adapterModule: 'claude-inventory.mjs',
      adapterRoot: packageRoot,
      runtimeRoot: runtime,
      eventRuntimeRoot: eventRuntime,
      contextRuntimeRoot: contextRuntime,
      ticketPackagesRoot: ticketPackages,
      supportedEvents: ['UserPromptSubmit'],
      advisoryEvents: ['UserPromptSubmit'],
      allowedTranscriptRoots: () => []
    });
    const hookEvent = {
      session_id: 'natural-print-session',
      transcript_path: join(runtime, 'not-created-yet.jsonl'),
      hook_event_name: 'UserPromptSubmit',
      cwd: 'C:\\work\\sample-project',
      prompt: 'Continue workstream agent-context-broker-live-proof-20260826. RAW_PROMPT_MUST_NOT_PERSIST'
    };
    const hookOptions = { testMode: true, now: '2026-08-26T08:02:00.000Z' };
    const result = await lifecycle.handleHookEvent(hookEvent, hookOptions);
    const replay = await lifecycle.handleHookEvent(hookEvent, hookOptions);
    const ambiguous = await lifecycle.handleHookEvent({
      ...hookEvent,
      session_id: 'ambiguous-natural-print-session',
      prompt: 'Compare workstream agent-context-broker-live-proof-20260826 with workstream unrelated-proof.'
    }, hookOptions);

    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /Live peer progress \(unverified/u);
    assert.match(context, new RegExp(published.progressId, 'u'));
    assert.match(context, /Codex canonical validation passed/u);
    assert.match(context, /No raw peer conversation content was imported/u);
    assert.deepEqual(replay, { continue: true });
    assert.deepEqual(ambiguous, { continue: true });
    assert.equal(runtimeText(runtime).includes('RAW_PROMPT_MUST_NOT_PERSIST'), false);
    assert.equal(runtimeText(runtime).includes('Compare workstream'), false);
    const injections = readdirSync(join(runtime, 'injections')).map((name) =>
      JSON.parse(readFileSync(join(runtime, 'injections', name), 'utf8'))
    );
    assert.equal(injections.length, 1);
    assert.equal(injections[0].payload, context);
    assert.equal(
      injections[0].digest,
      createHash('sha256').update(context, 'utf8').digest('hex')
    );
    const audit = readdirSync(join(runtime, 'audit')).map((name) =>
      JSON.parse(readFileSync(join(runtime, 'audit', name), 'utf8'))
    );
    assert.equal(audit.length, 3);
    const partial = audit.find((item) => item.outcome === 'context-partial');
    assert.equal(partial.errorClass, 'TranscriptUnavailable');
    assert.equal(partial.peerProgressCount, 1);
    assert.equal(partial.peerScopeKind, 'workstream');
    assert.equal(partial.peerScopeKeyHash.length, 64);
    assert.equal(audit.filter((item) => item.outcome === 'fail-open').length, 2);
  });

  test('routes natural review prompts to the merge request ledger scope', async () => {
    const runtime = tempRoot('natural-review-runtime');
    const contextRuntime = tempRoot('natural-review-context');
    const eventRuntime = tempRoot('natural-review-events');
    const reviewLedgersRoot = tempRoot('natural-review-ledgers');
    const reviewRoot = join(reviewLedgersRoot, 'mr-8466');
    mkdirSync(reviewRoot, { recursive: true });
    writeFileSync(join(reviewRoot, 'metadata.json'), `${JSON.stringify({
      references: { full: 'acme/widgets!8466' },
      iid: 8466,
      title: 'APP-19979 review'
    })}\n`, 'utf8');
    const attestation = {
      schemaVersion: 1,
      provider: 'codex',
      sessionKey: '6'.repeat(64),
      recordKey: '7'.repeat(64),
      sourceHash: '8'.repeat(64),
      inventoryHash: '9'.repeat(64),
      observedAt: '2026-09-02T08:00:00.000Z',
      scope: { kind: 'project', keyHash: 'a'.repeat(64) },
      sensitivity: 'shared'
    };
    await attestSource({ runtimeRoot: eventRuntime, attestation, execute: true });
    const sourceToken = planSourceAttestation({ attestation }).subjectRef;
    const published = await publishPeerProgress({
      runtimeRoot: contextRuntime,
      eventRuntimeRoot: eventRuntime,
      reviewLedgersRoot,
      provider: 'codex',
      execute: true,
      proposal: {
        schemaVersion: 1,
        proposalId: 'natural-review-progress',
        sourceToken,
        scope: { kind: 'merge-request', key: 'acme/widgets!8466' },
        work: { kind: 'review', key: 'acme/widgets!8466' },
        state: 'active',
        stage: 'review',
        summary: 'Review confirmed a contract compatibility risk.',
        nextSteps: [],
        limitations: [],
        changedSurfaces: ['review evidence only'],
        canonicalRefs: ['https://gitlab.example.com/acme/widgets/-/merge_requests/8466'],
        relatedScopes: [],
        revision: null,
        observedAt: '2026-09-02T08:01:00.000Z',
        ttlSeconds: 3600
      }
    });
    const lifecycle = createLifecycleConsumer({
      provider: 'claude-code',
      adapterModule: 'claude-inventory.mjs',
      adapterRoot: packageRoot,
      runtimeRoot: runtime,
      eventRuntimeRoot: eventRuntime,
      contextRuntimeRoot: contextRuntime,
      reviewLedgersRoot,
      supportedEvents: ['UserPromptSubmit'],
      advisoryEvents: ['UserPromptSubmit'],
      allowedTranscriptRoots: () => []
    });
    const result = await lifecycle.handleHookEvent({
      session_id: 'natural-review-session',
      transcript_path: join(runtime, 'not-created-yet.jsonl'),
      hook_event_name: 'UserPromptSubmit',
      cwd: 'C:\\work\\sample-project',
      prompt: 'Please rereview acme/widgets!8466. RAW_REVIEW_PROMPT_MUST_NOT_PERSIST'
    }, { testMode: true, now: '2026-09-02T08:02:00.000Z' });

    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /scope: merge-request acme\/widgets!8466/u);
    assert.match(context, new RegExp(published.progressId, 'u'));
    assert.match(context, /contract compatibility risk/u);
    assert.equal(runtimeText(runtime).includes('RAW_REVIEW_PROMPT_MUST_NOT_PERSIST'), false);
  });

  test('routes a configured standalone thread through project context without a ticket or review ledger', async () => {
    const runtime = tempRoot('natural-standalone-runtime');
    const contextRuntime = tempRoot('natural-standalone-context');
    const eventRuntime = tempRoot('natural-standalone-events');
    const attestation = {
      schemaVersion: 1,
      provider: 'codex',
      sessionKey: 'b'.repeat(64),
      recordKey: 'c'.repeat(64),
      sourceHash: 'd'.repeat(64),
      inventoryHash: 'e'.repeat(64),
      observedAt: '2026-09-03T08:00:00.000Z',
      scope: { kind: 'project', keyHash: 'f'.repeat(64) },
      sensitivity: 'shared'
    };
    await attestSource({ runtimeRoot: eventRuntime, attestation, execute: true });
    const sourceToken = planSourceAttestation({ attestation }).subjectRef;
    const published = await publishPeerProgress({
      runtimeRoot: contextRuntime,
      eventRuntimeRoot: eventRuntime,
      provider: 'codex',
      execute: true,
      proposal: {
        schemaVersion: 1,
        proposalId: 'natural-standalone-progress',
        sourceToken,
        scope: { kind: 'project', key: 'example-project' },
        work: { kind: 'thread', key: 'current' },
        state: 'completed',
        stage: 'handoff',
        summary: 'Context broker launcher release is complete.',
        nextSteps: [],
        limitations: [],
        changedSurfaces: ['shared agent package'],
        canonicalRefs: [],
        relatedScopes: [],
        revision: null,
        observedAt: '2026-09-03T08:01:00.000Z',
        ttlSeconds: 604800
      }
    });
    const lifecycle = createLifecycleConsumer({
      provider: 'claude-code',
      adapterModule: 'claude-inventory.mjs',
      adapterRoot: packageRoot,
      runtimeRoot: runtime,
      eventRuntimeRoot: eventRuntime,
      contextRuntimeRoot: contextRuntime,
      defaultProjectKey: 'example-project',
      supportedEvents: ['UserPromptSubmit'],
      advisoryEvents: ['UserPromptSubmit'],
      allowedTranscriptRoots: () => []
    });
    const result = await lifecycle.handleHookEvent({
      session_id: 'natural-standalone-session',
      transcript_path: join(runtime, 'not-created-yet.jsonl'),
      hook_event_name: 'UserPromptSubmit',
      cwd: 'C:\\Users\\developer',
      prompt: 'Continue the context broker launcher release. RAW_STANDALONE_PROMPT_MUST_NOT_PERSIST'
    }, { testMode: true, now: '2026-09-03T08:02:00.000Z' });

    const context = result.hookSpecificOutput.additionalContext;
    assert.match(context, /scope: project example-project/u);
    assert.match(context, new RegExp(published.progressId, 'u'));
    assert.match(context, /launcher release is complete/u);
    assert.equal(runtimeText(runtime).includes('RAW_STANDALONE_PROMPT_MUST_NOT_PERSIST'), false);
  });

  test('Codex accepts Windows device-prefixed transcript paths', {
    skip: process.platform !== 'win32'
  }, async () => {
    const root = tempRoot('windows-device-path');
    const runtime = join(root, 'runtime');
    const source = fixture(root, 'codex-active.jsonl');
    const result = await consumer('codex', runtime).handleHookEvent({
      session_id: 'private-native-id',
      transcript_path: `\\\\?\\${source}`,
      hook_event_name: 'UserPromptSubmit'
    }, {
      allowedTranscriptRoots: [root]
    });

    assert.ok(result.hookSpecificOutput?.additionalContext);
    assert.doesNotMatch(runtimeText(runtime), /fail-open/u);
    assert.equal(runtimeText(runtime).includes('private-native-id'), false);
  });

  test('strict isolation returns before transcript or runtime access', async () => {
    const root = tempRoot('strict-isolation');
    const runtime = join(root, 'runtime');
    const instance = consumer('codex', runtime);
    const result = await instance.handleHookEvent({
      session_id: 'private-native-id',
      transcript_path: join(root, 'missing.jsonl'),
      hook_event_name: 'SessionStart'
    }, { strictIsolation: true });

    assert.deepEqual(result, { continue: true });
    assert.equal(existsSync(runtime), false);
  });

  test('both providers publish metadata-only inventory and delta events', async () => {
    const root = tempRoot('provider-events');
    const eventRuntime = join(root, 'events');
    for (const provider of ['codex', 'claude-code']) {
      const runtime = join(root, 'runtime', provider);
      const source = fixture(root, provider === 'codex'
        ? 'codex-active.jsonl'
        : 'claude-active.jsonl');
      await consumer(provider, runtime).handleHookEvent({
        session_id: `fixture-${provider}`,
        transcript_path: source,
        hook_event_name: 'UserPromptSubmit',
        prompt: 'SECRET_PROMPT_MUST_NOT_PERSIST'
      }, {
        testMode: true,
        eventRuntimeRoot: eventRuntime,
        now: '2026-08-24T12:40:00.000Z'
      });
    }
    const events = verifyEventStore({ runtimeRoot: eventRuntime }).events;
    assert.deepEqual(events.map((event) => event.provider), [
      'codex', 'codex', 'claude-code', 'claude-code'
    ]);
    assert.deepEqual(events.map((event) => event.eventType), [
      'source.inventoryed', 'thread.delta',
      'source.inventoryed', 'thread.delta'
    ]);
    assert.equal(runtimeText(root).includes('SECRET_PROMPT_MUST_NOT_PERSIST'), false);
  });
});
