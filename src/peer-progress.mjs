import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { unsafeContentReason } from './content-safety.mjs';
import {
  appendBrokerEvent,
  sha256,
  stableJson,
  stableValue,
  verifyEventStore
} from './event-store.mjs';
import { provenanceForSourceToken } from './source-attestation.mjs';
import {
  relationsForScope,
  reviewLedgerRelations,
  ticketPackageRelations
} from './work-ledgers.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const ISSUE_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/u;
const SAFE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/!-]{0,127}$/u;
const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const PROVIDERS = new Set(['codex', 'claude-code']);
const SCOPE_KINDS = new Set(['global', 'project', 'workstream', 'ticket', 'merge-request']);
const RELATION_KINDS = SCOPE_KINDS;
const WORK_KINDS = new Set([
  'ticket', 'merge-request', 'thread', 'implementation', 'review', 'build', 'bugfix', 'qa', 'custom'
]);
const STATES = new Set(['active', 'blocked', 'completed']);
const STAGES = new Set(['research', 'implementation', 'validation', 'review', 'ci', 'handoff', 'other']);
const PIPELINE_STATES = new Set([
  'unknown', 'created', 'pending', 'running', 'passed', 'failed', 'canceled', 'skipped', 'manual'
]);
const PROPOSAL_FIELDS = new Set([
  'schemaVersion', 'proposalId', 'sourceToken', 'scope', 'work', 'state', 'stage',
  'summary', 'nextSteps', 'limitations', 'changedSurfaces', 'canonicalRefs',
  'relatedScopes', 'revision', 'observedAt', 'ttlSeconds'
]);
const ARTIFACT_FIELDS = new Set([
  'schemaVersion', 'progressId', 'digest', 'actorKey', 'workKeyHash', 'provider',
  'sourceRef', 'scope', 'work', 'state', 'stage', 'summary', 'nextSteps',
  'limitations', 'changedSurfaces', 'canonicalRefs', 'relatedScopes', 'relationKeys',
  'revision', 'observedAt', 'expiresAt', 'verification', 'sensitivity'
]);
const DEFAULTS = Object.freeze({
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  lockStaleMs: 600000,
  maxProgress: 8,
  maxSummaryLength: 1200,
  maxListItems: 10,
  maxListItemLength: 320,
  maxRelations: 16,
  maxReferences: 12
});

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function noUnknownFields(value, allowed, label) {
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} is invalid.`);
  }
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

async function withLock(path, options, action) {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx');
      writeFileSync(descriptor, JSON.stringify({
        processId: process.pid,
        acquiredAt: new Date().toISOString()
      }));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > options.lockStaleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error('Peer progress store is busy.');
      }
      await delay(options.lockRetryMs);
    }
  }
  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function boundedText(value, label, maximum, required = false) {
  if (value === undefined && !required) return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if ((required && !text) || text.length > maximum || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    throw new Error(`${label} exceeds the bounded text contract.`);
  }
  return text;
}

function boundedList(value, label, options) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > options.maxListItems) {
    throw new Error(`${label} exceeds the bounded list contract.`);
  }
  const items = value.map((item) => boundedText(item, label, options.maxListItemLength, true));
  if (new Set(items).size !== items.length) throw new Error(`${label} contains duplicates.`);
  return items;
}

function validScope(scope, relation = false) {
  const kinds = relation ? RELATION_KINDS : SCOPE_KINDS;
  return isRecord(scope) && Object.keys(scope).length === 2 &&
    kinds.has(scope.kind) && SAFE_KEY.test(scope.key ?? '') &&
    (scope.kind !== 'ticket' || ISSUE_KEY.test(scope.key)) &&
    (scope.kind !== 'merge-request' || /^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}!\d{1,12}$/u.test(scope.key));
}

function relationKey(scope) {
  return `${scope.kind}:${sha256(String(scope.key).toLowerCase())}`;
}

function normalizeRelation(scope, relationship = 'explicit') {
  if (!validScope(scope, true)) throw new Error('Peer progress relation is invalid.');
  return { kind: scope.kind, key: scope.key, relationship };
}

function relationIdentity(relation) {
  return `${relation.kind}:${String(relation.key).toLowerCase()}`;
}

export function resolveTicketRelations(inputOptions = {}) {
  return ticketPackageRelations(inputOptions.ticketPackagesRoot, inputOptions.issueKey);
}

function normalizedRelations(proposal, options) {
  const relations = [normalizeRelation(proposal.scope, 'primary')];
  for (const item of proposal.relatedScopes ?? []) {
    relations.push(normalizeRelation(item));
  }
  relations.push(...relationsForScope(proposal.scope, {
    ...options,
    requireReviewLedger: proposal.scope.kind === 'merge-request'
  }));
  const unique = new Map();
  for (const relation of relations) {
    const identity = relationIdentity(relation);
    const previous = unique.get(identity);
    if (!previous || previous.relationship === 'jira-parent') unique.set(identity, relation);
  }
  if (unique.size > options.maxRelations) throw new Error('Peer progress has too many relations.');
  return [...unique.values()].sort((left, right) => relationIdentity(left).localeCompare(relationIdentity(right)));
}

function normalizeReferences(value, options) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > options.maxReferences ||
      value.some((item) => typeof item !== 'string' || !SAFE_REFERENCE.test(item)) ||
      new Set(value).size !== value.length) {
    throw new Error('Peer progress canonical references are invalid.');
  }
  return [...value].sort();
}

function normalizeRevision(value) {
  if (value === undefined || value === null) return null;
  const fields = new Set(['sourceSha', 'targetSha', 'pipelineId', 'pipelineStatus']);
  noUnknownFields(value, fields, 'Peer progress revision');
  if (Object.keys(value).length === 0 ||
      !(value.sourceSha === undefined || /^[a-f0-9]{7,64}$/u.test(value.sourceSha)) ||
      !(value.targetSha === undefined || /^[a-f0-9]{7,64}$/u.test(value.targetSha)) ||
      !(value.pipelineId === undefined || /^\d{1,12}$/u.test(String(value.pipelineId))) ||
      !(value.pipelineStatus === undefined || PIPELINE_STATES.has(value.pipelineStatus))) {
    throw new Error('Peer progress revision is invalid.');
  }
  return stableValue(value);
}

function normalizedProposal(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  const proposal = inputOptions.proposal;
  noUnknownFields(proposal, PROPOSAL_FIELDS, 'Peer progress proposal');
  if (proposal.schemaVersion !== 1 || !SAFE_KEY.test(proposal.proposalId ?? '') ||
      !validScope(proposal.scope) || !isRecord(proposal.work) ||
      Object.keys(proposal.work).length !== 2 || !WORK_KINDS.has(proposal.work.kind) ||
      !SAFE_KEY.test(proposal.work.key ?? '') || !STATES.has(proposal.state) ||
      !STAGES.has(proposal.stage) || !PROVIDERS.has(inputOptions.provider)) {
    throw new Error('Peer progress proposal identity is invalid.');
  }
  const observedAt = new Date(proposal.observedAt);
  if (Number.isNaN(observedAt.getTime())) throw new Error('Peer progress observation time is invalid.');
  const ttlSeconds = proposal.ttlSeconds ?? (proposal.state === 'completed' ? 604800 : 3600);
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 2592000) {
    throw new Error('Peer progress TTL is invalid.');
  }
  const source = provenanceForSourceToken({
    runtimeRoot: inputOptions.eventRuntimeRoot,
    sourceToken: proposal.sourceToken
  });
  if (source.provider !== inputOptions.provider) {
    throw new Error('Peer progress provider does not match the attested source.');
  }
  if (proposal.work.kind === 'thread' && proposal.work.key !== 'current') {
    throw new Error('Thread progress must use the source-derived current thread key.');
  }
  const work = proposal.work.kind === 'thread'
    ? { kind: 'thread', key: source.threadRef }
    : stableValue(proposal.work);
  const relatedScopes = normalizedRelations(proposal, options);
  const normalized = {
    schemaVersion: 1,
    actorKey: sha256(`${inputOptions.provider}:${source.sessionKey}:${work.kind}:${work.key}`),
    workKeyHash: sha256(`${work.kind}:${String(work.key).toLowerCase()}`),
    provider: inputOptions.provider,
    sourceRef: proposal.sourceToken,
    scope: stableValue(proposal.scope),
    work,
    state: proposal.state,
    stage: proposal.stage,
    summary: boundedText(proposal.summary, 'Peer progress summary', options.maxSummaryLength, true),
    nextSteps: boundedList(proposal.nextSteps, 'Peer progress next steps', options),
    limitations: boundedList(proposal.limitations, 'Peer progress limitations', options),
    changedSurfaces: boundedList(proposal.changedSurfaces, 'Peer progress changed surfaces', options),
    canonicalRefs: normalizeReferences(proposal.canonicalRefs, options),
    relatedScopes,
    relationKeys: [...new Set(relatedScopes.map(relationKey))].sort(),
    revision: normalizeRevision(proposal.revision),
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + (ttlSeconds * 1000)).toISOString(),
    verification: 'unverified',
    sensitivity: 'shared'
  };
  const unsafeReason = unsafeContentReason(normalized);
  if (unsafeReason) throw new Error(`Peer progress contains unsafe content: ${unsafeReason}.`);
  return { normalized, source };
}

function artifactFor(inputOptions) {
  const { normalized, source } = normalizedProposal(inputOptions);
  const progressId = sha256(stableJson(normalized));
  return {
    artifact: { ...normalized, progressId, digest: progressId },
    source
  };
}

function progressEvent(artifact, source, previousRef) {
  return {
    idempotencyKey: artifact.progressId,
    eventType: 'peer-progress.published',
    occurredAt: artifact.observedAt,
    provider: artifact.provider,
    scope: { kind: artifact.scope.kind, keyHash: sha256(artifact.scope.key) },
    taskKeyHash: artifact.workKeyHash,
    threadKey: source.sessionKey,
    sourceRefs: [artifact.sourceRef],
    subjectRef: `acb://progress/${artifact.progressId}`,
    replacesRef: previousRef,
    evidenceRefs: artifact.canonicalRefs.map((reference) => `acb://evidence/${sha256(reference)}`),
    confidence: null,
    freshness: {
      status: 'current',
      verifiedAt: artifact.observedAt,
      expiresAt: artifact.expiresAt,
      sourceHeadHash: source.sourceHash,
      policy: 'peer-progress'
    },
    sensitivity: 'shared',
    redactionResult: 'clean',
    approvalState: 'not-required',
    payload: {
      actorKey: artifact.actorKey,
      artifactHash: artifact.progressId,
      workKeyHash: artifact.workKeyHash,
      relationCount: artifact.relationKeys.length,
      state: artifact.state,
      stage: artifact.stage,
      schema: 'peer-progress-v1'
    }
  };
}

