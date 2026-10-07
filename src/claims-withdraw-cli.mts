// `claims-withdraw`: plan by default, `--execute` to withdraw. Exit codes as the other claims commands: 0 ok,
// 2 usage or a claim that is not current, 3 integrity (the event store does not verify before or after).

import { join } from 'node:path';

import { verifyEventStore } from './event-store.mjs';
import { planClaimWithdrawal, withdrawClaims } from './claims-withdraw.mts';

const USAGE = 'agent-context-broker claims-withdraw (--home <runtimeHome> | --runtime-root <path> [--event-runtime-root <path>] [--audit-root <path> ...]) --claim <claimId> ... --reason <text> [--execute] --json';

export async function runWithdrawCommand(argv: string[], out = (text: string) => process.stdout.write(text), err = (text: string) => process.stderr.write(text)): Promise<number> {
  const options = { home: '', runtimeRoot: '', eventRuntimeRoot: '', auditRoots: [] as string[], claimIds: [] as string[], reason: '', execute: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]!;
    if (flag === '--json') continue;
    if (flag === '--execute') { options.execute = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) { err(`${flag} needs a value\n${USAGE}\n`); return 2; }
    i += 1;
    switch (flag) {
      case '--home': options.home = value; break;
      case '--runtime-root': options.runtimeRoot = value; break;
      case '--event-runtime-root': options.eventRuntimeRoot = value; break;
      case '--audit-root': options.auditRoots.push(value); break;
      case '--claim': options.claimIds.push(value); break;
      case '--reason': options.reason = value; break;
      default: err(`unknown option ${flag}\n${USAGE}\n`); return 2;
    }
  }
  if (options.home) {
    options.runtimeRoot ||= process.env.AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME ?? join(options.home, 'runtime', 'reconciliation');
    options.eventRuntimeRoot ||= process.env.AGENT_CONTEXT_BROKER_EVENT_RUNTIME ?? join(options.home, 'runtime', 'events');
    if (!options.auditRoots.length) options.auditRoots = ['query-audit', 'ticket-audit', 'thread-audit'].map(name => join(options.home, 'runtime', name));
  }
  if (!options.runtimeRoot || !options.claimIds.length || !options.reason.trim()) { err(`${USAGE}\n`); return 2; }
  const eventRoot = options.eventRuntimeRoot || options.runtimeRoot;
  const verified = () => { try { verifyEventStore({ runtimeRoot: eventRoot }); return true; } catch { return false; } };
  if (!verified()) { err('integrity: the event store does not verify; nothing was changed\n'); return 3; }
  const input = { runtimeRoot: options.runtimeRoot, eventRuntimeRoot: eventRoot, claimIds: options.claimIds, reason: options.reason, auditRoots: options.auditRoots };
  try {
    const result = options.execute ? await withdrawClaims({ ...input, execute: true }) : planClaimWithdrawal(input);
    if (options.execute && !verified()) { err('integrity: the event store does not verify after the withdrawal\n'); out(`${JSON.stringify(result, null, 2)}\n`); return 3; }
    out(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    err(`${(error as Error).message}\n`);
    return 2;
  }
}
