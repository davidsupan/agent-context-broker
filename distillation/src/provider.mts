import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { INSTRUCTIONS, type ModelRequest, type ModelResult, type ModelRunner } from './consumer.mts';
import { SliceSchema, modelOutputSchema, validateOutput, withRunnerCoverage } from './output.mts';
import { canonical, digest, redactBlock } from './slicing.mts';
import { hashArtifact } from './artifacts.mts';
import { noLinks } from './store.mts';
import { runContained, type ContainedOptions, type ContainedResult } from './windows-job.mts';
import { sha256Hex } from './platform.mts';

const WINDOWS = process.platform === 'win32';
/** The completion proof of a contained run on Node: the process tree verified empty (containment.mts). */
export const COMPLETION_PROOF = 'process-tree-empty-v1' as const;
import { CODEX_STARTUP_NOTICE_POLICY, permitsCodexStartupNotice, type CodexParserBinding } from './codex-startup-policy.mts';

const MiB = 1024 * 1024;
const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Path = z.string().min(1).max(4096).refine(value => /^[a-z]:[\\/]/i.test(value) && isAbsolute(value) && !value.includes('\0'));
const ReceiptRef = z.strictObject({ path: Path, sha256: Hash });
const Model = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const Provider = z.enum(['claude', 'codex']);
type ProviderName = z.infer<typeof Provider>;
// Values for the provider's allow-listed environment, recorded in config instead of
// inherited from whichever process launched the run. A Task Scheduler task, a Claude
// session and a Codex session then produce the same environment hash.
const EnvValue = z.string().min(1).max(4096).refine(value => !value.includes('\0'));
export const PinnedEnvironmentSchema = z.strictObject({
  SYSTEMROOT: Path.optional(), WINDIR: Path.optional(), USERPROFILE: Path.optional(), USER: EnvValue.optional(), LOGNAME: EnvValue.optional(),
  HOMEDRIVE: z.string().regex(/^[A-Za-z]:$/).optional(), HOMEPATH: EnvValue.optional(), HOME: Path.optional(),
  APPDATA: Path.optional(), LOCALAPPDATA: Path.optional(), PROGRAMDATA: Path.optional(),
  PROGRAMFILES: Path.optional(), 'PROGRAMFILES(X86)': Path.optional(), COMMONPROGRAMFILES: Path.optional(),
  LANG: EnvValue.optional(), LC_ALL: EnvValue.optional(),
});
export type PinnedEnvironment = z.infer<typeof PinnedEnvironmentSchema>;
const Binding = z.strictObject({
  executable: Path.refine(value => !WINDOWS || /\.exe$/i.test(value)), executableSha256: Hash,
  version: z.string().min(1).max(80), model: Model, authHome: Path,
  capabilityReceipt: ReceiptRef, liveProfileReceipt: ReceiptRef.optional(),
  environment: PinnedEnvironmentSchema.optional(),
});
export const ProviderConfigSchema = z.strictObject({
  providers: z.partialRecord(Provider, Binding).refine(value => Object.keys(value).length > 0),
  maxOutputBytes: z.number().int().min(1).max(MiB).default(MiB),
  maxStderrBytes: z.number().int().min(1).max(65536).default(65536),
});
export type ProviderConfig = z.input<typeof ProviderConfigSchema>;
type Config = z.output<typeof ProviderConfigSchema>;
type BoundProvider = z.infer<typeof Binding>;

// Version-bound reference profile from codex_capability_probe.py, not a claim
// that every future Codex version supports these flags. Receipts must match.
export const CODEX_DISABLED_FEATURES = Object.freeze([
  'apps', 'plugins', 'remote_plugin', 'hooks', 'memories', 'multi_agent', 'shell_tool',
  'unified_exec', 'shell_snapshot', 'browser_use', 'browser_use_external',
  'browser_use_full_cdp_access', 'computer_use', 'in_app_browser', 'image_generation',
  'view_image', 'code_mode_host', 'code_mode', 'goals', 'workspace_dependencies',
  'skill_search', 'skill_mcp_dependency_install', 'default_mode_request_user_input',
]);

function requireValue(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function parsed<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  requireValue(result.success, code);
  return result.data;
}
function sha(value: string | Uint8Array): string { return sha256Hex(value); }

// No exported strict parser exists in transcript.ts. Mirror its bounded duplicate
// key/depth scan and delegate JSON grammar to the native parser, not a new grammar.
function strictJson(text: string, cap: number): unknown {
  requireValue(text.length <= cap && Buffer.byteLength(text) <= cap && !text.includes('\ufffd'), 'provider-json-limit-or-encoding');
  try {
    const scopes: Array<Set<string> | null> = [];
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') {
        const start = i++;
        while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
        requireValue(i < text.length, 'provider-json');
        const value: unknown = JSON.parse(text.slice(start, i + 1));
        requireValue(typeof value === 'string' && value.isWellFormed(), 'provider-json');
        let next = i + 1;
        while (/[ \t\r\n]/.test(text[next] ?? '') && next < text.length) next++;
        if (text[next] === ':') {
          const keys = scopes.at(-1);
          requireValue(keys && !keys.has(value), 'provider-json');
          keys.add(value);
        }
      } else if (c === '{' || c === '[') {
        requireValue(scopes.length < 64, 'provider-json');
        scopes.push(c === '{' ? new Set() : null);
      } else if (c === '}' || c === ']') {
        requireValue(scopes.length > 0 && (c === '}') === (scopes.at(-1) !== null), 'provider-json');
        scopes.pop();
      }
    }
    requireValue(scopes.length === 0, 'provider-json');
    const result: unknown = JSON.parse(text);
    boundedJson(result, cap);
    return result;
  } catch { throw new Error('provider-json'); }
}

