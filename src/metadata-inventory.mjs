import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
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
import { readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

const DEFAULTS = Object.freeze({
  maxFiles: 20,
  maxScanBytes: 16 * 1024 * 1024,
  tailBootstrapBytes: 1024 * 1024,
  firstLineMaxBytes: 2 * 1024 * 1024,
  activeWindowSeconds: 120,
  peerTtlSeconds: 300,
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  lockStaleMs: 600000,
  recursive: false
});

export function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function normalizePathForIdentity(path) {
  return resolve(path).replaceAll('\\', '/').toLowerCase();
}

function sourceIdFor(path, adapter) {
  return hash(`${adapter.sourceNamespace}:${normalizePathForIdentity(path)}`);
}

export function hashedRelation(kind, value) {
  if (value === undefined || value === null || String(value).length === 0) {
    return null;
  }

  return `${kind}:${hash(`${kind}:${String(value).toLowerCase()}`)}`;
}

function parseJsonLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function discoverDirectory(path, recursive, files) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === '.jsonl') {
      files.push(child);
    } else if (recursive && entry.isDirectory()) {
      await discoverDirectory(child, recursive, files);
    }
  }
}

async function discoverSources(source, options) {
  const path = resolve(source);
  const stat = statSync(path);
  let files = [];

  if (stat.isFile()) {
    files = [path];
  } else if (stat.isDirectory()) {
    await discoverDirectory(path, options.recursive, files);
  } else {
    throw new Error('Source must be a JSONL file or directory.');
  }

  const candidates = files
    .map((file) => ({ path: file, stat: statSync(file) }))
    .filter(({ stat: fileStat }) => fileStat.isFile())
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  return {
    selected: candidates.slice(0, options.maxFiles),
    overflow: candidates.slice(options.maxFiles)
  };
}

async function discoverLedgerFiles(ledgerDir, maxLedgerFiles) {
  if (!existsSync(ledgerDir)) {
    return { selected: [], skipped: 0 };
  }

  const entries = await readdir(ledgerDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.deltas.jsonl'))
    .map((entry) => {
      const path = join(ledgerDir, entry.name);
      return { path, stat: statSync(path) };
    })
    .sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs);

  return {
    selected: files.slice(0, maxLedgerFiles),
    skipped: Math.max(0, files.length - maxLedgerFiles)
  };
}

async function readMetadata(path, maxBytes, adapter, sourceId) {
  let buffered = Buffer.alloc(0);
  let bytesRead = 0;
  const records = [];
  const sourceSize = statSync(path).size;

  for await (const chunk of createReadStream(path, {
    start: 0,
    end: maxBytes - 1,
    highWaterMark: 64 * 1024
  })) {
    bytesRead += chunk.length;
    buffered = Buffer.concat([buffered, chunk]);
    let newline;
    while ((newline = buffered.indexOf(0x0a)) >= 0) {
      let line = buffered.subarray(0, newline);
      if (line.at(-1) === 0x0d) {
        line = line.subarray(0, -1);
      }
      const record = parseJsonLine(line.toString('utf8'));
      if (record) {
        records.push(record);
      }
      buffered = buffered.subarray(newline + 1);
    }
    if (adapter.hasRequiredMetadata(records)) {
      break;
    }
  }

  if (!adapter.hasRequiredMetadata(records) && buffered.length > 0 && bytesRead >= sourceSize) {
    let line = buffered;
    if (line.at(-1) === 0x0d) {
      line = line.subarray(0, -1);
    }
    const record = parseJsonLine(line.toString('utf8'));
    if (record) {
      records.push(record);
    }
  }

  const metadata = adapter.metadataFromRecords(records, sourceId, path);
  if (!metadata?.sessionIdHash || !Array.isArray(metadata.relationKeys)) {
    throw new Error(`${adapter.provider} source metadata is unavailable.`);
  }
  return {
    metadata,
    metadataHash: hash(JSON.stringify(metadata))
  };
}

async function readSourceIdentity(adapter, source) {
  const path = resolve(source);
  const sourceId = sourceIdFor(path, adapter);
  const { metadata } = await readMetadata(
    path,
    DEFAULTS.firstLineMaxBytes,
    adapter,
    sourceId
  );

  return {
    sourceId,
    sessionIdHash: metadata.sessionIdHash,
    parentSessionIdHash: metadata.parentSessionIdHash,
    relationKeys: metadata.relationKeys
  };
}

