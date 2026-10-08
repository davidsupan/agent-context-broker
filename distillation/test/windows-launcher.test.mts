import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ownProcessIdentity, runContained, probeNamedJob, type ContainedOptions } from '../src/containment.mts';
import { windowsHost } from '../src/windows-host.mts';
import { runWindowsContained } from '../src/windows-launcher.mts';

const win = process.platform === 'win32' && process.arch === 'x64';
const env = { SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' };
const options = (code: string, extra: Partial<ContainedOptions> = {}): ContainedOptions => ({
  executable: process.execPath, args: ['-e', code], cwd: tmpdir(), env, stdin: '', timeoutMs: 10000, maxOutputBytes: 65536, ...extra,
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(predicate: () => boolean, ms = 15000) {
  const end = performance.now() + ms;
  while (!predicate() && performance.now() < end) await sleep(25);
  assert.ok(predicate(), 'condition reached within deadline');
}
function stop(child: ChildProcess | undefined) { if (child?.pid && alive(child.pid)) child.kill(); }
// The intermediate process exits while the root and grandchild stay alive. Detached
// creation must not provide job breakaway. Marker files survive loss of stdio/owner.
function orphanTree(directory: string, noisy = false) {
  const leaf = `require('node:fs').writeFileSync(${JSON.stringify(join(directory, 'leaf'))},String(process.pid));
    ${noisy ? "setInterval(()=>{process.stdout.write(Buffer.alloc(8192,255));process.stderr.write(Buffer.alloc(8192,0))},5);" : 'setInterval(()=>{},1000);'}`;
  const middle = `const {spawn}=require('node:child_process');
    const p=spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{detached:true,stdio:${noisy ? "['ignore','inherit','inherit']" : "'ignore'"}});
    p.unref();setTimeout(()=>process.exit(0),300);`;
  return `const fs=require('node:fs');const {spawn}=require('node:child_process');
    fs.writeFileSync(${JSON.stringify(join(directory, 'root'))},String(process.pid));
    const p=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{stdio:['ignore','inherit','inherit']});
    fs.writeFileSync(${JSON.stringify(join(directory, 'middle'))},String(p.pid));
    p.on('exit',()=>fs.writeFileSync(${JSON.stringify(join(directory, 'middle-exited'))},'yes'));
    setInterval(()=>{},1000);`;
}
function cleanTree(directory: string) {
  for (const name of ['root', 'middle', 'leaf']) {
    const path = join(directory, name);
    if (existsSync(path)) { const pid = Number(readFileSync(path, 'utf8')); if (alive(pid)) process.kill(pid); }
  }
}

test('Windows preserves binary output and a partial UTF-8 sequence at the exact cap', { skip: !win }, async () => {
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, n) => n));
  const result = await runContained(options('process.stdout.write(Buffer.from(Array.from({length:256},(_,n)=>n)))'));
  assert.deepEqual(result.stdoutBuffer, bytes);
  assert.equal(result.stdoutBytes, 256);
  assert.equal(result.containment, 'windows-job-v1');
  const cut = await runContained(options("process.stdout.write(Buffer.from([0x61,0xe2,0x82,0xac]));setInterval(()=>{},1000)", { maxOutputBytes: 3 }));
  assert.deepEqual(cut.stdoutBuffer, Buffer.from([0x61, 0xe2, 0x82]));
  assert.equal(cut.stdoutBytes + cut.stderrBytes, 3);
  assert.equal(cut.outputLimitExceeded, true);
  assert.equal(cut.containmentEmpty, true);
});

test('Windows streams large binary stdin concurrently with stdout and then delivers EOF', { skip: !win }, async () => {
  const input = Buffer.alloc(2 * 1024 * 1024);
  for (let n = 0; n < input.length; n++) input[n] = n % 256;
  const result = await runContained(options(`const {createHash}=require('node:crypto');let n=0;const hash=createHash('sha256');
    process.stdout.write(Buffer.alloc(131072,65));
    process.stdin.on('data',b=>{n+=b.length;hash.update(b)});
    process.stdin.on('end',()=>process.stderr.write(JSON.stringify({n,hash:hash.digest('hex')})));`,
  { stdin: input, maxOutputBytes: 200000 }));
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.stdoutBuffer, Buffer.alloc(131072, 65));
  assert.deepEqual(JSON.parse(result.stderr), { n: input.length, hash: createHash('sha256').update(input).digest('hex') });
});

