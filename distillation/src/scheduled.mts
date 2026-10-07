import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tomlString } from './platform.mts';
import { z } from 'zod';
import { DailyConfig, runDaily } from './daily.mts';
import { createProviderRunner, preflight } from './provider.mts';
import { DAILY_SECONDS, noLinks, openStore, status } from './store.mts';
import { canonical } from './slicing.mts';
import { applyAutomatic } from './review.mts';
import { ownProcessIdentity, probeOwner, type OwnerState, type ProcessIdentity } from './windows-job.mts';

// Wrapper for an unattended trigger (Windows Task Scheduler). It adds the guards that a
// conversation-driven trigger enforced by instruction: one owner, the other scheduler
// paused, one run per UTC day, one process at a time, and the approved policy limits.
// It never retries, never resets interrupted slices and never changes configuration.

export const OWNER = 'claude-task-scheduler';
export const CODEX_AUTOMATION = join(homedir(), '.codex', 'automations', 'dnevna-destilacija-zasebnega-korpusa', 'automation.toml');
const OwnerRecord = z.strictObject({ schemaVersion: z.literal(1), owner: z.literal(OWNER),
  since: z.iso.datetime(), approvedBy: z.literal('operator') });
const LockRecord = z.strictObject({ schemaVersion: z.literal(1), runId: z.uuid(), acquiredAt: z.iso.datetime(), owner: z.unknown() });
const Started = z.object({ recordedAt: z.iso.datetime() });

export type ScheduledMode = 'preflight-only' | 'run';
// codexAutomationPath defaults to this account's Codex home; another account's view needs it passed explicitly.
// allowPublication is never set by the CLI: publishing from an unattended run needs its own approval.
export type ScheduledInput = { home: string; configPath: string; mode: ScheduledMode; codexAutomationPath?: string;
  allowPublication?: boolean };
export type ScheduledDeps = {
  now?: () => Date;
  identity?: () => Promise<ProcessIdentity | null>;
  ownerState?: (owner: unknown) => Promise<OwnerState>;
  providerPreflight?: (adapters: NonNullable<z.infer<typeof DailyConfig>['adapters']>, home: string) => Promise<unknown>;
  daily?: (config: z.infer<typeof DailyConfig>, home: string, rereadConfig: () => unknown) => Promise<Record<string, unknown>>;
};

function refuse(code: string): never { throw new Error(code); }

