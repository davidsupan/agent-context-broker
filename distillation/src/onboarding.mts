import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DailyConfig } from './daily.mts';
import { resolveClaudeCli, type CliEnvironment } from './claude-cli.mts';
import { canonical, digest } from './slicing.mts';
import { sha256 } from './capture.mts';
import { coworkDialogue, readCoworkCapture } from './cowork-capture.mts';
import { configureDailyBudget } from './pilot-budget.mts';
import { noLinks, openStore, status } from './store.mts';
import { Database } from './sqlite.mts';
import { DailySeconds } from './schemas.mts';
import { reviewStats } from './review.mts';
import { OWNER } from './scheduled.mts';
import { installSchedule, removeSchedule, planSchedule, scheduleStatus, type ScheduleContext, type CommandRunner } from './schedule-install.mts';

export const CONSENT = 'distill my sessions on this device';
export type OnboardingContext = CliEnvironment & { schedule: ScheduleContext; claudeConfigDir: string;
  coworkExportPath?: string; runner: CommandRunner; now?: () => Date };
export type EnableInput = { home: string; dailySeconds?: number; claudeCli?: string; sources?: string[];
  time?: string; execute?: boolean; planDigest?: string; consent?: string; providerConfigPath?: string };
const registry = canonical({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });

export function readLocalJson(path: string): unknown {
  noLinks(path); const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error('onboarding-config-limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}
function writeJson(path: string, value: unknown) {
  noLinks(path); const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, canonical(value) + '\n', { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, path); } finally { if (existsSync(temp)) unlinkSync(temp); }
}
function configAt(home: string) { return join(home, 'daily.json'); }
function currentConfig(home: string) {
  const path = configAt(home); noLinks(path);
  return existsSync(path) ? DailyConfig.parse(readLocalJson(path)) : null;
}
function reviewCount(home: string) { return reviewStats(home).open; }
export { reviewCount };

export async function planEnable(input: EnableInput, context: OnboardingContext) {
  if (!isAbsolute(input.home) || !isAbsolute(context.claudeConfigDir)) throw new Error('onboarding-path-not-absolute');
  const home = resolve(input.home); noLinks(home);
  const existing = currentConfig(home);
  const sources = z.array(z.enum(['code', 'cowork-import'])).min(1).parse(input.sources ?? existing?.onboarding?.sources ?? ['code']);
  const selected = [...new Set(sources)].sort();
  const dailySeconds = DailySeconds.parse(input.dailySeconds ?? existing?.dailySeconds ?? 1800);
  const root = join(context.claudeConfigDir, 'projects'); noLinks(root);
  const folders = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory()).length : 0;
  let cowork = null;
  if (context.coworkExportPath) {
    noLinks(context.coworkExportPath);
    if (existsSync(context.coworkExportPath)) cowork = readCoworkCapture(context.coworkExportPath);
  }
  if (selected.includes('cowork-import') && !cowork) throw new Error('onboarding-cowork-export-missing');
  const claudeCli = input.claudeCli ?? existing?.claudeCli;
  const resolvedCli = await resolveClaudeCli(claudeCli, context);
  const supplied = input.providerConfigPath ? DailyConfig.parse(readLocalJson(input.providerConfigPath)) : existing;
  const config = DailyConfig.parse({
    ...(supplied ?? {}), enabled: true, ...(claudeCli ? { claudeCli } : {}), dailySeconds,
    capture: { ...(supplied?.capture ?? {}), providerRoots: {
      ...(selected.includes('code') ? { 'claude-code': root } : {}),
      ...(selected.includes('cowork-import') ? { 'cowork-import': join(home, 'cowork-import') } : {}) },
      allowInitialRootBinding: true,
      historyRegistry: supplied?.capture.historyRegistry ?? { path: join(home, 'history-registry.json'), sha256: sha256(registry) } },
    semantic: { ...(supplied?.semantic ?? {}), claudeAvailable: true, codexAvailable: false,
      attemptSeconds: Math.min(300, dailySeconds) },
    maxModelCalls: Math.ceil(dailySeconds / Math.min(300, dailySeconds)) });
  delete config.onboarding;
  // An onboarding approval is not a publication approval or a provider receipt.
  delete config.broker;
  if (config.adapters && Object.keys(config.adapters.providers).some(key => key !== 'claude')) throw new Error('onboarding-provider-policy');
  const schedule = planSchedule(home, configAt(home), context.schedule, input.time ?? existing?.onboarding?.scheduleTime ?? '09:15');
  const devicePath = join(home, 'device-id.json'); noLinks(devicePath);
  const deviceId = existsSync(devicePath) ? z.uuid().parse(readLocalJson(devicePath)) : null;
  const importPath = cowork ? join(home, 'cowork-import', cowork.fileSha256 + '.jsonl') : null;
  const body = { state: 'plan', writes: false, version: 1, action: 'enable', home, sources: { code: { folders, selected: selected.includes('code') },
    coworkImport: { exports: cowork ? 1 : 0, rows: cowork?.capture.rows.length ?? 0, selected: selected.includes('cowork-import'), oneTime: true } },
    selected, dailySeconds, resolvedCli, schedule, config, previousConfigSha256: existing ? digest(existing) : null, deviceId,
    coworkSha256: selected.includes('cowork-import') ? cowork?.fileSha256 ?? null : null,
    providerReady: false,
    providerApproval: config.adapters?.providers.claude?.liveProfileReceipt ? 'configured-unverified' : 'missing',
    providerBlockers: [
      ...(!config.adapters?.providers.claude?.liveProfileReceipt ? ['provider-approval-required'] : []),
      ...(context.platform === 'win32' ? ['provider-windows-containment-unavailable'] : [])],
    files: [configAt(home), devicePath, join(home, 'scheduler-owner.json'), join(home, 'queue.sqlite3'), schedule.path,
      ...(supplied ? [] : [join(home, 'history-registry.json')]),
      ...(selected.includes('cowork-import') && importPath ? [importPath, join(home, 'cowork-import-receipt.json')] : [])] };
  return { ...body, planDigest: digest(body) };
}

