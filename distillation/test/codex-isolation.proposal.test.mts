import { test, expect } from './expect.mts';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { CODEX_PROPOSAL_PIN, CODE_MODE_NOTICE, classifyProposalEvidence } from '../src/codex-isolation.proposal.mts';
import { assertProbePolicyAbsent, probeArgv, probeEnvironment, startCapabilityFixture, validateProbeOutput } from '../src/capability-probe.mts';
import { runContained } from '../src/windows-job.mts';
import { hashArtifact } from '../src/artifacts.mts';

test('classification never treats a Code Mode startup notice as execution rejection or approval', () => {
  const text = JSON.stringify({ type: 'item.completed', item: { id: 'notice', type: 'error', message: CODE_MODE_NOTICE } });
  const inspected = classifyProposalEvidence(text, { requests: [{ toolCount: 0 }, { toolCount: 0 }], toolResults: [] });
  expect(inspected.startupNoticeCount).toBe(1); expect(inspected.executionChallengeRejected).toBe(false);
  expect(inspected.productionAuthorized).toBe(false); expect(inspected.liveAuthVerified).toBe(false);
  expect(() => validateProbeOutput('codex', text, 0, 'a'.repeat(64))).toThrow();
  expect(() => classifyProposalEvidence('x'.repeat(65537), { requests: [], toolResults: [] })).toThrow('proposal-output-limit');
});

