import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { CONSENT, enable, disable, onboardingStatus, planEnable, reviewCount, type OnboardingContext } from '../src/onboarding.mts';
import { claudeCliCandidates, resolveClaudeCli } from '../src/claude-cli.mts';
import { runScheduled, type ScheduledDeps } from '../src/scheduled.mts';
import { configureDailyBudget } from '../src/pilot-budget.mts';
import { dailyBudgetLimit, openStore } from '../src/store.mts';
import { runDaily } from '../src/daily.mts';
import { runCapture } from '../src/capture.mts';
import { prepareSlices } from '../src/slice-queue.mts';
import { coverage, digest } from '../src/slicing.mts';
import type { ModelRunner } from '../src/consumer.mts';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const now = new Date('2026-10-07T10:00:00Z');
function fixture(platform: 'darwin' | 'win32' = 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'onboarding-test-')); roots.push(root);
  const home = join(root, 'runtime'); const user = join(root, 'user'); const config = join(root, 'config');
  const executable = join(user, '.local', 'bin', platform === 'win32' ? 'claude.exe' : 'claude');
  mkdirSync(join(user, '.local', 'bin'), { recursive: true }); writeFileSync(executable, 'fake cli, never executed');
  mkdirSync(join(config, 'projects', 'session-folder'), { recursive: true });
  const exportPath = join(root, 'cowork.json');
  writeFileSync(exportPath, JSON.stringify({ session: 'synthetic', title: 'PRIVATE TITLE', url: '', captured: now.toISOString(),
    rows: [{ index: 0, text: 'You said: PRIVATE TRANSCRIPT' }, { index: 1, text: 'Synthetic response.' }] }));
  let installed = false; const calls: Array<{ executable: string; args: string[] }> = [];
  const context: OnboardingContext = { platform, env: { HOME: user, USERPROFILE: user, LOCALAPPDATA: join(root, 'local') },
    claudeConfigDir: config, coworkExportPath: exportPath, now: () => now,
    schedule: { platform, nodePath: join(root, 'node.exe'), cliPath: join(root, 'cli.mts'),
      launchAgentsDir: join(root, 'agents'), uid: 123, powershellPath: join(root, 'powershell.exe') },
    runner: async (executable, args) => {
      calls.push({ executable, args }); const action = args.at(-1);
      if (args[0] === 'print') return { exitCode: installed ? 0 : 113, stdout: 'last exit code = 0', stderr: '' };
      if (action === 'status') return { exitCode: 0, stdout: JSON.stringify({ installed, nextRun: installed ? '2026-10-08T09:15:00' : null, lastResult: installed ? 0 : null }), stderr: '' };
      installed = args[0] === 'bootstrap' || action === 'install';
      return { exitCode: 0, stdout: '', stderr: '' };
    } };
  return { root, home, config, executable, exportPath, context, calls };
}
async function apply(f: ReturnType<typeof fixture>, extra = {}) {
  const input = { home: f.home, ...extra }; const plan = await planEnable(input, f.context);
  await enable({ ...input, execute: true, planDigest: plan.planDigest, consent: CONSENT }, f.context); return plan;
}
test('plan is deterministic, counts only, and writes nothing or invokes commands', async () => {
  const f = fixture(); const first = await planEnable({ home: f.home }, f.context);
  assert.deepEqual(await planEnable({ home: f.home }, f.context), first);
  const { planDigest, ...body } = first; assert.equal(planDigest, digest(body));
  assert.equal(first.sources.code.folders, 1); assert.equal(first.sources.coworkImport.exports, 1);
  assert.equal(first.sources.coworkImport.selected, false); assert.equal(first.dailySeconds, 1800);
  assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
  assert.equal(existsSync(f.home), false); assert.equal(existsSync(join(f.root, 'agents')), false); assert.equal(f.calls.length, 0);
});
test('wrong consent and changed budget, source inventory, executable or config refuse before writes', async () => {
  const f = fixture(); const plan = await planEnable({ home: f.home }, f.context);
  await assert.rejects(enable({ home: f.home, execute: true, planDigest: plan.planDigest, consent: CONSENT.toUpperCase() }, f.context), /onboarding-consent-required/);
  await assert.rejects(enable({ home: f.home, dailySeconds: 60, execute: true, planDigest: plan.planDigest, consent: CONSENT }, f.context), /onboarding-plan-changed/);
  mkdirSync(join(f.config, 'projects', 'another'));
  await assert.rejects(enable({ home: f.home, execute: true, planDigest: plan.planDigest, consent: CONSENT }, f.context), /onboarding-plan-changed/);
  const again = await planEnable({ home: f.home }, f.context); writeFileSync(f.executable, 'changed');
  await assert.rejects(enable({ home: f.home, execute: true, planDigest: again.planDigest, consent: CONSENT }, f.context), /onboarding-plan-changed/);
  assert.equal(existsSync(f.home), false); assert.equal(f.calls.length, 0);
  for (const dailySeconds of [59, 7201, 1.5, NaN]) await assert.rejects(planEnable({ home: f.home, dailySeconds }, f.context));
});
test('enable/disable on each OS retains queue, results, receipts and random device id', async () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = fixture(platform); const plan = await apply(f, { dailySeconds: 120 });
    const config = JSON.parse(readFileSync(join(f.home, 'daily.json'), 'utf8'));
    assert.equal(config.onboarding.planDigest, plan.planDigest); assert.match(config.onboarding.deviceId, /^[a-f0-9-]{36}$/);
    assert.equal(config.enabled, true);
    using db = openStore(join(f.home, 'queue.sqlite3')); assert.equal(dailyBudgetLimit(db), 120);
    mkdirSync(join(f.home, 'semantic-results')); writeFileSync(join(f.home, 'semantic-results', 'keep.txt'), 'keep');
    const before = readFileSync(join(f.home, 'queue.sqlite3'));
    const status = await onboardingStatus(f.home, f.context); assert.equal(status.onboarding?.enabled, true);
    assert.equal(status.schedule.installed, true); assert.equal(status.itemsWaitingForReview, 0);
    assert.equal((await disable(f.home, false, f.context)).writes, false);
    await disable(f.home, true, f.context);
    assert.deepEqual(readFileSync(join(f.home, 'queue.sqlite3')), before);
    assert.equal(readFileSync(join(f.home, 'semantic-results', 'keep.txt'), 'utf8'), 'keep');
    assert.equal((await onboardingStatus(f.home, f.context)).onboarding?.enabled, false);
    await disable(f.home, true, f.context);
    await apply(f, { dailySeconds: 120 });
    assert.equal(JSON.parse(readFileSync(join(f.home, 'device-id.json'), 'utf8')), config.onboarding.deviceId);
  }
});
test('Cowork is an opt-in, one-time import using existing capture and slice verification', async () => {
  const f = fixture(); await apply(f, { sources: ['code', 'cowork-import'] });
  const config = JSON.parse(readFileSync(join(f.home, 'daily.json'), 'utf8'));
  config.capture.reserveBytes = 1;
  const captured = runCapture(config.capture, f.home, true); assert.ok('errors' in captured); assert.equal(captured.errors, 0);
  assert.equal(prepareSlices(f.home, [], 16000, true).state, 'prepared');
  await apply(f, { sources: ['code', 'cowork-import'] });
  assert.equal(readdirSync(join(f.home, 'cowork-import')).length, 1);
  const again = runCapture(config.capture, f.home, true); assert.ok('errors' in again); assert.equal(again.errors, 0);
  using db = openStore(join(f.home, 'queue.sqlite3'));
  assert.equal((db.query('SELECT count(*) AS n FROM jobs').get() as { n: number }).n, 1);
});
test('status and review count work before onboarding without creating a home', async () => {
  const f = fixture(); const status = await onboardingStatus(f.home, f.context);
  assert.equal(status.onboarding, null); assert.equal(status.lastRun, null); assert.equal(status.budgetUsedToday, 0);
  assert.equal(status.schemaVersion, 1); assert.equal(status.productionEnabled, false);
  assert.equal(reviewCount(f.home), 0); assert.equal(existsSync(f.home), false);
});
test('resolution uses explicit override, then injected user directory, then installed directory', async () => {
  const f = fixture(); const secondDir = join(f.context.env.LOCALAPPDATA!, 'Programs', 'claude'); mkdirSync(secondDir, { recursive: true });
  const second = join(secondDir, 'claude.exe'); writeFileSync(second, 'second');
  assert.equal((await resolveClaudeCli(undefined, f.context)).path, f.executable);
  assert.equal((await resolveClaudeCli(second, f.context)).sha256, hash('second'));
  rmSync(f.executable); assert.equal((await resolveClaudeCli(undefined, f.context)).path, second);
  await assert.rejects(resolveClaudeCli(join(f.root, 'missing.exe'), f.context), /provider-cli-not-found/);
  const mac = fixture('darwin'); assert.equal((await resolveClaudeCli(undefined, mac.context)).path, mac.executable);
  // The native installer's locations come first; a global npm install's executable is the fallback.
  assert.deepEqual(claudeCliCandidates(undefined, mac.context).slice(0, 3), [mac.executable, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
  const forward = (path: string) => path.replaceAll(String.fromCharCode(92), '/');
  assert.ok(claudeCliCandidates(undefined, mac.context).slice(3).every((path) => forward(path).endsWith('@anthropic-ai/claude-code/bin/claude')));
  const windows = claudeCliCandidates(undefined, { platform: 'win32', env: { APPDATA: 'C:/Users/x/AppData/Roaming' } });
  assert.ok(forward(windows.at(-1)!).endsWith('npm/node_modules/@anthropic-ai/claude-code/bin/claude.exe'));
  assert.deepEqual(claudeCliCandidates(second, f.context), [second]);
});

async function scheduledFixture() {
  const f = fixture(); await apply(f);
  const path = join(f.home, 'daily.json'); const config = JSON.parse(readFileSync(path, 'utf8'));
  config.adapters = { providers: { claude: { executable: f.executable, executableSha256: hash('fake cli, never executed'),
    version: 'fixture', model: 'fixture', authHome: join(f.root, 'auth'),
    capabilityReceipt: { path: join(f.root, 'cap.json'), sha256: 'a'.repeat(64) },
    liveProfileReceipt: { path: join(f.root, 'live.json'), sha256: 'b'.repeat(64) } } } };
  writeFileSync(path, JSON.stringify(config));
  const deps: ScheduledDeps = { now: () => now, cliEnvironment: f.context,
    identity: async () => ({ platform: 'windows', pid: 10, creationFiletime: '123', machineIdSha256: 'a'.repeat(64) }),
    ownerState: async () => 'alive', providerPreflight: async () => ({}),
    daily: async () => ({ state: 'pending-review', modelCalls: 1, attempts: [] }) };
  return { ...f, path, deps, input: { home: f.home, configPath: path, mode: 'run' as const } };
}
test('one run writes binary fingerprint, budget and exit receipt; another run is exit 2', async () => {
  const f = await scheduledFixture(); const result = await runScheduled(f.input, f.deps);
  assert.equal(result.exitCode, 0); assert.equal(result.resolvedCli?.sha256, hash('fake cli, never executed'));
  assert.equal(result.resolvedCli?.size, Buffer.byteLength('fake cli, never executed'));
  const receipt = JSON.parse(readFileSync(join(f.home, 'runs', result.runId + '.json'), 'utf8'));
  assert.equal(receipt.budgetBefore, 0); assert.equal(receipt.budgetAfter, 0); assert.equal(receipt.errorClass, null);
  assert.equal((await runScheduled(f.input, f.deps)).exitCode, 2);
  assert.ok((await onboardingStatus(f.home, f.context)).lastRun);
});
test('scheduled and run-once core classify idle, lock, quota, integrity and other errors', async () => {
  for (const [state, exitCode] of [['idle', 2], ['paused-quota', 4], ['containment-unresolved', 3], ['invalid-output-or-source', 3], ['interrupted-unknown', 1]] as const) {
    const f = await scheduledFixture();
    assert.equal((await runScheduled(f.input, { ...f.deps, daily: async () => ({ state, modelCalls: 0 }) })).exitCode, exitCode);
  }
  const f = await scheduledFixture(); writeFileSync(join(f.home, 'scheduler.lock'), JSON.stringify({ schemaVersion: 1, runId: randomUUID(), acquiredAt: now.toISOString(), owner: {} }));
  assert.equal((await runScheduled(f.input, f.deps)).exitCode, 2);
  const g = await scheduledFixture();
  assert.equal((await runScheduled(g.input, { ...g.deps, daily: async () => { throw new Error('registry-integrity'); } })).exitCode, 3);
});
test('upgraded executable is inventoried but binding still requires reapproval', async () => {
  const f = await scheduledFixture(); writeFileSync(f.executable, 'upgrade');
  const result = await runScheduled(f.input, f.deps);
  assert.equal(result.exitCode, 1); assert.equal(result.errorClass, 'provider-executable-changed');
  assert.equal(result.resolvedCli?.sha256, hash('upgrade'));
  const config = JSON.parse(readFileSync(f.path, 'utf8'));
  await assert.rejects(runDaily(config, f.home, false, undefined, { cliEnvironment: f.context }), /provider-executable-changed/);
});
test('new user enables schedule but no provider proof is fabricated', async () => {
  const f = fixture(); await apply(f);
  const result = await runScheduled({ home: f.home, configPath: join(f.home, 'daily.json'), mode: 'run' },
    { cliEnvironment: f.context, identity: async () => ({ platform: 'windows', pid: 10, creationFiletime: '123', machineIdSha256: 'a'.repeat(64) }) });
  assert.equal(result.errorClass, 'provider-approval-required'); assert.equal(result.exitCode, 1);
});
test('budget config uses existing ledger and preserves spent reservations when limit changes', async () => {
  const f = fixture(); await apply(f, { dailySeconds: 7200 });
  { using db = openStore(join(f.home, 'queue.sqlite3'), { readonly: false });
    assert.equal(dailyBudgetLimit(db), 7200); db.query('INSERT INTO semantic_budget VALUES(?,?)').run('2026-10-07', 600); }
  configureDailyBudget(f.home, 60);
  using db = openStore(join(f.home, 'queue.sqlite3')); assert.equal(dailyBudgetLimit(db), 60);
  assert.equal((db.query('SELECT seconds FROM semantic_budget').get() as { seconds: number }).seconds, 600);
});

test('corpus reservations obey the configured pilot budget below and above the old default', async () => {
  for (const limit of [60, 7200]) {
    const f = fixture(); await apply(f, { dailySeconds: limit });
    const config = JSON.parse(readFileSync(join(f.home, 'daily.json'), 'utf8')); config.capture.reserveBytes = 1;
    const source = join(f.config, 'projects', 'session-folder', 'session.jsonl');
    writeFileSync(source, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Keep synthetic fixtures local.' } }) + '\n');
    let calls = 0;
    const runner: ModelRunner = async request => { calls++; return { state: 'output', durationMs: 1, completionProof: 'synthetic-fixture',
      output: { schemaVersion: 1, sliceId: request.slice.sliceId, coverage: coverage(request.slice), disposition: 'no-durable-findings', observations: [] } }; };
    if (limit === 7200) {
      using db = openStore(join(f.home, 'queue.sqlite3'), { readonly: false });
      db.query('INSERT INTO semantic_budget VALUES(?,?)').run(now.toISOString().slice(0, 10), 1800);
    }
    await runDaily(config, f.home, true, runner, { synthetic: true, now: now.getTime() / 1000, cliEnvironment: f.context });
    assert.equal(calls, 1);
    using db = openStore(join(f.home, 'queue.sqlite3'));
    assert.equal((db.query('SELECT seconds FROM semantic_budget').get() as { seconds: number }).seconds, limit === 60 ? 60 : 2100);
    if (limit === 60) {
      writeFileSync(join(f.config, 'projects', 'session-folder', 'second.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'Another synthetic fixture.' } }) + '\n');
      assert.equal((await runDaily(config, f.home, true, runner, { synthetic: true, now: now.getTime() / 1000, cliEnvironment: f.context })).state, 'paused-budget');
      assert.equal(calls, 1);
    }
  }
});

test('failed scheduler install leaves config disabled and a retry preserves the device id', async () => {
  const f = fixture(); const plan = await planEnable({ home: f.home }, f.context);
  await assert.rejects(enable({ home: f.home, execute: true, planDigest: plan.planDigest, consent: CONSENT },
    { ...f.context, runner: async () => ({ exitCode: 5, stdout: '', stderr: '' }) }), /onboarding-schedule-install-failed/);
  const failed = JSON.parse(readFileSync(join(f.home, 'daily.json'), 'utf8'));
  assert.equal(failed.enabled, false); assert.equal(existsSync(join(f.home, 'onboarding.lock')), false);
  await apply(f); assert.equal(JSON.parse(readFileSync(join(f.home, 'device-id.json'), 'utf8')), failed.onboarding.deviceId);
});

test('CLI run --once and scheduled use exit 2 for a disabled config; review count is one number', async () => {
  const f = fixture(); await apply(f); await disable(f.home, true, f.context);
  const cli = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
  const env = { ...process.env, HOME: f.root, USERPROFILE: f.root, APPDATA: f.root, LOCALAPPDATA: f.root };
  for (const args of [['run', '--once'], ['scheduled', '--mode', 'run', '--config', join(f.home, 'daily.json')]]) {
    const result = spawnSync(process.execPath, [cli, ...args, '--home', f.home], { encoding: 'utf8', env });
    assert.equal(result.status, 2, result.stderr); assert.equal(JSON.parse(result.stdout).reason, 'disabled');
  }
  const count = spawnSync(process.execPath, [cli, 'review', 'count', '--home', f.home], { encoding: 'utf8', env });
  assert.equal(count.status, 0); assert.equal(count.stdout.trim(), '0');
});
