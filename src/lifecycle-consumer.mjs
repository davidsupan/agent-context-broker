import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  deliverLifecycleOutbox,
  persistLifecycleOutbox,
  sourceAttestation
} from './lifecycle-events.mjs';
import { readPeerProgress } from './peer-progress.mjs';
import {
  planSourceAttestation,
  provenanceForSourceToken
} from './source-attestation.mjs';

const SAFE_REFERENCE = /^(?:https|context|confluence|jira|repo):\/\/[^\s]{1,500}$/u;
const DEFAULT_STATE_LIMIT = 256;
const MAX_HOOK_PROMPT_LENGTH = 32768;

function hash(value) {
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

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
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
        if (Date.now() - statSync(path).mtimeMs > options.lockStaleMs) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= options.lockTimeoutMs) {
        throw new Error('Lifecycle state is busy.');
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

function isWithin(path, root) {
  const normalizedPath = normalize(path);
  const normalizedRoot = normalize(root).replace(/[\\/]+$/u, '');
  return normalizedPath.toLowerCase() === normalizedRoot.toLowerCase() ||
    normalizedPath.toLowerCase().startsWith(`${normalizedRoot}${sep}`.toLowerCase());
}

function normalizeWindowsDevicePath(path) {
  if (process.platform !== 'win32' || !path.startsWith('\\\\?\\')) return path;
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  return path.slice(4);
}

function validateTranscriptPath(transcriptPath, options) {
  const filesystemPath = typeof transcriptPath === 'string'
    ? normalizeWindowsDevicePath(transcriptPath)
    : transcriptPath;
  if (typeof filesystemPath !== 'string' || !filesystemPath || !isAbsolute(filesystemPath)) {
    throw new Error('Transcript path is unavailable.');
  }
  if (!existsSync(filesystemPath) || !statSync(filesystemPath).isFile()) {
    throw new Error('Transcript path is unavailable.');
  }
  const realTranscript = realpathSync(filesystemPath);
  if (!realTranscript.toLowerCase().endsWith('.jsonl')) {
    throw new Error('Transcript source is not JSONL.');
  }
  if (!options.testMode) {
    const roots = options.allowedTranscriptRoots.map((root) => {
      const filesystemRoot = normalizeWindowsDevicePath(root);
      return existsSync(filesystemRoot) ? realpathSync(filesystemRoot) : resolve(filesystemRoot);
    });
    if (!roots.some((root) => isWithin(realTranscript, root))) {
      throw new Error('Transcript path is outside configured provider roots.');
    }
  }
  return realTranscript;
}

function loadState(path) {
  if (!existsSync(path)) {
    return {
      schemaVersion: 1,
      watermark: 0,
      deliveredDeltaIds: [],
      acceptedSnapshotDigests: []
    };
  }
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schemaVersion !== 1 || !Number.isSafeInteger(state.watermark)) {
    throw new Error('Unsupported lifecycle state.');
  }
  return state;
}

function acceptedSnapshots(path, relationKeys) {
  if (!path || !existsSync(path)) return [];
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) {
    throw new Error('Unsupported accepted snapshot registry.');
  }
  const relations = new Set(relationKeys);
  return registry.snapshots
    .filter((snapshot) => snapshot?.state === 'clean')
    .filter((snapshot) => snapshot.relationKeys?.some((key) => relations.has(key)))
    .map((snapshot) => ({
      snapshotId: String(snapshot.snapshotId ?? ''),
      digest: String(snapshot.digest ?? ''),
      canonicalRefs: Array.isArray(snapshot.canonicalRefs)
        ? snapshot.canonicalRefs.filter((reference) => SAFE_REFERENCE.test(reference)).slice(0, 3)
        : []
    }))
    .filter((snapshot) => snapshot.snapshotId && snapshot.digest && snapshot.canonicalRefs.length)
    .slice(0, 3);
}

