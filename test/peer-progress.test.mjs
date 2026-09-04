import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, test } from 'node:test';

import { sha256, verifyEventStore } from '../src/event-store.mjs';
import { planContextQuery, runContextQuery } from '../src/context-query.mjs';
import { projectReadModel } from '../src/read-model.mjs';
import {
  planPeerProgressPublication,
  publishPeerProgress,
  readPeerProgress
} from '../src/peer-progress.mjs';
import { attestSource, planSourceAttestation } from '../src/source-attestation.mjs';

const roots = [];

function sharedWrapper() {
  const candidates = [
    join(import.meta.dirname, '..', 'scripts', 'agent-context.mjs'),
    join(import.meta.dirname, '..', '..', '..', 'scripts', 'agent-context.mjs'),
    join(import.meta.dirname, '..', '..', 'scripts', 'agent-context.mjs')
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function root(name) {
  const value = join(tmpdir(), `acb-peer-progress-${name}-${randomUUID()}`);
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
    canonicalRefs: [`jira://browse/${issueKey}`],
    relatedScopes: [],
    observedAt: '2026-08-26T08:05:00.000Z',
    ttlSeconds: 3600,
    ...overrides
  };
}

function ticket(packagesRoot, issueKey, relatedTickets = {}) {
  const packageRoot = join(packagesRoot, issueKey);
  mkdirSync(packageRoot, { recursive: true });
  writeFileSync(join(packageRoot, 'README.md'), `# ${issueKey}\n`, 'utf8');
  writeFileSync(join(packageRoot, 'jira-context.json'), `${JSON.stringify({
    issue: { key: issueKey },
    relatedTickets: {
      parent: null,
      subtasks: [],
      issueLinks: [],
      ...relatedTickets
    }
  }, null, 2)}\n`, 'utf8');
}

function reviewLedger(reviewLedgersRoot, mergeRequestKey, ticketKeys = []) {
  const [project, iid] = mergeRequestKey.split('!');
  const directory = join(reviewLedgersRoot, `mr-${iid}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'metadata.json'), `${JSON.stringify({
    schemaVersion: 1,
    mergeRequest: Number(iid),
    project,
    issue: ticketKeys[0] ?? null,
    title: ticketKeys.join(' '),
    sourceBranch: ticketKeys[0] ? `feature/${ticketKeys[0]}-review-proof` : 'feature/review-proof'
  }, null, 2)}\n`, 'utf8');
  return directory;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('peer progress', () => {
  test('plans without writes and publishes a verified artifact event', async () => {
    const runtimeRoot = root('plan-runtime');
    const eventRuntimeRoot = root('plan-events');
    const sourceToken = await source(eventRuntimeRoot, 'codex', 'plan');
    const input = {
      runtimeRoot,
      eventRuntimeRoot,
      provider: 'codex',
      proposal: proposal(sourceToken, 'APP-10001', 'API implementation is in progress')
    };
    const plan = planPeerProgressPublication(input);
    assert.equal(plan.writesEnabled, false);
    assert.equal(plan.verification, 'unverified');

    const result = await publishPeerProgress({ ...input, execute: true });
    assert.equal(result.writesEnabled, true);
    assert.equal(result.idempotentReplay, false);
    const events = verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events;
    assert.equal(events.filter((event) => event.eventType === 'peer-progress.published').length, 1);
    const readModelRoot = root('plan-read-model');
    projectReadModel({ runtimeRoot: eventRuntimeRoot, outputRoot: readModelRoot, execute: true });
    const progressNode = readFileSync(join(readModelRoot, 'nodes.jsonl'), 'utf8')
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line))
      .find((node) => node.id === result.progressRef);
    assert.equal(progressNode.status, 'live-unverified');
  });

  test('publishes a source-derived standalone thread checkpoint and routes it by terms', async () => {
    const runtimeRoot = root('standalone-runtime');
    const eventRuntimeRoot = root('standalone-events');
    const sourceToken = await source(eventRuntimeRoot, 'codex', 'standalone');
    const input = {
      runtimeRoot,
      eventRuntimeRoot,
      provider: 'codex',
      proposal: {
        schemaVersion: 1,
        proposalId: 'standalone-skill-release',
        sourceToken,
        scope: { kind: 'project', key: 'example-project' },
        work: { kind: 'thread', key: 'current' },
        state: 'completed',
        stage: 'handoff',
        summary: 'Shared skill release validation completed',
        nextSteps: ['reuse the verified package in later setup work'],
        limitations: [],
        changedSurfaces: ['agent context broker package'],
        canonicalRefs: [],
        relatedScopes: [],
        observedAt: '2026-09-03T08:05:00.000Z',
        ttlSeconds: 604800
      }
    };

    const plan = planPeerProgressPublication(input);
    assert.equal(plan.work.kind, 'thread');
    assert.match(plan.work.key, /^context:\/\/thread\/[a-f0-9]{64}$/u);
    assert.equal(plan.threadRef, plan.work.key);
    await publishPeerProgress({ ...input, execute: true });

    const unrelated = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'claude-code', crossProvider: true,
      scopeKind: 'project', scopeKey: 'example-project', terms: []
    });
    const related = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'claude-code', crossProvider: true,
      scopeKind: 'project', scopeKey: 'example-project', terms: ['skill', 'release']
    });

    assert.equal(unrelated.progress.length, 0);
    assert.equal(related.progress.length, 1);
    assert.equal(related.progress[0].work.key, plan.threadRef);
    assert.equal(related.progress[0].provider, 'codex');
  });

  test('CLI progress publication remains plan-only without execute', async () => {
    const runtimeRoot = root('cli-runtime');
    const eventRuntimeRoot = root('cli-events');
    const token = await source(eventRuntimeRoot, 'codex', 'cli');
    const proposalPath = join(root('cli-input'), 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify(
      proposal(token, 'APP-10002', 'CLI plan is bounded and read-only'), null, 2
    )}\n`, 'utf8');
    const result = spawnSync(process.execPath, [
      join(import.meta.dirname, '..', 'src', 'cli.mjs'),
      'progress-publish',
      '--provider', 'codex',
      '--proposal', proposalPath,
      '--runtime-root', runtimeRoot,
      '--event-runtime-root', eventRuntimeRoot
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'peer-progress-publication');
    assert.equal(output.writesEnabled, false);
    assert.equal(verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events
      .filter((event) => event.eventType === 'peer-progress.published').length, 0);
  });

  test('shared Bun wrapper exposes progress publication without requiring a skill command', async () => {
    const runtimeRoot = root('wrapper-runtime');
    const eventRuntimeRoot = root('wrapper-events');
    const token = await source(eventRuntimeRoot, 'codex', 'wrapper');
    const proposalPath = join(root('wrapper-input'), 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify(
      proposal(token, 'APP-18208', 'Natural ticket work can publish this checkpoint'), null, 2
    )}\n`, 'utf8');
    const wrapper = sharedWrapper();
    const result = spawnSync(process.execPath, [
      wrapper,
      'progress',
      '--provider', 'codex',
      '--proposal', proposalPath
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME: runtimeRoot,
        AGENT_CONTEXT_BROKER_EVENT_RUNTIME: eventRuntimeRoot
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.mode, 'peer-progress-publication');
    assert.equal(output.writesEnabled, false);
  });

  test('shared wrapper executes progress and appends metadata-only ticket audit', async () => {
    const runtimeRoot = root('wrapper-execute-runtime');
    const eventRuntimeRoot = root('wrapper-execute-events');
    const packagesRoot = root('wrapper-execute-packages');
    const runtimeHome = root('wrapper-execute-home');
    ticket(packagesRoot, 'APP-10003');
    const token = await source(eventRuntimeRoot, 'claude-code', 'wrapper-execute');
    const proposalPath = join(root('wrapper-execute-input'), 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify(
      proposal(token, 'APP-10003', 'Claude publishes a metadata-audited ticket checkpoint'), null, 2
    )}\n`, 'utf8');
    const wrapper = sharedWrapper();
    const result = spawnSync(process.execPath, [
      wrapper,
      'progress',
      '--provider', 'claude-code',
      '--proposal', proposalPath,
      '--ticket-packages-root', packagesRoot,
      '--runtime-home', runtimeHome,
      '--execute'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME: runtimeRoot,
        AGENT_CONTEXT_BROKER_EVENT_RUNTIME: eventRuntimeRoot
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.writesEnabled, true);
    const rows = readFileSync(
      join(runtimeHome, 'runtime', 'ticket-audit', 'APP-10003', 'CONTEXT_LEDGER.jsonl'),
      'utf8'
    )
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'peer-progress-publish');
    assert.equal(rows[0].progressId, output.progressId);
    assert.equal(rows[0].issueKey, 'APP-10003');
    assert.equal(JSON.stringify(rows).includes('Claude publishes'), false);
  });

  test('shared wrapper executes review progress and appends metadata-only review audit', async () => {
    const runtimeRoot = root('wrapper-review-runtime');
    const eventRuntimeRoot = root('wrapper-review-events');
    const reviewLedgersRoot = root('wrapper-review-ledgers');
    const runtimeHome = root('wrapper-review-home');
    const reviewDirectory = reviewLedger(reviewLedgersRoot, 'acme/widgets!8123', ['APP-10004']);
    const token = await source(eventRuntimeRoot, 'codex', 'wrapper-review');
    const proposalPath = join(root('wrapper-review-input'), 'proposal.json');
    writeFileSync(proposalPath, `${JSON.stringify(
      proposal(token, 'APP-10004', 'Review found a contract mismatch that the ticket needs', {
        scope: { kind: 'merge-request', key: 'acme/widgets!8123' },
        work: { kind: 'review', key: 'acme/widgets!8123' },
        stage: 'review',
        canonicalRefs: ['https://gitlab.example.com/acme/widgets/-/merge_requests/8123']
      }), null, 2
    )}\n`, 'utf8');
    const wrapper = sharedWrapper();
    const result = spawnSync(process.execPath, [
      wrapper,
      'progress',
      '--provider', 'codex',
      '--proposal', proposalPath,
      '--review-ledgers-root', reviewLedgersRoot,
      '--runtime-home', runtimeHome,
      '--execute'
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME: runtimeRoot,
        AGENT_CONTEXT_BROKER_EVENT_RUNTIME: eventRuntimeRoot
      }
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    const rows = readFileSync(join(reviewDirectory, 'CONTEXT_LEDGER.jsonl'), 'utf8')
      .trim().split(/\r?\n/u).map((line) => JSON.parse(line));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operation, 'peer-progress-publish');
    assert.equal(rows[0].reviewKey, 'acme/widgets!8123');
    assert.equal(rows[0].progressId, output.progressId);
    assert.equal(JSON.stringify(rows).includes('contract mismatch'), false);
  });

  test('shares one-sided linked BE and DB ticket progress bidirectionally across providers', async () => {
    const runtimeRoot = root('linked-runtime');
    const eventRuntimeRoot = root('linked-events');
    const packagesRoot = root('linked-packages');
    ticket(packagesRoot, 'APP-20001');
    ticket(packagesRoot, 'APP-20002', {
      issueLinks: [{ linkType: 'Blocks', direction: 'inward', key: 'APP-20001' }]
    });
    ticket(packagesRoot, 'APP-29999');
    const codexToken = await source(eventRuntimeRoot, 'codex', 'be');
    const claudeToken = await source(eventRuntimeRoot, 'claude-code', 'db');

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', execute: true,
      proposal: proposal(codexToken, 'APP-20001', 'BE found the DB procedure needs a DTO-matched alias')
    });
    const dbBeforePublish = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-20002', now: '2026-08-26T08:10:00.000Z'
    });
    assert.deepEqual(dbBeforePublish.progress.map((item) => item.scope.key), ['APP-20001']);

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', execute: true,
      proposal: proposal(claudeToken, 'APP-20002', 'DB confirmed the alias and script order required by BE', {
        changedSurfaces: ['ass.LocationByIdQuery'],
        canonicalRefs: ['jira://browse/APP-20002']
      })
    });
    const be = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-20001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.deepEqual(new Set(be.progress.map((item) => item.scope.key)), new Set(['APP-20001', 'APP-20002']));
    assert.equal(be.progress.find((item) => item.scope.key === 'APP-20002').provider, 'claude-code');

    const unrelated = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-29999', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(unrelated.progress.length, 0);
  });

  test('gives a linked FE ticket both BE and DB progress and returns its findings to both', async () => {
    const runtimeRoot = root('three-ticket-runtime');
    const eventRuntimeRoot = root('three-ticket-events');
    const packagesRoot = root('three-ticket-packages');
    ticket(packagesRoot, 'APP-22001');
    ticket(packagesRoot, 'APP-22002');
    ticket(packagesRoot, 'APP-22003', {
      issueLinks: [
        { linkType: 'Blocks', direction: 'inward', key: 'APP-22001' },
        { linkType: 'Blocks', direction: 'inward', key: 'APP-22002' }
      ]
    });
    const beToken = await source(eventRuntimeRoot, 'codex', 'three-be');
    const dbToken = await source(eventRuntimeRoot, 'claude-code', 'three-db');
    const feToken = await source(eventRuntimeRoot, 'codex', 'three-fe');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', execute: true,
      proposal: proposal(beToken, 'APP-22001', 'BE finalized the response DTO', {
        changedSurfaces: ['Location response DTO']
      })
    });
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', execute: true,
      proposal: proposal(dbToken, 'APP-22002', 'DB confirmed nullable readback semantics', {
        changedSurfaces: ['ass.LocationByIdQuery']
      })
    });
    const feBeforePublish = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-22003', now: '2026-08-26T08:10:00.000Z'
    });
    assert.deepEqual(
      new Set(feBeforePublish.progress.map((item) => item.scope.key)),
      new Set(['APP-22001', 'APP-22002'])
    );

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', execute: true,
      proposal: proposal(feToken, 'APP-22003', 'FE found that omitted and null values require different rendering', {
        changedSurfaces: ['Operator Portal location details']
      })
    });
    for (const issueKey of ['APP-22001', 'APP-22002']) {
      const result = readPeerProgress({
        runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
        provider: issueKey === 'APP-22001' ? 'codex' : 'claude-code', crossProvider: true,
        scopeKind: 'ticket', scopeKey: issueKey, now: '2026-08-26T08:10:00.000Z'
      });
      assert.ok(result.progress.some((item) => item.scope.key === 'APP-22003'));
    }
  });

  test('shares direct parent-child progress without leaking between siblings', async () => {
    const runtimeRoot = root('hierarchy-runtime');
    const eventRuntimeRoot = root('hierarchy-events');
    const packagesRoot = root('hierarchy-packages');
    ticket(packagesRoot, 'APP-23000');
    ticket(packagesRoot, 'APP-23001', { parent: { key: 'APP-23000' } });
    ticket(packagesRoot, 'APP-23002', { parent: { key: 'APP-23000' } });
    const token = await source(eventRuntimeRoot, 'codex', 'hierarchy');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-23001', 'First child found a contract limitation')
    });
    const parent = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-23000', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(parent.progress.length, 1);
    const sibling = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-23002', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(sibling.progress.length, 0);
  });

  test('rechecks Jira-derived links and excludes progress after the relation is removed', async () => {
    const runtimeRoot = root('stale-link-runtime');
    const eventRuntimeRoot = root('stale-link-events');
    const packagesRoot = root('stale-link-packages');
    ticket(packagesRoot, 'APP-24001');
    ticket(packagesRoot, 'APP-24002', {
      issueLinks: [{ linkType: 'Blocks', direction: 'inward', key: 'APP-24001' }]
    });
    const token = await source(eventRuntimeRoot, 'claude-code', 'stale-link');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', execute: true,
      proposal: proposal(token, 'APP-24002', 'DB dependency was linked to BE')
    });
    ticket(packagesRoot, 'APP-24002', { issueLinks: [] });
    const result = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-24001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(result.progress.length, 0);
    assert.deepEqual(result.warnings, ['stale-peer-relation-excluded']);
  });

  test('injects live progress separately from accepted claims and persists the exact payload', async () => {
    const runtimeRoot = root('query-runtime');
    const eventRuntimeRoot = root('query-events');
    const auditRoot = root('query-audit');
    const packagesRoot = root('query-packages');
    ticket(packagesRoot, 'APP-21001');
    ticket(packagesRoot, 'APP-21002', {
      issueLinks: [{ linkType: 'Blocks', direction: 'inward', key: 'APP-21001' }]
    });
    const token = await source(eventRuntimeRoot, 'codex', 'query');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-21001', 'BE changed the response contract needed by the DB ticket')
    });
    const planned = await planContextQuery({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', profileId: 'implementation',
      scopeKind: 'ticket', scopeKey: 'APP-21002', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(planned.claims.length, 0);
    assert.equal(planned.peerProgress.length, 1);
    assert.match(planned.context, /Live peer progress \(unverified/u);
    assert.match(planned.context, /No raw peer conversation/u);
    assert.equal(planned.injection.payload, planned.context);
    assert.equal(planned.injection.persisted, false);

    const executed = await runContextQuery({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot,
      provider: 'claude-code', profileId: 'implementation',
      scopeKind: 'ticket', scopeKey: 'APP-21002', now: '2026-08-26T08:10:00.000Z',
      globalAuditDirectory: auditRoot, execute: true
    });
    assert.equal(executed.injection.persisted, true);
    const persisted = JSON.parse(readFileSync(join(auditRoot, executed.injection.artifact), 'utf8'));
    assert.equal(persisted.payload, executed.context);
    assert.equal(persisted.digest, executed.injection.digest);
  });

  test('honors provider isolation and strict isolation', async () => {
    const runtimeRoot = root('provider-runtime');
    const eventRuntimeRoot = root('provider-events');
    const token = await source(eventRuntimeRoot, 'claude-code', 'provider');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'claude-code', execute: true,
      proposal: proposal(token, 'APP-30001', 'Claude found a cross-provider constraint')
    });
    const sameOnly = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', crossProvider: false,
      scopeKind: 'ticket', scopeKey: 'APP-30001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(sameOnly.progress.length, 0);
    const isolated = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', strictIsolation: true,
      scopeKind: 'ticket', scopeKey: 'APP-30001'
    });
    assert.deepEqual(isolated, { progress: [], warnings: [] });
  });

  test('supersedes one actor progress and excludes expired progress', async () => {
    const runtimeRoot = root('update-runtime');
    const eventRuntimeRoot = root('update-events');
    const token = await source(eventRuntimeRoot, 'codex', 'update');
    const first = await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-40001', 'Research started', {
        stage: 'research', observedAt: '2026-08-26T08:01:00.000Z'
      })
    });
    const second = await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-40001', 'Implementation completed', {
        state: 'completed', stage: 'handoff', observedAt: '2026-08-26T08:20:00.000Z'
      })
    });
    assert.equal(second.replacesRef, first.progressRef);
    const current = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-40001', now: '2026-08-26T08:30:00.000Z'
    });
    assert.equal(current.progress.length, 1);
    assert.equal(current.progress[0].summary, 'Implementation completed');

    const expired = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-40001', now: '2026-09-30T08:30:00.000Z'
    });
    assert.equal(expired.progress.length, 0);
    assert.deepEqual(expired.warnings, ['expired-peer-progress-excluded']);
    const unrelated = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-49999', now: '2026-09-30T08:30:00.000Z'
    });
    assert.deepEqual(unrelated, { progress: [], warnings: [] });
  });

  test('replays identical progress idempotently after a fresh module-level read', async () => {
    const runtimeRoot = root('replay-runtime');
    const eventRuntimeRoot = root('replay-events');
    const token = await source(eventRuntimeRoot, 'codex', 'replay');
    const input = {
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-41001', 'Stable checkpoint for restart replay')
    };
    const first = await publishPeerProgress(input);
    const replay = await publishPeerProgress(input);
    assert.equal(replay.progressId, first.progressId);
    assert.equal(replay.idempotentReplay, true);
    assert.equal(readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-41001', now: '2026-08-26T08:10:00.000Z'
    }).progress.length, 1);
  });

  test('serializes concurrent updates from one actor into a deterministic current checkpoint', async () => {
    const runtimeRoot = root('concurrent-runtime');
    const eventRuntimeRoot = root('concurrent-events');
    const token = await source(eventRuntimeRoot, 'codex', 'concurrent');
    const inputs = ['API validation passed', 'DB dependency is blocked'].map((summary, index) => ({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-42001', summary, {
        observedAt: `2026-08-26T08:0${index + 6}:00.000Z`,
        state: index === 0 ? 'active' : 'blocked'
      })
    }));
    await Promise.all(inputs.map((input) => publishPeerProgress(input)));
    const events = verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events
      .filter((event) => event.eventType === 'peer-progress.published');
    assert.equal(events.length, 2);
    assert.equal(events[1].replacesRef, events[0].subjectRef);
    const current = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-42001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(current.progress.length, 1);
  });

  test('correlates an MR checkpoint with its ticket without exposing unrelated reviews', async () => {
    const runtimeRoot = root('mr-runtime');
    const eventRuntimeRoot = root('mr-events');
    const token = await source(eventRuntimeRoot, 'codex', 'mr');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-43001', 'MR review found a failing contract test', {
        work: { kind: 'merge-request', key: 'acme/widgets!8123' },
        stage: 'review',
        relatedScopes: [{ kind: 'merge-request', key: 'acme/widgets!8123' }],
        revision: { sourceSha: 'abcdef1', targetSha: '1234567', pipelineId: '132000', pipelineStatus: 'failed' }
      })
    });
    const result = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-43001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(result.progress.length, 1);
    assert.deepEqual(result.progress[0].work, { kind: 'merge-request', key: 'acme/widgets!8123' });
    assert.equal(result.progress[0].revision.pipelineStatus, 'failed');
  });

  test('treats a review ledger as a bidirectional first-class relation source', async () => {
    const runtimeRoot = root('review-ledger-runtime');
    const eventRuntimeRoot = root('review-ledger-events');
    const packagesRoot = root('review-ledger-tickets');
    const reviewLedgersRoot = root('review-ledger-reviews');
    ticket(packagesRoot, 'APP-43011');
    ticket(packagesRoot, 'APP-43999');
    ticket(packagesRoot, 'APP-43998');
    reviewLedger(reviewLedgersRoot, 'acme/widgets!8133', ['APP-43011']);
    reviewLedger(reviewLedgersRoot, 'acme/widgets!8134', ['APP-43999']);
    const reviewToken = await source(eventRuntimeRoot, 'codex', 'first-class-review');
    const ticketToken = await source(eventRuntimeRoot, 'claude-code', 'first-class-ticket');
    const unrelatedReviewToken = await source(eventRuntimeRoot, 'codex', 'unrelated-review');

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'codex', execute: true,
      proposal: proposal(reviewToken, 'APP-43011', 'Review found a contract edge case', {
        scope: { kind: 'merge-request', key: 'acme/widgets!8133' },
        work: { kind: 'review', key: 'acme/widgets!8133' },
        stage: 'review',
        relatedScopes: [],
        canonicalRefs: ['https://gitlab.example.com/acme/widgets/-/merge_requests/8133']
      })
    });
    const ticketView = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-43011', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(ticketView.progress.length, 1);
    assert.deepEqual(ticketView.progress[0].scope, { kind: 'merge-request', key: 'acme/widgets!8133' });

    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'claude-code', execute: true,
      proposal: proposal(ticketToken, 'APP-43011', 'Ticket implementation confirmed the review contract')
    });
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'codex', execute: true,
      proposal: proposal(unrelatedReviewToken, 'APP-43999', 'A different review shares only the project', {
        scope: { kind: 'merge-request', key: 'acme/widgets!8134' },
        work: { kind: 'review', key: 'acme/widgets!8134' },
        stage: 'review',
        relatedScopes: [],
        canonicalRefs: ['https://gitlab.example.com/acme/widgets/-/merge_requests/8134']
      })
    });
    const reviewView = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'merge-request', scopeKey: 'acme/widgets!8133', terms: ['review'],
      now: '2026-08-26T08:10:00.000Z'
    });
    assert.deepEqual(
      new Set(reviewView.progress.map((item) => `${item.scope.kind}:${item.scope.key}`)),
      new Set(['merge-request:acme/widgets!8133', 'ticket:APP-43011'])
    );

    const unrelated = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, ticketPackagesRoot: packagesRoot, reviewLedgersRoot,
      provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-43998', terms: ['review'],
      now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(unrelated.progress.length, 0);
  });

  test('enriches existing project-scoped review progress from its review ledger', async () => {
    const runtimeRoot = root('legacy-review-runtime');
    const eventRuntimeRoot = root('legacy-review-events');
    const reviewLedgersRoot = root('legacy-review-ledgers');
    reviewLedger(reviewLedgersRoot, 'acme/widgets!8144', ['APP-43022']);
    const token = await source(eventRuntimeRoot, 'codex', 'legacy-review');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, reviewLedgersRoot,
      provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-43022', 'Legacy review progress used a project scope', {
        scope: { kind: 'project', key: 'example-project' },
        work: { kind: 'review', key: 'acme/widgets!8144' },
        stage: 'review',
        relatedScopes: [{ kind: 'merge-request', key: 'acme/widgets!8144' }]
      })
    });
    const result = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, reviewLedgersRoot,
      provider: 'claude-code', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-43022', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(result.progress.length, 1);
    assert.ok(result.progress[0].relatedScopes.some((relation) =>
      relation.kind === 'ticket' && relation.key === 'APP-43022' &&
      relation.relationship === 'review-ticket'
    ));
  });

  test('marks conflicting current revision reports without choosing one', async () => {
    const runtimeRoot = root('conflict-runtime');
    const eventRuntimeRoot = root('conflict-events');
    const codexToken = await source(eventRuntimeRoot, 'codex', 'conflict-a');
    const claudeToken = await source(eventRuntimeRoot, 'claude-code', 'conflict-b');
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(codexToken, 'APP-50001', 'Codex sees the pipeline as running', {
        revision: { sourceSha: 'aaaaaaa', pipelineId: '100', pipelineStatus: 'running' }
      })
    });
    await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'claude-code', execute: true,
      proposal: proposal(claudeToken, 'APP-50001', 'Claude sees the pipeline as failed', {
        revision: { sourceSha: 'bbbbbbb', pipelineId: '101', pipelineStatus: 'failed' }
      })
    });
    const result = readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', crossProvider: true,
      scopeKind: 'ticket', scopeKey: 'APP-50001', now: '2026-08-26T08:10:00.000Z'
    });
    assert.equal(result.progress.length, 2);
    assert.ok(result.progress.every((item) => item.conflicted));
  });

  test('blocks secrets and absolute paths before persistence', async () => {
    const runtimeRoot = root('privacy-runtime');
    const eventRuntimeRoot = root('privacy-events');
    const token = await source(eventRuntimeRoot, 'codex', 'privacy');
    for (const summary of [
      'contact developer@example.com',
      'password=unsafe',
      'inspect C:\\private\\secret.txt'
    ]) {
      assert.throws(() => planPeerProgressPublication({
        runtimeRoot, eventRuntimeRoot, provider: 'codex',
        proposal: proposal(token, 'APP-60001', summary)
      }), /unsafe content/u);
    }
  });

  test('fails closed when an immutable artifact is tampered', async () => {
    const runtimeRoot = root('tamper-runtime');
    const eventRuntimeRoot = root('tamper-events');
    const token = await source(eventRuntimeRoot, 'codex', 'tamper');
    const published = await publishPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex', execute: true,
      proposal: proposal(token, 'APP-70001', 'Original bounded progress')
    });
    const path = join(runtimeRoot, 'peer-progress', 'records', `${published.progressId}.json`);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    artifact.summary = 'Tampered progress';
    writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    assert.throws(() => readPeerProgress({
      runtimeRoot, eventRuntimeRoot, provider: 'codex',
      scopeKind: 'ticket', scopeKey: 'APP-70001'
    }), /verification failed/u);
  });
});