function addCount(counts, key) {
  const safeKey = typeof key === 'string' && key.length > 0 ? key : 'unknown';
  counts[safeKey] = (counts[safeKey] ?? 0) + 1;
}

async function scanCompleteLines(
  path,
  requestedStart,
  discardPartialStart,
  endExclusive,
  adapter
) {
  const segmentHasher = createHash('sha256');
  const recordCounts = {};
  let malformedRecords = 0;
  let firstEventAt = null;
  let lastEventAt = null;
  let lastLifecycle = null;
  let buffer = Buffer.alloc(0);
  let effectiveStart = requestedStart;
  let committedBytes = 0;
  let discardPending = discardPartialStart;

  const stream = requestedStart < endExclusive
    ? createReadStream(path, {
      start: requestedStart,
      end: endExclusive - 1,
      highWaterMark: 64 * 1024
    })
    : [];

  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);

    if (discardPending) {
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) {
        continue;
      }

      effectiveStart += newline + 1;
      buffer = buffer.subarray(newline + 1);
      discardPending = false;
    }

    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const committed = buffer.subarray(0, newline + 1);
      segmentHasher.update(committed);
      committedBytes += committed.length;

      let lineBytes = committed.subarray(0, -1);
      if (lineBytes.at(-1) === 0x0d) {
        lineBytes = lineBytes.subarray(0, -1);
      }

      const row = parseJsonLine(lineBytes.toString('utf8'));
      if (!row) {
        malformedRecords += 1;
      } else {
        const inspected = adapter.inspectRecord(row);
        addCount(recordCounts, inspected.recordType ?? row.type);
        if (typeof inspected.timestamp === 'string') {
          firstEventAt ??= inspected.timestamp;
          lastEventAt = inspected.timestamp;
        }
        if (typeof inspected.lifecycle === 'string') {
          lastLifecycle = inspected.lifecycle;
        }
      }

      buffer = buffer.subarray(newline + 1);
    }
  }

  return {
    coverageStartOffset: effectiveStart,
    nextOffset: effectiveStart + committedBytes,
    segmentHash: segmentHasher.digest('hex'),
    appendedBytes: committedBytes,
    recordCounts,
    malformedRecords,
    firstEventAt,
    lastEventAt,
    lastLifecycle
  };
}

function chainHash(previousHash, segment, generation) {
  if (segment.appendedBytes === 0 && previousHash) {
    return previousHash;
  }

  return hash([
    previousHash ?? 'initial',
    generation,
    segment.coverageStartOffset,
    segment.nextOffset,
    segment.segmentHash
  ].join(':'));
}

function classifyThread({
  adapter,
  lastLifecycle,
  lastWriteAt,
  now,
  previousState,
  grew,
  activeWindowSeconds
}) {
  let state = adapter.stateForLifecycle(lastLifecycle);
  if (!state) {
    const ageMs = now.getTime() - lastWriteAt.getTime();
    state = ageMs <= activeWindowSeconds * 1000
      ? 'active'
      : 'quiescent';
  }

  if (grew && adapter.terminalStates.has(previousState) && state === 'active') {
    return 'reopened';
  }

  return state;
}

function expiryFor(state, now, peerTtlSeconds, adapter) {
  if (adapter.terminalStates.has(state)) {
    return null;
  }

  return new Date(now.getTime() + peerTtlSeconds * 1000).toISOString();
}

function loadCheckpoint(path, adapter) {
  if (!path || !existsSync(path)) {
    return {
      schemaVersion: 1,
      provider: adapter.provider,
      adapterVersion: adapter.adapterVersion,
      updatedAt: new Date(0).toISOString(),
      sequence: 0,
      sources: {}
    };
  }

  const checkpoint = JSON.parse(readFileSync(path, 'utf8'));
  if (checkpoint.schemaVersion !== 1 || checkpoint.provider !== adapter.provider) {
    throw new Error(`Unsupported ${adapter.provider} inventory checkpoint.`);
  }

  return checkpoint;
}

