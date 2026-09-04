import {
  appendBrokerEvent,
  sha256,
  stableJson,
  verifyEventStore
} from './event-store.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const REFERENCE = /^acb:\/\/[a-z][a-z0-9-]*\/[a-f0-9]{64}$/u;
const PROPOSAL_FIELDS = new Set([
  'schemaVersion', 'proposalKey', 'targetRef', 'targetRevisionHash',
  'correctionKind', 'disposition', 'replacementHash', 'evidenceRefs',
  'confidence', 'scope', 'requestedBy', 'approvalClass', 'sensitivity',
  'occurredAt'
]);
const DECISION_FIELDS = new Set([
  'schemaVersion', 'correctionRef', 'expectedProposalEventId', 'decision',
  'observedRevisionHash', 'evidenceRefs', 'decidedBy', 'occurredAt'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRefs(value) {
  return Array.isArray(value) && value.length > 0 &&
    new Set(value).size === value.length && value.every((item) => REFERENCE.test(item));
}

function validScope(value) {
  return isRecord(value) && Object.keys(value).length === 2 &&
    ['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(value.kind) &&
    HASH.test(value.keyHash ?? '');
}

function validateProposal(proposal) {
  if (!isRecord(proposal) || Object.keys(proposal).length !== PROPOSAL_FIELDS.size ||
      Object.keys(proposal).some((key) => !PROPOSAL_FIELDS.has(key)) ||
      proposal.schemaVersion !== 1 || !HASH.test(proposal.proposalKey ?? '') ||
      !REFERENCE.test(proposal.targetRef ?? '') ||
      !HASH.test(proposal.targetRevisionHash ?? '') ||
      !['finding', 'guidance', 'claim'].includes(proposal.correctionKind) ||
      !['replace', 'withdraw', 'refresh'].includes(proposal.disposition) ||
      !(proposal.replacementHash === null || HASH.test(proposal.replacementHash ?? '')) ||
      (proposal.disposition !== 'withdraw' && proposal.replacementHash === null) ||
      !validRefs(proposal.evidenceRefs) || typeof proposal.confidence !== 'number' ||
      proposal.confidence < 0 || proposal.confidence > 1 || !validScope(proposal.scope) ||
      !['codex', 'claude-code'].includes(proposal.requestedBy) ||
      !['auto-private', 'owner-validated', 'explicit'].includes(proposal.approvalClass) ||
      !['shared', 'private'].includes(proposal.sensitivity) ||
      Number.isNaN(Date.parse(proposal.occurredAt)) ||
      (proposal.approvalClass === 'auto-private' && proposal.sensitivity !== 'private')) {
    throw new Error('Correction proposal is invalid.');
  }
}

function validateDecision(decision) {
  if (!isRecord(decision) || Object.keys(decision).length !== DECISION_FIELDS.size ||
      Object.keys(decision).some((key) => !DECISION_FIELDS.has(key)) ||
      decision.schemaVersion !== 1 ||
      !/^acb:\/\/correction\/[a-f0-9]{64}$/u.test(decision.correctionRef ?? '') ||
      !HASH.test(decision.expectedProposalEventId ?? '') ||
      !['accept', 'reject'].includes(decision.decision) ||
      !HASH.test(decision.observedRevisionHash ?? '') ||
      !validRefs(decision.evidenceRefs) ||
      !['codex', 'claude-code'].includes(decision.decidedBy) ||
      Number.isNaN(Date.parse(decision.occurredAt))) {
    throw new Error('Correction decision is invalid.');
  }
}

function proposalId(proposal) {
  return sha256(stableJson({
    proposalKey: proposal.proposalKey,
    targetRef: proposal.targetRef,
    targetRevisionHash: proposal.targetRevisionHash,
    correctionKind: proposal.correctionKind,
    disposition: proposal.disposition,
    replacementHash: proposal.replacementHash,
    scope: proposal.scope
  }));
}

function proposalEvent(proposal) {
  const id = proposalId(proposal);
  return {
    idempotencyKey: proposal.proposalKey,
    eventType: 'correction.proposed',
    occurredAt: new Date(proposal.occurredAt).toISOString(),
    provider: proposal.requestedBy,
    scope: proposal.scope,
    taskKeyHash: null,
    threadKey: null,
    sourceRefs: [],
    subjectRef: `acb://correction/${id}`,
    replacesRef: proposal.targetRef,
    evidenceRefs: proposal.evidenceRefs,
    confidence: proposal.confidence,
    freshness: {
      status: 'current',
      verifiedAt: new Date(proposal.occurredAt).toISOString(),
      expiresAt: null,
      sourceHeadHash: proposal.targetRevisionHash,
      policy: 'correction-cas'
    },
    sensitivity: proposal.sensitivity,
    redactionResult: 'clean',
    approvalState: 'pending',
    payload: {
      correctionKind: proposal.correctionKind,
      disposition: proposal.disposition,
      targetRevisionHash: proposal.targetRevisionHash,
      replacementHash: proposal.replacementHash,
      approvalClass: proposal.approvalClass
    }
  };
}

function findProposal(runtimeRoot, decision) {
  const { events } = verifyEventStore({ runtimeRoot });
  const related = events.filter((event) => event.subjectRef === decision.correctionRef);
  const proposal = related.find((event) => event.eventType === 'correction.proposed');
  const terminal = related.find((event) =>
    ['correction.accepted', 'correction.rejected'].includes(event.eventType)
  );
  if (!proposal || proposal.eventId !== decision.expectedProposalEventId) {
    throw new Error('Correction proposal CAS mismatch.');
  }
  if (terminal) throw new Error('Correction already has a terminal decision.');
  return proposal;
}

export function planCorrectionProposal(inputOptions = {}) {
  validateProposal(inputOptions.proposal);
  const id = proposalId(inputOptions.proposal);
  return {
    schemaVersion: 1,
    mode: 'correction-proposal',
    writesEnabled: false,
    correctionRef: `acb://correction/${id}`,
    targetRevisionHash: inputOptions.proposal.targetRevisionHash,
    replacementHash: inputOptions.proposal.replacementHash
  };
}

export async function proposeCorrection(inputOptions = {}) {
  if (inputOptions.execute !== true || !inputOptions.runtimeRoot) {
    throw new Error('Correction proposal requires execute: true and runtimeRoot.');
  }
  validateProposal(inputOptions.proposal);
  const event = await appendBrokerEvent({
    ...inputOptions,
    event: proposalEvent(inputOptions.proposal)
  });
  return {
    schemaVersion: 1,
    mode: 'correction-proposal',
    correctionRef: event.subjectRef,
    proposalEventId: event.eventId,
    idempotentReplay: event.idempotentReplay
  };
}

export function planCorrectionDecision(inputOptions = {}) {
  validateDecision(inputOptions.decision);
  if (!inputOptions.runtimeRoot) throw new Error('Correction runtime root is required.');
  const proposal = findProposal(inputOptions.runtimeRoot, inputOptions.decision);
  const expectedHash = inputOptions.decision.decision === 'accept'
    ? proposal.payload.replacementHash
    : proposal.payload.targetRevisionHash;
  if (inputOptions.decision.observedRevisionHash !== expectedHash) {
    throw new Error('Correction target revision CAS mismatch.');
  }
  return {
    schemaVersion: 1,
    mode: 'correction-decision',
    writesEnabled: false,
    correctionRef: inputOptions.decision.correctionRef,
    decision: inputOptions.decision.decision,
    proposalEventId: proposal.eventId
  };
}

export async function decideCorrection(inputOptions = {}) {
  if (inputOptions.execute !== true || !inputOptions.runtimeRoot) {
    throw new Error('Correction decision requires execute: true and runtimeRoot.');
  }
  const plan = planCorrectionDecision(inputOptions);
  const proposal = findProposal(inputOptions.runtimeRoot, inputOptions.decision);
  const decision = inputOptions.decision;
  const idempotencyKey = sha256(stableJson({
    correctionRef: decision.correctionRef,
    expectedProposalEventId: decision.expectedProposalEventId,
    decision: decision.decision,
    observedRevisionHash: decision.observedRevisionHash
  }));
  const event = await appendBrokerEvent({
    ...inputOptions,
    event: {
      idempotencyKey,
      eventType: decision.decision === 'accept'
        ? 'correction.accepted'
        : 'correction.rejected',
      occurredAt: new Date(decision.occurredAt).toISOString(),
      provider: decision.decidedBy,
      scope: proposal.scope,
      taskKeyHash: proposal.taskKeyHash,
      threadKey: proposal.threadKey,
      sourceRefs: [],
      subjectRef: decision.correctionRef,
      replacesRef: proposal.replacesRef,
      evidenceRefs: decision.evidenceRefs,
      confidence: proposal.confidence,
      freshness: {
        status: 'current',
        verifiedAt: new Date(decision.occurredAt).toISOString(),
        expiresAt: null,
        sourceHeadHash: decision.observedRevisionHash,
        policy: 'correction-cas'
      },
      sensitivity: proposal.sensitivity,
      redactionResult: 'clean',
      approvalState: decision.decision === 'accept' ? 'approved' : 'rejected',
      payload: {
        decision: decision.decision,
        proposalEventId: proposal.eventId,
        targetRevisionHash: proposal.payload.targetRevisionHash,
        observedRevisionHash: decision.observedRevisionHash
      }
    }
  });
  return {
    ...plan,
    writesEnabled: true,
    decisionEventId: event.eventId,
    idempotentReplay: event.idempotentReplay
  };
}
