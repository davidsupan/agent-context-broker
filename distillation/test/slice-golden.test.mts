import { afterEach, expect, test } from './expect.mts';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../src/sqlite.mts';
import { parseEvent } from '../src/transcript.mts';
import { buildSlices, canonical, CONTEXT_BOUNDARY } from '../src/slicing.mts';
import { modelOutputSchema, SliceSchema } from '../src/output.mts';
import { INSTRUCTIONS } from '../src/consumer.mts';
import { prepareProviderRequest } from '../src/provider.mts';
import { runCapture, sha256 } from '../src/capture.mts';
import { prepareSlices, verifyStoredSlice } from '../src/slice-queue.mts';

// Golden values were computed with the module BEFORE the document lane existed. Any
// change here means existing transcript slices would get new sliceId digests.
// The two schema hashes were re-pinned on 2026-10-07: the model output schema no longer
// carries coverage and disposition (runner-set since 2026-10-06/07). Slice ids, payloads
// and the provider input are unchanged.
const GOLDEN = {
  instructions: 'd353b68249dc260ffefcd5261c104cf0e4b18aee0d78e42cf6c428e4329e6115',
  'codex:128': { blocks: 5, planSha256: '90d749a3ece3956e795c447c2a4c6355adc4973aeb5fc93d130e68e13b627cc2',
    sliceIds: ['15ccf205b3d1a9d1c21ce9b1ebf134d01a376632f9b0b3839414b62b42068659', '1a2ceb2af61b89dc0ac6ef2719270a2cb00035d465adbb0b307298a657156d11',
      '9fd7c2264cf0f2d2aabf66d6fa4ec0aab6f382098f102e9b626364502c1d6adf', '539813137e9a18281864d2e070f780ca5cfe4088f5d3ae96fe4ed5d2e12fa250'],
    canonicalSha: ['b40949bb8e1429c941552ac7adee1c72ae110ea59594d8037a45317a39dcb20e', '5a911fe25c8e01805394ea2100c3a23ff4ed94cca0d1196b4b7c7d9c6e0e954e',
      '95b6d582ab0588beea9c8c9e614674e0e7a0a422ae00585fbdfe155bcd52840e', 'a9194390a95733f188a1d050438441ecb67a6e68c0acd8225f2dc8c135a58088'],
    outputSchemaSha: 'cbae8e257f07056d9455f63517ae69e005e6bac725d50776d0ed4ad859dee9a2',
    providerInputSha: '804e4d2e4387612784c68f569eac62b315239c2d8074510f041f49b30a5b0f1a',
    schemaTextSha: '226c0490bf007e9cbb7de89cd27dec63d84c2c3b539fe8f4f5af8fa305fb37a5',
    redactionKinds: { 'credential-assignment': 1, authorization: 1 } },
  'codex:16000': { blocks: 5, planSha256: '7ad68951aad85e132f3c390c718b9c6a43223abc46e7821ed9acd05864f03ffc',
    sliceIds: ['0f14ee4695e214ed15987135a4c75af79a6313028c11a6b5c14724c963eb728d'],
    canonicalSha: ['9d6da06ef7dd4952b97fcd25470d31c63e40453c47aeef1165d416953e4542c0'],
    outputSchemaSha: '2e8df133fbdde2ecc5f9acd856a2ae5f936c10a72edae28bb1fe545067128d1e',
    providerInputSha: 'ff3fb6e421e51f6027d597335b82e80bdb36a41349a829175f947c57747a2096',
    schemaTextSha: '59547c88583a6418eeb5320a756b8f78d529f5f91badce0480ea5b48dcc6b563',
    redactionKinds: { 'credential-assignment': 1, authorization: 1 } },
  'claude-code:128': { blocks: 3, planSha256: '48f788f7f97c5ec3d1b8a4b9060ab1d085ccdc72502ab4b408822a318365054e',
    sliceIds: ['68af38ab0fa9785ca167c61c4a734eeba36627a04268d001b3fe45e0cc9c25ca', '51f96ad109ec677569c13f907f3012da2694f8888efbeffa05df265ec9fc0687'],
    canonicalSha: ['f1ca54671420c7aca52a85ef50ed2b3689b166e25ee0bcdecc47277af2ed81ff', 'dd85d9cccd1ef1534b86bfbdeca7cf0036b9a8408be4c9732cde4b66143e9f02'],
    outputSchemaSha: '16e86a98dcbf9f954c1b130bd5b9a11d1a5d794a6d37a9471fdff0495d4e17eb',
    providerInputSha: 'b9808cf9961db7c75f043898936825bfe2059a1504d8382dd057b8e7338d31a3',
    schemaTextSha: '1800ea9b0dcfdfe7f698c75c7fb51dba972f2d2cb6702142fef80b30f1be7ee3',
    redactionKinds: { 'provider-token': 1 } },
  'claude-code:16000': { blocks: 3, planSha256: '98e54c8ba4889a066c0650ab355820e8e4b7e306e8f8182be206ccf4f6aebc84',
    sliceIds: ['5c2171e2eef40f2b466a0ae980266a5b2cc340376734ed318f9c42bf6e74f28c'],
    canonicalSha: ['258acfd34ce3070ff5a9b48315347b4e532c795090e6b6701e624bd3087886ae'],
    outputSchemaSha: '3c8f0541b1ab5e7033084798bc99ff0c22d0d2fcb1643a1742873f62fdb28506',
    providerInputSha: '12ecd9de203212dff9695c1897caaf327862c317ce6d04e35b5721422f71656e',
    schemaTextSha: 'fde4691018986cb34f091c64589c34aa9077bce68d4867cf4dd9dec83b1f3621',
    redactionKinds: { 'provider-token': 1 } }
} as const;
const FIXTURES = [['golden-codex.jsonl', 'codex'], ['golden-claude.jsonl', 'claude-code']] as const;
const fixturePath = (file: string) => fileURLToPath(new URL(`./fixtures/${file}`, import.meta.url));

