import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { sha256, stableJson, verifyEventStore } from './event-store.mjs';

const STATUS_BY_EVENT = Object.freeze({
  'source.inventoryed': 'observed',
  'thread.delta': 'observed',
  'claim.proposed': 'pending',
  'claim.accepted': 'accepted',
  'claim.rejected': 'rejected',
  'claim.superseded': 'superseded',
  'snapshot.published': 'published',
  'correction.proposed': 'pending',
  'correction.accepted': 'accepted',
  'correction.rejected': 'rejected',
  'usage.observed': 'observed',
  'peer-progress.published': 'live-unverified',
  'read-model.projected': 'observed'
});

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

function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function kindOf(reference) {
  return reference.slice('acb://'.length).split('/')[0];
}

function nodeFor(reference, event) {
  const attributes = {
    eventType: event.eventType,
    confidence: event.confidence,
    approvalState: event.approvalState,
    redactionResult: event.redactionResult,
    payloadHash: event.payloadHash
  };
  return {
    schemaVersion: 1,
    id: reference,
    kind: kindOf(reference),
    status: STATUS_BY_EVENT[event.eventType],
    freshness: event.freshness.status,
    provider: event.provider,
    sensitivity: event.sensitivity,
    latestSequence: event.sequence,
    latestEventId: event.eventId,
    attributesHash: sha256(stableJson(attributes))
  };
}

function referenceNode(reference, event) {
  return {
    schemaVersion: 1,
    id: reference,
    kind: kindOf(reference),
    status: 'observed',
    freshness: 'unknown',
    provider: event.provider,
    sensitivity: event.sensitivity,
    latestSequence: event.sequence,
    latestEventId: event.eventId,
    attributesHash: sha256(stableJson({ reference }))
  };
}

function edge(from, to, kind, event) {
  const core = { from, to, kind, sequence: event.sequence, eventId: event.eventId };
  return { schemaVersion: 1, id: sha256(stableJson(core)), ...core };
}

function addIndex(index, key, value) {
  index[key] ??= [];
  if (!index[key].includes(value)) index[key].push(value);
}

function projection(events) {
  const nodes = new Map();
  const edges = [];
  for (const event of events) {
    nodes.set(event.subjectRef, nodeFor(event.subjectRef, event));
    for (const sourceRef of event.sourceRefs) {
      if (!nodes.has(sourceRef)) nodes.set(sourceRef, referenceNode(sourceRef, event));
      edges.push(edge(event.subjectRef, sourceRef, 'sourced-from', event));
    }
    for (const evidenceRef of event.evidenceRefs) {
      if (!nodes.has(evidenceRef)) nodes.set(evidenceRef, referenceNode(evidenceRef, event));
      edges.push(edge(event.subjectRef, evidenceRef, 'evidenced-by', event));
    }
    if (event.replacesRef) {
      if (!nodes.has(event.replacesRef)) nodes.set(event.replacesRef, referenceNode(event.replacesRef, event));
      edges.push(edge(event.subjectRef, event.replacesRef, 'replaces', event));
    }
  }
  const orderedNodes = [...nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  const orderedEdges = edges.sort((left, right) => left.id.localeCompare(right.id));
  const indexes = { provider: {}, status: {}, freshness: {} };
  for (const node of orderedNodes) {
    addIndex(indexes.provider, node.provider, node.id);
    addIndex(indexes.status, node.status, node.id);
    addIndex(indexes.freshness, node.freshness, node.id);
  }
  for (const values of Object.values(indexes)) {
    for (const ids of Object.values(values)) ids.sort();
  }
  return { nodes: orderedNodes, edges: orderedEdges, indexes };
}

function contentLines(items) {
  return items.map((item) => stableJson(item)).join('\n') + (items.length ? '\n' : '');
}

function verifiedExisting(outputRoot, manifest) {
  if (!manifest) return false;
  const nodesPath = join(outputRoot, 'nodes.jsonl');
  const edgesPath = join(outputRoot, 'edges.jsonl');
  const indexesPath = join(outputRoot, 'indexes.json');
  return [nodesPath, edgesPath, indexesPath].every(existsSync) &&
    sha256(readFileSync(nodesPath, 'utf8')) === manifest.nodesHash &&
    sha256(readFileSync(edgesPath, 'utf8')) === manifest.edgesHash &&
    sha256(readFileSync(indexesPath, 'utf8')) === manifest.indexesHash;
}

export function planReadModel(inputOptions = {}) {
  if (inputOptions.strictIsolation) {
    return { schemaVersion: 1, mode: 'read-model', strictIsolation: true, reads: 0, writes: 0 };
  }
  if (!inputOptions.runtimeRoot) throw new Error('Read model runtime root is required.');
  return {
    schemaVersion: 1,
    mode: 'read-model',
    strictIsolation: false,
    writesEnabled: false,
    outputRoot: inputOptions.outputRoot ? resolve(inputOptions.outputRoot) :
      join(resolve(inputOptions.runtimeRoot), 'read-model')
  };
}

export function projectReadModel(inputOptions = {}) {
  if (inputOptions.strictIsolation) {
    return { schemaVersion: 1, mode: 'read-model', strictIsolation: true, reads: 0, writes: 0 };
  }
  if (inputOptions.execute !== true || !inputOptions.runtimeRoot) {
    throw new Error('Read model projection requires execute: true and runtimeRoot.');
  }
  const runtimeRoot = resolve(inputOptions.runtimeRoot);
  const outputRoot = inputOptions.outputRoot ? resolve(inputOptions.outputRoot) :
    join(runtimeRoot, 'read-model');
  const verified = verifyEventStore({ runtimeRoot });
  const currentManifestPath = join(outputRoot, 'manifest.json');
  const currentManifest = existsSync(currentManifestPath)
    ? JSON.parse(readFileSync(currentManifestPath, 'utf8'))
    : null;
  if (currentManifest?.sourceHeadHash === verified.head.headHash &&
      verifiedExisting(outputRoot, currentManifest)) {
    return { ...currentManifest, unchanged: true, writes: 0 };
  }

  const result = projection(verified.events);
  const nodesText = contentLines(result.nodes);
  const edgesText = contentLines(result.edges);
  const indexesText = `${JSON.stringify(result.indexes, null, 2)}\n`;
  const manifestCore = {
    schemaVersion: 1,
    sourceSequence: verified.head.sequence,
    sourceEventId: verified.head.eventId,
    sourceHeadHash: verified.head.headHash,
    projectedThroughAt: verified.events.at(-1)?.recordedAt ?? null,
    nodeCount: result.nodes.length,
    edgeCount: result.edges.length,
    nodesHash: sha256(nodesText),
    edgesHash: sha256(edgesText),
    indexesHash: sha256(indexesText)
  };
  const manifest = { ...manifestCore, projectionHash: sha256(stableJson(manifestCore)) };
  atomicWrite(join(outputRoot, 'nodes.jsonl'), nodesText);
  atomicWrite(join(outputRoot, 'edges.jsonl'), edgesText);
  atomicWrite(join(outputRoot, 'indexes.json'), indexesText);
  writeJson(currentManifestPath, manifest);
  return { ...manifest, unchanged: false, writes: 4 };
}
