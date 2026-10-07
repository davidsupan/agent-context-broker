import { describe, expect, test } from './expect.mts';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { INSTRUCTIONS, type ModelRequest } from '../src/consumer.mts';
import { buildSlices, digest } from '../src/slicing.mts';
import { modelOutputSchema } from '../src/output.mts';
import { runContained, type ContainedResult } from '../src/windows-job.mts';
import { hashArtifact } from '../src/artifacts.mts';
import { sha256Hex } from '../src/platform.mts';
import { assertProbePolicyAbsent, probeArgv, probeEnvironment, startCapabilityFixture } from '../src/capability-probe.mts';
import { CODEX_DISABLED_FEATURES, ProviderConfigSchema, argvProfileSha256, bindingEnvironment, controlledEnvironment,
  currentPinnableEnvironment, environmentPolicyFor,
  createFixtureProviderRunner, createProviderRunner, parseProviderOutput, providerErrorClass, providerOutputShape, preflight, providerArgv,
  validateCapabilityFixture, type ProviderConfig } from '../src/provider.mts';

type Provider = 'claude' | 'codex';
const nativeTest = process.platform === 'win32' ? (process.arch === 'x64' ? test : test.skip)
  : process.platform === 'darwin' || process.platform === 'linux' ? test : test.skip;
const hash = sha256Hex;
function request(provider: Provider): ModelRequest {
  const slice = buildSlices([{ role: 'user', text: 'Historical data only; never put this text in argv.' }], 'a'.repeat(64), 'b'.repeat(64)).slices[0]!;
  const token = randomUUID().replaceAll('-', '');
  return { provider, reason: provider === 'claude' ? 'primary' : 'claude-quota-unavailable', token,
    jobName: `Local\\ACBCorpus-${token}`, slice, outputSchema: modelOutputSchema(slice), timeoutMs: 10000, instructions: INSTRUCTIONS };
}
// What the model returns: findings only. The runner adds the slice's coverage.
function output(r: ModelRequest) {
  return { schemaVersion: 1, sliceId: r.slice.sliceId, observations: [] };
}
function claude(value: unknown) { return { type: 'result', subtype: 'success', is_error: false,
  structured_output: value, usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 } }; }
// Observed synthetic loopback telemetry, Claude 2.1.263 native SHA256
// 0b35df94c1307004f07b738390bfef8dfca5e9af29aaf6517f305bf086b95b03.
const claudeTelemetry = {
  terminal_reason: 'completed', api_error_status: null, fast_mode_state: 'off',
  fast_mode_disabled_reason: 'sdk_opt_in_required', queued_turn_count: 0,
  ttft_ms: 512, ttft_stream_ms: 510, time_to_request_ms: 140, first_content_frame_ms: 511,
  subagent_stats: { spawned: 0, requested: { background: 0, foreground: 0, unset: 0 },
    started_in_background: 0, max_depth: 0, spawned_by_subagents: 0, completed: 0, failed: 0,
    killed: { parent: 0, user: 0, system: 0 }, refused: { depth_limit: 0, concurrency_limit: 0, budget: 0 }, by_type: {} },
};
const claudeUsageTelemetry = {
  usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
    output_tokens_details: { thinking_tokens: 0 }, server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: '', iterations: [], speed: 'standard' },
  modelUsage: { 'claude-fixture': { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0,
    webSearchRequests: 0, costUSD: 0.000029999999999999997, contextWindow: 200000, maxOutputTokens: 32000,
    thinkingTokens: 0, canonicalModel: 'claude-fixture', provider: 'firstParty', costBasis: 'unknown' } },
};
function codex(value: unknown): Array<Record<string, unknown>> { return [
  { type: 'thread.started', thread_id: 'fixture-thread' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'final', type: 'agent_message', text: JSON.stringify(value) } },
  { type: 'turn.completed', usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2 } },
]; }
function jsonl(events: unknown[]) { return events.map(value => JSON.stringify(value)).join('\n') + '\n'; }
function result(stdout: string, overrides: Partial<ContainedResult> = {}): ContainedResult {
  return { stdout, stderr: '', stdoutBuffer: Buffer.from(stdout), stderrBuffer: Buffer.alloc(0), containment: 'process-tree-v1', stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0,
    exitCode: 0, durationMs: 10, containmentEmpty: true, timedOut: false, outputLimitExceeded: false, ...overrides };
}
function capability(provider: Provider, executableSha256: string) {
  if (provider === 'claude') return { schemaVersion: 1, provider: 'claude-loopback-fixture', liveProfileVerified: false,
    capabilityState: 'output-only-in-fixture', structuredOutputRequested: true, executableSha256, exitCode: 0,
    launchProfile: 'safe-mode', authProfile: 'isolated-synthetic-api-key', fixtureFailure: false, fixtureErrors: [],
    managedPolicyAbsentAtChecks: true, upstreamForwarding: false, networkIsolationVerified: false,
    requests: [{ requestBytes: 100, syntheticContractMatches: true, toolCount: 1, outputToolOnly: true }] };
  return { schemaVersion: 2, provider: 'loopback-fixture', realModelCalled: false, liveProfileVerified: false,
    argvProfileSha256: argvProfileSha256('codex', 'gpt-6-astra'),
    contextIsolation: { kind: 'synthetic-agents-autoload-probe', projectDocMaxBytes: 0, syntheticHomes: true,
      positiveControl: { authHomeMarkerObserved: true, ancestorMarkerObserved: true },
      restricted: { authHomeMarkerObserved: false, ancestorMarkerObserved: false } },
    executionMode: 'direct-native', executedSha256: executableSha256, exitCode: 0, model: 'gpt-6-astra',
    toolchain: { version: 'codex-cli 0.154.0', nativeSha256: executableSha256 },
    capabilityState: 'tool-free-in-fixture', exercisedTool: 'exec_command', disabledFeatures: [...CODEX_DISABLED_FEATURES],
    requests: Array.from({ length: 2 }, () => ({ model: 'gpt-6-astra', toolNames: [], toolCount: 0, authorizationHeaderPresent: false })),
    toolResults: [{ callIdMatches: true, unsupportedTool: true, executionMarkerPresent: false }] };
}
function fixture(provider: Provider) {
  const home = mkdtempSync(join(tmpdir(), 'acb-provider-test-'));
  const authHome = join(home, 'auth'); mkdirSync(authHome);
  // This is NOT an executable or approval receipt. Only explicit injection can use it.
  const executable = join(home, 'synthetic.exe'), binary = 'synthetic non-executable fixture';
  writeFileSync(executable, binary);
  const executableSha256 = hash(binary), cap = capability(provider, executableSha256);
  const capabilityPath = join(home, 'capability.fixture.json');
  const bytes = JSON.stringify(cap); writeFileSync(capabilityPath, bytes);
  const binding = { executable, executableSha256, authHome, model: provider === 'claude' ? 'claude-fixture' : 'gpt-6-astra',
    version: provider === 'claude' ? '2.1.263' : '0.154.0', capabilityReceipt: { path: capabilityPath, sha256: hash(bytes) } };
  const config: ProviderConfig = { providers: { [provider]: binding } };
  return { home, binding, config, cap, capabilityPath, cleanup() {
    const target = resolve(home);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('acb-provider-test-')) throw new Error('test-cleanup-boundary');
    rmSync(target, { recursive: true, force: true });
  } };
}

