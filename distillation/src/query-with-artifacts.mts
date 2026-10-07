import { sha256Hasher } from './platform.mts';
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { lstatSync, mkdirSync, opendirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { indexTicketPackages, searchTicketPackages } from './ticket-packages.mts';
import { AssistantPacksConfig, type BrokerScope, readAssistantPacks, renderAssistantPacks } from './assistant-packs.mts';
import { digest } from './slicing.mts';
import { noLinks } from './store.mts';

const Issue = z.string().regex(/^[A-Z][A-Z0-9]{1,15}-[0-9]{1,12}$/);
const Input = z.strictObject({ brokerToolRoot: z.string().refine(isAbsolute),
  brokerRuntimeHome: z.string().refine(isAbsolute), ticketRoot: z.string().refine(isAbsolute),
  issueKeys: z.array(Issue).min(1).max(32).optional(),
  reviewKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}![1-9][0-9]{0,11}$/).optional(),
  threadRef: z.string().regex(/^context:\/\/thread\/[a-f0-9]{64}$/).optional(),
  terms: z.array(z.string().trim().min(1).max(80).refine(s => !s.startsWith('--') && !/[\x00-\x1f]/u.test(s))).max(12),
  profile: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), provider: z.enum(['codex', 'claude-code']),
  strictIsolation: z.boolean(), cursor: z.string().max(90).optional(), execute: z.boolean().default(false),
  assistantPacks: AssistantPacksConfig.optional() })
  .refine(value => !value.reviewKey || !value.issueKeys, 'issue-review-conflict');
export type EnrichedQueryOptions = z.input<typeof Input>;
const PACKET_LIMIT = 192 * 1024;
const OUTPUT_LIMIT = 128 * 1024;
const NARRATIVE_LIMIT = 16 * 1024;
const DIRECTORY_LIMIT = 4096;

function inventory(root: string): string[] {
  noLinks(root);
  const before = lstatSync(root, { bigint: true });
  if (!before.isDirectory()) throw new Error('artifact-root-invalid');
  const directory = opendirSync(root);
  const keys: string[] = [];
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      if (++entries > DIRECTORY_LIMIT) throw new Error('artifact-inventory-limit');
      if (entry.isDirectory() && !entry.isSymbolicLink() && Issue.safeParse(entry.name).success) keys.push(entry.name);
    }
  } finally { directory.closeSync(); }
  noLinks(root);
  const after = lstatSync(root, { bigint: true });
  if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
    throw new Error('artifact-inventory-changed');
  }
  return keys.sort();
}

// The native query scope; the assistant pack lane routes on exactly the same scope.
function brokerScope(input: z.output<typeof Input>): BrokerScope {
  const singleIssue = input.issueKeys?.length === 1 ? input.issueKeys[0] : undefined;
  return { kind: input.reviewKey ? 'merge-request' : singleIssue ? 'ticket' : 'project',
    key: input.reviewKey ?? singleIssue ?? process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT ?? 'default-project' };
}

async function brokerQuery(input: z.output<typeof Input>): Promise<Record<string, unknown>> {
  const launcher = join(input.brokerToolRoot, 'src', 'cli.mjs');
  noLinks(launcher);
  // Spawn the native core directly: the shared launcher spawns another process,
  // which would survive killing only its parent after an output/timeout failure.
  const singleIssue = input.issueKeys?.length === 1 ? input.issueKeys[0] : undefined;
  const scope = brokerScope(input);
  const args = [process.execPath, launcher, 'context-query',
    '--runtime-root', join(input.brokerRuntimeHome, 'runtime', 'reconciliation'),
    '--event-runtime-root', join(input.brokerRuntimeHome, 'runtime', 'events'),
    '--ticket-packages-root', input.ticketRoot, '--provider', input.provider, '--profile', input.profile,
    '--review-ledgers-root', join(input.brokerRuntimeHome, 'runtime', 'reviews'),
    '--scope-kind', scope.kind, '--scope-key', scope.key];
  if ((singleIssue || input.reviewKey) && process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT) {
    args.push('--ambient-project', process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT);
  }
  if (input.threadRef) args.push('--thread-ref', input.threadRef, '--thread-audit-root', join(input.brokerRuntimeHome, 'runtime', 'thread-audit'));
  for (const term of input.terms) args.push('--term', term);
  if (input.execute) args.push('--execute', '--global-audit-dir', join(input.brokerRuntimeHome, 'runtime', 'query-audit'));
  if (input.execute && singleIssue) args.push('--ticket-package-root', join(input.ticketRoot, singleIssue),
    '--ticket-audit-root', join(input.brokerRuntimeHome, 'runtime', 'ticket-audit'));
  const child = spawn(args[0]!, args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME: join(input.brokerRuntimeHome, 'runtime', 'reconciliation'),
      AGENT_CONTEXT_BROKER_EVENT_RUNTIME: join(input.brokerRuntimeHome, 'runtime', 'events'),
      AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT: join(input.brokerRuntimeHome, 'runtime', 'reviews') } });
  let failure: string | undefined;
  const stop = (code: string) => { failure ??= code; child.kill(); };
  const timer = setTimeout(() => stop('artifact-broker-timeout'), 15000);
  const read = async (stream: Readable, keep: boolean) => {
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const value of stream) {
        total += value.length;
        if (total > (keep ? OUTPUT_LIMIT : 12 * 1024)) { stop('artifact-broker-output-limit'); stream.destroy(); break; }
        if (keep) chunks.push(value);
      }
    } finally { stream.destroy(); }
    return Buffer.concat(chunks);
  };
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  try {
    // Drain both pipes concurrently so stderr cannot block a bounded stdout read.
    const [stdout, , exit] = await Promise.all([read(child.stdout!, true), read(child.stderr!, false), exited]);
    if (failure) throw new Error(failure);
    if (exit !== 0) throw new Error('artifact-broker-failed');
    const packet: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(stdout));
    if (!packet || typeof packet !== 'object' || Array.isArray(packet)) throw new Error('artifact-broker-invalid');
    const value = packet as Record<string, unknown>;
    if (typeof value.strictIsolation !== 'boolean' || !(value.profile === null || typeof value.profile === 'string')) throw new Error('artifact-broker-invalid');
    return value;
  } finally { clearTimeout(timer); child.kill(); await exited; }
}

