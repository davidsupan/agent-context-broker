#!/usr/bin/env bun

import { verifyInstallation } from '../src/installation.mjs';

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== '--runtime-home') throw new Error(`Unknown verification argument: ${argument}`);
    const value = argv[++index];
    if (!value) throw new Error('--runtime-home requires a value.');
    options.runtimeHome = value;
  }
  return options;
}

try {
  const result = verifyInstallation(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.healthy) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
