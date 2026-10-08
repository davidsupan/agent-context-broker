import { parseArtifactQuery } from '../scripts/artifact-query-args.ts';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { noLinks } from './store.mts';
import { runEnrichedQuery } from './query-with-artifacts.mts';
import { AssistantPacksConfig } from './assistant-packs.mts';

const Config = z.strictObject({ brokerToolRoot: z.string().refine(isAbsolute),
  brokerRuntimeHome: z.string().refine(isAbsolute), ticketRoot: z.string().refine(isAbsolute),
  assistantPacks: AssistantPacksConfig.optional() });

export async function artifactQueryCli(argv: string[], configPath: string) {
  const values = parseArtifactQuery(argv);
  // Isolation is decided before config access, even when the config is missing.
  if (values['strict-isolation'] || values.profile === 'strict-isolation') {
    return { originalBrokerPacket: null, sourceArtifacts: [], warnings: ['strict-isolation'],
      coverage: { state: 'not-read', exhaustiveGlobalCoverage: false, nextCursor: null }, artifactAudit: { persisted: false } };
  }
  noLinks(configPath);
  if (lstatSync(configPath).size > 16384) throw new Error('artifact-config-limit');
  const bytes = readFileSync(configPath);
  if (bytes.length > 16384) throw new Error('artifact-config-limit');
  const config = Config.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  const terms = [...(values.query ?? []), ...(values.term ?? [])];
  if (!terms.length && values['issue-key']) terms.push(values['issue-key']);
  return runEnrichedQuery({ ...config, provider: z.enum(['codex', 'claude-code']).parse(values.provider),
    profile: values.profile!, terms, strictIsolation: false, execute: values.execute,
    ...(values['issue-key'] ? { issueKeys: [values['issue-key']] } : {}),
    ...(values['review-key'] ? { reviewKey: values['review-key'] } : {}),
    ...(values['thread-ref'] ? { threadRef: values['thread-ref'] } : {}),
    ...(values.cursor ? { cursor: values.cursor } : {}),
    ...(values['ticket-packages-root'] ? { ticketRoot: values['ticket-packages-root'] } : {}),
    ...(values['runtime-home'] ? { brokerRuntimeHome: values['runtime-home'] } : {})
  });
}
