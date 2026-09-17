#!/usr/bin/env bun
// Backfills the codec label on manifest entries written before the field existed.
//
// The label is not assumed from run history: for each unlabelled entry it re-compresses
// the original with each candidate codec and keeps the one whose output hashes to the
// packed bytes actually on disk. An entry whose producer cannot be reproduced is left
// unlabelled rather than guessed, because a wrong provenance label is worse than a
// missing one.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { constants, zstdCompressSync } from 'node:zlib';

function parseArgs(argv) {
  const options = { execute: false, limit: Infinity };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') { options.execute = true; continue; }
    const value = argv[index + 1];
    switch (argument) {
      case '--archive': options.archive = value; index += 1; break;
      case '--source': options.source = value; index += 1; break;
      case '--limit': options.limit = Number(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.archive || !options.source) {
    throw new Error('usage: label-archive-codec.mjs --archive <dir> --source <dir> [--limit n] [--execute]');
  }
  return options;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

const candidates = [
  { codec: 'bun-zstd-buffered', pack: (bytes, level) => Bun.zstdCompressSync(bytes, { level }) },
  {
    codec: 'node-zlib-zstd-buffered',
    pack: (bytes, level) => zstdCompressSync(bytes, {
      params: { [constants.ZSTD_c_compressionLevel]: level }
    })
  }
];

const options = parseArgs(process.argv.slice(2));
const archive = resolve(options.archive);
const source = resolve(options.source);
const manifestPath = join(archive, 'manifest.jsonl');

const entries = readFileSync(manifestPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const unlabelled = entries.filter((entry) => !entry.codec);
console.log('entries        : ' + entries.length);
console.log('unlabelled     : ' + unlabelled.length);
console.log('mode           : ' + (options.execute ? 'execute' : 'plan (no writes)'));
console.log('');

// Identifying the producer only needs enough entries to be conclusive, and re-compressing
// every multi-hundred-MB original would cost more than the label is worth. Sort by size so
// the probe uses the cheapest files.
const probes = [...unlabelled]
  .filter((entry) => existsSync(join(source, entry.relativePath)))
  .sort((left, right) => left.originalBytes - right.originalBytes)
  .slice(0, Math.min(options.limit, 12));

const tally = new Map();
for (const entry of probes) {
  const bytes = readFileSync(join(source, entry.relativePath));
  if (sha(bytes) !== entry.originalSha256) continue; // original changed; not evidence
  for (const candidate of candidates) {
    if (sha(candidate.pack(bytes, entry.level ?? 9)) === entry.packedSha256) {
      tally.set(candidate.codec, (tally.get(candidate.codec) ?? 0) + 1);
      break;
    }
  }
}

console.log('probe files    : ' + probes.length);
for (const [codec, count] of tally) console.log('  reproduced by ' + codec + ': ' + count);

if (tally.size !== 1 || [...tally.values()][0] !== probes.length) {
  console.log('');
  console.log('inconclusive: leaving entries unlabelled rather than guessing a producer');
  process.exit(0);
}

const identified = [...tally.keys()][0];
console.log('');
console.log('identified     : ' + identified + ' (reproduced every probe byte-for-byte)');

if (!options.execute) {
  console.log('rerun with --execute to write the label');
  process.exit(0);
}

const updated = entries.map((entry) => (entry.codec ? entry : {
  ...entry,
  codec: identified,
  codecSource: 'backfilled-by-reproduction'
}));
writeFileSync(manifestPath, updated.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
console.log('labelled       : ' + unlabelled.length + ' entry(ies)');
