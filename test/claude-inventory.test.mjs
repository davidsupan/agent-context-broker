import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  planInventory,
  readSourceIdentity,
  runInventory
} from '../src/claude-inventory.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(packageRoot, 'fixtures', 'claude-active.jsonl');
const temporaryRoots = [];

function tempRoot() {
  const root = join(tmpdir(), `agent-context-broker-claude-${randomUUID()}`);
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

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('Claude Code inventory adapter', () => {
  test('collects metadata across the bounded initial record window', async () => {
    const identity = await readSourceIdentity(fixture);
    const serialized = JSON.stringify(identity);

    assert.match(identity.sourceId, /^[a-f0-9]{64}$/u);
    assert.match(identity.sessionIdHash, /^[a-f0-9]{64}$/u);
    assert.equal(identity.relationKeys.length, 4);
    assert.equal(serialized.includes('private claude project'), false);
    assert.equal(serialized.includes('feature/private-claude-work'), false);
    assert.equal(serialized.includes('fixture-claude-session'), false);
  });

  test('plans read-only and uses explicit hook lifecycle overrides', async () => {
    const root = tempRoot();
    const paths = outputPaths(root);
    const plan = await planInventory({ source: fixture });

    assert.equal(plan.provider, 'claude-code');
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(paths.output), false);

    const result = await runInventory({
      source: fixture,
      ...paths,
      lifecycleOverride: 'session_end',
      now: '2026-08-24T10:01:00.000Z'
    });
    const persisted = [
      readFileSync(paths.output, 'utf8'),
      readFileSync(paths.deltas, 'utf8'),
      readFileSync(paths.checkpoint, 'utf8')
    ].join('\n');

    assert.equal(result.inventory.provider, 'claude-code');
    assert.equal(result.inventory.sources[0].threadState, 'completed');
    assert.equal(result.deltas[0].classification, 'candidate');
    assert.equal(result.deltas[0].expiresAt, null);
    assert.equal(persisted.includes('CLAUDE_FIXTURE_SECRET_MUST_NOT_LEAK'), false);
    assert.equal(persisted.includes('PRIVATE_CLAUDE_PROMPT'), false);
    assert.equal(persisted.includes('PRIVATE_CLAUDE_RESPONSE'), false);
  });
});
