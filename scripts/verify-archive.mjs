#!/usr/bin/env bun
// Re-verifies an archive written by archive-corpus.mjs, independently of the manifest's
// own verdict.
//
// The manifest records what the writer observed at write time. That is not the same as
// the archive being intact now, so this reads the files back off disk: every entry is
// checked for presence and packed SHA-256, and a sample (or all of them, with --full) is
// decompressed and hashed to prove the original bytes are still recoverable.
//
// Reproducibility note: entries carry the codec that wrote them. The Bun-native API and
// the node:zlib streams both emit valid zstd and each reads the other's output, but they
// do not emit identical bytes, so verification is by recorded hash rather than by
// re-compressing and comparing. A mixed-codec archive is therefore fully verifiable; it
// simply is not bit-reproducible from the source.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

function parseArgs(argv) {
  const options = { sample: 24, full: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--full') { options.full = true; continue; }
    const value = argv[index + 1];
    switch (argument) {
      case '--archive': options.archive = value; index += 1; break;
      case '--source': options.source = value; index += 1; break;
      case '--sample': options.sample = Number(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.archive) {
    throw new Error('usage: verify-archive.mjs --archive <dir> [--source <dir>] [--sample 24] [--full]');
  }
  return options;
}

async function hashFile(path, transform) {
  const digest = createHash('sha256');
  const seen = new PassThrough();
  seen.on('data', (chunk) => digest.update(chunk));
  const stages = [createReadStream(path)];
  if (transform) stages.push(transform);
  stages.push(seen);
  await pipeline(...stages);
  return digest.digest('hex');
}

const options = parseArgs(process.argv.slice(2));
const archive = resolve(options.archive);
const manifestPath = join(archive, 'manifest.jsonl');
if (!existsSync(manifestPath)) throw new Error('no manifest at ' + manifestPath);

const entries = readFileSync(manifestPath, 'utf8')
  .split('\n')
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line));

const byPath = new Map();
const duplicates = [];
for (const entry of entries) {
  if (byPath.has(entry.relativePath)) duplicates.push(entry.relativePath);
  byPath.set(entry.relativePath, entry);
}

const codecs = new Map();
let originalTotal = 0;
let packedTotal = 0;
for (const entry of byPath.values()) {
  const codec = entry.codec ?? '(unrecorded)';
  codecs.set(codec, (codecs.get(codec) ?? 0) + 1);
  originalTotal += entry.originalBytes;
  packedTotal += entry.packedBytes;
}

console.log('archive        : ' + archive);
console.log('manifest lines : ' + entries.length +
  (duplicates.length ? ' (' + duplicates.length + ' duplicate path(s))' : ''));
console.log('unique entries : ' + byPath.size);
console.log('original       : ' + (originalTotal / 1024 ** 3).toFixed(2) + ' GB');
console.log('packed         : ' + (packedTotal / 1024 ** 3).toFixed(2) + ' GB');
console.log('ratio          : ' + (originalTotal / packedTotal).toFixed(2) + 'x');
for (const [codec, count] of codecs) console.log('codec          : ' + codec + ' x' + count);
console.log('');

// Pass 1: every entry must be present, the right size, and hash to what was recorded.
let missing = 0;
let sizeMismatch = 0;
let packedMismatch = 0;
let checked = 0;
for (const entry of byPath.values()) {
  const path = join(archive, entry.relativePath + '.zst');
  if (!existsSync(path)) { missing += 1; console.error('  MISSING: ' + entry.relativePath); continue; }
  if (statSync(path).size !== entry.packedBytes) {
    sizeMismatch += 1;
    console.error('  SIZE DRIFT: ' + entry.relativePath);
    continue;
  }
  const digest = await hashFile(path);
  checked += 1;
  if (digest !== entry.packedSha256) {
    packedMismatch += 1;
    console.error('  PACKED HASH MISMATCH: ' + entry.relativePath);
  }
}
console.log('present + packed hash : ' + (checked - packedMismatch) + ' / ' + byPath.size + ' ok');
if (missing) console.log('missing               : ' + missing);
if (sizeMismatch) console.log('size drift            : ' + sizeMismatch);

// Pass 2: prove the original bytes come back. Deterministic sample so a rerun checks the
// same files and a failure is reproducible.
const all = [...byPath.values()].sort((left, right) =>
  left.relativePath.localeCompare(right.relativePath));
const stride = options.full ? 1 : Math.max(1, Math.floor(all.length / Math.max(1, options.sample)));
const selected = options.full ? all : all.filter((_, index) => index % stride === 0);

let restored = 0;
let restoreFailed = 0;
let sourceChecked = 0;
let sourceDrift = 0;
for (const entry of selected) {
  const path = join(archive, entry.relativePath + '.zst');
  if (!existsSync(path)) continue;
  // A damaged frame makes the decompressor throw rather than return wrong bytes. That is
  // a verification result, not a crash: catch it so the run still reports every other
  // entry instead of dying on the first bad one.
  let digest = null;
  let unreadable = false;
  try {
    digest = await hashFile(path, createZstdDecompress());
  } catch (error) {
    unreadable = true;
    restoreFailed += 1;
    console.error('  UNREADABLE ARCHIVE ENTRY: ' + entry.relativePath +
      ' (' + (error.code ?? error.message) + ')');
  }
  if (!unreadable) {
    if (digest === entry.originalSha256) restored += 1;
    else { restoreFailed += 1; console.error('  ROUND-TRIP MISMATCH: ' + entry.relativePath); }
  }

  // If the originals are still on disk, check them too: that is what makes "safe to
  // prune" a measurement rather than an assumption.
  if (options.source) {
    const originalPath = join(resolve(options.source), entry.relativePath);
    if (existsSync(originalPath)) {
      sourceChecked += 1;
      const live = await hashFile(originalPath);
      if (live !== entry.originalSha256) {
        sourceDrift += 1;
        console.error('  SOURCE CHANGED SINCE ARCHIVE: ' + entry.relativePath);
      }
    }
  }
}

console.log('round-trip decompress : ' + restored + ' / ' + selected.length +
  (options.full ? ' (full)' : ' (sample, stride ' + stride + ')'));
if (options.source) {
  console.log('source still matches  : ' + (sourceChecked - sourceDrift) + ' / ' + sourceChecked +
    (sourceDrift ? ' - drifted files are NOT safe to prune from this archive' : ''));
}

// Source drift counts as a failure. This command exists to answer "is it safe to delete
// the originals", and a drifted original is precisely the case where the answer is no, so
// reporting it while exiting 0 turns the exit code into a trap for anyone scripting the
// check.
const failures = missing + sizeMismatch + packedMismatch + restoreFailed + sourceDrift;
console.log('');
if (failures === 0) {
  console.log('archive verified: every checked entry is intact and restores to its original hash');
} else {
  console.log('archive NOT verified: ' + failures + ' problem(s) above');
}
process.exit(failures === 0 ? 0 : 1);
