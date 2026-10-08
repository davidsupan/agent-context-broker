import { parseArgs } from 'node:util';
import { closeEmergency, emergencyHome, emergencyReport, evaluateEmergency, openEmergency, openGrants, verifyEmergency } from './emergency.mts';
import { pruneInjectionAudit } from './audit-prune.mts';

export function runEmergencyCommand(command: string, argv: string[], now?: Date): number {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      provider: { type: 'string' }, until: { type: 'string' }, reason: { type: 'string' }, trigger: { type: 'string' },
      window: { type: 'string' }, execute: { type: 'boolean' }, text: { type: 'boolean' }, since: { type: 'string' },
      grant: { type: 'string' }, 'runtime-home': { type: 'string' }, 'older-than-days': { type: 'string' }
    } });
    const action = positionals[0];
    const allowed: Record<string, string[]> = {
      open: ['provider', 'until', 'reason', 'trigger', 'window', 'execute'], close: ['provider', 'reason', 'execute'],
      status: ['provider'], report: ['since', 'grant', 'text'], prune: ['older-than-days', 'execute']
    };
    if (positionals.length !== 1 || !(action in allowed) || (command === 'audit' ? action !== 'prune' : action === 'prune') ||
        Object.keys(values).some(k => k !== 'runtime-home' && !allowed[action].includes(k)))
      throw Object.assign(new Error('Invalid emergency/audit command or options.'), { exitCode: 2 });
    if (values.provider && !['codex', 'claude-code'].includes(values.provider)) throw Object.assign(new Error('Unsupported provider.'), { exitCode: 2 });
    if (values.since && (!/(Z|[+-]\d\d:\d\d)$/u.test(values.since) || !Number.isFinite(Date.parse(values.since)))) throw Object.assign(new Error('Invalid absolute --since.'), { exitCode: 2 });
    const options = { ...values, now, runtimeHome: values['runtime-home'], olderThanDays: values['older-than-days'] };
    let result: any;
    if (action === 'open') result = openEmergency(options);
    else if (action === 'close') result = closeEmergency(options);
    else if (action === 'prune') result = pruneInjectionAudit(options);
    else if (action === 'report') result = emergencyReport(options);
    else {
      const evaluated = evaluateEmergency({ ...options, execute: true });
      const ledger = verifyEmergency(emergencyHome(options));
      result = { schemaVersion: 1, chainVerified: ledger.valid, warnings: [...new Set([...evaluated.warnings, ...ledger.warnings])],
        grants: openGrants(ledger.records).filter(g => (!values.provider || g.provider === values.provider) && Date.parse(g.expiresAt) > +(now ?? new Date())) };
    }
    console.log(values.text ? result.grants.map((g: any) => `${g.grantId} ${g.provider} ${g.state}: ${g.counts.queries} queries, ${g.counts.publishes} publications, ${g.counts.progress} progress; ${g.writes.length} claim writes.`).join('\n') : JSON.stringify(result, null, 2));
    return result.chainVerified === false ? 3 : 0;
  } catch (error) {
    const e = error as Error & { exitCode?: number; code?: string };
    console.error(e.message);
    return e.exitCode ?? (e.code?.startsWith('ERR_PARSE_ARGS') ? 2 : 1);
  }
}
