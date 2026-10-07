import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hashArtifact } from './artifacts.mts';

export type CliEnvironment = { platform: string; env: Record<string, string | undefined> };
export type ResolvedCli = { path: string; size: number; sha256: string };

export function claudeCliCandidates(explicit: string | undefined, context: CliEnvironment): string[] {
  const { env, platform } = context;
  return (explicit ? [explicit] : platform === 'win32'
    ? [env.USERPROFILE && join(env.USERPROFILE, '.local', 'bin', 'claude.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe')]
    : platform === 'darwin' ? [env.HOME && join(env.HOME, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude'] : []).filter((path): path is string => Boolean(path));
}

/** No shell, PATH, version invocation, or implicit home lookup. */
export async function resolveClaudeCli(explicit: string | undefined, context: CliEnvironment): Promise<ResolvedCli> {
  const candidates = claudeCliCandidates(explicit, context);
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!isAbsolute(candidate)) throw new Error('provider-cli-path-not-absolute');
    if (!existsSync(candidate)) continue;
    // Native installers commonly expose a symlink to the versioned executable.
    const path = realpathSync(candidate);
    const result = await hashArtifact(path, 512 * 1024 * 1024);
    return { path, size: result.bytes, sha256: result.sha256 };
  }
  throw new Error('provider-cli-not-found');
}