function boundedJson(value: unknown, cap: number): string {
  const stack = [{ value, depth: 0 }];
  let nodes = 0, size = 0;
  while (stack.length) {
    const item = stack.pop()!;
    requireValue(++nodes <= 200000 && item.depth <= 64, 'provider-json-bound');
    if (typeof item.value === 'string') {
      requireValue(item.value.isWellFormed(), 'provider-json-unicode');
      size += Buffer.byteLength(item.value);
    } else if (typeof item.value === 'number') requireValue(Number.isFinite(item.value), 'provider-json-number');
    else if (item.value !== null && typeof item.value !== 'boolean') {
      requireValue(object(item.value) || Array.isArray(item.value), 'provider-json-value');
      for (const [key, child] of Object.entries(item.value)) {
        size += Buffer.byteLength(key) + 3;
        requireValue(size <= cap && stack.length < 200000, 'provider-json-bound');
        stack.push({ value: child, depth: item.depth + 1 });
      }
    }
    requireValue(size <= cap, 'provider-json-bound');
  }
  const text = canonical(value);
  requireValue(Buffer.byteLength(text) <= cap, 'provider-json-bound');
  return text;
}

/** Full argv after executable. Placeholders are only for receipt profile hashing. */
export function providerArgv(provider: ProviderName, model: string, schema = '<OUTPUT_SCHEMA>'): string[] {
  parsed(Provider, provider, 'provider-name'); parsed(Model, model, 'provider-model');
  if (provider === 'claude') return ['--safe-mode', '--tools', '', '--strict-mcp-config',
    '--no-session-persistence', '--print', '--output-format', 'json', '--disable-slash-commands',
    '--no-chrome', '--system-prompt', INSTRUCTIONS, '--model', model, '--json-schema', schema];
  return ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only',
    '--json', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '--model', model,
    ...CODEX_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    '-c', 'project_doc_max_bytes=0', '--output-schema', schema, '-'];
}

export type EnvironmentPolicy = 'subscription-allowlist-v1' | 'subscription-pinned-v1';
export function environmentPolicyFor(environment?: PinnedEnvironment): EnvironmentPolicy {
  return environment ? 'subscription-pinned-v1' : 'subscription-allowlist-v1';
}

export function argvProfileSha256(provider: ProviderName, model: string,
  environmentPolicy: EnvironmentPolicy = 'subscription-allowlist-v1'): string {
  return digest({ schemaVersion: 1, provider, argv: providerArgv(provider, model),
    instructions: INSTRUCTIONS, environmentPolicy,
    parserProfile: provider === 'claude' ? 'strict-claude-telemetry-v4' : 'strict-codex-startup-notice-v2' });
}

/** No inherited PATH, API keys, proxies, provider overrides or startup injection.
 * Auth/cache access still requires separately reviewed live-profile evidence.
 */
export function controlledEnvironment(provider: ProviderName, authHome: string, home: string,
  source: Record<string, string | undefined> = process.env): Record<string, string> {
  const allowed = new Set(WINDOWS
    ? ['SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
      'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'COMMONPROGRAMFILES', 'LANG', 'LC_ALL']
    : ['HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL']);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (!allowed.has(name) || value === undefined) continue;
    requireValue(!(name in env) && !value.includes('\0') && value.length <= 4096, 'provider-environment');
    env[name] = value;
  }
  if (WINDOWS) {
    requireValue(env.SYSTEMROOT && isAbsolute(env.SYSTEMROOT), 'provider-system-root');
    env.PATH = join(env.SYSTEMROOT, 'System32') + ';' + env.SYSTEMROOT;
    // Probe and runner may spell the same Windows path with different separators.
    // Canonicalize before hashing so equivalent paths bind to the same environment.
    env.TEMP = resolve(home).replaceAll('\\', '/'); env.TMP = env.TEMP;
  } else {
    requireValue(env.HOME && isAbsolute(env.HOME), 'provider-home');
    // Only the system folders: no user PATH entries, so no shim or wrapper can stand in for a tool.
    env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
    env.TMPDIR = resolve(home);
  }
  env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = resolve(authHome).replaceAll('\\', '/');
  return env;
}

/** Pinned values when the binding records them, otherwise the inherited allow-list. */
export function bindingEnvironment(provider: ProviderName, authHome: string, home: string, environment?: PinnedEnvironment) {
  return controlledEnvironment(provider, authHome, home,
    environment ? parsed(PinnedEnvironmentSchema, environment, 'provider-environment') : process.env);
}

/** The allow-listed values of this process, for an operator to review and pin in config. */
export function currentPinnableEnvironment(source: Record<string, string | undefined> = process.env): PinnedEnvironment {
  const keys = Object.keys(PinnedEnvironmentSchema.shape);
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const name = key.toUpperCase();
    if (keys.includes(name) && value !== undefined && !(name in values)) values[name] = value;
  }
  return parsed(PinnedEnvironmentSchema, values, 'provider-environment');
}

