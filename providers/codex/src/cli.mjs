#!/usr/bin/env bun

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { defaultRuntimeHome } from '../../../src/platform-paths.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

try {
  const runtimeHomeIndex = process.argv.indexOf('--runtime-home');
  const runtimeHome = runtimeHomeIndex === -1
    ? defaultRuntimeHome()
    : process.argv[runtimeHomeIndex + 1];
  if (!runtimeHome) throw new Error('--runtime-home requires a value.');
  process.env.AGENT_CONTEXT_BROKER_HOME = runtimeHome;
  const activationLock = process.env.AGENT_CONTEXT_BROKER_ACTIVATION_LOCK ??
    join(runtimeHome, 'runtime', 'activation', 'activation.lock');
  if (existsSync(activationLock)) {
    process.stdout.write('{"continue":true}\n');
    process.exit(0);
  }
  const { handleHookEvent, recordFailOpen } = await import('./bridge.mjs');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) throw new Error('Hook input exceeds the configured limit.');
    chunks.push(chunk);
  }
  const result = await handleHookEvent(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const failureClass = String(error?.message).includes('configured limit')
    ? 'InputTooLarge'
    : 'MalformedInput';
  try {
    const { recordFailOpen } = await import('./bridge.mjs');
    process.stdout.write(`${JSON.stringify(recordFailOpen({}, failureClass))}\n`);
  } catch {
    process.stdout.write('{"continue":true}\n');
  }
}
