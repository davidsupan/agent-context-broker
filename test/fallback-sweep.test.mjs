import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { planFallbackSweep, runFallbackSweep } from '../src/fallback-sweep.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporaryRoots = [];

function tempRoot() {
  const root = join(tmpdir(), `agent-context-sweep-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  temporaryRoots.push(root);
  return root;
}

function sources() {
  return [
    { provider: 'codex', source: join(packageRoot, 'fixtures', 'codex-active.jsonl') },
    { provider: 'claude-code', source: join(packageRoot, 'fixtures', 'claude-active.jsonl') }
  ];
}

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

describe('fallback sweep', () => {
  test('plans both providers without writes or native paths', async () => {
    const root = tempRoot();
    const plan = await planFallbackSweep({ runtimeRoot: root, sources: sources() });
    const serialized = JSON.stringify(plan);
    assert.equal(plan.sources.length, 2);
    assert.equal(plan.writesEnabled, false);
    assert.equal(existsSync(join(root, 'fallback-state.json')), false);
    assert.equal(serialized.includes(packageRoot), false);
  });

  test('runs sequentially and enforces the low-frequency interval', async () => {
    const root = tempRoot();
    const first = await runFallbackSweep({
      runtimeRoot: root,
      sources: sources(),
      execute: true,
      now: '2026-08-24T12:00:00.000Z'
    });
    const second = await runFallbackSweep({
      runtimeRoot: root,
      sources: sources(),
      execute: true,
      now: '2026-08-24T12:01:00.000Z'
    });
    const manifest = readFileSync(
      join(root, 'sweeps', `${first.sweepId}.json`),
      'utf8'
    );

    assert.equal(first.state, 'completed');
    assert.deepEqual(first.sources.map((item) => item.provider), ['codex', 'claude-code']);
    assert.equal(second.state, 'skipped-not-due');
    assert.equal(second.writesEnabled, false);
    assert.equal(manifest.includes(packageRoot), false);
    assert.equal(manifest.includes('PRIVATE_CLAUDE_PROMPT'), false);
  });
});
