import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const HASH = /^[a-f0-9]{64}$/u;
const REFERENCE = /^acb:\/\/[a-z][a-z0-9-]*\/[a-f0-9]{64}$/u;
const SAFE_KEY = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const SAFE_TOKEN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const EVENT_TYPES = new Set([
  'source.inventoryed', 'thread.delta', 'claim.proposed', 'claim.accepted',
  'claim.rejected', 'claim.superseded', 'snapshot.published',
  'correction.proposed', 'correction.accepted', 'correction.rejected',
  'usage.observed', 'read-model.projected', 'peer-progress.published'
]);
const PROVIDERS = new Set(['system', 'codex', 'claude-code']);
const INPUT_FIELDS = new Set([
  'idempotencyKey', 'eventType', 'occurredAt', 'provider', 'scope',
  'taskKeyHash', 'threadKey', 'sourceRefs', 'subjectRef', 'replacesRef',
  'evidenceRefs', 'confidence', 'freshness', 'sensitivity',
  'redactionResult', 'approvalState', 'payload'
]);
const EVENT_FIELDS = new Set([
  'schemaVersion', 'eventId', 'idempotencyKey', 'sequence', 'eventType',
  'occurredAt', 'recordedAt', 'provider', 'scope', 'taskKeyHash', 'threadKey',
  'sourceRefs', 'subjectRef', 'replacesRef', 'evidenceRefs', 'confidence',
  'freshness', 'sensitivity', 'redactionResult', 'approvalState', 'payload',
  'payloadHash', 'previousEventHash'
]);
const DEFAULTS = Object.freeze({
  lockTimeoutMs: 5000,
  lockRetryMs: 50,
  lockStaleMs: 600000
});

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

export function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
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

function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function isProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    // Permission failures still prove that a process owns the PID.
    return error?.code !== 'ESRCH';
  }
}

function shouldReclaimLock(path, options) {
  const lockStat = statSync(path);
  try {
    const lock = JSON.parse(readFileSync(path, 'utf8'));
    if (Number.isSafeInteger(lock?.processId) && lock.processId > 0) {
      return !isProcessAlive(lock.processId);
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }

  return Date.now() - lockStat.mtimeMs > options.lockStaleMs;
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
        if (shouldReclaimLock(path, options)) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error('Broker event store is busy.');
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

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validDate(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function validReferenceList(value) {
  return Array.isArray(value) && new Set(value).size === value.length &&
    value.every((item) => typeof item === 'string' && REFERENCE.test(item));
}

function validPayload(payload) {
  if (!isRecord(payload) || Object.keys(payload).length > 32) return false;
  return Object.entries(payload).every(([key, value]) =>
    SAFE_KEY.test(key) && (
      value === null || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && (HASH.test(value) || SAFE_TOKEN.test(value)))
    )
  );
}

function validateEventInput(event) {
  if (!isRecord(event) || Object.keys(event).some((key) => !INPUT_FIELDS.has(key)) ||
      [...INPUT_FIELDS].some((key) => !Object.hasOwn(event, key))) {
    throw new Error('Broker event input shape is invalid.');
  }
  if (!HASH.test(event.idempotencyKey ?? '') || !EVENT_TYPES.has(event.eventType) ||
      !validDate(event.occurredAt) || !PROVIDERS.has(event.provider)) {
    throw new Error('Broker event identity is invalid.');
  }
  if (!isRecord(event.scope) ||
      !['global', 'project', 'workstream', 'ticket', 'merge-request'].includes(event.scope.kind) ||
      !HASH.test(event.scope.keyHash ?? '') || Object.keys(event.scope).length !== 2) {
    throw new Error('Broker event scope is invalid.');
  }
  for (const value of [event.taskKeyHash, event.threadKey]) {
    if (!(value === null || HASH.test(value ?? ''))) {
      throw new Error('Broker event relation hash is invalid.');
    }
  }
  if (!validReferenceList(event.sourceRefs) || !REFERENCE.test(event.subjectRef ?? '') ||
      !(event.replacesRef === null || REFERENCE.test(event.replacesRef ?? '')) ||
      !validReferenceList(event.evidenceRefs)) {
    throw new Error('Broker event reference is invalid.');
  }
  if (!(event.confidence === null ||
      (typeof event.confidence === 'number' && event.confidence >= 0 && event.confidence <= 1))) {
    throw new Error('Broker event confidence is invalid.');
  }
  const freshness = event.freshness;
  if (!isRecord(freshness) || Object.keys(freshness).length !== 5 ||
      !['current', 'stale', 'expired', 'unknown'].includes(freshness.status) ||
      !(freshness.verifiedAt === null || validDate(freshness.verifiedAt)) ||
      !(freshness.expiresAt === null || validDate(freshness.expiresAt)) ||
      !(freshness.sourceHeadHash === null || HASH.test(freshness.sourceHeadHash ?? '')) ||
      !/^[a-z][a-z0-9.-]{0,63}$/u.test(freshness.policy ?? '')) {
    throw new Error('Broker event freshness is invalid.');
  }
  if (!['shared', 'private'].includes(event.sensitivity) ||
      !['clean', 'suppressed'].includes(event.redactionResult) ||
      !['not-required', 'pending', 'approved', 'rejected'].includes(event.approvalState) ||
      !validPayload(event.payload)) {
    throw new Error('Broker event policy metadata is invalid.');
  }
}

function eventCore(event) {
  return Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'eventId'));
}