export interface CapabilityBinding { provider: ProviderName; model: string; version: string; executableSha256: string }
/** Validate historical loopback evidence only. This function NEVER approves live use. */
export function validateCapabilityFixture(value: unknown, binding: CapabilityBinding) {
  const r = parsed(z.record(z.string(), z.unknown()), value, 'capability-receipt');
  boundedJson(r, 65536);
  requireValue(r.liveProfileVerified === false && r.exitCode === 0, 'capability-not-fixture-success');
  if (binding.provider === 'claude') {
    requireValue(r.schemaVersion === 1 && r.provider === 'claude-loopback-fixture' &&
      r.executableSha256 === binding.executableSha256 && r.launchProfile === 'safe-mode' &&
      r.authProfile === 'isolated-synthetic-api-key' && r.capabilityState === 'output-only-in-fixture' &&
      r.structuredOutputRequested === true && r.fixtureFailure === false &&
      Array.isArray(r.fixtureErrors) && r.fixtureErrors.length === 0 &&
      r.managedPolicyAbsentAtChecks === true && r.upstreamForwarding === false &&
      r.networkIsolationVerified === false && Array.isArray(r.requests) &&
      r.requests.length > 0 && r.requests.length <= 8, 'claude-capability-mismatch');
    for (const request of r.requests) requireValue(object(request) && request.syntheticContractMatches === true &&
      request.toolCount === 1 && request.outputToolOnly === true && Number.isSafeInteger(request.requestBytes) &&
      (request.requestBytes as number) > 0 && (request.requestBytes as number) <= MiB, 'claude-capability-tools');
  } else {
    requireValue(r.argvProfileSha256 === argvProfileSha256('codex', binding.model), 'codex-capability-profile');
    parsed(z.strictObject({
      kind: z.literal('synthetic-agents-autoload-probe'), projectDocMaxBytes: z.literal(0),
      syntheticHomes: z.literal(true),
      positiveControl: z.strictObject({ authHomeMarkerObserved: z.literal(true), ancestorMarkerObserved: z.literal(true) }),
      restricted: z.strictObject({ authHomeMarkerObserved: z.literal(false), ancestorMarkerObserved: z.literal(false) }),
    }), r.contextIsolation, 'codex-context-unverified');
    requireValue(r.schemaVersion === 2 && r.provider === 'loopback-fixture' && r.realModelCalled === false &&
      r.executionMode === 'direct-native' && r.executedSha256 === binding.executableSha256 &&
      object(r.toolchain) && r.toolchain.nativeSha256 === binding.executableSha256 &&
      r.toolchain.version === 'codex-cli ' + binding.version && r.model === binding.model &&
      r.capabilityState === 'tool-free-in-fixture' && r.exercisedTool === 'exec_command' &&
      canonical(r.disabledFeatures) === canonical(CODEX_DISABLED_FEATURES) &&
      Array.isArray(r.requests) && r.requests.length === 2 && Array.isArray(r.toolResults) &&
      r.toolResults.length > 0 && r.toolResults.length <= 8, 'codex-capability-mismatch');
    for (const request of r.requests) requireValue(object(request) && request.model === binding.model &&
      request.toolCount === 0 && Array.isArray(request.toolNames) && request.toolNames.length === 0 &&
      request.authorizationHeaderPresent === false && (request.parseFailed === undefined || request.parseFailed === false), 'codex-capability-tools');
    for (const result of r.toolResults) requireValue(object(result) && result.callIdMatches === true &&
      result.unsupportedTool === true && result.executionMarkerPresent === false, 'codex-capability-rejection');
  }
  return { scope: 'fixture-only' as const, liveAuthorized: false as const, provider: binding.provider };
}

/** New approval contract; only read/validated here, NEVER generated or promoted.
 * Pin this receipt's SHA externally after human review. Hashes bind evidence;
 * they do not establish the truth of attestations or prevent binary swap-back.
 */
export const LiveProfileReceiptSchema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('human-reviewed-live-profile'), provider: Provider,
  approved: z.literal(true), liveProfileVerified: z.literal(true), executionMode: z.literal('direct-native'),
  model: Model, version: z.string().min(1).max(80), executableSha256: Hash, capabilityReceiptSha256: Hash,
  argvProfileSha256: Hash, environmentSha256: Hash, authHome: Path, runtimeHome: Path,
  subscriptionAuthOnly: z.literal(true), managedPolicyReviewed: z.literal(true),
  noExecutionToolsVerified: z.literal(true), authAndCacheWritesReviewed: z.literal(true),
});

function directory(path: string): string {
  noLinks(path); const stat = lstatSync(path, { bigint: true });
  requireValue(stat.isDirectory(), 'provider-directory');
  return `${stat.dev}:${stat.ino}`;
}
function readReceipt(ref: z.infer<typeof ReceiptRef>): unknown {
  noLinks(ref.path);
  const before = lstatSync(ref.path, { bigint: true });
  requireValue(before.isFile() && before.size > 0n && before.size <= 65536n, 'provider-receipt-limit');
  const fd = openSync(ref.path, 'r');
  try {
    const opened = fstatSync(fd, { bigint: true });
    requireValue(before.dev === opened.dev && before.ino === opened.ino && before.size === opened.size, 'provider-receipt-changed');
    const raw = Buffer.alloc(Number(before.size) + 1);
    let bytes = 0;
    while (bytes < raw.length) { const n = readSync(fd, raw, bytes, raw.length - bytes, bytes); if (!n) break; bytes += n; }
    const after = fstatSync(fd, { bigint: true });
    noLinks(ref.path); const pathAfter = lstatSync(ref.path, { bigint: true });
    requireValue(BigInt(bytes) === before.size && after.dev === before.dev && after.ino === before.ino &&
      after.size === before.size && after.mtimeNs === before.mtimeNs && after.ctimeNs === before.ctimeNs &&
      pathAfter.dev === before.dev && pathAfter.ino === before.ino && pathAfter.size === before.size &&
      pathAfter.mtimeNs === before.mtimeNs && pathAfter.ctimeNs === before.ctimeNs && sha(raw.subarray(0, bytes)) === ref.sha256,
      'provider-receipt-changed');
    return strictJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw.subarray(0, bytes)), 65536);
  } finally { closeSync(fd); }
}

