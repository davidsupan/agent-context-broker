// File identity on Windows without FFI. The Bun runner read FILE_ID_INFO: the full 64-bit volume serial and the
// 128-bit file id (`win:<volume>:<id>`). Node's stat gives the low 32 bits of the volume serial as `dev` and the
// 64-bit file index as `ino`. On NTFS the 128-bit id is that index zero-extended and the 32-bit serial is the low
// part of the 64-bit one, so an identity recorded by the old runner is matched by truncating its serial, and new
// identities are written in the same `win:` shape with the 32-bit serial.

import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** `win:<volume serial low 32 bits>:<file index>` for an existing absolute path on Windows. */
export function windowsFileIdentity(path: string): string {
  if (process.platform !== 'win32' || !isAbsolute(path) || path.includes('\0')) throw new Error('native-file-identity-unavailable');
  const s = statSync(path, { bigint: true });
  if (s.ino === 0n) throw new Error('native-file-identity-unavailable');
  return `win:${s.dev & 0xffffffffn}:${s.ino}`;
}

/**
 * Whether a stored `win:` identity names the same file as a fresh one. The stored value may carry the full
 * 64-bit serial and a 128-bit id from the old runner; both sides are compared after the same truncation.
 */
export function sameWindowsIdentity(stored: string, actual: string): boolean {
  const parse = (value: string) => {
    const m = /^win:(\d+):(\d+)$/.exec(value);
    return m ? { volume: BigInt(m[1]!) & 0xffffffffn, id: BigInt(m[2]!) & 0xffffffffffffffffn, high: BigInt(m[2]!) >> 64n } : null;
  };
  const a = parse(stored), b = parse(actual);
  return Boolean(a && b && a.high === 0n && b.high === 0n && a.volume === b.volume && a.id === b.id);
}
