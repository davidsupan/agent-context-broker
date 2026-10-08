#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArtifactQuery } from './artifact-query-args.ts';

const args = process.argv.slice(2);
function readConfig(path) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('config');
  return JSON.parse(readFileSync(path, 'utf8'));
}
try {
  const values = args[0] === 'query' ? parseArtifactQuery(args) : null;
  if (args[0] !== 'query') {
    if (!['publish', 'progress', 'route'].includes(args[0])) throw new Error('command');
    const config = readConfig(join(homedir(), '.agent-context-broker/artifact-query.json'));
    if (typeof config.queryConfig !== 'string' || !isAbsolute(config.queryConfig)) throw new Error('config');
    const binding = readConfig(config.queryConfig);
    if (typeof binding.brokerRuntimeHome !== 'string' || !isAbsolute(binding.brokerRuntimeHome) ||
        typeof binding.brokerToolRoot !== 'string' || !isAbsolute(binding.brokerToolRoot)) throw new Error('config');
    // Use the same store as artifact queries and lifecycle hooks, never the OS default.
    // Explicit overrides are rejected here; use the native CLI for another installation.
    if (args.some(arg => arg === '--runtime-home' || arg.startsWith('--runtime-home='))) throw new Error('runtime-override');
    const child = spawn(process.execPath, [join(binding.brokerToolRoot, 'scripts/agent-context.mjs'),
      ...args, '--runtime-home', binding.brokerRuntimeHome],
      { stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
  } else if (values['strict-isolation'] || values.profile === 'strict-isolation') {
    console.log(JSON.stringify({ originalBrokerPacket: null, sourceArtifacts: [], warnings: ['strict-isolation'],
      coverage: { state: 'not-read', exhaustiveGlobalCoverage: false, nextCursor: null }, artifactAudit: { persisted: false } }));
  } else {
    const configPath = join(homedir(), '.agent-context-broker/artifact-query.json');
    const config = readConfig(configPath);
    if (typeof config.entrypoint !== 'string' || !isAbsolute(config.entrypoint) ||
        typeof config.queryConfig !== 'string' || !isAbsolute(config.queryConfig)) throw new Error('config');
    const { artifactQueryCli } = await import(pathToFileURL(config.entrypoint).href);
    console.log(JSON.stringify(await artifactQueryCli(args, config.queryConfig)));
  }
} catch {
  console.log(JSON.stringify({ state: 'unavailable', code: 'artifact-query-failed',
    hint: 'Inspect private query configuration or use native broker with explicit package readback; do not claim full coverage.' }));
  process.exitCode = 1;
}
