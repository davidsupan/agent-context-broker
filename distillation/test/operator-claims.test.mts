import { afterEach, expect, test } from './expect.mts';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/capture.mts';
import { addClaim, CLAIM_TYPE, claimProposal, listClaims, markPublished, ProposalClaimSchema, ProposalSchema, revokeClaim,
  PROJECT_SCOPE, type Proposal } from '../src/operator-claims.mts';

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function home() { const root = mkdtempSync(join(tmpdir(), 'acb-claims-')); roots.push(root); return join(root, 'home'); }

const TOKEN = `acb://source/${'a'.repeat(64)}`;
const T0 = new Date('2026-10-05T09:30:00.000Z');
const later = (days: number) => new Date(T0.getTime() + days * 86400000);
const base = { statement: 'Location statistics API contract unblocks frontend work before DDD.', kind: 'agreement',
  source: { channel: 'teams', occurredAt: '2026-10-03' }, confidence: 'confirmed' };
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return (error as Error).message; } return 'no-error'; };
let counter = 0;
const seq = () => (counter++).toString(16).padStart(6, '0');

test('add writes one immutable record and lists it newest first as current', () => {
  const h = home();
  const first = addClaim(h, base, T0);
  const second = addClaim(h, { ...base, kind: 'constraint', statement: 'Never touch the CI file as a side effect of a ticket.' }, later(0.01));
  expect(first.claimId).toMatch(/^CLM-20261005-[a-f0-9]{6}$/);
  expect(first.record).toEqual({ schemaVersion: 1, claimId: first.claimId, statement: base.statement, kind: 'agreement', scopes: [],
    source: { channel: 'teams', occurredAt: '2026-10-03', participants: [] }, recordedBy: 'operator',
    recordedAt: T0.toISOString(), confidence: 'confirmed', supersedes: [], status: 'active' });
  expect(JSON.parse(readFileSync(join(h, 'operator-claims', `${first.claimId}.json`), 'utf8'))).toEqual(first.record);
  const listed = listClaims(h, T0);
  expect(listed.schemaVersion).toBe(1);
  expect(listed.items.map(i => i.claimId)).toEqual([second.claimId, first.claimId]);
  expect(listed.items[1]).toEqual({ ...first.record, current: true, revoked: false, reviewDue: false, published: null });
  expect(listClaims(join(h, 'missing')).items).toEqual([]);
});

test('an id collision retries with a new suffix; the existing file is untouched', () => {
  const h = home();
  const ids = ['abc123', 'abc123', 'def456'];
  const first = addClaim(h, base, T0, () => ids.shift()!);
  const before = readFileSync(join(h, 'operator-claims', `${first.claimId}.json`), 'utf8');
  const second = addClaim(h, base, T0, () => ids.shift()!);
  expect([first.claimId, second.claimId]).toEqual(['CLM-20261005-abc123', 'CLM-20261005-def456']);
  expect(readFileSync(join(h, 'operator-claims', `${first.claimId}.json`), 'utf8')).toBe(before);
  expect(code(() => addClaim(h, base, T0, () => 'abc123'))).toBe('claims-id-contention');
});

test('revocation is a separate record, once only, and the claim file never changes', () => {
  const h = home();
  const { claimId } = addClaim(h, base, T0);
  const path = join(h, 'operator-claims', `${claimId}.json`);
  const before = readFileSync(path, 'utf8');
  expect(code(() => revokeClaim(h, claimId, { reason: 'short' }, later(1)))).toBe('claims-input-invalid');
  const revoked = revokeClaim(h, claimId, { reason: 'Superseded in the Monday planning meeting.' }, later(1));
  expect(revoked.revocation).toEqual({ schemaVersion: 1, revokes: claimId, reason: 'Superseded in the Monday planning meeting.',
    recordedBy: 'operator', recordedAt: later(1).toISOString() });
  expect(readFileSync(path, 'utf8')).toBe(before);
  expect(listClaims(h, later(1)).items[0]).toMatchObject({ current: false, revoked: true });
  expect(code(() => revokeClaim(h, claimId, { reason: 'A second revocation attempt.' }, later(2)))).toBe('claims-already-revoked');
  expect(code(() => revokeClaim(h, 'CLM-20261005-ffffff', { reason: 'Unknown claim revocation.' }))).toBe('claims-not-found');
  expect(code(() => revokeClaim(h, 'nope', { reason: 'Malformed claim revocation.' }))).toBe('claims-id-invalid');
});

