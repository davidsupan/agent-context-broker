// The JavaScript runtime the broker is running on (TypeScript; scripts/build-package.mjs ships it as .mjs). Node 24 is the primary runtime; Bun 1.4
// keeps working for one more release. Everything runtime-specific goes through here, so the
// rest of the code never touches `globalThis.Bun`.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const MINIMUM_NODE_VERSION = '24.2.0';
export const MINIMUM_BUN_VERSION = '1.4.0';

function versionParts(version: unknown): number[] {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(String(version ?? ''));
  if (!match) throw new Error(`Invalid runtime version: ${version ?? '<missing>'}`);
  return match.slice(1).map(Number);
}

function atLeast(version: string, minimum: string): boolean {
  const [a, b, c] = versionParts(version);
  const [x, y, z] = versionParts(minimum);
  return a !== x ? a > x : b !== y ? b > y : c >= z;
}

export type RuntimeName = 'node' | 'bun';
export type RuntimeInfo = { name: RuntimeName; version: string; path: string };
export type InstalledRuntime = RuntimeInfo & { present: boolean; reportedVersion: string | null; supported: boolean };

/** The current runtime: `{ name, version, path }`, where `path` is the executable that runs this process. */
export function runtimeInfo(): RuntimeInfo {
  const bun = (globalThis as { Bun?: { version: string } }).Bun;
  return bun
    ? { name: 'bun', version: bun.version, path: process.execPath }
    : { name: 'node', version: process.versions.node, path: process.execPath };
}

/** Throws unless the runtime is Node >= 24.2 or Bun 1.4 below 2.0. Returns the runtime description. */
export function assertSupportedRuntime(info: RuntimeInfo = runtimeInfo()): RuntimeInfo {
  if (info.name === 'bun') {
    if (versionParts(info.version)[0] === 1 && atLeast(info.version, MINIMUM_BUN_VERSION)) return info;
    throw new Error(`Agent Context Broker requires Bun ${MINIMUM_BUN_VERSION} or newer, below 2.0.0, or Node ${MINIMUM_NODE_VERSION} or newer.`);
  }
  if (info.name === 'node' && atLeast(info.version, MINIMUM_NODE_VERSION)) return info;
  throw new Error(`Agent Context Broker requires Node ${MINIMUM_NODE_VERSION} or newer, or Bun ${MINIMUM_BUN_VERSION} or newer below 2.0.0.`);
}

/**
 * Whether the runtime an installation pinned still exists and reports a supported version. Hooks fail
 * open, so a Node that an upgrade removed would otherwise go unnoticed; this makes it unhealthy instead.
 */
export function inspectInstalledRuntime(runtime: RuntimeInfo): InstalledRuntime {
  const result: InstalledRuntime = { ...runtime, present: false, reportedVersion: null, supported: false };
  if (!runtime?.path || !existsSync(runtime.path)) return result;
  result.present = true;
  const probe = spawnSync(runtime.path, ['--version'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  const reported = probe.status === 0 ? String(probe.stdout ?? '').trim().replace(/^v/u, '') : null;
  if (!reported) return result;
  result.reportedVersion = reported;
  try {
    assertSupportedRuntime({ name: runtime.name, version: reported, path: runtime.path });
    result.supported = true;
  } catch {
    result.supported = false;
  }
  return result;
}

/** Blocks the thread for `milliseconds`; used only in short lock retry loops. */
export function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, milliseconds));
}

/** True when `moduleUrl` is the entry point of this process, on Node and on Bun. */
export function isMainModule(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  if (!argv[1]) return false;
  try {
    const { fileURLToPath } = globalThis.process.getBuiltinModule('node:url');
    const { resolve } = globalThis.process.getBuiltinModule('node:path');
    return resolve(argv[1]) === resolve(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