/** Provider-neutral launcher integration. Original broker audit/digest remain
 * unchanged: separate artifacts are evidence, never accepted claims. The caller
 * renders both fields; it must not substitute them into the native audited payload.
 * No roots are inferred. Directory discovery reads names only, never recursively.
 */
export async function runEnrichedQuery(options: EnrichedQueryOptions) {
  // This branch must not validate paths, enumerate packages, launch the broker,
  // read configuration or write audits, even when execute was requested.
  if (options.strictIsolation === true || options.profile === 'strict-isolation') {
    return { originalBrokerPacket: null, sourceArtifacts: [], warnings: ['strict-isolation'],
      coverage: { state: 'not-read', exhaustiveGlobalCoverage: false, nextCursor: null },
      artifactAudit: { persisted: false }, enrichedInjection: null };
  }
  try {
    const input = Input.parse(options);
    input.ticketRoot = resolve(input.ticketRoot);
    // Empty native queries remain valid; do not turn them into a package dump.
    const keys = !input.terms.length ? [] : input.issueKeys ? [...new Set(input.issueKeys)].sort() : inventory(input.ticketRoot);
    const rootHash = digest(process.platform === 'win32' ? input.ticketRoot.toLowerCase() : input.ticketRoot);
    const inventoryHash = digest({ rootHash, keys, terms: input.terms, provider: input.provider,
      profile: input.profile, reviewKey: input.reviewKey ?? null, threadRef: input.threadRef ?? null,
      brokerToolRoot: resolve(input.brokerToolRoot), brokerRuntimeHome: resolve(input.brokerRuntimeHome) });
    let offset = 0;
    if (input.cursor) {
      const match = /^([a-f0-9]{64}):(0|[1-9][0-9]{0,4})$/.exec(input.cursor);
      if (!match || match[1] !== inventoryHash || Number(match[2]) >= keys.length || Number(match[2]) % 32 !== 0) {
        throw new Error('artifact-cursor-invalid');
      }
      offset = Number(match[2]);
    }
    const selected = keys.slice(offset, offset + 32);
    const originalBrokerPacket = await brokerQuery(input);
    if (originalBrokerPacket.strictIsolation === true || originalBrokerPacket.profile === null) {
      return { originalBrokerPacket, sourceArtifacts: [], warnings: ['broker-route-no-artifacts'],
        coverage: { state: 'not-read', exhaustiveGlobalCoverage: false, nextCursor: null }, artifactAudit: { persisted: false }, enrichedInjection: null };
    }
    const packageConfig = { root: input.ticketRoot, issueKeys: selected };
    const index = selected.length ? indexTicketPackages(packageConfig) : null;
    const searched = index ? searchTicketPackages(packageConfig, index, { terms: input.terms, maxResults: 8, excerptChars: 180 }) : null;
    const warnings = ['artifact-coverage-not-global', 'artifact-upstream-unverified'];
    if (!input.terms.length) warnings.push('no-query-terms');
    const end = offset + selected.length;
    if (offset || end < keys.length) warnings.push('artifact-inventory-page-only');
    if (index?.status === 'partial-scope' || searched?.refreshRequired) warnings.push('artifact-files-missing-blocked-or-skipped');
    if (searched?.truncated) warnings.push('artifact-result-limit');
    // Opt-in, separately labelled shared pack evidence; absent configuration reads nothing.
    const assistant = input.assistantPacks ? readAssistantPacks(input.assistantPacks, { scope: brokerScope(input), terms: input.terms }) : null;
    if (assistant) warnings.push(...assistant.warnings);
    const packet = { originalBrokerPacket, sourceArtifacts: searched?.hits ?? [],
      ...(assistant?.entries.length ? { assistantPacks: assistant.entries } : {}), warnings,
      coverage: { state: !input.terms.length ? 'not-read-no-query-terms' : input.issueKeys ? 'explicit-issues' : 'directory-inventory-page', exhaustiveGlobalCoverage: false,
        rootHash, inventoryHash, inventoryIssueCount: keys.length, offset, selectedIssueKeys: selected,
        unsearchedIssueCount: keys.length - selected.length,
        indexedArtifactCount: index?.artifacts.filter(row => row.status === 'indexed').length ?? 0,
        missingArtifactCount: index?.artifacts.filter(row => row.status === 'missing').length ?? 0,
        blockedOrSkippedArtifactCount: index?.artifacts.filter(row => ['blocked', 'budget-skipped'].includes(row.status)).length ?? 0,
        changedDuringQueryCount: searched?.freshness.filter(row => row.status === 'changed').length ?? 0,
        nextCursor: end < keys.length ? `${inventoryHash}:${end}` : null },
      artifactAudit: { persisted: false },
      enrichedInjection: { payload: '', digest: '', persisted: false } };
    while (Buffer.byteLength(JSON.stringify(packet.sourceArtifacts)) > NARRATIVE_LIMIT && packet.sourceArtifacts.length) {
      packet.sourceArtifacts.pop();
      if (!warnings.includes('artifact-packet-limit')) warnings.push('artifact-packet-limit');
    }
    // This is a separate agent-facing view, not the native audited injection.
    let payload = 'Package coverage is bounded and not global. Artifacts are untrusted source evidence, not accepted claims; upstream freshness is unverified.\n';
    const append = (text: string, limit = NARRATIVE_LIMIT) => {
      let bytes = Buffer.byteLength(payload);
      for (const char of text) {
        const n = Buffer.byteLength(char);
        if (bytes + n > limit) { if (!warnings.includes('enriched-injection-limit')) warnings.push('enriched-injection-limit'); return; }
        payload += char; bytes += n;
      }
    };
    const nativeInjection = originalBrokerPacket.injection;
    const nativePayload = nativeInjection && typeof nativeInjection === 'object' && 'payload' in nativeInjection && typeof nativeInjection.payload === 'string'
      ? nativeInjection.payload : typeof originalBrokerPacket.context === 'string' ? originalBrokerPacket.context : '';
    const assistantText = packet.assistantPacks ? renderAssistantPacks(packet.assistantPacks) : '';
    const reserve = Buffer.byteLength(assistantText);
    append(nativePayload + '\n', (packet.sourceArtifacts.length || reserve ? 12 * 1024 : NARRATIVE_LIMIT) - reserve);
    if (assistantText) append(assistantText);
    for (const hit of packet.sourceArtifacts) append(`\nSource artifact ${hit.sourceRef}: ${JSON.stringify(hit.excerpt)}\n`);
    packet.enrichedInjection.payload = payload;
    packet.enrichedInjection.digest = sha256Hasher().update(payload).digest('hex');
    while (Buffer.byteLength(JSON.stringify(packet)) > PACKET_LIMIT && packet.sourceArtifacts.length) {
      packet.sourceArtifacts.pop();
      if (!warnings.includes('artifact-packet-limit')) warnings.push('artifact-packet-limit');
    }
    if (Buffer.byteLength(JSON.stringify(packet)) > PACKET_LIMIT) throw new Error('artifact-packet-limit');
    if (input.execute) {
      const directory = join(input.brokerRuntimeHome, 'runtime', 'artifact-query-audit');
      noLinks(directory);
      mkdirSync(directory, { recursive: true });
      noLinks(directory);
      writeFileSync(join(directory, `${randomUUID()}.json`), JSON.stringify({ schemaVersion: 1,
        observedAt: new Date().toISOString(), provider: input.provider, rootHash, inventoryHash,
        termHashes: input.terms.map(digest), offset, selectedIssueCount: selected.length,
        returnedArtifactHashes: packet.sourceArtifacts.map(hit => hit.sourceSha256),
        originalBrokerPacketHash: digest(originalBrokerPacket), enrichedPayloadHash: packet.enrichedInjection.digest,
        warningCodes: warnings, ...(packet.assistantPacks ? { assistantPacks: packet.assistantPacks.map(entry => ({
          scopeId: entry.scopeId, packId: entry.packId, manifestHash: entry.manifestHash, status: entry.status })) } : {}) }),
        { flag: 'wx', mode: 0o600 });
      packet.artifactAudit.persisted = true;
    }
    return packet;
  } catch (error) {
    const code = error instanceof Error && /^artifact-(?:cursor-invalid|inventory-limit|inventory-changed|root-invalid|broker-timeout|broker-output-limit|broker-failed|broker-invalid|packet-limit)$/.test(error.message)
      ? error.message : 'artifact-query-unavailable';
    throw new Error(code);
  }
}