test('supersession chain: a successor hides its predecessor until the successor is revoked', () => {
  const h = home();
  const old = addClaim(h, base, T0, seq);
  const next = addClaim(h, { ...base, statement: 'Location statistics: DDD is required only for live data.', supersedes: [old.claimId] }, later(1), seq);
  let items = listClaims(h, later(1)).items;
  expect(items.map(i => [i.claimId, i.current])).toEqual([[next.claimId, true], [old.claimId, false]]);
  expect(items[1]!.revoked).toBe(false);
  revokeClaim(h, next.claimId, { reason: 'The amendment was withdrawn by email.' }, later(2));
  items = listClaims(h, later(2)).items;
  expect(items.map(i => [i.claimId, i.current])).toEqual([[next.claimId, false], [old.claimId, true]]);
  expect(code(() => addClaim(h, { ...base, supersedes: ['CLM-20200101-000000'] }, T0))).toBe('claims-supersedes-unknown');
  expect(code(() => addClaim(h, { ...base, supersedes: [old.claimId, old.claimId] }, T0))).toBe('claims-input-invalid');
});

test('validUntil expires after its day; a passed reviewBy stays current but is due', () => {
  const h = home();
  const { claimId } = addClaim(h, { ...base, validUntil: '2026-10-07', reviewBy: '2026-10-06' }, T0);
  const at = (iso: string) => listClaims(h, new Date(iso)).items[0]!;
  expect(at('2026-10-06T12:00:00Z')).toMatchObject({ current: true, reviewDue: false });
  expect(at('2026-10-07T23:59:59Z')).toMatchObject({ current: true, reviewDue: true });
  expect(at('2026-10-08T00:00:00Z')).toMatchObject({ current: false, reviewDue: true, revoked: false });
  expect(code(() => claimProposal(h, claimId, TOKEN, new Date('2026-10-08T00:00:00Z')))).toBe('claims-not-current');
  expect(code(() => addClaim(h, { ...base, validUntil: '2026-10-02' }, T0))).toBe('claims-valid-until-invalid');
  expect(addClaim(h, { ...base, validUntil: '2026-10-03' }, T0).record.validUntil).toBe('2026-10-03');
});

test('text that redaction or broker content safety would change is refused', () => {
  const h = home();
  const refused = [
    { ...base, statement: 'Use password=hunter2secret for the shared QA account.' },
    { ...base, statement: 'Token glpat-abcdefghijklmnopqrstuv is fine to use.' },
    { ...base, statement: 'Send the export to someone@example.com every Monday.' },
    { ...base, statement: 'The share lives at C:\\shared\\exports on the desktop.' },
    { ...base, source: { ...base.source, participants: ['Alex', 'someone@example.com'] } },
    { ...base, source: { ...base.source, reference: 'https://x.test/a?token=abcdefghijklmnopqrstuvwxyz' } },
  ];
  for (const input of refused) expect(code(() => addClaim(h, input, T0))).toBe('claims-sensitive-text');
  expect(code(() => addClaim(h, { ...base, source: { ...base.source, reference: 'http://example.test/thread' } }, T0)))
    .toBe('claims-reference-invalid');
  const { claimId } = addClaim(h, { ...base, source: { ...base.source, reference: 'Re: Location statistics rollout',
    participants: ['Alex', 'Sam'] } }, T0);
  expect(code(() => revokeClaim(h, claimId, { reason: 'Withdrawn, see password=hunter2secret' }))).toBe('claims-sensitive-text');
  expect(readdirSync(join(h, 'operator-claims'))).toEqual([`${claimId}.json`]);
});

test('scopes follow the broker rules; assistant scopes have their own key rule', () => {
  const h = home();
  const ok = (scopes: unknown[]) => addClaim(h, { ...base, scopes }, T0).record.scopes;
  expect(ok([{ kind: 'ticket', key: 'EX-4' }, { kind: 'merge-request', key: 'example/main!101' },
    { kind: 'workstream', key: 'location-statistics' }, { kind: 'global', key: 'all' }, { kind: 'assistant-scope', key: 'daily-notes' }]))
    .toHaveLength(5);
  for (const scope of [{ kind: 'ticket', key: 'ex-123' }, { kind: 'ticket', key: 'EX123' }, { kind: 'merge-request', key: 'example/main#101' },
    { kind: 'merge-request', key: 'example/main' }, { kind: 'project', key: '-bad' }, { kind: 'assistant-scope', key: 'Daily Notes' }]) {
    expect(code(() => addClaim(h, { ...base, scopes: [scope] }, T0))).toBe('claims-scope-invalid');
  }
  expect(code(() => addClaim(h, { ...base, scopes: [{ kind: 'repo', key: 'x' }] }, T0))).toBe('claims-input-invalid');
  expect(code(() => addClaim(h, { ...base, scopes: [{ kind: 'ticket', key: 'EX-1' }, { kind: 'ticket', key: 'EX-1' }] }, T0)))
    .toBe('claims-scope-duplicate');
  expect(code(() => addClaim(h, { ...base, scopes: Array.from({ length: 9 }, (_, i) => ({ kind: 'ticket', key: `EX-${i + 1}` })) }, T0)))
    .toBe('claims-input-invalid');
});

