#!/usr/bin/env bun
// Archives an agent transcript corpus with a per-file round-trip proof.
//
// Originals are never modified or removed. The archive records, for every file, the
// original SHA-256, the packed SHA-256, and the SHA-256 of the decompressed bytes.
// A file is only marked verified when the decompressed hash equals the original hash,
// so "safe to prune" is proven per file rather than assumed for the run.
//
// Level 9 is the default on measurement, not preference: on this corpus level 19 buys
// about 11% more compression for roughly 50x the CPU (0.2 s versus 11.3 s for 24 MB),
// which is minutes versus hours across 12.9 GB. Output is deterministic for a given
// level and implementation, but Bun and node:zlib do not emit identical bytes at the
// same level, so an archive is reproducible only with the runtime that wrote it.
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';

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

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(path);
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const source = resolve(options.source);
const archive = resolve(options.archive);
const cutoff = Date.now() - (options.minAgeHours * 3600 * 1000);

const all = walk(source).sort();
// A file still being written is not a safe archive candidate: Codex rewrites rollouts
// in place, so only files untouched for the cutoff window are considered settled.
const candidates = all
  .filter((path) => statSync(path).mtimeMs <= cutoff)
  .slice(0, options.limit);

console.log('source       : ' + source);
console.log('files found  : ' + all.length);
console.log('settled (>' + options.minAgeHours + 'h): ' + candidates.length);
console.log('level        : ' + options.level);
console.log('mode         : ' + (options.execute ? 'execute' : 'plan (no writes)'));
console.log('');

if (!options.execute) {
  const sampled = candidates.slice(0, 3);
  for (const path of sampled) {
    const raw = readFileSync(path);
    const packed = Bun.zstdCompressSync(raw, { level: options.level });
    console.log('  ' + basename(path).slice(0, 44) + '  ' +
      (raw.length / 1024 / 1024).toFixed(1) + ' MB -> ' +
      (packed.length / 1024 / 1024).toFixed(1) + ' MB  (' +
      (raw.length / packed.length).toFixed(2) + 'x)');
  }
  console.log('');
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

let originalBytes = 0;
let packedBytes = 0;
let verified = 0;
let failed = 0;
const started = performance.now();

for (const path of candidates) {
  const relativePath = relative(source, path).split('\\').join('/');
  if (done.has(relativePath)) continue;

  const raw = readFileSync(path);
  const originalHash = sha256(raw);
  const packed = Bun.zstdCompressSync(raw, { level: options.level });
  // Round trip before writing anything: an archive entry that cannot be restored is
  // worse than no archive entry, because it invites deleting the original.
  const restored = Buffer.from(Bun.zstdDecompressSync(packed));
  const restoredHash = sha256(restored);
  const ok = restoredHash === originalHash;

  if (ok) {
    const target = join(archive, relativePath + '.zst');
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, packed);
    originalBytes += raw.length;
    packedBytes += packed.length;
    verified += 1;
  } else {
    failed += 1;
  }

  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    relativePath,
    originalBytes: raw.length,
    packedBytes: packed.length,
    originalSha256: originalHash,
    packedSha256: sha256(packed),
    restoredSha256: restoredHash,
    roundTrip: ok ? 'verified' : 'failed',
    level: options.level,
    runtime: 'bun-' + Bun.version,
    archivedAt: new Date().toISOString()
  }) + '\n', { flag: 'a' });
}

const elapsed = (performance.now() - started) / 1000;
console.log('archived     : ' + verified + ' file(s)');
console.log('failed       : ' + failed);
console.log('original     : ' + (originalBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB');
console.log('packed       : ' + (packedBytes / 1024 / 1024 / 1024).toFixed(2) + ' GB');
if (packedBytes > 0) {
  console.log('ratio        : ' + (originalBytes / packedBytes).toFixed(2) + 'x');
}
console.log('elapsed      : ' + elapsed.toFixed(1) + ' s');
console.log('');
console.log('originals were not modified or removed; pruning is a separate decision');
process.exit(failed === 0 ? 0 : 1);
