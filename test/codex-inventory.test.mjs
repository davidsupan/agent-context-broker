import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  planInventory,
  readSourceIdentity,
  readRelatedDeltas,
  runInventory
} from '../src/codex-inventory-v2.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(packageRoot, 'fixtures');
const temporaryRoots = [];

function tempRoot(name) {
  const root = join(tmpdir(), `agent-context-broker-${name}-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function outputPaths(root) {
  return {
    output: join(root, 'inventory.json'),
    deltas: join(root, 'deltas.jsonl'),
    checkpoint: join(root, 'checkpoint.json'),
    ledgerDir: join(root, 'ledger')
  };
}

function readOutputs(paths) {
  return {
    inventory: JSON.parse(readFileSync(paths.output, 'utf8')),
    deltas: readFileSync(paths.deltas, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
    checkpoint: JSON.parse(readFileSync(paths.checkpoint, 'utf8'))
  };
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('Codex inventory adapter', () => {
  test('source identity exposes only hashed relationship metadata', async () => {
    const source = join(fixtures, 'codex-active.jsonl');
    const identity = await readSourceIdentity(source);
    const serialized = JSON.stringify(identity);

    assert.match(identity.sourceId, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionIdHash, /^[a-f0-9]{64}$/u);
    assert.equal(identity.relationKeys.length, 4);
    assert.equal(serialized.includes(source), false);
    assert.equal(serialized.includes('sensitive project'), false);
    assert.equal(serialized.includes('feature/private-work'), false);
  });

  test('source identity accepts a complete metadata record without a final newline', async () => {
    const root = tempRoot('metadata-no-newline');
    const source = join(root, 'session.jsonl');
    const metadata = readFileSync(join(fixtures, 'codex-active.jsonl'), 'utf8')
      .split('\n')[0];
    writeFileSync(source, metadata, 'utf8');

    const identity = await readSourceIdentity(source);

    assert.match(identity.sessionIdHash, /^[a-f0-9]{64}$/u);
    assert.equal(identity.relationKeys.length, 4);
  });

  test('source identity does not parse a bounded prefix as an EOF record', async () => {
    const root = tempRoot('metadata-bounded-prefix');
    const source = join(root, 'session.jsonl');
    const metadata = readFileSync(join(fixtures, 'codex-active.jsonl'), 'utf8')
      .split('\n')[0];
    writeFileSync(source, `${metadata}${' '.repeat(2 * 1024 * 1024)}`, 'utf8');

    await assert.rejects(
      readSourceIdentity(source),
      /source metadata is unavailable/u
    );
  });

  test('dry-run plans bounded sources without writing output', async () => {
    const root = tempRoot('plan');
    const source = join(fixtures, 'codex-active.jsonl');
    const paths = outputPaths(root);

    const plan = await planInventory({ source, maxFiles: 1 });

    assert.equal(plan.selected.length, 1);
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(paths.output), false);
    assert.equal(JSON.stringify(plan).includes(source), false);
  });

  test('active inventory emits only hashed private metadata', async () => {
    const root = tempRoot('active');
    const source = join(fixtures, 'codex-active.jsonl');
    const paths = outputPaths(root);
    const before = statSync(source);

    await runInventory({
      source,
      ...paths,
      now: '2026-08-24T09:00:30.000Z'
    });

    const after = statSync(source);
    const serialized = [
      readFileSync(paths.output, 'utf8'),
      readFileSync(paths.deltas, 'utf8'),
      readFileSync(paths.checkpoint, 'utf8')
    ].join('\n');
    const result = readOutputs(paths);

    assert.equal(result.inventory.sources[0].threadState, 'active');
    assert.equal(result.deltas[0].classification, 'unverified');
    assert.ok(result.deltas[0].expiresAt);
    assert.equal(result.inventory.sources[0].relationKeys.length, 4);
    assert.equal(serialized.includes('SENSITIVE_FIXTURE_VALUE_MUST_NOT_LEAK'), false);
    assert.equal(serialized.includes('sensitive project'), false);
    assert.equal(serialized.includes('feature/private-work'), false);
    assert.equal(serialized.includes('private/repo.git'), false);
    assert.equal(before.size, after.size);
    assert.equal(before.mtimeMs, after.mtimeMs);
    assert.equal(readdirSync(paths.ledgerDir).length, 2);
  });

  test('completed and malformed sources preserve lifecycle without raw data', async () => {
    const root = tempRoot('terminal');
    const completedPaths = outputPaths(join(root, 'completed'));
    const malformedPaths = outputPaths(join(root, 'malformed'));

    await runInventory({
      source: join(fixtures, 'codex-completed.jsonl'),
      ...completedPaths,
      now: '2026-08-24T08:01:00.000Z'
    });
    await runInventory({
      source: join(fixtures, 'codex-malformed.jsonl'),
      ...malformedPaths,
      now: '2026-08-24T07:01:00.000Z'
    });

    const completed = readOutputs(completedPaths);
    const malformed = readOutputs(malformedPaths);
    assert.equal(completed.inventory.sources[0].threadState, 'completed');
    assert.equal(completed.deltas[0].classification, 'candidate');
    assert.equal(completed.deltas[0].expiresAt, null);
    assert.equal(malformed.inventory.sources[0].threadState, 'aborted');
    assert.equal(malformed.inventory.sources[0].malformedRecords, 1);
    assert.equal(
      readFileSync(malformedPaths.output, 'utf8').includes('deliberately not json'),
      false
    );
  });

  test('checkpoint skips replay and reports a reopened completed thread', async () => {
    const root = tempRoot('replay');
    const source = join(root, 'session.jsonl');
    const paths = outputPaths(root);
    copyFileSync(join(fixtures, 'codex-completed.jsonl'), source);

    const first = await runInventory({
      source,
      ...paths,
      now: '2026-08-24T08:01:00.000Z'
    });
    const second = await runInventory({
      source,
      ...paths,
      now: '2026-08-24T08:02:00.000Z'
    });

    assert.equal(first.deltas.length, 1);
    assert.equal(second.deltas.length, 0);
    assert.equal(second.inventory.skipped[0].reason, 'unchanged');
    assert.equal(second.checkpoint.sequence, 1);

    appendFileSync(
      source,
      '{"timestamp":"2026-08-24T08:03:00.000Z","type":"event_msg","payload":{"type":"task_started","turn_id":"turn-2"}}\n',
      'utf8'
    );
    const reopened = await runInventory({
      source,
      ...paths,
      now: '2026-08-24T08:03:10.000Z'
    });

    assert.equal(reopened.inventory.sources[0].coverage, 'incremental');
    assert.equal(reopened.inventory.sources[0].threadState, 'reopened');
    assert.equal(reopened.deltas[0].previousThreadState, 'completed');
    assert.equal(reopened.checkpoint.sequence, 2);
  });

  test('large first source uses a bounded tail bootstrap', async () => {
    const root = tempRoot('tail');
    const source = join(root, 'large.jsonl');
    const paths = outputPaths(root);
    const metadata = readFileSync(join(fixtures, 'codex-active.jsonl'), 'utf8')
      .split('\n')[0];
    const filler = Array.from({ length: 80 }, (_, index) => JSON.stringify({
      timestamp: `2026-08-24T09:00:${String(index % 60).padStart(2, '0')}.000Z`,
      type: 'event_msg',
      payload: { type: 'token_count', index, ignored: 'TAIL_FIXTURE_SECRET' }
    })).join('\n');
    writeFileSync(
      source,
      `${metadata}\n${filler}\n{"timestamp":"2026-08-24T09:02:00.000Z","type":"event_msg","payload":{"type":"task_started"}}\n`,
      'utf8'
    );

    const result = await runInventory({
      source,
      ...paths,
      maxScanBytes: 512,
      tailBootstrapBytes: 512,
      now: '2026-08-24T09:02:10.000Z'
    });

    assert.equal(result.inventory.sources[0].coverage, 'tail');
    assert.ok(result.inventory.sources[0].coverageStartOffset > 0);
    assert.ok(result.deltas[0].appendedBytes <= 512);
    assert.equal(readFileSync(paths.output, 'utf8').includes('TAIL_FIXTURE_SECRET'), false);
  });

  test('parallel inventory runs serialize through the shared checkpoint', async () => {
    const root = tempRoot('parallel');
    const source = join(fixtures, 'codex-active.jsonl');
    const paths = outputPaths(root);

    const results = await Promise.all([
      runInventory({ source, ...paths, now: '2026-08-24T09:03:00.000Z' }),
      runInventory({ source, ...paths, now: '2026-08-24T09:03:01.000Z' })
    ]);

    assert.deepEqual(results.map((result) => result.deltas.length).sort(), [0, 1]);
    assert.equal(JSON.parse(readFileSync(paths.checkpoint, 'utf8')).sequence, 1);
    assert.equal(readdirSync(paths.ledgerDir).length, 4);
    assert.equal(existsSync(`${paths.checkpoint}.lock`), false);
  });

  test('related context returns live peer deltas and respects TTL and sequence', async () => {
    const root = tempRoot('related');
    const paths = outputPaths(root);
    const active = join(fixtures, 'codex-active.jsonl');
    const completed = join(fixtures, 'codex-completed.jsonl');

    await runInventory({
      source: active,
      ...paths,
      now: '2026-08-24T09:00:30.000Z',
      peerTtlSeconds: 300
    });
    await runInventory({
      source: completed,
      ...paths,
      now: '2026-08-24T09:01:00.000Z',
      peerTtlSeconds: 300
    });

    const current = await readRelatedDeltas({
      source: active,
      ledgerDir: paths.ledgerDir,
      afterSequence: 0,
      now: '2026-08-24T09:02:00.000Z'
    });
    assert.equal(current.deltas.length, 1);
    assert.equal(current.deltas[0].threadState, 'completed');
    assert.equal(current.watermark, 2);

    const afterWatermark = await readRelatedDeltas({
      source: active,
      ledgerDir: paths.ledgerDir,
      afterSequence: current.watermark,
      now: '2026-08-24T09:02:00.000Z'
    });
    assert.equal(afterWatermark.deltas.length, 0);

    const completedView = await readRelatedDeltas({
      source: completed,
      ledgerDir: paths.ledgerDir,
      afterSequence: 0,
      now: '2026-08-24T09:10:00.000Z'
    });
    assert.equal(completedView.deltas.length, 0);
    assert.equal(completedView.watermark, 2);
  });

  test('CLI requires execute before creating files', () => {
    const root = tempRoot('cli');
    const output = execFileSync(
      process.execPath,
      [
        join(packageRoot, 'src', 'cli.mjs'),
        'inventory',
        '--source',
        join(fixtures, 'codex-active.jsonl')
      ],
      { encoding: 'utf8' }
    );

    assert.match(output, /"writesEnabled": false/);
    assert.equal(existsSync(join(root, 'inventory.json')), false);
  });
});
