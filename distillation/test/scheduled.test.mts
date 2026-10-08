import { afterEach, expect, test } from './expect.mts';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/capture.mts';
import { checkPolicy, codexAutomationState, runScheduled, type ScheduledDeps } from '../src/scheduled.mts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
const NOW = new Date('2026-10-06T07:15:00.000Z');
const identity = { platform: 'windows' as const, pid: 4242, creationFiletime: '133000000000000000', machineIdSha256: 'a'.repeat(64) };

function fixture(change: (config: Record<string, any>) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'acb-scheduled-')); roots.push(root);
  const home = join(root, 'home'); mkdirSync(home);
  const executable = join(root, 'claude.exe'); writeFileSync(executable, 'synthetic executable bytes');
  const registry = JSON.stringify({ schemaVersion: 1, entries: [] });
  const config: Record<string, any> = {
    claudeCli: executable,
    capture: { providerRoots: { codex: join(root, 'source') }, historyRegistry: { path: join(root, 'h.json'), sha256: sha256(registry) } },
    semantic: { claudeAvailable: true, codexAvailable: false, attemptSeconds: 300 },
    adapters: { providers: { claude: { executable, executableSha256: sha256('synthetic executable bytes'), version: '2.1.263',
      model: 'haiku', authHome: 'C:/synthetic/auth', capabilityReceipt: { path: 'C:/synthetic/cap.json', sha256: 'c'.repeat(64) },
      liveProfileReceipt: { path: 'C:/synthetic/live.json', sha256: 'd'.repeat(64) } } } },
    maxModelCalls: 6,
  };
  change(config);
  const configPath = join(root, 'daily.json'); writeFileSync(configPath, JSON.stringify(config));
  const codexPath = join(root, 'automation.toml');
  writeFileSync(codexPath, 'version = 1\nstatus = "PAUSED"\n');
  writeFileSync(join(home, 'scheduler-owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'claude-task-scheduler',
    since: '2026-10-05T12:00:00.000Z', approvedBy: 'operator' }));
  let dailyCalls = 0, preflightCalls = 0;
  const deps: ScheduledDeps = { now: () => NOW, identity: async () => identity, ownerState: async () => 'dead',
    providerPreflight: async () => { preflightCalls++; return { state: 'ready' }; },
    daily: async () => { dailyCalls++; return { state: 'pending-review', modelCalls: 2, attempts: [] }; } };
  return { root, home, configPath, codexPath, deps, counts: () => ({ dailyCalls, preflightCalls }) };
}
const input = (f: ReturnType<typeof fixture>, mode: 'run' | 'preflight-only' = 'run') =>
  ({ home: f.home, configPath: f.configPath, mode, codexAutomationPath: f.codexPath });
const records = (home: string) => readdirSync(join(home, 'scheduler-runs')).map(name => JSON.parse(readFileSync(join(home, 'scheduler-runs', name), 'utf8')));

test('a run completes once, records the outcome and releases its lock', async () => {
  const f = fixture();
  const result = await runScheduled(input(f), f.deps);
  expect(result).toMatchObject({ state: 'completed', dailyState: 'pending-review', modelCalls: 2, exitCode: 0, utcDay: '2026-10-06' });
  expect(f.counts()).toEqual({ dailyCalls: 1, preflightCalls: 1 });
  expect(existsSync(join(f.home, 'scheduler.lock'))).toBe(false);
  expect(records(f.home)).toHaveLength(1);
});

test('preflight-only checks everything but never starts the daily run', async () => {
  const f = fixture();
  expect(await runScheduled(input(f, 'preflight-only'), f.deps)).toMatchObject({ state: 'preflight-ready', exitCode: 0,
    guards: { owner: 'present', codexAutomation: 'paused' } });
  expect(f.counts()).toEqual({ dailyCalls: 0, preflightCalls: 1 });
  // Before a switchover preflight reports the guards it would enforce, but still starts nothing.
  writeFileSync(f.codexPath, 'status = "ACTIVE"\n'); rmSync(join(f.home, 'scheduler-owner.json'));
  expect(await runScheduled(input(f, 'preflight-only'), f.deps)).toMatchObject({ state: 'preflight-ready',
    guards: { owner: 'missing', codexAutomation: 'active' } });
  expect(f.counts().dailyCalls).toBe(0);
});

