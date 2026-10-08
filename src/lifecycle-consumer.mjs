import { prepareEmergency, emergencyUse, emergencyAdvisory } from './emergency.mts';
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
  observedAtFor,
  persistLifecycleOutbox,
  sourceAttestation
} from './lifecycle-events.mts';
import { realpathSync as resolvePhysicalPath } from 'node:fs';

import { verifyEventTail } from './event-store.mjs';
import { acceptedTicketKeysForProvider, scopeRelation } from './context-query.mjs';
import { createContextTrace, persistQueryInjection, traceCounts, traceLayers } from './context-trace.mts';
import { peerTicketKeysForProvider, readPeerProgress } from './peer-progress.mjs';
import { reviewLedgerContext, ticketPackageContext } from './work-ledgers.mts';
import { loadProviderPolicy, policyEntry, scopeReadable } from './provider-policy.mjs';
import {
  planSourceAttestation,
  provenanceForSourceToken
} from './source-attestation.mts';

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

function acceptedSnapshots(path, relationKeys, readable = () => true) {
  if (!path || !existsSync(path)) return [];
  const registry = JSON.parse(readFileSync(path, 'utf8'));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.snapshots)) {
    throw new Error('Unsupported accepted snapshot registry.');
  }
  const relations = new Set(relationKeys);
  return registry.snapshots
    .filter((snapshot) => snapshot?.state === 'clean')
    .filter((snapshot) => snapshot.relationKeys?.some((key) => relations.has(key)))
    .filter((snapshot) => readable(snapshot.scope))
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

