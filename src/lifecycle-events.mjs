import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { appendBrokerEvent, sha256, stableJson } from './event-store.mjs';
import { attestSource, planSourceAttestation } from './source-attestation.mjs';

export function sourceAttestation(provider, source, observedAt) {
  return {
    schemaVersion: 1,
    provider,
    sessionKey: source.sessionIdHash,
    recordKey: sha256(`${source.sourceId}:${source.generation}:${source.nextOffset}`),
    sourceHash: source.contentChainHash,
    inventoryHash: sha256(stableJson(source)),
    observedAt,
    scope: {
      kind: 'global',
      keyHash: sha256(source.relationKeys[0] ?? provider)
    },
    sensitivity: 'private'
  };
}

function deltaEvent(provider, delta, source, attestation, observedAt) {
  return {
    idempotencyKey: sha256(`thread-delta:${delta.deltaId}`),
    eventType: 'thread.delta',
    occurredAt: observedAt,
    provider,
    scope: attestation.scope,
    taskKeyHash: null,
    threadKey: attestation.sessionKey,
    sourceRefs: [planSourceAttestation({ attestation }).subjectRef],
    subjectRef: `acb://delta/${delta.deltaId}`,
    replacesRef: null,
    evidenceRefs: [`acb://inventory/${attestation.inventoryHash}`],
    confidence: delta.classification === 'candidate' ? 1 : null,
    freshness: {
      status: 'current',
      policy: 'peer-delta-ttl',
      verifiedAt: observedAt,
      expiresAt: delta.expiresAt,
      sourceHeadHash: source.contentChainHash
    },
    sensitivity: 'private',
    redactionResult: 'clean',
    approvalState: delta.classification === 'candidate' ? 'pending' : 'not-required',
    payload: {
      appendedBytes: delta.appendedBytes,
      classification: delta.classification,
      generation: source.generation,
      threadState: delta.threadState
    }
  };
}

export function lifecycleOutboxEntry(inventory, deltas) {
  const sources = new Map(inventory.sources.map((source) => [source.sourceId, source]));
  const attestations = inventory.sources.map((source) =>
    sourceAttestation(inventory.provider, source, inventory.generatedAt)
  );
  const bySource = new Map(attestations.map((item, index) => [
    inventory.sources[index].sourceId,
    item
  ]));
  return {
    schemaVersion: 1,
    runId: inventory.runId,
    inventoryHash: sha256(stableJson(inventory)),
    attestations,
    events: deltas.map((delta) => deltaEvent(
      inventory.provider,
      delta,
      sources.get(delta.sourceId),
      bySource.get(delta.sourceId),
      inventory.generatedAt
    ))
  };
}

export function persistLifecycleOutbox(inputOptions) {
  const entry = lifecycleOutboxEntry(inputOptions.inventory, inputOptions.deltas);
  if (entry.attestations.length === 0 && entry.events.length === 0) return null;
  const path = join(
    resolve(inputOptions.lifecycleRuntimeRoot),
    'event-outbox',
    'pending',
    `${sha256(entry.runId)}.json`
  );
  inputOptions.atomicWriter(path, `${JSON.stringify(entry, null, 2)}\n`);
  return path;
}

export async function deliverLifecycleOutbox(inputOptions) {
  const lifecycleRoot = resolve(inputOptions.lifecycleRuntimeRoot);
  const pendingRoot = join(lifecycleRoot, 'event-outbox', 'pending');
  if (!existsSync(pendingRoot)) {
    return { deliveredEntries: 0, deliveredEvents: 0, attestedSubjectRefs: [] };
  }
  mkdirSync(join(lifecycleRoot, 'event-outbox', 'delivered'), { recursive: true });
  let deliveredEntries = 0;
  let deliveredEvents = 0;
  const attestedSubjectRefs = new Set();
  const entries = readdirSync(pendingRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^[a-f0-9]{64}\.json$/u.test(entry.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const receiptPath = join(lifecycleRoot, 'event-outbox', 'delivered', entry.name);
    if (existsSync(receiptPath)) continue;
    const outbox = JSON.parse(readFileSync(join(pendingRoot, entry.name), 'utf8'));
    const eventIds = [];
    for (const attestation of outbox.attestations) {
      const result = await attestSource({
        runtimeRoot: inputOptions.eventRuntimeRoot,
        attestation,
        execute: true
      });
      eventIds.push(result.eventId);
      attestedSubjectRefs.add(result.subjectRef);
    }
    for (const event of outbox.events) {
      const result = await appendBrokerEvent({
        runtimeRoot: inputOptions.eventRuntimeRoot,
        event,
        execute: true
      });
      eventIds.push(result.eventId);
      deliveredEvents += 1;
    }
    inputOptions.atomicWriter(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      runIdHash: sha256(outbox.runId),
      inventoryHash: outbox.inventoryHash,
      eventIds
    }, null, 2)}\n`);
    deliveredEntries += 1;
  }
  return {
    deliveredEntries,
    deliveredEvents,
    attestedSubjectRefs: [...attestedSubjectRefs].sort()
  };
}