function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(
    dirname(path),
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) {
      unlinkSync(temporary);
    }
  }
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function withCheckpointLock(checkpointPath, options, action) {
  mkdirSync(dirname(checkpointPath), { recursive: true });
  const lockPath = `${checkpointPath}.lock`;
  const startedAt = Date.now();
  let descriptor;

  while (descriptor === undefined) {
    try {
      descriptor = openSync(lockPath, 'wx');
      try {
        writeFileSync(descriptor, JSON.stringify({
          processId: process.pid,
          acquiredAt: new Date().toISOString()
        }));
      } catch (error) {
        closeSync(descriptor);
        descriptor = undefined;
        unlinkSync(lockPath);
        throw error;
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      try {
        const lockStat = statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > options.lockStaleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') {
          throw statError;
        }
        continue;
      }

      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error(`${options.adapter.provider} inventory checkpoint is busy.`);
      }
      await delay(options.lockRetryMs);
    }
  }

  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function normalizedOptions(adapter, options) {
  return {
    ...DEFAULTS,
    ...options,
    adapter,
    source: resolve(options.source),
    now: options.now ? new Date(options.now) : new Date()
  };
}

async function planInventory(adapter, inputOptions) {
  const options = normalizedOptions(adapter, inputOptions);
  const discovered = await discoverSources(options.source, options);

  return {
    provider: adapter.provider,
    adapterVersion: adapter.adapterVersion,
    mode: 'plan',
    selected: discovered.selected.map(({ path, stat }) => ({
      sourceId: sourceIdFor(path, adapter),
      sizeBytes: stat.size,
      largeFileTailBootstrap: stat.size > options.maxScanBytes
    })),
    skippedByFileLimit: discovered.overflow.map(({ path }) => sourceIdFor(path, adapter)),
    limits: {
      maxFiles: options.maxFiles,
      maxScanBytes: options.maxScanBytes,
      tailBootstrapBytes: options.tailBootstrapBytes
    },
    writesEnabled: false
  };
}

async function readRelatedDeltas(adapter, inputOptions) {
  const options = {
    maxLedgerFiles: 100,
    afterSequence: 0,
    includeSelf: false,
    ...inputOptions,
    source: resolve(inputOptions.source),
    ledgerDir: resolve(inputOptions.ledgerDir),
    now: inputOptions.now ? new Date(inputOptions.now) : new Date()
  };
  const sourceId = sourceIdFor(options.source, adapter);
  const { metadata } = await readMetadata(
    options.source,
    DEFAULTS.firstLineMaxBytes,
    adapter,
    sourceId
  );
  const relationSet = new Set(metadata.relationKeys);
  const ledger = await discoverLedgerFiles(options.ledgerDir, options.maxLedgerFiles);
  const matches = new Map();
  let watermark = options.afterSequence;

  for (const file of ledger.selected) {
    const text = readFileSync(file.path, 'utf8');
    for (const line of text.split(/\r?\n/u)) {
      if (!line) {
        continue;
      }
      const delta = parseJsonLine(line);
      if (!delta || delta.provider !== adapter.provider || !Number.isInteger(delta.sequence)) {
        continue;
      }

      watermark = Math.max(watermark, delta.sequence);
      if (delta.sequence <= options.afterSequence) {
        continue;
      }
      if (!options.includeSelf && delta.sourceId === sourceId) {
        continue;
      }
      if (!delta.relationKeys?.some((key) => relationSet.has(key))) {
        continue;
      }
      if (
        delta.classification === 'unverified' &&
        delta.expiresAt &&
        new Date(delta.expiresAt).getTime() <= options.now.getTime()
      ) {
        continue;
      }

      matches.set(delta.deltaId, delta);
    }
  }

  return {
    schemaVersion: 1,
    provider: adapter.provider,
    generatedAt: options.now.toISOString(),
    afterSequence: options.afterSequence,
    watermark,
    relationKeyCount: relationSet.size,
    ledgerFilesScanned: ledger.selected.length,
    ledgerFilesSkipped: ledger.skipped,
    deltas: [...matches.values()].sort((left, right) => left.sequence - right.sequence)
  };
}

