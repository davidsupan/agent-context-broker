// The `capabilities` and `claims-export` commands, with their own small argument parser and exit codes:
// 0 ok, 2 usage, 3 integrity (nothing is printed to stdout), 4 unsupported provider policy state.

import { capabilities, exportClaims, IntegrityError, type Scope, type ScopeKind } from './claims-export.mts';
import { join } from 'node:path';

import { loadProviderPolicy } from './provider-policy.mjs';

export const EXIT = Object.freeze({ ok: 0, usage: 2, integrity: 3, unsupported: 4 });

const USAGE = [
  'agent-context-broker capabilities --json',
  'agent-context-broker claims-export --provider <codex|claude-code> (--home <runtimeHome> | --runtime-root <path> [--event-runtime-root <path>])',
  '  (--scope <kind:key> ... | --ref <prefix> ... | --include-project <key>) [--after <cursor>] [--limit <n>] [--provider-policy <path>] --json',
].join('\n');

class UsageError extends Error {}

function parse(argv: string[]) {
  const options = { provider: '', runtimeRoot: '', eventRuntimeRoot: '', scopes: [] as Scope[], refs: [] as string[], includeProject: null as string | null,
    after: null as string | null, limit: undefined as number | undefined, providerPolicyPath: '', home: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--json') continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    i += 1;
    switch (flag) {
      case '--provider': options.provider = value; break;
      case '--runtime-root': options.runtimeRoot = value; break;
      case '--event-runtime-root': options.eventRuntimeRoot = value; break;
      case '--scope': {
        const split = value.indexOf(':');
        if (split < 1) throw new UsageError('--scope takes kind:key');
        options.scopes.push({ kind: value.slice(0, split) as ScopeKind, key: value.slice(split + 1) });
        break;
      }
      case '--ref': options.refs.push(value); break;
      case '--include-project': options.includeProject = value; break;
      case '--after': options.after = value; break;
      case '--limit': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--limit takes a positive integer');
        options.limit = n;
        break;
      }
      case '--provider-policy': options.providerPolicyPath = value; break;
      case '--home': options.home = value; break;
      default: throw new UsageError(`unknown option ${flag}`);
    }
  }
  if (!['codex', 'claude-code'].includes(options.provider)) throw new UsageError('--provider must be codex or claude-code');
  // --home resolves the two roots the way the installed launcher does (its env overrides included).
  if (options.home) {
    options.runtimeRoot ||= process.env.AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME ?? join(options.home, 'runtime', 'reconciliation');
    options.eventRuntimeRoot ||= process.env.AGENT_CONTEXT_BROKER_EVENT_RUNTIME ?? join(options.home, 'runtime', 'events');
  }
  if (!options.runtimeRoot) throw new UsageError('--home or --runtime-root is required');
  return options;
}

/** Runs one of the two commands; returns the exit code. Output goes to the given writers. */
export function runClaimsCommand(command: string, argv: string[], out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text)): number {
  if (command === 'capabilities') {
    out(`${JSON.stringify(capabilities(), null, 2)}\n`);
    return EXIT.ok;
  }
  let options: ReturnType<typeof parse>;
  try { options = parse(argv); } catch (error) { err(`${(error as Error).message}\n${USAGE}\n`); return EXIT.usage; }
  let providerPolicy: unknown;
  try {
    providerPolicy = loadProviderPolicy({ providerPolicyPath: options.providerPolicyPath || undefined, runtimeRoots: [options.runtimeRoot, options.eventRuntimeRoot || options.runtimeRoot] });
  } catch (error) {
    // An invalid policy fails closed, as everywhere else.
    err(`provider policy: ${(error as Error).message}\n`);
    return EXIT.unsupported;
  }
  try {
    const result = exportClaims({ runtimeRoot: options.runtimeRoot, eventRuntimeRoot: options.eventRuntimeRoot || undefined,
      provider: options.provider as 'codex' | 'claude-code', scopes: options.scopes, refs: options.refs,
      includeProject: options.includeProject, after: options.after, limit: options.limit, providerPolicy });
    out(`${JSON.stringify(result, null, 2)}\n`);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof IntegrityError) { err(`integrity: ${error.message}\n`); return EXIT.integrity; }
    err(`${(error as Error).message}\n`);
    return EXIT.usage;
  }
}
