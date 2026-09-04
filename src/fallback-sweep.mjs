import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import * as claudeCode from './claude-inventory.mjs';
import * as codex from './codex-inventory-v2.mjs';

const ADAPTERS = Object.freeze({ codex, 'claude-code': claudeCode });
const DEFAULTS = Object.freeze({
  minimumIntervalSeconds: 900,
  maxSources: 4,
  maxFilesPerSource: 20,
  maxScanBytes: 16 * 1024 * 1024,
  tailBootstrapBytes: 1024 * 1024
});

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function withSweepLock(path, action) {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  let descriptor;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > 300000) {
          unlinkSync(path);
          continue;
        }
      } catch (statError) {
        if (statError?.code !== 'ENOENT') throw statError;
        continue;
      }
      if (Date.now() - startedAt >= 2000) throw new Error('Fallback sweep is busy.');
      await delay(25);
    }
  }
  try {
    return await action();
  } finally {
    closeSync(descriptor);
    try {
      unlinkSync(path);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, value, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function writeJson(path, value) {
  atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

function validateSources(sources, maxSources) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > maxSources) {
    throw new Error(`Fallback sweep requires 1-${maxSources} explicit sources.`);
  }
  return sources.map((entry) => {
    if (!ADAPTERS[entry?.provider] || typeof entry?.source !== 'string') {
      throw new Error('Fallback sweep source requires a supported provider and path.');
    }
    return { ...entry, source: resolve(entry.source) };
  });
}

function optionsFor(entry, options) {
  return {
    source: entry.source,
    recursive: entry.recursive === true,
    maxFiles: Math.min(entry.maxFiles ?? options.maxFilesPerSource, options.maxFilesPerSource),
    maxScanBytes: options.maxScanBytes,
    tailBootstrapBytes: options.tailBootstrapBytes,
    now: options.now
  };
}

function loadSweepState(path) {
  if (!existsSync(path)) return { schemaVersion: 1, lastCompletedAt: null };
  const state = JSON.parse(readFileSync(path, 'utf8'));
  if (state.schemaVersion !== 1) throw new Error('Unsupported fallback sweep state.');
  return state;
}

function dueStatus(state, now, minimumIntervalSeconds) {
  if (!state.lastCompletedAt) return { due: true, nextEligibleAt: null };
  const next = new Date(
    new Date(state.lastCompletedAt).getTime() + minimumIntervalSeconds * 1000
  );
  return { due: now.getTime() >= next.getTime(), nextEligibleAt: next.toISOString() };
}

export async function planFallbackSweep(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  const sources = validateSources(options.sources, options.maxSources);
  const now = options.now ? new Date(options.now) : new Date();
  const runtimeRoot = resolve(options.runtimeRoot);
  const state = loadSweepState(join(runtimeRoot, 'fallback-state.json'));
  const due = dueStatus(state, now, options.minimumIntervalSeconds);
  const plans = [];

  for (const entry of sources) {
    const sourceKey = hash(`${entry.provider}:${entry.source.toLowerCase()}`);
    const plan = await ADAPTERS[entry.provider].planInventory(optionsFor(entry, options));
    plans.push({
      provider: entry.provider,
      sourceKey,
      selectedSourceCount: plan.selected.length,
      skippedByFileLimitCount: plan.skippedByFileLimit.length,
      limits: plan.limits
    });
  }

  return {
    schemaVersion: 1,
    mode: 'plan',
    generatedAt: now.toISOString(),
    due: due.due,
    nextEligibleAt: due.nextEligibleAt,
    writesEnabled: false,
    sources: plans
  };
}

export async function runFallbackSweep(inputOptions) {
  const options = { ...DEFAULTS, ...inputOptions };
  if (options.execute !== true) throw new Error('Fallback sweep writes require execute: true.');
  const sources = validateSources(options.sources, options.maxSources);
  const now = options.now ? new Date(options.now) : new Date();
  const runtimeRoot = resolve(options.runtimeRoot);
  return withSweepLock(join(runtimeRoot, 'fallback-state.lock'), async () => {
    const statePath = join(runtimeRoot, 'fallback-state.json');
    const state = loadSweepState(statePath);
    const due = dueStatus(state, now, options.minimumIntervalSeconds);
    if (!due.due) {
      return {
        schemaVersion: 1,
        mode: 'observe',
        state: 'skipped-not-due',
        nextEligibleAt: due.nextEligibleAt,
        writesEnabled: false,
        sources: []
      };
    }

    const sweepId = randomUUID();
    const summaries = [];
    for (const entry of sources) {
      const sourceKey = hash(`${entry.provider}:${entry.source.toLowerCase()}`);
      const root = join(runtimeRoot, 'providers', entry.provider, sourceKey);
      const result = await ADAPTERS[entry.provider].runInventory({
        ...optionsFor(entry, options),
        output: join(root, 'inventory.json'),
        deltas: join(root, 'deltas.jsonl'),
        checkpoint: join(root, 'checkpoint.json'),
        ledgerDir: join(root, 'ledger')
      });
      summaries.push({
        provider: entry.provider,
        sourceKey,
        sourcesProcessed: result.inventory.sources.length,
        sourcesSkipped: result.inventory.skipped.length,
        deltasWritten: result.deltas.length,
        checkpointSequence: result.checkpoint.sequence
      });
    }

    const manifest = {
      schemaVersion: 1,
      sweepId,
      completedAt: now.toISOString(),
      minimumIntervalSeconds: options.minimumIntervalSeconds,
      writesEnabled: true,
      sources: summaries
    };
    writeJson(join(runtimeRoot, 'sweeps', `${sweepId}.json`), manifest);
    writeJson(statePath, {
      schemaVersion: 1,
      lastCompletedAt: now.toISOString(),
      lastSweepId: sweepId
    });
    return { ...manifest, mode: 'observe', state: 'completed' };
  });
}