test('the other scheduler must be paused and this one must own the trigger', async () => {
  const active = fixture(); writeFileSync(active.codexPath, 'status = "ACTIVE"\n');
  expect(await runScheduled(input(active), active.deps)).toMatchObject({ state: 'refused', code: 'scheduler-codex-active', exitCode: 1 });
  const unknown = fixture(); writeFileSync(unknown.codexPath, 'status = maybe\n');
  expect(await runScheduled(input(unknown), unknown.deps)).toMatchObject({ code: 'scheduler-codex-unknown' });
  const owner = fixture(); rmSync(join(owner.home, 'scheduler-owner.json'));
  expect(await runScheduled(input(owner), owner.deps)).toMatchObject({ state: 'refused', code: 'scheduler-not-owner' });
  for (const f of [active, unknown, owner]) expect(f.counts().dailyCalls).toBe(0);
  expect(codexAutomationState(join(owner.root, 'missing.toml'))).toBe('absent');
});

test('a day that already has a daily run is skipped, whoever started it', async () => {
  const f = fixture();
  mkdirSync(join(f.home, 'daily-runs'));
  writeFileSync(join(f.home, 'daily-runs', 'x.started.json'), JSON.stringify({ recordedAt: '2026-10-06T06:59:00.000Z' }));
  expect(await runScheduled(input(f), f.deps)).toMatchObject({ state: 'skipped', reason: 'already-ran-today', exitCode: 2 });
  writeFileSync(join(f.home, 'daily-runs', 'y.started.json'), 'not json');
  expect(f.counts().dailyCalls).toBe(0);
});

test('a live or unknown lock holder refuses; only a dead holder is set aside', async () => {
  for (const state of ['alive', 'unknown'] as const) {
    const f = fixture();
    writeFileSync(join(f.home, 'scheduler.lock'), JSON.stringify({ schemaVersion: 1, runId: crypto.randomUUID(),
      acquiredAt: '2026-10-06T07:00:00.000Z', owner: identity }));
    expect(await runScheduled(input(f), { ...f.deps, ownerState: async () => state })).toMatchObject({ state: 'refused', code: 'scheduler-busy' });
    expect(existsSync(join(f.home, 'scheduler.lock'))).toBe(true);
  }
  const f = fixture();
  const runId = crypto.randomUUID();
  writeFileSync(join(f.home, 'scheduler.lock'), JSON.stringify({ schemaVersion: 1, runId, acquiredAt: '2026-10-06T07:00:00.000Z', owner: identity }));
  expect(await runScheduled(input(f), f.deps)).toMatchObject({ state: 'completed' });
  expect(existsSync(join(f.home, `scheduler.lock.stale-${runId}`))).toBe(true);
});

test('policy limits are enforced from the file actually used', async () => {
  for (const change of [
    (c: Record<string, any>) => { c.semantic.codexAvailable = true; },
    (c: Record<string, any>) => { c.maxModelCalls = 7; },
    (c: Record<string, any>) => { c.semantic.attemptSeconds = 301; },
    (c: Record<string, any>) => { delete c.adapters.providers.claude.liveProfileReceipt; },
    (c: Record<string, any>) => { c.semantic.claudeUnavailableReason = 'quota-unavailable'; },
  ]) {
    const f = fixture(change);
    const result = await runScheduled(input(f), f.deps);
    expect(result).toMatchObject({ state: 'failed', exitCode: 1 });
    expect(String((result as { code?: string }).code)).toMatch(/^scheduler-/);
    expect(f.counts()).toEqual({ dailyCalls: 0, preflightCalls: 0 });
  }
  expect(() => checkPolicy({})).toThrow();
});

