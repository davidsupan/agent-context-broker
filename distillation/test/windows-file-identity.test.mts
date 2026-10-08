import { expect, test } from './expect.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sameWindowsIdentity, windowsFileIdentity } from '../src/windows-file-identity.mts';

test('an old 64-bit volume serial record matches the current low-32-bit identity', () => {
  const old = `win:${0xf123456789abcdefn}:${0x123456789abcdefn}`;
  const current = `win:${0x89abcdefn}:${0x123456789abcdefn}`;
  expect(sameWindowsIdentity(old, current)).toBe(true);
  expect(sameWindowsIdentity(old, `win:${0x89abcdefn}:${0x123456789abcdf0n}`)).toBe(false);
  expect(sameWindowsIdentity('win:2309737967:340282366920938463463374607431768211455', 'win:2309737967:18446744073709551615')).toBe(false);
  expect(sameWindowsIdentity('malformed', 'win:1:2')).toBe(false);
});

(process.platform === 'win32' ? test : test.skip)('a file identity uses stat volume low bits and file index', () => {
  const home = mkdtempSync(join(tmpdir(), 'acb-file-identity-'));
  try {
    const path = join(home, 'synthetic.txt');
    writeFileSync(path, 'synthetic');
    expect(windowsFileIdentity(path)).toMatch(/^win:\d+:\d+$/);
    expect(sameWindowsIdentity(windowsFileIdentity(path), windowsFileIdentity(path))).toBe(true);
    expect(() => windowsFileIdentity('relative.txt')).toThrow('native-file-identity-unavailable');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
