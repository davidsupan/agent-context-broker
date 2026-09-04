import {
  appendBrokerEvent,
  sha256,
  stableJson,
  verifyEventStore
} from './event-store.mjs';

const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_TOKEN = /^acb:\/\/source\/([a-f0-9]{64})$/u;
const FIELDS = new Set([
  'schemaVersion', 'provider', 'sessionKey', 'recordKey', 'sourceHash',
  'inventoryHash', 'observedAt', 'scope', 'sensitivity'
]);

function threadRef(sessionKey) {
  if (!HASH.test(sessionKey ?? '')) throw new Error('Thread reference requires a hashed session key.');
  return `context://thread/${sha256(`standalone-thread:${sessionKey}`)}`;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateAttestation(attestation) {
  if (!isRecord(attestation) || Object.keys(attestation).length !== FIELDS.size ||
      Object.keys(attestation).some((key) => !FIELDS.has(key)) ||
      attestation.schemaVersion !== 1 ||
      !['codex', 'claude-code'].includes(attestation.provider) ||
      ![attestation.sessionKey, attestation.recordKey, attestation.sourceHash,
        attestation.inventoryHash].every((value) => HASH.test(value ?? '')) ||
      typeof attestation.observedAt !== 'string' ||
      Number.isNaN(Date.parse(attestation.observedAt)) ||
      !isRecord(attestation.scope) || Object.keys(attestation.scope).length !== 2 ||
      !['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(attestation.scope.kind) ||
      !HASH.test(attestation.scope.keyHash ?? '') ||
      !['shared', 'private'].includes(attestation.sensitivity)) {
    throw new Error('Source attestation input is invalid.');
  }
}

function attestationCore(attestation) {
  return {
    provider: attestation.provider,
    sessionKey: attestation.sessionKey,
    recordKey: attestation.recordKey,
    sourceHash: attestation.sourceHash,
    inventoryHash: attestation.inventoryHash,
    observedAt: new Date(attestation.observedAt).toISOString(),
    scope: attestation.scope,
    sensitivity: attestation.sensitivity
  };
}

function attestationId(attestation) {
  return sha256(stableJson(attestationCore(attestation)));
}

function brokerEvent(attestation) {
  const id = attestationId(attestation);
  return {
    idempotencyKey: id,
    eventType: 'source.inventoryed',
    occurredAt: new Date(attestation.observedAt).toISOString(),
    provider: attestation.provider,
    scope: attestation.scope,
    taskKeyHash: null,
    threadKey: attestation.sessionKey,
    sourceRefs: [],
    subjectRef: `acb://source/${id}`,
    replacesRef: null,
    evidenceRefs: [`acb://inventory/${attestation.inventoryHash}`],
    confidence: 1,
    freshness: {
      status: 'current',
      verifiedAt: new Date(attestation.observedAt).toISOString(),
      expiresAt: null,
      sourceHeadHash: attestation.inventoryHash,
      policy: 'source-inventory'
    },
    sensitivity: attestation.sensitivity,
    redactionResult: 'clean',
    approvalState: 'not-required',
    payload: {
      sessionKey: attestation.sessionKey,
      recordKey: attestation.recordKey,
      sourceHash: attestation.sourceHash,
      inventoryHash: attestation.inventoryHash,
      status: 'attested'
    }
  };
}

export function planSourceAttestation(inputOptions = {}) {
  validateAttestation(inputOptions.attestation);
  const id = attestationId(inputOptions.attestation);
  return {
    schemaVersion: 1,
    mode: 'source-attestation',
    writesEnabled: false,
    attestationId: id,
    subjectRef: `acb://source/${id}`,
    threadRef: threadRef(inputOptions.attestation.sessionKey)
  };
}

export async function attestSource(inputOptions = {}) {
  if (inputOptions.execute !== true || !inputOptions.runtimeRoot) {
    throw new Error('Source attestation requires execute: true and runtimeRoot.');
  }
  validateAttestation(inputOptions.attestation);
  const event = await appendBrokerEvent({
    ...inputOptions,
    event: brokerEvent(inputOptions.attestation)
  });
  return {
    schemaVersion: 1,
    mode: 'source-attestation',
    attestationId: attestationId(inputOptions.attestation),
    eventId: event.eventId,
    subjectRef: `acb://source/${attestationId(inputOptions.attestation)}`,
    threadRef: threadRef(inputOptions.attestation.sessionKey),
    idempotentReplay: event.idempotentReplay
  };
}

export function isSourceAttested(inputOptions = {}) {
  if (!inputOptions.runtimeRoot) return false;
  const provenance = inputOptions.provenance;
  if (!isRecord(provenance) ||
      !['codex', 'claude-code'].includes(provenance.provider) ||
      ![provenance.sessionKey, provenance.recordKey, provenance.sourceHash]
        .every((value) => HASH.test(value ?? ''))) {
    return false;
  }
  const { events } = verifyEventStore({ runtimeRoot: inputOptions.runtimeRoot });
  return events.some((event) => event.eventType === 'source.inventoryed' &&
    event.provider === provenance.provider &&
    event.payload.sessionKey === provenance.sessionKey &&
    event.payload.recordKey === provenance.recordKey &&
    event.payload.sourceHash === provenance.sourceHash &&
    event.redactionResult === 'clean');
}

export function provenanceForSourceToken(inputOptions = {}) {
  if (!inputOptions.runtimeRoot || typeof inputOptions.sourceToken !== 'string') {
    throw new Error('Source token resolution requires runtimeRoot and sourceToken.');
  }
  const match = SOURCE_TOKEN.exec(inputOptions.sourceToken);
  if (!match) {
    throw new Error('Source token is invalid.');
  }
  const { events } = verifyEventStore({ runtimeRoot: inputOptions.runtimeRoot });
  const event = events.find((candidate) =>
    candidate.eventType === 'source.inventoryed' &&
    candidate.subjectRef === inputOptions.sourceToken &&
    candidate.redactionResult === 'clean'
  );
  if (!event || event.provider === 'system') {
    throw new Error('Source token is not attested.');
  }
  return {
    provider: event.provider,
    sessionKey: event.payload.sessionKey,
    recordKey: event.payload.recordKey,
    sourceHash: event.payload.sourceHash,
    threadRef: threadRef(event.payload.sessionKey)
  };
}
