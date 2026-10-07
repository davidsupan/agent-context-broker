import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { hashArtifact } from './artifacts.mts';
import { noLinks } from './store.mts';
import { canonical } from './slicing.mts';
import { CODEX_DISABLED_FEATURES, providerArgv, parseProviderOutput, providerErrorClass, providerOutputShape, validateCapabilityFixture,
  bindingEnvironment, argvProfileSha256, environmentPolicyFor, PinnedEnvironmentSchema, prepareProviderRequest } from './provider.mts';
import { SliceSchema, modelOutputSchema, validateOutput, withRunnerCoverage } from './output.mts';
import { INSTRUCTIONS } from './consumer.mts';
import { syntheticDistillationRequest, validateSyntheticDistillation } from './distillation-probe.mts';
import { runContained, type ContainedResult } from './windows-job.mts';
import { spawnSync } from 'node:child_process';
import { sha256Hex } from './platform.mts';

const MAX_BODY = 1024 * 1024;
const KEY = 'synthetic-loopback-fixture-not-a-credential';
const SCHEMA = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
type Provider = 'claude' | 'codex';
const NativePath = z.string().max(4096).regex(/^[a-z]:[\\/][^\0]*$/i);
export const ProbeOptionsSchema = z.strictObject({
  provider: z.enum(['claude', 'codex']), executable: NativePath.refine(p => /\.exe$/i.test(p)),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  version: z.string().regex(/^[0-9][A-Za-z0-9.+-]{0,79}$/),
  model: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/), home: NativePath,
  timeoutMs: z.number().int().min(1000).max(30000).default(30000),
});
export type ProbeOptions = z.input<typeof ProbeOptionsSchema>;
export type ProbeDiagnostics = {
  phase: 'version' | 'fixture'; exitCode: number; timedOut: boolean; outputLimitExceeded: boolean;
  containmentEmpty: boolean; stdoutBytes: number; stderrBytes: number; requests: number; fixtureErrors: string[];
  rejectedKnownArgument: string | null;
  outputItemKinds?: string[];
  rejectionShape?: { keys: string[]; vocabulary: string[]; matchesWire: boolean };
  envelopeKeys?: string[];
  permissionDenialCount?: number;
};
export class ProbeError extends Error {
  readonly diagnostics: ProbeDiagnostics;
  constructor(code: string, diagnostics: ProbeDiagnostics) { super(code); this.name = 'ProbeError'; this.diagnostics = diagnostics; }
}