async function runInventoryLocked(options) {
  const adapter = options.adapter;
  const checkpoint = loadCheckpoint(options.checkpoint, adapter);
  const discovered = await discoverSources(options.source, options);
  const nowIso = options.now.toISOString();
  const runId = randomUUID();
  const sources = [];
  const skipped = discovered.overflow.map(({ path }) => ({
    sourceId: sourceIdFor(path, adapter),
    reason: 'file-limit'
  }));
  const deltas = [];

  for (const candidate of discovered.selected) {
    const sourceId = sourceIdFor(candidate.path, adapter);
    try {
      const { metadata, metadataHash } = await readMetadata(
        candidate.path,
        options.firstLineMaxBytes,
        adapter,
        sourceId
      );
      const previous = checkpoint.sources[sourceId];
      const reset = Boolean(previous) && (
        candidate.stat.size < previous.nextOffset ||
        metadataHash !== previous.metadataHash
      );

      if (previous && !reset && candidate.stat.size === previous.nextOffset) {
        skipped.push({ sourceId, reason: 'unchanged' });
        continue;
      }

      const generation = reset ? previous.generation + 1 : (previous?.generation ?? 1);
      let requestedStart;
      let discardPartialStart;
      let coverage;
      let coverageStartOffset;

      if (previous && !reset) {
        requestedStart = previous.nextOffset;
        discardPartialStart = false;
        coverage = 'incremental';
        coverageStartOffset = previous.coverageStartOffset;
      } else if (candidate.stat.size <= options.maxScanBytes) {
        requestedStart = 0;
        discardPartialStart = false;
        coverage = 'full';
        coverageStartOffset = 0;
      } else {
        requestedStart = Math.max(0, candidate.stat.size - options.tailBootstrapBytes);
        discardPartialStart = requestedStart > 0;
        coverage = 'tail';
        coverageStartOffset = requestedStart;
      }

      const segment = await scanCompleteLines(
        candidate.path,
        requestedStart,
        discardPartialStart,
        candidate.stat.size,
        adapter
      );
      if (previous && !reset && segment.appendedBytes === 0) {
        skipped.push({ sourceId, reason: 'unchanged' });
        continue;
      }
      if (coverage === 'tail') {
        coverageStartOffset = segment.coverageStartOffset;
      }

      const lastLifecycle = options.lifecycleOverride ??
        segment.lastLifecycle ??
        previous?.lastLifecycle ??
        null;
      const grew = Boolean(previous) && candidate.stat.size > previous.nextOffset;
      const threadState = classifyThread({
        adapter,
        lastLifecycle,
        lastWriteAt: candidate.stat.mtime,
        now: options.now,
        previousState: previous?.threadState ?? null,
        grew,
        activeWindowSeconds: options.activeWindowSeconds
      });
      const contentChainHash = chainHash(
        reset ? null : previous?.contentChainHash,
        segment,
        generation
      );

      const source = {
        sourceId,
        sessionIdHash: metadata.sessionIdHash,
        parentSessionIdHash: metadata.parentSessionIdHash,
        generation,
        sizeBytes: candidate.stat.size,
        lastWriteAt: candidate.stat.mtime.toISOString(),
        coverage,
        coverageStartOffset,
        nextOffset: segment.nextOffset,
        recordCounts: segment.recordCounts,
        malformedRecords: segment.malformedRecords,
        firstEventAt: segment.firstEventAt,
        lastEventAt: segment.lastEventAt,
        threadState,
        relationKeys: metadata.relationKeys,
        contentChainHash,
        privacy: 'private'
      };
      sources.push(source);

      checkpoint.sequence += 1;
      const classification = adapter.terminalStates.has(threadState)
        ? 'candidate'
        : 'unverified';
      const deltaCore = [
        sourceId,
        generation,
        segment.coverageStartOffset,
        segment.nextOffset,
        contentChainHash,
        threadState
      ].join(':');
      deltas.push({
        schemaVersion: 1,
        deltaId: hash(deltaCore),
        sequence: checkpoint.sequence,
        runId,
        provider: adapter.provider,
        sourceId,
        observedAt: nowIso,
        expiresAt: expiryFor(
          threadState,
          options.now,
          options.peerTtlSeconds,
          adapter
        ),
        classification,
        threadState,
        previousThreadState: previous?.threadState ?? null,
        relationKeys: metadata.relationKeys,
        appendedBytes: segment.appendedBytes,
        recordCountDelta: segment.recordCounts,
        coverage
      });

      checkpoint.sources[sourceId] = {
        sizeBytes: candidate.stat.size,
        generation,
        metadataHash,
        lastWriteAt: candidate.stat.mtime.toISOString(),
        nextOffset: segment.nextOffset,
        coverageStartOffset,
        contentChainHash,
        sessionIdHash: metadata.sessionIdHash,
        parentSessionIdHash: metadata.parentSessionIdHash,
        threadState,
        lastLifecycle,
        relationKeys: metadata.relationKeys
      };
    } catch {
      skipped.push({ sourceId, reason: 'unreadable' });
    }
  }

  checkpoint.updatedAt = nowIso;
  checkpoint.adapterVersion = adapter.adapterVersion;

  const inventory = {
    schemaVersion: 1,
    runId,
    provider: adapter.provider,
    adapterVersion: adapter.adapterVersion,
    generatedAt: nowIso,
    mode: 'observe',
    outputClass: 'private-metadata',
    sources,
    skipped
  };

  // Publish evidence first and the checkpoint last so a partial write replays
  // an idempotent delta instead of silently skipping unrecorded evidence.
  writeAtomic(options.output, `${JSON.stringify(inventory, null, 2)}\n`);
  writeAtomic(
    options.deltas,
    deltas.map((delta) => JSON.stringify(delta)).join('\n') + (deltas.length ? '\n' : '')
  );
  writeAtomic(
    join(options.ledgerDir, `${runId}.inventory.json`),
    `${JSON.stringify(inventory, null, 2)}\n`
  );
  writeAtomic(
    join(options.ledgerDir, `${runId}.deltas.jsonl`),
    deltas.map((delta) => JSON.stringify(delta)).join('\n') + (deltas.length ? '\n' : '')
  );
  if (options.beforeCheckpoint) {
    await options.beforeCheckpoint({ inventory, deltas });
  }
  writeAtomic(options.checkpoint, `${JSON.stringify(checkpoint, null, 2)}\n`);

  return { inventory, deltas, checkpoint, ledgerArtifacts: 2 };
}

