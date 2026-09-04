import { sha256, stableJson } from './event-store.mjs';
import {
  currentScopeContext,
  planReconciliation,
  reconcileClaimBatch
} from './reconciliation.mjs';
import { provenanceForSourceToken } from './source-attestation.mjs';
import { relationsForScope } from './work-ledgers.mjs';

const CLAIM_FIELDS = new Set([
  'claimKey', 'claimType', 'subject', 'predicate', 'value', 'observedAt',
  'confidence', 'sensitivity', 'evidenceClass', 'verification', 'freshness',
  'canonicalRefs'
]);
const PROPOSAL_FIELDS = new Set([
  'schemaVersion', 'proposalId', 'sourceToken', 'scope', 'claims'
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateProposal(proposal) {
  if (!isRecord(proposal) || proposal.schemaVersion !== 1 ||
      Object.keys(proposal).some((field) => !PROPOSAL_FIELDS.has(field)) ||
      typeof proposal.proposalId !== 'string' || proposal.proposalId.length === 0 ||
      typeof proposal.sourceToken !== 'string' ||
      !isRecord(proposal.scope) ||
      !['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(proposal.scope.kind) ||
      typeof proposal.scope.key !== 'string' || proposal.scope.key.length === 0 ||
      !Array.isArray(proposal.claims) || proposal.claims.length === 0) {
    throw new Error('Context publication proposal is invalid.');
  }
  for (const claim of proposal.claims) {
    if (!isRecord(claim) || Object.keys(claim).some((field) => !CLAIM_FIELDS.has(field))) {
      throw new Error('Context publication proposal claim is invalid.');
    }
  }
}

export function buildClaimBatch(inputOptions = {}) {
  validateProposal(inputOptions.proposal);
  const proposal = inputOptions.proposal;
  const provenance = provenanceForSourceToken({
    runtimeRoot: inputOptions.eventRuntimeRoot,
    sourceToken: proposal.sourceToken
  });
  if (inputOptions.provider && provenance.provider !== inputOptions.provider) {
    throw new Error('Source token provider does not match the publishing provider.');
  }
  const claimProvenance = {
    provider: provenance.provider,
    sessionKey: provenance.sessionKey,
    recordKey: provenance.recordKey,
    sourceHash: provenance.sourceHash
  };
  const current = currentScopeContext({
    runtimeRoot: inputOptions.runtimeRoot,
    scope: proposal.scope
  });
  const relations = [proposal.scope, ...relationsForScope(proposal.scope, {
    ...inputOptions,
    requireReviewLedger: proposal.scope.kind === 'merge-request'
  })];
  const relationKeys = [...new Set(relations.map((relation) =>
    `${relation.kind}:${sha256(relation.key.toLowerCase())}`
  ))].sort();
  return {
    schemaVersion: 1,
    batchId: `publish-${sha256(stableJson(proposal))}`,
    expectedSnapshotHash: current.snapshotHash,
    scope: proposal.scope,
    relationKeys,
    claims: proposal.claims.map((claim) => ({
      ...claim,
      expectedCurrentClaimId: current.claimIds[claim.claimKey] ?? null,
      provenance: [claimProvenance]
    }))
  };
}

export function planContextPublication(inputOptions = {}) {
  const batch = buildClaimBatch(inputOptions);
  const source = provenanceForSourceToken({
    runtimeRoot: inputOptions.eventRuntimeRoot,
    sourceToken: inputOptions.proposal.sourceToken
  });
  return {
    ...planReconciliation({ ...inputOptions, batch }),
    mode: 'context-publication',
    sourceTokenHash: sha256(inputOptions.proposal.sourceToken),
    proposalIdHash: sha256(inputOptions.proposal.proposalId),
    threadRef: source.threadRef
  };
}

export async function publishContext(inputOptions = {}) {
  if (inputOptions.execute !== true) {
    throw new Error('Context publication writes require execute: true.');
  }
  const batch = buildClaimBatch(inputOptions);
  const source = provenanceForSourceToken({
    runtimeRoot: inputOptions.eventRuntimeRoot,
    sourceToken: inputOptions.proposal.sourceToken
  });
  const result = await reconcileClaimBatch({
    ...inputOptions,
    batch,
    requireSourceAttestation: true,
    attestationRuntimeRoot: inputOptions.eventRuntimeRoot,
    eventRuntimeRoot: inputOptions.eventRuntimeRoot,
    execute: true
  });
  return {
    ...result,
    mode: 'context-publication',
    sourceTokenHash: sha256(inputOptions.proposal.sourceToken),
    proposalIdHash: sha256(inputOptions.proposal.proposalId),
    threadRef: source.threadRef
  };
}