async function checkBinding(provider: ProviderName, binding: BoundProvider, home: string, fixture: boolean) {
  // This gate intentionally precedes executable hashing and any process creation.
  requireValue(fixture || binding.liveProfileReceipt, 'live-profile-receipt-required');
  const homeId = directory(home), authId = directory(binding.authHome);
  const env = bindingEnvironment(provider, binding.authHome, home, binding.environment);
  const envHash = digest(env), profileHash = argvProfileSha256(provider, binding.model, environmentPolicyFor(binding.environment));
  const live = fixture ? null : parsed(LiveProfileReceiptSchema, readReceipt(binding.liveProfileReceipt!), 'live-profile-unverified');
  if (live) requireValue(live.provider === provider && live.model === binding.model && live.version === binding.version &&
    live.executableSha256 === binding.executableSha256 && live.capabilityReceiptSha256 === binding.capabilityReceipt.sha256 &&
    live.argvProfileSha256 === profileHash && live.environmentSha256 === envHash &&
    resolve(live.authHome) === resolve(binding.authHome) && resolve(live.runtimeHome) === home, 'live-profile-mismatch');
  validateCapabilityFixture(readReceipt(binding.capabilityReceipt), { provider, ...binding });
  const executable = await hashArtifact(binding.executable, 512 * MiB);
  requireValue(executable.sha256 === binding.executableSha256, 'provider-executable-changed');
  // Node on Windows cannot give the child an exact environment (libuv adds required parent variables) or a job
  // object, so live runs stay closed there until the contained launcher exists.
  requireValue(fixture || !WINDOWS, 'provider-windows-containment-unavailable');
  return { env, fingerprint: digest({ executable: executable.sha256, capability: binding.capabilityReceipt.sha256,
    live: fixture ? null : binding.liveProfileReceipt!.sha256, envHash, profileHash, homeId, authId }) };
}

function configValue(config: ProviderConfig, home: string) {
  requireValue(WINDOWS ? process.arch === 'x64' : process.platform === 'darwin' || process.platform === 'linux', WINDOWS ? 'provider-windows-x64-required' : 'provider-platform-unsupported');
  const value = parsed(ProviderConfigSchema, strictJson(boundedJson(config, 65536), 65536), 'provider-config');
  parsed(Path, home, 'provider-home');
  return { value, home: resolve(home) };
}

/** Call immediately BEFORE consumeSlice/reservation; read-only, no model/probe calls. */
export async function preflight(config: ProviderConfig, home: string) {
  const fixed = configValue(config, home);
  const providers: ProviderName[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const binding = fixed.value.providers[provider];
    if (binding) { await checkBinding(provider, binding, fixed.home, false); providers.push(provider); }
  }
  return { state: 'ready' as const, invoked: false as const, providers };
}

const Counter = z.number().int().min(0).max(1e12);
const Usage = z.strictObject({ input_tokens: Counter, output_tokens: Counter,
  cache_creation_input_tokens: Counter.optional(), cache_read_input_tokens: Counter.optional() });
function counters(value: unknown, codex: boolean): Record<string, number> {
  requireValue(object(value), 'provider-usage');
  const allowed = codex ? ['input_tokens', 'output_tokens', 'cached_input_tokens'] :
    ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
      'server_tool_use', 'cache_creation', 'service_tier', 'inference_geo', 'output_tokens_details', 'iterations', 'speed'];
  requireValue(Object.keys(value).every(key => allowed.includes(key)), 'provider-unexpected-usage');
  for (const key of ['service_tier', 'inference_geo']) if (value[key] !== undefined) {
    requireValue(value[key] === null || (typeof value[key] === 'string' && value[key].length <= 100), 'provider-usage');
  }
  if (value.cache_creation !== undefined) parsed(z.strictObject({
    ephemeral_5m_input_tokens: Counter, ephemeral_1h_input_tokens: Counter,
  }), value.cache_creation, 'provider-usage');
  if (value.output_tokens_details !== undefined) {
    const details = parsed(z.strictObject({ thinking_tokens: Counter }), value.output_tokens_details, 'provider-usage');
    requireValue(typeof value.output_tokens === 'number' && details.thinking_tokens <= value.output_tokens, 'provider-usage');
  }
  if (value.iterations !== undefined) {
    // A single ordinary sampling entry is usage accounting, not an advisor or
    // server-tool loop. Its totals must agree with the enclosing usage record.
    const iterations = parsed(z.array(z.strictObject({ type: z.literal('message'),
      model: Model.optional(), input_tokens: Counter, output_tokens: Counter,
      cache_creation_input_tokens: Counter.optional(), cache_read_input_tokens: Counter.optional(),
      cache_creation: z.strictObject({ ephemeral_5m_input_tokens: Counter, ephemeral_1h_input_tokens: Counter }).optional(),
    })).max(1), value.iterations, 'provider-unexpected-usage');
    for (const iteration of iterations) {
      for (const key of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'] as const) {
        requireValue((iteration[key] ?? 0) === (value[key] ?? 0), 'provider-iteration-total');
      }
    }
  }
  if (value.speed !== undefined) parsed(z.literal('standard'), value.speed, 'provider-usage');
  const mapped: Record<string, unknown> = { input_tokens: value.input_tokens, output_tokens: value.output_tokens };
  for (const key of ['cache_creation_input_tokens', 'cache_read_input_tokens']) if (value[key] !== undefined) mapped[key] = value[key];
  if (codex) {
    const cached = parsed(Counter, value.cached_input_tokens, 'provider-usage');
    requireValue(typeof value.input_tokens === 'number' && cached <= value.input_tokens, 'provider-usage');
    mapped.cache_read_input_tokens = cached;
  }
  // Extra telemetry may exist, but nested tool-use counters cannot claim activity.
  if (value.server_tool_use !== undefined) {
    parsed(z.strictObject({ web_search_requests: z.literal(0).optional(), web_fetch_requests: z.literal(0).optional() }),
      value.server_tool_use, 'provider-tool-usage');
  }
  return parsed(Usage, mapped, 'provider-usage') as Record<string, number>;
}