test('proposal is exact, one per broker scope, and passes the strict schema mirror', () => {
  const h = home();
  const { claimId } = addClaim(h, { ...base, scopes: [{ kind: 'ticket', key: 'EX-4' }, { kind: 'assistant-scope', key: 'daily-notes' },
    { kind: 'merge-request', key: 'example/main!101' }], source: { ...base.source, participants: ['Alex', 'Sam'] } }, T0);
  const proposals = claimProposal(h, claimId, TOKEN, T0) as Proposal[];
  const claim: Proposal['claims'][number] = { claimKey: `operator.${claimId}`, claimType: 'decision', subject: 'operator-agreement', predicate: 'agreed-via-teams',
    value: `${base.statement} (with: Alex, Sam)`, observedAt: '2026-10-03T00:00:00Z', confidence: 0.9, sensitivity: 'private',
    evidenceClass: 'canonical-artifact', verification: 'verified',
    freshness: { policy: 'manual', verifiedAt: T0.toISOString(), expiresAt: null, sourceHeadHash: null },
    canonicalRefs: [`context://operator-claim/${claimId}`] };
  expect(proposals).toEqual([
    { schemaVersion: 1, proposalId: `operator-claim-${claimId}-1`, sourceToken: TOKEN, scope: { kind: 'ticket', key: 'EX-4' }, claims: [claim] },
    { schemaVersion: 1, proposalId: `operator-claim-${claimId}-2`, sourceToken: TOKEN, scope: { kind: 'merge-request', key: 'example/main!101' }, claims: [claim] },
  ]);
  for (const proposal of proposals) expect(ProposalSchema.parse(proposal)).toEqual(proposal);
  expect(code(() => ProposalSchema.parse({ ...proposals[0], extra: 1 }))).not.toBe('no-error');
  expect(code(() => claimProposal(h, claimId, 'acb://source/xyz'))).toBe('claims-source-token-invalid');

  // Empty scopes mean the whole project; tentative stays unverified at 0.6; validUntil becomes a ttl.
  const tentative = addClaim(h, { ...base, kind: 'correction', confidence: 'tentative', validUntil: '2026-10-31' }, T0);
  const single = claimProposal(h, tentative.claimId, TOKEN, T0) as Proposal;
  expect(single.scope).toEqual({ ...PROJECT_SCOPE });
  expect(single.proposalId).toBe(`operator-claim-${tentative.claimId}-1`);
  expect(single.claims[0]).toMatchObject({ claimType: 'risk', confidence: 0.6, verification: 'unverified', value: base.statement,
    freshness: { policy: 'ttl', verifiedAt: T0.toISOString(), expiresAt: '2026-11-01T00:00:00.000Z', sourceHeadHash: null } });
  const assistantOnly = addClaim(h, { ...base, scopes: [{ kind: 'assistant-scope', key: 'daily-notes' }] }, T0);
  expect(code(() => claimProposal(h, assistantOnly.claimId, TOKEN, T0))).toBe('claims-not-publishable');
  expect(CLAIM_TYPE).toEqual({ agreement: 'decision', decision: 'decision', constraint: 'procedure', correction: 'risk', fact: 'fact' });
});

test('the schema mirror matches the installed broker schema when it is present', () => {
  const path = join(homedir(), '.agent-context-broker', 'tool', 'schemas', 'context-publication-proposal.schema.json');
  if (!existsSync(path)) return;
  const schema = JSON.parse(readFileSync(path, 'utf8'));
  const item = schema.properties.claims.items;
  expect(Object.keys(ProposalSchema.shape).sort()).toEqual(Object.keys(schema.properties).sort());
  expect(Object.keys(ProposalClaimSchema.shape).sort()).toEqual(Object.keys(item.properties).sort());
  expect([...ProposalSchema.shape.scope.shape.kind.options]).toEqual(schema.properties.scope.properties.kind.enum);
  for (const field of ['claimType', 'sensitivity', 'evidenceClass', 'verification'] as const) {
    expect([...ProposalClaimSchema.shape[field].options]).toEqual(item.properties[field].enum);
  }
  expect(item.required.every((field: string) => field === 'value' || !ProposalClaimSchema.shape[field as 'claimKey'].isOptional())).toBe(true);
});

