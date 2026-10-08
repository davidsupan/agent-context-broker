import { parseArgs } from 'node:util';

export function parseArtifactQuery(argv: string[]) {
  const result = parseArgs({ args: argv, allowPositionals: true, options: {
    provider: { type: 'string', default: 'codex' }, profile: { type: 'string', default: 'custom-project' },
    query: { type: 'string', multiple: true }, term: { type: 'string', multiple: true },
    'issue-key': { type: 'string' }, 'review-key': { type: 'string' }, 'thread-ref': { type: 'string' },
    'ticket-packages-root': { type: 'string' }, 'runtime-home': { type: 'string' },
    cursor: { type: 'string' }, 'strict-isolation': { type: 'boolean', default: false },
    execute: { type: 'boolean', default: false }
  } });
  if (result.positionals.length !== 1 || result.positionals[0] !== 'query') throw new Error('artifact-query-command-required');
  return result.values;
}
