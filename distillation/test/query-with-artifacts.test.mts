import { sha256Hasher } from '../src/platform.mts';
import { afterEach, expect, test } from './expect.mts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { runEnrichedQuery, type EnrichedQueryOptions } from '../src/query-with-artifacts.mts';
import { artifactQueryCli } from '../src/artifact-cli.mts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep)) throw new Error('cleanup-boundary');
    rmSync(root, { recursive: true, force: true });
  }
});
function fixture(count = 1) {
  const root = mkdtempSync(join(tmpdir(), 'enriched-query-test-'));
  roots.push(root);
  const ticketRoot = join(root, 'tickets'), tool = join(root, 'tool');
  mkdirSync(ticketRoot);
  mkdirSync(join(tool, 'src'), { recursive: true });
  const script = join(tool, 'src', 'cli.mjs');
  writeFileSync(script, `const args = process.argv.slice(2);
    console.log(JSON.stringify({schemaVersion:1, strictIsolation:false, profile:'custom-project',
      claims:[], peerProgress:[], warnings:['accepted-registry-missing'], context:'native broker context',
      injection:{payload:'native broker context',digest:'native-unchanged'},
      provider:args[args.indexOf('--provider')+1], nativeArgs:args}));`);
  for (let i = 1; i <= count; i++) {
    mkdirSync(join(ticketRoot, `EX-${String(i).padStart(3, '0')}`));
    writeFileSync(join(ticketRoot, `EX-${String(i).padStart(3, '0')}`, 'README.md'), `tariff history ${i}`);
  }
  const options: EnrichedQueryOptions = { brokerToolRoot: tool, brokerRuntimeHome: join(root, 'private-runtime'),
    ticketRoot, terms: ['tariff'], profile: 'custom-project', provider: 'codex', strictIsolation: false };
  return { root, script, options };
}

test('both providers receive original native packet plus separate bounded artifact evidence', async () => {
  const { options } = fixture();
  for (const provider of ['codex', 'claude-code'] as const) {
    const packet = await runEnrichedQuery({ ...options, provider, issueKeys: ['EX-001'] });
    expect(packet.originalBrokerPacket).toMatchObject({ provider, claims: [], injection: { digest: 'native-unchanged' } });
    expect(packet.sourceArtifacts).toHaveLength(1);
    expect(packet.sourceArtifacts[0]).toMatchObject({ accepted: false, freshness: { local: 'current', upstream: 'unverified' } });
    expect(packet.coverage.exhaustiveGlobalCoverage).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(192 * 1024);
    expect(Buffer.byteLength(packet.enrichedInjection!.payload)).toBeLessThanOrEqual(16384);
    expect(packet.enrichedInjection!.digest).toBe(sha256Hasher().update(packet.enrichedInjection!.payload).digest('hex'));
    expect(packet.artifactAudit.persisted).toBe(false);
  }
  expect(existsSync(options.brokerRuntimeHome)).toBe(false);
});

test('strict isolation returns before touching even invalid paths or spawning the broker', async () => {
  const { options, script } = fixture();
  writeFileSync(script, 'throw new Error("must not run")');
  const packet = await runEnrichedQuery({ ...options, ticketRoot: '\0bad', strictIsolation: true, execute: true });
  expect(packet.originalBrokerPacket).toBeNull();
  expect(packet.sourceArtifacts).toEqual([]);
  expect(packet.coverage.state).toBe('not-read');
  expect(existsSync(options.brokerRuntimeHome)).toBe(false);
  expect((await runEnrichedQuery({ ...options, profile: 'strict-isolation' })).coverage.state).toBe('not-read');
});