test('proposals are refused for revoked and superseded claims', () => {
  const h = home();
  const revoked = addClaim(h, base, T0, seq);
  revokeClaim(h, revoked.claimId, { reason: 'Retracted verbally the next day.' }, later(1));
  expect(code(() => claimProposal(h, revoked.claimId, TOKEN, later(1)))).toBe('claims-not-current');
  const old = addClaim(h, base, T0, seq);
  addClaim(h, { ...base, supersedes: [old.claimId] }, later(1), seq);
  expect(code(() => claimProposal(h, old.claimId, TOKEN, later(1)))).toBe('claims-not-current');
  expect(code(() => claimProposal(h, 'CLM-20261005-ffffff', TOKEN))).toBe('claims-not-found');
});

test('mark-published stores bounded receipts once, bound to the proposal order', () => {
  const h = home();
  const { claimId } = addClaim(h, { ...base, scopes: [{ kind: 'ticket', key: 'EX-1' }, { kind: 'workstream', key: 'stats' }] }, T0);
  const result = (state: string, extra: object = {}) => ({ state, acceptedClaimCount: state === 'clean' ? 1 : 0,
    snapshotHash: 'b'.repeat(64), mode: 'context-publication', issues: [], ...extra });
  expect(code(() => markPublished(h, claimId, result('clean'), later(1)))).toBe('claims-receipt-count');
  expect(code(() => markPublished(h, claimId, [result('clean'), result('blocked')], later(1)))).toBe('claims-receipt-not-recorded');
  expect(code(() => markPublished(h, claimId, [result('clean', { proposalIdHash: sha256('other') }), result('clean')], later(1))))
    .toBe('claims-receipt-mismatch');
  expect(code(() => markPublished(h, claimId, [{ state: 'clean' }, result('clean')], later(1)))).toBe('claims-receipt-invalid');
  const marked = markPublished(h, claimId, [result('clean', { proposalIdHash: sha256(`operator-claim-${claimId}-1`), eventId: 'c'.repeat(64) }),
    result('pending', { eventId: null })], later(1));
  expect(marked.published).toEqual({ state: 'pending', at: later(1).toISOString() });
  expect(JSON.parse(readFileSync(join(h, 'operator-claims', `${claimId}.published.json`), 'utf8'))).toEqual({ schemaVersion: 1, claimId,
    recordedAt: later(1).toISOString(), receipts: [
      { proposalId: `operator-claim-${claimId}-1`, state: 'clean', acceptedClaimCount: 1, snapshotHash: 'b'.repeat(64), eventId: 'c'.repeat(64) },
      { proposalId: `operator-claim-${claimId}-2`, state: 'pending', acceptedClaimCount: 0, snapshotHash: 'b'.repeat(64) }] });
  expect(code(() => markPublished(h, claimId, [result('clean'), result('clean')], later(2)))).toBe('claims-already-published');
  expect(listClaims(h, later(2)).items[0]!.published).toEqual({ state: 'pending', at: later(1).toISOString() });

  const single = addClaim(h, base, T0);
  expect(markPublished(h, single.claimId, result('clean'), later(1)).published).toEqual({ state: 'clean', at: later(1).toISOString() });
});

test('the CLI adds, lists, proposes, revokes and marks published as JSON', async () => {
  const h = home();
  const cli = fileURLToPath(new URL('../src/cli.mts', import.meta.url));
  const run = (args: string[], stdin?: unknown) => {
    const result = spawnSync(process.execPath, [cli, 'claims', ...args, '--home', h],
      { input: stdin === undefined ? undefined : Buffer.from(JSON.stringify(stdin)) });
    return { exitCode: result.status, json: JSON.parse(result.stdout.toString()) };
  };
  const added = run(['add'], base);
  expect(added).toMatchObject({ exitCode: 0, json: { state: 'recorded' } });
  const id = added.json.claimId as string;
  expect(run(['list']).json.items.map((i: { claimId: string }) => i.claimId)).toEqual([id]);
  expect(run(['proposal', '--id', id, '--source-token', TOKEN]).json.proposalId).toBe(`operator-claim-${id}-1`);
  expect(run(['mark-published', '--id', id], { state: 'clean', acceptedClaimCount: 1, snapshotHash: 'b'.repeat(64) }).json)
    .toMatchObject({ state: 'published' });
  expect(run(['revoke', '--id', id], { reason: 'Withdrawn during the standup call.' }).json).toMatchObject({ state: 'revoked' });
  expect(run(['proposal', '--id', id, '--source-token', TOKEN])).toEqual({ exitCode: 1,
    json: { state: 'unavailable', code: 'claims-not-current', fullyCurrent: false } });
  expect(run(['add'], { ...base, statement: 'Use password=hunter2secret here.' }).json.code).toBe('claims-sensitive-text');
});

