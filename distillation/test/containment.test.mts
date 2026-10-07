import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { ownProcessIdentity, probeNamedJob, probeOwner, runContained } from '../src/containment.mts';

let registry = '';
before(() => { registry = mkdtempSync(join(tmpdir(), 'acb-containment-')); process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR = registry; });
after(() => { delete process.env.AGENT_CONTEXT_BROKER_CONTAINMENT_DIR; rmSync(registry, { recursive: true, force: true }); });

const node = process.execPath;
const env = { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' };
const base = { executable: node, cwd: tmpdir(), env, stdin: '', maxOutputBytes: 65536, timeoutMs: 20000 };
const script = (code: string) => ['-e', code];

test('a command reads stdin, writes output and exits; the tree is verified empty', async () => {
  const result = await runContained({ ...base, args: script('process.stdin.pipe(process.stdout)'), stdin: 'hello' });
  assert.equal(result.stdout, 'hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.containmentEmpty, true);
  assert.equal(result.timedOut, false);
});

test('the exit code and stderr come back as they were', async () => {
  const result = await runContained({ ...base, args: script("process.stderr.write('bad', () => process.exit(7))") });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, 'bad');
});

test('a timeout stops the whole tree', async () => {
  const result = await runContained({ ...base, timeoutMs: 1500, args: script('setInterval(() => {}, 1000)') });
  assert.equal(result.timedOut, true);
  assert.equal(result.containmentEmpty, true);
});

test('output beyond the limit stops the tree and is cut at the limit', async () => {
  const result = await runContained({ ...base, maxOutputBytes: 1000, args: script("setInterval(() => process.stdout.write('x'.repeat(4096)), 5)") });
  assert.equal(result.outputLimitExceeded, true);
  assert.equal(result.stdoutBytes, 1000);
  assert.equal(result.containmentEmpty, true);
});

test('a grandchild left running after the child exits is stopped', async () => {
  // The child starts a long-lived grandchild and exits at once; containment must find and stop it.
  const child = `const { spawn } = require('node:child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
g.unref(); setTimeout(() => process.exit(0), 300);`;
  const result = await runContained({ ...base, args: script(child) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.containmentEmpty, true);
});

test('a labelled run is recorded; its label then reads empty, an unknown label absent, a reused label refused', async () => {
  const jobName = `Local\\ACBTest-${process.pid}-${Date.now()}`;
  await runContained({ ...base, jobName, args: script('process.exit(0)') });
  assert.equal(await probeNamedJob(jobName), 'empty');
  assert.equal(await probeNamedJob(`Local\\ACBTest-missing-${Date.now()}`), 'absent');
  assert.equal(await probeNamedJob('not a label'), 'unknown');
  await assert.rejects(runContained({ ...base, jobName, args: script('process.exit(0)') }), /job-name-already-exists/);
});

test('the own identity probes alive; a forged start stamp or another machine does not', async () => {
  const me = await ownProcessIdentity();
  assert.ok(me, 'identity');
  assert.equal(await probeOwner(me), 'alive');
  const forged = me.platform === 'windows' ? { ...me, creationFiletime: '1' } : { ...me, startTime: 'Thu Jan  1 00:00:00 1970' };
  assert.equal(await probeOwner(forged), 'dead');
  assert.equal(await probeOwner({ ...me, machineIdSha256: '0'.repeat(64) }), 'unknown');
  assert.equal(await probeOwner({ pid: 'x' }), 'unknown');
});

test('invalid options are refused before anything starts', async () => {
  await assert.rejects(runContained({ ...base, executable: 'node', args: [] }), /invalid-native-executable/);
  await assert.rejects(runContained({ ...base, args: [], timeoutMs: 0 }), /timeout-limit/);
  await assert.rejects(runContained({ ...base, args: [], jobName: 'bad' }), /invalid-job-name/);
});