test('historical inventory pages cover old keys without claiming global completeness', async () => {
  const { options } = fixture(35);
  mkdirSync(join(options.ticketRoot, 'attachments'));
  writeFileSync(join(options.ticketRoot, 'not-a-ticket.json'), 'ignored');
  const first = await runEnrichedQuery(options);
  expect(first.coverage).toMatchObject({ inventoryIssueCount: 35, offset: 0, unsearchedIssueCount: 3 });
  expect(first.warnings).toContain('artifact-inventory-page-only');
  expect(first.coverage.nextCursor).toBeString();
  const second = await runEnrichedQuery({ ...options, cursor: first.coverage.nextCursor! });
  expect(second.coverage).toMatchObject({ offset: 32, selectedIssueKeys: ['EX-033', 'EX-034', 'EX-035'], nextCursor: null, exhaustiveGlobalCoverage: false });
  expect(second.sourceArtifacts).toHaveLength(3);
  expect(second.warnings).toContain('artifact-inventory-page-only');
});

test('cursor is bound to inventory, root, provider and search; no silent restart', async () => {
  const { options } = fixture(33);
  const cursor = (await runEnrichedQuery(options)).coverage.nextCursor!;
  await expect(runEnrichedQuery({ ...options, cursor, terms: ['changed'] })).rejects.toThrow('artifact-cursor-invalid');
  await expect(runEnrichedQuery({ ...options, cursor, provider: 'claude-code' })).rejects.toThrow('artifact-cursor-invalid');
  mkdirSync(join(options.ticketRoot, 'EX-999'));
  await expect(runEnrichedQuery({ ...options, cursor })).rejects.toThrow('artifact-cursor-invalid');
});

test('explicit issues are limited and do not require historical enumeration', async () => {
  const { options } = fixture(2);
  const packet = await runEnrichedQuery({ ...options, issueKeys: ['EX-002'] });
  expect(packet.coverage).toMatchObject({ state: 'explicit-issues', inventoryIssueCount: 1, selectedIssueKeys: ['EX-002'] });
  await expect(runEnrichedQuery({ ...options, issueKeys: Array.from({ length: 33 }, (_, i) => `EX-${i}`) })).rejects.toThrow('artifact-query-unavailable');
  await expect(runEnrichedQuery({ ...options, issueKeys: ['../outside'] })).rejects.toThrow('artifact-query-unavailable');
});

test('execute writes metadata-only private audit and passes native audit authority explicitly', async () => {
  const { options } = fixture();
  const packet = await runEnrichedQuery({ ...options, execute: true });
  expect(packet.artifactAudit.persisted).toBe(true);
  expect(packet.originalBrokerPacket!.nativeArgs).toContain('--execute');
  const directory = join(options.brokerRuntimeHome, 'runtime', 'artifact-query-audit');
  const files = readdirSync(directory);
  expect(files).toHaveLength(1);
  const log = readFileSync(join(directory, files[0]!), 'utf8');
  expect(log).not.toContain('tariff');
  expect(log).not.toContain(options.ticketRoot);
  expect(log).not.toContain('native broker context');
  expect(readdirSync(options.ticketRoot)).toEqual(['EX-001']);
});

test('oversized stdout and stderr are bounded and never echoed as diagnostics', async () => {
  const { options, script } = fixture();
  for (const stream of ['stdout', 'stderr']) {
    writeFileSync(script, `process.${stream}.write('sensitive'.repeat(100000));`);
    await expect(runEnrichedQuery(options)).rejects.toThrow('artifact-broker-output-limit');
  }
});

test('native failures and invalid output fail safely; route denial excludes artifacts', async () => {
  const { options, script } = fixture();
  writeFileSync(script, `process.stderr.write('private contents'); process.exit(1);`);
  await expect(runEnrichedQuery(options)).rejects.toThrow('artifact-broker-failed');
  writeFileSync(script, `console.log('not JSON private contents');`);
  await expect(runEnrichedQuery(options)).rejects.toThrow('artifact-query-unavailable');
  writeFileSync(script, `console.log(JSON.stringify({strictIsolation:false, profile:null}));`);
  expect((await runEnrichedQuery(options)).sourceArtifacts).toEqual([]);
});