function recordPath(runtimeRoot, progressId) {
  return join(resolve(runtimeRoot), 'peer-progress', 'records', `${progressId}.json`);
}

function verifiedArtifact(runtimeRoot, event) {
  const progressId = event.payload?.artifactHash;
  if (!HASH.test(progressId ?? '')) throw new Error('Peer progress event artifact hash is invalid.');
  const path = recordPath(runtimeRoot, progressId);
  if (!existsSync(path)) throw new Error('Peer progress artifact is missing.');
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  noUnknownFields(artifact, ARTIFACT_FIELDS, 'Peer progress artifact');
  const core = Object.fromEntries(Object.entries(artifact)
    .filter(([key]) => !['progressId', 'digest'].includes(key)));
  if (artifact.schemaVersion !== 1 || artifact.progressId !== progressId || artifact.digest !== progressId ||
      sha256(stableJson(core)) !== progressId || event.subjectRef !== `acb://progress/${progressId}` ||
      event.provider !== artifact.provider || event.taskKeyHash !== artifact.workKeyHash ||
      event.payload.actorKey !== artifact.actorKey || !event.sourceRefs.includes(artifact.sourceRef) ||
      unsafeContentReason(artifact)) {
    throw new Error('Peer progress artifact verification failed.');
  }
  return artifact;
}

