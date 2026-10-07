import { tmpdir } from 'node:os';
import { win32 } from 'node:path';

/** Use the OS loader's module inventory, never PATH, cwd, or an environment root. */
export function resolveWindowsHost(modules: readonly string[], temp: string) {
  const kernel = modules.find(path => /^[A-Za-z]:\\.+\\System32\\kernel32\.dll$/i.test(path));
  if (!kernel || !win32.isAbsolute(temp)) throw new Error('windows-system-directory-unverified');
  const system = win32.dirname(kernel), root = win32.dirname(system);
  return {
    executable: win32.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    cwd: system,
    env: { SystemRoot: root, windir: root, TEMP: temp, TMP: temp, PATH: system },
  };
}

export function windowsHost() {
  const report = process.report.getReport() as { sharedObjects?: string[] };
  return resolveWindowsHost(report.sharedObjects ?? [], tmpdir());
}