const TelemetryMilliseconds = z.number().int().min(0).max(3600000);
// Claude 2.1.263 emits these even with tools disabled. Activity/error indicators
// are literals, not generic counters: telemetry must not conceal agent work.
const ClaudeTelemetrySchema = z.strictObject({
  terminal_reason: z.literal('completed').optional(),
  api_error_status: z.null().optional(),
  fast_mode_state: z.literal('off').optional(),
  fast_mode_disabled_reason: z.literal('sdk_opt_in_required').optional(),
  queued_turn_count: z.literal(0).optional(),
  ttft_ms: TelemetryMilliseconds.optional(),
  ttft_stream_ms: TelemetryMilliseconds.optional(),
  time_to_request_ms: TelemetryMilliseconds.optional(),
  first_content_frame_ms: TelemetryMilliseconds.optional(),
  subagent_stats: z.strictObject({
    spawned: z.literal(0),
    requested: z.strictObject({ background: z.literal(0), foreground: z.literal(0), unset: z.literal(0) }),
    started_in_background: z.literal(0), max_depth: z.literal(0), spawned_by_subagents: z.literal(0),
    completed: z.literal(0), failed: z.literal(0),
    killed: z.strictObject({ parent: z.literal(0), user: z.literal(0), system: z.literal(0) }),
    refused: z.strictObject({ depth_limit: z.literal(0), concurrency_limit: z.literal(0), budget: z.literal(0) }),
    by_type: z.strictObject({}),
  }).optional(),
});
const ClaudeTelemetryKeys = Object.keys(ClaudeTelemetrySchema.shape);

/** Metadata only: no response, session identifier, field values or unknown key
 * names are retained. This lets failed probes explain schema drift safely. */
export function providerOutputShape(stdout: string) {
  try {
    const r = strictJson(stdout, MiB);
    if (!object(r)) return { state: 'not-object' };
    const usage = object(r.usage) ? r.usage : {};
    const known = new Set(['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens',
      'server_tool_use', 'cache_creation', 'service_tier', 'inference_geo', 'output_tokens_details', 'iterations', 'speed']);
    return { state: 'shape-only', usage: Object.keys(usage).slice(0, 64).map(key => ({
      field: known.has(key) ? key : 'unknown', keySha256: digest(key),
      type: usage[key] === null ? 'null' : Array.isArray(usage[key]) ? 'array' : typeof usage[key],
      ...(Array.isArray(usage[key]) ? { length: usage[key].length } : {}),
    })), iterations: Array.isArray(usage.iterations) ? usage.iterations.slice(0, 8).map(item =>
      object(item) && ['message', 'advisor_message', 'compaction', 'fallback_message'].includes(String(item.type)) ? item.type : 'unknown') : [] };
  } catch { return { state: 'unparseable' }; }
}

export const PROVIDER_ERROR_CATEGORIES = Object.freeze(['auth', 'billing', 'quota-or-rate-limit', 'provider-unavailable',
  'invalid-request', 'model-unavailable', 'structured-output-retries', 'max-turns', 'budget', 'execution-error', 'unknown'] as const);
type ErrorCategory = typeof PROVIDER_ERROR_CATEGORIES[number];
const ClaudeSubtypes: Record<string, ErrorCategory | null> = { success: null, error_during_execution: 'execution-error',
  error_max_turns: 'max-turns', error_max_structured_output_retries: 'structured-output-retries', error_max_budget_usd: 'budget' };
const ClaudeTerminalReasons = ['completed', 'error', 'aborted', 'max_turns', 'prompt_too_long', 'blocking_limit', 'model_error', 'api_error'];
const ClaudeEnvelopeKeys = new Set(['type', 'subtype', 'is_error', 'structured_output', 'result', 'usage', 'modelUsage',
  'duration_ms', 'duration_api_ms', 'num_turns', 'session_id', 'total_cost_usd', 'permission_denials', 'stop_reason', 'uuid',
  'errors', 'error', ...ClaudeTelemetryKeys]);
// Fixed CLI error phrases. Only the matched pattern id is ever retained, never text.
const ErrorPatterns: ReadonlyArray<readonly [string, ErrorCategory, RegExp]> = [
  ['credit-balance', 'billing', /credit balance|billing/i],
  ['usage-limit', 'quota-or-rate-limit', /usage limit|hit your (?:\w+ )?limit|limit reached|out of extra usage|limit will reset|resets? (?:at|in) /i],
  ['rate-limit', 'quota-or-rate-limit', /rate.?limit|too many requests|\b429\b/i],
  ['auth', 'auth', /invalid api key|run \/login|not logged in|oauth token|authenticat|unauthori[sz]ed|\b40[13]\b/i],
  ['model', 'model-unavailable', /model\b.{0,80}\b(?:not found|not available|does not exist|unavailable|not_found)|\b404\b/i],
  ['overloaded', 'provider-unavailable', /overloaded|internal server error|service unavailable|bad gateway|\b5\d\d\b/i],
  ['invalid-request', 'invalid-request', /prompt is too long|too large|invalid_request|invalid request|\b4(?:00|13|22)\b/i],
];
function statusCategory(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'billing';
  if (status === 404) return 'model-unavailable';
  if (status === 429) return 'quota-or-rate-limit';
  if (status === 400 || status === 413 || status === 422) return 'invalid-request';
  if (status >= 500 && status <= 599) return 'provider-unavailable';
  return 'unknown';
}
function errorPattern(text: unknown): { id: string; category: ErrorCategory } | null {
  if (typeof text !== 'string' || text.length > 65536) return null;
  for (const [id, category, pattern] of ErrorPatterns) if (pattern.test(text)) return { id, category };
  return null;
}