export function branchTicketScope(cwd) {
  // The branch name is the most reliable work signal on a per-ticket-worktree machine,
  // and it is already captured as a hashed relation. Derive scope from it when the
  // prompt is silent or ambiguous. Never throws: scope derivation is best-effort.
  try {
    const start = typeof cwd === 'string' && cwd.trim() ? resolve(cwd) : null;
    if (!start) return null;
    let directory = start;
    for (let depth = 0; depth < 24; depth += 1) {
      const gitPath = join(directory, '.git');
      if (existsSync(gitPath)) {
        let gitDirectory = gitPath;
        if (statSync(gitPath).isFile()) {
          // worktree or submodule: .git is a file containing "gitdir: <path>"
          const pointer = readFileSync(gitPath, 'utf8').slice(0, 1024).trim();
          const target = /^gitdir:\s*(?<path>.+)$/u.exec(pointer);
          if (!target) return null;
          gitDirectory = resolve(directory, target.groups.path.trim());
        }
        const headPath = join(gitDirectory, 'HEAD');
        if (!existsSync(headPath)) return null;
        const head = readFileSync(headPath, 'utf8').slice(0, 512).trim();
        const ref = /^ref:\s*refs\/heads\/(?<branch>.+)$/u.exec(head);
        if (!ref) return null;
        // A branch naming two different tickets is as ambiguous as a prompt naming two.
        // Taking the first match would let an ambiguous prompt fall back to an equally
        // ambiguous branch and inject context for the wrong task, so exactly one distinct
        // ticket is required; the same ticket repeated is fine.
        // Project keys are letters. Allowing digits in the key made `utf-8`, `sha-256` and
        // `v2-3` look like tickets and pre-empt the project-scope fallback. Common
        // technical tokens that are letters-then-number are excluded explicitly, and an
        // installation can pin the accepted project keys outright.
        const allowed = (process.env.AGENT_CONTEXT_BROKER_TICKET_PROJECTS ?? '')
          .split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
        const denied = new Set(['UTF', 'SHA', 'MD', 'CRC', 'ISO', 'RFC', 'HTTP', 'TLS', 'SSL',
          'IPV', 'ES', 'PY', 'GO', 'V', 'X', 'UTC', 'GMT', 'AES', 'RSA', 'HMAC', 'CVE']);
        const keys = new Set();
        for (const match of ref.groups.branch.toUpperCase()
          .matchAll(/(?<![A-Z0-9])(?<project>[A-Z]{2,10})-(?<number>\d{1,9})(?![A-Z0-9])/gu)) {
          const project = match.groups.project;
          if (allowed.length > 0 ? !allowed.includes(project) : denied.has(project)) continue;
          keys.add(`${project}-${match.groups.number}`);
        }
        return keys.size === 1 ? { kind: 'ticket', key: [...keys][0] } : null;
      }
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return null;
  } catch {
    return null;
  }
}

/** @param {any} event @param {any} options @param {any} state
 * @param {import('./context-trace.mts').ContextTrace} trace
 */
function safeScopeFromHookEvent(event, options, state, trace) {
  const defaultProjectKey = options.defaultProjectKey;
  const prompt = typeof event?.prompt === 'string' && event.prompt.length <= MAX_HOOK_PROMPT_LENGTH
    ? event.prompt
    : '';
  const branchScope = branchTicketScope(event?.cwd);
  const fallback = () => branchScope ?? (defaultProjectKey && prompt.trim()
    ? { kind: 'project', key: defaultProjectKey } : null);
  const attempt = (/** @type {() => any} */ read) => {
    try { return read(); } catch { return null; }
  };
  let acceptedTickets;
  let peerTickets;
  const hasEvidence = (/** @type {{kind: string, key: string}} */ scope) => {
    const relationKey = scopeRelation(scope.kind, scope.key);
    if (Array.isArray(state.routedScopes) && state.routedScopes.includes(relationKey)) return true;
    if (scope.kind === 'merge-request') {
      return Boolean(attempt(() => reviewLedgerContext(options.reviewLedgersRoot, scope.key)));
    }
    if (branchScope?.key === scope.key ||
        attempt(() => ticketPackageContext(options.ticketPackagesRoot, scope.key))) return true;
    acceptedTickets ??= attempt(() => acceptedTicketKeysForProvider(
      options.acceptedSnapshots, options.provider, options.now)) ?? new Set();
    if (acceptedTickets.has(scope.key)) return true;
    peerTickets ??= attempt(() => peerTicketKeysForProvider(
      options.contextRuntimeRoot, options.eventRuntimeRoot, options.provider)) ?? new Set();
    return peerTickets.has(scope.key);
  };
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
  const issueKeys = [...new Set(
    [...prompt.matchAll(/\b[A-Z][A-Z0-9]{1,15}-\d+\b/gu)].map((match) => match[0].toUpperCase())
  )];
  const candidates = [
    ...[...reviewKeys].map(key => ({ kind: 'merge-request', key })),
    ...issueKeys.map(key => ({ kind: 'ticket', key }))
  ];
  const evidenced = candidates.filter(scope => {
    if (hasEvidence(scope)) return true;
    trace.suggestedScopes.push({ kind: /** @type {'ticket' | 'merge-request'} */ (scope.kind),
      keyHash: hash(scope.key.toLowerCase()), reason: 'no-local-evidence' });
    return false;
  });
  if (evidenced.length === 1) return evidenced[0];
  if (candidates.length > 1) return branchScope;
  if (candidates.length) return fallback();

  const workstreamKeys = [...new Set(
    [...prompt.matchAll(/\bworkstream(?:\s+|:\s*)([A-Za-z0-9](?:[A-Za-z0-9._:/!-]{0,126}[A-Za-z0-9])?)/giu)]
      .map((match) => match[1])
  )];
  if (workstreamKeys.length === 1) return { kind: 'workstream', key: workstreamKeys[0] };
  if (workstreamKeys.length > 1) return branchTicketScope(event?.cwd);

  if (branchScope) return branchScope;
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

/** @param {any} event @param {any} options @param {import('./context-trace.mts').ContextTrace} trace @param {any} state */
function naturalPeerProgress(event, options, trace, state) {
  if (event?.hook_event_name !== 'UserPromptSubmit') return null;
  const scope = safeScopeFromHookEvent(event, options, state, trace);
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
      ambientProjectKey: options.defaultProjectKey ?? null,
      providerPolicy: options.providerPolicy ?? null,
      decisionTrace: trace,
      terms: safeTermsFromHookEvent(event),
      now: options.now,
      maxProgress: 3
    })
  };
}

/** Only ticket and review routes established by evidence reach this point.
 * @param {any} state @param {any} natural @param {any} options
 */