function eventInputFromRecord(event) {
  return Object.fromEntries(
    Object.entries(event).filter(([key]) => INPUT_FIELDS.has(key))
  );
}

function validateStoredEvent(event, path, expectedSequence, previousEventHash) {
  if (!isRecord(event) || Object.keys(event).length !== EVENT_FIELDS.size ||
      Object.keys(event).some((key) => !EVENT_FIELDS.has(key))) {
    throw new Error('Broker event chain verification failed.');
  }
  validateEventInput(eventInputFromRecord(event));
  const expectedName = `${String(expectedSequence).padStart(12, '0')}-${event.eventId}.json`;
  if (event.schemaVersion !== 1 || event.sequence !== expectedSequence ||
      basename(path) !== expectedName || event.previousEventHash !== previousEventHash ||
      event.payloadHash !== sha256(stableJson(event.payload)) ||
      event.eventId !== sha256(stableJson(eventCore(event)))) {
    throw new Error('Broker event chain verification failed.');
  }
}

function recordsRoot(runtimeRoot) {
  return join(resolve(runtimeRoot), 'events', 'records');
}

function recordFiles(runtimeRoot) {
  const root = recordsRoot(runtimeRoot);
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d{12}-[a-f0-9]{64}\.json$/u.test(entry.name))
    .map((entry) => join(root, entry.name))
    .sort();
}

function headCore(events) {
  const last = events.at(-1) ?? null;
  return {
    schemaVersion: 1,
    sequence: last?.sequence ?? 0,
    eventId: last?.eventId ?? null,
    previousEventHash: last?.previousEventHash ?? null,
    recordedAt: last?.recordedAt ?? null
  };
}

function expectedHead(events) {
  const core = headCore(events);
  return { ...core, headHash: sha256(stableJson(core)) };
}

export function verifyEventStore(inputOptions = {}) {
  if (!inputOptions.runtimeRoot) throw new Error('Broker event runtime root is required.');
  const headPath = join(resolve(inputOptions.runtimeRoot), 'events', 'head.json');
  const lockPath = join(resolve(inputOptions.runtimeRoot), 'events', 'event-store.lock');
  const readHead = () => existsSync(headPath) ? readFileSync(headPath, 'utf8') : null;
  // Records and head are separate atomic writes. A concurrent append must not
  // make a reader compare an older record list with a newer committed head.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readHead();
    const result = verifyEventRecords(inputOptions.runtimeRoot);
    const after = readHead();
    if (before !== after) continue;
    const actual = after === null ? null : JSON.parse(after);
    if ((actual === null && result.events.length === 0) ||
        stableJson(actual) === stableJson(result.head)) return result;
    if (!existsSync(lockPath)) {
      throw new Error(actual === null
        ? 'Broker event head is missing.'
        : 'Broker event head verification failed.');
    }
  }
  const error = new Error('Broker event store changed during verification; retry the read.');
  error.name = 'LockBusy';
  throw error;
}

