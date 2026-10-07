import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { appendBrokerEvents, sha256, stableJson, verifyEventTail } from './event-store.mjs';
import { attestSource, planSourceAttestation } from './source-attestation.mts';
import type { SourceAttestation } from './source-attestation.mts';

export type LifecycleSource = { sourceId: string; sessionIdHash: string; generation: number; nextOffset: number; contentChainHash: string; relationKeys: string[]; lastEventAt?: string | null };
export type LifecycleDelta = { deltaId: string; sourceId: string; classification: string; expiresAt: string | null; appendedBytes: number; threadState: string };
export type LifecycleInventory = { provider: SourceAttestation['provider']; generatedAt: string; runId: string; sources: LifecycleSource[] };
export type LifecycleOutbox = { schemaVersion: number; runId: string; inventoryHash: string; attestations: SourceAttestation[]; events: ReturnType<typeof deltaEvent>[] };
export type PersistLifecycleOptions = { inventory: LifecycleInventory; deltas: LifecycleDelta[]; lifecycleRuntimeRoot: string; atomicWriter: (path: string, value: string) => void };
export type DeliverLifecycleOptions = { lifecycleRuntimeRoot: string; eventRuntimeRoot: string; atomicWriter: (path: string, value: string) => void; allowGenesis?: boolean };
export type LifecycleDelivery = { deliveredEntries: number; deliveredEvents: number; attestedSubjectRefs: string[] };

export function sourceAttestation(provider: LifecycleInventory['provider'], source: LifecycleSource, observedAt: string): SourceAttestation {
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

function deltaEvent(provider: LifecycleInventory['provider'], delta: LifecycleDelta, source: LifecycleSource, attestation: SourceAttestation, observedAt: string) {
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

// Valid time is a property of the source, not of the run that happened to read it.
// Using the run timestamp collapses an entire ingested history into one instant, which
// makes months-old threads look freshly observed; a backfill then outranks current
// context. The source's own newest record is the honest answer, and for a live session
// it is seconds old, so live behaviour is unchanged.
export function observedAtFor(source: LifecycleSource | undefined, fallback: string): string {
  const candidate = source?.lastEventAt;
  return typeof candidate === 'string' && !Number.isNaN(Date.parse(candidate))
    ? new Date(candidate).toISOString()
    : fallback;
}

export function lifecycleOutboxEntry(inventory: LifecycleInventory, deltas: LifecycleDelta[]): LifecycleOutbox {
  const sources = new Map(inventory.sources.map((source) => [source.sourceId, source]));
  const attestations = inventory.sources.map((source) =>
    sourceAttestation(inventory.provider, source, observedAtFor(source, inventory.generatedAt))
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
    // A delta whose source is not in the inventory has no attestation to point at, so it
    // cannot become an event. Dropping it would lose it for good, because both callers move
    // on once the outbox is written; refusing leaves the run to be replayed or inspected.
    events: deltas.map((delta) => {
      const source = sources.get(delta.sourceId);
      const attestation = bySource.get(delta.sourceId);
      if (!source || !attestation) {
        throw new Error(`Lifecycle outbox refused run ${inventory.runId}: delta ${delta.deltaId} ` +
          'names a source its inventory does not hold.');
      }
      return deltaEvent(inventory.provider, delta, source, attestation, observedAtFor(source, inventory.generatedAt));
    })
  };
}

export function persistLifecycleOutbox(inputOptions: PersistLifecycleOptions): string | null {
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

// A receipt proves that a chain existed only through its content: the events it delivered
// or the head it left behind. A file name alone is not evidence - a receipt for an entry
// that delivered nothing says nothing about the store - while a receipt that cannot be
// read is treated as proof, because failing closed is the whole point of this guard.
function receiptsProveChain(deliveredRoot: string): boolean {
  if (!existsSync(deliveredRoot)) return false;
  return readdirSync(deliveredRoot).some((name) => {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) return false;
    try {
      const parsedReceipt: unknown = JSON.parse(readFileSync(join(deliveredRoot, name), 'utf8'));
      const receipt = parsedReceipt !== null && typeof parsedReceipt === 'object'
        ? parsedReceipt as { headEventId?: unknown; eventIds?: unknown } : null;
      return typeof receipt?.headEventId === 'string' ||
        (Array.isArray(receipt?.eventIds) && receipt.eventIds.length > 0);
    } catch {
      return true;
    }
  });
}

export async function deliverLifecycleOutbox(inputOptions: DeliverLifecycleOptions): Promise<LifecycleDelivery> {
  const lifecycleRoot = resolve(inputOptions.lifecycleRuntimeRoot);
  const pendingRoot = join(lifecycleRoot, 'event-outbox', 'pending');
  if (!existsSync(pendingRoot)) {
    return { deliveredEntries: 0, deliveredEvents: 0, attestedSubjectRefs: [] };
  }
  // The first hook run after activation legitimately seeds an empty store. What is never
  // legitimate is an empty store *after this lifecycle has already delivered events*: a
  // delivered receipt proves the chain existed, so a missing head now means the hook is
  // looking at the wrong or a partially visible directory, not at a fresh store. That is
  // exactly how a second genesis got written beside the real chain and failed verification
  // for every reader. Refuse and leave the outbox pending; a deliberate rebuild opts in.
  const deliveredRoot = join(lifecycleRoot, 'event-outbox', 'delivered');
  if (receiptsProveChain(deliveredRoot) && inputOptions.allowGenesis !== true) {
    const tip = verifyEventTail({ runtimeRoot: inputOptions.eventRuntimeRoot, count: 1 });
    if (tip.head.sequence === 0) {
      throw new Error('Lifecycle delivery refused to start a new event chain: this lifecycle has ' +
        'delivered events before, but the event store now shows no committed head. The store ' +
        'is most likely not the one you think it is. Pass allowGenesis only for a deliberate rebuild.');
    }
  }
  mkdirSync(join(lifecycleRoot, 'event-outbox', 'delivered'), { recursive: true });
  let deliveredEntries = 0;
  let deliveredEvents = 0;
  const attestedSubjectRefs = new Set<string>();
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
    if (outbox.events.length > 0) {
      // One batch per outbox entry: delivery is the path a historical backfill takes,
      // and appending per event made that cost grow with the store.
      const results = await appendBrokerEvents({
        runtimeRoot: inputOptions.eventRuntimeRoot,
        events: outbox.events,
        execute: true
      });
      for (const result of results) {
        eventIds.push(result.eventId);
        deliveredEvents += 1;
      }
    }
    // The receipt names the events it delivered and the chain head it left behind, so a
    // later run can tell a receipt that proves a chain from one that delivered nothing.
    inputOptions.atomicWriter(receiptPath, `${JSON.stringify({
      schemaVersion: 1,
      runIdHash: sha256(outbox.runId),
      inventoryHash: outbox.inventoryHash,
      eventIds,
      headEventId: eventIds.at(-1) ?? null
    }, null, 2)}\n`);
    deliveredEntries += 1;
  }
  return {
    deliveredEntries,
    deliveredEvents,
    attestedSubjectRefs: [...attestedSubjectRefs].sort()
  };
}