export async function enable(input: EnableInput, context: OnboardingContext) {
  if (input.execute && input.consent !== CONSENT) throw new Error('onboarding-consent-required');
  let plan;
  try { plan = await planEnable(input, context); }
  catch (error) { if (input.execute) throw new Error('onboarding-plan-changed'); throw error; }
  if (!input.execute) return plan;
  if (input.planDigest !== plan.planDigest) throw new Error('onboarding-plan-changed');
  const home = plan.home;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Serialize apply; stale locks require explicit inspection, never silent reclamation.
  const lock = join(home, 'onboarding.lock'); noLinks(lock);
  writeFileSync(lock, plan.planDigest, { flag: 'wx', mode: 0o600 });
  try {
    const checked = await planEnable(input, context);
    if (checked.planDigest !== plan.planDigest) throw new Error('onboarding-plan-changed');
    const deviceId = plan.deviceId ?? randomUUID();
    if (!plan.deviceId) writeJson(join(home, 'device-id.json'), deviceId);
    if (plan.files.includes(join(home, 'history-registry.json'))) {
      noLinks(join(home, 'history-registry.json')); writeFileSync(join(home, 'history-registry.json'), registry, { mode: 0o600 });
    }
    if (plan.selected.includes('cowork-import')) {
      const imported = readCoworkCapture(context.coworkExportPath!);
      if (imported.fileSha256 !== plan.coworkSha256) throw new Error('onboarding-plan-changed');
      const directory = join(home, 'cowork-import'); noLinks(directory); mkdirSync(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, imported.fileSha256 + '.jsonl'); noLinks(path);
      const text = coworkDialogue(imported.capture).map(row => canonical({ type: row.role, message: { role: row.role, content: row.text } })).join('\n') + '\n';
      if (existsSync(path) && readFileSync(path, 'utf8') !== text) throw new Error('onboarding-import-integrity');
      if (!existsSync(path)) writeFileSync(path, text, { flag: 'wx', mode: 0o600 });
      writeJson(join(home, 'cowork-import-receipt.json'), { schemaVersion: 1, fileSha256: imported.fileSha256, rows: imported.capture.rows.length });
    }
    configureDailyBudget(home, plan.dailySeconds);
    const enabledAt = (context.now?.() ?? new Date()).toISOString();
    const config = { ...plan.config, enabled: false, onboarding: { version: 1, planDigest: plan.planDigest,
      enabledAt, deviceId, sources: plan.selected, scheduleTime: plan.schedule.time } };
    // Fail closed if OS installation fails or the process stops midway.
    writeJson(configAt(home), config);
    writeJson(join(home, 'scheduler-owner.json'), { schemaVersion: 1, owner: OWNER, since: enabledAt, approvedBy: 'operator' });
    await installSchedule(plan.schedule, context.runner);
    writeJson(configAt(home), { ...config, enabled: true });
    return { state: 'enabled', writes: true, planDigest: plan.planDigest, deviceId, providerReady: plan.providerReady, providerBlockers: plan.providerBlockers };
  } finally { unlinkSync(lock); }
}

export async function disable(home: string, execute: boolean, context: OnboardingContext) {
  noLinks(home); const config = currentConfig(home);
  const schedule = planSchedule(resolve(home), configAt(resolve(home)), context.schedule, config?.onboarding?.scheduleTime);
  if (!execute) return { state: 'plan', writes: false, action: 'disable', schedule, files: config ? [configAt(home), schedule.path] : [schedule.path] };
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'onboarding.lock'); noLinks(lock); writeFileSync(lock, 'disable', { flag: 'wx', mode: 0o600 });
  try {
    const current = currentConfig(home);
    // Disable first, so a removal failure cannot leave an active unattended run.
    if (current) writeJson(configAt(home), { ...current, enabled: false,
      ...(current.onboarding ? { onboarding: { ...current.onboarding, disabledAt: (context.now?.() ?? new Date()).toISOString() } } : {}) });
    await removeSchedule(planSchedule(resolve(home), configAt(resolve(home)), context.schedule, current?.onboarding?.scheduleTime), context.runner);
    return { state: 'disabled', writes: true };
  } finally { unlinkSync(lock); }
}

export async function onboardingStatus(home: string, context: OnboardingContext) {
  const config = currentConfig(home); const path = join(home, 'queue.sqlite3'); noLinks(path);
  // In-memory status preserves the old fields even before a queue exists.
  using db = existsSync(path) ? openStore(path) : new Database(':memory:');
  const existing = status(db);
  const schedule = planSchedule(resolve(home), configAt(resolve(home)), context.schedule, config?.onboarding?.scheduleTime);
  let resolvedCli;
  try { resolvedCli = await resolveClaudeCli(config?.claudeCli, context); }
  catch (error) { resolvedCli = { code: error instanceof Error ? error.message : 'provider-cli-not-found' }; }
  const directory = join(home, 'runs'); noLinks(directory);
  const receipts = existsSync(directory) ? readdirSync(directory).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(name => readLocalJson(join(directory, name)) as { startedAt: string }) : [];
  return { ...existing, onboarding: config?.onboarding ? { ...config.onboarding, enabled: config.enabled === true } : null,
    schedule: await scheduleStatus(schedule, context.runner), lastRun: receipts.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1) ?? null,
    budgetUsedToday: existing.reservedSeconds, itemsWaitingForReview: reviewCount(home), resolvedCli };
}