test('Windows timeout kills a grandchild after its intermediate parent has exited', { skip: !win }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'contained-orphan-'));
  try {
    const result = await runContained(options(orphanTree(directory), { timeoutMs: 8000 }));
    assert.ok(existsSync(join(directory, 'middle-exited')));
    assert.equal(result.timedOut, true); assert.equal(result.containmentEmpty, true);
    for (const name of ['root', 'middle', 'leaf']) assert.equal(alive(Number(readFileSync(join(directory, name), 'utf8'))), false);
  } finally { cleanTree(directory); rmSync(directory, { recursive: true, force: true }); }
});

test('Windows combined output cap stops a noisy tree with an exact byte count', { skip: !win }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'contained-noisy-'));
  try {
    const result = await runContained(options(orphanTree(directory, true), { maxOutputBytes: 10003 }));
    assert.equal(result.outputLimitExceeded, true); assert.equal(result.containmentEmpty, true);
    assert.equal(result.stdoutBytes + result.stderrBytes, 10003);
    assert.equal(result.stdoutBuffer.length + result.stderrBuffer.length, 10003);
    for (const name of ['root', 'middle', 'leaf']) assert.equal(alive(Number(readFileSync(join(directory, name), 'utf8'))), false);
  } finally { cleanTree(directory); rmSync(directory, { recursive: true, force: true }); }
});