function verifyEventRecords(runtimeRoot) {
  const events = [];
  let previousEventHash = null;
  for (const [index, path] of recordFiles(runtimeRoot).entries()) {
    const event = JSON.parse(readFileSync(path, 'utf8'));
    const expectedSequence = index + 1;
    validateStoredEvent(event, path, expectedSequence, previousEventHash);
    events.push(event);
    previousEventHash = event.eventId;
  }
  return { events, head: expectedHead(events) };
}

// A tail read verifies the newest `count` records: each record's own identity and
// payload hash, the links between them, and that the last one is exactly the
// committed head. It deliberately does NOT walk back to the genesis event.
//
// That is a weaker guarantee than verifyEventStore, and it is scoped to match it:
// the only caller is the peer-progress reader, whose data is explicitly unverified,
// TTL-bounded coordination state. Re-deriving the whole hash chain on every prompt
// to read unverified data is disproportionate, and it degrades linearly forever as
// the store grows. Anything that feeds the accepted-claim lane must keep using
// verifyEventStore, which still proves the chain from genesis.
export function verifyEventTail(inputOptions = {}) {
  if (!inputOptions.runtimeRoot) throw new Error('Broker event runtime root is required.');
  const root = resolve(inputOptions.runtimeRoot);
  const count = Number.isSafeInteger(inputOptions.count) && inputOptions.count > 0
    ? inputOptions.count
    : 512;
  const headPath = join(root, 'events', 'head.json');
  const lockPath = join(root, 'events', 'event-store.lock');
  const readHead = () => existsSync(headPath) ? readFileSync(headPath, 'utf8') : null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = readHead();
    const paths = recordFiles(root);
    if (paths.length === 0) {
      const after = readHead();
      if (before !== after) continue;
      if (after !== null) throw new Error('Broker event head verification failed.');
      return { events: [], head: expectedHead([]), tailOnly: true, truncated: false };
    }

    const startIndex = Math.max(0, paths.length - count);
    const events = [];
    // The record immediately before the tail anchors the first link. When the tail
    // starts at the genesis event there is nothing before it, so the anchor is null.
    let previousEventHash = null;
    if (startIndex > 0) {
      const anchor = JSON.parse(readFileSync(paths[startIndex - 1], 'utf8'));
      previousEventHash = anchor.eventId;
    }
    for (let index = startIndex; index < paths.length; index += 1) {
      const event = JSON.parse(readFileSync(paths[index], 'utf8'));
      validateStoredEvent(event, paths[index], index + 1, previousEventHash);
      events.push(event);
      previousEventHash = event.eventId;
    }

    const after = readHead();
    if (before !== after) continue;
    const actual = after === null ? null : JSON.parse(after);
    if (actual !== null && stableJson(actual) === stableJson(expectedHead(events))) {
      return {
        events,
        head: actual,
        tailOnly: true,
        truncated: startIndex > 0
      };
    }
    if (!existsSync(lockPath)) {
      throw new Error(actual === null
        ? 'Broker event head is missing.'
        : 'Broker event head verification failed.');
    }
  }
  const error = new Error('Broker event store changed during verification; retry the read.');
  error.name = 'LockBusy';
  throw error;
}

// Idempotency used to be answered by scanning every event, which made appending
// O(store size) and building a store quadratic. The index answers the same question
// from one sequential file. It is a derived cache, never a source of truth: it is
// rebuilt from the records whenever it is missing or inconsistent with the tip, so a
// deleted or stale index costs time, never correctness.
function indexPath(runtimeRoot) {
  return join(resolve(runtimeRoot), 'events', 'idempotency.jsonl');
}

