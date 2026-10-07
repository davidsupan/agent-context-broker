import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runContained, probeNamedJob, type ContainedOptions } from '../src/containment.mts';

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
    const result = await runContained(options(orphanTree(directory), { timeoutMs: 2500 }));
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
    helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../src/windows-launcher.ps1', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const closed = new Promise<void>(resolve => helper!.once('close', () => resolve()));
    helper.stdout!.resume(); helper.stderr!.resume(); helper.stdin!.on('error', () => {});
    const config = Buffer.from(JSON.stringify({ ...options(orphanTree(directory), { timeoutMs: 30000 }), owner: identity }));
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

test('Windows missing executable reports launch failure and records an empty job', { skip: !win }, async () => {
  const jobName = 'Local\\contained-missing-' + randomUUID();
  await assert.rejects(runContained(options('', { executable: join(tmpdir(), randomUUID() + '.exe'), jobName })), /create-process-failed:2/);
  assert.equal(await probeNamedJob(jobName), 'empty');
});