async function runInventory(adapter, inputOptions) {
  const options = normalizedOptions(adapter, inputOptions);
  if (!options.output || !options.deltas || !options.checkpoint || !options.ledgerDir) {
    throw new Error(
      'Execute mode requires output, deltas, checkpoint, and ledger directory paths.'
    );
  }
  return withCheckpointLock(
    options.checkpoint,
    options,
    () => runInventoryLocked(options)
  );
}

function normalizeAdapter(definition) {
  const requiredStrings = ['provider', 'adapterVersion', 'sourceNamespace'];
  for (const field of requiredStrings) {
    if (typeof definition?.[field] !== 'string' || definition[field].length === 0) {
      throw new Error(`Inventory adapter requires ${field}.`);
    }
  }

  for (const field of [
    'hasRequiredMetadata',
    'metadataFromRecords',
    'inspectRecord',
    'stateForLifecycle'
  ]) {
    if (typeof definition[field] !== 'function') {
      throw new Error(`Inventory adapter requires ${field}().`);
    }
  }

  const terminalStates = definition.terminalStates instanceof Set
    ? new Set(definition.terminalStates)
    : new Set(definition.terminalStates ?? []);
  if (terminalStates.size === 0) {
    throw new Error('Inventory adapter requires at least one terminal state.');
  }

  return Object.freeze({ ...definition, terminalStates });
}

export function createMetadataInventoryAdapter(definition) {
  const adapter = normalizeAdapter(definition);

  return Object.freeze({
    provider: adapter.provider,
    adapterVersion: adapter.adapterVersion,
    readSourceIdentity: (source) => readSourceIdentity(adapter, source),
    planInventory: (options) => planInventory(adapter, options),
    readRelatedDeltas: (options) => readRelatedDeltas(adapter, options),
    runInventory: (options) => runInventory(adapter, options)
  });
}