for (const loss of ['owner', 'helper'] as const) {
test(`Windows ${loss} loss kills orphaned descendants with the binary transport still open`, { skip: !win }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'contained-owner-'));
  let owner: ChildProcess | undefined, helper: ChildProcess | undefined;
  try {
    const moduleUrl = new URL('../src/containment.mts', import.meta.url).href;
    owner = spawn(process.execPath, ['--input-type=module', '-e',
      `import {ownProcessIdentity} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await ownProcessIdentity()));setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const identity = await new Promise<{ pid: number; creationFiletime: string }>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('owner-fixture-timeout')), 15000);
      owner!.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString(); if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text)); } catch (e) { reject(e); } } });
      owner!.once('error', error => { clearTimeout(timer); reject(error); });
      owner!.once('exit', () => { clearTimeout(timer); reject(new Error('owner-fixture-exited')); });
    });
    assert.ok(identity.creationFiletime);
    const host = windowsHost();
    helper = spawn(host.executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../src/windows-launcher.ps1', import.meta.url))], { ...host, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise<void>(resolve => helper!.once('close', () => resolve()));
    helper.stdout!.resume(); helper.stderr!.resume(); helper.stdin!.on('error', () => {});
    const config = Buffer.from(JSON.stringify({ ...options(orphanTree(directory), { timeoutMs: 30000 }), owner: identity, deadlineUnixMs: Date.now() + 30000 }));
    const header = Buffer.alloc(5); header.writeUInt32LE(config.length + 1); header[4] = 1;
    helper.stdin!.write(Buffer.concat([header, config]));
    // Deliberately retain helper stdin without EOF while the watched owner dies.
    await until(() => existsSync(join(directory, 'middle-exited')) && existsSync(join(directory, 'leaf')));
    assert.ok(alive(Number(readFileSync(join(directory, 'leaf'), 'utf8'))));
    if (loss === 'owner') owner.kill(); else helper.kill();
    await until(() => ['root', 'middle', 'leaf'].every(name => !alive(Number(readFileSync(join(directory, name), 'utf8')))));
    await until(() => helper!.exitCode !== null || helper!.signalCode !== null);
    await closed;
  } finally { stop(owner); stop(helper); cleanTree(directory); rmSync(directory, { recursive: true, force: true }); }
});
}

test('Windows job allows query but denies mutation, breakaway, termination and owner DACL changes', { skip: !win }, async () => {
  const name = 'Local\\query-only-' + randomUUID(), host = windowsHost();
  const directory = mkdtempSync(join(tmpdir(), 'job-access-'));
  const code = `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class JobAccess {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
 [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
}
'@
$result = @(4,2,1,8,0x40000,0x80000,0x1f003f) | ForEach-Object {
 $h = [JobAccess]::OpenJobObjectW($_,$false,'${name}');
 $ok = $h -ne [IntPtr]::Zero; if ($ok) { [void][JobAccess]::CloseHandle($h) }; $ok
}
ConvertTo-Json -Compress -InputObject @($result)`;
  try {
    const result = await runContained(options('', { executable: host.executable, cwd: host.cwd,
      args: ['-NoProfile', '-NonInteractive', '-Command', code], env: { ...host.env, TEMP: directory, TMP: directory }, jobName: name, timeoutMs: 20000 }));
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), [true, false, false, false, false, false, false]);
    assert.equal(await probeNamedJob(name), 'empty');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('Windows host ignores poisoned parent PATH, root and runtime injection variables', { skip: !win }, async () => {
  const saved = { ...process.env }, directory = mkdtempSync(join(tmpdir(), 'host-poison-'));
  const host = windowsHost();
  try {
    process.env.PATH = directory; process.env.SystemRoot = directory; process.env.windir = directory;
    process.env.PSModulePath = directory; process.env.COMPlus_Version = 'invalid';
    process.env.DOTNET_STARTUP_HOOKS = join(directory, 'missing.dll');
    const identity = await ownProcessIdentity(); assert.ok(identity);
    const result = await runContained(options('console.log("bounded")', { env: host.env }));
    assert.equal(result.stdout.trim(), 'bounded'); assert.equal(result.containmentEmpty, true);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved); rmSync(directory, { recursive: true, force: true });
  }
});

// Pause an isolated copy of the real helper at the vulnerable prelaunch point.
// Production code has no timing switches or test-only launch bypasses.
for (const scenario of ['owner-loss', 'startup-deadline'] as const) {
test(`Windows prelaunch ${scenario} cannot launch after recovery or renew the execution allowance`, { skip: !win }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'prelaunch-race-'));
  const previous = process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR;
  let owner: ChildProcess | undefined;
  try {
    process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = directory;
    const host = windowsHost(), name = 'Local\\prelaunch-' + randomUUID();
    const registryPath = join(directory, name.slice(6) + '.json');
    const ready = join(directory, 'ready'), release = join(directory, 'release'), launched = join(directory, 'launched');
    const literal = (path: string) => '@"' + path.replaceAll('"', '""') + '"';
    const source = readFileSync(new URL('../src/windows-launcher.cs', import.meta.url), 'utf8');
    const anchor = 'if (budget.ElapsedMilliseconds >= remainingMs) { timedOut = true; throw new InvalidOperationException("deadline-before-launch"); }';
    assert.ok(source.includes(anchor));
    writeFileSync(join(directory, 'windows-launcher.cs'), source.replace(anchor,
      `File.WriteAllText(${literal(ready)}, "ready"); while (!File.Exists(${literal(release)})) Thread.Sleep(10);\n            ${anchor}`));
    copyFileSync(new URL('../src/windows-launcher.ps1', import.meta.url), join(directory, 'windows-launcher.ps1'));
    owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    // Use the same pinned host to read this fixture owner's exact creation time.
    const { execFileSync } = await import('node:child_process');
    const stamp = execFileSync(host.executable, ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${owner.pid}).StartTime.ToFileTimeUtc()`], { ...host, encoding: 'utf8', windowsHide: true }).trim();
    writeFileSync(registryPath, '{}');
    const budget = scenario === 'startup-deadline' ? 4000 : 20000;
    const deadlineUnixMs = Date.now() + budget;
    const run = runWindowsContained(options(`require('node:fs').writeFileSync(${JSON.stringify(launched)},'launched')`, { jobName: name, timeoutMs: budget }),
      { pid: owner.pid!, creationFiletime: stamp }, { claim() {}, finished() {} },
      { registryPath, deadlineUnixMs, launch: () => spawn(host.executable,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(directory, 'windows-launcher.ps1')],
        { ...host, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }) });
    const observed = run.then(result => ({ result, error: null }), (error: unknown) => ({ result: null, error }));
    await until(() => existsSync(ready));
    const record = JSON.parse(readFileSync(registryPath, 'utf8'));
    assert.ok(record.pid > 0 && /^\d+$/.test(record.start));
    if (scenario === 'owner-loss') {
      owner.kill();
      await until(() => !alive(owner!.pid!));
      assert.equal(await probeNamedJob(name), 'unknown');
    } else {
      await sleep(Math.max(0, deadlineUnixMs - Date.now() + 50));
    }
    writeFileSync(release, 'release');
    const outcome = await observed;
    assert.equal(existsSync(launched), false);
    assert.equal(await probeNamedJob(name), 'empty');
    if (scenario === 'owner-loss') assert.match(String(outcome.error), /owner-ended-before-launch/);
    else { assert.equal(outcome.result?.timedOut, true); assert.equal(outcome.result?.containmentEmpty, true); }
  } finally {
    stop(owner);
    if (previous === undefined) delete process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR;
    else process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
}

test('Windows missing executable reports launch failure and records an empty job', { skip: !win }, async () => {
  const jobName = 'Local\\contained-missing-' + randomUUID();
  await assert.rejects(runContained(options('', { executable: join(tmpdir(), randomUUID() + '.exe'), jobName })), /create-process-failed:2/);
  assert.equal(await probeNamedJob(jobName), 'empty');
});
