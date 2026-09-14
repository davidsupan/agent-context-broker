#!/usr/bin/env bun
// Archives an agent transcript corpus with a per-file round-trip proof.
//
// Originals are never modified or removed. For every file the archive records the
// original SHA-256, the packed SHA-256 and the SHA-256 of the decompressed bytes, and
// an entry is only marked verified when the decompressed hash equals the original, so
// "safe to prune" is proven per file rather than assumed for the run.
//
// Everything streams. An earlier buffered version peaked at 4.4 GB of RAM on a corpus
// whose largest rollouts are about 1 GB, because it held the raw, packed and restored
// bytes at once; on a machine shared with other agents that is not acceptable. Memory
// here is bounded by the stream chunk size regardless of file size.
//
// Level 9 is chosen on measurement: on this corpus level 3 gives 3.36x, level 9 gives
// 3.65x, and level 19 gives 4.12x but costs 11.3 s against 0.2 s for the same 24 MB,
// which is hours instead of minutes across 12.9 GB for about 11% more compression.
// Output is deterministic for a given level and codec, but the Bun-native API and the
// node:zlib streams do not emit identical bytes, so each entry records which codec
// wrote it rather than the archive claiming universal reproducibility.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { constants, createZstdCompress, createZstdDecompress } from 'node:zlib';

function parseArgs(argv) {
  const options = { level: 9, minAgeHours: 24, limit: Infinity, execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') { options.execute = true; continue; }
    const value = argv[index + 1];
    switch (argument) {
      case '--source': options.source = value; index += 1; break;
      case '--archive': options.archive = value; index += 1; break;
      case '--level': options.level = Number(value); index += 1; break;
      case '--min-age-hours': options.minAgeHours = Number(value); index += 1; break;
      case '--limit': options.limit = Number(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.source || !options.archive) {
    throw new Error('usage: archive-corpus.mjs --source <dir> --archive <dir> [--level 9] [--min-age-hours 24] [--limit n] [--execute]');
  }
  return options;
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

function compressor(level) {
  return createZstdCompress({ params: { [constants.ZSTD_c_compressionLevel]: level } });
}

// Compress source -> archive while hashing both sides, without buffering the file.
async function packStreaming(sourcePath, targetPath, level) {
  const originalHash = createHash('sha256');
  const packedHash = createHash('sha256');
  let originalBytes = 0;
  let packedBytes = 0;

  const seen = new PassThrough();
  seen.on('data', (chunk) => {
    originalBytes += chunk.length;
    originalHash.update(chunk);
  });
  const written = new PassThrough();
  written.on('data', (chunk) => {
    packedBytes += chunk.length;
    packedHash.update(chunk);
  });

  await pipeline(
    createReadStream(sourcePath),
    seen,
    compressor(level),
    written,
    createWriteStream(targetPath)
  );

  return {
    originalBytes,
    packedBytes,
    originalSha256: originalHash.digest('hex'),
    packedSha256: packedHash.digest('hex')
  };
}

// Read the archive entry back and hash what comes out, again without buffering.
async function restoredHash(targetPath) {
  const digest = createHash('sha256');
  const seen = new PassThrough();
  seen.on('data', (chunk) => digest.update(chunk));
  await pipeline(createReadStream(targetPath), createZstdDecompress(), seen);
  return digest.digest('hex');
}

const options = parseArgs(process.argv.slice(2));
const source = resolve(options.source);
const archive = resolve(options.archive);
const cutoff = Date.now() - (options.minAgeHours * 3600 * 1000);

const all = walk(source).sort();
// Codex rewrites rollouts in place, so a file touched inside the window is not settled
// and is not a safe archive candidate.
const candidates = all
  .filter((path) => statSync(path).mtimeMs <= cutoff)
  .slice(0, options.limit);

console.log('source        : ' + source);
console.log('files found   : ' + all.length);
console.log('settled (>' + options.minAgeHours + 'h) : ' + candidates.length);
console.log('level         : ' + options.level + ' (streaming)');
console.log('mode          : ' + (options.execute ? 'execute' : 'plan (no writes)'));
console.log('');

if (!options.execute) {
  console.log('plan only; rerun with --execute to write the archive');
  process.exit(0);
}

mkdirSync(archive, { recursive: true });
const manifestPath = join(archive, 'manifest.jsonl');
const done = new Set();
if (existsSync(manifestPath)) {
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (line.trim()) done.add(JSON.parse(line).relativePath);
  }
  console.log('resuming: ' + done.size + ' file(s) already archived');
}

let originalTotal = 0;
let packedTotal = 0;
let verified = 0;
let failed = 0;
let peakFileMb = 0;
const started = performance.now();

for (const path of candidates) {
  const relativePath = relative(source, path).split('\\').join('/');
  if (done.has(relativePath)) continue;

  const target = join(archive, relativePath + '.zst');
  mkdirSync(join(target, '..'), { recursive: true });

  const packed = await packStreaming(path, target, options.level);
  const restored = await restoredHash(target);
  const ok = restored === packed.originalSha256;

  if (ok) {
    originalTotal += packed.originalBytes;
    packedTotal += packed.packedBytes;
    verified += 1;
    peakFileMb = Math.max(peakFileMb, packed.originalBytes / 1024 / 1024);
  } else {
    failed += 1;
    console.error('  ROUND-TRIP FAILED: ' + relativePath);
  }

  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    relativePath,
    originalBytes: packed.originalBytes,
    packedBytes: packed.packedBytes,
    originalSha256: packed.originalSha256,
    packedSha256: packed.packedSha256,
    restoredSha256: restored,
    roundTrip: ok ? 'verified' : 'failed',
    level: options.level,
    codec: 'node-zlib-zstd-stream',
    runtime: 'bun-' + Bun.version,
    archivedAt: new Date().toISOString()
  }) + '\n', { flag: 'a' });
}

const elapsed = (performance.now() - started) / 1000;
console.log('archived      : ' + verified + ' file(s)');
console.log('failed        : ' + failed);
console.log('largest file  : ' + peakFileMb.toFixed(0) + ' MB (streamed, not buffered)');
console.log('original      : ' + (originalTotal / 1024 / 1024 / 1024).toFixed(2) + ' GB');
console.log('packed        : ' + (packedTotal / 1024 / 1024 / 1024).toFixed(2) + ' GB');
if (packedTotal > 0) console.log('ratio         : ' + (originalTotal / packedTotal).toFixed(2) + 'x');
console.log('elapsed       : ' + elapsed.toFixed(1) + ' s');
console.log('');
console.log('originals were not modified or removed; pruning is a separate decision');
process.exit(failed === 0 ? 0 : 1);
