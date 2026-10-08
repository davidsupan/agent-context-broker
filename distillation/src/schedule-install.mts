import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { noLinks } from './store.mts';

export const LABEL = 'com.agent-context-broker.distill';
export const TASK = 'AgentContextBroker-Distill';
export type CommandRunner = (executable: string, args: string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
export type ScheduleContext = { platform: 'darwin' | 'win32'; nodePath: string; cliPath: string;
  launchAgentsDir?: string; uid?: number; launchctlPath?: string; powershellPath?: string };
export type SchedulePlan = { platform: 'darwin' | 'win32'; home: string; time: string; name: string;
  path: string; content: string; programArguments: string[]; executable: string; installArgs: string[]; removeArgs: string[]; statusArgs: string[] };
const xml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const ps = (s: string) => "'" + s.replaceAll("'", "''") + "'";
// Windows command-line quoting for the task action (never passed to a shell).
export const windowsArgument = (s: string) => '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';

export function planSchedule(home: string, configPath: string, context: ScheduleContext, time = '09:15'): SchedulePlan {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('onboarding-schedule-time');
  for (const path of [home, configPath, context.nodePath, context.cliPath]) {
    if (!isAbsolute(path) || /[\x00-\x1f]/.test(path)) throw new Error('onboarding-schedule-path');
  }
  const programArguments = [context.nodePath, context.cliPath, 'scheduled', '--mode', 'run', '--home', home, '--config', configPath];
  if (context.platform === 'darwin') {
    if (!context.launchAgentsDir || !isAbsolute(context.launchAgentsDir) || !Number.isInteger(context.uid) || context.uid! < 0)
      throw new Error('onboarding-schedule-context');
    const path = join(context.launchAgentsDir, LABEL + '.plist');
    const domain = `gui/${context.uid}`;
    const [hour, minute] = time.split(':').map(Number);
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array>${programArguments.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${xml(join(home, 'logs', 'scheduled.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(home, 'logs', 'scheduled.err.log'))}</string>
</dict></plist>
`;
    return { platform: context.platform, home, time, name: LABEL, path, content, programArguments,
      executable: context.launchctlPath ?? '/bin/launchctl', installArgs: ['bootstrap', domain, path],
      removeArgs: ['bootout', domain + '/' + LABEL], statusArgs: ['print', domain + '/' + LABEL] };
  }
  if (!context.powershellPath || !isAbsolute(context.powershellPath)) throw new Error('onboarding-schedule-context');
  const path = join(home, 'schedule', 'task.ps1');
  // Windows PowerShell 5 needs a BOM to interpret non-ASCII paths as UTF-8.
  const content = `\uFEFFparam([ValidateSet('install','remove','status')][string]$Action)
$ErrorActionPreference = 'Stop'
$name = '${TASK}'
$existing = Get-ScheduledTask -TaskPath '\\' | Where-Object { $_.TaskName -eq $name }
if ($Action -eq 'remove') {
  if ($existing) { Unregister-ScheduledTask -TaskPath '\\' -TaskName $name -Confirm:$false }
} elseif ($Action -eq 'status') {
  if (!$existing) { @{ installed = $false; nextRun = $null; lastResult = $null } | ConvertTo-Json -Compress }
  else {
    $info = Get-ScheduledTaskInfo -TaskPath '\\' -TaskName $name
    @{ installed = $true; nextRun = $info.NextRunTime.ToString('o'); lastResult = $info.LastTaskResult } | ConvertTo-Json -Compress
  }
} else {
  $taskAction = New-ScheduledTaskAction -Execute ${ps(context.nodePath)} -Argument ${ps(programArguments.slice(1).map(windowsArgument).join(' '))}
  $trigger = New-ScheduledTaskTrigger -Daily -At ${ps(time)}
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 45)
  Register-ScheduledTask -TaskPath '\\' -TaskName $name -Action $taskAction -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
}
`;
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path, '-Action'];
  return { platform: context.platform, home, time, name: TASK, path, content, programArguments,
    executable: context.powershellPath, installArgs: [...args, 'install'], removeArgs: [...args, 'remove'], statusArgs: [...args, 'status'] };
}

export async function scheduleStatus(plan: SchedulePlan, runner: CommandRunner, now = new Date()) {
  noLinks(plan.path);
  if (plan.platform === 'win32' && !existsSync(plan.path)) return { installed: false, nextRun: null, lastResult: null };
  if (plan.platform === 'win32' && readFileSync(plan.path, 'utf8') !== plan.content) throw new Error('onboarding-schedule-integrity');
  const result = await runner(plan.executable, plan.statusArgs);
  if (plan.platform === 'win32') {
    if (result.exitCode !== 0) throw new Error('onboarding-schedule-status-failed');
    const value = JSON.parse(result.stdout);
    if (typeof value.installed !== 'boolean') throw new Error('onboarding-schedule-status-invalid');
    return { installed: value.installed as boolean, nextRun: value.nextRun as string | null, lastResult: value.lastResult as number | null };
  }
  if (result.exitCode !== 0) {
    if (result.exitCode !== 113 && !/could not find service/i.test(result.stderr)) throw new Error('onboarding-schedule-status-failed');
    return { installed: false, nextRun: null, lastResult: null };
  }
  const next = new Date(now); const [hour, minute] = plan.time.split(':').map(Number);
  next.setHours(hour!, minute!, 0, 0); if (next <= now) next.setDate(next.getDate() + 1);
  return { installed: true, nextRun: next.toISOString(), nextRunEstimated: true,
    lastResult: /last exit code = (-?\d+)/.test(result.stdout) ? Number(/last exit code = (-?\d+)/.exec(result.stdout)![1]) : null };
}

export async function installSchedule(plan: SchedulePlan, runner: CommandRunner) {
  noLinks(plan.path);
  const state = plan.platform === 'win32' && existsSync(plan.path) && readFileSync(plan.path, 'utf8') !== plan.content
    ? { installed: false } : await scheduleStatus(plan, runner);
  if (state.installed && existsSync(plan.path) && readFileSync(plan.path, 'utf8') === plan.content) return;
  if (state.installed && plan.platform === 'darwin') {
    if ((await runner(plan.executable, plan.removeArgs)).exitCode !== 0) throw new Error('onboarding-schedule-remove-failed');
  }
  for (const path of [plan.path, join(plan.home, 'logs')]) noLinks(path);
  mkdirSync(dirname(plan.path), { recursive: true, mode: 0o700 }); mkdirSync(join(plan.home, 'logs'), { recursive: true, mode: 0o700 });
  writeFileSync(plan.path, plan.content, { mode: 0o600 });
  if ((await runner(plan.executable, plan.installArgs)).exitCode !== 0) throw new Error('onboarding-schedule-install-failed');
}

export async function removeSchedule(plan: SchedulePlan, runner: CommandRunner) {
  if ((await scheduleStatus(plan, runner)).installed && (await runner(plan.executable, plan.removeArgs)).exitCode !== 0)
    throw new Error('onboarding-schedule-remove-failed');
  noLinks(plan.path); if (existsSync(plan.path)) unlinkSync(plan.path);
}
