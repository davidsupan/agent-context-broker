import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { HashSchema, TokenSchema } from './schemas.mts';
import { noLinks, openStore } from './store.mts';
import { sha256 } from './capture.mts';
import { checkedDialogue, verifyStoredSlice } from './slice-queue.mts';
import { buildSlices, canonical, digest } from './slicing.mts';
import { validateOutput } from './output.mts';
import { reviewGate, type ReviewGate } from './review.mts';
import { checkedDocument, documentSensitivity, type DocumentSourceConfig } from './documents.mts';

export const BrokerConfig = z.strictObject({ toolRoot: z.string(), claimsRoot: z.string(), eventsRoot: z.string() });
export type BrokerTransport = (input: { attestation: unknown; candidate: unknown }, config: z.infer<typeof BrokerConfig>) => Promise<unknown>;
const PendingProof = z.object({ state: z.literal('pending'), acceptedClaimCount: z.literal(0), snapshotHash: z.null(), automaticRetryAllowed: z.literal(false) });

export const pendingBrokerTransport: BrokerTransport = async (input, config) => {
  for (const path of Object.values(config)) { if (!isAbsolute(path)) throw new Error('absolute-broker-path-required'); noLinks(path); }
  const load = async (name: string) => import(pathToFileURL(join(config.toolRoot, 'src', name)).href);
  const { attestSource } = await load('source-attestation.mjs');
  const { planContextPublication, publishContext } = await load('context-publish.mjs');
  const { verifyEventStore } = await load('event-store.mjs');
  const attestation = z.object({ provider: z.enum(['codex', 'claude-code']) }).passthrough().parse(input.attestation);
  const candidate = z.object({ proposalId: z.string() }).passthrough().parse(input.candidate);
  const source = z.object({ subjectRef: z.string().regex(/^acb:\/\/source\/[a-f0-9]{64}$/u) }).parse(
    await attestSource({ runtimeRoot: config.eventsRoot, execute: true, attestation }));
  const options = { runtimeRoot: config.claimsRoot, eventRuntimeRoot: config.eventsRoot,
    provider: attestation.provider, proposal: { ...candidate, sourceToken: source.subjectRef } };
  PendingProof.parse(planContextPublication(options));
  const receipt = PendingProof.parse(await publishContext({ ...options, execute: true }));
  verifyEventStore({ runtimeRoot: config.eventsRoot });
  return { ...receipt, sourceToken: source.subjectRef, proposalId: candidate.proposalId };
};

// Only reviewed results leave the corpus: an attempt is publishable once every observation
// has a final accept or reject bound to its output hash, and only accepted ones become claims.
function reviewedCount(outputJson: unknown) {
  try { return z.object({ observations: z.array(z.unknown()) }).parse(JSON.parse(String(outputJson))).observations.length; }
  catch { return -1; }
}

