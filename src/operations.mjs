import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  deliverLifecycleOutbox,
  persistLifecycleOutbox
} from './lifecycle-events.mjs';
import { stableJson, verifyEventStore } from './event-store.mjs';

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function readJson(path, fallback = null) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}

function inventoryPairs(ledgerDirectory) {
  const root = resolve(ledgerDirectory);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.inventory.json'))
    .map((entry) => {
      const runId = entry.name.slice(0, -'.inventory.json'.length);
      return {
        runId,
        inventoryPath: join(root, entry.name),
        deltasPath: join(root, `${runId}.deltas.jsonl`)
      };
    })
    .filter((pair) => existsSync(pair.deltasPath))
    .sort((left, right) => left.runId.localeCompare(right.runId));
}

function loadPair(pair) {
  const inventoryText = readFileSync(pair.inventoryPath, 'utf8');
  const deltasText = readFileSync(pair.deltasPath, 'utf8');
  return {
    inventory: JSON.parse(inventoryText),
    deltas: deltasText.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)),
    inputHash: sha256(`${inventoryText}\n${deltasText}`)
  };
}

export function planLifecycleMigration(inputOptions = {}) {
  const checkpoint = readJson(join(resolve(inputOptions.runtimeRoot), 'migration', 'checkpoint.json'), {
    schemaVersion: 1,
    migratedInputHashes: []
  });
  const migrated = new Set(checkpoint.migratedInputHashes ?? []);
  const pending = inventoryPairs(inputOptions.ledgerDirectory)
    .map((pair) => ({ pair, loaded: loadPair(pair) }))
    .filter(({ loaded }) => !migrated.has(loaded.inputHash));
  return {
    schemaVersion: 1,
    mode: 'lifecycle-migration',
    writesEnabled: false,
    discoveredPairs: inventoryPairs(inputOptions.ledgerDirectory).length,
    pendingPairs: pending.length,
    pendingInputHashes: pending.map(({ loaded }) => loaded.inputHash)
  };
}

export async function migrateLifecycleLedger(inputOptions = {}) {
  if (inputOptions.execute !== true) {
    throw new Error('Lifecycle migration requires execute: true.');
  }
  const runtimeRoot = resolve(inputOptions.runtimeRoot);
  const checkpointPath = join(runtimeRoot, 'migration', 'checkpoint.json');
  const checkpoint = readJson(checkpointPath, {
    schemaVersion: 1,
    migratedInputHashes: []
  });
  const migrated = new Set(checkpoint.migratedInputHashes ?? []);
  let migratedPairs = 0;
  for (const pair of inventoryPairs(inputOptions.ledgerDirectory)) {
    const loaded = loadPair(pair);
    if (migrated.has(loaded.inputHash)) continue;
    persistLifecycleOutbox({
      lifecycleRuntimeRoot: runtimeRoot,
      inventory: loaded.inventory,
      deltas: loaded.deltas,
      atomicWriter: atomicWrite
    });
    await deliverLifecycleOutbox({
      lifecycleRuntimeRoot: runtimeRoot,
      eventRuntimeRoot: inputOptions.eventRuntimeRoot,
      atomicWriter: atomicWrite
    });
    migrated.add(loaded.inputHash);
    checkpoint.migratedInputHashes = [...migrated].sort();
    checkpoint.updatedAt = new Date().toISOString();
    atomicWrite(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    migratedPairs += 1;
  }
  return {
    schemaVersion: 1,
    mode: 'lifecycle-migration',
    writesEnabled: true,
    migratedPairs,
    totalMigratedPairs: migrated.size
  };
}

function fileCount(path, pattern) {
  if (!existsSync(path)) return 0;
  return readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name)).length;
}

function outstandingCount(pendingPath, deliveredPath, pattern) {
  if (!existsSync(pendingPath)) return 0;
  const delivered = new Set(
    existsSync(deliveredPath)
      ? readdirSync(deliveredPath, { withFileTypes: true })
        .filter((entry) => entry.isFile() && pattern.test(entry.name))
        .map((entry) => entry.name)
      : []
  );
  return readdirSync(pendingPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .filter((entry) => !delivered.has(entry.name)).length;
}

export function diagnoseBroker(inputOptions = {}) {
  const runtimeRoot = resolve(inputOptions.runtimeRoot);
  const eventRuntimeRoot = resolve(inputOptions.eventRuntimeRoot ?? runtimeRoot);
  let eventStore;
  try {
    const verified = verifyEventStore({ runtimeRoot: eventRuntimeRoot });
    eventStore = {
      status: 'verified',
      eventCount: verified.events.length,
      headHash: verified.head.headHash
    };
  } catch (error) {
    eventStore = { status: 'invalid', errorClass: error.name };
  }
  const state = readJson(join(runtimeRoot, 'state.json'));
  const registry = readJson(join(runtimeRoot, 'accepted-snapshots.json'));
  const readModelManifest = inputOptions.readModelRoot
    ? readJson(join(resolve(inputOptions.readModelRoot), 'manifest.json'))
    : null;
  return {
    schemaVersion: 1,
    mode: 'doctor',
    writesEnabled: false,
    eventStore,
    reconciliation: {
      stateRevision: state?.revision ?? null,
      registryRevision: registry?.generatedFromRevision ?? null,
      synchronized: state === null || registry === null
        ? null
        : state.revision === registry.generatedFromRevision,
      pendingOutbox: outstandingCount(
        join(runtimeRoot, 'outbox', 'pending'),
        join(runtimeRoot, 'outbox', 'delivered'),
        /^[a-f0-9]{64}\.json$/u
      ),
      deliveredOutbox: fileCount(join(runtimeRoot, 'outbox', 'delivered'), /^[a-f0-9]{64}\.json$/u)
    },
    lifecycle: {
      pendingOutbox: outstandingCount(
        join(runtimeRoot, 'event-outbox', 'pending'),
        join(runtimeRoot, 'event-outbox', 'delivered'),
        /^[a-f0-9]{64}\.json$/u
      ),
      deliveredOutbox: fileCount(join(runtimeRoot, 'event-outbox', 'delivered'), /^[a-f0-9]{64}\.json$/u),
      migratedInputs: readJson(join(runtimeRoot, 'migration', 'checkpoint.json'), {
        migratedInputHashes: []
      }).migratedInputHashes.length
    },
    readModel: readModelManifest === null
      ? { status: 'not-configured' }
      : {
        status: 'present',
        eventHeadHash: readModelManifest.sourceHeadHash ?? null,
        manifestHash: sha256(stableJson(readModelManifest))
      }
  };
}