/** Diagnostic classification of a failed Claude run. It keeps envelope literals
 * from fixed allow-lists, counts and matched pattern ids only: no response text,
 * session identifier, unknown key names or unknown values. It never changes the
 * attempt state, refunds budget or triggers fallback; a category is not proof. */
export function providerErrorClass(stdout: string, stderr = '') {
  const stderrPattern = errorPattern(stderr)?.id ?? null;
  let r: unknown;
  try { r = strictJson(stdout, MiB); } catch {
    return { state: 'unparseable' as const, category: 'unknown' as ErrorCategory, categorySource: 'none' as const, stderrPattern };
  }
  if (!object(r)) return { state: 'not-object' as const, category: 'unknown' as ErrorCategory, categorySource: 'none' as const, stderrPattern };
  const literal = (value: unknown, allowed: readonly string[]) => value === undefined ? 'absent' :
    typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  const status = r.api_error_status === undefined ? 'absent' : r.api_error_status === null ? null :
    Number.isInteger(r.api_error_status) && (r.api_error_status as number) >= 100 && (r.api_error_status as number) <= 599 ?
      r.api_error_status as number : 'invalid';
  const subtype = literal(r.subtype, Object.keys(ClaudeSubtypes));
  const resultPattern = r.is_error === true || (subtype !== 'success' && subtype !== 'absent') ? errorPattern(r.result) : null;
  let category: ErrorCategory = 'unknown', categorySource: 'api-status' | 'subtype' | 'result-pattern' | 'stderr-pattern' | 'none' = 'none';
  if (typeof status === 'number' && statusCategory(status) !== 'unknown') { category = statusCategory(status); categorySource = 'api-status'; }
  else if (resultPattern) { category = resultPattern.category; categorySource = 'result-pattern'; }
  else if (subtype in ClaudeSubtypes && ClaudeSubtypes[subtype]) { category = ClaudeSubtypes[subtype]!; categorySource = 'subtype'; }
  else if (stderrPattern) { category = errorPattern(stderr)!.category; categorySource = 'stderr-pattern'; }
  return { state: 'classified' as const, category, categorySource,
    envelope: {
      type: literal(r.type, ['result']), subtype,
      isError: r.is_error === undefined ? 'absent' : typeof r.is_error === 'boolean' ? r.is_error : 'invalid',
      apiErrorStatus: status, terminalReason: literal(r.terminal_reason, ClaudeTerminalReasons),
      numTurns: r.num_turns === undefined ? 'absent' : Number.isInteger(r.num_turns) && (r.num_turns as number) >= 0 &&
        (r.num_turns as number) <= 1000 ? r.num_turns : 'invalid',
      structuredOutput: r.structured_output === undefined ? 'absent' : 'present',
      result: r.result === undefined ? 'absent' : typeof r.result === 'string' ? 'string' : 'other',
      errors: Array.isArray(r.errors) ? Math.min(r.errors.length, 1000) : r.errors === undefined ? 'absent' : 'other',
      error: r.error === undefined ? 'absent' : 'present',
      keys: Object.keys(r).slice(0, 64).map(key => ClaudeEnvelopeKeys.has(key) ? key : 'unknown').sort(),
    },
    resultPattern: resultPattern?.id ?? null, stderrPattern };
}