function advisoryFor(deltas, snapshots, sourceToken, threadRef) {
  const completed = deltas.filter((delta) => delta.classification === 'candidate').length;
  const live = deltas.filter((delta) => delta.classification === 'unverified').length;
  const parts = [];
  if (completed) parts.push(`${completed} completed peer ${completed === 1 ? 'candidate' : 'candidates'} awaiting reconciliation`);
  if (live) parts.push(`${live} live peer metadata ${live === 1 ? 'update' : 'updates'}`);
  if (snapshots.length) {
    parts.push(`accepted context: ${snapshots.flatMap((item) => item.canonicalRefs).slice(0, 3).join(', ')}`);
  }
  if (sourceToken) parts.push(`source token: ${sourceToken}`);
  if (sourceToken && threadRef) parts.push(`thread ref: ${threadRef}`);
  if (!parts.length) return null;
  return `Context broker advisory: ${parts.join('; ')}. For context-aware work, invoke the installed broker integration, retrieve the narrowest accepted context profile, and publish bounded progress after material findings, blockers, validation changes, and final handoff. No raw peer conversation content was imported. Verify candidate state against canonical sources before acting.`;
}

function safeScopeFromHookEvent(event, defaultProjectKey = null) {
  const prompt = typeof event?.prompt === 'string' && event.prompt.length <= MAX_HOOK_PROMPT_LENGTH
    ? event.prompt
    : '';
  const reviewKeys = new Set();
  for (const match of prompt.matchAll(
    /https?:\/\/[^/\s]+\/(?<project>[A-Za-z0-9][A-Za-z0-9._/-]{0,95})\/-\/merge_requests\/(?<iid>\d{1,12})\b/giu
  )) {
    reviewKeys.add(`${match.groups.project}!${match.groups.iid}`);
  }
  for (const match of prompt.matchAll(
    /(?:^|[\s(])(?<project>[A-Za-z0-9][A-Za-z0-9._/-]{0,95})!(?<iid>\d{1,12})\b/gu
  )) {
    reviewKeys.add(`${match.groups.project}!${match.groups.iid}`);
  }
  if (reviewKeys.size === 1) return { kind: 'merge-request', key: [...reviewKeys][0] };
  if (reviewKeys.size > 1) return null;

  const issueKeys = [...new Set(
    [...prompt.matchAll(/\b[A-Z][A-Z0-9]{1,15}-\d+\b/gu)].map((match) => match[0].toUpperCase())
  )];
  if (issueKeys.length === 1) return { kind: 'ticket', key: issueKeys[0] };
  if (issueKeys.length > 1) return null;

  const workstreamKeys = [...new Set(
    [...prompt.matchAll(/\bworkstream(?:\s+|:\s*)([A-Za-z0-9](?:[A-Za-z0-9._:/!-]{0,126}[A-Za-z0-9])?)/giu)]
      .map((match) => match[1])
  )];
  if (workstreamKeys.length === 1) return { kind: 'workstream', key: workstreamKeys[0] };
  if (workstreamKeys.length > 1) return null;

  const cwdMatch = /(?:^|[\\/])(?<project>[A-Z][A-Z0-9]{1,15})[-_](?<number>\d+)(?:[\\/]|$)/u
    .exec(String(event?.cwd ?? ''));
  if (cwdMatch) return { kind: 'ticket', key: `${cwdMatch.groups.project}-${cwdMatch.groups.number}` };
  if (defaultProjectKey && prompt.trim()) return { kind: 'project', key: defaultProjectKey };
  return null;
}

function safeTermsFromHookEvent(event) {
  const prompt = typeof event?.prompt === 'string' && event.prompt.length <= MAX_HOOK_PROMPT_LENGTH
    ? event.prompt
    : '';
  const ignored = new Set([
    'about', 'after', 'again', 'also', 'before', 'continue', 'from', 'have',
    'into', 'please', 'that', 'this', 'with', 'without', 'work'
  ]);
  return [...new Set(
    [...prompt.matchAll(/[A-Za-z0-9][A-Za-z0-9_-]{2,39}/gu)]
      .map((match) => match[0].toLowerCase())
      .filter((term) => !ignored.has(term))
  )].slice(0, 8);
}

function naturalPeerProgress(event, options) {
  if (event?.hook_event_name !== 'UserPromptSubmit') return null;
  const scope = safeScopeFromHookEvent(event, options.defaultProjectKey);
  if (!scope) return null;
  return {
    scope,
    ...readPeerProgress({
      runtimeRoot: options.contextRuntimeRoot,
      eventRuntimeRoot: options.eventRuntimeRoot,
      ticketPackagesRoot: options.ticketPackagesRoot,
      reviewLedgersRoot: options.reviewLedgersRoot,
      provider: options.provider,
      crossProvider: true,
      scopeKind: scope.kind,
      scopeKey: scope.key,
      terms: safeTermsFromHookEvent(event),
      now: options.now,
      maxProgress: 3
    })
  };
}

function freshNaturalPeerProgress(natural, state) {
  if (!natural) return null;
  const delivered = new Set(state.deliveredPeerProgressIds ?? []);
  return {
    ...natural,
    progress: natural.progress.filter((item) => !delivered.has(item.progressId))
  };
}

function compactText(value, maximum) {
  const text = String(value ?? '').replaceAll(/\s+/gu, ' ').trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 3)}...`;
}

function naturalPeerProgressAdvisory(natural) {
  if (!natural || natural.progress.length === 0) return null;
  const lines = [
    `Agent Context Broker scope: ${natural.scope.kind} ${natural.scope.key}.`,
    'Live peer progress (unverified; verify canonical sources before acting):'
  ];
  for (const item of natural.progress) {
    const conflict = item.conflicted ? ' CONFLICTED' : '';
    lines.push(`- ${item.work.kind} ${item.work.key}: ${item.state}/${item.stage}${conflict} [${item.provider}] progress:${item.progressId}`);
    lines.push(`  ${compactText(item.summary, 240)}`);
    if (item.changedSurfaces.length > 0) {
      lines.push(`  surfaces: ${item.changedSurfaces.slice(0, 3).map((value) => compactText(value, 100)).join('; ')}`);
    }
  }
  if (natural.warnings.length > 0) lines.push(`Warnings: ${natural.warnings.join(', ')}.`);
  lines.push('Accepted claims are separate from this live/unverified section.');
  lines.push('The installed broker integration provides deeper queries and semantic checkpoint publication for this task.');
  lines.push('No raw peer conversation content was imported.');
  return lines.join('\n');
}

function errorClass(error) {
  const message = String(error?.message ?? '');
  if (message.includes('busy')) return 'LockBusy';
  if (message.includes('Transcript') || message.includes('provider roots')) return 'TranscriptUnavailable';
  if (message.includes('Session identity')) return 'SessionIdentityUnavailable';
  if (message.includes('adapter') || error?.code === 'ERR_MODULE_NOT_FOUND') return 'AdapterUnavailable';
  if (message.includes('snapshot registry')) return 'SnapshotRegistryInvalid';
  if (message.includes('state')) return 'StateInvalid';
  if (['EACCES', 'EBUSY', 'EISDIR', 'ENOENT', 'EPERM'].includes(error?.code)) {
    return 'FilesystemUnavailable';
  }
  return error?.name || 'LifecycleBridgeError';
}

function appendAudit(options, record) {
  try {
    const directory = join(options.runtimeRoot, 'audit');
    const timestamp = options.now.toISOString().replaceAll(':', '').replaceAll('.', '');
    atomicWrite(
      join(directory, `${timestamp}-${randomUUID()}.json`),
      `${JSON.stringify(record)}\n`
    );
  } catch {
    // Context availability remains advisory when private audit storage is unavailable.
  }
}

function persistInjection(options, eventName, advisory) {
  const timestamp = options.now.toISOString().replaceAll(':', '').replaceAll('.', '');
  const name = `${timestamp}-${randomUUID()}.json`;
  const payload = {
    schemaVersion: 1,
    generatedAt: options.now.toISOString(),
    provider: options.provider,
    eventName,
    payload: advisory,
    digest: hash(advisory)
  };
  atomicWrite(
    join(options.runtimeRoot, 'injections', name),
    `${JSON.stringify(payload, null, 2)}\n`
  );
  return { artifact: `injections/${name}`, digest: payload.digest };
}

async function importAdapter(root, moduleName) {
  const path = join(root, 'src', moduleName);
  if (!existsSync(path)) throw new Error('Agent Context Broker adapter is unavailable.');
  return import(pathToFileURL(path).href);
}

function normalizeDefinition(definition) {
  if (!definition?.provider || !definition?.adapterModule || !definition?.runtimeRoot) {
    throw new Error('Lifecycle consumer definition is incomplete.');
  }
  return Object.freeze({
    ...definition,
    supportedEvents: new Set(definition.supportedEvents ?? []),
    advisoryEvents: new Set(definition.advisoryEvents ?? [])
  });
}

export function createLifecycleConsumer(inputDefinition) {
  const definition = normalizeDefinition(inputDefinition);

  function optionsFor(inputOptions = {}) {
    const runtimeRoot = resolve(inputOptions.runtimeRoot ?? definition.runtimeRoot);
    const eventRuntimeRoot = resolve(
      inputOptions.eventRuntimeRoot ??
      definition.eventRuntimeRoot ??
      join(runtimeRoot, '..', 'events')
    );
    return {
      provider: definition.provider,
      runtimeRoot,
      eventRuntimeRoot,
      adapterRoot: resolve(inputOptions.adapterRoot ?? definition.adapterRoot),
      acceptedSnapshots: inputOptions.acceptedSnapshots ??
        join(resolve(runtimeRoot, '..', 'reconciliation'), 'accepted-snapshots.json'),
      contextRuntimeRoot: resolve(
        inputOptions.contextRuntimeRoot ??
        definition.contextRuntimeRoot ??
        join(eventRuntimeRoot, '..', 'reconciliation')
      ),
      ticketPackagesRoot: resolve(
        inputOptions.ticketPackagesRoot ??
        definition.ticketPackagesRoot ??
        join(eventRuntimeRoot, '..', '..', '..', 'tickets')
      ),
      reviewLedgersRoot: resolve(
        inputOptions.reviewLedgersRoot ??
        definition.reviewLedgersRoot ??
        join(eventRuntimeRoot, '..', 'reviews')
      ),
      defaultProjectKey: inputOptions.defaultProjectKey ?? definition.defaultProjectKey ?? null,
      allowedTranscriptRoots: inputOptions.allowedTranscriptRoots ?? definition.allowedTranscriptRoots(),
      testMode: inputOptions.testMode === true,
      now: inputOptions.now ? new Date(inputOptions.now) : new Date(),
      lockTimeoutMs: inputOptions.lockTimeoutMs ?? 2000,
      lockRetryMs: inputOptions.lockRetryMs ?? 25,
      lockStaleMs: inputOptions.lockStaleMs ?? 300000,
      stateLimit: inputOptions.stateLimit ?? DEFAULT_STATE_LIMIT,
      maxScanBytes: inputOptions.maxScanBytes ?? 16 * 1024 * 1024,
      tailBootstrapBytes: inputOptions.tailBootstrapBytes ?? 1024 * 1024
    };
  }

  async function handleHookEvent(event, inputOptions = {}) {
    if (inputOptions.strictIsolation === true || definition.strictIsolation?.() === true) {
      return { continue: true };
    }
    const options = optionsFor(inputOptions);
    const startedAt = Date.now();
    const eventName = typeof event?.hook_event_name === 'string' ? event.hook_event_name : 'unknown';
    const auditBase = {
      schemaVersion: 1,
      timestamp: options.now.toISOString(),
      provider: definition.provider,
      eventName,
      mode: 'advisory'
    };
    if (!definition.supportedEvents.has(eventName)) {
      appendAudit(options, { ...auditBase, outcome: 'ignored', durationMs: Date.now() - startedAt });
      return { continue: true };
    }

    let sessionKey = null;
    let statePath = null;
    let natural = null;
    try {
      if (typeof event?.session_id !== 'string' || !event.session_id) {
        throw new Error('Session identity is unavailable.');
      }
      sessionKey = hash(`${definition.provider}-consumer:${event.session_id}`);
      statePath = join(options.runtimeRoot, 'state', `${sessionKey}.json`);
      natural = definition.advisoryEvents.has(eventName)
        ? naturalPeerProgress(event, options)
        : null;
      const transcriptPath = validateTranscriptPath(event.transcript_path, options);

      return await withLock(`${statePath}.lock`, options, async () => {
        const state = loadState(statePath);
        const freshNatural = freshNaturalPeerProgress(natural, state);
        await deliverLifecycleOutbox({
          lifecycleRuntimeRoot: options.runtimeRoot,
          eventRuntimeRoot: options.eventRuntimeRoot,
          atomicWriter: atomicWrite
        });
        const adapter = await importAdapter(options.adapterRoot, definition.adapterModule);
        const currentDirectory = join(options.runtimeRoot, 'current', sessionKey);
        const ledgerDirectory = join(options.runtimeRoot, 'ledger');
        const identity = await adapter.readSourceIdentity(transcriptPath);
        const inventoryResult = await adapter.runInventory({
          source: transcriptPath,
          output: join(currentDirectory, 'inventory.json'),
          deltas: join(currentDirectory, 'deltas.jsonl'),
          checkpoint: join(options.runtimeRoot, 'checkpoint.json'),
          ledgerDir: ledgerDirectory,
          maxFiles: 1,
          maxScanBytes: options.maxScanBytes,
          tailBootstrapBytes: options.tailBootstrapBytes,
          lifecycleOverride: definition.lifecycleForEvent?.(eventName) ?? null,
          now: options.now,
          beforeCheckpoint: ({ inventory, deltas }) => persistLifecycleOutbox({
            lifecycleRuntimeRoot: options.runtimeRoot,
            inventory,
            deltas,
            atomicWriter: atomicWrite
          })
        });
        const delivery = await deliverLifecycleOutbox({
          lifecycleRuntimeRoot: options.runtimeRoot,
          eventRuntimeRoot: options.eventRuntimeRoot,
          atomicWriter: atomicWrite
        });

        const currentSource = inventoryResult.inventory.sources.find(
          (source) => source.sourceId === identity.sourceId
        );
        const sourcePlan = currentSource
          ? planSourceAttestation({
              attestation: sourceAttestation(
                definition.provider,
                currentSource,
                inventoryResult.inventory.generatedAt
              )
            })
          : null;
        const plannedSourceToken = sourcePlan?.subjectRef ?? null;
        let sourceToken = null;
        let sourceTokenState = plannedSourceToken ? 'suppressed-unattested' : 'unavailable';
        if (plannedSourceToken && delivery.attestedSubjectRefs.includes(plannedSourceToken)) {
          sourceToken = plannedSourceToken;
          sourceTokenState = 'confirmed-delivery';
        }
        else if (plannedSourceToken) {
          try {
            provenanceForSourceToken({
              runtimeRoot: options.eventRuntimeRoot,
              sourceToken: plannedSourceToken
            });
            sourceToken = plannedSourceToken;
            sourceTokenState = 'confirmed-store';
          } catch {
            sourceToken = null;
          }
        }
        const threadRef = sourceToken ? sourcePlan.threadRef : null;

        if (!definition.advisoryEvents.has(eventName)) {
          appendAudit(options, {
            ...auditBase,
            sessionKey,
            outcome: 'observed',
            sourceTokenState,
            durationMs: Date.now() - startedAt
          });
          return { continue: true };
        }

        const related = await adapter.readRelatedDeltas({
          source: transcriptPath,
          ledgerDir: ledgerDirectory,
          afterSequence: state.watermark,
          now: options.now
        });
        const delivered = new Set(state.deliveredDeltaIds ?? []);
        const freshDeltas = related.deltas.filter((delta) => !delivered.has(delta.deltaId));
        const snapshots = acceptedSnapshots(options.acceptedSnapshots, identity.relationKeys);
        const priorSnapshots = new Set(state.acceptedSnapshotDigests ?? []);
        const freshSnapshots = snapshots.filter((snapshot) => !priorSnapshots.has(snapshot.digest));
        const freshSourceToken = state.sourceToken === sourceToken ? null : sourceToken;
        const lifecycleAdvisory = advisoryFor(
          freshDeltas,
          freshSnapshots,
          freshSourceToken,
          threadRef
        );
        const peerAdvisory = naturalPeerProgressAdvisory(freshNatural);
        const advisory = [peerAdvisory, lifecycleAdvisory].filter(Boolean).join('\n\n') || null;
        const nextState = {
          schemaVersion: 1,
          sessionKey,
          watermark: Math.max(state.watermark, related.watermark),
          deliveredDeltaIds: [
            ...(state.deliveredDeltaIds ?? []),
            ...freshDeltas.map((delta) => delta.deltaId)
          ].slice(-options.stateLimit),
          acceptedSnapshotDigests: [
            ...(state.acceptedSnapshotDigests ?? []),
            ...freshSnapshots.map((snapshot) => snapshot.digest)
          ].slice(-options.stateLimit),
          deliveredPeerProgressIds: [
            ...(state.deliveredPeerProgressIds ?? []),
            ...(freshNatural?.progress ?? []).map((item) => item.progressId)
          ].slice(-options.stateLimit),
          sourceToken,
          lastEventName: eventName,
          updatedAt: options.now.toISOString()
        };
        const injection = advisory ? persistInjection(options, eventName, advisory) : null;
        atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
        appendAudit(options, {
          ...auditBase,
          sessionKey,
          outcome: advisory ? 'context' : 'no-change',
          watermarkBefore: state.watermark,
          watermarkAfter: nextState.watermark,
          relatedCandidates: freshDeltas.filter((delta) => delta.classification === 'candidate').length,
          relatedLive: freshDeltas.filter((delta) => delta.classification === 'unverified').length,
          peerProgressCount: freshNatural?.progress.length ?? 0,
          peerProgressDigests: (freshNatural?.progress ?? []).map((item) => item.progressId),
          peerScopeKind: freshNatural?.scope.kind ?? null,
          peerScopeKeyHash: freshNatural ? hash(freshNatural.scope.key) : null,
          acceptedSnapshots: freshSnapshots.length,
          sourceTokenState,
          injectionDigest: injection?.digest ?? null,
          injectionArtifact: injection?.artifact ?? null,
          durationMs: Date.now() - startedAt
        });
        return advisory
          ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: advisory } }
          : { continue: true };
      });
    } catch (error) {
      const classified = errorClass(error);
      if (classified === 'TranscriptUnavailable' && sessionKey && statePath && natural) {
        try {
          return await withLock(`${statePath}.lock`, options, async () => {
            const state = loadState(statePath);
            const freshNatural = freshNaturalPeerProgress(natural, state);
            const advisory = naturalPeerProgressAdvisory(freshNatural);
            if (!advisory) throw error;
            const nextState = {
              ...state,
              schemaVersion: 1,
              sessionKey,
              deliveredPeerProgressIds: [
                ...(state.deliveredPeerProgressIds ?? []),
                ...freshNatural.progress.map((item) => item.progressId)
              ].slice(-options.stateLimit),
              lastEventName: eventName,
              updatedAt: options.now.toISOString()
            };
            const injection = persistInjection(options, eventName, advisory);
            atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
            appendAudit(options, {
              ...auditBase,
              sessionKey,
              outcome: 'context-partial',
              errorClass: classified,
              peerProgressCount: freshNatural.progress.length,
              peerProgressDigests: freshNatural.progress.map((item) => item.progressId),
              peerScopeKind: freshNatural.scope.kind,
              peerScopeKeyHash: hash(freshNatural.scope.key),
              injectionDigest: injection.digest,
              injectionArtifact: injection.artifact,
              durationMs: Date.now() - startedAt
            });
            return { hookSpecificOutput: { hookEventName: eventName, additionalContext: advisory } };
          });
        } catch (partialError) {
          error = partialError;
        }
      }
      appendAudit(options, {
        ...auditBase,
        sessionKey,
        outcome: 'fail-open',
        errorClass: errorClass(error),
        durationMs: Date.now() - startedAt
      });
      return { continue: true };
    }
  }

  function recordFailOpen(inputOptions = {}, failureClass = 'MalformedInput') {
    const options = optionsFor(inputOptions);
    appendAudit(options, {
      schemaVersion: 1,
      timestamp: options.now.toISOString(),
      provider: definition.provider,
      eventName: 'unknown',
      mode: 'advisory',
      outcome: 'fail-open',
      errorClass: failureClass,
      durationMs: 0
    });
    return { continue: true };
  }

  return Object.freeze({ handleHookEvent, recordFailOpen, runtimeDefaults: optionsFor });
}
