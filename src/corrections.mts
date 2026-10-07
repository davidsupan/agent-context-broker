import {
  appendBrokerEvent,
  sha256,
  stableJson,
  verifyEventStore
} from './event-store.mjs';

export type CorrectionScope = { kind: string; keyHash: string };
export type CorrectionProposal = { schemaVersion: 1; proposalKey: string; targetRef: string; targetRevisionHash: string; correctionKind: string; disposition: string; replacementHash: string | null; evidenceRefs: string[]; confidence: number; scope: CorrectionScope; requestedBy: 'codex' | 'claude-code'; approvalClass: string; sensitivity: 'shared' | 'private'; occurredAt: string };
export type CorrectionDecision = { schemaVersion: 1; correctionRef: string; expectedProposalEventId: string; decision: 'accept' | 'reject'; observedRevisionHash: string; evidenceRefs: string[]; decidedBy: 'codex' | 'claude-code'; occurredAt: string };
export type CorrectionProposalOptions = { proposal?: unknown; execute?: boolean; runtimeRoot?: string };
export type CorrectionDecisionOptions = { decision?: unknown; execute?: boolean; runtimeRoot?: string };
export type CorrectionProposalPlan = { schemaVersion: number; mode: string; writesEnabled: boolean; correctionRef: string; targetRevisionHash: string; replacementHash: string | null };
export type CorrectionProposalResult = { schemaVersion: number; mode: string; correctionRef: string; proposalEventId: string; idempotentReplay: boolean };
export type CorrectionDecisionPlan = { schemaVersion: number; mode: string; writesEnabled: boolean; correctionRef: string; decision: string; proposalEventId: string; decisionEventId?: string; idempotentReplay?: boolean };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRefs(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    new Set(value).size === value.length && value.every((item) => REFERENCE.test(item as string));
}

function validScope(value: unknown): value is CorrectionScope {
  return isRecord(value) && Object.keys(value).length === 2 &&
    ['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(value.kind as string) &&
    HASH.test((value.keyHash ?? '') as string);
}

function validateProposal(proposal: unknown): asserts proposal is CorrectionProposal {
  const p = proposal as CorrectionProposal;
  if (!isRecord(proposal) || Object.keys(proposal).length !== PROPOSAL_FIELDS.size ||
      Object.keys(proposal).some((key) => !PROPOSAL_FIELDS.has(key)) ||
      p.schemaVersion !== 1 || !HASH.test(p.proposalKey ?? '') ||
      !REFERENCE.test(p.targetRef ?? '') ||
      !HASH.test(p.targetRevisionHash ?? '') ||
      !['finding', 'guidance', 'claim'].includes(p.correctionKind) ||
      !['replace', 'withdraw', 'refresh'].includes(p.disposition) ||
      !(p.replacementHash === null || HASH.test(p.replacementHash ?? '')) ||
      (p.disposition !== 'withdraw' && p.replacementHash === null) ||
      !validRefs(p.evidenceRefs) || typeof p.confidence !== 'number' ||
      p.confidence < 0 || p.confidence > 1 || !validScope(p.scope) ||
      !['codex', 'claude-code'].includes(p.requestedBy) ||
      !['auto-private', 'owner-validated', 'explicit'].includes(p.approvalClass) ||
      !['shared', 'private'].includes(p.sensitivity) ||
      Number.isNaN(Date.parse(p.occurredAt)) ||
      (p.approvalClass === 'auto-private' && p.sensitivity !== 'private')) {
    throw new Error('Correction proposal is invalid.');
  }
}

function validateDecision(decision: unknown): asserts decision is CorrectionDecision {
  const d = decision as CorrectionDecision;
  if (!isRecord(decision) || Object.keys(decision).length !== DECISION_FIELDS.size ||
      Object.keys(decision).some((key) => !DECISION_FIELDS.has(key)) ||
      d.schemaVersion !== 1 ||
      !/^acb:\/\/correction\/[a-f0-9]{64}$/u.test(d.correctionRef ?? '') ||
      !HASH.test(d.expectedProposalEventId ?? '') ||
      !['accept', 'reject'].includes(d.decision) ||
      !HASH.test(d.observedRevisionHash ?? '') ||
      !validRefs(d.evidenceRefs) ||
      !['codex', 'claude-code'].includes(d.decidedBy) ||
      Number.isNaN(Date.parse(d.occurredAt))) {
    throw new Error('Correction decision is invalid.');
  }
}

function proposalId(proposal: CorrectionProposal): string {
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

function proposalEvent(proposal: CorrectionProposal) {
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

function findProposal(runtimeRoot: string, decision: CorrectionDecision) {
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

export function planCorrectionProposal(inputOptions: CorrectionProposalOptions = {}): CorrectionProposalPlan {
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

export async function proposeCorrection(inputOptions: CorrectionProposalOptions = {}): Promise<CorrectionProposalResult> {
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

export function planCorrectionDecision(inputOptions: CorrectionDecisionOptions = {}): CorrectionDecisionPlan {
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

export async function decideCorrection(inputOptions: CorrectionDecisionOptions = {}): Promise<CorrectionDecisionPlan> {
  if (inputOptions.execute !== true || !inputOptions.runtimeRoot) {
    throw new Error('Correction decision requires execute: true and runtimeRoot.');
  }
  const plan = planCorrectionDecision(inputOptions);
  const decision = inputOptions.decision as CorrectionDecision;
  const proposal = findProposal(inputOptions.runtimeRoot, decision);
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