function durable(path: string, value: unknown, flag = 'wx') {
  noLinks(path);
  const fd = openSync(path, flag, 0o600);
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

function readConfig(path: string): unknown {
  noLinks(path);
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) refuse('scheduler-config-limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

/** ACTIVE or unreadable means the other scheduler may still fire, so this one must not. */
export function codexAutomationState(path: string): 'absent' | 'paused' | 'active' | 'unknown' {
  let text: string;
  // Only a missing file is absent; any other read error may hide a live automation.
  try { text = readFileSync(path, 'utf8'); } catch (error) { return (error as { code?: string }).code === 'ENOENT' ? 'absent' : 'unknown'; }
  try {
    const status = tomlString(text, 'status');
    return status === 'PAUSED' ? 'paused' : status === 'ACTIVE' ? 'active' : 'unknown';
  } catch { return 'unknown'; }
}

function codexGuard(state: ReturnType<typeof codexAutomationState>) {
  if (state !== 'absent' && state !== 'paused') refuse(state === 'active' ? 'scheduler-codex-active' : 'scheduler-codex-unknown');
}

/** The raw owner record when valid, so a later check can require the very same record. */
function ownerRecord(home: string): string | null {
  try {
    const text = readFileSync(join(home, 'scheduler-owner.json'), 'utf8');
    return OwnerRecord.safeParse(JSON.parse(text)).success ? text : null;
  } catch { return null; }
}

function ranToday(home: string, day: string) {
  const directory = join(home, 'daily-runs');
  if (!existsSync(directory)) return false;
  return readdirSync(directory).filter(name => name.endsWith('.started.json')).some(name => {
    try { return Started.parse(JSON.parse(readFileSync(join(directory, name), 'utf8'))).recordedAt.slice(0, 10) === day; }
    catch { return true; } // An unreadable run record is treated as a run, never as permission.
  });
}

/** Approved limits, checked from the file actually used, before any process starts. */
export function checkPolicy(value: unknown, options: { allowPublication?: boolean } = {}) {
  const config = DailyConfig.parse(value);
  // A broker block would let daily() publish; configuration alone never grants that.
  if (config.broker && options.allowPublication !== true) refuse('scheduler-publication-not-approved');
  const providers = Object.keys(config.adapters?.providers ?? {});
  if (!config.adapters || providers.length !== 1 || providers[0] !== 'claude') refuse('scheduler-provider-policy');
  if (config.semantic.claudeAvailable !== true || config.semantic.codexAvailable !== false ||
    config.semantic.claudeUnavailableReason !== undefined) refuse('scheduler-provider-policy');
  if (config.maxModelCalls > 6 || config.semantic.attemptSeconds > 300 || DAILY_SECONDS !== 1800) refuse('scheduler-limit-policy');
  if (!config.adapters.providers.claude?.liveProfileReceipt) refuse('scheduler-live-profile-missing');
  return config;
}

function acquireLock(home: string, runId: string, owner: unknown, now: Date) {
  const path = join(home, 'scheduler.lock');
  durable(path, { schemaVersion: 1, runId, acquiredAt: now.toISOString(), owner });
  return path;
}

async function lockOrReclaim(home: string, runId: string, owner: unknown, now: Date, ownerState: (owner: unknown) => Promise<OwnerState>) {
  const path = join(home, 'scheduler.lock');
  try { return acquireLock(home, runId, owner, now); } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
  }
  const held = readLock(path) ?? refuse('scheduler-lock-unreadable');
  // Only a lock whose owner is provably gone may be set aside; unknown keeps it held.
  if (await ownerState(held.record.owner) !== 'dead') refuse('scheduler-busy');
  // The probe was asynchronous: a lock replaced or removed meanwhile is not the one proved dead.
  const again = readLock(path);
  if (!again || again.record.runId !== held.record.runId || !again.raw.equals(held.raw)) refuse('scheduler-busy');
  renameSync(path, join(home, `scheduler.lock.stale-${held.record.runId}`));
  return acquireLock(home, runId, owner, now);
}

function readLock(path: string) {
  try { const raw = readFileSync(path); return { raw, record: LockRecord.parse(JSON.parse(raw.toString('utf8'))) }; }
  catch { return null; }
}

/** Removes the lock only while it is still ours; one reclaimed by another run stays. */
function releaseLock(path: string, runId: string) {
  try { noLinks(path); if (readLock(path)?.record.runId === runId) unlinkSync(path); }
  catch { /* A leftover lock is resolved by the next owner probe. */ }
}

// Daily outcomes that are a normal end of a run; anything else needs attention.
const SETTLED = new Set(['pending-review', 'idle', 'paused-budget', 'paused-quota', 'paused-unavailable',
  'paused-day-boundary', 'no-attempt', 'leased', 'busy', 'source-state-changed']);

function failureClasses(home: string, result: Record<string, unknown>) {
  const attempts = z.array(z.object({ token: z.string().optional(), state: z.string() }).passthrough()).catch([]).parse(result.attempts);
  return attempts.flatMap(attempt => {
    if (!attempt.token || !/^[a-f0-9]{32}$/.test(attempt.token)) return [];
    const path = join(home, 'provider-failures', attempt.token + '.json');
    if (!existsSync(path)) return [];
    try {
      const record = JSON.parse(readFileSync(path, 'utf8'));
      return [{ token: attempt.token, code: String(record.code ?? 'unknown'), category: String(record.errorClass?.category ?? 'unclassified') }];
    } catch { return [{ token: attempt.token, code: 'unreadable', category: 'unclassified' }]; }
  });
}

function reservedSeconds(home: string, now: Date) {
  const path = join(home, 'queue.sqlite3');
  if (!existsSync(path)) return 0;
  using db = openStore(path, { readonly: true });
  return status(db, now.getTime() / 1000).reservedSeconds;
}

export async function runScheduled(input: ScheduledInput, deps: ScheduledDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const runId = randomUUID(), startedAt = now();
  const day = startedAt.toISOString().slice(0, 10);
  const directory = join(input.home, 'scheduler-runs');
  noLinks(directory); mkdirSync(directory, { recursive: true });
  const base = { schemaVersion: 1, runId, mode: input.mode, startedAt: startedAt.toISOString(), utcDay: day };
  const record = (value: Record<string, unknown> & { state: string; exitCode: 0 | 1 }) => {
    const result = { ...base, finishedAt: now().toISOString(), ...value };
    durable(join(directory, `${runId}.json`), result);
    return result;
  };
  let lock: string | null = null;
  try {
    // Preflight starts nothing, so before a switchover it reports these two guards
    // instead of refusing; a run always enforces them.
    const owner = ownerRecord(input.home);
    const codexPath = input.codexAutomationPath ?? CODEX_AUTOMATION;
    const codex = codexAutomationState(codexPath);
    const guards = { owner: owner !== null ? 'present' : 'missing', codexAutomation: codex, codexAutomationPath: codexPath };
    if (input.mode === 'run') {
      if (owner === null) refuse('scheduler-not-owner');
      codexGuard(codex);
    }
    const policy = { allowPublication: input.allowPublication === true };
    const identity = await (deps.identity ?? ownProcessIdentity)();
    if (!identity) refuse('scheduler-owner-proof-unavailable');
    lock = await lockOrReclaim(input.home, runId, identity, startedAt, deps.ownerState ?? probeOwner);
    if (input.mode === 'run' && ranToday(input.home, day)) {
      return record({ state: 'skipped', reason: 'already-ran-today', exitCode: 0 });
    }
    const config = checkPolicy(readConfig(input.configPath), policy);
    await (deps.providerPreflight ?? preflight)(config.adapters!, input.home);
    if (input.mode === 'preflight-only') return record({ state: 'preflight-ready', guards, exitCode: 0 });
    const before = reservedSeconds(input.home, startedAt);
    const daily = deps.daily ?? (async (value, home, reread) => {
      const runner = await createProviderRunner(value.adapters!, home);
      return await runDaily(value, home, true, runner, { rereadConfig: reread }) as Record<string, unknown>;
    });
    // daily() rereads before every model call, so the guards are proved again each time and
    // a switchover, ownership change or policy edit mid-run stops further calls.
    const reread = () => {
      try {
        if (ownerRecord(input.home) !== owner) refuse('scheduler-not-owner');
        codexGuard(codexAutomationState(codexPath));
        const value = readConfig(input.configPath);
        checkPolicy(value, policy);
        return value;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('scheduler-')) throw error;
        refuse('scheduler-config-invalid');
      }
    };
    const result = await daily(config, input.home, reread);
    // The one automatic review rule; a failure here keeps the results but fails the exit code.
    let autoAccepted: number | 'failed' = 0;
    try { autoAccepted = applyAutomatic(input.home, now()).accepted; } catch { autoAccepted = 'failed'; }
    const dailyState = String(result.state ?? 'unknown');
    const problem = !SETTLED.has(dailyState) || autoAccepted === 'failed';
    return record({ state: 'completed', dailyState,
      modelCalls: Number(result.modelCalls ?? 0), reservedBefore: before, reservedAfter: reservedSeconds(input.home, now()),
      failures: failureClasses(input.home, result), autoAccepted, ...(problem ? { problem: true } : {}), exitCode: problem ? 1 : 0 });
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const code = /^(?:scheduler|provider|live-profile|capture|slice|source|registry|config|adapter)-[a-z0-9-]{1,70}$/.test(message)
      ? message : 'scheduler-run-failed';
    return record({ state: code === 'scheduler-busy' || code.startsWith('scheduler-codex') || code === 'scheduler-not-owner' ? 'refused' : 'failed',
      code, exitCode: 1 });
  } finally {
    if (lock) releaseLock(lock, runId);
  }
}
