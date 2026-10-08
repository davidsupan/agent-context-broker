import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { probeNamedJob, probeWindowsRecord } from '../src/containment.mts';
import { resolveWindowsHost } from '../src/windows-host.mts';
import { runWindowsContained } from '../src/windows-launcher.mts';

test('missing, removed and relocated registry records are unknown', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'registry-proof-'));
  const previous = process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR;
  const name = 'Local\\synthetic-record';
  try {
    process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = directory;
    assert.equal(await probeNamedJob(name), 'unknown');
    const path = join(directory, 'synthetic-record.json');
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, jobName: name, platform: process.platform === 'win32' ? 'windows' : process.platform,
      pid: 123, start: '123', state: 'empty', containment: 'windows-job-v1', terminalAcknowledged: true }));
    assert.equal(await probeNamedJob(name), 'empty');
    process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = join(directory, 'different-temp');
    assert.equal(await probeNamedJob(name), 'unknown');
    process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = directory;
    rmSync(path); assert.equal(await probeNamedJob(name), 'unknown');
  } finally {
    if (previous === undefined) delete process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR;
    else process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('empty accounting cannot certify a live, unregistered or unverified helper', async () => {
  const record = { pid: 123, start: '456', state: 'running' as const };
  for (const snapshot of [{ state: 'alive' as const, start: '456' }, { state: 'unknown' as const, start: null }]) {
    assert.equal(await probeWindowsRecord(record, async () => snapshot, async () => 'empty'), 'unknown');
  }
  for (const snapshot of [{ state: 'dead' as const, start: null }, { state: 'alive' as const, start: '789' }]) {
    assert.equal(await probeWindowsRecord(record, async () => snapshot, async () => 'empty'), 'empty');
    assert.equal(await probeWindowsRecord(record, async () => snapshot, async () => 'unknown'), 'unknown');
    assert.equal(await probeWindowsRecord(record, async () => snapshot, async () => 'active'), 'active');
  }
  assert.equal(await probeWindowsRecord({ ...record, start: null }, async () => ({ state: 'dead', start: null }), async () => 'empty'), 'unknown');
  assert.equal(await probeWindowsRecord({ ...record, state: 'empty', terminalAcknowledged: true },
    async () => ({ state: 'alive', start: '456' }), async () => 'unknown'), 'empty');
});

test('host uses loaded system directory and an allowlisted environment', () => {
  const host = resolveWindowsHost(['X:\\System\\System32\\KERNEL32.DLL'], 'X:\\Temp');
  assert.equal(host.executable, 'X:\\System\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(host.cwd, 'X:\\System\\System32');
  assert.deepEqual(host.env, { SystemRoot: 'X:\\System', windir: 'X:\\System', TEMP: 'X:\\Temp', TMP: 'X:\\Temp', PATH: host.cwd });
  assert.throws(() => resolveWindowsHost(['kernel32.dll'], 'X:\\Temp'), /unverified/);
});

for (const stalled of ['all', 'send', 'close', 'receive'] as const) {
  test(`watchdog bounds ${stalled} transport stalls even when kill does not close handles`, async () => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    let killed = false, unreferenced = false, finished: unknown;
    Object.assign(child, { exitCode: null, stdout: new PassThrough(), stderr: new PassThrough(),
      stdin: new Writable({ write(_chunk, _encoding, callback) { if (stalled !== 'all' && stalled !== 'send') callback(); } }),
      kill() { killed = true; return true; }, unref() { unreferenced = true; } });
    const start = performance.now();
    const run = runWindowsContained({ executable: process.execPath, args: [], cwd: tmpdir(), env: {},
      stdin: Buffer.alloc(131072), maxOutputBytes: 1024, timeoutMs: 40 }, { pid: 123, creationFiletime: '456' },
    { claim() {}, finished(value) { finished = value; } }, { launch: () => child, shutdownGraceMs: 20 });
    if (stalled === 'send' || stalled === 'close') child.stdout.push(null);
    if (stalled === 'send' || stalled === 'receive') child.emit('close', 0);
    const result = await run;
    assert.equal(result.containmentEmpty, 'unknown'); assert.equal(finished, 'unknown');
    assert.equal(result.timedOut, true); assert.ok(killed && unreferenced);
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
    assert.ok(performance.now() - start < 1000);
  });
}
