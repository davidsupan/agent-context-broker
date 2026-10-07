// Contained child processes on Node 24, on Windows, macOS and Linux: run one command with an exact environment,
// bounded stdin, output and time; stop its whole tree on a timeout or an output overflow; and prove afterwards that
// nothing it started is still running. Also the owner identity and liveness probes the run leases use.
//
// How the tree is held:
// - POSIX: the child leads a new process group (`detached`), and the group is signalled as one: SIGTERM, then
//   SIGKILL after a grace period. Empty means `kill(-pgid, 0)` reports ESRCH. A descendant that calls setsid()
//   leaves the group and is not contained; the provider's command does not do that.
// - Windows: a compiled-per-run helper creates the child atomically in a non-breakaway Job Object.
//   Only the job's active-process count reaching zero is cleanup proof, including orphaned descendants.
//
// A run label (`jobName`, kept as `Local\ACBCorpus-<token>` for the existing records) names a small registry file,
// so a later process can ask whether a run it did not start is still active (`probeNamedJob`).

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { sha256Hex } from './platform.mts';
import { runWindowsContained, probeWindowsJob, windowsLauncherAvailable } from './windows-launcher.mts';
export { windowsLauncherAvailable } from './windows-launcher.mts';

export interface ContainedOptions {
  executable: string;
  args: readonly string[];
  cwd: string;
  /** Exact environment, not merged with the parent. */
  env: Record<string, string>;
  stdin: string | Uint8Array;
  /** Combined stdout/stderr capture limit in bytes. Overflow stops the tree. */
  maxOutputBytes: number;
  timeoutMs: number;
  /** Run label; a label already in use is rejected. */
  jobName?: string;
}

export interface ContainedResult {
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
  stderrBuffer: Buffer;
  stdoutBytes: number;
  stderrBytes: number;
  exitCode: number;
  durationMs: number;
  containmentEmpty: boolean | 'unknown';
  containment: 'process-tree-v1' | 'windows-job-v1';
  /** Host startup and per-run compilation measurements, Windows only. */
  startupMs?: number;
  compileMs?: number;
  timedOut: boolean;
  outputLimitExceeded: boolean;
}

export type ProcessIdentity =
  | { platform: 'windows'; pid: number; /** Exact unsigned FILETIME as decimal text. */ creationFiletime: string; machineIdSha256: string }
  | { platform: 'darwin' | 'linux'; pid: number; /** `ps -o lstart=` in the C locale. */ startTime: string; machineIdSha256: string };

export type OwnerState = 'alive' | 'dead' | 'unknown';
export type NamedJobState = 'empty' | 'active' | 'absent' | 'unknown';

export const CLEANUP_TIMEOUT_MS = 5000;
const TERM_GRACE_MS = 1500;
const MAX_IO = 16 * 1024 * 1024;
const JOB_NAME = /^Local\\[A-Za-z0-9_.-]{1,180}$/;
const WINDOWS = process.platform === 'win32';
const POSIX = process.platform === 'darwin' || process.platform === 'linux';

function check(condition: unknown, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

const supported = () => (WINDOWS ? process.arch === 'x64' : POSIX);
const platformName = (): ProcessIdentity['platform'] => (WINDOWS ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux');

function run(file: string, args: string[], timeoutMs = 15000): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout) => resolve({ code: error ? (typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 1) : 0, stdout: String(stdout ?? '') }));
  });
}

// ---- machine and process identity -------------------------------------------------------------------------

let machineCache: string | null = null;

/** sha256 of the lower-cased machine id: MachineGuid on Windows (as before), IOPlatformUUID on macOS. */
async function machineHash(): Promise<string> {
  if (machineCache) return machineCache;
  let value = '';
  if (WINDOWS) {
    const out = await run('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
    value = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out.stdout)?.[1] ?? '';
  } else if (process.platform === 'darwin') {
    const out = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
    value = /"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(out.stdout)?.[1] ?? '';
  } else {
    try { value = readFileSync('/etc/machine-id', 'utf8'); } catch { value = ''; }
  }
  check(value.trim().length > 0, 'machine-identity-unavailable');
  machineCache = sha256Hex(value.trim().toLowerCase());
  return machineCache;
}

