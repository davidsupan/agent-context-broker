import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hashArtifact } from './artifacts.mts';

export type CliEnvironment = { platform: string; env: Record<string, string | undefined> };
export type ResolvedCli = { path: string; size: number; sha256: string };

export function claudeCliCandidates(explicit: string | undefined, context: CliEnvironment): string[] {
  const { env, platform } = context;
  // The native installer's locations first, then a global npm install's executable (never its .cmd or shell shim).
  const npm = (prefix: string | undefined, ...rest: string[]) => prefix && join(prefix, ...rest, '@anthropic-ai', 'claude-code', 'bin');
  return (explicit ? [explicit] : platform === 'win32'
    ? [env.USERPROFILE && join(env.USERPROFILE, '.local', 'bin', 'claude.exe'),
      env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'claude', 'claude.exe'),
      env.APPDATA && join(npm(env.APPDATA, 'npm', 'node_modules')!, 'claude.exe')]
    : platform === 'darwin' ? [env.HOME && join(env.HOME, '.local', 'bin', 'claude'),
      '/opt/homebrew/bin/claude', '/usr/local/bin/claude',
      join(npm('/opt/homebrew', 'lib', 'node_modules')!, 'claude'), join(npm('/usr/local', 'lib', 'node_modules')!, 'claude')]
    : platform === 'linux' ? [env.HOME && join(env.HOME, '.local', 'bin', 'claude'), '/usr/local/bin/claude',
      join(npm('/usr/local', 'lib', 'node_modules')!, 'claude')]
    : []).filter((path): path is string => Boolean(path));
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