function currentProgressEvents(eventRuntimeRoot) {
  const events = verifyEventStore({ runtimeRoot: eventRuntimeRoot }).events
    .filter((event) => event.eventType === 'peer-progress.published');
  const current = new Map();
  for (const event of events) current.set(event.payload.actorKey, event);
  return [...current.values()];
}

export function planPeerProgressPublication(inputOptions = {}) {
  if (!inputOptions.runtimeRoot || !inputOptions.eventRuntimeRoot) {
    throw new Error('Peer progress publication requires runtimeRoot and eventRuntimeRoot.');
  }
  if (inputOptions.strictIsolation === true) {
    throw new Error('Peer progress publication is unavailable in strict isolation.');
  }
  const { artifact, source } = artifactFor({ ...DEFAULTS, ...inputOptions });
  return {
    schemaVersion: 1,
    mode: 'peer-progress-publication',
    writesEnabled: false,
    progressId: artifact.progressId,
    progressRef: `acb://progress/${artifact.progressId}`,
    proposalIdHash: sha256(inputOptions.proposal.proposalId),
    sourceTokenHash: sha256(inputOptions.proposal.sourceToken),
    threadRef: artifact.work.kind === 'thread' ? artifact.work.key : source.threadRef,
    provider: artifact.provider,
    scope: artifact.scope,
    work: artifact.work,
    state: artifact.state,
    stage: artifact.stage,
    relationCount: artifact.relationKeys.length,
    expiresAt: artifact.expiresAt,
    verification: artifact.verification
  };
}

