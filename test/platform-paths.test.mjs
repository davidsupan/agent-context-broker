import assert from 'node:assert/strict';
import { test } from 'node:test';

import { defaultRuntimeHome } from '../src/platform-paths.mjs';

test('uses an explicit broker home on every platform', () => {
  assert.equal(
    defaultRuntimeHome({
      env: { AGENT_CONTEXT_BROKER_HOME: '/tmp/custom-broker' },
      home: '/Users/example',
      platform: 'darwin'
    }),
    '/tmp/custom-broker'
  );
});

test('uses LocalAppData on Windows', () => {
  assert.equal(
    defaultRuntimeHome({
      env: { LOCALAPPDATA: 'C:\\Users\\example\\AppData\\Local' },
      home: 'C:\\Users\\example',
      platform: 'win32'
    }),
    'C:\\Users\\example\\AppData\\Local\\AgentContextBroker'
  );
});

test('uses XDG state storage on Linux when configured', () => {
  assert.equal(
    defaultRuntimeHome({
      env: { XDG_STATE_HOME: '/home/example/.state' },
      home: '/home/example',
      platform: 'linux'
    }),
    '/home/example/.state/agent-context-broker'
  );
});

test('uses the Linux state fallback when XDG_STATE_HOME is absent', () => {
  assert.equal(
    defaultRuntimeHome({ env: {}, home: '/home/example', platform: 'linux' }),
    '/home/example/.local/state/agent-context-broker'
  );
});

test('requires an explicit home on unsupported platforms', () => {
  assert.throws(
    () => defaultRuntimeHome({ env: {}, home: '/Users/example', platform: 'darwin' }),
    /Unsupported platform/u
  );
});