type Snapshot = { state: OwnerState; start: string | null };

/** Liveness and the start stamp of one pid, read without touching the process. */
async function processSnapshot(pid: number): Promise<Snapshot> {
  if (WINDOWS) {
    // Get-Process yields nothing for a pid that is not running; StartTime throws only when access is denied.
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { 'dead' } else { try { if ($p.HasExited) { 'dead' } else { $p.StartTime.ToFileTimeUtc() } } catch { 'unknown' } }`;
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    const text = out.stdout.trim();
    if (out.code !== 0) return { state: 'unknown', start: null };
    if (text === 'dead') return { state: 'dead', start: null };
    return /^[1-9][0-9]{0,19}$/.test(text) ? { state: 'alive', start: text } : { state: 'unknown', start: null };
  }
  const out = await run('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const text = out.stdout.replace(/\s+/g, ' ').trim();
  if (out.code !== 0 && !text) return { state: 'dead', start: null };
  return text ? { state: 'alive', start: text } : { state: 'unknown', start: null };
}

/** Complete JSON-safe identity of this process, or null when ownership cannot be established. */
export async function ownProcessIdentity(): Promise<ProcessIdentity | null> {
  if (!supported()) return null;
  try {
    const machineIdSha256 = await machineHash();
    const snapshot = await processSnapshot(process.pid);
    if (snapshot.state !== 'alive' || !snapshot.start) return null;
    return WINDOWS
      ? { platform: 'windows', pid: process.pid, creationFiletime: snapshot.start, machineIdSha256 }
      : { platform: platformName() as 'darwin' | 'linux', pid: process.pid, startTime: snapshot.start, machineIdSha256 };
  } catch { return null; }
}

/** Liveness snapshot, not a lock or recovery grant. Never expire ownership by age. */
export async function probeOwner(value: unknown): Promise<OwnerState> {
  if (!supported()) return 'unknown';
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown';
    const v = value as Record<string, unknown>;
    const pid = v.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > 0xffffffff) return 'unknown';
    if (typeof v.machineIdSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.machineIdSha256)) return 'unknown';
    let stamp: string;
    if (WINDOWS) {
      if (v.platform !== 'windows' || typeof v.creationFiletime !== 'string' || !/^[1-9][0-9]{0,19}$/.test(v.creationFiletime) ||
        BigInt(v.creationFiletime) > 0xffffffffffffffffn) return 'unknown';
      stamp = v.creationFiletime;
    } else {
      if (v.platform !== platformName() || typeof v.startTime !== 'string' || !v.startTime.trim()) return 'unknown';
      stamp = v.startTime;
    }
    if (v.machineIdSha256 !== await machineHash()) return 'unknown';
    const snapshot = await processSnapshot(pid);
    if (snapshot.state === 'unknown') return 'unknown';
    // A reused pid is not the old owner.
    if (snapshot.state === 'alive' && snapshot.start !== null && snapshot.start !== stamp) return 'dead';
    return snapshot.state;
  } catch { return 'unknown'; }
}

// ---- run registry -------------------------------------------------------------------------------------------

type RegistryRecord = { schemaVersion: 1; jobName: string; platform: ProcessIdentity['platform']; pid: number; start: string | null; state: 'running' | 'empty' | 'unverified'; updatedAt: string; containment?: 'windows-job-v1' };

/** Where run records live: AGENT_CONTEXT_BROKER_CONTAINMENT_DIR, else a folder in the system temp directory. */
export function registryDir(): string {
  const configured = process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR;
  return configured && isAbsolute(configured) ? configured : join(tmpdir(), 'agent-context-broker-containment');
}

const recordPath = (jobName: string) => join(registryDir(), `${jobName.slice('Local\\'.length)}.json`);

function readRecord(jobName: string): RegistryRecord | null {
  try {
    const value = JSON.parse(readFileSync(recordPath(jobName), 'utf8')) as RegistryRecord;
    return value && value.schemaVersion === 1 && value.jobName === jobName ? value : null;
  } catch { return null; }
}

function writeRecord(record: RegistryRecord, fresh = false): void {
  mkdirSync(registryDir(), { recursive: true });
  const path = recordPath(record.jobName);
  if (fresh) {
    // A label in use is rejected; `wx` makes the claim atomic.
    writeFileSync(path, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    return;
  }
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record)}\n`);
  renameSync(temp, path);
}