export async function publishPending(home: string, policy: { excludedSources?: string[]; sliceChars?: number },
  broker: unknown, execute = false, transport: BrokerTransport = pendingBrokerTransport, review: ReviewGate = reviewGate(home),
  documents: DocumentSourceConfig[] = []) {
  const excluded = new Set((policy.excludedSources ?? []).map(s => s.normalize('NFC').toLowerCase()));
  using db = openStore(join(home, 'queue.sqlite3'), { readonly: !execute });
  const tables = new Set(z.array(z.object({ name: z.string() })).parse(db.query("SELECT name FROM sqlite_master WHERE type='table'").all()).map(r => r.name));
  if (!tables.has('semantic_attempts') || !tables.has('slices')) return { state: 'idle', writes: false, accepted: false };
  const published = tables.has('broker_publications') ? 'AND NOT EXISTS(SELECT 1 FROM broker_publications p WHERE p.attempt_token=a.token AND p.output_sha256=a.output_sha256)' : '';
  const statement = db.prepare(`SELECT j.*,s.provider,s.relative_path,w.id AS slice_id,w.ordinal,w.payload_json,w.payload_sha,
    a.token,a.output_json,a.output_sha256,a.finished_at,a.provider AS model_provider
    FROM semantic_attempts a JOIN jobs j ON j.id=a.job_id JOIN sources s ON s.key=j.source_key
    JOIN slices w ON w.id=a.slice_id AND w.job_id=j.id
    WHERE a.state='pending-review' AND w.state='pending-review' ${published} ORDER BY a.finished_at,a.token LIMIT 1000`);
  let selected: Record<string, unknown> | undefined;
  try {
    for (const value of statement.iterate()) {
      const row = z.record(z.string(), z.unknown()).parse(value);
      if (excluded.has(`${row.provider}:${row.relative_path}`.normalize('NFC').toLowerCase())) continue;
      const count = reviewedCount(row.output_json);
      if (count < 0 || !review(String(row.token), String(row.output_sha256), count).complete) continue;
      selected = row; break;
    }
  } finally { statement.finalize(); }
  // Document results of enabled sources publish after transcripts, under their own scope and sensitivity.
  const enabled = new Map(documents.filter(source => source.enabled).map(source => [source.id, source]));
  let source: DocumentSourceConfig | undefined;
  if (!selected && enabled.size && tables.has('document_jobs')) {
    const documentStatement = db.prepare(`SELECT d.*,f.source_id,f.relative_path,w.id AS slice_id,w.ordinal,w.payload_json,w.payload_sha,
      a.token,a.output_json,a.output_sha256,a.finished_at,a.provider AS model_provider
      FROM semantic_attempts a JOIN document_jobs d ON d.id=a.job_id JOIN document_files f ON f.key=d.file_key
      JOIN slices w ON w.id=a.slice_id AND w.job_id=d.id
      WHERE a.state='pending-review' AND w.state='pending-review' ${published} ORDER BY a.finished_at,a.token LIMIT 1000`);
    try {
      for (const value of documentStatement.iterate()) {
        const row = z.record(z.string(), z.unknown()).parse(value);
        const candidate = enabled.get(String(row.source_id));
        const count = reviewedCount(row.output_json);
        if (!candidate || count < 0 || !review(String(row.token), String(row.output_sha256), count).complete) continue;
        selected = row; source = candidate; break;
      }
    } finally { documentStatement.finalize(); }
  }
  if (!selected) return { state: 'idle', writes: false, accepted: false };
  const row = selected;
  const token = TokenSchema.parse(row.token), jobId = HashSchema.parse(row.id);
  if (tables.has('broker_publications') && db.query('SELECT 1 FROM broker_publications WHERE attempt_token=?').get(token)) {
    throw new Error('publication-output-changed');
  }
  const outputJson = z.string().max(1024 * 1024).parse(row.output_json);
  if (Buffer.byteLength(outputJson) > 1024 * 1024 || sha256(outputJson) !== HashSchema.parse(row.output_sha256)) throw new Error('output-integrity');
  const item = verifyStoredSlice({ ...row, id: row.slice_id, job_id: jobId });
  // Source job may now be pending-review; provenance checks still use its original pending contract.
  const rebuilt = buildSlices(source ? checkedDocument(home, { ...row, state: 'pending' }) : checkedDialogue(home, { ...row, state: 'pending' }),
    jobId, row.receipt_hash, policy.sliceChars ?? 16000);
  if (canonical(rebuilt.slices[item.index]) !== canonical(item)) throw new Error('slice-source-changed');
  const checked = validateOutput(JSON.parse(outputJson), item);
  const reviewed = review(token, HashSchema.parse(row.output_sha256), checked.result.observations.length);
  if (!reviewed.complete) throw new Error('publication-review-changed');
  const acceptedIndexes = new Set(reviewed.accepted);
  const identity = digest(checked.result);
  const observedAt = new Date(z.number().finite().nonnegative().parse(row.finished_at) * 1000).toISOString();
  const kinds = { decision: 'decision', constraint: 'fact', correction: 'risk', failure: 'risk', verification: 'result', 'open-question': 'question' } as const;
  // Shared only when the source is shared, publication is allowed and the private floor does not apply.
  const sensitivity = source ? documentSensitivity(source, home) : 'private';
  const scopeKey = source ? `corpus-documents-${source.id}` : 'private-corpus-distillation';
  const candidate = { schemaVersion: 1, proposalId: `corpus-${identity}`,
    scope: { kind: 'workstream', key: scopeKey },
    claims: checked.result.observations.flatMap((observation, index) => acceptedIndexes.has(index) ? [{ claimKey: `corpus.${identity}.${index}`,
      claimType: kinds[observation.kind], subject: source ? 'workbench-document' : 'historical-dialogue', predicate: `unverified-${observation.kind}`,
      value: observation.summary, observedAt, confidence: 0.5, sensitivity, evidenceClass: 'agent-handoff',
      verification: 'unverified', canonicalRefs: [`context://corpus/slice/${item.sliceId}`] }] : []) };
  if (!execute) return { state: 'plan', writes: false, accepted: false, claimCount: candidate.claims.length };
  const inventory = { schemaVersion: 1, sourceReceiptSha256: row.receipt_hash, slicePayloadSha256: row.payload_sha, outputSha256: row.output_sha256 };
  let receipt: unknown = { state: 'no-findings', acceptedClaimCount: 0 };
  if (candidate.claims.length) {
    const config = BrokerConfig.parse(broker);
    const model = z.enum(['claude', 'codex']).parse(row.model_provider);
    const attestation = { schemaVersion: 1, provider: model === 'claude' ? 'claude-code' : 'codex',
      sessionKey: source ? sha256(`corpus-document:${row.file_key}`) : sha256(`corpus-source:${row.source_key}`), recordKey: sha256(`corpus-slice:${item.sliceId}`),
      sourceHash: row.output_sha256, inventoryHash: sha256(canonical(inventory)), observedAt,
      scope: { kind: 'workstream', keyHash: sha256(scopeKey) }, sensitivity };
    const response = await transport({ attestation, candidate }, config);
    receipt = PendingProof.extend({ proposalId: z.literal(candidate.proposalId), sourceToken: z.string().regex(/^acb:\/\/source\/[a-f0-9]{64}$/u) }).parse(response);
  }
  db.run(`CREATE TABLE IF NOT EXISTS broker_publications(attempt_token TEXT PRIMARY KEY,output_sha256 TEXT NOT NULL,state TEXT NOT NULL,inventory_json TEXT NOT NULL,receipt_json TEXT NOT NULL)`);
  db.transaction(() => {
    const current = z.object({ output_sha256: HashSchema }).parse(db.query("SELECT output_sha256 FROM semantic_attempts WHERE token=? AND state='pending-review'").get(token));
    if (current.output_sha256 !== row.output_sha256) throw new Error('attempt-changed-after-publication');
    const old = db.query('SELECT output_sha256 FROM broker_publications WHERE attempt_token=?').get(token);
    if (old && z.object({ output_sha256: HashSchema }).parse(old).output_sha256 !== row.output_sha256) throw new Error('publication-output-changed');
    db.query('INSERT OR IGNORE INTO broker_publications VALUES(?,?,?,?,?)').run(token, current.output_sha256,
      candidate.claims.length ? 'pending' : 'no-findings', canonical(inventory), canonical(receipt));
  }).immediate();
  return { state: candidate.claims.length ? 'pending' : 'no-findings', writes: true, accepted: false, claimCount: candidate.claims.length };
}