export async function publishPeerProgress(inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true || !options.runtimeRoot || !options.eventRuntimeRoot) {
    throw new Error('Peer progress publication requires execute: true, runtimeRoot, and eventRuntimeRoot.');
  }
  if (options.strictIsolation === true) {
    throw new Error('Peer progress publication is unavailable in strict isolation.');
  }
  return withLock(join(resolve(options.runtimeRoot), 'peer-progress', 'publish.lock'), options, async () => {
    const { artifact, source } = artifactFor(options);
    const current = currentProgressEvents(options.eventRuntimeRoot)
      .find((event) => event.payload.actorKey === artifact.actorKey) ?? null;
    const path = recordPath(options.runtimeRoot, artifact.progressId);
    const content = `${JSON.stringify(artifact, null, 2)}\n`;
    if (existsSync(path)) {
      if (readFileSync(path, 'utf8') !== content) throw new Error('Peer progress artifact collision detected.');
    } else {
      atomicWrite(path, content);
    }
    const event = await appendBrokerEvent({
      runtimeRoot: options.eventRuntimeRoot,
      event: progressEvent(artifact, source, current?.subjectRef ?? null),
      now: options.now,
      execute: true
    });
    return {
      ...planPeerProgressPublication(options),
      writesEnabled: true,
      eventId: event.eventId,
      idempotentReplay: event.idempotentReplay,
      replacesRef: event.replacesRef
    };
  });
}

function queryRelations(options) {
  const primary = normalizeRelation({ kind: options.scopeKind, key: options.scopeKey }, 'primary');
  const relations = [primary];
  if (options.scopeKind === 'ticket') {
    relations.push(...ticketPackageRelations(options.ticketPackagesRoot, options.scopeKey));
  }
  if (options.scopeKind === 'merge-request') {
    relations.push(...reviewLedgerRelations(options.reviewLedgersRoot, options.scopeKey));
  }
  return relations;
}

function relationshipWeight(relationship) {
  if (['primary'].includes(relationship)) return 20;
  if (['explicit', 'jira-link', 'jira-subtask', 'review-ticket', 'review-project'].includes(relationship)) return 12;
  return 4;
}

function directHierarchyWeight(relationship) {
  return relationship === 'jira-parent' ? 10 : relationshipWeight(relationship);
}

function progressScore(artifact, options, relations, terms) {
  if (!options.crossProvider && artifact.provider !== options.provider) return -1;
  let score = 0;
  let structurallyRelated = false;
  if (artifact.scope.kind === options.scopeKind && artifact.scope.key === options.scopeKey) {
    score = 20;
    structurallyRelated = true;
  }
  for (const artifactRelation of artifact.relatedScopes) {
    if (artifactRelation.kind === options.scopeKind && artifactRelation.key === options.scopeKey) {
      score = Math.max(score, directHierarchyWeight(artifactRelation.relationship));
      structurallyRelated = true;
    }
    for (const queryRelation of relations) {
      // A shared project does not make every review in that project relevant to one MR.
      if (options.scopeKind === 'merge-request' && queryRelation.kind === 'project') continue;
      if (relationIdentity(artifactRelation) === relationIdentity(queryRelation)) {
        score = Math.max(score, Math.min(
          relationshipWeight(artifactRelation.relationship),
          relationshipWeight(queryRelation.relationship)
        ));
        structurallyRelated = true;
      }
    }
  }
  for (const queryRelation of relations) {
    if (options.scopeKind === 'merge-request' && queryRelation.kind === 'project') continue;
    if (artifact.scope.kind === queryRelation.kind && artifact.scope.key === queryRelation.key) {
      score = Math.max(score, directHierarchyWeight(queryRelation.relationship));
      structurallyRelated = true;
    }
  }
  if (['ticket', 'merge-request'].includes(options.scopeKind) && !structurallyRelated) return -1;
  const haystack = stableJson({
    scope: artifact.scope,
    work: artifact.work,
    state: artifact.state,
    stage: artifact.stage,
    summary: artifact.summary,
    nextSteps: artifact.nextSteps,
    limitations: artifact.limitations,
    changedSurfaces: artifact.changedSurfaces
  }).toLowerCase();
  const termMatches = terms.filter((term) => haystack.includes(term)).length;
  if (artifact.work.kind === 'thread' &&
      artifact.scope.kind === 'project' &&
      artifact.scope.key === options.scopeKey &&
      termMatches === 0) {
    return -1;
  }
  if (termMatches > 0) score += termMatches * 4;
  return score >= 8 || termMatches > 0 ? score : -1;
}

