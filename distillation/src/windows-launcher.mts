import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ContainedOptions, ContainedResult } from './containment.mts';

const script = fileURLToPath(new URL('./windows-launcher.ps1', import.meta.url));
const source = fileURLToPath(new URL('./windows-launcher.cs', import.meta.url));
const FRAME_LIMIT = 1024 * 1024;
const CHUNK_LIMIT = 65536;
const HOST_GRACE_MS = 30000;
export const windowsLauncherAvailable = () => process.platform === 'win32' && process.arch === 'x64' && existsSync(script) && existsSync(source);
const hostArgs = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script];

export async function probeWindowsJob(name: string): Promise<'active' | 'empty' | 'unknown'> {
  const child = spawn('powershell.exe', [...hostArgs, '-ProbeJob', name], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let text = '';
  child.stdout.on('data', (chunk: Buffer) => { if (text.length < 100) text += chunk.toString('utf8'); });
  const timer = setTimeout(() => child.kill(), HOST_GRACE_MS);
  try {
    await new Promise<void>(resolve => { child.once('error', () => resolve()); child.once('close', () => resolve()); });
    return child.exitCode === 0 && (text.trim() === 'active' || text.trim() === 'empty') ? text.trim() as 'active' | 'empty' : 'unknown';
  } finally { clearTimeout(timer); child.stdout.destroy(); }
}

type Status = {
  containment: 'windows-job-v1'; containmentEmpty: boolean | 'unknown'; exitCode: number;
  timedOut: boolean; outputLimitExceeded: boolean; stdoutBytes: number; stderrBytes: number;
  compileMs: number; executionMs: number; error: string | null;
};
type Lifecycle = {
  claim: () => void;
  started: (pid: number) => void;
  finished: (empty: boolean | 'unknown') => void;
};

/** Binary protocol: uint32 LE size (including type), one type byte, then payload.
 * 1 config, 2 stdin, 3 stdin EOF, 4 stdout, 5 stderr, 6 final status.
 * Only config/status are UTF-8 JSON. No text decoding occurs on the data frames.
 */
export async function runWindowsContained(options: ContainedOptions, owner: { pid: number; creationFiletime: string }, lifecycle: Lifecycle): Promise<ContainedResult> {
  const started = performance.now();
  let child: ChildProcessWithoutNullStreams | undefined;
  let closed: Promise<number | null> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let claimed = false, status: Status | undefined;
  let cleanup: boolean | 'unknown' = 'unknown';
  let hostExpired = false, hostError = false;
  const out: Buffer[] = [], err: Buffer[] = [];
  let outBytes = 0, errBytes = 0;
  try {
    if (!windowsLauncherAvailable()) throw new Error('windows-containment-unavailable');
    const { stdin, ...config } = options;
    const configBytes = Buffer.from(JSON.stringify({ ...config, owner }), 'utf8');
    if (configBytes.length >= FRAME_LIMIT) throw new Error('windows-config-limit');
    lifecycle.claim(); claimed = true;
    child = spawn('powershell.exe', hostArgs, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const host = child;
    closed = new Promise(resolve => host.once('close', code => resolve(code)));
    host.on('error', () => { hostError = true; });
    host.stdin.on('error', () => { /* early host exit; final status/close decides success */ });
    // Bound and discard host diagnostics; they must never become child stderr.
    let diagnostics = 0;
    host.stderr.on('data', (chunk: Buffer) => { diagnostics += chunk.length; if (diagnostics > 65536) host.kill(); });
    timer = setTimeout(() => { hostExpired = true; host.kill(); }, options.timeoutMs + HOST_GRACE_MS);
    const write = (kind: number, bytes: Buffer) => new Promise<void>((resolve, reject) => {
      const header = Buffer.allocUnsafe(5); header.writeUInt32LE(bytes.length + 1); header[4] = kind;
      // Await each write's callback: at most one bounded frame is queued.
      host.stdin.write(Buffer.concat([header, bytes]), error => error ? reject(error) : resolve());
    });
    // Begin both directions before registration or waiting on either pipe.
    const sending = (async () => {
      await write(1, configBytes);
      const input = Buffer.from(stdin);
      for (let offset = 0; offset < input.length; offset += CHUNK_LIMIT) await write(2, input.subarray(offset, offset + CHUNK_LIMIT));
      await write(3, Buffer.alloc(0)); host.stdin.end();
    })().catch(() => { /* child may exit without consuming stdin */ });
    const receiving = (async () => {
      let pending: Buffer = Buffer.alloc(0);
      for await (const data of host.stdout) {
        pending = pending.length ? Buffer.concat([pending, data as Buffer]) : data as Buffer;
        while (pending.length >= 4) {
          const length = pending.readUInt32LE(0);
          if (length < 1 || length > FRAME_LIMIT) throw new Error('windows-invalid-frame');
          if (pending.length < length + 4) break;
          const kind = pending[4], bytes = pending.subarray(5, 4 + length);
          pending = pending.subarray(4 + length);
          if (status) throw new Error('windows-frame-after-status');
          if (kind === 4 || kind === 5) {
            if (bytes.length > CHUNK_LIMIT || outBytes + errBytes + bytes.length > options.maxOutputBytes) throw new Error('windows-output-protocol-limit');
            const copy = Buffer.from(bytes);
            if (kind === 4) { out.push(copy); outBytes += copy.length; } else { err.push(copy); errBytes += copy.length; }
          } else if (kind === 6) {
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Status;
            if (value.containment !== 'windows-job-v1' || ![true, false, 'unknown'].includes(value.containmentEmpty) ||
                !Number.isInteger(value.exitCode) || value.exitCode < 0 || value.exitCode > 0xffffffff ||
                typeof value.timedOut !== 'boolean' || typeof value.outputLimitExceeded !== 'boolean' ||
                value.stdoutBytes !== outBytes || value.stderrBytes !== errBytes ||
                !Number.isFinite(value.compileMs) || value.compileMs < 0 || !Number.isFinite(value.executionMs) || value.executionMs < 0 ||
                !(value.error === null || typeof value.error === 'string')) throw new Error('windows-invalid-status');
            status = value;
          } else throw new Error('windows-unexpected-frame');
        }
      }
      if (pending.length) throw new Error('windows-truncated-frame');
    })();
    // Attach rejection handling now, including registration failures.
    const received = receiving.then(() => null, (error: unknown) => { host.kill(); return error; });
    lifecycle.started(host.pid ?? 0);
    const protocolError = await received;
    const code = await closed;
    await sending;
    if (protocolError) throw protocolError;
    if (hostExpired || hostError || code !== 0 || !status) throw new Error('windows-launcher-failed:containment-unknown');
    cleanup = status.containmentEmpty;
    if (status.error) throw new Error(`windows-launcher:${status.error}`);
    const stdoutBuffer = Buffer.concat(out), stderrBuffer = Buffer.concat(err);
    return { stdout: stdoutBuffer.toString('utf8'), stderr: stderrBuffer.toString('utf8'), stdoutBuffer, stderrBuffer,
      stdoutBytes: outBytes, stderrBytes: errBytes, exitCode: status.exitCode, containment: 'windows-job-v1',
      containmentEmpty: status.containmentEmpty, timedOut: status.timedOut, outputLimitExceeded: status.outputLimitExceeded,
      durationMs: performance.now() - started, startupMs: performance.now() - started - status.executionMs, compileMs: status.compileMs };
  } finally {
    if (timer) clearTimeout(timer);
    if (child) {
      if (child.exitCode === null) child.kill(); // closing the helper's last job handle kills its tree
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      if (closed) await closed;
    }
    if (claimed) lifecycle.finished(cleanup);
  }
}