/** Reuse the production envelope/usage gate; formatting differences are not evidence differences. */
export function validateProbeOutput(provider: Provider, stdout: string, exitCode: number, expectedRejectionSha256?: string) {
  if (provider === 'codex' && expectedRejectionSha256 !== undefined) {
    check(/^[a-f0-9]{64}$/.test(expectedRejectionSha256), 'probe-rejection-binding');
    check(Buffer.byteLength(stdout) <= 65536, 'probe-output-limit');
    const lines = stdout.trim().split('\n'); check(lines.length <= 256, 'probe-output-limit');
    let rejections = 0;
    stdout = lines.filter(line => {
      const event = json(Buffer.from(line));
      if (!record(event) || !record(event.item) || event.item.type !== 'error') return true;
      const item = event.item;
      check(event.type === 'item.completed' && Object.keys(event).every(k => ['type', 'item'].includes(k)) &&
        Object.keys(item).every(k => ['id', 'type', 'message'].includes(k)) && typeof item.id === 'string' && item.id.length <= 200 &&
        typeof item.message === 'string' && Buffer.byteLength(item.message) <= 65536 && hash(item.message) === expectedRejectionSha256 &&
        !item.message.includes('SYNTHETIC_EXEC_PROBE') &&
        ++rejections === 1, 'probe-unexpected-rejection');
      return false;
    }).join('\n');
    check(rejections === 1, 'probe-missing-rejection');
  }
  const parsed = parseProviderOutput(provider, stdout, exitCode);
  check(canonical(parsed.output) === canonical({ ok: true }), 'probe-output-unverified');
}
function check(value: unknown, code: string): asserts value { if (!value) throw new Error(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function hash(text: string) { return sha256Hex(text); }

// Fail before JSON.parse on excessive depth or duplicate keys (including escaped keys).
function json(raw: Buffer): unknown {
  check(raw.length > 0 && raw.length <= MAX_BODY, 'fixture-body-limit');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const scopes: Array<Set<string> | null> = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      const value: unknown = JSON.parse(text.slice(start, i + 1));
      check(typeof value === 'string' && value.isWellFormed(), 'fixture-json');
      let n = i + 1;
      while (n < text.length && /\s/.test(text[n]!)) n++;
      if (text[n] === ':') { const keys = scopes.at(-1); check(keys && !keys.has(value), 'fixture-json'); keys.add(value); }
    } else if (c === '{' || c === '[') {
      check(scopes.length < 64, 'fixture-depth'); scopes.push(c === '{' ? new Set() : null);
    } else if (c === '}' || c === ']') {
      check(scopes.length > 0 && (c === '}') === (scopes.at(-1) !== null), 'fixture-json'); scopes.pop();
    }
  }
  check(scopes.length === 0, 'fixture-json');
  return JSON.parse(text);
}
function sse(events: unknown[]): string {
  return events.map(event => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}
function claudeResponse(model: string, distillation = false): string {
  const slice = distillation ? syntheticDistillationRequest('claude').slice : undefined;
  const coverage = slice?.segments.map(({ block, startChar, endChar }) => ({ block, startChar, endChar }));
  const output = slice ? { schemaVersion: 1, sliceId: slice.sliceId,
    observations: [{ kind: 'correction', summary: 'Beacon retention changed from 7 to 14 days.', sourceRefs: [coverage![2]] }] } : { ok: true };
  return sse([
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], model,
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'synthetic_output', name: 'StructuredOutput', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(output) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}
function codexResponse(first: boolean): string {
  const item = first ? { type: 'function_call', id: 'fixture_item', call_id: 'fixture_call', name: 'exec_command',
    arguments: JSON.stringify({ cmd: 'echo SYNTHETIC_EXEC_PROBE' }) } :
    { type: 'message', id: 'fixture_message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] };
  const response = { id: first ? 'resp_fixture_1' : 'resp_fixture_2', object: 'response', status: 'completed', output: [item],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
  return sse([{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response }]);
}

/** Local mock only. Does not forward, log prompts/headers, or produce a receipt. */
export async function startCapabilityFixture(provider: Provider, model: string, purpose: 'boolean-smoke' | 'distillation' = 'boolean-smoke') {
  check(['claude', 'codex'].includes(provider) && /^[A-Za-z0-9._-]{1,80}$/.test(model), 'fixture-options');
  check(purpose === 'boolean-smoke' || (purpose === 'distillation' && provider === 'claude'), 'fixture-purpose');
  const requests: Record<string, unknown>[] = [], toolResults: Record<string, unknown>[] = [];
  const errors = new Set<string>(), sockets = new Set<Socket>();
  let count = 0, connections = 0, closed = false;
  const fail = (code: string) => { if (errors.size < 8) errors.add(code); };
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 3000, headersTimeout: 3000 }, async (req, res) => {
    const timer = setTimeout(() => { fail('request-deadline'); req.destroy(); }, 3000);
    try {
      check(++count <= 8 && !closed && req.socket.remoteAddress === '127.0.0.1', 'request-limit');
      const path = req.url?.split('?')[0];
      check(req.headers.host === `127.0.0.1:${port}`, 'request-host');
      if (provider === 'claude' && req.method === 'HEAD' && path === '/api/hello') { res.writeHead(200); res.end(); return; }
      check(req.method === 'POST' && path === (provider === 'claude' ? '/v1/messages' : '/v1/responses'), 'request-route');
      check(!req.headers['transfer-encoding'] && /^\d{1,8}$/.test(req.headers['content-length'] ?? ''), 'request-length');
      const length = Number(req.headers['content-length']);
      check(length > 0 && length <= MAX_BODY, 'request-size');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) { bytes += chunk.length; check(bytes <= length && bytes <= MAX_BODY, 'request-size'); chunks.push(Buffer.from(chunk)); }
      check(bytes === length, 'request-size');
      const payload = json(Buffer.concat(chunks));
      check(record(payload), 'request-contract');
      check(payload.model === model, 'request-model');
      check(payload.stream === true, 'request-stream');
      // The Responses API omits the tools member when no tools are advertised.
      const declaredTools = payload.tools === undefined ? [] : payload.tools;
      check(Array.isArray(declaredTools), 'request-tools-shape');
      check(!req.headers.authorization && !req.headers.cookie, 'request-auth');
      let body: string;
      if (provider === 'claude') {
        const tools = declaredTools;
        const valid = req.headers['x-api-key'] === KEY && Array.isArray(payload.messages);
        const outputOnly = tools.length === 1 && record(tools[0]) && tools[0].name === 'StructuredOutput';
        requests.push({ requestBytes: bytes, toolCount: tools.length, outputToolOnly: outputOnly, syntheticContractMatches: valid });
        check(valid && outputOnly, 'request-tools');
        body = claudeResponse(model, purpose === 'distillation');
      } else {
        check(!req.headers['x-api-key'] && Array.isArray(payload.input), 'request-auth-or-input');
        const names = declaredTools.map(tool => record(tool) ? tool.name ?? tool.type : null);
        // Never retain provider-supplied tool names; only the empty accepted list.
        check(names.length === 0, 'request-tools');
        requests.push({ model, toolNames: [], toolCount: 0, authorizationHeaderPresent: false });
        check(requests.length <= 2, 'request-count');
        const outputs = payload.input.filter(entry => record(entry) && entry.type === 'function_call_output');
        if (requests.length === 1) check(outputs.length === 0, 'tool-order');
        else {
          check(outputs.length === 1, 'tool-result-count');
          const entry = outputs[0] as Record<string, unknown>;
          check(typeof entry.output === 'string' && Buffer.byteLength(entry.output) <= 65536, 'tool-result-size');
          const lower = entry.output.toLowerCase();
          const unsupported = ['unknown tool', 'unsupported tool', 'unrecognized function', 'unknown function', 'unsupported call'].some(p => lower.includes(p));
          const result = { callIdMatches: entry.call_id === 'fixture_call', unsupportedTool: unsupported,
            outputSha256: hash(entry.output),
            executionMarkerPresent: entry.output.includes('SYNTHETIC_EXEC_PROBE'), outputBytes: Buffer.byteLength(entry.output) };
          toolResults.push(result);
          check(result.callIdMatches && result.unsupportedTool && !result.executionMarkerPresent, 'tool-executed-or-unverified');
        }
        body = codexResponse(requests.length === 1);
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Content-Length': Buffer.byteLength(body), Connection: 'close' });
      res.end(body);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const known = ['request-limit', 'request-host', 'request-route', 'request-length', 'request-size', 'request-contract',
        'request-auth', 'request-tools', 'request-model', 'request-stream', 'request-tools-shape', 'request-auth-or-input', 'request-count', 'tool-order', 'tool-result-count',
        'tool-result-size', 'tool-executed-or-unverified', 'fixture-body-limit', 'fixture-json', 'fixture-depth'];
      fail(known.includes(code) ? code : 'request-invalid-json');
      if (!res.headersSent) res.writeHead(400, { Connection: 'close', 'Content-Length': 0 }); res.end();
    }
    finally { clearTimeout(timer); }
  });
  server.on('connection', socket => {
    sockets.add(socket);
    const deadline = setTimeout(() => { fail('connection-deadline'); socket.destroy(); }, 3500);
    socket.on('close', () => { clearTimeout(deadline); sockets.delete(socket); });
    socket.on('error', () => fail('connection-error'));
    if (++connections > 8 || socket.remoteAddress !== '127.0.0.1') { fail('connection-limit'); socket.destroy(); }
  });
  server.on('clientError', (_error, socket) => { fail('http-invalid'); socket.destroy(); });
  server.on('connect', (_req, socket) => { fail('proxy-forbidden'); socket.destroy(); });
  server.on('upgrade', (_req, socket) => { fail('upgrade-forbidden'); socket.destroy(); });
  server.on('error', () => fail('server-error'));
  await new Promise<void>((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', () => { server.off('error', no); yes(); }); });
  const address = server.address(); check(address && typeof address !== 'string', 'fixture-listen');
  const port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    snapshot: () => structuredClone({ requests, toolResults, fixtureFailure: errors.size > 0, fixtureErrors: [...errors] }),
    close: async () => { if (closed) return; closed = true; for (const socket of sockets) socket.destroy();
      await new Promise<void>(yes => server.close(() => yes())); },
  };
}

function loopback(url: string): string {
  const parsed = new URL(url);
  check(parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port &&
    !parsed.username && !parsed.password && parsed.pathname === '/' && !parsed.search && !parsed.hash, 'fixture-endpoint');
  return parsed.origin;
}
/** Only synthetic overrides differ from the production argv restrictions. */
export function probeArgv(provider: Provider, model: string, url: string, schemaPath: string): string[] {
  url = loopback(url);
  const argv = providerArgv(provider, model, provider === 'claude' ? JSON.stringify(SCHEMA) : schemaPath);
  if (provider === 'claude') return argv;
  argv.pop();
  return [...argv, ...[
    'model_provider="fixture"', 'model_providers.fixture.name="Local capability fixture"',
    `model_providers.fixture.base_url=${JSON.stringify(url + '/v1')}`, 'model_providers.fixture.wire_api="responses"',
    'model_providers.fixture.requires_openai_auth=false', 'model_providers.fixture.request_max_retries=0',
    'model_providers.fixture.stream_max_retries=0', 'analytics.enabled=false', 'feedback.enabled=false',
    'check_for_update_on_startup=false',
  ].flatMap(value => ['-c', value]), '-'];
}

/** Exact environment; caller creates these fresh directories before use. */
export function probeEnvironment(provider: Provider, session: string, url: string): Record<string, string> {
  url = loopback(url);
  check(NativePath.safeParse(session).success && ['claude', 'codex'].includes(provider), 'fixture-environment');
  const env: Record<string, string> = { SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
    PATH: 'C:\\Windows\\System32;C:\\Windows', HOME: join(session, 'home'), USERPROFILE: join(session, 'home'),
    APPDATA: join(session, 'appdata'), LOCALAPPDATA: join(session, 'localappdata'),
    TEMP: join(session, 'tmp'), TMP: join(session, 'tmp'),
    PROGRAMDATA: 'C:\\ProgramData', PROGRAMFILES: 'C:\\Program Files',
    HTTP_PROXY: url, HTTPS_PROXY: url, ALL_PROXY: url, NO_PROXY: '127.0.0.1',
    DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1' };
  if (provider === 'claude') Object.assign(env, { CLAUDE_CONFIG_DIR: join(session, 'config'), ANTHROPIC_BASE_URL: url,
    ANTHROPIC_API_KEY: KEY, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1' });
  else env.CODEX_HOME = join(session, 'config');
  return env;
}

function absent(path: string) {
  noLinks(path);
  try { lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('policy-location-unreadable'); }
  throw new Error('managed-policy-present');
}
/** Snapshot checks, not a sandbox or an authorization bypass. Access denied blocks. */
export async function assertProbePolicyAbsent(provider: Provider) {
  check(['claude', 'codex'].includes(provider), 'probe-provider');
  if (process.platform !== 'win32') return assertPosixPolicyAbsent(provider);
  check(process.arch === 'x64', 'probe-windows-x64-required');
  for (const [name, expected] of [['SystemRoot', 'C:\\Windows'], ['ProgramFiles', 'C:\\Program Files'], ['ProgramData', 'C:\\ProgramData']] as const) {
    check(process.env[name]?.replace(/[\\/]$/, '').toLowerCase() === expected.toLowerCase(), 'policy-root-unverified');
    noLinks(expected);
  }
  if (provider === 'codex') {
    for (const name of ['config.toml', 'requirements.toml', 'managed_config.toml']) absent(join('C:\\ProgramData\\OpenAI\\Codex', name));
    return;
  }
  for (const root of ['C:\\Program Files\\ClaudeCode', 'C:\\ProgramData\\ClaudeCode']) {
    for (const name of ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json']) absent(join(root, name));
  }
  // The policy key in both hives and both registry views, read with reg.exe: exit 0 means present, 1 absent.
  for (const hive of ['HKCU', 'HKLM']) for (const view of ['/reg:64', '/reg:32']) {
    const result = spawnSync('reg.exe', ['query', `${hive}\\SOFTWARE\\Policies\\ClaudeCode`, view], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    if (result.status === 0) throw new Error('managed-policy-present');
    check(result.status === 1, 'policy-registry-unverified');
  }
}

/** macOS and Linux: the system-wide managed settings locations must be absent. */
function assertPosixPolicyAbsent(provider: Provider) {
  check(process.platform === 'darwin' || process.platform === 'linux', 'probe-platform-unsupported');
  if (provider === 'codex') {
    for (const name of ['config.toml', 'requirements.toml', 'managed_config.toml']) absent(join('/etc/codex', name));
    return;
  }
  const roots = process.platform === 'darwin' ? ['/Library/Application Support/ClaudeCode'] : ['/etc/claude-code'];
  for (const root of roots) for (const name of ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json']) absent(join(root, name));
  // A configuration profile (MDM) can also carry the policy on macOS.
  if (process.platform === 'darwin') absent('/Library/Managed Preferences/com.anthropic.claudecode.plist');
}

let busy = false;
/** Runs at most one native process at a time. No executor injection can mint receipts.
 * Returned receiptText is ready for exclusive storage by the caller; no live approval
 * is generated. Session contains synthetic CLI state only and is left for inspection.
 * Endpoint/proxy routing is not OS egress isolation; networkIsolationVerified is false.
 */
export async function probeCapability(options: ProbeOptions) {
  check(!busy, 'probe-busy'); busy = true;
  let fixture: Awaited<ReturnType<typeof startCapabilityFixture>> | undefined;
  try {
    const parsed = ProbeOptionsSchema.safeParse(options); check(parsed.success, 'probe-options');
    const o = parsed.data;
    await assertProbePolicyAbsent(o.provider);
    const verifyBinary = async () => check((await hashArtifact(o.executable, 512 * 1024 * 1024)).sha256 === o.executableSha256, 'probe-executable-changed');
    await verifyBinary(); noLinks(o.home); check(lstatSync(o.home).isDirectory(), 'probe-home');
    const session = mkdtempSync(join(resolve(o.home), 'capability-'));
    for (const child of ['home', 'appdata', 'localappdata', 'tmp', 'config', 'cwd']) mkdirSync(join(session, child));
    const schemaPath = join(session, 'output.schema.json'); writeFileSync(schemaPath, JSON.stringify(SCHEMA), { flag: 'wx' });
    fixture = await startCapabilityFixture(o.provider, o.model);
    const env = probeEnvironment(o.provider, session, fixture.url);
    const run = async (args: string[], stdin: string, timeoutMs: number) => {
      await assertProbePolicyAbsent(o.provider); await verifyBinary();
      const result = await runContained({ executable: o.executable, args, cwd: join(session, 'cwd'), env, stdin,
        timeoutMs, maxOutputBytes: 65536, jobName: `Local\\ACBCapability-${crypto.randomUUID()}` });
      await assertProbePolicyAbsent(o.provider); await verifyBinary();
      if (!result.containmentEmpty || result.timedOut || result.outputLimitExceeded || result.exitCode !== 0 ||
        result.stdoutBytes + result.stderrBytes > 65536) {
        const observed = fixture!.snapshot();
        const rejected = /unexpected argument '([^']+)'/.exec(result.stderr)?.[1];
        throw new ProbeError('probe-process-failed', {
          phase: args[0] === '--version' ? 'version' : 'fixture', exitCode: result.exitCode, timedOut: result.timedOut,
          outputLimitExceeded: result.outputLimitExceeded, containmentEmpty: result.containmentEmpty,
          stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes, requests: observed.requests.length,
          fixtureErrors: observed.fixtureErrors, rejectedKnownArgument: rejected && args.includes(rejected) ? rejected : null,
        });
      }
      return result;
    };
    const version = await run(['--version'], '', Math.min(o.timeoutMs, 5000));
    const expected = o.provider === 'codex' ? `codex-cli ${o.version}` : `${o.version} (Claude Code)`;
    check(version.stdout.trim() === expected && fixture.snapshot().requests.length === 0, 'probe-version-mismatch');
    const result = await run(probeArgv(o.provider, o.model, fixture.url, schemaPath), 'Synthetic fixture. Return {"ok":true}.\n', o.timeoutMs);
    await fixture.close();
    const observed = fixture.snapshot(); check(!observed.fixtureFailure, 'probe-fixture-failed');
    const rejected = observed.toolResults.length === 1 && observed.toolResults[0]?.callIdMatches === true &&
      observed.toolResults[0]?.unsupportedTool === true && observed.toolResults[0]?.executionMarkerPresent === false;
    try { validateProbeOutput(o.provider, result.stdout, result.exitCode,
      o.provider === 'codex' && rejected ? observed.toolResults[0]!.outputSha256 as string : undefined); }
    catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Only fixed parser error identifiers, never CLI text, can leave the process.
      const known = ['provider-failed', 'provider-json', 'provider-usage', 'provider-unexpected-usage', 'claude-failed',
        'claude-unexpected-activity', 'claude-tool-usage', 'codex-event-order', 'codex-unexpected-tool', 'codex-unexpected-item',
        'codex-item-order', 'codex-multiple-final', 'codex-incomplete', 'codex-error-or-unexpected-event',
        'codex-unexpected-event-fields', 'probe-output-unverified'];
      const kinds = new Set<string>();
      let envelopeKeys: string[] | undefined, permissionDenialCount: number | undefined;
      if (o.provider === 'claude') {
        try {
          const envelope = json(Buffer.from(result.stdout));
          if (record(envelope)) {
            envelopeKeys = Object.keys(envelope).slice(0, 32).map(k => /^[A-Za-z_]{1,80}$/.test(k) ? k : 'other');
            permissionDenialCount = Array.isArray(envelope.permission_denials) ? envelope.permission_denials.length : -1;
          }
        } catch { /* No raw output or parse messages leave the probe. */ }
      }
      let rejectionShape: { keys: string[]; vocabulary: string[]; matchesWire: boolean } | undefined;
      if (o.provider === 'codex') for (const line of result.stdout.trim().split('\n').slice(0, 256)) {
        try {
          const event = json(Buffer.from(line));
          if (record(event) && record(event.item)) kinds.add(
            ['error', 'command_execution', 'mcp_tool_call', 'web_search', 'file_change', 'todo_list', 'agent_message', 'reasoning'].includes(String(event.item.type))
              ? String(event.item.type) : 'unknown');
          if (record(event) && record(event.item) && event.item.type === 'error') {
            const message = typeof event.item.message === 'string' ? event.item.message : '';
            const words = new Set(['unsupported', 'unknown', 'unrecognized', 'tool', 'call', 'function', 'exec_command', 'error']);
            rejectionShape = { keys: Object.keys(event.item).slice(0, 8).map(k => ['id', 'type', 'message', 'text'].includes(k) ? k : 'other'),
              vocabulary: message.split(/[^a-z_]+/i).filter(Boolean).slice(0, 16).map(w => words.has(w.toLowerCase()) ? w.toLowerCase() : 'other'),
              matchesWire: hash(message) === observed.toolResults[0]?.outputSha256 };
          }
        } catch { kinds.add('unparseable'); }
      }
      throw new ProbeError(known.includes(code) ? 'probe-output-' + code : 'probe-output-unverified', {
        phase: 'fixture', exitCode: result.exitCode, timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded,
        containmentEmpty: result.containmentEmpty, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
        requests: observed.requests.length, fixtureErrors: observed.fixtureErrors, rejectedKnownArgument: null, outputItemKinds: [...kinds],
        ...(rejectionShape ? { rejectionShape } : {}),
        ...(envelopeKeys ? { envelopeKeys, permissionDenialCount: permissionDenialCount! } : {}),
      });
    }
    const boundary = 'Synthetic loopback evidence only; no live approval, no OS egress or filesystem sandbox.';
    const receipt = o.provider === 'claude' ? {
      schemaVersion: 1, provider: 'claude-loopback-fixture', capabilityState: 'output-only-in-fixture', exitCode: result.exitCode,
      requests: observed.requests, fixtureFailure: false, fixtureErrors: [], structuredOutputRequested: true,
      executableSha256: o.executableSha256, launchProfile: 'safe-mode', authProfile: 'isolated-synthetic-api-key',
      liveProfileVerified: false, networkIsolationVerified: false, managedPolicyAbsentAtChecks: true, upstreamForwarding: false, boundary,
    } : {
      schemaVersion: 2, provider: 'loopback-fixture', realModelCalled: false, executionMode: 'direct-native',
      executedSha256: o.executableSha256, exitCode: result.exitCode, requests: observed.requests,
      disabledFeatures: [...CODEX_DISABLED_FEATURES], capabilityState: 'tool-free-in-fixture',
      toolResults: observed.toolResults, exercisedTool: 'exec_command', model: o.model,
      toolchain: { version: expected, nativeSha256: o.executableSha256 }, liveProfileVerified: false,
      networkIsolationVerified: false, boundary,
    };
    validateCapabilityFixture(receipt, { provider: o.provider, model: o.model, version: o.version, executableSha256: o.executableSha256 });
    const receiptText = canonical(receipt) + '\n';
    return { state: 'fixture-verified' as const, receipt, receiptText, receiptSha256: hash(receiptText), session };
  } catch (error) {
    if (error instanceof ProbeError) throw error;
    const message = error instanceof Error ? error.message : '';
    const code = /^(probe|policy|managed)-[a-z-]+$/.test(message) ? message : 'probe-failed';
    throw new Error(code);
  } finally { try { await fixture?.close(); } finally { busy = false; } }
}

export const LiveProbeOptionsSchema = ProbeOptionsSchema.omit({ timeoutMs: true }).extend({
  authHome: NativePath,
  capabilityReceipt: z.strictObject({ path: NativePath, sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  purpose: z.enum(['boolean-smoke', 'distillation', 'approved-slice']).default('boolean-smoke'),
  environment: PinnedEnvironmentSchema.optional(),
  // Only for purpose approved-slice: one real slice the operator approved for one call.
  slice: SliceSchema.optional(),
  approval: z.union([z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
    scope: z.literal('two-synthetic-subscription-calls'),
    providers: z.tuple([z.literal('claude'), z.literal('codex')]),
    maxCalls: z.literal(2), timeoutPerProviderMs: z.literal(60000), globalBudgetSeconds: z.literal(1800),
  }), z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
    scope: z.literal('one-synthetic-distillation-call'),
    providers: z.tuple([z.literal('claude')]),
    maxCalls: z.literal(1), timeoutPerProviderMs: z.literal(60000), globalBudgetSeconds: z.literal(1800),
  }), z.strictObject({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/),
    scope: z.literal('one-approved-slice-call'),
    providers: z.tuple([z.literal('claude')]),
    maxCalls: z.literal(1), timeoutPerProviderMs: z.literal(60000), globalBudgetSeconds: z.literal(1800),
  })]),
}).superRefine((value, ctx) => {
  if ((value.approval.scope === 'one-approved-slice-call') !== (value.purpose === 'approved-slice') ||
      (value.purpose === 'approved-slice') !== (value.slice !== undefined) ||
      (value.purpose === 'approved-slice' && value.provider !== 'claude')) {
    ctx.addIssue({ code: 'custom', message: 'approved-slice-approval-required' });
  }
  if (value.approval.scope === 'one-synthetic-distillation-call' &&
      (value.provider !== 'claude' || value.purpose !== 'distillation')) {
    ctx.addIssue({ code: 'custom', message: 'approval-purpose-mismatch' });
  }
  if (value.purpose === 'distillation' && value.approval.scope !== 'one-synthetic-distillation-call') {
    ctx.addIssue({ code: 'custom', message: 'distillation-approval-required' });
  }
});
export type LiveProbeOptions = z.input<typeof LiveProbeOptionsSchema>;
export interface LiveProbeCoordinator {
  /** Parent MUST durably enforce approval call count, one active worker and the
   * existing shared 1800-second ledger before returning. No local substitute.
   * Unsettled reservations must remain held on crash/error, never expire by age.
   */
  reserve(request: { approvalId: string; provider: Provider; seconds: 60; globalBudgetSeconds: 1800 }): Promise<{
    reservationId: string;
    jobName: string;
    settle(proof: { completionProof: 'process-tree-empty-v1'; durationMs: number; exitCode: number }): Promise<void>;
  }>;
}

async function readPinnedCapability(ref: { path: string; sha256: string }): Promise<unknown> {
  const before = await hashArtifact(ref.path, 65536);
  check(before.sha256 === ref.sha256, 'probe-capability-changed');
  noLinks(ref.path);
  const fd = openSync(ref.path, 'r');
  let bytes = 0; const raw = Buffer.alloc(65537);
  try {
    while (bytes < raw.length) { const count = readSync(fd, raw, bytes, raw.length - bytes, bytes); if (!count) break; bytes += count; }
  } finally { closeSync(fd); }
  check(bytes > 0 && bytes <= 65536 && sha256Hex(raw.subarray(0, bytes)) === ref.sha256,
    'probe-capability-changed');
  check((await hashArtifact(ref.path, 65536)).sha256 === ref.sha256, 'probe-capability-changed');
  return json(raw.subarray(0, bytes));
}

async function livePreflight(options: LiveProbeOptions) {
  const parsed = LiveProbeOptionsSchema.safeParse(options); check(parsed.success, 'probe-live-options');
  const o = parsed.data;
  await assertProbePolicyAbsent(o.provider);
  for (const path of [o.home, o.authHome]) { noLinks(path); check(lstatSync(path).isDirectory(), 'probe-live-home'); }
  const receipt = await readPinnedCapability(o.capabilityReceipt);
  validateCapabilityFixture(receipt, o);
  check((await hashArtifact(o.executable, 512 * 1024 * 1024)).sha256 === o.executableSha256, 'probe-executable-changed');
  const env = bindingEnvironment(o.provider, o.authHome, o.home, o.environment);
  return { o, env, environmentSha256: hash(canonical(env)),
    argvProfileSha256: argvProfileSha256(o.provider, o.model, environmentPolicyFor(o.environment)) };
}

/** Read-only inspection of exact argv/profile and fixed stdin; never reserves or launches.
 * For Codex, the sole placeholder is replaced by the fresh synthetic schema path.
 */
export async function describeLiveProbe(options: LiveProbeOptions) {
  const p = await livePreflight(options);
  const payload = livePayload(p.o);
  return { executable: p.o.executable, args: providerArgv(p.o.provider, p.o.model,
    p.o.provider === 'claude' ? JSON.stringify(payload.schema) : '<FRESH_SESSION>/output.schema.json'),
    stdin: payload.stdin,
    schema: payload.schema, timeoutMs: 50000, cleanupBudgetMs: 5000, reservationSeconds: 60,
    maxOutputBytes: 65536, environmentSha256: p.environmentSha256, argvProfileSha256: p.argvProfileSha256 };
}

function livePayload(options: LiveProbeOptions) {
  if (options.purpose === 'approved-slice') {
    const token = '0'.repeat(32);
    const request = prepareProviderRequest({ provider: options.provider, reason: 'approved-slice', token,
      jobName: `Local\\ACBCorpus-${token}`, slice: options.slice!, outputSchema: modelOutputSchema(options.slice!),
      timeoutMs: 50000, instructions: INSTRUCTIONS });
    return { stdin: request.input, schema: request.outputSchema };
  }
  if (options.purpose === 'distillation') {
    const request = syntheticDistillationRequest(options.provider);
    return { stdin: request.input, schema: request.outputSchema };
  }
  return { stdin: canonical({ instructions: INSTRUCTIONS, syntheticProbe: 'Return exactly {"ok":true}. No tools. No private corpus.' }),
    schema: structuredClone(SCHEMA) };
}

/** Separate, explicit user-approved observation pathway, never used by the daily
 * provider runner. No injected executor, arbitrary payload, automatic reservation
 * or approval-receipt writer. Parent supplies the real shared-budget coordinator.
 * The returned receipt is an observation awaiting review, NOT LiveProfileReceipt.
 */
export async function runLiveProbe(options: LiveProbeOptions, coordinator: LiveProbeCoordinator) {
  check(!busy, 'probe-busy'); busy = true;
  try {
    check(coordinator && typeof coordinator.reserve === 'function', 'probe-budget-coordinator-required');
    const before = await livePreflight(options);
    const { o } = before;
    const payload = livePayload(o);
    const session = mkdtempSync(join(resolve(o.home), 'subscription-probe-'));
    const schemaPath = join(session, 'output.schema.json');
    writeFileSync(schemaPath, JSON.stringify(payload.schema), { flag: 'wx' });
    const permit = await coordinator.reserve({ approvalId: o.approval.id, provider: o.provider, seconds: 60, globalBudgetSeconds: 1800 });
    check(permit && /^[A-Za-z0-9_.:-]{1,120}$/.test(permit.reservationId) &&
      /^Local\\[A-Za-z0-9_.-]{1,180}$/.test(permit.jobName) && typeof permit.settle === 'function', 'probe-budget-permit');
    // Revalidate after the reservation await, before handing any bytes to a child.
    // Failed pre-dispatch revalidation leaves the reservation held for the parent.
    const dispatch = await livePreflight(o);
    check(dispatch.environmentSha256 === before.environmentSha256 && dispatch.argvProfileSha256 === before.argvProfileSha256,
      'probe-profile-changed');
    const startedAt = new Date().toISOString();
    const result = await runContained({ executable: o.executable,
      args: providerArgv(o.provider, o.model, o.provider === 'claude' ? JSON.stringify(payload.schema) : schemaPath),
      cwd: session, env: dispatch.env,
      stdin: payload.stdin,
      timeoutMs: 50000, maxOutputBytes: 65536, jobName: permit.jobName });
    check(result.containmentEmpty === true, 'probe-live-containment-unverified');
    // Settlement reports process proof even when parsing/hash checks reject output.
    await permit.settle({ completionProof: 'process-tree-empty-v1', durationMs: result.durationMs, exitCode: result.exitCode });
    const after = await livePreflight(o);
    check(after.environmentSha256 === before.environmentSha256 && after.argvProfileSha256 === before.argvProfileSha256,
      'probe-profile-changed');
    writeFileSync(join(session, 'process-result.json'), canonical({ exitCode: result.exitCode,
      durationMs: result.durationMs, timedOut: result.timedOut, outputLimitExceeded: result.outputLimitExceeded,
      containmentEmpty: result.containmentEmpty, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes }), { flag: 'wx' });
    // Content-free failure class, so a rejected probe explains itself without its text.
    if (o.provider === 'claude' && result.exitCode !== 0) {
      writeFileSync(join(session, 'error-class.json'), canonical(providerErrorClass(result.stdout, result.stderr)), { flag: 'wx' });
    }
    check(!result.timedOut && !result.outputLimitExceeded && result.exitCode === 0 && result.durationMs <= 60000,
      'probe-live-process-failed');
    if (o.provider === 'claude') writeFileSync(join(session, 'output-shape.json'), canonical(providerOutputShape(result.stdout)), { flag: 'wx' });
    if (o.purpose === 'boolean-smoke') validateProbeOutput(o.provider, result.stdout, result.exitCode);
    const output = parseProviderOutput(o.provider, result.stdout, result.exitCode);
    const distillation = o.purpose === 'distillation' ? validateSyntheticDistillation(output.output, o.provider)
      : o.purpose === 'approved-slice' ? validateOutput(withRunnerCoverage(output.output, o.slice!), o.slice!) : undefined;
    // The approved-slice result is private and unreviewed: it stays in the probe session under the runtime home.
    if (distillation) writeFileSync(join(session, o.purpose === 'approved-slice' ? 'approved-slice-output.private.json'
      : 'synthetic-distillation.json'), canonical(distillation) + '\n', { flag: 'wx', mode: 0o600 });
    const receipt = {
      schemaVersion: 1, kind: o.purpose === 'approved-slice' ? 'subscription-approved-slice-observation' : 'subscription-synthetic-observation',
      provider: o.provider, model: o.model, version: o.version,
      ...(o.purpose === 'approved-slice' ? { sliceId: o.slice!.sliceId } : {}),
      approvalId: o.approval.id, reservationId: permit.reservationId, startedAt, finishedAt: new Date().toISOString(),
      executableSha256: o.executableSha256, capabilityReceiptSha256: o.capabilityReceipt.sha256,
      argvProfileSha256: before.argvProfileSha256, environmentSha256: before.environmentSha256,
      authHome: o.authHome, runtimeHome: o.home, subscriptionAuthRequested: true, subscriptionAuthVerified: false,
      humanReviewPerformed: false, liveProfileVerified: false, networkIsolationVerified: false,
      purpose: o.purpose, inputSha256: hash(payload.stdin), distillationValidated: Boolean(distillation),
      completionProof: 'process-tree-empty-v1', containmentEmpty: true, exitCode: result.exitCode,
      durationMs: result.durationMs, stdoutBytes: result.stdoutBytes, stderrBytes: result.stderrBytes,
      outputSha256: hash(canonical(output.output)), usage: output.usage,
    };
    const receiptText = canonical(receipt) + '\n';
    return { receipt, receiptText, receiptSha256: hash(receiptText), session };
  } finally { busy = false; }
}