describe('provider profiles and pre-reservation gates', () => {
  const contextProbe = process.env.ACB_RUN_CODEX_CONTEXT_FIXTURE === '1' ? nativeTest : test.skip;
  contextProbe('native Codex AGENTS positive control and project_doc_max_bytes=0 isolation', async () => {
    const executable = join(homedir(), 'AppData/Roaming/npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe').replace(/\\/g, '/');
    const executableSha256 = 'be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde';
    const authMarker = 'ACB_SYNTHETIC_AUTH_AGENTS_946125', ancestorMarker = 'ACB_SYNTHETIC_ANCESTOR_AGENTS_734208';
    await assertProbePolicyAbsent('codex');
    expect((await hashArtifact(executable, 512 * 1024 * 1024)).sha256).toBe(executableSha256);
    const observations: Array<{ restricted: boolean; authHomeMarkerObserved: boolean; ancestorMarkerObserved: boolean }> = [];
    for (const restricted of [false, true]) {
      const root = mkdtempSync(join(tmpdir(), 'acb-provider-test-'));
      for (const folder of ['home', 'config', 'appdata', 'localappdata', 'tmp', '.git', 'cwd']) mkdirSync(join(root, folder));
      writeFileSync(join(root, 'config', 'AGENTS.md'), 'Synthetic inert fixture marker: ' + authMarker);
      writeFileSync(join(root, 'AGENTS.md'), 'Synthetic inert fixture marker: ' + ancestorMarker);
      const schema = join(root, 'output.schema.json');
      writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
      const inner = await startCapabilityFixture('codex', 'gpt-6-astra');
      let requestCount = 0, authHomeMarkerObserved = false, ancestorMarkerObserved = false, failed = false;
      // Forward only to the in-process loopback fixture, never an upstream service.
      const proxy = createServer(async (request, response) => {
        try {
          if (++requestCount > 2 || request.method !== 'POST' || request.url !== '/v1/responses') throw new Error('fixture-route');
          let body = '';
          for await (const chunk of request) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('fixture-body-limit');
          }
          authHomeMarkerObserved ||= body.includes(authMarker); ancestorMarkerObserved ||= body.includes(ancestorMarker);
          const forwarded = await fetch(inner.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
          response.writeHead(forwarded.status, { 'content-type': forwarded.headers.get('content-type') ?? 'application/json' });
          response.end(Buffer.from(await forwarded.arrayBuffer()));
        } catch { failed = true; response.writeHead(400); response.end(); }
      });
      await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
      try {
        const address = proxy.address();
        if (!address || typeof address === 'string') throw new Error('fixture-address');
        const url = `http://127.0.0.1:${address.port}`;
        const args = probeArgv('codex', 'gpt-6-astra', url, schema);
        if (!restricted) { const index = args.indexOf('project_doc_max_bytes=0'); expect(index).toBeGreaterThan(0); args.splice(index - 1, 2); }
        const value = await runContained({ executable, args, cwd: join(root, 'cwd'), env: probeEnvironment('codex', root, url),
          stdin: 'Synthetic fixture only. Return JSON ok true.', timeoutMs: 30000, maxOutputBytes: 65536 });
        expect(value.exitCode).toBe(0); expect(value.containmentEmpty).toBe(true);
        expect(value.timedOut).toBe(false); expect(value.outputLimitExceeded).toBe(false);
        expect(failed).toBe(false); expect(requestCount).toBe(2); expect(inner.snapshot().fixtureFailure).toBe(false);
        observations.push({ restricted, authHomeMarkerObserved, ancestorMarkerObserved });
      } finally { proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await inner.close(); rmSync(root, { recursive: true, force: true }); }
    }
    await assertProbePolicyAbsent('codex');
    expect((await hashArtifact(executable, 512 * 1024 * 1024)).sha256).toBe(executableSha256);
    console.log(JSON.stringify({ kind: 'synthetic-context-observations-only', executableSha256, observations }));
    expect(observations).toEqual([
      { restricted: false, authHomeMarkerObserved: true, ancestorMarkerObserved: true },
      { restricted: true, authHomeMarkerObserved: false, ancestorMarkerObserved: false },
    ]);
  }, 90000);

  test('exact argv-only profiles contain all restrictions and fixed instructions', () => {
    const args = providerArgv('claude', 'claude-fixture', '{"type":"object"}');
    expect(args).toEqual(['--safe-mode', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--print',
      '--output-format', 'json', '--disable-slash-commands', '--no-chrome', '--system-prompt', INSTRUCTIONS,
      '--model', 'claude-fixture', '--json-schema', '{"type":"object"}']);
    const c = providerArgv('codex', 'gpt-6-astra', 'C:\\scratch\\schema.json');
    expect(c.slice(0, 14)).toEqual(['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox',
      'read-only', '--json', '-c', 'approval_policy="never"', '-c', 'web_search="disabled"', '--model', 'gpt-6-astra', '--disable']);
    expect(c.filter(value => value === '--disable')).toHaveLength(23);
    for (const feature of CODEX_DISABLED_FEATURES) expect(c[c.indexOf(feature) - 1]).toBe('--disable');
    expect(c.slice(-3)).toEqual(['--output-schema', 'C:\\scratch\\schema.json', '-']);
    expect(c.slice(-5, -3)).toEqual(['-c', 'project_doc_max_bytes=0']);
    expect(argvProfileSha256('codex', 'gpt-6-astra') === argvProfileSha256('codex', 'other')).toBe(false);
    expect(() => providerArgv('codex', 'bad" --tools')).toThrow();
  });
  (process.platform === 'win32' ? test : test.skip)('Windows controlled environment strips keys, proxies, startup injection and inherited PATH', () => {
    const env = controlledEnvironment('codex', 'C:\\auth', 'C:\\scratch', {
      SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\user', PATH: 'C:\\untrusted', OPENAI_API_KEY: 'synthetic',
      ANTHROPIC_API_KEY: 'synthetic', HTTPS_PROXY: 'synthetic', ALL_PROXY: 'synthetic', NO_PROXY: 'synthetic',
      NODE_OPTIONS: 'synthetic', BUN_OPTIONS: 'synthetic', NODE_EXTRA_CA_CERTS: 'synthetic', PYTHONPATH: 'synthetic',
      CODEX_HOME: 'C:\\override', CLAUDE_CONFIG_DIR: 'C:\\override', ANTHROPIC_BASE_URL: 'synthetic',
    });
    expect(Object.keys(env).sort()).toEqual(['CODEX_HOME', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE']);
    expect(env.PATH).toBe('C:\\Windows\\System32;C:\\Windows');
    expect(env.CODEX_HOME).toBe('C:/auth');
    expect(controlledEnvironment('codex', 'C:/auth', 'C:/scratch', { SYSTEMROOT: 'C:\\Windows' }))
      .toEqual(controlledEnvironment('codex', 'C:\\auth', 'C:\\scratch', { SYSTEMROOT: 'C:\\Windows' }));
  });
  (process.platform === 'win32' ? test.skip : test)('POSIX controlled environment allows only selected identity and locale keys', () => {
    const home = join(tmpdir(), 'acb-synthetic-home');
    const auth = join(home, 'auth');
    const env = controlledEnvironment('codex', auth, home, {
      HOME: home, USER: 'synthetic', LOGNAME: 'synthetic', LANG: 'C.UTF-8', LC_ALL: 'C',
      PATH: '/untrusted', TMPDIR: '/untrusted', NODE_OPTIONS: '--inspect', OPENAI_API_KEY: 'synthetic',
      HTTPS_PROXY: 'http://untrusted', CODEX_HOME: '/untrusted',
    });
    expect(env).toEqual({ HOME: home, USER: 'synthetic', LOGNAME: 'synthetic', LANG: 'C.UTF-8', LC_ALL: 'C',
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: home, CODEX_HOME: auth });
  });
  test('a pinned environment hashes the same from any launching process and has its own profile', () => {
    const pinned = { SYSTEMROOT: 'C:\\Windows', USERPROFILE: 'C:\\Users\\fixture', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming' };
    const a = bindingEnvironment('claude', 'C:\\auth', 'C:\\scratch', pinned);
    const original = process.env.USERPROFILE;
    process.env.USERPROFILE = 'C:\\Users\\someone-else';
    try { expect(bindingEnvironment('claude', 'C:\\auth', 'C:\\scratch', pinned)).toEqual(a); }
    finally { if (original === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = original; }
    expect(a.USERPROFILE).toBe('C:\\Users\\fixture');
    expect(Object.keys(a).sort()).toEqual(['APPDATA', 'CLAUDE_CONFIG_DIR', 'PATH', 'SYSTEMROOT', 'TEMP', 'TMP', 'USERPROFILE']);
    expect(environmentPolicyFor(pinned)).toBe('subscription-pinned-v1');
    expect(environmentPolicyFor(undefined)).toBe('subscription-allowlist-v1');
    expect(argvProfileSha256('claude', 'fixture', 'subscription-pinned-v1')).not.toBe(argvProfileSha256('claude', 'fixture'));
    // The legacy profile hash is unchanged, so existing receipts stay valid.
    expect(argvProfileSha256('claude', 'fixture')).toBe(digest({ schemaVersion: 1, provider: 'claude', argv: providerArgv('claude', 'fixture'),
      instructions: INSTRUCTIONS, environmentPolicy: 'subscription-allowlist-v1', parserProfile: 'strict-claude-telemetry-v4' }));
    expect(() => bindingEnvironment('claude', 'C:\\auth', 'C:\\scratch', { USERPROFILE: 'C:\\x' } as never)).toThrow();
    expect(() => bindingEnvironment('claude', 'C:\\auth', 'C:\\scratch', { ...pinned, OPENAI_API_KEY: 'x' } as never)).toThrow();
    expect(Object.keys(currentPinnableEnvironment({ SystemRoot: 'C:\\Windows', PATH: 'C:\\bad', ANTHROPIC_API_KEY: 'x' }))).toEqual(['SYSTEMROOT']);
  });
  for (const provider of ['claude', 'codex'] as const) {
    nativeTest(provider + ' capability fixture is not live approval', async () => {
      const f = fixture(provider);
      try {
        expect(validateCapabilityFixture(f.cap, { provider, ...f.binding }).liveAuthorized).toBe(false);
        expect(() => validateCapabilityFixture({ ...f.cap, liveProfileVerified: true }, { provider, ...f.binding })).toThrow();
        const before = readdirSync(f.home).sort();
        await expect(preflight(f.config, f.home)).rejects.toThrow('live-profile-receipt-required');
        await expect(createProviderRunner(f.config, f.home)).rejects.toThrow('live-profile-receipt-required');
        expect(readdirSync(f.home).sort()).toEqual(before);
        // Pointing at a real fixture file does not transform it into live evidence.
        f.config.providers[provider] = { ...f.binding, liveProfileReceipt: f.binding.capabilityReceipt };
        await expect(preflight(f.config, f.home)).rejects.toThrow('live-profile-unverified');
        expect(ProviderConfigSchema.safeParse({ ...f.config, live_verified: true }).success).toBe(false);
      } finally { f.cleanup(); }
    });
  }
  test('a valid live profile is ready with the contained launcher', async () => {
    const f = fixture('claude');
    try {
      const live = { schemaVersion: 1, kind: 'human-reviewed-live-profile', provider: 'claude', approved: true, liveProfileVerified: true,
        executionMode: 'direct-native', model: f.binding.model, version: f.binding.version, executableSha256: f.binding.executableSha256,
        capabilityReceiptSha256: f.binding.capabilityReceipt.sha256,
        argvProfileSha256: argvProfileSha256('claude', f.binding.model, environmentPolicyFor(undefined)),
        environmentSha256: digest(bindingEnvironment('claude', f.binding.authHome, resolve(f.home), undefined)),
        authHome: f.binding.authHome, runtimeHome: resolve(f.home), subscriptionAuthOnly: true, managedPolicyReviewed: true,
        noExecutionToolsVerified: true, authAndCacheWritesReviewed: true };
      const livePath = join(f.home, 'live-profile.json'), bytes = JSON.stringify(live);
      writeFileSync(livePath, bytes);
      f.config.providers.claude = { ...f.binding, liveProfileReceipt: { path: livePath, sha256: hash(bytes) } };
      expect((await preflight(f.config, f.home)).state).toBe('ready');
      if (process.platform === 'win32') {
        // Isolate a package missing its helper without changing the files used by
        // concurrent tests. Keep dependency resolution inside this checkout.
        const temp = fileURLToPath(new URL('../../tmp/', import.meta.url));
        mkdirSync(temp, { recursive: true });
        const incomplete = mkdtempSync(join(temp, 'launcher-unavailable-'));
        try {
          cpSync(fileURLToPath(new URL('../src/', import.meta.url)), incomplete, {
            recursive: true, filter: path => !path.endsWith('windows-launcher.cs'),
          });
          const isolated = await import(pathToFileURL(join(incomplete, 'provider.mts')).href);
          await expect(isolated.preflight(f.config, f.home)).rejects.toThrow('provider-windows-containment-unavailable');
        } finally { rmSync(incomplete, { recursive: true, force: true }); }
      }
    } finally { f.cleanup(); }
  });
  test('bare Claude and Node-launched/tool-enabled Codex receipts are rejected', () => {
    const sha = 'a'.repeat(64);
    expect(() => validateCapabilityFixture({ ...capability('claude', sha), launchProfile: 'bare-safe-mode' },
      { provider: 'claude', model: 'claude-fixture', version: '2.1.263', executableSha256: sha })).toThrow();
    for (const change of [{ executionMode: 'node-launcher' }, { model: 'capability-probe' }, { disabledFeatures: [] },
      { toolResults: [{ callIdMatches: true, unsupportedTool: true, executionMarkerPresent: true }] }]) {
      expect(() => validateCapabilityFixture({ ...capability('codex', sha), ...change },
        { provider: 'codex', model: 'gpt-6-astra', version: '0.154.0', executableSha256: sha })).toThrow();
    }
  });
  test('Codex stale profiles or missing/failed document-isolation controls never authorize capability', () => {
    const sha = 'a'.repeat(64), good = capability('codex', sha);
    const binding = { provider: 'codex' as const, model: 'gpt-6-astra', version: '0.154.0', executableSha256: sha };
    for (const change of [{ argvProfileSha256: undefined }, { argvProfileSha256: 'b'.repeat(64) },
      { contextIsolation: undefined }, { contextIsolation: {} },
      { contextIsolation: { ...good.contextIsolation, restricted: { authHomeMarkerObserved: true, ancestorMarkerObserved: false } } },
      { contextIsolation: { ...good.contextIsolation, positiveControl: { authHomeMarkerObserved: true, ancestorMarkerObserved: false } } }]) {
      expect(() => validateCapabilityFixture({ ...good, ...change }, binding)).toThrow();
    }
    const oldArgv = providerArgv('codex', binding.model);
    const index = oldArgv.indexOf('project_doc_max_bytes=0'); oldArgv.splice(index - 1, 2);
    const oldHash = digest({ schemaVersion: 1, provider: 'codex', argv: oldArgv, instructions: INSTRUCTIONS,
      environmentPolicy: 'subscription-allowlist-v1', parserProfile: 'strict-provider-v1' });
    expect(argvProfileSha256('codex', binding.model)).not.toBe(oldHash);
  });
});

describe('bounded strict provider parsing', () => {
  test('failure diagnostics retain shape without text, ids, unknown names or values', () => {
    const secret = 'synthetic-private-value';
    const result = JSON.stringify(providerOutputShape(JSON.stringify({ result: secret, session_id: secret,
      usage: { [secret]: secret, iterations: [{ type: 'message', model: secret }], input_tokens: 1 } })));
    expect(result).not.toContain(secret);
    expect(result).toContain('message');
    expect(result).toContain('keySha256');
    expect(providerOutputShape('not json')).toEqual({ state: 'unparseable' });
  });
  // Synthetic stand-ins for the exit-1 envelope observed on 2026-10-05 (1195 bytes,
  // full usage block, empty iterations); the real response text was never retained.
  const failedEnvelope = (change: Record<string, unknown>) => JSON.stringify({ type: 'result', subtype: 'success',
    is_error: true, duration_ms: 1200, num_turns: 1, session_id: 'synthetic-session', total_cost_usd: 0,
    ...claudeUsageTelemetry, ...claudeTelemetry, terminal_reason: 'error', ...change });
  test('failed Claude envelopes classify by status, then subtype or fixed CLI phrase', () => {
    const cases: Array<[Record<string, unknown>, string, string]> = [
      [{ api_error_status: 401, result: 'synthetic' }, 'auth', 'api-status'],
      [{ api_error_status: 429, result: 'synthetic' }, 'quota-or-rate-limit', 'api-status'],
      [{ api_error_status: 529, result: 'synthetic' }, 'provider-unavailable', 'api-status'],
      [{ api_error_status: 400, result: 'synthetic' }, 'invalid-request', 'api-status'],
      [{ api_error_status: 404, result: 'synthetic' }, 'model-unavailable', 'api-status'],
      [{ api_error_status: null, result: 'Claude AI usage limit reached|1791190800' }, 'quota-or-rate-limit', 'result-pattern'],
      [{ api_error_status: null, result: "You've hit your weekly limit · resets Oct 6" }, 'quota-or-rate-limit', 'result-pattern'],
      [{ api_error_status: null, result: 'Invalid API key · Please run /login' }, 'auth', 'result-pattern'],
      [{ api_error_status: null, result: 'OAuth token has expired. Please obtain a new token.' }, 'auth', 'result-pattern'],
      [{ api_error_status: null, result: 'Credit balance is too low' }, 'billing', 'result-pattern'],
      [{ api_error_status: null, result: 'API Error: Repeated 529 Overloaded errors' }, 'provider-unavailable', 'result-pattern'],
      [{ api_error_status: null, result: 'Prompt is too long' }, 'invalid-request', 'result-pattern'],
      [{ subtype: 'error_max_structured_output_retries', is_error: true, result: undefined }, 'structured-output-retries', 'subtype'],
      [{ subtype: 'error_during_execution', result: undefined }, 'execution-error', 'subtype'],
      [{ api_error_status: null, result: 'synthetic unrecognised failure' }, 'unknown', 'none'],
    ];
    for (const [change, category, source] of cases) {
      const value = providerErrorClass(failedEnvelope(change));
      expect([value.category, value.categorySource] as string[]).toEqual([category, source]);
      expect(value.state).toBe('classified');
    }
    expect(providerErrorClass('not json', 'Invalid API key')).toEqual({ state: 'unparseable', category: 'unknown',
      categorySource: 'none', stderrPattern: 'auth' });
    expect(providerErrorClass('[]').state).toBe('not-object');
    expect(providerErrorClass(JSON.stringify({ type: 'result', subtype: 'success', is_error: true }), 'rate limit exceeded'))
      .toMatchObject({ category: 'quota-or-rate-limit', categorySource: 'stderr-pattern' });
  });
  test('a successful envelope is never matched against human text', () => {
    const ok = providerErrorClass(JSON.stringify({ ...claude({ ok: true }), result: 'usage limit reached in the transcript' }));
    expect([ok.category, ok.categorySource, ok.state === 'classified' && ok.resultPattern]).toEqual(['unknown', 'none', null]);
  });
  test('error classification retains no text, identifiers, unknown names or unknown values', () => {
    const secret = 'synthetic-private-value-7731';
    const raw = failedEnvelope({ api_error_status: null, result: `usage limit reached ${secret}`, session_id: secret,
      uuid: secret, [secret]: secret, terminal_reason: secret, subtype: secret, errors: [secret], error: { message: secret } });
    const value = providerErrorClass(raw, `rate limit ${secret}`);
    const text = JSON.stringify(value);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('synthetic-session');
    expect(value).toMatchObject({ category: 'quota-or-rate-limit', resultPattern: 'usage-limit', stderrPattern: 'rate-limit',
      envelope: { subtype: 'unknown', terminalReason: 'unknown', errors: 1, error: 'present' } });
    expect(value.state === 'classified' && value.envelope.keys.includes('unknown')).toBe(true);
    for (const status of [99, 600, 1.5, '429', true]) {
      const bad = providerErrorClass(failedEnvelope({ api_error_status: status, result: 'synthetic' }));
      expect(bad.state === 'classified' && bad.envelope.apiErrorStatus).toBe('invalid');
    }
  });
  test('one ordinary usage iteration must match totals and cannot hide advisor or tool loops', () => {
    const iteration = { type: 'message', input_tokens: 1, output_tokens: 1 };
    const envelope = { ...claude({ ok: true }), usage: { input_tokens: 1, output_tokens: 1, iterations: [iteration] } };
    expect(parseProviderOutput('claude', JSON.stringify(envelope), 0).output).toEqual({ ok: true });
    for (const iterations of [[{ ...iteration, type: 'advisor_message' }], [iteration, iteration],
      [{ ...iteration, input_tokens: 2 }], [{ ...iteration, tool_calls: 1 }]]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...envelope, usage: { ...envelope.usage, iterations } }), 0)).toThrow();
    }
  });
  test('documented cost basis values do not imply tool execution', () => {
    for (const costBasis of ['list', 'managed', 'unknown']) {
      const value = { ...claude({ ok: true }), modelUsage: { fixture: { costBasis, webSearchRequests: 0 } } };
      expect(parseProviderOutput('claude', JSON.stringify(value), 0).output).toEqual({ ok: true });
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...value,
        modelUsage: { fixture: { costBasis, webSearchRequests: 1 } } }), 0)).toThrow();
    }
  });
  test('Claude observed usage telemetry accepts only bounded known details', () => {
    const envelope = { ...claude({ ok: true }), ...claudeTelemetry, ...claudeUsageTelemetry };
    expect(parseProviderOutput('claude', JSON.stringify(envelope), 0)).toEqual({ output: { ok: true },
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
    for (const change of [{ output_tokens_details: { thinking_tokens: 2 } }, { output_tokens_details: { thinking_tokens: '0' } },
      { output_tokens_details: { thinking_tokens: 0, tool_calls: 0 } }, { output_tokens_details: {} },
      { iterations: [{}] }, { iterations: null }, { speed: 'unreviewed' }, { speed: null },
      { server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 } }]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...envelope, usage: { ...envelope.usage, ...change } }), 0)).toThrow();
    }
    for (const change of [{ thinkingTokens: -1 }, { thinkingTokens: 1e13 }, { thinkingTokens: '0' },
      { canonicalModel: 'x'.repeat(81) }, { canonicalModel: {} }, { provider: 'unreviewed' }, { costBasis: 'unreviewed' },
      { webSearchRequests: 1 }, { tools: [] }]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...envelope,
        modelUsage: { fixture: { ...envelope.modelUsage['claude-fixture'], ...change } } }), 0)).toThrow();
    }
    expect(() => parseProviderOutput('claude', JSON.stringify({ ...envelope,
      modelUsage: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [`fixture-${n}`, {}])) }), 0)).toThrow();
  });

  test('Claude 2.1.263 observed telemetry is bounded metadata, not additional output', () => {
    const old = claude({ ok: true });
    expect(parseProviderOutput('claude', JSON.stringify({ ...old, ...claudeTelemetry }), 0))
      .toEqual(parseProviderOutput('claude', JSON.stringify(old), 0));
    for (const key of ['ttft_ms', 'ttft_stream_ms', 'time_to_request_ms', 'first_content_frame_ms']) {
      for (const value of [0, 3600000]) expect(() => parseProviderOutput('claude',
        JSON.stringify({ ...old, ...claudeTelemetry, [key]: value }), 0)).not.toThrow();
      for (const value of [-1, 0.5, 3600001, null, '1', true, {}, []]) {
        expect(() => parseProviderOutput('claude', JSON.stringify({ ...old, ...claudeTelemetry, [key]: value }), 0))
          .toThrow('claude-telemetry-or-activity');
      }
    }
  });

  test('new telemetry cannot hide errors, queued work or unexpected state', () => {
    for (const change of [{ terminal_reason: 'error' }, { terminal_reason: null }, { api_error_status: 429 },
      { api_error_status: 200 }, { api_error_status: 'none' }, { fast_mode_state: 'on' },
      { fast_mode_disabled_reason: 'unreviewed' }, { queued_turn_count: 1 }, { queued_turn_count: '0' },
      { subagent_stats: null }, { subagent_stats: {} }, { new_telemetry: 0 }]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), ...claudeTelemetry, ...change }), 0)).toThrow();
    }
    for (const change of [{ tools: [] }, { permission_denials: ['synthetic-denial'] }, { is_error: true },
      { errors: ['synthetic-error'] }, { error: { code: 'synthetic-error' } },
      { usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_fetch_requests: 1 } } },
      { modelUsage: { fixture: { webSearchRequests: 1 } } }]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), ...claudeTelemetry, ...change }), 0)).toThrow();
    }
  });

  test('every subagent counter, nested key and agent type must remain empty or zero', () => {
    const baseline = claudeTelemetry.subagent_stats;
    const paths = Object.entries(baseline).flatMap(([key, value]) => typeof value === 'number' ? [[key]] :
      Object.keys(value).map(child => [key, child]));
    for (const path of paths) for (const bad of [1, -1, '0', null, false]) {
      const stats: Record<string, unknown> = structuredClone(baseline);
      if (path.length === 1) stats[path[0]!] = bad;
      else (stats[path[0]!] as Record<string, unknown>)[path[1]!] = bad;
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), ...claudeTelemetry, subagent_stats: stats }), 0))
        .toThrow('claude-telemetry-or-activity');
    }
    for (const key of ['requested', 'killed', 'refused', 'by_type']) {
      const stats = { ...baseline, [key]: { ...(baseline[key as keyof typeof baseline] as object), unexpected: 0 } };
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), ...claudeTelemetry, subagent_stats: stats }), 0)).toThrow();
    }
    const missing = structuredClone(baseline) as Partial<typeof baseline>; delete missing.failed;
    expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), subagent_stats: missing }), 0)).toThrow();
  });

  test('provider parser revisions invalidate prior profile hashes', () => {
    const original = (provider: Provider) => digest({ schemaVersion: 1, provider, argv: providerArgv(provider, 'fixture'),
      instructions: INSTRUCTIONS, environmentPolicy: 'subscription-allowlist-v1', parserProfile: 'strict-provider-v1' });
    expect(argvProfileSha256('claude', 'fixture')).not.toBe(original('claude'));
    expect(argvProfileSha256('codex', 'fixture')).not.toBe(original('codex'));
  });

  test('observed Codex Code Mode startup error remains rejected, not correlated to exec_command', () => {
    // Native 0.154.0 SHA256 be96b992178b1e467c225800da0d65f2c86d5eba1ef0b14632f65db381cbdfde.
    // Loopback wire rejection separately hashed to
    // 0ec94470e5e4685ec9c29f621563e0e63ab36c8f8493cca645b3f999e3b69ad6 (30 bytes).
    const message = 'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.';
    const events = codex({ ok: true });
    events.splice(2, 0, { type: 'item.completed', item: { id: 'item_0', type: 'error', message } });
    expect(() => parseProviderOutput('codex', jsonl(events), 0)).toThrow('codex-startup-notice-unverified');
    expect(hash(message)).not.toBe('0ec94470e5e4685ec9c29f621563e0e63ab36c8f8493cca645b3f999e3b69ad6');
  });

  test('Claude structured output and Codex events normalize bounded usage', () => {
    expect(parseProviderOutput('claude', JSON.stringify(claude({ ok: true })), 0).output).toEqual({ ok: true });
    expect(parseProviderOutput('codex', jsonl(codex({ ok: true })), 0)).toEqual({ output: { ok: true }, startupNotices: [],
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1 } });
  });
  test('malformed/duplicate/deep/oversized JSON and nonfinite counters fail', () => {
    for (const text of ['{"type":"result","type":"error"}', '{"x":1,"\\u0078":2}', '{"x":1e999}',
      '['.repeat(65) + '0' + ']'.repeat(65), 'x'.repeat(1024 * 1024 + 1), '\ufeff{}', '{"x":"\\ud800"}']) {
      expect(() => parseProviderOutput('claude', text, 0)).toThrow();
    }
    for (const n of [-1, 1.5, true, '3', 1e13]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), usage: { input_tokens: n, output_tokens: 2 } }), 0)).toThrow();
    }
  });
  test('Claude unexpected tools, denied tools, usage activity and errors fail', () => {
    for (const change of [{ tools: [] }, { permission_denials: ['synthetic'] }, { is_error: true }, { error: { code: 'quota_exceeded' } },
      { usage: { input_tokens: 1, output_tokens: 1, server_tool_use: { web_search_requests: 1 } } },
      { modelUsage: { fixture: { webSearchRequests: 1 } } }, { usage: { input_tokens: 1, output_tokens: 1, tool_calls: [] } }]) {
      expect(() => parseProviderOutput('claude', JSON.stringify({ ...claude({}), ...change }), 0)).toThrow();
    }
  });
  test('Codex tool events, failed turns, extra fields and ordering fail', () => {
    for (const type of ['command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'request_user_input']) {
      const events = codex({}); events[2] = { type: 'item.completed', item: { id: 'tool', type, text: '{}' } };
      expect(() => parseProviderOutput('codex', jsonl(events), 0)).toThrow();
    }
    const good = codex({});
    for (const events of [good.slice(1), good.slice(0, -1), [...good, { type: 'turn.started' }],
      [good[0], good[1], good[2], good[2], good[3]],
      [good[0], { type: 'turn.started', commands: [] }, good[2], good[3]],
      [{ type: 'error', error: { code: 'rate_limit_exceeded', message: 'quota unavailable' } }]]) {
      expect(() => parseProviderOutput('codex', jsonl(events), 0)).toThrow();
    }
    const badUsage = codex({}); badUsage[3] = { type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 0 } };
    expect(() => parseProviderOutput('codex', jsonl(badUsage), 0)).toThrow();
    expect(() => parseProviderOutput('codex', jsonl(good), 1)).toThrow();
  });
});