// ---- process trees ------------------------------------------------------------------------------------------

function groupAlive(pgid: number): boolean {
  try { process.kill(-pgid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* already gone */ }
}

/** Whether nothing the run started is still alive. */
async function treeEmpty(pid: number): Promise<boolean> {
  return !groupAlive(pid);
}

function prepare(options: ContainedOptions) {
  check(options && typeof options === 'object', 'invalid-options');
  const { executable, args, cwd, env, stdin, maxOutputBytes, timeoutMs, jobName } = options;
  check(typeof executable === 'string' && isAbsolute(executable) && executable.length < 32767 && !/[\0"]/.test(executable) &&
    (!WINDOWS || /\.exe$/i.test(executable)), 'invalid-native-executable');
  check(Array.isArray(args) && args.length <= 4096 && args.every(a => typeof a === 'string' && !a.includes('\0')), 'invalid-native-argv');
  check(typeof cwd === 'string' && isAbsolute(cwd) && !cwd.includes('\0'), 'invalid-cwd');
  check(env && typeof env === 'object' && !Array.isArray(env), 'invalid-environment');
  const names = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    check(key.length && !/[=\0]/.test(key) && typeof value === 'string' && !value.includes('\0'), 'invalid-environment');
    const folded = WINDOWS ? key.toUpperCase() : key;
    check(!names.has(folded), 'duplicate-environment-name');
    names.add(folded);
  }
  check(typeof stdin === 'string' || stdin instanceof Uint8Array, 'invalid-stdin');
  const input = Buffer.from(stdin);
  check(input.byteLength <= MAX_IO, 'stdin-limit');
  check(Number.isSafeInteger(maxOutputBytes) && maxOutputBytes > 0 && maxOutputBytes <= MAX_IO, 'output-limit');
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 1800000, 'timeout-limit');
  check(jobName === undefined || (typeof jobName === 'string' && JOB_NAME.test(jobName)), 'invalid-job-name');
  return { executable, args: [...args], cwd, env: { ...env }, input, maxOutputBytes, timeoutMs, jobName: jobName ?? null };
}