/** Strict text envelope validation only; validateOutput remains the content gate. */
export function parseProviderOutput(provider: ProviderName, stdout: string, exitCode: number, binding?: CodexParserBinding) {
  requireValue(exitCode === 0 && Buffer.byteLength(stdout) <= MiB, 'provider-failed');
  if (provider === 'claude') {
    const r = strictJson(stdout, MiB);
    requireValue(object(r) && r.type === 'result' && r.subtype === 'success' && r.is_error === false &&
      r.error === undefined && (r.errors === undefined || (Array.isArray(r.errors) && r.errors.length === 0)), 'claude-failed');
    const allowed = new Set(['type', 'subtype', 'is_error', 'structured_output', 'result', 'usage', 'modelUsage',
      'duration_ms', 'duration_api_ms', 'num_turns', 'session_id', 'total_cost_usd', 'permission_denials',
      'stop_reason', 'uuid', 'errors', ...ClaudeTelemetryKeys]);
    requireValue(Object.keys(r).every(key => allowed.has(key)) &&
      (r.permission_denials === undefined || (Array.isArray(r.permission_denials) && !r.permission_denials.length)), 'claude-unexpected-activity');
    parsed(ClaudeTelemetrySchema, Object.fromEntries(ClaudeTelemetryKeys.filter(key => key in r).map(key => [key, r[key]])),
      'claude-telemetry-or-activity');
    if (r.modelUsage !== undefined) {
      requireValue(object(r.modelUsage) && Object.keys(r.modelUsage).length <= 64, 'claude-usage');
      for (const item of Object.values(r.modelUsage)) parsed(z.strictObject({
        inputTokens: Counter.optional(), outputTokens: Counter.optional(), cacheReadInputTokens: Counter.optional(),
        cacheCreationInputTokens: Counter.optional(), webSearchRequests: z.literal(0).optional(),
        costUSD: z.number().finite().min(0).max(1e9).optional(), contextWindow: Counter.optional(), maxOutputTokens: Counter.optional(),
        thinkingTokens: Counter.optional(), canonicalModel: Model.optional(), provider: z.literal('firstParty').optional(),
        // Claude Code 2.1.246+ names the pricing table, not tool activity.
        costBasis: z.enum(['list', 'managed', 'unknown']).optional(),
      }), item, 'claude-tool-usage');
    }
    let output: unknown = r.structured_output;
    if (output === undefined && typeof r.result === 'string') output = strictJson(r.result, MiB);
    requireValue(object(output), 'claude-output');
    return { output, usage: counters(r.usage, false) };
  }
  requireValue(provider === 'codex', 'provider-name');
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  requireValue(lines.length > 0 && lines.length <= 4096, 'codex-event-count');
  let thread = false, started = false, completed = false, final: string | undefined;
  let usage: Record<string, number> | undefined;
  const startupNotices: string[] = [];
  const states = new Map<string, { type: string; done: boolean }>();
  for (const line of lines) {
    const event = strictJson(line, MiB);
    requireValue(object(event) && !completed, 'codex-event-order');
    if (event.type === 'thread.started') {
      requireValue(!thread && !started && typeof event.thread_id === 'string', 'codex-event-order'); thread = true;
    } else if (event.type === 'turn.started') {
      requireValue(thread && !started, 'codex-event-order'); started = true;
    } else if (event.type === 'item.completed' && object(event.item) && event.item.type === 'error' &&
      event.item.message === CODEX_STARTUP_NOTICE_POLICY.message) {
      requireValue(permitsCodexStartupNotice(binding) && thread && !started && startupNotices.length === 0 &&
        Object.keys(event.item).every(key => ['id', 'type', 'message'].includes(key)) &&
        typeof event.item.id === 'string' && event.item.id.length > 0 && event.item.id.length <= 200 &&
        !states.has(event.item.id), 'codex-startup-notice-unverified');
      states.set(event.item.id, { type: 'startup-notice', done: true });
      startupNotices.push(CODEX_STARTUP_NOTICE_POLICY.code);
    } else if (['item.started', 'item.updated', 'item.completed'].includes(event.type as string)) {
      const item = event.item;
      requireValue(started && object(item) && ['agent_message', 'reasoning'].includes(item.type as string) &&
        typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 200 && typeof item.text === 'string', 'codex-unexpected-tool');
      requireValue(Object.keys(item).every(key => ['id', 'type', 'text'].includes(key)), 'codex-unexpected-item');
      const previous = states.get(item.id);
      requireValue(!previous?.done && (!previous || previous.type === item.type) &&
        (event.type !== 'item.started' || !previous), 'codex-item-order');
      states.set(item.id, { type: item.type as string, done: event.type === 'item.completed' });
      if (item.type === 'agent_message' && event.type === 'item.completed') {
        requireValue(final === undefined, 'codex-multiple-final'); final = item.text;
      }
    } else if (event.type === 'turn.completed') {
      requireValue(started && final !== undefined && [...states.values()].every(item => item.done), 'codex-incomplete');
      usage = counters(event.usage, true); completed = true;
    } else throw new Error('codex-error-or-unexpected-event');
    const eventKeys = event.type === 'thread.started' ? ['type', 'thread_id'] : event.type === 'turn.started' ? ['type'] :
      event.type === 'turn.completed' ? ['type', 'usage'] : ['type', 'item'];
    requireValue(Object.keys(event).every(key => eventKeys.includes(key)), 'codex-unexpected-event-fields');
  }
  requireValue(completed && final !== undefined && usage, 'codex-incomplete');
  const output = strictJson(final, MiB); requireValue(object(output), 'codex-output');
  return { output, usage, startupNotices };
}

export function prepareProviderRequest(request: ModelRequest) {
  const value = strictJson(boundedJson(request, 4 * MiB), 4 * MiB);
  const schema = z.strictObject({ provider: Provider, reason: z.string().min(1).max(100), token: z.string().regex(/^[a-f0-9]{32}$/),
    jobName: z.string(), slice: SliceSchema, outputSchema: z.unknown(), timeoutMs: z.number().int().min(1).max(1800000),
    instructions: z.literal(INSTRUCTIONS) });
  const r = parsed(schema, value, 'provider-request');
  requireValue(r.jobName === `Local\\ACBCorpus-${r.token}`, 'provider-job-name');
  const { sliceId, ...body } = r.slice;
  requireValue(digest(body) === sliceId, 'provider-slice-identity');
  requireValue(r.slice.segments.length <= 64 && r.slice.segments.reduce((n, s) => n + s.endChar - s.startChar, 0) <= 80000,
    'provider-slice-limit');
  for (const segment of r.slice.segments) requireValue(redactBlock(segment.text).text === segment.text, 'provider-input-privacy');
  const outputSchema = modelOutputSchema(r.slice);
  requireValue(boundedJson(r.outputSchema, 16384) === boundedJson(outputSchema, 16384), 'provider-output-schema');
  const input = boundedJson({ instructions: INSTRUCTIONS, untrustedDialogue: r.slice.segments, untrustedSlice: r.slice }, 4 * MiB);
  return { ...r, input, schemaText: boundedJson(outputSchema, 16384) };
}

export type ProviderRunner = ModelRunner & { preflight: () => Promise<{ state: 'ready'; invoked: false; providers: ProviderName[] }> };
type Executor = (options: ContainedOptions) => Promise<ContainedResult>;