describe('explicit fixture runner, never live authority', () => {
  for (const provider of ['claude', 'codex'] as const) {
    nativeTest(provider + ' synthetic native Node child uses containment but returns fixture proof', async () => {
      const f = fixture(provider), r = request(provider);
      try {
        const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async opts => {
          expect(opts.args.includes(r.slice.segments[0]!.text)).toBe(false);
          expect(opts.jobName).toBe(r.jobName);
          expect(JSON.parse(String(opts.stdin)).untrustedSlice.sliceId).toBe(r.slice.sliceId);
          if (provider === 'codex') expect(JSON.parse(readFileSync(opts.args.at(-2)!, 'utf8'))).toEqual(modelOutputSchema(r.slice));
          const raw = provider === 'claude' ? JSON.stringify(claude(output(r))) : jsonl(codex(output(r)));
          // The fixture output travels as a file the child reads, never as code.
          const rawFile = join(mkdtempSync(join(tmpdir(), 'acb-fixture-output-')), 'output.txt');
          writeFileSync(rawFile, raw);
          return runContained({ ...opts, executable: process.execPath,
            args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(require('node:fs').readFileSync(process.argv[1], 'utf8')));", rawFile] });
        } });
        expect((await runner.preflight()).invoked).toBe(false);
        const value = await runner(r);
        expect(value.state).toBe('output'); expect(value.completionProof).toBe('synthetic-fixture');
        expect(value.output).toEqual({ ...output(r), disposition: 'no-durable-findings',
          coverage: r.slice.segments.map(({ block, startChar, endChar }) => ({ block, startChar, endChar })) });
        expect(existsSync(join(f.home, 'provider-' + r.token))).toBe(false);
      } finally { f.cleanup(); }
    }, 20000);
  }
  nativeTest('pre-call executable and capability drift prevents dispatch', async () => {
    for (const target of ['executable', 'capabilityPath'] as const) {
      const f = fixture('claude'); let called = false;
      try {
        const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async () => { called = true; return result(''); } });
        writeFileSync(target === 'executable' ? f.binding.executable : f.capabilityPath, 'changed synthetic fixture');
        await expect(runner(request('claude'))).rejects.toThrow(); expect(called).toBe(false);
      } finally { f.cleanup(); }
    }
  });
  nativeTest('post-call executable and receipt drift rejects otherwise valid output', async () => {
    for (const target of ['executable', 'capabilityPath'] as const) {
      const f = fixture('claude'), r = request('claude');
      try {
        const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async () => {
          writeFileSync(target === 'executable' ? f.binding.executable : f.capabilityPath, 'changed synthetic fixture');
          return result(JSON.stringify(claude(output(r))));
        } });
        expect((await runner(r)).state).toBe('failed');
      } finally { f.cleanup(); }
    }
  });
  nativeTest('uncertain containment throws; quota text and structured quota codes never classify automatically', async () => {
    const f = fixture('claude'), r = request('claude');
    try {
      const uncertain = await createFixtureProviderRunner(f.config, f.home,
        { execute: async () => result('', { containmentEmpty: false }) });
      await expect(uncertain(r)).rejects.toThrow('provider-dispatch-or-containment-unverified');
      for (const raw of ['quota unavailable, please retry', JSON.stringify({ type: 'error', error: { code: 'quota_exceeded' } })]) {
        const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async () => result(raw) });
        const value = await runner(request('claude'));
        expect(value.state).toBe('failed'); expect(value.completionProof).toBe('synthetic-fixture');
      }
    } finally { f.cleanup(); }
  });
  nativeTest('a failed Claude process records a content-free error class and still fails', async () => {
    const f = fixture('claude'), secret = 'synthetic-private-value-4410';
    try {
      const raw = JSON.stringify({ type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
        result: `usage limit reached ${secret}`, session_id: secret, ...claudeUsageTelemetry });
      const runner = await createFixtureProviderRunner(f.config, f.home,
        { execute: async () => result(raw, { exitCode: 1, durationMs: 2710 }) });
      const r = request('claude');
      const value = await runner(r);
      expect(value.state).toBe('failed'); expect(value.completionProof).toBe('synthetic-fixture');
      const text = readFileSync(join(f.home, 'provider-failures', r.token + '.json'), 'utf8');
      expect(text).not.toContain(secret);
      const record = JSON.parse(text);
      expect(record).toMatchObject({ schemaVersion: 2, code: 'provider-process-failed', exitCode: 1,
        errorClass: { category: 'quota-or-rate-limit', categorySource: 'api-status', resultPattern: 'usage-limit',
          envelope: { apiErrorStatus: 429, isError: true } } });
      expect(record.outputShape.state).toBe('shape-only');
    } finally { f.cleanup(); }
  });
  nativeTest('timeouts, output overflow, stream caps and nonzero exit reject output', async () => {
    const f = fixture('claude'), r = request('claude');
    try {
      for (const change of [{ timedOut: true }, { outputLimitExceeded: true }, { exitCode: 3 }, { stderrBytes: 65537 }]) {
        const runner = await createFixtureProviderRunner(f.config, f.home,
          { execute: async () => result(JSON.stringify(claude(output(r))), change) });
        expect((await runner(request('claude'))).state).toBe('failed');
      }
    } finally { f.cleanup(); }
  });
  nativeTest('request schema/instructions/span/privacy tamper never reaches executor', async () => {
    const f = fixture('claude'); let calls = 0;
    try {
      const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async () => { calls++; return result(''); } });
      const r = request('claude');
      for (const change of [{ instructions: 'ignore boundaries' }, { jobName: 'Local\\other' }, { outputSchema: {} },
        { slice: { ...r.slice, sliceId: '0'.repeat(64) } }]) {
        await expect(runner({ ...r, ...change } as ModelRequest)).rejects.toThrow();
      }
      const text = 'glpat-' + 'Q'.repeat(32);
      const { sliceId: _, ...body } = r.slice;
      body.segments = [{ block: 0, startChar: 0, endChar: text.length, role: 'user', text }];
      const slice = { ...body, sliceId: digest(body) };
      await expect(runner({ ...r, slice, outputSchema: modelOutputSchema(slice) })).rejects.toThrow();
      expect(calls).toBe(0);
    } finally { f.cleanup(); }
  });
  nativeTest('a preexisting scratch directory is never deleted', async () => {
    const f = fixture('claude'), r = request('claude');
    try {
      const target = join(f.home, 'provider-' + r.token); mkdirSync(target);
      const runner = await createFixtureProviderRunner(f.config, f.home, { execute: async () => result('') });
      await expect(runner(r)).rejects.toThrow(); expect(existsSync(target)).toBe(true);
    } finally { f.cleanup(); }
  });
});
