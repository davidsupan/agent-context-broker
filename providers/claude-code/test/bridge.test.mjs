import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { handleHookEvent } from '../src/bridge.mjs';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const toolRoot = process.env.AGENT_CONTEXT_BROKER_TOOL_ROOT ??
  resolve(packageRoot, '..', '..');
const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test('Claude candidate observes SessionEnd without context injection or raw input', async () => {
  const root = join(tmpdir(), `claude-lifecycle-${randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const source = join(root, 'session.jsonl');
  copyFileSync(join(toolRoot, 'fixtures', 'claude-active.jsonl'), source);
  const runtime = join(root, 'runtime');
  const result = await handleHookEvent({
    session_id: 'native-claude-session-id',
    transcript_path: source,
    hook_event_name: 'SessionEnd',
    reason: 'other',
    prompt: 'PRIVATE_CLAUDE_PROMPT_MUST_NOT_PERSIST'
  }, {
    runtimeRoot: runtime,
    eventRuntimeRoot: join(root, 'events'),
    adapterRoot: toolRoot,
    testMode: true
  });
  const audit = readFileSync(join(runtime, 'audit', readdirSync(join(runtime, 'audit'))[0]), 'utf8');

  assert.deepEqual(result, { continue: true });
  assert.match(audit, /"outcome":"observed"/u);
  assert.equal(audit.includes('native-claude-session-id'), false);
  assert.equal(audit.includes('PRIVATE_CLAUDE_PROMPT_MUST_NOT_PERSIST'), false);
});
