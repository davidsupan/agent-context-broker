import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSchedule, installSchedule, removeSchedule, scheduleStatus, LABEL, type CommandRunner } from '../src/schedule-install.mts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(platform: 'darwin' | 'win32') {
  const root = mkdtempSync(join(tmpdir(), 'schedule-test-')); roots.push(root);
  const home = join(root, 'runtime space');
  const plan = planSchedule(home, join(home, 'daily.json'), { platform, nodePath: join(root, 'node & runtime'),
    cliPath: join(root, 'entry space', 'cli.mts'), launchAgentsDir: join(root, 'agents'), uid: 123,
    launchctlPath: join(root, 'launchctl'), powershellPath: join(root, 'powershell.exe') });
  return { root, home, plan };
}
const normalized = (value: string, root: string) => value.replace(/^\uFEFF/, '').replaceAll(root, '<ROOT>').replaceAll('\\', '/');
test('LaunchAgent and Windows script match portable golden files', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const f = fixture(platform);
    if (platform === 'win32') assert.equal(f.plan.content.charCodeAt(0), 0xfeff);
    assert.equal(normalized(f.plan.content, f.root), readFileSync(new URL(`./golden/schedule-${platform}.txt`, import.meta.url), 'utf8').replaceAll('\r\n', '\n'));
    assert.equal(existsSync(f.home), false);
  }
});
test('mac install/status/remove argv are exact, idempotent, and paths stay single arguments', async () => {
  const f = fixture('darwin'); let installed = false; const calls: Array<[string, string[]]> = [];
  const runner: CommandRunner = async (executable, args) => {
    calls.push([executable, args]);
    if (args[0] === 'print') return { exitCode: installed ? 0 : 113, stdout: 'last exit code = 0', stderr: '' };
    installed = args[0] === 'bootstrap'; return { exitCode: 0, stdout: '', stderr: '' };
  };
  await installSchedule(f.plan, runner); await installSchedule(f.plan, runner);
  const state = await scheduleStatus(f.plan, runner, new Date('2026-10-07T12:00:00'));
  assert.equal(state.installed, true); assert.equal(state.lastResult, 0); assert.ok(state.nextRun);
  await removeSchedule(f.plan, runner); await removeSchedule(f.plan, runner);
  assert.deepEqual(calls, [
    [f.plan.executable, ['print', `gui/123/${LABEL}`]], [f.plan.executable, ['bootstrap', 'gui/123', f.plan.path]],
    [f.plan.executable, ['print', `gui/123/${LABEL}`]], [f.plan.executable, ['print', `gui/123/${LABEL}`]],
    [f.plan.executable, ['print', `gui/123/${LABEL}`]], [f.plan.executable, ['bootout', `gui/123/${LABEL}`]],
    [f.plan.executable, ['print', `gui/123/${LABEL}`]],
  ]);
  assert.equal(existsSync(f.plan.path), false);
});
test('Windows runner receives only script file argv, queries actual task info, and removes idempotently', async () => {
  const f = fixture('win32'); let installed = false; const calls: Array<[string, string[]]> = [];
  const runner: CommandRunner = async (exe, args) => {
    calls.push([exe, args]);
    if (args.at(-1) === 'status') return { exitCode: 0, stdout: JSON.stringify({ installed, nextRun: installed ? 'tomorrow' : null, lastResult: installed ? 0 : null }), stderr: '' };
    installed = args.at(-1) === 'install'; return { exitCode: 0, stdout: '', stderr: '' };
  };
  await installSchedule(f.plan, runner); await installSchedule(f.plan, runner);
  assert.equal((await scheduleStatus(f.plan, runner)).lastResult, 0);
  await removeSchedule(f.plan, runner); await removeSchedule(f.plan, runner);
  const argv = (action: string) => [f.plan.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f.plan.path, '-Action', action]];
  assert.deepEqual(calls, [argv('install'), argv('status'), argv('status'), argv('status'), argv('remove')]);
});
test('tampered Windows script is never executed; runner errors do not pretend installation succeeded', async () => {
  const f = fixture('win32'); mkdirSync(join(f.home, 'schedule'), { recursive: true }); writeFileSync(f.plan.path, 'unexpected');
  const forbidden: CommandRunner = async () => { assert.fail('must not execute a tampered file'); };
  await assert.rejects(scheduleStatus(f.plan, forbidden), /onboarding-schedule-integrity/);
  await assert.rejects(removeSchedule(f.plan, forbidden), /onboarding-schedule-integrity/);
  rmSync(f.plan.path);
  await assert.rejects(installSchedule(f.plan, async () => ({ exitCode: 5, stdout: '', stderr: '' })), /onboarding-schedule-install-failed/);
});
test('invalid time and relative program paths are rejected before any runner call', () => {
  const f = fixture('darwin');
  for (const time of ['24:00', '9:15', '09:60', '09:15; command']) assert.throws(() => planSchedule(f.home, join(f.home, 'daily.json'),
    { platform: 'darwin', nodePath: join(f.root, 'node'), cliPath: join(f.root, 'cli.mts'), uid: 123, launchAgentsDir: join(f.root, 'agents') }, time));
});