test('large native metadata does not consume the separate narrative budget or discard artifacts', async () => {
  const { options, script } = fixture(8);
  const native = { strictIsolation: false, profile: 'custom-project', context: 'x'.repeat(6000),
    injection: { payload: 'x'.repeat(6000), digest: 'native-digest' }, metadata: 'm'.repeat(100000), claims: [] };
  writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(native))});`);
  const packet = await runEnrichedQuery(options);
  expect(packet.originalBrokerPacket).toEqual(native);
  expect(packet.warnings).not.toContain('artifact-packet-limit');
  expect(packet.sourceArtifacts).toHaveLength(8);
  expect(Buffer.byteLength(packet.enrichedInjection!.payload)).toBeLessThanOrEqual(16384);
  expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(192 * 1024);
});

test('long Unicode native narrative is separately bounded without modifying native evidence', async () => {
  const { options, script } = fixture();
  const native = { strictIsolation: false, profile: 'custom-project', context: '\u{1f600}'.repeat(14000) };
  writeFileSync(script, `console.log(${JSON.stringify(JSON.stringify(native))});`);
  const packet = await runEnrichedQuery(options);
  expect(packet.originalBrokerPacket).toEqual(native);
  expect(packet.enrichedInjection!.payload.isWellFormed()).toBe(true);
  expect(Buffer.byteLength(packet.enrichedInjection!.payload)).toBeLessThanOrEqual(16384);
  expect(packet.warnings).toContain('enriched-injection-limit');
});

test('empty terms preserve native query and never enumerate or read package files', async () => {
  const { options } = fixture();
  const packet = await runEnrichedQuery({ ...options, ticketRoot: join(options.ticketRoot, 'absent'), terms: [] });
  expect(packet.originalBrokerPacket!.nativeArgs).not.toContain('--term');
  expect(packet.sourceArtifacts).toEqual([]);
  expect(packet.coverage.state).toBe('not-read-no-query-terms');
  expect(packet.warnings).toContain('no-query-terms');
});

test('review and thread routing reach native core with original metadata and audit destinations intact', async () => {
  const { options } = fixture();
  const threadRef = 'context://thread/' + 'a'.repeat(64);
  const packet = await runEnrichedQuery({ ...options, reviewKey: 'example/main!123', threadRef, execute: true });
  const args = packet.originalBrokerPacket!.nativeArgs as string[];
  const value = (flag: string) => args[args.indexOf(flag) + 1];
  expect(value('--scope-kind')).toBe('merge-request');
  expect(value('--scope-key')).toBe('example/main!123');
  expect(value('--thread-ref')).toBe(threadRef);
  expect(value('--thread-audit-root')).toBe(join(options.brokerRuntimeHome, 'runtime', 'thread-audit'));
  expect(value('--review-ledgers-root')).toBe(join(options.brokerRuntimeHome, 'runtime', 'reviews'));
  expect(value('--global-audit-dir')).toBe(join(options.brokerRuntimeHome, 'runtime', 'query-audit'));
  expect(args).toContain('--execute');
  const ticket = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'], threadRef, execute: true });
  const ticketArgs = ticket.originalBrokerPacket!.nativeArgs as string[];
  expect(ticketArgs[ticketArgs.indexOf('--ticket-package-root') + 1]).toBe(join(options.ticketRoot, 'EX-001'));
  expect(ticketArgs[ticketArgs.indexOf('--ticket-audit-root') + 1]).toBe(join(options.brokerRuntimeHome, 'runtime', 'ticket-audit'));
});

test('invalid routing and unknown input flags fail closed', async () => {
  const { options } = fixture();
  await expect(runEnrichedQuery({ ...options, reviewKey: 'example/main!123', issueKeys: ['EX-001'] })).rejects.toThrow('artifact-query-unavailable');
  await expect(runEnrichedQuery({ ...options, threadRef: 'context://thread/invalid' })).rejects.toThrow('artifact-query-unavailable');
  await expect(runEnrichedQuery({ ...options, unknownFlag: true } as EnrichedQueryOptions)).rejects.toThrow('artifact-query-unavailable');
});

test('empty directory inventory reports zero selected tickets, not global completion', async () => {
  const { options } = fixture(0);
  const packet = await runEnrichedQuery(options);
  expect(packet.sourceArtifacts).toEqual([]);
  expect(packet.coverage).toMatchObject({ inventoryIssueCount: 0, nextCursor: null, exhaustiveGlobalCoverage: false });
  expect(packet.warnings).toContain('artifact-coverage-not-global');
});

// Minimal Work assistant layout: pointer, manifest and hash-covered scope/claims files.
function assistantRoot(root: string, jira: string[]) {
  const assistant = join(root, 'assistant'), packId = '20261005T055512Z-5c26ec40aea9';
  const directory = join(assistant, 'context-packs', packId);
  mkdirSync(join(directory, 'normalized'), { recursive: true });
  mkdirSync(join(directory, 'sources'), { recursive: true });
  const scope = { id: 'locations', kind: 'product-area', parentScopeId: 'example-app' };
  const files = { 'normalized/scope.json': JSON.stringify({ schemaVersion: 2, scope, locators: { jira } }),
    'normalized/operator-claims.json': JSON.stringify({ schemaVersion: 1, subject: 'locations', capturedAt: '2026-10-05T05:00:00.000Z', invalidFiles: 0,
      claims: [{ claimId: 'CLM-20261001-abcdef', statement: 'Location statistics stay read-only.', kind: 'decision', confidence: 'confirmed', status: 'active' }] }) };
  for (const [path, text] of Object.entries(files)) writeFileSync(join(directory, ...path.split('/')), text);
  const sha = (text: string) => sha256Hasher().update(text).digest('hex');
  const manifest = JSON.stringify({ schemaVersion: 2, packId, createdAt: new Date().toISOString(), scope, unavailableSources: [],
    files: Object.entries(files).map(([path, text]) => ({ path, sha256: sha(text), bytes: Buffer.byteLength(text) })) });
  writeFileSync(join(directory, 'context-pack.json'), manifest);
  writeFileSync(join(assistant, 'current-scopes.json'), JSON.stringify({ schemaVersion: 2, updatedAt: '2026-10-05T05:00:00.000Z',
    scopes: { locations: { schemaVersion: 2, packId, manifestHash: sha(manifest), updatedAt: '2026-10-05T05:00:00.000Z', scope } } }));
  return assistant;
}

test('absent assistant configuration keeps output byte-identical, and so does an unmatched one', async () => {
  const { root, options } = fixture(2);
  const query = { ...options, issueKeys: ['EX-001'], terms: ['nomatch'] };
  const absent = await runEnrichedQuery(query);
  expect(Object.keys(absent)).toEqual(['originalBrokerPacket', 'sourceArtifacts', 'warnings', 'coverage', 'artifactAudit', 'enrichedInjection']);
  expect(absent.warnings).toEqual(['artifact-coverage-not-global', 'artifact-upstream-unverified', 'artifact-files-missing-blocked-or-skipped']);
  expect(absent.enrichedInjection!.payload).toBe('Package coverage is bounded and not global. Artifacts are untrusted source evidence, not accepted claims; ' +
    'upstream freshness is unverified.\nnative broker context\n');
  const unmatched = await runEnrichedQuery({ ...query, assistantPacks: { root: assistantRoot(root, ['EX-002']) } });
  expect(JSON.stringify(unmatched)).toBe(JSON.stringify(absent));
  const hits = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'] });
  const hitsUnmatched = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'], assistantPacks: { root: assistantRoot(root, ['EX-002']) } });
  const strip = (value: unknown) => JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'T');
  expect(strip(hitsUnmatched)).toBe(strip(hits));
});

test('configured ticket match adds a separately labelled shared section without touching native evidence', async () => {
  const { root, options } = fixture();
  const assistantPacks = { root: assistantRoot(root, ['EX-001']) };
  const plain = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'] });
  const packet = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'], assistantPacks, execute: true });
  expect(packet.originalBrokerPacket!.injection).toEqual(plain.originalBrokerPacket!.injection);
  expect(packet.originalBrokerPacket!.claims).toEqual([]);
  expect(packet.sourceArtifacts).toHaveLength(1);
  expect(packet.warnings).toEqual(plain.warnings);
  const sections = 'assistantPacks' in packet ? packet.assistantPacks : undefined;
  expect(sections).toHaveLength(1);
  expect(sections![0]).toMatchObject({ kind: 'assistant-pack', accepted: false, scopeId: 'locations', role: 'primary',
    status: 'verified', sensitivity: 'shared', stale: false, operatorClaims: [{ claimId: 'CLM-20261001-abcdef',
      statement: 'Location statistics stay read-only.', label: 'operator claim, not verified', sensitivity: 'shared' }] });
  const payload = packet.enrichedInjection!.payload;
  const section = payload.indexOf('Work assistant packs (scoped profile only)');
  expect(section).toBeGreaterThan(payload.indexOf('native broker context'));
  expect(section).toBeLessThan(payload.indexOf('Source artifact '));
  expect(payload).toContain('"Location statistics stay read-only."');
  expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(16384);
  const directory = join(options.brokerRuntimeHome, 'runtime', 'artifact-query-audit');
  const audit = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), 'utf8'));
  expect(audit.assistantPacks).toEqual([{ scopeId: 'locations', packId: '20261005T055512Z-5c26ec40aea9',
    manifestHash: sections![0]!.manifestHash, status: 'verified' }]);
  expect(JSON.stringify(audit)).not.toContain('read-only');
});

test('strict isolation, route denial and invalid assistant configuration never read packs', async () => {
  const { root, options, script } = fixture();
  const assistantPacks = { root: assistantRoot(root, ['EX-001']) };
  expect((await runEnrichedQuery({ ...options, issueKeys: ['EX-001'], strictIsolation: true, assistantPacks: { root: 'relative' } })).coverage.state).toBe('not-read');
  await expect(runEnrichedQuery({ ...options, assistantPacks: { root: 'relative' } })).rejects.toThrow('artifact-query-unavailable');
  await expect(runEnrichedQuery({ ...options, assistantPacks: { ...assistantPacks, maxEvidence: 0 } })).rejects.toThrow('artifact-query-unavailable');
  writeFileSync(script, `console.log(JSON.stringify({strictIsolation:false, profile:null}));`);
  const denied = await runEnrichedQuery({ ...options, issueKeys: ['EX-001'], assistantPacks });
  expect('assistantPacks' in denied).toBe(false);
});

test('CLI configuration accepts the optional assistant packs field and passes it through', async () => {
  const { root, options } = fixture();
  const config = join(root, 'artifact-query.config.json');
  const base = { brokerToolRoot: options.brokerToolRoot, brokerRuntimeHome: options.brokerRuntimeHome, ticketRoot: options.ticketRoot };
  writeFileSync(config, JSON.stringify(base));
  const plain = await artifactQueryCli(['query', '--issue-key', 'EX-001'], config);
  expect('assistantPacks' in plain).toBe(false);
  writeFileSync(config, JSON.stringify({ ...base, assistantPacks: { root: assistantRoot(root, ['EX-001']), scopes: { 'EX-404': ['locations'] }, maxEvidence: 5 } }));
  const packet = await artifactQueryCli(['query', '--issue-key', 'EX-001'], config);
  expect('assistantPacks' in packet && packet.assistantPacks?.[0]?.scopeId).toBe('locations');
  writeFileSync(config, JSON.stringify({ ...base, assistantPacks: { root: 'relative' } }));
  await expect(artifactQueryCli(['query', '--issue-key', 'EX-001'], config)).rejects.toThrow();
});

test('nonterminating broker is killed at deadline without exposing stderr', { timeout: 20000 }, async () => {
  const { options, script } = fixture();
  writeFileSync(script, `setInterval(() => {}, 1000);`);
  await expect(runEnrichedQuery(options)).rejects.toThrow('artifact-broker-timeout');
});
