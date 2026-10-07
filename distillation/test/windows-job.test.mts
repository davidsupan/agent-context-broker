import { describe, expect, test } from './expect.mts';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLEANUP_TIMEOUT_MS, ownProcessIdentity, probeNamedJob, probeOwner, registryDir,
  runContained, type ContainedOptions } from '../src/windows-job.mts';

const supported = process.platform === 'win32' ? process.arch === 'x64' : process.platform === 'darwin' || process.platform === 'linux';
const nativeTest = supported ? test : test.skip;
const options = (code: string, overrides: Partial<ContainedOptions> = {}): ContainedOptions => ({
  executable: process.execPath, args: ['-e', code], cwd: tmpdir(),
  env: { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', PATH: process.env.PATH ?? '' }, stdin: '',
  maxOutputBytes: 65536, timeoutMs: 5000, ...overrides,
});

describe('portable containment validation', () => {
  nativeTest('bad options fail before launch', async () => {
    const cases: Array<[Partial<ContainedOptions>, string]> = [
      [{ executable: 'node' }, 'invalid-native-executable'],
      [{ args: ['\0'] }, 'invalid-native-argv'],
      [{ cwd: 'relative' }, 'invalid-cwd'],
      [{ timeoutMs: 0 }, 'timeout-limit'],
      [{ timeoutMs: Infinity }, 'timeout-limit'],
      [{ maxOutputBytes: 0 }, 'output-limit'],
      [{ stdin: new Uint8Array(16 * 1024 * 1024 + 1) }, 'stdin-limit'],
      [{ env: { 'bad=name': 'value' } }, 'invalid-environment'],
      [{ jobName: 'Global\\not-allowed' }, 'invalid-job-name'],
    ];
    if (process.platform === 'win32') cases.push(
      [{ executable: 'C:\\bad.cmd' }, 'invalid-native-executable'],
      [{ env: { Path: 'a', PATH: 'b' } }, 'duplicate-environment-name']);
    for (const [overrides, code] of cases) await expect(runContained(options('process.exit(99)', overrides))).rejects.toThrow(code);
  });
});

describe('durable recovery snapshots', () => {
  nativeTest('own identity survives JSON and detects PID reuse without using age', async () => {
    const identity = await ownProcessIdentity();
    if (!identity) throw new Error('identity-unavailable');
    expect(identity.pid).toBe(process.pid);
    expect(identity.machineIdSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await probeOwner(JSON.parse(JSON.stringify(identity)))).toBe('alive');
    expect(JSON.stringify(await ownProcessIdentity())).toBe(JSON.stringify(identity));
    const changed = identity.platform === 'windows'
      ? { ...identity, creationFiletime: (BigInt(identity.creationFiletime) + 1n).toString() }
      : { ...identity, startTime: 'Thu Jan  1 00:00:00 1970' };
    expect(await probeOwner(changed)).toBe('dead');
    expect(await probeOwner({ ...identity, createdAt: 0, expiresAt: 0 })).toBe('alive');
  });

  nativeTest('foreign, malformed and lossy identities remain unknown', async () => {
    const identity = await ownProcessIdentity();
    if (!identity) throw new Error('identity-unavailable');
    const values: unknown[] = [null, [], {}, { ...identity, platform: 'other' },
      ...[0, -1, 1.5, 0x100000000, true].map(pid => ({ ...identity, pid })),
      { ...identity, machineIdSha256: 'not-a-hash' }, { ...identity, machineIdSha256: 'a'.repeat(64) }];
    if (identity.platform === 'windows') values.push(
      { ...identity, creationFiletime: Number(identity.creationFiletime) },
      ...['0', '01', '18446744073709551616', '1'.repeat(10000)].map(creationFiletime => ({ ...identity, creationFiletime })));
    for (const value of values) expect(await probeOwner(value)).toBe('unknown');
    expect(await probeOwner({ get platform() { throw new Error('synthetic-getter'); } })).toBe('unknown');
  });

  nativeTest('an absent PID is dead and repeated read-only owner probes stay stable', async () => {
    const identity = await ownProcessIdentity();
    if (!identity) throw new Error('identity-unavailable');
    expect(await probeOwner({ ...identity, pid: 0xffffffff })).toBe('dead');
    for (let i = 0; i < 8; i++) expect(await probeOwner(identity)).toBe('alive');
  });

  nativeTest('a missing label is absent; invalid labels are unknown; a finished label is empty', async () => {
    const name = 'Local\\acb-probe-' + randomUUID();
    expect(await probeNamedJob(name)).toBe('absent');
    for (const value of [null, '', 'Global\\job', 'Local\\bad\0name', 'Local\\' + 'x'.repeat(181)])
      expect(await probeNamedJob(value)).toBe('unknown');
    await runContained(options('process.exit(0)', { jobName: name }));
    expect(await probeNamedJob(name)).toBe('empty');
    await expect(runContained(options('process.exit(0)', { jobName: name }))).rejects.toThrow('job-name-already-exists');
  });

  nativeTest('a contained child observes its active label and its owner is dead after exit', async () => {
    const name = 'Local\\acb-recovery-' + randomUUID();
    const moduleUrl = new URL('../src/windows-job.mts', import.meta.url).href;
    const code = `import {ownProcessIdentity,probeNamedJob,probeOwner} from ${JSON.stringify(moduleUrl)};
      const owner=await ownProcessIdentity();
      let jobState='absent';
      for(let i=0;i<20;i++){jobState=await probeNamedJob(${JSON.stringify(name)});if(jobState==='active')break;await new Promise(r=>setTimeout(r,100));}
      console.log(JSON.stringify({owner,ownerState:await probeOwner(owner),jobState}));`;
    // Recovery tools need an explicit shared registry/temp location now that no
    // parent environment variables are silently inserted into the child.
    const result = await runContained(options(code, { jobName: name, timeoutMs: 15000, cwd: process.cwd(),
      env: { ...options('').env, TEMP: tmpdir(), TMP: tmpdir(), AGENT_CONTEXT_BROKER_CONTAINMENT_DIR: registryDir() } }));
    expect(result.exitCode).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed.ownerState).toBe('alive');
    expect(observed.jobState).toBe('active');
    expect(await probeOwner(observed.owner)).toBe('dead');
    expect(await probeNamedJob(name)).toBe('empty');
  });
});

