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

test('Codex v2 candidate advises on start and observes Stop without content', async () => {
  const root = join(tmpdir(), `codex-lifecycle-v2-${randomUUID()}`);
  roots.push(root);
  mkdirSync(root, { recursive: true });
  const source = join(root, 'session.jsonl');
  copyFileSync(join(toolRoot, 'fixtures', 'codex-active.jsonl'), source);
  const runtime = join(root, 'runtime');
  const result = await handleHookEvent({
    session_id: 'native-session-id',
    transcript_path: source,
    hook_event_name: 'SessionStart',
    prompt: 'PRIVATE_PROMPT_MUST_NOT_PERSIST'
  }, {
    runtimeRoot: runtime,
    eventRuntimeRoot: join(root, 'events'),
    adapterRoot: toolRoot,
    testMode: true
  });
  const stopped = await handleHookEvent({
    session_id: 'native-session-id',
    transcript_path: source,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: 'PRIVATE_STOP_CONTENT_MUST_NOT_PERSIST'
  }, {
    runtimeRoot: runtime,
    eventRuntimeRoot: join(root, 'events'),
    adapterRoot: toolRoot,
    testMode: true
  });
  const audit = readdirSync(join(runtime, 'audit'))
    .map((name) => readFileSync(join(runtime, 'audit', name), 'utf8'))
    .join('\n');

  assert.match(
    result.hookSpecificOutput.additionalContext,
    /source token: acb:\/\/source\/[a-f0-9]{64}/u
  );
  assert.equal(result.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.deepEqual(stopped, { continue: true });
  assert.equal(audit.includes('native-session-id'), false);
  assert.equal(audit.includes('PRIVATE_PROMPT_MUST_NOT_PERSIST'), false);
  assert.equal(audit.includes('PRIVATE_STOP_CONTENT_MUST_NOT_PERSIST'), false);
  assert.match(audit, /"eventName":"Stop"/u);
  assert.match(audit, /"outcome":"observed"/u);
});