// An assistant project's claims folder, written by the work assistant, read here only.
function assistantProject(records: Array<Record<string, unknown>>, revocations: Array<Record<string, unknown>> = []) {
  const root = mkdtempSync(join(tmpdir(), 'acb-claims-root-')); roots.push(root);
  const folder = join(root, 'claims'); mkdirSync(folder);
  writeFileSync(join(folder, 'README.md'), '# Claims\n');
  writeFileSync(join(folder, 'claim.schema.json'), '{}');
  writeFileSync(join(folder, 'revocation.schema.json'), '{}');
  for (const record of records) writeFileSync(join(folder, `${record.claimId}.json`), JSON.stringify(record));
  for (const revocation of revocations) writeFileSync(join(folder, `${revocation.revokes}.revocation.json`), JSON.stringify(revocation));
  return folder;
}
const external = (claimId: string, change: Record<string, unknown> = {}) => ({ schemaVersion: 1, claimId,
  statement: 'Tariff detail keeps the Figma order of sections.', kind: 'decision',
  scopes: [{ kind: 'assistant-scope', key: 'pricing' }, { kind: 'assistant-chapter', key: 'tariffs' }],
  source: { channel: 'meeting', occurredAt: '2026-10-02', participants: ['design owner'] },
  recordedBy: 'Jordan', recordedAt: '2026-10-05T08:00:00.000Z', confidence: 'confirmed', supersedes: [], status: 'active', ...change });

test('an external claims root is read as is, filtered by name, and never written', () => {
  const h = home();
  const folder = assistantProject([external('CLM-20261005-aaaaaa'),
    external('CLM-20261005-bbbbbb', { scopes: [], statement: 'Whole-project agreement recorded in the assistant.' })],
    [{ schemaVersion: 1, revokes: 'CLM-20261005-aaaaaa', reason: 'Replaced in the next design review.', recordedBy: 'Jordan',
      recordedAt: '2026-10-05T09:00:00.000Z' }])
  const before = readdirSync(folder).sort();
  const at = { home: h, claimsRoot: folder };
  const listed = listClaims(at, T0);
  expect(listed.items.map(i => [i.claimId, i.current, i.revoked, i.recordedBy])).toEqual([
    ['CLM-20261005-bbbbbb', true, false, 'Jordan'], ['CLM-20261005-aaaaaa', false, true, 'Jordan']]);
  expect(code(() => addClaim(at, base, T0))).toBe('claims-root-read-only');
  expect(code(() => revokeClaim(at, 'CLM-20261005-bbbbbb', { reason: 'Not allowed from here at all.' }, T0))).toBe('claims-root-read-only');
  // Assistant scopes and chapters never reach the broker; an empty list is the whole project.
  expect(code(() => claimProposal(at, 'CLM-20261005-aaaaaa', TOKEN, T0))).toBe('claims-not-current');
  const proposal = claimProposal(at, 'CLM-20261005-bbbbbb', TOKEN, T0) as Proposal;
  expect(proposal.scope).toEqual({ ...PROJECT_SCOPE });
  // Receipts for external claims go to our home, never into the project folder.
  markPublished(at, 'CLM-20261005-bbbbbb', { state: 'pending', acceptedClaimCount: 0, snapshotHash: null }, T0);
  expect(existsSync(join(h, 'operator-claims', 'CLM-20261005-bbbbbb.published.json'))).toBe(true);
  expect(readdirSync(folder).sort()).toEqual(before);
  expect(listClaims(at, T0).items[0]!.published).toMatchObject({ state: 'pending' });
});

test('a claim that only has assistant scopes or chapters is not publishable', () => {
  const h = home();
  const folder = assistantProject([external('CLM-20261005-cccccc')]);
  expect(code(() => claimProposal({ home: h, claimsRoot: folder }, 'CLM-20261005-cccccc', TOKEN, T0))).toBe('claims-not-publishable');
});

test('an external record with unsafe text is refused before a proposal is built', () => {
  const h = home();
  const folder = assistantProject([external('CLM-20261005-dddddd', { scopes: [],
    statement: 'Send the export to jordan.example@example.com every Friday.' })]);
  expect(code(() => claimProposal({ home: h, claimsRoot: folder }, 'CLM-20261005-dddddd', TOKEN, T0))).toBe('claims-sensitive-text');
});