function currentArtifactRelations(artifact, options) {
  const ledgerRelations = [
    ...relationsForScope(artifact.scope, options),
    ...artifact.relatedScopes
      .filter((relation) => relation.kind === 'merge-request')
      .flatMap((relation) => reviewLedgerRelations(options.reviewLedgersRoot, relation.key))
  ];
  const hasTicketLedgerSource = artifact.scope.kind === 'ticket' && Boolean(options.ticketPackagesRoot);
  if (ledgerRelations.length === 0 && !hasTicketLedgerSource) {
    return { artifact, staleRelations: [] };
  }
  const current = new Set(ledgerRelations
    .map((relation) => `${relationIdentity(relation)}:${relation.relationship}`));
  const staleRelations = [];
  const relatedScopes = artifact.relatedScopes.filter((relation) => {
    if (!relation.relationship.startsWith('jira-') && !relation.relationship.startsWith('review-')) return true;
    const present = current.has(`${relationIdentity(relation)}:${relation.relationship}`);
    if (!present) staleRelations.push(relation);
    return present;
  });
  const identities = new Set(relatedScopes.map(relationIdentity));
  for (const relation of ledgerRelations) {
    if (!identities.has(relationIdentity(relation))) {
      relatedScopes.push(relation);
      identities.add(relationIdentity(relation));
    }
  }
  relatedScopes.sort((left, right) => relationIdentity(left).localeCompare(relationIdentity(right)));
  return { artifact: { ...artifact, relatedScopes }, staleRelations };
}

function markConflicts(items) {
  const byWork = new Map();
  for (const item of items) {
    const key = `${item.work.kind}:${item.work.key}`;
    const group = byWork.get(key) ?? [];
    group.push(item);
    byWork.set(key, group);
  }
  return items.map((item) => {
    const group = byWork.get(`${item.work.kind}:${item.work.key}`);
    const signatures = new Set(group.map((candidate) => stableJson({
      revision: candidate.revision,
      state: candidate.state,
      stage: candidate.stage
    })));
    return { ...item, conflicted: signatures.size > 1 };
  });
}

export function readPeerProgress(inputOptions = {}) {
  const options = { ...DEFAULTS, crossProvider: true, ...inputOptions };
  if (!options.runtimeRoot || !options.eventRuntimeRoot || !PROVIDERS.has(options.provider) ||
      !validScope({ kind: options.scopeKind, key: options.scopeKey })) {
    throw new Error('Peer progress query requires provider, roots, and an explicit scope.');
  }
  if (options.strictIsolation === true) return { progress: [], warnings: [] };
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Peer progress query time is invalid.');
  const terms = [...new Set((options.terms ?? []).map((term) => String(term).trim().toLowerCase()).filter(Boolean))];
  const relations = queryRelations(options);
  const warnings = [];
  const candidates = [];
  for (const event of currentProgressEvents(options.eventRuntimeRoot)) {
    const artifact = verifiedArtifact(options.runtimeRoot, event);
    const current = currentArtifactRelations(artifact, options);
    const previousScore = progressScore(artifact, options, relations, terms);
    const score = progressScore(current.artifact, options, relations, terms);
    if (current.staleRelations.length > 0 && previousScore >= 0) {
      warnings.push('stale-peer-relation-excluded');
    }
    if (score < 0) continue;
    if (Date.parse(artifact.expiresAt) <= now.getTime()) {
      warnings.push('expired-peer-progress-excluded');
      continue;
    }
    candidates.push({
      progressId: artifact.progressId,
      progressRef: `acb://progress/${artifact.progressId}`,
      provider: artifact.provider,
      scope: artifact.scope,
      work: artifact.work,
      state: artifact.state,
      stage: artifact.stage,
      summary: artifact.summary,
      nextSteps: artifact.nextSteps,
      limitations: artifact.limitations,
      changedSurfaces: artifact.changedSurfaces,
      canonicalRefs: artifact.canonicalRefs,
      relatedScopes: current.artifact.relatedScopes,
      revision: artifact.revision,
      observedAt: artifact.observedAt,
      expiresAt: artifact.expiresAt,
      verification: artifact.verification,
      sensitivity: artifact.sensitivity,
      relevance: score
    });
  }
  candidates.sort((left, right) =>
    right.relevance - left.relevance ||
    String(right.observedAt).localeCompare(String(left.observedAt)) ||
    left.progressId.localeCompare(right.progressId)
  );
  if (candidates.length > options.maxProgress) warnings.push('peer-progress-limit-reached');
  return {
    progress: markConflicts(candidates.slice(0, options.maxProgress)),
    warnings: [...new Set(warnings)].sort()
  };
}
