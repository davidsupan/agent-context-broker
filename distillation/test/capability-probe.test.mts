import { describe, test, expect } from './expect.mts';
import { sha256Hex } from '../src/platform.mts';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCapabilityFixture, probeArgv, probeEnvironment, probeCapability, ProbeOptionsSchema, validateProbeOutput,
  LiveProbeOptionsSchema, describeLiveProbe, runLiveProbe, type LiveProbeOptions } from '../src/capability-probe.mts';
import { CODEX_DISABLED_FEATURES } from '../src/provider.mts';
import { runContained } from '../src/windows-job.mts';

const KEY = 'synthetic-loopback-fixture-not-a-credential';
const model = 'fixture-model';
function claude(tools: unknown[] = [{ name: 'StructuredOutput' }]) {
  return { model, stream: true, tools, messages: [{ role: 'user', content: 'synthetic private marker' }] };
}
function codex(input: unknown[] = []) { return { model, stream: true, tools: [], input }; }
async function send(url: string, provider: 'claude' | 'codex', payload: unknown, headers: Record<string, string> = {}) {
  return fetch(url + (provider === 'claude' ? '/v1/messages' : '/v1/responses'), {
    method: 'POST', headers: { 'content-type': 'application/json', ...(provider === 'claude' ? { 'x-api-key': KEY } : {}), ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
}

describe('bounded capability fixture', () => {
  test('Claude returns only StructuredOutput SSE and retains no prompt or headers', async () => {
    const fixture = await startCapabilityFixture('claude', model);
    try {
      expect((await fetch(fixture.url + '/api/hello', { method: 'HEAD' })).status).toBe(200);
      const response = await send(fixture.url, 'claude', claude());
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('StructuredOutput');
      const snapshot = fixture.snapshot();
      expect(snapshot.fixtureFailure).toBe(false);
      expect(snapshot.requests).toHaveLength(1);
      expect(snapshot.requests[0]).toMatchObject({ outputToolOnly: true, syntheticContractMatches: true, toolCount: 1 });
      expect(JSON.stringify(snapshot)).not.toContain('synthetic private marker');
      expect(JSON.stringify(snapshot)).not.toContain(KEY);
      snapshot.requests.length = 0;
      expect(fixture.snapshot().requests).toHaveLength(1);
    } finally { await fixture.close(); await fixture.close(); }
  });

  test('Codex challenges an undeclared execution tool and requires rejection before final output', async () => {
    const fixture = await startCapabilityFixture('codex', model);
    try {
      const first = await send(fixture.url, 'codex', codex());
      expect(first.status).toBe(200); expect(await first.text()).toContain('exec_command');
      const second = await send(fixture.url, 'codex', codex([{ type: 'function_call_output', call_id: 'fixture_call', output: 'unsupported tool: exec_command' }]));
      expect(second.status).toBe(200); expect(await second.text()).toContain('response.completed');
      expect(fixture.snapshot().toolResults).toEqual([{ callIdMatches: true, unsupportedTool: true, executionMarkerPresent: false, outputBytes: 30,
        outputSha256: sha256Hex('unsupported tool: exec_command') }]);
      expect(fixture.snapshot().fixtureFailure).toBe(false);
    } finally { await fixture.close(); }
  });

  test('rejects advertised tools before issuing challenge', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      const fixture = await startCapabilityFixture(provider, model);
      try {
        const payload = provider === 'claude' ? claude([{ name: 'Bash' }]) : { ...codex(), tools: [{ name: 'exec_command' }] };
        expect((await send(fixture.url, provider, payload)).status).toBe(400);
        expect(fixture.snapshot().fixtureFailure).toBe(true);
      } finally { await fixture.close(); }
    }
  });

  test('wrong auth, model, stream, JSON duplicates, depth and oversized payloads fail without logging content', async () => {
    const cases: Array<[unknown, Record<string, string>]> = [
      [claude(), { authorization: 'synthetic-rejected-value' }], [claude(), { 'x-api-key': 'synthetic-wrong-value' }],
      [{ ...claude(), model: 'wrong' }, {}], [{ ...claude(), stream: false }, {}],
      ['{"model":"a","m\\u006fdel":"b"}', {}], ['['.repeat(66) + '0' + ']'.repeat(66), {}],
      ['x'.repeat(1024 * 1024 + 1), {}], ['{"a":', {}],
    ];
    for (const [payload, headers] of cases) {
      const fixture = await startCapabilityFixture('claude', model);
      try {
        try { expect((await send(fixture.url, 'claude', payload, headers)).status).toBe(400); }
        catch (error) {
          // Node may reset a connection when the fixture rejects an oversized request before reading its body.
          if (typeof payload !== 'string' || payload.length <= 1024 * 1024 ||
              (error as { cause?: { code?: string } }).cause?.code !== 'ECONNRESET') throw error;
        }
        const state = fixture.snapshot(); expect(state.fixtureFailure).toBe(true);
        expect(JSON.stringify(state)).not.toContain('synthetic-rejected-value');
      } finally { await fixture.close(); }
    }
  });

  test('execution marker, wrong call id and absent rejection all fail', async () => {
    for (const [call_id, output] of [['fixture_call', 'SYNTHETIC_EXEC_PROBE'], ['wrong', 'unsupported tool'], ['fixture_call', 'done']]) {
      const fixture = await startCapabilityFixture('codex', model);
      try {
        await (await send(fixture.url, 'codex', codex())).text();
        expect((await send(fixture.url, 'codex', codex([{ type: 'function_call_output', call_id, output }]))).status).toBe(400);
        expect(fixture.snapshot().fixtureFailure).toBe(true);
      } finally { await fixture.close(); }
    }
  });

  test('unexpected paths, proxy attempts and idle connections fail closed', async () => {
    const fixture = await startCapabilityFixture('claude', model);
    try {
      expect((await fetch(fixture.url + '/not-allowed')).status).toBe(400);
      const address = new URL(fixture.url);
      await new Promise<void>(resolve => {
        const socket = connect(Number(address.port), '127.0.0.1', () => socket.write('CONNECT elsewhere.invalid:443 HTTP/1.1\r\nHost: elsewhere.invalid\r\n\r\n'));
        socket.on('error', () => {}); socket.on('close', () => resolve());
      });
      expect(fixture.snapshot().fixtureErrors).toContain('proxy-forbidden');
    } finally { await fixture.close(); }
    const idle = await startCapabilityFixture('codex', model);
    try {
      await new Promise<void>(resolve => { const socket = connect(Number(new URL(idle.url).port), '127.0.0.1');
        socket.on('error', () => {}); socket.on('close', () => resolve()); });
      expect(idle.snapshot().fixtureErrors).toContain('connection-deadline');
    } finally { await idle.close(); }
  }, 10000);

  test('request and connection budget cannot silently truncate into success', async () => {
    const fixture = await startCapabilityFixture('claude', model);
    try {
      for (let i = 0; i < 8; i++) await (await send(fixture.url, 'claude', claude())).text();
      try { await send(fixture.url, 'claude', claude()); } catch { /* Socket closes at the connection bound. */ }
      expect(fixture.snapshot().fixtureFailure).toBe(true);
      expect(fixture.snapshot().requests).toHaveLength(8);
    } finally { await fixture.close(); }
  });
});

describe('live observation pathway is separately authorized and coordinated', () => {
  const approval = { id: 'synthetic-test-approval', scope: 'two-synthetic-subscription-calls' as const,
    providers: ['claude', 'codex'] as ['claude', 'codex'], maxCalls: 2 as const,
    timeoutPerProviderMs: 60000 as const, globalBudgetSeconds: 1800 as const };
  test('missing approval, expanded bounds and arbitrary prompt/executor fields reject before reservation', async () => {
    let reservations = 0;
    const coordinator = { reserve: async () => { reservations++; throw new Error('test-no-dispatch'); } };
    await expect(runLiveProbe({} as never, coordinator)).rejects.toThrow('probe-live-options');
    expect(reservations).toBe(0);
    const basic = { provider: 'claude', executable: 'C:\\synthetic.exe', executableSha256: 'a'.repeat(64), version: '2.1.263',
      model: 'fixture-model', home: 'C:\\synthetic', authHome: 'C:\\synthetic\\auth',
      capabilityReceipt: { path: 'C:\\synthetic\\cap.json', sha256: 'a'.repeat(64) }, approval };
    expect(LiveProbeOptionsSchema.safeParse(basic).success).toBe(true);
    for (const changed of [{ ...basic, stdin: 'arbitrary' }, { ...basic, execute: () => {} },
      { ...basic, approval: { ...approval, maxCalls: 3 } }, { ...basic, approval: { ...approval, timeoutPerProviderMs: 60001 } },
      { ...basic, approval: { ...approval, globalBudgetSeconds: 1801 } }]) {
      expect(LiveProbeOptionsSchema.safeParse(changed).success).toBe(false);
    }
  });

  test('inspection is read-only; missing budget permit prevents all execution after valid fixture binding', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acb-live-probe-test-'));
    const digest = sha256Hex;
    try {
      const executable = join(root, 'synthetic.exe');
      const authHome = join(root, 'auth'); mkdirSync(authHome);
      const bytes = 'synthetic non-executable test bytes'; writeFileSync(executable, bytes);
      const capability = JSON.stringify({ schemaVersion: 1, provider: 'claude-loopback-fixture', exitCode: 0,
        liveProfileVerified: false, executableSha256: digest(bytes), launchProfile: 'safe-mode',
        authProfile: 'isolated-synthetic-api-key', capabilityState: 'output-only-in-fixture',
        structuredOutputRequested: true, fixtureFailure: false, fixtureErrors: [], managedPolicyAbsentAtChecks: true,
        upstreamForwarding: false, networkIsolationVerified: false,
        requests: [{ syntheticContractMatches: true, toolCount: 1, outputToolOnly: true, requestBytes: 100 }] });
      const receiptPath = join(root, 'capability.json'); writeFileSync(receiptPath, capability);
      const options: LiveProbeOptions = { provider: 'claude', executable, executableSha256: digest(bytes), version: '2.1.263',
        model: 'fixture-model', home: root, authHome, capabilityReceipt: { path: receiptPath, sha256: digest(capability) }, approval };
      const plan = await describeLiveProbe(options);
      expect(plan.timeoutMs + plan.cleanupBudgetMs).toBeLessThanOrEqual(60000);
      expect(plan.stdin).toContain('No private corpus'); expect(plan.args).toContain('--safe-mode');
      expect(plan.reservationSeconds).toBe(60);
      let reservations = 0;
      await expect(runLiveProbe(options, { reserve: async request => {
        reservations++; expect(request).toEqual({ approvalId: approval.id, provider: 'claude', seconds: 60, globalBudgetSeconds: 1800 });
        throw new Error('test-no-dispatch');
      } })).rejects.toThrow('test-no-dispatch');
      expect(reservations).toBe(1);
      writeFileSync(receiptPath, capability + ' ');
      await expect(runLiveProbe(options, { reserve: async () => { reservations++; throw new Error('unreachable'); } })).rejects.toThrow('probe-capability-changed');
      expect(reservations).toBe(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('native probe contracts', () => {
  test('Codex stdout must bind exactly one intentional rejection; unrelated errors never become evidence', () => {
    const message = 'unsupported tool: exec_command';
    const rejectionHash = sha256Hex(message);
    const error = { type: 'item.completed', item: { id: 'e1', type: 'error', message } };
    const head = [{ type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' }];
    const tail = [{ type: 'item.completed', item: { id: 'a1', type: 'agent_message', text: '{ "ok": true }' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0 } }];
    const text = (events: unknown[]) => events.map(e => JSON.stringify(e)).join('\n') + '\n';
    expect(() => validateProbeOutput('codex', text([...head, error, ...tail]), 0, rejectionHash)).not.toThrow();
    expect(() => validateProbeOutput('codex', text([...head, ...tail]), 0, rejectionHash)).toThrow('probe-missing-rejection');
    expect(() => validateProbeOutput('codex', text([...head, error, error, ...tail]), 0, rejectionHash)).toThrow('probe-unexpected-rejection');
    expect(() => validateProbeOutput('codex', text([...head, { ...error, item: { ...error.item, message: 'unrelated warning' } }, ...tail]), 0, rejectionHash)).toThrow('probe-unexpected-rejection');
    expect(() => validateProbeOutput('codex', text([...head, error, ...tail]), 1, rejectionHash)).toThrow();
  });

  test('Codex omitted tools means an empty advertised set, not an implicit tool', async () => {
    const fixture = await startCapabilityFixture('codex', model);
    try {
      expect((await send(fixture.url, 'codex', { model, stream: true, input: [] })).status).toBe(200);
      expect(fixture.snapshot().requests[0]).toMatchObject({ toolCount: 0, toolNames: [] });
    } finally { await fixture.close(); }
  });

  test('profiles retain restrictions; endpoint overrides cannot target external hosts', () => {
    const args = probeArgv('codex', model, 'http://127.0.0.1:12345', 'C:\\fixture\\schema.json');
    for (const feature of CODEX_DISABLED_FEATURES) expect(args).toContain(feature);
    expect(args).toContain('--output-schema'); expect(args).toContain('--ignore-user-config');
    expect(args).toContain('model_providers.fixture.requires_openai_auth=false');
    expect(args).toContain('model_providers.fixture.request_max_retries=0');
    expect(args.at(-1)).toBe('-');
    const claudeArgs = probeArgv('claude', model, 'http://127.0.0.1:12345', 'unused');
    expect(claudeArgs).toContain('--safe-mode'); expect(claudeArgs).not.toContain('--bare');
    expect(claudeArgs[claudeArgs.indexOf('--tools') + 1]).toBe('');
    for (const url of ['https://127.0.0.1:123', 'http://localhost:123', 'http://example.invalid:123', 'http://user@127.0.0.1:123', 'http://127.0.0.1:123/path']) {
      expect(() => probeArgv('codex', model, url, 'unused')).toThrow('fixture-endpoint');
    }
  });

  test('environment never inherits authentication, startup variables or real user homes', () => {
    for (const provider of ['claude', 'codex'] as const) {
      const env = probeEnvironment(provider, 'C:\\synthetic', 'http://127.0.0.1:123');
      expect(env.USERPROFILE).toBe('C:\\synthetic\\home');
      expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BUN_OPTIONS).toBeUndefined();
      expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:123');
      expect(env.ANTHROPIC_API_KEY).toBe(provider === 'claude' ? KEY : undefined);
    }
  });

  test('invalid configs reject before setup; failures do not mint evidence or expose input', async () => {
    expect(ProbeOptionsSchema.safeParse({}).success).toBe(false);
    await expect(probeCapability({} as never)).rejects.toThrow('probe-options');
    await expect(probeCapability({ provider: 'claude', executable: 'C:\\missing.exe', executableSha256: 'a'.repeat(64),
      version: '2.1.263', model, home: 'C:\\missing', timeoutMs: 30001 })).rejects.toThrow('probe-options');
  });

  test('one contained native Node child exercises the local server, with exact empty proof', async () => {
    const root = mkdtempSync(join(tmpdir(), 'acb-probe-test-'));
    const fixture = await startCapabilityFixture('claude', model);
    try {
      for (const folder of ['home', 'appdata', 'localappdata', 'tmp', 'config']) mkdirSync(join(root, folder));
      const code = `const r=await fetch(${JSON.stringify(fixture.url + '/v1/messages')},{method:'POST',headers:{'x-api-key':${JSON.stringify(KEY)},'content-type':'application/json'},body:${JSON.stringify(JSON.stringify(claude()))}});if(r.status!==200)process.exit(1);await r.text();console.log('fixture-complete');`;
      const result = await runContained({ executable: process.execPath, args: ['-e', code], cwd: root,
        env: probeEnvironment('claude', root, fixture.url), stdin: '', maxOutputBytes: 4096, timeoutMs: 10000 });
      expect(result.containmentEmpty).toBe(true); expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('fixture-complete'); expect(fixture.snapshot().fixtureFailure).toBe(false);
    } finally { await fixture.close(); rmSync(root, { recursive: true, force: true }); }
  }, 15000);
});