const native = process.env.ACB_RUN_ISOLATION_PROPOSAL === '1' && process.platform === 'win32' ? test : test.skip;
native('dedicated synthetic auth home suppresses poison docs while offline auth loading remains available', { timeout: 90000 }, async () => {
  await assertProbePolicyAbsent('codex');
  expect((await hashArtifact(CODEX_PROPOSAL_PIN.executable, 512 * 1024 * 1024)).sha256).toBe(CODEX_PROPOSAL_PIN.sha256);
  const observations: unknown[] = [];
  for (const mode of ['positive', 'restricted-shared-home', 'dedicated'] as const) {
    const dedicated = mode === 'dedicated';
    const root = mkdtempSync(join(tmpdir(), 'acb-codex-proposal-'));
    for (const child of ['home', 'config', 'dedicated-auth', 'appdata', 'localappdata', 'tmp', '.git', 'cwd']) mkdirSync(join(root, child));
    const markers = { auth: 'SYNTHETIC_GLOBAL_AGENTS_641793', ancestor: 'SYNTHETIC_ANCESTOR_AGENTS_298573',
      skill: 'SYNTHETIC_SKILL_CONTEXT_692857' };
    writeFileSync(join(root, 'config', 'AGENTS.md'), 'Inert synthetic context marker: ' + markers.auth);
    writeFileSync(join(root, 'AGENTS.md'), 'Inert synthetic context marker: ' + markers.ancestor);
    const skill = join(root, '.agents', 'skills', 'fixture'); mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: fixture\ndescription: ${markers.skill}\n---\nInert synthetic fixture.\n`);
    // This unsigned token is synthetic, never sent to an external endpoint.
    const jwt = [Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url'),
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
        'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account', chatgpt_plan_type: 'plus' } })).toString('base64url'), 'synthetic'].join('.');
    const authHome = join(root, dedicated ? 'dedicated-auth' : 'config');
    writeFileSync(join(authHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: {
      id_token: jwt, access_token: 'synthetic-access-not-a-credential', refresh_token: 'synthetic-refresh-not-a-credential',
      account_id: 'synthetic-account' }, last_refresh: new Date().toISOString() }));
    const schema = join(root, 'output.schema.json');
    writeFileSync(schema, JSON.stringify({ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }));
    const fixture = await startCapabilityFixture('codex', 'gpt-6-astra');
    const seen = { auth: false, ancestor: false, skill: false };
    let requestCount = 0, catalogCount = 0, blockedConnectCount = 0, forwardingFailed = false;
    const routes: string[] = [];
    const handle = async (request: Request) => {
        try {
          const path = new URL(request.url).pathname;
          if (routes.length >= 8) throw new Error('total-request-budget');
          if (routes.length < 8) routes.push(request.method + ' ' + path.slice(0, 100));
          if (request.method === 'CONNECT') {
            blockedConnectCount++;
            return new Response('', { status: 403 });
          }
          if (request.method === 'GET' && ['/models', '/v1/models'].includes(path)) {
            if (++catalogCount > 2) throw new Error('catalog-budget');
            return Response.json({ models: [] });
          }
          if (++requestCount > 2 || request.method !== 'POST' || path !== '/v1/responses') throw new Error('route');
          const body = await request.text();
          for (const key of ['auth', 'ancestor', 'skill'] as const) seen[key] ||= body.includes(markers[key]);
          return await fetch(fixture.url + '/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
        } catch { forwardingFailed = true; return new Response('', { status: 400 }); }
      };
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = new Request(`http://127.0.0.1${req.url}`, { method: req.method,
        ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const response = await handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
    proxy.on('connect', (_req, socket) => { blockedConnectCount++; socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const url = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
      const env = { ...probeEnvironment('codex', root, url), CODEX_HOME: authHome };
      const authResult = await runContained({ executable: CODEX_PROPOSAL_PIN.executable, args: ['login', 'status'],
        cwd: join(root, 'cwd'), env, stdin: '', timeoutMs: 5000, maxOutputBytes: 4096 });
      expect(authResult.exitCode).toBe(0); expect(authResult.containmentEmpty).toBe(true);
      const offlineAuthRecognized = /Logged in using ChatGPT/.test(authResult.stdout + authResult.stderr);
      expect(offlineAuthRecognized).toBe(true); expect(requestCount).toBe(0);
      const args = probeArgv('codex', 'gpt-6-astra', url, schema);
      if (dedicated) args.splice(args.length - 1, 0, '-c', 'skills.include_instructions=false');
      if (mode === 'positive') args.splice(args.length - 1, 0, '-c', 'project_doc_max_bytes=32768', '-c', 'skills.include_instructions=true');
      const result = await runContained({ executable: CODEX_PROPOSAL_PIN.executable, args, cwd: join(root, 'cwd'), env,
        stdin: 'Synthetic fixture only. Return JSON ok true.', timeoutMs: 30000, maxOutputBytes: 65536 });
      // These streams contain only loopback-fixture data and synthetic credentials.
      if (result.exitCode !== 0) console.log(JSON.stringify({ dedicated, exitCode: result.exitCode,
        stderr: result.stderr.slice(0, 4096), stdout: result.stdout.slice(0, 4096), requestCount, catalogCount,
        fixture: fixture.snapshot(), routes, blockedConnectCount }));
      expect(result.exitCode).toBe(0); expect(result.containmentEmpty).toBe(true);
      expect(result.timedOut).toBe(false); expect(result.outputLimitExceeded).toBe(false);
      expect(forwardingFailed).toBe(false); expect(requestCount).toBe(2);
      const wire = fixture.snapshot(); expect(wire.fixtureFailure).toBe(false);
      const inspected = classifyProposalEvidence(result.stdout, wire);
      expect(inspected.zeroAdvertisedTools).toBe(true); expect(inspected.executionChallengeRejected).toBe(true);
      expect(inspected.startupNoticeCount).toBe(1); expect(inspected.otherErrorCount).toBe(0);
      expect(() => validateProbeOutput('codex', result.stdout, result.exitCode, String(wire.toolResults[0]?.outputSha256))).toThrow();
      observations.push({ mode, dedicated, offlineAuthRecognized, markersObserved: { ...seen }, blockedConnectCount, ...inspected });
      expect(seen.auth).toBe(!dedicated); expect(seen.ancestor).toBe(mode === 'positive');
      if (mode === 'positive') expect(seen.skill).toBe(true);
      if (dedicated) expect(seen.skill).toBe(false);
    } finally {
      proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); await fixture.close();
      const target = resolve(root);
      if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('acb-codex-proposal-')) throw new Error('cleanup-boundary');
      rmSync(target, { recursive: true, force: true });
    }
  }
  await assertProbePolicyAbsent('codex');
  expect((await hashArtifact(CODEX_PROPOSAL_PIN.executable, 512 * 1024 * 1024)).sha256).toBe(CODEX_PROPOSAL_PIN.sha256);
  console.log(JSON.stringify({ kind: 'synthetic-proposal-observations-only', observations, liveAuthVerified: false, productionAuthorized: false }));
});
