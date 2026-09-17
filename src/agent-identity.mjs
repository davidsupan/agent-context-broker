// Describes the agent that produced a broker write.
//
// The broker already distinguishes actors: peer progress derives an actorKey from
// provider, session and work. What it could not say is *what* that actor is. With several
// Codex and Claude agents sharing one machine, a read returns `provider: "codex"` and an
// opaque hash, which is not enough to tell an interactive session from a subagent, or one
// concurrent run from another.
//
// This descriptor is deliberately weak. It is self-declared and unverified, so it is
// recorded as description and must never be read as authorization: nothing here may raise
// confidence, change acceptance, widen scope, or outrank another actor. An agent that
// could promote its own writes by naming itself would be a trust hole, not a feature.
//
// It is also kept non-prose. Every field is an enumerated value, a short safe token or a
// hash, so ingested payloads stay free of free text and the corpus audit keeps meaning
// what it says.
import { createHash } from 'node:crypto';

export const AGENT_KINDS = Object.freeze(new Set([
  // A human is in the loop, typing turns.
  'interactive',
  // An agent spawned by another agent. Its output is agent-authored by definition.
  'subagent',
  // Started by a timer or hook, with nobody watching.
  'scheduled',
  // Driven programmatically through an SDK or script.
  'sdk',
  'unknown'
]));

const FIELDS = Object.freeze(new Set(['kind', 'harness', 'harnessVersion', 'model', 'instanceId']));
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._@:+-]{0,63}$/u;
const HASH = /^[a-f0-9]{64}$/u;

function sha256(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function token(value, label, max) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length === 0) return null;
  if (text.length > max || !SAFE_TOKEN.test(text)) {
    throw new Error(`Agent descriptor ${label} is invalid.`);
  }
  return text;
}

/**
 * Validates a caller-supplied agent descriptor.
 *
 * Returns null when no descriptor is supplied, so every call site stays optional and
 * existing proposals keep working unchanged.
 */
export function normalizeAgentDescriptor(input) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Agent descriptor must be an object.');
  }
  for (const key of Object.keys(input)) {
    if (!FIELDS.has(key)) throw new Error(`Agent descriptor field "${key}" is not allowed.`);
  }
  const kind = input.kind === undefined || input.kind === null ? 'unknown' : String(input.kind);
  if (!AGENT_KINDS.has(kind)) throw new Error('Agent descriptor kind is invalid.');

  // The raw instance id never lands in the store. It can carry a pid, a path or a session
  // id, so it is hashed on the way in and only the hash is kept.
  const instanceId = input.instanceId === undefined || input.instanceId === null
    ? null
    : String(input.instanceId).trim();
  if (instanceId !== null && instanceId.length === 0) {
    throw new Error('Agent descriptor instanceId is invalid.');
  }
  if (instanceId !== null && instanceId.length > 512) {
    throw new Error('Agent descriptor instanceId is invalid.');
  }

  const descriptor = {
    kind,
    harness: token(input.harness, 'harness', 32),
    harnessVersion: token(input.harnessVersion, 'harnessVersion', 32),
    model: token(input.model, 'model', 64),
    instanceHash: instanceId === null ? null : sha256(`agent-instance:${instanceId}`),
    // Stated by the caller about itself, checked by nobody. Recorded so a reader is never
    // tempted to treat the rest of this object as established fact.
    attestation: 'self-declared'
  };
  return Object.freeze(descriptor);
}

/**
 * Confirms a descriptor read back from storage still has the shape this module writes,
 * so a hand-edited record cannot smuggle prose or extra fields into a payload.
 */
export function isStoredAgentDescriptor(value) {
  if (value === null || value === undefined) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set(['kind', 'harness', 'harnessVersion', 'model', 'instanceHash', 'attestation']);
  for (const key of Object.keys(value)) if (!allowed.has(key)) return false;
  if (!AGENT_KINDS.has(value.kind)) return false;
  if (value.attestation !== 'self-declared') return false;
  for (const key of ['harness', 'harnessVersion', 'model']) {
    const item = value[key];
    if (item === null || item === undefined) continue;
    if (typeof item !== 'string' || item.length > 64 || !SAFE_TOKEN.test(item)) return false;
  }
  if (value.instanceHash !== null && value.instanceHash !== undefined &&
      !HASH.test(value.instanceHash)) {
    return false;
  }
  return true;
}

/**
 * Derives a descriptor from the process environment so callers do not hand-author one.
 *
 * Everything here is a guess about the local runtime, which is another reason the result
 * is only ever descriptive.
 */
export function agentDescriptorFromEnvironment(env = process.env) {
  const claude = Boolean(env.CLAUDECODE || env.CLAUDE_CODE_ENTRYPOINT);
  const codex = Boolean(env.CODEX_HOME || env.CODEX_SANDBOX || env.CODEX_THREAD_ID);

  let kind = 'unknown';
  if (env.ACB_AGENT_KIND && AGENT_KINDS.has(env.ACB_AGENT_KIND)) kind = env.ACB_AGENT_KIND;
  else if (env.CLAUDE_AGENT_TYPE || env.ACB_SUBAGENT) kind = 'subagent';
  else if (env.CLAUDE_CODE_ENTRYPOINT === 'sdk-cli' || env.CLAUDE_CODE_ENTRYPOINT === 'sdk') kind = 'sdk';
  else if (claude || codex) kind = 'interactive';

  const candidate = {
    kind,
    harness: claude ? 'claude-code' : codex ? 'codex-cli' : null,
    harnessVersion: env.CLAUDE_CODE_VERSION ?? env.CODEX_VERSION ?? null,
    model: env.ANTHROPIC_MODEL ?? env.ACB_AGENT_MODEL ?? env.CODEX_MODEL ?? null,
    instanceId: env.CLAUDE_SESSION_ID ?? env.CODEX_THREAD_ID ?? String(process.pid)
  };
  // A stray environment value must not break a publish that would otherwise succeed; an
  // unusable descriptor degrades to the minimum rather than failing the write.
  try {
    return normalizeAgentDescriptor(candidate);
  } catch {
    return normalizeAgentDescriptor({ kind: 'unknown' });
  }
}
