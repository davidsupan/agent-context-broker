import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  agentDescriptorFromEnvironment,
  isStoredAgentDescriptor,
  normalizeAgentDescriptor
} from '../src/agent-identity.mjs';
import { sha256, verifyEventStore } from '../src/event-store.mjs';
import { planPeerProgressPublication, publishPeerProgress, readPeerProgress } from '../src/peer-progress.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-agent-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
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
    scope: { kind: 'project', keyHash: sha256('example-project') },
    sensitivity: 'private'
  };
  await attestSource({ runtimeRoot: eventRuntimeRoot, attestation, execute: true });
  return planSourceAttestation({ attestation }).subjectRef;
}

function proposal(sourceToken, issueKey, summary, overrides = {}) {
  return {
    schemaVersion: 1,
    proposalId: `${issueKey.toLowerCase()}-progress`,
    sourceToken,
    scope: { kind: 'ticket', key: issueKey },
    work: { kind: 'ticket', key: issueKey },
    state: 'active',
    stage: 'implementation',
    summary,
    nextSteps: ['run the focused validation'],
    limitations: [],
    changedSurfaces: ['Orca API contract'],
    canonicalRefs: [],
    relatedScopes: [],
    observedAt: '2026-08-26T08:05:00.000Z',
    ttlSeconds: 3600,
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('agent descriptors are validated and bounded', () => {
  test('normalises a descriptor and hashes the raw instance id away', () => {
    const descriptor = normalizeAgentDescriptor({
      kind: 'interactive',
      harness: 'claude-code',
      harnessVersion: '2.0.1',
      model: 'claude-opus-5',
      instanceId: 'C:/git/main#pid-4188'
    });

    assert.equal(descriptor.kind, 'interactive');
    assert.equal(descriptor.model, 'claude-opus-5');
    assert.equal(descriptor.attestation, 'self-declared');
    // The raw id can carry a path or a pid, so only its hash is kept.
    assert.match(descriptor.instanceHash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(descriptor).includes('C:/git/main'), false);
  });

  test('absent descriptors stay absent rather than being invented', () => {
    assert.equal(normalizeAgentDescriptor(undefined), null);
    assert.equal(normalizeAgentDescriptor(null), null);
  });

  test('rejects unknown fields, bad kinds and prose', () => {
    assert.throws(() => normalizeAgentDescriptor({ kind: 'interactive', note: 'hello' }),
      /not allowed/u);
    assert.throws(() => normalizeAgentDescriptor({ kind: 'root' }), /kind is invalid/u);
    // A free-text field would put prose into ingested payloads, which the corpus audit
    // relies on being absent.
    assert.throws(() => normalizeAgentDescriptor({ model: 'the model we agreed on yesterday' }),
      /model is invalid/u);
    assert.throws(() => normalizeAgentDescriptor([{ kind: 'sdk' }]), /must be an object/u);
  });

  test('recognises its own stored shape and refuses a tampered one', () => {
    const stored = normalizeAgentDescriptor({ kind: 'subagent', harness: 'claude-code' });
    assert.equal(isStoredAgentDescriptor(stored), true);
    assert.equal(isStoredAgentDescriptor(null), true);
    assert.equal(isStoredAgentDescriptor({ ...stored, attestation: 'verified' }), false);
    assert.equal(isStoredAgentDescriptor({ ...stored, escalate: true }), false);
  });

  test('derives a descriptor from the environment without throwing on junk', () => {
    const derived = agentDescriptorFromEnvironment({
      CLAUDECODE: '1', CLAUDE_CODE_VERSION: '2.0.1', ANTHROPIC_MODEL: 'claude-opus-5'
    });
    assert.equal(derived.kind, 'interactive');
    assert.equal(derived.harness, 'claude-code');

    const subagent = agentDescriptorFromEnvironment({ CLAUDECODE: '1', ACB_SUBAGENT: '1' });
    assert.equal(subagent.kind, 'subagent');

    // A hostile or malformed environment must not break an otherwise valid publish.
    const junk = agentDescriptorFromEnvironment({ CLAUDECODE: '1', ANTHROPIC_MODEL: 'a b c d e'.repeat(40) });
    assert.equal(junk.kind, 'unknown');
  });
});

describe('agent identity is descriptive and never authorization', () => {
  test('records the publishing agent on the artifact and the event', async () => {
    const runtimeRoot = root('publish-runtime');
    const eventRuntimeRoot = root('publish-events');
    const token = await source(eventRuntimeRoot, 'codex', 'publish');

    await publishPeerProgress({
      runtimeRoot,
      eventRuntimeRoot,
      provider: 'codex',
      execute: true,
      proposal: proposal(token, 'APP-50001', 'Implementation underway', {
        agent: { kind: 'subagent', harness: 'codex-cli', model: 'gpt-x', instanceId: 'run-7' }
      })
    });

    const progress = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-50001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(progress.progress.length, 1);
    assert.equal(progress.progress[0].agent.kind, 'subagent');
    assert.equal(progress.progress[0].agent.attestation, 'self-declared');

    // The event payload carries the enumerated kind and a hash, never free text.
    const events = verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events
      .filter((event) => event.eventType === 'peer-progress.published');
    assert.equal(events.length, 1);
    assert.equal(events[0].payload.agentKind, 'subagent');
    assert.match(events[0].payload.agentInstanceHash, /^[a-f0-9]{64}$/u);
    assert.equal(JSON.stringify(events[0].payload).includes('run-7'), false);
  });

  test('a proposal without an agent still publishes and verifies', async () => {
    const runtimeRoot = root('optional-runtime');
    const eventRuntimeRoot = root('optional-events');
    const token = await source(eventRuntimeRoot, 'codex', 'optional');

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-50002', 'No agent declared')
    });

    const progress = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-50002', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(progress.progress.length, 1);
    assert.equal(progress.progress[0].agent, null);
  });

  test('declaring an identity does not change verification or ranking', async () => {
    const runtimeRoot = root('claims-runtime');
    const eventRuntimeRoot = root('claims-events');
    const token = await source(eventRuntimeRoot, 'codex', 'claims');

    // The same checkpoint, once anonymous and once claiming to be a trusted interactive
    // session. Neither may become more trusted than the other.
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-50003', 'Same summary', {
        agent: { kind: 'interactive', harness: 'claude-code' }
      })
    });
    const boastful = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-50003', now: '2026-08-26T08:10:00.000Z'
    }).progress[0];

    assert.equal(boastful.verification, 'unverified',
      'an agent must not verify itself by naming itself');
    assert.equal(boastful.sensitivity, 'shared');
    assert.ok(boastful.expiresAt, 'a declared identity must not exempt progress from its TTL');
  });

  test('an unknown agent field on a proposal is refused outright', async () => {
    const runtimeRoot = root('reject-runtime');
    const eventRuntimeRoot = root('reject-events');
    const token = await source(eventRuntimeRoot, 'codex', 'reject');

    await assert.rejects(() => publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-50004', 'Trying it on', {
        agent: { kind: 'interactive', trusted: true }
      })
    }), /not allowed/u);
  });

  test('the same work from two agents stays one actor, so supersede still works', async () => {
    const runtimeRoot = root('actor-runtime');
    const eventRuntimeRoot = root('actor-events');
    const token = await source(eventRuntimeRoot, 'codex', 'actor');

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-50005', 'First checkpoint', {
        agent: { kind: 'interactive', instanceId: 'one' }
      })
    });
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-50005', 'Second checkpoint', {
        agent: { kind: 'subagent', instanceId: 'two' },
        observedAt: '2026-08-26T08:06:00.000Z'
      })
    });

    // actorKey is deliberately not widened by the descriptor: if it were, a restarted agent
    // would stop superseding its own progress and the queue would fill with stale duplicates.
    const progress = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-50005', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(progress.progress.length, 1);
    assert.equal(progress.progress[0].summary, 'Second checkpoint');
  });
});

describe('query audits record who read the context', () => {
  test('the audit names the reading agent without changing the result', async () => {
    const { runContextQuery } = await import('../src/context-query.mjs');
    const runtimeRoot = root('query-runtime');
    const auditRoot = root('query-audit');

    const audited = await runContextQuery({
      provider: 'codex',
      runtimeRoot,
      scopeKind: 'project',
      scopeKey: 'example-project',
      projectScope: true,
      execute: true,
      globalAuditDirectory: auditRoot,
      agent: { kind: 'interactive', harness: 'claude-code', instanceId: 'session-9' }
    });

    const files = readdirSync(auditRoot).filter((name) => name.endsWith('.json'));
    assert.equal(files.length, 1);
    const audit = JSON.parse(readFileSync(join(auditRoot, files[0]), 'utf8'));
    assert.equal(audit.agent.kind, 'interactive');
    assert.equal(audit.agent.harness, 'claude-code');
    assert.equal(JSON.stringify(audit).includes('session-9'), false);
    // Reading is unaffected by who says they are reading.
    assert.equal(audited.claims.length, 0);
  });
});