describe('contained native Node processes', () => {
  nativeTest('separate bounded output and exact nonzero exit', async () => {
    const result = await runContained(options('console.log("out"); console.error("err"); process.exit(23);'));
    expect(result.stdout).toBe('out\n'); expect(result.stderr).toBe('err\n');
    expect(result.stdoutBytes).toBe(4); expect(result.stderrBytes).toBe(4);
    expect(result.exitCode).toBe(23); expect(result.containmentEmpty).toBe(true);
    expect(result.timedOut).toBe(false); expect(result.outputLimitExceeded).toBe(false);
  });

  nativeTest('259 is an ordinary exit code', async () => {
    const result = await runContained(options('process.exit(259)'));
    expect(result.exitCode).toBe(259); expect(result.containmentEmpty).toBe(true);
  });

  (process.platform === 'win32' ? test : test.skip)('argv round trips through spaced executable and cwd; the whole environment is exact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'acb containment spaces '));
    try {
      const executable = join(directory, 'synthetic node.exe');
      copyFileSync(process.execPath, executable);
      const args = ['', 'a b', 'x\ty', 'quote"inside', 'trail space\\', '\\\\"', 'é🚀', '&|<>^%PATH%'];
      const code = 'console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),env:process.env}));';
      const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows', ACB_TEST: 'synthetic value', lower_case: 'one=two\nthree', EMPTY: '' };
      const result = await runContained(options(code, { executable, cwd: directory,
        args: ['-e', code, '--', ...args], env }));
      expect(result.exitCode).toBe(0);
      const seen = JSON.parse(result.stdout);
      expect(seen).toEqual({ args, cwd: directory, env });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  nativeTest('large stdin is delivered byte for byte, then EOF', async () => {
    const input = 'syntheticé🚀\n'.repeat(65536);
    const code = `const {createHash}=require('node:crypto');const h=createHash('sha256');let n=0;
      process.stdin.on('data',chunk=>{h.update(chunk);n+=chunk.length});
      process.stdin.on('end',()=>console.log(h.digest('hex')+'\\n'+n));`;
    const result = await runContained(options(code, { stdin: input, timeoutMs: 30000 }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([createHash('sha256').update(input).digest('hex'), String(Buffer.byteLength(input))]);
  });

  nativeTest('blocked stdin cannot block wall timeout', async () => {
    const started = performance.now();
    const result = await runContained(options('console.log(process.pid); setTimeout(()=>process.exit(0),10000);',
      { stdin: Buffer.alloc(1024 * 1024, 65), timeoutMs: 1800 }));
    expect(result.timedOut).toBe(true); expect(result.containmentEmpty).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(performance.now() - started < 1800 + CLEANUP_TIMEOUT_MS + 1500).toBe(true);
  });

  nativeTest('combined output cap terminates a noisy process', async () => {
    const result = await runContained(options('const b="x".repeat(65536);for(let i=0;i<1000;i++){process.stdout.write(b);process.stderr.write(b)}',
      { maxOutputBytes: 1024 }));
    expect(result.outputLimitExceeded).toBe(true);
    expect(result.stdoutBytes + result.stderrBytes).toBe(1024);
    expect(result.containmentEmpty).toBe(true);
  });

  for (const rootExits of [false, true]) {
    nativeTest('child and grandchild are stopped, root exits=' + rootExits, async () => {
      const grandchild = 'console.log("grandchild:"+process.pid);setTimeout(()=>process.exit(0),30000);';
      const child = `const {spawn}=require('node:child_process');console.log('child:'+process.pid);
        spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','inherit','inherit']});
        setTimeout(()=>process.exit(0),30000);`;
      const root = `const {spawn}=require('node:child_process');console.log('root:'+process.pid);
        spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});
        setTimeout(()=>process.exit(17),${rootExits ? 1600 : 30000});`;
      const result = await runContained(options(root, { timeoutMs: 8000 }));
      expect(result.stdout.trim().split('\n')).toHaveLength(3);
      expect(result.containmentEmpty).toBe(true);
      expect(result.timedOut).toBe(!rootExits);
      if (rootExits) expect(result.exitCode).toBe(17);
    });
  }

  nativeTest('a descendant without output pipes is stopped after the root exits', async () => {
    const child = 'setTimeout(()=>process.exit(0),30000);';
    const root = `const {spawn}=require('node:child_process');
      const p=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});
      console.log(p.pid);process.exit(0);`;
    const result = await runContained(options(root));
    expect(result.exitCode).toBe(0);
    expect(result.containmentEmpty).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });

  nativeTest('an existing label is rejected without changing its completed record', async () => {
    const name = 'Local\\acb-collision-' + randomUUID();
    await runContained(options('process.exit(0)', { jobName: name }));
    await expect(runContained(options('process.exit(0)', { jobName: name }))).rejects.toThrow('job-name-already-exists');
    expect(await probeNamedJob(name)).toBe('empty');
  });

  nativeTest('concurrent runs keep output and cleanup independent', async () => {
    const results = await Promise.all([
      runContained(options('setTimeout(()=>console.log("first"),150);')),
      runContained(options('console.log("second"); process.exit(9);')),
    ]);
    expect(results.map(result => result.stdout)).toEqual(['first\n', 'second\n']);
    expect(results.map(result => result.exitCode)).toEqual([0, 9]);
    expect(results.every(result => result.containmentEmpty && !result.timedOut)).toBe(true);
  });
});