test('a completed run fails its exit code when daily did not settle or the review rule failed', async () => {
  const settled = fixture();
  const ok = await runScheduled(input(settled), settled.deps);
  expect(ok).toMatchObject({ state: 'completed', dailyState: 'pending-review', exitCode: 0 });
  expect(ok).not.toHaveProperty('problem');
  const interrupted = fixture();
  const bad = await runScheduled(input(interrupted), { ...interrupted.deps,
    daily: async () => ({ state: 'interrupted-unknown', modelCalls: 1, attempts: [] }) });
  expect(bad).toMatchObject({ state: 'completed', dailyState: 'interrupted-unknown', exitCode: 1, problem: true });
  expect(records(interrupted.home)[0]).toMatchObject({ exitCode: 1, problem: true });
  const review = fixture();
  const failed = await runScheduled(input(review), { ...review.deps, daily: async (_c, home) => {
    // An empty store plus an unreadable results path makes the automatic review rule throw.
    writeFileSync(join(home, 'queue.sqlite3'), ''); writeFileSync(join(home, 'semantic-results'), 'not a directory');
    return { state: 'idle', modelCalls: 0, attempts: [] };
  } });
  expect(failed).toMatchObject({ state: 'completed', dailyState: 'idle', autoAccepted: 'failed', exitCode: 1, problem: true });
});

test('codex automation status is read as TOML, top-level only', () => {
  const f = fixture();
  const state = (text: string) => { writeFileSync(f.codexPath, text); return codexAutomationState(f.codexPath); };
  expect(state("version = 1\nstatus = 'PAUSED' # comment\n")).toBe('paused');
  expect(state('status = """ACTIVE"""\n')).toBe('active');
  expect(state('version = 1\n')).toBe('unknown');
  expect(state('[nested]\nstatus = "PAUSED"\n')).toBe('unknown');
  expect(state('status = "PAUSED"\nstatus = "ACTIVE"\n')).toBe('unknown');
  expect(state('status = 1\n')).toBe('unknown');
  expect(state('status = "paused"\n')).toBe('unknown');
  // A path that exists but cannot be read as a file is never treated as absent.
  rmSync(f.codexPath); mkdirSync(f.codexPath);
  expect(codexAutomationState(f.codexPath)).toBe('unknown');
});

test('the guards are proved again before every model call', async () => {
  const flips: Array<[(f: ReturnType<typeof fixture>) => void, string]> = [
    [f => writeFileSync(f.codexPath, 'status = "ACTIVE"\n'), 'scheduler-codex-active'],
    [f => writeFileSync(f.codexPath, 'status = ['), 'scheduler-codex-unknown'],
    [f => rmSync(join(f.home, 'scheduler-owner.json')), 'scheduler-not-owner'],
    [f => writeFileSync(join(f.home, 'scheduler-owner.json'), JSON.stringify({ schemaVersion: 1, owner: 'claude-task-scheduler',
      since: '2026-10-06T07:00:00.000Z', approvedBy: 'operator' })), 'scheduler-not-owner'],
    [f => { const c = JSON.parse(readFileSync(f.configPath, 'utf8')); c.maxModelCalls = 7; writeFileSync(f.configPath, JSON.stringify(c)); },
      'scheduler-limit-policy'],
    [f => { const c = JSON.parse(readFileSync(f.configPath, 'utf8')); c.broker = { toolRoot: 'C:/b', claimsRoot: 'C:/c', eventsRoot: 'C:/e' };
      writeFileSync(f.configPath, JSON.stringify(c)); }, 'scheduler-publication-not-approved'],
    [f => writeFileSync(f.configPath, '{'), 'scheduler-config-invalid'],
  ];
  for (const [flip, code] of flips) {
    const f = fixture();
    let rereads = 0;
    const result = await runScheduled(input(f), { ...f.deps, daily: async (_c, _h, reread) => {
      expect(reread()).toEqual(JSON.parse(readFileSync(f.configPath, 'utf8'))); rereads++;
      flip(f);
      reread(); rereads++; // A daily run stops here, before its next model call.
      return { state: 'pending-review', modelCalls: 2, attempts: [] };
    } });
    expect(rereads).toBe(1);
    expect(result).toMatchObject({ code, exitCode: 1 });
    expect(existsSync(join(f.home, 'scheduler.lock'))).toBe(false);
  }
});

