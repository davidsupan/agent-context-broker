import { evaluateEmergency, emergencyHome } from './emergency.mts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { sha256 } from './event-store.mjs';
import { defaultRuntimeHome } from './platform-paths.mjs';

// An optional, operator-owned file that narrows what each provider may read and publish.
// Without the file every provider keeps the behaviour of earlier releases. With it, the
// rules apply to the provider the broker itself identified (the hook bridge, or the
// provider bound to a source token); a provider named only on a command line is a
// declaration, not an authentication, so the policy is a guardrail and not a sandbox.

export const POLICY_FILE = 'provider-policy.json';
const policyContexts = new WeakMap();
const MAX_POLICY_BYTES = 64 * 1024;
const PROVIDERS = new Set(['codex', 'claude-code']);
const SCOPE_KINDS = ['global', 'project', 'workstream', 'ticket', 'merge-request'];
const SENSITIVITY_RANK = { shared: 0, private: 1, restricted: 2 };
const EVIDENCE_CLASSES = new Set(['canonical-artifact', 'observed-tool-result', 'agent-handoff']);
const PATTERN = /^(?:\*|global|project|workstream|ticket|merge-request):[^\s\0]{1,200}$/u;
const ENTRY_FIELDS = new Set(['strictIsolation', 'defaultProject', 'read', 'publish', 'sources', 'teamShared']);
const READ_FIELDS = new Set(['allow', 'deny']);
const PUBLISH_FIELDS = new Set(['allow', 'deny', 'maxSensitivity', 'evidenceClasses']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function invalid() {
  return new Error('Provider policy is invalid.');
}

function patterns(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256 ||
      value.some((item) => typeof item !== 'string' || !PATTERN.test(item))) throw invalid();
  return Object.freeze([...new Set(value)]);
}

function rules(value, fields) {
  if (value === undefined) return undefined;
  if (!isRecord(value) || Object.keys(value).some((key) => !fields.has(key))) throw invalid();
  const result = { allow: patterns(value.allow), deny: patterns(value.deny) };
  if (fields === PUBLISH_FIELDS) {
    if (value.maxSensitivity !== undefined && !(value.maxSensitivity in SENSITIVITY_RANK)) throw invalid();
    if (value.evidenceClasses !== undefined && (!Array.isArray(value.evidenceClasses) ||
        value.evidenceClasses.some((item) => !EVIDENCE_CLASSES.has(item)))) throw invalid();
    result.maxSensitivity = value.maxSensitivity;
    result.evidenceClasses = value.evidenceClasses ? Object.freeze([...new Set(value.evidenceClasses)]) : undefined;
  }
  return Object.freeze(result);
}

function entry(value) {
  if (!isRecord(value) || Object.keys(value).some((key) => !ENTRY_FIELDS.has(key))) throw invalid();
  if (value.teamShared !== undefined && (!isRecord(value.teamShared) ||
      Object.keys(value.teamShared).some((key) => key !== 'maxContextBytes') ||
      (value.teamShared.maxContextBytes !== undefined && (!Number.isSafeInteger(value.teamShared.maxContextBytes) ||
        value.teamShared.maxContextBytes < 0 || value.teamShared.maxContextBytes > 65536)))) throw invalid();
  if (value.sources !== undefined && (!isRecord(value.sources) ||
      Object.keys(value.sources).some((key) => key !== 'teamShared') ||
      (value.sources.teamShared !== undefined && !['allow', 'deny'].includes(value.sources.teamShared)))) throw invalid();
  if (value.strictIsolation !== undefined && typeof value.strictIsolation !== 'boolean') throw invalid();
  if (value.defaultProject !== undefined && value.defaultProject !== null &&
      (typeof value.defaultProject !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u.test(value.defaultProject))) {
    throw invalid();
  }
  return Object.freeze({
    strictIsolation: value.strictIsolation === true,
    sources: Object.freeze({ teamShared: value.sources?.teamShared ?? 'deny' }),
    teamShared: Object.freeze({ maxContextBytes: value.teamShared?.maxContextBytes ?? 2048 }),
    ...(value.defaultProject !== undefined ? { defaultProject: value.defaultProject } : {}),
    read: rules(value.read, READ_FIELDS),
    publish: rules(value.publish, PUBLISH_FIELDS)
  });
}

/** Strict parse of a policy document. Unknown fields, providers or patterns reject it. */
export function parseProviderPolicy(text) {
  let document;
  try { document = JSON.parse(text); } catch { throw invalid(); }
  if (!isRecord(document) || document.schemaVersion !== 1 ||
      Object.keys(document).some((key) => !['schemaVersion', 'providers'].includes(key)) ||
      !isRecord(document.providers) ||
      Object.keys(document.providers).some((key) => !PROVIDERS.has(key))) throw invalid();
  return Object.freeze({
    schemaVersion: 1,
    sha256: sha256(text),
    providers: Object.freeze(Object.fromEntries(
      Object.entries(document.providers).map(([provider, value]) => [provider, entry(value)])
    ))
  });
}

// A store in the standard layout lives at `<runtime home>/runtime/<store>`.
function storeHome(root) {
  const parent = dirname(root);
  return basename(parent).toLowerCase() === 'runtime' ? dirname(parent) : null;
}

/**
 * The policy file that governs a command, or null when none applies. The policy belongs to
 * the store a command works on: explicit `runtimeRoots` in the standard layout select their
 * runtime home, and explicit roots outside one standard home inherit no policy (an explicit
 * path or AGENT_CONTEXT_BROKER_PROVIDER_POLICY still applies). Without explicit roots the
 * default runtime home is used, as before.
 */