async function makeRunner(config: ProviderConfig, home: string, execute: Executor, fixture: boolean): Promise<ProviderRunner> {
  const fixed = configValue(config, home);
  const checkAll = async () => {
    const providers: ProviderName[] = [];
    for (const provider of ['claude', 'codex'] as const) {
      const binding = fixed.value.providers[provider];
      if (binding) { await checkBinding(provider, binding, fixed.home, fixture); providers.push(provider); }
    }
    return { state: 'ready' as const, invoked: false as const, providers };
  };
  await checkAll();
  let busy = false;
  const runner: ModelRunner = async request => {
    requireValue(!busy, 'provider-runner-busy'); busy = true;
    let scratch: string | undefined, schemaPath: string | undefined;
    try {
      const r = prepareProviderRequest(request), binding = fixed.value.providers[r.provider];
      requireValue(binding, 'provider-not-configured');
      const deadline = performance.now() + r.timeoutMs;
      const before = await checkBinding(r.provider, binding, fixed.home, fixture);
      const target = join(fixed.home, 'provider-' + r.token);
      noLinks(target); mkdirSync(target, { mode: 0o700 }); scratch = target;
      let schemaArgument = r.schemaText;
      if (r.provider === 'codex') {
        const targetSchema = join(scratch, 'output.schema.json');
        const fd = openSync(targetSchema, 'wx', 0o600); schemaPath = targetSchema;
        try { writeFileSync(fd, r.schemaText); } finally { closeSync(fd); }
        schemaArgument = schemaPath;
      }
      const timeoutMs = Math.floor(deadline - performance.now());
      requireValue(timeoutMs > 0, 'provider-deadline-before-dispatch');
      const result = await execute({ executable: binding.executable, args: providerArgv(r.provider, binding.model, schemaArgument),
        cwd: scratch, env: before.env, stdin: r.input, maxOutputBytes: fixed.value.maxOutputBytes + fixed.value.maxStderrBytes,
        timeoutMs, jobName: r.jobName });
      requireValue(result.containmentEmpty === true && Number.isFinite(result.durationMs) && result.durationMs >= 0 &&
        result.durationMs <= 3600000, 'provider-containment-unverified');
      const completionProof = fixture ? 'synthetic-fixture' as const : COMPLETION_PROOF;
      const failed: ModelResult = { completionProof, state: 'failed', durationMs: result.durationMs };
      try {
        const after = await checkBinding(r.provider, binding, fixed.home, fixture);
        requireValue(before.fingerprint === after.fingerprint, 'provider-proof-drift');
        requireValue(!result.timedOut && !result.outputLimitExceeded && result.exitCode === 0 &&
          result.stdoutBytes <= fixed.value.maxOutputBytes && result.stderrBytes <= fixed.value.maxStderrBytes &&
          Buffer.byteLength(result.stdout) === result.stdoutBytes && Buffer.byteLength(result.stderr) === result.stderrBytes,
          'provider-process-failed');
        // No VERIFIED_QUOTA_CODES: all errors, including structured quota codes,
        // remain failures. Human text never triggers automatic provider fallback.
        const parsed = parseProviderOutput(r.provider, result.stdout, result.exitCode, r.provider === 'codex' ? binding : undefined);
        if (parsed.startupNotices?.length) {
          const directory = join(fixed.home, 'provider-notices');
          noLinks(directory); mkdirSync(directory, { recursive: true });
          const path = join(directory, r.token + '.json'); noLinks(path);
          writeFileSync(path, canonical({ schemaVersion: 1, attemptToken: r.token, provider: r.provider,
            version: binding.version, executableSha256: binding.executableSha256,
            recordedAt: new Date().toISOString(), startupNotices: parsed.startupNotices,
            toolRejectionProof: false }) + '\n', { flag: 'wx', mode: 0o600 });
        }
        const checked = validateOutput(withRunnerCoverage(parsed.output, r.slice), r.slice);
        return { completionProof, state: 'output', output: checked.result, usage: parsed.usage, durationMs: result.durationMs };
      } catch (error) {
        const known = new Set(['provider-proof-drift', 'provider-process-failed', 'provider-json', 'provider-usage',
          'provider-unexpected-usage', 'claude-failed', 'claude-unexpected-activity', 'claude-tool-usage',
          'output-identity', 'output-coverage', 'output-disposition', 'output-privacy', 'ref-outside-slice']);
        const message = error instanceof Error ? error.message : '';
        const directory = join(fixed.home, 'provider-failures');
        noLinks(directory); mkdirSync(directory, { recursive: true });
        const failurePath = join(directory, r.token + '.json');
        noLinks(failurePath);
        writeFileSync(failurePath, canonical({ schemaVersion: 2, provider: r.provider, attemptToken: r.token,
          recordedAt: new Date().toISOString(), code: known.has(message) ? message : 'provider-output-invalid',
          exitCode: result.exitCode, timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded,
          containmentEmpty: result.containmentEmpty, durationMs: result.durationMs,
          stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
          ...(r.provider === 'claude' ? { outputShape: providerOutputShape(result.stdout),
            errorClass: providerErrorClass(result.stdout, result.stderr) } : {})
        }) + '\n', { flag: 'wx', mode: 0o600 });
        return failed;
      }
    } catch { throw new Error('provider-dispatch-or-containment-unverified'); }
    finally {
      busy = false;
      // Remove only artifacts we created. Never recursively remove unexpected CLI files.
      if (schemaPath) { noLinks(schemaPath); unlinkSync(schemaPath); }
      if (scratch) { noLinks(scratch); rmdirSync(scratch); }
    }
  };
  return Object.assign(runner, { preflight: checkAll });
}

/** Production: factory preflights; caller must ALSO preflight immediately before
 * each consumer reservation. No factory/config flag can enable synthetic execution.
 */
export async function createProviderRunner(config: ProviderConfig, home: string): Promise<ProviderRunner> {
  return makeRunner(config, home, runContained, false);
}

/** Explicit test-only dependency injection. Never yields a live completion proof,
 * even when the injected executor uses the real containment primitive.
 */
export async function createFixtureProviderRunner(config: ProviderConfig, home: string,
  injection: { execute: Executor }): Promise<ProviderRunner> {
  requireValue(injection && typeof injection.execute === 'function', 'fixture-injection-required');
  return makeRunner(config, home, injection.execute, true);
}