function routedScopes(state, natural, options) {
  const scopes = new Set(Array.isArray(state.routedScopes) ? state.routedScopes : []);
  const scope = natural?.scope;
  if (scope && ['ticket', 'merge-request'].includes(scope.kind)) {
    scopes.delete(scopeRelation(scope.kind, scope.key));
    scopes.add(scopeRelation(scope.kind, scope.key));
  }
  return [...scopes].slice(-options.stateLimit);
}

function freshNaturalPeerProgress(natural, state) {
  if (!natural) return null;
  const delivered = new Set(state.deliveredPeerProgressIds ?? []);
  return {
    ...natural,
    decisions: natural.decisions.map((/** @type {import('./context-trace.mts').PeerDecision} */ item) => item.decision === 'included' && delivered.has(item.progressId)
      ? { ...item, decision: 'excluded', reason: 'already-delivered' } : item),
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

// Which store this hook actually read, by resolved path and head hash. The same pathname
// has resolved to different directories from different processes on one machine, and the
// audit trail was the one place that could have said which store the hooks saw - it
// recorded neither. A tail read is cheap; a failure to read is itself recorded, never
// thrown, because audit must not take context availability down with it.
function storeIdentity(options) {
  if (!options.eventRuntimeRoot) return null;
  const identity = { lexicalEventRoot: options.eventRuntimeRoot, resolvedEventRoot: null, headHash: null, eventCount: null };
  try { identity.resolvedEventRoot = resolvePhysicalPath.native ? resolvePhysicalPath.native(options.eventRuntimeRoot) : resolvePhysicalPath(options.eventRuntimeRoot); } catch { /* recorded as null */ }
  try {
    const tail = verifyEventTail({ runtimeRoot: options.eventRuntimeRoot, count: 1 });
    identity.headHash = tail.head.headHash ?? null;
    identity.eventCount = tail.head.sequence ?? null;
  } catch (error) {
    identity.error = error?.name ?? 'Error';
  }
  return identity;
}

function appendAudit(options, record) {
  try {
    const directory = join(options.runtimeRoot, 'audit');
    const timestamp = options.now.toISOString().replaceAll(':', '').replaceAll('.', '');
    atomicWrite(
      join(directory, `${timestamp}-${randomUUID()}.json`),
      `${JSON.stringify({ ...record, store: storeIdentity(options) })}\n`
    );
  } catch {
    // Context availability remains advisory when private audit storage is unavailable.
  }
}

/** @param {any} options @param {string} eventName @param {string} advisory
 * @param {import('./context-trace.mts').ContextTrace} trace @param {any} natural @param {string | null} threadRef */
function persistInjection(options, eventName, advisory, trace, natural, threadRef) {
  if (natural) {
    trace.peerProgress = natural.decisions;
  }
  trace.budget.renderedContextBytes = Buffer.byteLength(advisory, 'utf8');
  trace.layers = traceLayers(trace);
  try { emergencyUse(options, options.emergency, 'refresh', { trace, context: advisory, routeReason: 'lifecycle-advisory' }); }
  catch (error) {
    options.emergency.warnings.push('emergency-ledger-append-failed');
    if (error instanceof Error && error.message === 'emergency-ledger-invalid') options.emergency.warnings.push('emergency-ledger-invalid');
  }
  const injection = persistQueryInjection(options.globalAuditDirectory, {
    generatedAt: options.now.toISOString(),
    provider: options.provider,
    profile: null,
    routeReason: 'lifecycle-advisory',
    ...(threadRef ? { threadRef } : {}),
    eventName,
    payload: advisory,
    trace
  });
  // Keep lifecycle operational audit separate; this sibling is the shared query ledger.
  atomicWrite(
    join(options.globalAuditDirectory, basename(injection.artifact)),
    `${JSON.stringify({ schemaVersion: 1, auditId: injection.auditId,
      generatedAt: options.now.toISOString(), provider: options.provider, eventName,
      profile: null, routeReason: 'lifecycle-advisory',
      ...(threadRef ? { threadRefHash: hash(threadRef) } : {}),
      contextDigest: injection.digest, traceCounts: traceCounts(trace) })}\n`
  );
  return injection;
}

async function importAdapter(root, moduleName) {
  // Adapters are named by their installed .mjs file. A source checkout may hold the TypeScript source instead
  // (the package build strips it to that .mjs), so only there the .mts twin stands in.
  const installed = join(root, 'src', moduleName);
  const source = moduleName.endsWith('.mjs') ? `${installed.slice(0, -'.mjs'.length)}.mts` : null;
  const path = existsSync(installed) ? installed : source && existsSync(source) ? source : null;
  if (!path) throw new Error('Agent Context Broker adapter is unavailable.');
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

  /** @param {any} inputOptions */
  function optionsFor(inputOptions = {}) {
    const runtimeRoot = resolve(inputOptions.runtimeRoot ?? definition.runtimeRoot);
    const eventRuntimeRoot = resolve(
      inputOptions.eventRuntimeRoot ??
      definition.eventRuntimeRoot ??
      join(runtimeRoot, '..', 'events')
    );
    return {
      provider: definition.provider,
      runtimeHome: inputOptions.runtimeHome,
      runtimeRoot,
      eventRuntimeRoot,
      globalAuditDirectory: resolve(inputOptions.globalAuditDirectory ??
        (inputOptions.eventRuntimeRoot ? join(eventRuntimeRoot, '..', 'query-audit') : definition.globalAuditDirectory) ??
        join(eventRuntimeRoot, '..', 'query-audit')),
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
      tailBootstrapBytes: inputOptions.tailBootstrapBytes ?? 1024 * 1024,
      providerPolicyPath: inputOptions.providerPolicyPath ?? definition.providerPolicyPath ?? null,
      providerPolicy: inputOptions.providerPolicy ?? null
    };
  }

  async function handleHookEvent(event, inputOptions = {}) {
    if (inputOptions.strictIsolation === true || process.env.AGENT_CONTEXT_BROKER_STRICT_ISOLATION === '1' || definition.strictIsolation?.() === true) {
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
    if (!options.providerPolicy && options.providerPolicyPath) {
      try {
        options.providerPolicy = loadProviderPolicy({ providerPolicyPath: options.providerPolicyPath });
      } catch {
        // A present but unreadable policy withholds context rather than widening access.
        appendAudit(options, { ...auditBase, outcome: 'provider-policy-invalid', durationMs: Date.now() - startedAt });
        return { continue: true };
      }
    }
    const prepared = prepareEmergency({ ...options, runtimeRoots: [options.contextRuntimeRoot, options.eventRuntimeRoot], execute: true });
    options.providerPolicy = prepared.providerPolicy;
    /** @type {any} */ (options).emergency = prepared.emergency;
    const emergency = /** @type {any} */ (options).emergency;
    let returnSummary = '';
    if (eventName === 'SessionStart' && definition.provider === 'claude-code') {
      try { returnSummary = emergencyAdvisory(options); }
      catch { emergency.warnings.push(emergency.valid ? 'emergency-ledger-append-failed' : 'emergency-ledger-invalid'); }
    }
    const policyRule = policyEntry(options.providerPolicy, definition.provider);
    if (policyRule?.strictIsolation) return { continue: true, ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}),
      ...(returnSummary ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: returnSummary } } : {}) };
    if (policyRule && policyRule.defaultProject !== undefined) options.defaultProjectKey = policyRule.defaultProject;
    const trace = createContextTrace({ maxSnapshots: 0, maxClaims: 0, maxContextBytes: 0 });
    trace.lifecycle = { advisoryReferences: 0, claimsInjected: 0 };
    const snapshotReadable = (scope) => {
      const readable = !policyRule?.read || scopeReadable(policyRule, scope);
      if (!readable && scope?.kind && scope?.key) {
        const relationKey = scopeRelation(scope.kind, scope.key);
        if (!trace.policy.some(item => item.relationKey === relationKey)) {
          trace.policy.push({ relationKey, reason: 'scope-denied' });
        }
      }
      return readable;
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
        ? naturalPeerProgress(event, options, trace, loadState(statePath))
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
                // Must match the observed time the outbox attests with, or the planned
                // token and the delivered attestation hash differently and the advisory
                // silently drops its source token.
                observedAtFor(currentSource, inventoryResult.inventory.generatedAt)
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
        const auditThreadRef = threadRef ?? state.threadRef ?? null;

        if (!definition.advisoryEvents.has(eventName)) {
          appendAudit(options, {
            ...auditBase,
            sessionKey,
            outcome: 'observed',
            sourceTokenState,
            durationMs: Date.now() - startedAt
          });
          return { continue: true, ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}),
            ...(returnSummary ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: returnSummary } } : {}) };
        }

        const related = await adapter.readRelatedDeltas({
          source: transcriptPath,
          ledgerDir: ledgerDirectory,
          afterSequence: state.watermark,
          now: options.now
        });
        const delivered = new Set(state.deliveredDeltaIds ?? []);
        const freshDeltas = related.deltas.filter((delta) => !delivered.has(delta.deltaId));
        for (const relationKey of identity.relationKeys) {
          if (!trace.scopes.some(item => item.relationKey === relationKey)) {
            trace.scopes.push({ relationKey, role: 'lifecycle' });
          }
        }
        const snapshots = acceptedSnapshots(options.acceptedSnapshots, identity.relationKeys, snapshotReadable);
        const priorSnapshots = new Set(state.acceptedSnapshotDigests ?? []);
        const freshSnapshots = snapshots.filter((snapshot) => !priorSnapshots.has(snapshot.digest));
        trace.lifecycle = { advisoryReferences: freshSnapshots.flatMap((/** @type {any} */ item) => item.canonicalRefs).slice(0, 3).length,
          claimsInjected: 0 };
        const freshSourceToken = state.sourceToken === sourceToken ? null : sourceToken;
        const lifecycleAdvisory = advisoryFor(
          freshDeltas,
          freshSnapshots,
          freshSourceToken,
          threadRef
        );
        const peerAdvisory = naturalPeerProgressAdvisory(freshNatural);
        const advisory = [returnSummary, peerAdvisory, lifecycleAdvisory].filter(Boolean).join('\n\n') || null;
        const nextState = {
          schemaVersion: 1,
          sessionKey,
          routedScopes: routedScopes(state, freshNatural, options),
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
          threadRef: auditThreadRef,
          lastEventName: eventName,
          updatedAt: options.now.toISOString()
        };
        const injection = advisory || eventName === 'UserPromptSubmit'
          ? persistInjection(options, eventName, advisory ?? '', trace, freshNatural, auditThreadRef) : null;
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
          ? { ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}), hookSpecificOutput: { hookEventName: eventName, additionalContext: advisory } }
          : { continue: true, ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}) };
      });
    } catch (error) {
      const classified = errorClass(error);
      if (classified === 'TranscriptUnavailable' && sessionKey && statePath &&
          (natural || trace.suggestedScopes.length > 0)) {
        try {
          return await withLock(`${statePath}.lock`, options, async () => {
            const state = loadState(statePath);
            const freshNatural = freshNaturalPeerProgress(natural, state);
            const advisory = [returnSummary, naturalPeerProgressAdvisory(freshNatural)].filter(Boolean).join('\n');
            const nextState = {
              ...state,
              schemaVersion: 1,
              sessionKey,
              routedScopes: routedScopes(state, freshNatural, options),
              deliveredPeerProgressIds: [
                ...(state.deliveredPeerProgressIds ?? []),
                ...(freshNatural?.progress ?? []).map((item) => item.progressId)
              ].slice(-options.stateLimit),
              lastEventName: eventName,
              updatedAt: options.now.toISOString()
            };
            const injection = persistInjection(options, eventName, advisory ?? '', trace, freshNatural, state.threadRef ?? null);
            atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
            appendAudit(options, {
              ...auditBase,
              sessionKey,
              outcome: advisory ? 'context-partial' : 'no-change',
              errorClass: classified,
              peerProgressCount: freshNatural?.progress.length ?? 0,
              peerProgressDigests: (freshNatural?.progress ?? []).map((item) => item.progressId),
              peerScopeKind: freshNatural?.scope.kind ?? null,
              peerScopeKeyHash: freshNatural ? hash(freshNatural.scope.key) : null,
              injectionDigest: injection.digest,
              injectionArtifact: injection.artifact,
              durationMs: Date.now() - startedAt
            });
            return advisory ? { ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}), hookSpecificOutput: { hookEventName: eventName, additionalContext: advisory } }
              : { continue: true, ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}) };
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
      return { continue: true, ...(emergency.warnings.length ? { warnings: emergency.warnings } : {}),
        ...(returnSummary ? { hookSpecificOutput: { hookEventName: eventName, additionalContext: returnSummary } } : {}) };
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