export function providerPolicyPath(options = {}) {
  if (options.providerPolicyPath) return resolve(options.providerPolicyPath);
  const env = options.env ?? process.env;
  if (env.AGENT_CONTEXT_BROKER_PROVIDER_POLICY?.trim()) return resolve(env.AGENT_CONTEXT_BROKER_PROVIDER_POLICY);
  if (options.runtimeHome) return join(options.runtimeHome, POLICY_FILE);
  const roots = (options.runtimeRoots ?? []).filter(Boolean).map((root) => resolve(root));
  if (roots.length) {
    const homes = new Set(roots.map(storeHome));
    if (homes.size !== 1 || homes.has(null)) return null;
    return join([...homes][0], POLICY_FILE);
  }
  return join(defaultRuntimeHome({ env }), POLICY_FILE);
}

/** Returns null when no policy file applies or exists; throws on a present but invalid file. */
export function loadProviderPolicy(options = {}) {
  const path = providerPolicyPath(options);
  if (path === null || !existsSync(path)) {
    const home = emergencyHome(options);
    if (!home || !existsSync(join(home, 'emergency', 'grants.jsonl'))) return null;
    const policy = Object.freeze({ schemaVersion: 1, sha256: null, providers: {}, path });
    policyContexts.set(policy, options);
    return policy;
  }
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_POLICY_BYTES) throw invalid();
  const policy = Object.freeze({ ...parseProviderPolicy(readFileSync(path, 'utf8')), path });
  policyContexts.set(policy, options);
  return policy;
}

/** @param {any} policy @param {string} provider */
export function policyEntry(policy, provider) {
  if (emergencyFor(policy, provider)?.grant?.provider === provider) return null;
  return policy?.providers?.[provider] ?? null;
}

/** @param {any} policy @param {string} provider */
function emergencyFor(policy, provider) {
  return policy?.emergency ?? (policyContexts.has(policy) ? evaluateEmergency({ ...policyContexts.get(policy), provider }) : null);
}

/** The shared source is opt-in even without a provider policy. Isolation always wins.
 * @param {ReturnType<typeof loadProviderPolicy>} policy @param {string} provider */
export function teamSharedReadable(policy, provider) {
  const rule = policyEntry(policy, provider);
  return emergencyFor(policy, provider)?.grant?.provider === provider ||
    (!rule?.strictIsolation && rule?.sources?.teamShared === 'allow');
}

function globMatch(pattern, value) {
  const expression = pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, '\\$&')).join('.*');
  return new RegExp(`^${expression}$`, 'iu').test(value);
}

function matches(list, scope) {
  return (list ?? []).some((pattern) => {
    const split = pattern.indexOf(':');
    const kind = pattern.slice(0, split);
    return (kind === '*' || kind === scope.kind) && globMatch(pattern.slice(split + 1), scope.key);
  });
}

function allowed(ruleSet, scope) {
  if (!ruleSet) return true;
  if (!scope || !SCOPE_KINDS.includes(scope.kind) || typeof scope.key !== 'string') return false;
  if (matches(ruleSet.deny, scope)) return false;
  return ruleSet.allow === undefined || matches(ruleSet.allow, scope);
}

/** True when the provider may read context recorded against this scope. */
export function scopeReadable(policyOrEntry, scope, provider) {
  const rule = provider ? policyEntry(policyOrEntry, provider) : policyOrEntry;
  return !rule || allowed(rule.read, scope);
}

/** True when read rules exist, so callers must not widen beyond the requested scope. */
export function readRestricted(policyOrEntry, provider) {
  const rule = provider ? policyEntry(policyOrEntry, provider) : policyOrEntry;
  return Boolean(rule?.read);
}

/** Throws when the provider may not publish the given claims or progress to the scope. */
export function assertPublishable(policy, provider, scope, items = []) {
  const rule = policyEntry(policy, provider);
  const failure = (/** @type {string} */ message) => Object.assign(new Error(message), { warnings: emergencyFor(policy, provider)?.warnings ?? [] });
  if (!rule) return;
  if (rule.strictIsolation) throw failure('Provider policy isolates this provider from publication.');
  if (!allowed(rule.publish, scope)) throw failure('Provider policy denies publication to this scope.');
  const max = rule.publish?.maxSensitivity;
  for (const item of items) {
    if (max && SENSITIVITY_RANK[item.sensitivity ?? 'shared'] > SENSITIVITY_RANK[max]) {
      throw failure('Provider policy denies publication at this sensitivity.');
    }
    if (rule.publish?.evidenceClasses && item.evidenceClass !== undefined &&
        !rule.publish.evidenceClasses.includes(item.evidenceClass)) {
      throw failure('Provider policy denies publication of this evidence class.');
    }
  }
}

/** Bounded summary for doctor output: no scope patterns beyond counts. */
export function describeProviderPolicy(policy) {
  if (!policy) return { state: 'absent' };
  return {
    state: 'loaded',
    sha256: policy.sha256,
    providers: Object.fromEntries(Object.entries(policy.providers).map(([provider, rule]) => [provider, {
      strictIsolation: rule.strictIsolation,
      sources: rule.sources,
      defaultProject: rule.defaultProject === undefined ? 'inherited' : rule.defaultProject === null ? 'none' : 'set',
      read: rule.read ? { allow: rule.read.allow?.length ?? 'all', deny: rule.read.deny?.length ?? 0 } : 'unrestricted',
      publish: rule.publish ? {
        allow: rule.publish.allow?.length ?? 'all', deny: rule.publish.deny?.length ?? 0,
        maxSensitivity: rule.publish.maxSensitivity ?? 'any', evidenceClasses: rule.publish.evidenceClasses?.length ?? 'any'
      } : 'unrestricted'
    }]))
  };
}
