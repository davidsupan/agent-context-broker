#!/usr/bin/env node

import { handleHookEvent, recordFailOpen } from './bridge.mjs';

const MAX_INPUT_BYTES = 1024 * 1024;

try {
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
  process.stdout.write(`${JSON.stringify(recordFailOpen({}, failureClass))}\n`);
}