/** Run one command contained. No shell; the environment is exactly `env`. */
export async function runContained(options: ContainedOptions): Promise<ContainedResult> {
  check(supported(), WINDOWS ? 'windows-x64-required' : 'platform-unsupported');
  const config = prepare(options);
  if (WINDOWS) {
    check(windowsLauncherAvailable(), 'windows-containment-unavailable');
    const owner = await processSnapshot(process.pid);
    check(owner.state === 'alive' && owner.start, 'windows-owner-identity-unavailable');
    let pid = 0;
    const record = (state: RegistryRecord['state'], fresh = false) => {
      if (config.jobName) writeRecord({ schemaVersion: 1, jobName: config.jobName, platform: 'windows', pid,
        start: null, state, containment: 'windows-job-v1', updatedAt: new Date().toISOString() }, fresh);
    };
    const { input, jobName, ...launch } = config;
    return runWindowsContained({ ...launch, stdin: input, jobName: jobName ?? undefined }, { pid: process.pid, creationFiletime: owner.start }, {
      claim: () => { try { record('running', true); } catch { throw new Error('job-name-already-exists'); } },
      started: value => { pid = value; record('running'); },
      finished: empty => record(empty === true ? 'empty' : 'unverified'),
    });
  }
  if (config.jobName) {
    try { writeRecord({ schemaVersion: 1, jobName: config.jobName, platform: platformName(), pid: 0, start: null, state: 'running', updatedAt: new Date().toISOString() }, true); }
    catch { throw new Error('job-name-already-exists'); }
  }
  const started = performance.now();
  const child = spawn(config.executable, config.args, {
    cwd: config.cwd, env: config.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true,
    detached: POSIX, // its own process group, so the whole tree is signalled at once
  });
  // Listen before any await: a child that exits at once must not emit `exit` or `close` unheard.
  const exited = new Promise<number>(resolve => child.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  const out = { chunks: [] as Buffer[], bytes: 0 };
  const err = { chunks: [] as Buffer[], bytes: 0 };
  let outputLimitExceeded = false;
  let timedOut = false;
  let stopping: Promise<void> | null = null;
  const stop = () => {
    const pid = child.pid!;
    stopping ??= (async () => {
      signalGroup(pid, 'SIGTERM');
      const until = performance.now() + TERM_GRACE_MS;
      while (groupAlive(pid) && performance.now() < until) await sleep(25);
      signalGroup(pid, 'SIGKILL');
    })();
    return stopping;
  };
  const collect = (sink: typeof out) => (chunk: Buffer) => {
    const remaining = config.maxOutputBytes - out.bytes - err.bytes;
    const keep = Math.min(chunk.length, Math.max(0, remaining));
    if (keep) { sink.chunks.push(chunk.subarray(0, keep)); sink.bytes += keep; }
    if (chunk.length > remaining && !outputLimitExceeded) { outputLimitExceeded = true; void stop(); }
  };
  child.stdout!.on('data', collect(out));
  child.stderr!.on('data', collect(err));
  child.stdin!.on('error', () => { /* the child closed stdin early; its exit code tells the rest */ });
  child.stdin!.end(config.input);
  const timer = setTimeout(() => { timedOut = true; void stop(); }, config.timeoutMs);
  const pid = await new Promise<number>((resolve, reject) => {
    child.once('spawn', () => resolve(child.pid!));
    child.once('error', () => reject(new Error('create-process-failed')));
  });
  if (config.jobName) {
    const start = (await processSnapshot(pid)).start;
    writeRecord({ schemaVersion: 1, jobName: config.jobName, platform: platformName(), pid, start, state: 'running', updatedAt: new Date().toISOString() });
  }


  // `exit` gives the code; `close` waits for the pipes, which a leftover grandchild may still hold open.
  let exitCode: number;
  try {
    exitCode = await exited;
  } finally {
    clearTimeout(timer);
  }
  // The child is gone; whatever it started must be gone too, or be stopped now.
  let empty = await treeEmpty(pid);
  if (!empty) {
    await stop();
    const until = performance.now() + CLEANUP_TIMEOUT_MS;
    while (!(empty = await treeEmpty(pid)) && performance.now() < until) await sleep(100);
  }
  // With the tree gone the pipes reach EOF; give the last chunks a bounded moment to arrive.
  await Promise.race([closed, sleep(CLEANUP_TIMEOUT_MS)]);
  if (config.jobName) {
    writeRecord({ schemaVersion: 1, jobName: config.jobName, platform: platformName(), pid, start: null, state: empty ? 'empty' : 'unverified', updatedAt: new Date().toISOString() });
  }
  check(empty, 'containment-empty-unverified');
  return {
    stdout: Buffer.concat(out.chunks).toString('utf8'), stderr: Buffer.concat(err.chunks).toString('utf8'),
    stdoutBuffer: Buffer.concat(out.chunks), stderrBuffer: Buffer.concat(err.chunks), containment: 'process-tree-v1',
    stdoutBytes: out.bytes, stderrBytes: err.bytes, exitCode, durationMs: performance.now() - started,
    containmentEmpty: true, timedOut, outputLimitExceeded,
  };
}

/** State of a run by its label. Absent is NOT empty or completion proof. */
export async function probeNamedJob(name: unknown): Promise<NamedJobState> {
  if (!supported() || typeof name !== 'string' || !JOB_NAME.test(name)) return 'unknown';
  try {
    if (!existsSync(recordPath(name))) return 'absent';
    const record = readRecord(name);
    if (!record || record.platform !== platformName()) return 'unknown';
    if (WINDOWS) {
      if (record.containment !== 'windows-job-v1') return 'unknown';
      return record.state === 'empty' ? 'empty' : await probeWindowsJob(name);
    }
    if (record.state === 'empty') return 'empty';
    if (!record.pid) return 'unknown';
    return groupAlive(record.pid) ? 'active' : 'empty';
  } catch { return 'unknown'; }
}
