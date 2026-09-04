#!/usr/bin/env bun

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { manageInstallation } from '../src/installation.mjs';

const VALUE_OPTIONS = Object.freeze({
  '--provider': 'provider',
  '--package-root': 'packageRoot',
  '--install-root': 'installRoot',
  '--codex-home': 'codexHome',
  '--claude-home': 'claudeHome',
  '--runtime-home': 'runtimeHome',
  '--bun-path': 'bunPath',
  '--expected-manifest-digest': 'expectedManifestDigest',
  '--expected-plan-digest': 'expectedPlanDigest'
});

export function parseInstallationArguments(argv) {
  const args = [...argv];
  const positionalAction = args[0] && !args[0].startsWith('--') ? args.shift() : undefined;
  const options = {
    action: positionalAction?.toLowerCase() ?? 'install',
    packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..')
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--execute') {
      options.execute = true;
      continue;
    }
    if (argument === '--action') {
      const value = args[++index];
      if (!value) throw new Error('--action requires a value.');
      options.action = value.toLowerCase();
      continue;
    }
    const key = VALUE_OPTIONS[argument];
    if (!key) throw new Error(`Unknown installation argument: ${argument}`);
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[key] = value;
  }
  return options;
}

if (import.meta.main) {
  try {
    const result = manageInstallation(parseInstallationArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