function rebuildIdempotencyIndex(runtimeRoot) {
  const index = new Map();
  const lines = [];
  for (const path of recordFiles(runtimeRoot)) {
    const event = JSON.parse(readFileSync(path, 'utf8'));
    index.set(event.idempotencyKey, event.sequence);
    lines.push(stableJson({ idempotencyKey: event.idempotencyKey, sequence: event.sequence }));
  }
  atomicWrite(indexPath(runtimeRoot), lines.length > 0 ? lines.join('\n') + '\n' : '');
  return index;
}

function readIdempotencyIndex(runtimeRoot, expectedSequence) {
  const path = indexPath(runtimeRoot);
  if (!existsSync(path)) return rebuildIdempotencyIndex(runtimeRoot);
  const index = new Map();
  let highest = 0;
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line);
      if (!HASH.test(entry.idempotencyKey ?? '') || !Number.isSafeInteger(entry.sequence)) {
        return rebuildIdempotencyIndex(runtimeRoot);
      }
      index.set(entry.idempotencyKey, entry.sequence);
      if (entry.sequence > highest) highest = entry.sequence;
    }
  } catch {
    return rebuildIdempotencyIndex(runtimeRoot);
  }
  // The index must describe exactly the committed tip, or it is not trustworthy.
  if (highest !== expectedSequence) return rebuildIdempotencyIndex(runtimeRoot);
  return index;
}

function appendIdempotencyEntries(runtimeRoot, entries) {
  if (entries.length === 0) return;
  const path = indexPath(runtimeRoot);
  const payload = entries
    .map((entry) => stableJson({ idempotencyKey: entry.idempotencyKey, sequence: entry.sequence }))
    .join('\n') + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, payload, { encoding: 'utf8', flag: 'a' });
}

// Verifying the whole chain before every write is what made appends quadratic. The
// tip check proves the store's newest record is internally valid and is exactly what
// head.json commits to, which is what an append actually depends on. It does not
// re-prove the prefix; that is what verifyEventStore and event-verify are for, and
// repair still walks the full chain.
function verifyEventTip(runtimeRoot) {
  const tail = verifyEventTail({ runtimeRoot, count: 1 });
  return { head: tail.head, tip: tail.events.at(-1) ?? null };
}

export function planBrokerEvent(inputOptions = {}) {
  validateEventInput(inputOptions.event);
  return {
    schemaVersion: 1,
    mode: 'event-append',
    writesEnabled: false,
    eventType: inputOptions.event.eventType,
    idempotencyKey: inputOptions.event.idempotencyKey,
    subjectRef: inputOptions.event.subjectRef
  };
}

function buildEvent(input, sequence, previousEventHash, recordedAt) {
  const core = {
    schemaVersion: 1,
    idempotencyKey: input.idempotencyKey,
    sequence,
    eventType: input.eventType,
    occurredAt: new Date(input.occurredAt).toISOString(),
    recordedAt,
    provider: input.provider,
    scope: input.scope,
    taskKeyHash: input.taskKeyHash,
    threadKey: input.threadKey,
    sourceRefs: [...input.sourceRefs].sort(),
    subjectRef: input.subjectRef,
    replacesRef: input.replacesRef,
    evidenceRefs: [...input.evidenceRefs].sort(),
    confidence: input.confidence,
    freshness: input.freshness,
    sensitivity: input.sensitivity,
    redactionResult: input.redactionResult,
    approvalState: input.approvalState,
    payload: stableValue(input.payload),
    payloadHash: sha256(stableJson(input.payload)),
    previousEventHash
  };
  return { ...core, eventId: sha256(stableJson(core)) };
}

function writeEventRecord(root, event) {
  const name = `${String(event.sequence).padStart(12, '0')}-${event.eventId}.json`;
  writeJson(join(recordsRoot(root), name), event);
}

function readEventBySequence(root, sequence) {
  const prefix = String(sequence).padStart(12, '0');
  const match = recordFiles(root).find((path) => basename(path).startsWith(`${prefix}-`));
  return match ? JSON.parse(readFileSync(match, 'utf8')) : null;
}

