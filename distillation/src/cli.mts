import { parseArgs } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { z } from 'zod';
import { CaptureConfig, runCapture } from './capture.mts';
import { documentsReport } from './documents.mts';
import { DailyConfig, runDaily } from './daily.mts';
import { currentPinnableEnvironment, preflight } from './provider.mts';
import { noLinks } from './store.mts';
import { applyAutomatic, decide, decideBatch, listForReview, reviewHistory, reviewStats } from './review.mts';
import { runScheduled, scheduledExitCode } from './scheduled.mts';
import { describeLiveProbe, runLiveProbe, type LiveProbeOptions } from './capability-probe.mts';
import { liveProbeCoordinator } from './pilot-budget.mts';
import { addClaim, claimProposal, listClaims, markPublished, parseClaimsInput, revokeClaim } from './operator-claims.mts';
import { planCoworkCapture, type CoworkPlan } from './cowork-capture.mts';
import { stdinText } from './platform.mts';
import { enable, disable, onboardingStatus, reviewCount, type OnboardingContext } from './onboarding.mts';

/** OS boundary: core onboarding never reads ambient environment or starts commands. */
function onboardingContext(configDir?: string, coworkExport?: string): OnboardingContext {
  const env = { ...process.env };
  const platform = process.platform;
  if (platform !== 'darwin' && platform !== 'win32') throw new Error('onboarding-platform-unsupported');
  const userHome = platform === 'win32' ? env.USERPROFILE : env.HOME;
  if (!userHome) throw new Error('onboarding-home-unavailable');
  return { platform, env, claudeConfigDir: configDir ?? env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'),
    coworkExportPath: coworkExport ?? join(configDir ?? env.CLAUDE_CONFIG_DIR ?? join(userHome, '.claude'), 'cowork-history.json'),
    schedule: { platform, nodePath: process.execPath, cliPath: fileURLToPath(import.meta.url),
      ...(platform === 'darwin' ? { launchAgentsDir: join(userHome, 'Library', 'LaunchAgents'), uid: process.getuid?.() }
        : { powershellPath: join(env.SYSTEMROOT ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') }) },
    runner: (executable, args) => new Promise((resolve, reject) => {
      execFile(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && typeof error.code !== 'number') { reject(new Error('onboarding-schedule-runner-failed')); return; }
        resolve({ exitCode: error?.code as number ?? 0, stdout, stderr });
      });
    }) };
}

function readJson(path: string): unknown {
  noLinks(path);
  const bytes = readFileSync(path);
  if (bytes.length > 1024 * 1024) throw new Error('config-limit');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

// The approval file may carry a human note ("received"); only the contract fields bind.
const ApprovalFile = z.object({ id: z.string(), scope: z.enum(['one-synthetic-distillation-call', 'one-approved-slice-call']),
  providers: z.tuple([z.literal('claude')]), maxCalls: z.literal(1), timeoutPerProviderMs: z.literal(60000),
  globalBudgetSeconds: z.literal(1800), received: z.string().max(1000).optional() });

// A synthetic probe needs the synthetic approval scope; a real slice needs its own scope and the slice.
function probeOptions(configPath: string, approvalPath: string, home: string, slice?: unknown): LiveProbeOptions {
  const config = DailyConfig.parse(readJson(configPath));
  const binding = config.adapters?.providers.claude;
  if (!binding) throw new Error('probe-claude-binding-missing');
  const { received: _, ...approval } = ApprovalFile.parse(readJson(approvalPath));
  return { provider: 'claude', executable: binding.executable, executableSha256: binding.executableSha256,
    version: binding.version, model: binding.model, home, authHome: binding.authHome,
    capabilityReceipt: binding.capabilityReceipt, purpose: slice ? 'approved-slice' : 'distillation',
    ...(slice ? { slice } : {}),
    ...(binding.environment ? { environment: binding.environment } : {}), approval } as LiveProbeOptions;
}

/** Counts and ids only; no captured text is printed. */
function coworkSummary(plan: CoworkPlan) {
  return { sourceKey: plan.sourceKey, captured: plan.captured, fileSha256: plan.fileSha256, jobId: plan.jobId,
    receiptSha256: plan.receiptSha256, rows: plan.rows, userRows: plan.userRows, assistantRows: plan.assistantRows,
    chars: plan.chars, slices: plan.plan.sliceCount, redactionKinds: plan.plan.redactionKinds,
    sliceChars: plan.plan.slices.map(s => s.segments.reduce((n, x) => n + x.endChar - x.startChar, 0)) };
}

let scheduledCommand = false;
try {
  const { values, positionals } = parseArgs({ options: { home: { type: 'string' },
    config: { type: 'string' }, execute: { type: 'boolean', default: false },
    approval: { type: 'string' }, describe: { type: 'boolean', default: false },
    mode: { type: 'string' }, 'codex-automation': { type: 'string' },
    token: { type: 'string' }, index: { type: 'string' }, 'output-sha256': { type: 'string' },
    decision: { type: 'string' }, reason: { type: 'string' }, 'expected-latest': { type: 'string' },
    all: { type: 'boolean', default: false }, limit: { type: 'string' },
    id: { type: 'string' }, 'source-token': { type: 'string' }, 'claims-root': { type: 'string' },
    file: { type: 'string' }, 'slice-chars': { type: 'string' },
    'daily-seconds': { type: 'string' }, 'claude-cli': { type: 'string' }, sources: { type: 'string' },
    'plan-digest': { type: 'string' }, consent: { type: 'string' }, once: { type: 'boolean' },
    'schedule-time': { type: 'string' }, 'claude-config-dir': { type: 'string' },
    'cowork-export': { type: 'string' }, 'provider-config': { type: 'string' } },
    allowPositionals: true });
  const command = positionals[0];
  scheduledCommand = command === 'run' || command === 'scheduled';
  // --claims-root reads an external claims folder (read-only); receipts stay under --home.
  const claimsAt = (home: string) => values['claims-root'] ? { home, claimsRoot: values['claims-root'] } : home;
  if (command === 'print-environment') {
    console.log(JSON.stringify(currentPinnableEnvironment()));
  } else if (!values.home) {
    throw new Error('command-and-home-required');
  } else if (command === 'status' && positionals.length === 1) {
    console.log(JSON.stringify(await onboardingStatus(values.home, onboardingContext(values['claude-config-dir'], values['cowork-export']))));
  } else if (command === 'enable' && positionals.length === 1) {
    console.log(JSON.stringify(await enable({ home: values.home, execute: values.execute,
      ...(values['daily-seconds'] !== undefined ? { dailySeconds: Number(values['daily-seconds']) } : {}),
      ...(values['claude-cli'] ? { claudeCli: values['claude-cli'] } : {}),
      ...(values.sources !== undefined ? { sources: values.sources.split(',') } : {}),
      ...(values['plan-digest'] ? { planDigest: values['plan-digest'] } : {}),
      ...(values.consent ? { consent: values.consent } : {}),
      ...(values['schedule-time'] ? { time: values['schedule-time'] } : {}),
      ...(values['provider-config'] ? { providerConfigPath: values['provider-config'] } : {}) },
    onboardingContext(values['claude-config-dir'], values['cowork-export']))));
  } else if (command === 'disable' && positionals.length === 1) {
    console.log(JSON.stringify(await disable(values.home, values.execute, onboardingContext(values['claude-config-dir'], values['cowork-export']))));
  } else if (command === 'review' && positionals[1] === 'count') {
    console.log(reviewCount(values.home));
  } else if (command === 'review' && positionals[1] === 'list') {
    console.log(JSON.stringify(listForReview(values.home, { includeDecided: values.all })));
  } else if (command === 'review' && positionals[1] === 'decide-batch') {
    const text = await stdinText();
    if (Buffer.byteLength(text) > 256 * 1024) throw new Error('review-batch-limit');
    console.log(JSON.stringify(decideBatch(values.home, JSON.parse(text))));
  } else if (command === 'review' && positionals[1] === 'history') {
    console.log(JSON.stringify(reviewHistory(values.home, values.limit === undefined ? {} : { limit: Number(values.limit) })));
  } else if (command === 'review' && positionals[1] === 'stats') {
    console.log(JSON.stringify(reviewStats(values.home)));
  } else if (command === 'review' && positionals[1] === 'auto') {
    console.log(JSON.stringify(applyAutomatic(values.home)));
  } else if (command === 'review' && positionals[1] === 'decide') {
    console.log(JSON.stringify(decide(values.home, { attemptToken: values.token ?? '',
      observationIndex: Number(values.index), outputSha256: values['output-sha256'] ?? '',
      decision: z.enum(['accept', 'reject', 'defer']).parse(values.decision),
      ...(values.reason ? { reason: values.reason } : {}),
      ...(values['expected-latest'] ? { expectedLatest: values['expected-latest'] } : {}) })));
  } else if (command === 'claims' && positionals[1] === 'add' && positionals.length === 2) {
    console.log(JSON.stringify(addClaim(claimsAt(values.home), parseClaimsInput(await stdinText()))));
  } else if (command === 'claims' && positionals[1] === 'list' && positionals.length === 2) {
    console.log(JSON.stringify(listClaims(claimsAt(values.home))));
  } else if (command === 'claims' && positionals[1] === 'revoke' && positionals.length === 2 && values.id) {
    console.log(JSON.stringify(revokeClaim(claimsAt(values.home), values.id, parseClaimsInput(await stdinText()))));
  } else if (command === 'claims' && positionals[1] === 'proposal' && positionals.length === 2 && values.id && values['source-token']) {
    console.log(JSON.stringify(claimProposal(claimsAt(values.home), values.id, values['source-token'])));
  } else if (command === 'claims' && positionals[1] === 'mark-published' && positionals.length === 2 && values.id) {
    console.log(JSON.stringify(markPublished(claimsAt(values.home), values.id, parseClaimsInput(await stdinText()))));
  } else if ((command === 'scheduled' && values.config) || (command === 'run' && values.once)) {
    const mode = command === 'run' ? 'run' : z.enum(['preflight-only', 'run']).parse(values.mode);
    const result = await runScheduled({ home: values.home, configPath: values.config ?? join(values.home, 'daily.json'), mode,
      ...(values['claude-cli'] ? { claudeCli: values['claude-cli'] } : {}),
      ...(values['codex-automation'] ? { codexAutomationPath: values['codex-automation'] } : {}) });
    console.log(JSON.stringify(result));
    process.exitCode = result.exitCode;
  } else if (command === 'probe-synthetic' && values.config && values.approval) {
    const options = probeOptions(values.config, values.approval, values.home);
    if (values.describe || !values.execute) {
      const described = await describeLiveProbe(options);
      console.log(JSON.stringify({ state: 'plan', invoked: false, environmentSha256: described.environmentSha256,
        argvProfileSha256: described.argvProfileSha256, reservationSeconds: described.reservationSeconds }));
    } else {
      const probe = await runLiveProbe(options, liveProbeCoordinator(values.home, options.approval.id));
      const path = join(probe.session, 'observation.json'); noLinks(path);
      writeFileSync(path, probe.receiptText, { flag: 'wx' });
      console.log(JSON.stringify({ state: 'observed', invoked: true, session: probe.session, receiptSha256: probe.receiptSha256,
        distillationValidated: probe.receipt.distillationValidated, exitCode: probe.receipt.exitCode,
        environmentSha256: probe.receipt.environmentSha256, argvProfileSha256: probe.receipt.argvProfileSha256 }));
    }
  } else if (command === 'cowork' && positionals[1] === 'plan' && values.file) {
    console.log(JSON.stringify(coworkSummary(planCoworkCapture(values.file, values['slice-chars'] ? Number(values['slice-chars']) : undefined))));
  } else if (command === 'probe-slice' && values.config && values.approval && values.file && values.index !== undefined) {
    // One operator-approved real slice through the probe path: same preflight, containment and shared budget.
    const plan = planCoworkCapture(values.file, values['slice-chars'] ? Number(values['slice-chars']) : undefined);
    const slice = plan.plan.slices[Number(values.index)];
    if (!slice) throw new Error('probe-slice-index');
    const options = probeOptions(values.config, values.approval, values.home, slice);
    if (values.describe || !values.execute) {
      const described = await describeLiveProbe(options);
      console.log(JSON.stringify({ state: 'plan', invoked: false, sourceKey: plan.sourceKey, sliceId: slice.sliceId,
        sliceIndex: Number(values.index), sliceChars: slice.segments.reduce((n, x) => n + x.endChar - x.startChar, 0),
        segments: slice.segments.length, environmentSha256: described.environmentSha256,
        argvProfileSha256: described.argvProfileSha256, reservationSeconds: described.reservationSeconds }));
    } else {
      const probe = await runLiveProbe(options, liveProbeCoordinator(values.home, options.approval.id));
      const path = join(probe.session, 'observation.json'); noLinks(path);
      writeFileSync(path, probe.receiptText, { flag: 'wx' });
      console.log(JSON.stringify({ state: 'observed', invoked: true, session: probe.session, receiptSha256: probe.receiptSha256,
        sliceId: slice.sliceId, outputValidated: probe.receipt.distillationValidated, exitCode: probe.receipt.exitCode,
        outputSha256: probe.receipt.outputSha256 }));
    }
  } else if (command === 'documents' && values.config && positionals.length === 1) {
    // Read-only inventory of a daily or capture config: counts only, never paths or content.
    const value = readJson(values.config);
    const daily = value && typeof value === 'object' && 'capture' in value ? DailyConfig.parse(value) : null;
    const capture = daily ? daily.capture : CaptureConfig.parse(value);
    const bindings = Object.values(daily?.adapters?.providers ?? {}).filter(binding => binding !== undefined);
    console.log(JSON.stringify(documentsReport(capture.documentSources, { home: values.home,
      providerRoots: Object.values(capture.providerRoots).filter(root => root !== undefined), registry: capture.historyRegistry.path,
      guard: { authHomes: bindings.map(binding => binding.authHome),
        receipts: bindings.flatMap(binding => [binding.capabilityReceipt.path, ...(binding.liveProfileReceipt ? [binding.liveProfileReceipt.path] : [])]) } })));
  } else if (command === 'preflight' && values.config) {
    const daily = DailyConfig.parse(readJson(values.config));
    if (!daily.adapters) throw new Error('adapter-config-missing');
    console.log(JSON.stringify(await preflight(daily.adapters, values.home)));
  } else if (['capture', 'daily'].includes(command!) && values.config && positionals.length === 1) {
    noLinks(values.config);
    const config: unknown = readJson(values.config);
    if (command === 'capture') {
      console.log(JSON.stringify(runCapture(config, values.home, values.execute)));
    } else {
      const daily = DailyConfig.parse(config);
      console.log(JSON.stringify(await runDaily(daily, values.home, values.execute, undefined, {
        ...(values['claude-cli'] ? { claudeCli: values['claude-cli'] } : {}),
        rereadConfig: () => readJson(values.config!)
      })));
    }
  } else { throw new Error('unknown-command'); }
} catch (error) {
  const code = error instanceof Error && /^(?:linked|onboarding|provider|artifact|capture|registry|slice|live-profile|source|native-file|command|config|adapter|broker|review|probe|pilot|scheduler|claims|document)-[a-z0-9-]{1,70}$/.test(error.message)
    ? error.message : 'command-failed';
  console.log(JSON.stringify({ state: 'unavailable', code, fullyCurrent: false }));
  process.exitCode = scheduledCommand ? scheduledExitCode(code) : 1;
}