test('a lock replaced during the owner probe is never set aside', async () => {
  const f = fixture();
  const lock = join(f.home, 'scheduler.lock');
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  writeFileSync(lock, JSON.stringify({ schemaVersion: 1, runId: first, acquiredAt: '2026-10-06T07:00:00.000Z', owner: identity }));
  const replacement = JSON.stringify({ schemaVersion: 1, runId: second, acquiredAt: '2026-10-06T07:01:00.000Z', owner: identity });
  const result = await runScheduled(input(f), { ...f.deps, ownerState: async () => { writeFileSync(lock, replacement); return 'dead'; } });
  expect(result).toMatchObject({ state: 'refused', code: 'scheduler-busy' });
  expect(readFileSync(lock, 'utf8')).toBe(replacement);
  expect(readdirSync(f.home).some(name => name.startsWith('scheduler.lock.stale-'))).toBe(false);
  // Same runId but different bytes is a different lock too.
  const g = fixture();
  const held = JSON.stringify({ schemaVersion: 1, runId: first, acquiredAt: '2026-10-06T07:00:00.000Z', owner: identity });
  writeFileSync(join(g.home, 'scheduler.lock'), held);
  expect(await runScheduled(input(g), { ...g.deps, ownerState: async () => {
    writeFileSync(join(g.home, 'scheduler.lock'), held + ' '); return 'dead'; } })).toMatchObject({ code: 'scheduler-busy' });
  expect(g.counts().dailyCalls).toBe(0);
});

test('release removes only a lock that is still this run', async () => {
  const f = fixture();
  const lock = join(f.home, 'scheduler.lock');
  const other = JSON.stringify({ schemaVersion: 1, runId: crypto.randomUUID(), acquiredAt: '2026-10-06T07:10:00.000Z', owner: identity });
  const result = await runScheduled(input(f), { ...f.deps, daily: async () => {
    expect(JSON.parse(readFileSync(lock, 'utf8')).runId).toBeString();
    writeFileSync(lock, other); return { state: 'pending-review', modelCalls: 0, attempts: [] };
  } });
  expect(result).toMatchObject({ state: 'completed', exitCode: 0 });
  expect(readFileSync(lock, 'utf8')).toBe(other);
});

test('a broker section needs explicit publication approval', async () => {
  const broker = (c: Record<string, any>) => { c.broker = { toolRoot: 'C:/b', claimsRoot: 'C:/c', eventsRoot: 'C:/e' }; };
  const f = fixture(broker);
  const config = JSON.parse(readFileSync(f.configPath, 'utf8'));
  expect(() => checkPolicy(config)).toThrow('scheduler-publication-not-approved');
  expect(() => checkPolicy(config, { allowPublication: false })).toThrow('scheduler-publication-not-approved');
  expect(checkPolicy(config, { allowPublication: true }).broker).toEqual(config.broker);
  expect(await runScheduled(input(f), f.deps)).toMatchObject({ state: 'failed', code: 'scheduler-publication-not-approved', exitCode: 1 });
  expect(f.counts()).toEqual({ dailyCalls: 0, preflightCalls: 0 });
  expect(await runScheduled({ ...input(f), allowPublication: true }, f.deps)).toMatchObject({ state: 'completed', exitCode: 0 });
});

test('a failing provider preflight stops before the daily run', async () => {
  const f = fixture();
  const result = await runScheduled(input(f), { ...f.deps, providerPreflight: async () => { throw new Error('live-profile-mismatch'); } });
  expect(result).toMatchObject({ state: 'failed', code: 'live-profile-mismatch', exitCode: 1 });
  expect(f.counts().dailyCalls).toBe(0);
});