export async function appendBrokerEvent(inputOptions = {}) {
  const [result] = await appendBrokerEvents({
    ...inputOptions,
    events: [inputOptions.event]
  });
  return result;
}

// Appending used to verify the entire chain per event, which made a backfill of N
// events cost O(N^2): at a store of 800 events one append already cost 329 ms.
// A batch verifies the tip once, links the whole batch, and publishes one head, so
// ingesting history becomes linear in the number of events rather than quadratic.
export async function appendBrokerEvents(inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true || !options.runtimeRoot) {
    throw new Error('Broker event append requires execute: true and runtimeRoot.');
  }
  const inputs = Array.isArray(options.events) ? options.events : [];
  if (inputs.length === 0) throw new Error('Broker event append requires at least one event.');
  for (const input of inputs) validateEventInput(input);

  const seen = new Set();
  for (const input of inputs) {
    if (seen.has(input.idempotencyKey)) {
      throw new Error('Broker event batch repeats an idempotency key.');
    }
    seen.add(input.idempotencyKey);
  }

  const root = resolve(options.runtimeRoot);
  return withLock(join(root, 'events', 'event-store.lock'), options, async () => {
    const { head } = verifyEventTip(root);
    const index = readIdempotencyIndex(root, head.sequence);

    const recordedAt = options.now
      ? new Date(options.now).toISOString()
      : new Date().toISOString();

    const results = [];
    const appended = [];
    let sequence = head.sequence;
    let previousEventHash = head.eventId;

    for (const input of inputs) {
      const existing = index.get(input.idempotencyKey);
      if (existing !== undefined) {
        const duplicate = readEventBySequence(root, existing);
        if (duplicate) {
          results.push({ ...duplicate, idempotentReplay: true });
          continue;
        }
        // The index named a record that is not there; the index is a cache, so
        // rebuild rather than trusting it, and fail closed if it still disagrees.
        const rebuilt = rebuildIdempotencyIndex(root);
        const recovered = rebuilt.get(input.idempotencyKey);
        if (recovered !== undefined) {
          const event = readEventBySequence(root, recovered);
          if (event) {
            results.push({ ...event, idempotentReplay: true });
            continue;
          }
          throw new Error('Broker event idempotency index is inconsistent.');
        }
      }
      sequence += 1;
      const event = buildEvent(input, sequence, previousEventHash, recordedAt);
      writeEventRecord(root, event);
      appended.push(event);
      previousEventHash = event.eventId;
      results.push({ ...event, idempotentReplay: false });
    }

    if (appended.length > 0) {
      // One head publication for the whole batch: the head only ever describes the
      // newest event, so a batch and a sequence of single appends commit the same tip.
      writeJson(join(root, 'events', 'head.json'), expectedHead(appended));
      appendIdempotencyEntries(root, appended);
    }
    return results;
  });
}

export async function repairEventHead(inputOptions = {}) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true || !options.runtimeRoot) {
    throw new Error('Broker event repair requires execute: true and runtimeRoot.');
  }
  const root = resolve(options.runtimeRoot);
  return withLock(join(root, 'events', 'event-store.lock'), options, async () => {
    const paths = recordFiles(root);
    const headPath = join(root, 'events', 'head.json');
    const existing = existsSync(headPath) ? readFileSync(headPath, 'utf8') : null;
    if (existsSync(headPath)) unlinkSync(headPath);
    try {
      const events = [];
      let previousEventHash = null;
      for (const [index, path] of paths.entries()) {
        const event = JSON.parse(readFileSync(path, 'utf8'));
        validateStoredEvent(event, path, index + 1, previousEventHash);
        events.push(event);
        previousEventHash = event.eventId;
      }
      const head = expectedHead(events);
      if (events.length > 0) writeJson(headPath, head);
      // Repair is the operation that makes the store self-consistent, so the derived
      // idempotency index is rebuilt here rather than left to drift.
      rebuildIdempotencyIndex(root);
      return { repaired: true, head, eventCount: events.length };
    } catch (error) {
      if (existing !== null) atomicWrite(headPath, existing);
      throw error;
    }
  });
}