function rows(file: string, provider: 'codex' | 'claude-code') {
  const raw = readFileSync(fixturePath(file));
  const out: Array<{ role: string | null; text: string }> = [];
  for (let offset = 0; offset < raw.length;) {
    const next = raw.indexOf(10, offset) + 1;
    const parsed = parseEvent(raw.subarray(offset, next), provider);
    for (const text of parsed.texts) out.push({ role: parsed.role, text: text.text });
    offset = next;
  }
  return out;
}

test('INSTRUCTIONS are unchanged; the live receipt pins them', () => {
  expect(sha256(INSTRUCTIONS)).toBe(GOLDEN.instructions);
});

test('real-format transcript slices keep their pinned sliceId digests, payloads and provider input', () => {
  for (const [file, provider] of FIXTURES) {
    const blocks = rows(file, provider);
    for (const maxChars of [128, 16000] as const) {
      const golden = GOLDEN[`${provider}:${maxChars}`];
      const plan = buildSlices(blocks, 'a'.repeat(64), 'b'.repeat(64), maxChars);
      expect(blocks).toHaveLength(golden.blocks);
      expect(plan.planSha256).toBe(golden.planSha256);
      expect(plan.slices.map(item => item.sliceId)).toEqual([...golden.sliceIds]);
      expect(plan.slices.map(item => sha256(canonical(item)))).toEqual([...golden.canonicalSha]);
      expect(plan.redactionKinds).toEqual(golden.redactionKinds);
      for (const item of plan.slices) {
        expect(item.contextBoundary).toBe(CONTEXT_BOUNDARY);
        // Parsing through the widened schema must not add, drop or reorder a byte.
        expect(canonical(SliceSchema.parse(JSON.parse(canonical(item))))).toBe(canonical(item));
      }
      const first = plan.slices[0]!;
      expect(sha256(JSON.stringify(modelOutputSchema(first)))).toBe(golden.outputSchemaSha);
      const request = prepareProviderRequest({ provider: 'claude', reason: 'primary', token: 'c'.repeat(32), jobName: `Local\\ACBCorpus-${'c'.repeat(32)}`,
        slice: first, outputSchema: modelOutputSchema(first), timeoutMs: 300000, instructions: INSTRUCTIONS });
      expect(sha256(request.input)).toBe(golden.providerInputSha);
      expect(sha256(request.schemaText)).toBe(golden.schemaTextSha);
    }
  }
});

const temp: string[] = [];
afterEach(() => { for (const root of temp.splice(0)) rmSync(root, { recursive: true, force: true }); });
test('captured real-format transcripts store canonical slices with or without disabled document sources', () => {
  const plans: unknown[] = [];
  for (const documentSources of [undefined, [{ id: 'docs', root: 'set-below', sensitivity: 'private' }]]) {
    const root = mkdtempSync(join(tmpdir(), 'acb-golden-')); temp.push(root);
    const codex = join(root, 'codex'), claude = join(root, 'claude'), home = join(root, 'home'), docs = join(root, 'docs');
    mkdirSync(codex); mkdirSync(claude); mkdirSync(docs);
    copyFileSync(fixturePath('golden-codex.jsonl'), join(codex, 'a.jsonl'));
    copyFileSync(fixturePath('golden-claude.jsonl'), join(claude, 'b.jsonl'));
    writeFileSync(join(docs, 'note.md'), '# Note\nnever read while disabled\n');
    const registry = JSON.stringify({ schemaVersion: 1, boundary: 'Historical path membership only. Evidence hashes identify metadata inputs, not verified transcript content or semantic coverage. No capture offset or skip authority.', entries: [] });
    writeFileSync(join(root, 'history.json'), registry);
    const config = { providerRoots: { codex, 'claude-code': claude }, historyRegistry: { path: join(root, 'history.json'), sha256: sha256(registry) }, reserveBytes: 1,
      ...(documentSources ? { documentSources: documentSources.map(source => ({ ...source, root: docs })) } : {}) };
    const result = runCapture(config, home, true);
    expect(result).toEqual({ state: 'complete-tick', processed: 2, errors: 0, legacyUnresolved: 0, fullyCurrent: false });
    while (prepareSlices(home, [], 128, true).state === 'prepared');
    using db = new Database(join(home, 'queue.sqlite3'), { readonly: true });
    const stored = db.query('SELECT * FROM slices ORDER BY job_id,ordinal').all() as Array<Record<string, string>>;
    for (const row of stored) {
      const item = verifyStoredSlice(row);
      expect(canonical(item)).toBe(row.payload_json!);
      expect(item.segments.every(segment => segment.role !== 'document')).toBe(true);
    }
    const names = (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name);
    expect(names.filter(name => name.startsWith('document_'))).toEqual([]);
    // Receipts carry a timestamp, so compare the receipt-independent payload content.
    plans.push(stored.map(row => { const { jobId: _, receiptSha256: __, sliceId: ___, ...rest } = JSON.parse(row.payload_json!); return rest; })
      .sort((a, b) => canonical(a) < canonical(b) ? -1 : 1));
  }
  expect(canonical(plans[1])).toBe(canonical(plans[0]));
});
