#!/usr/bin/env bun
// Moves archived originals into a quarantine directory, reversibly.
//
// Pruning is a rename, not a delete. Every moved file is recorded in a ledger with the
// hash it had at move time, and --restore puts them all back and re-checks those hashes,
// so the operation is reversible until someone deliberately deletes the quarantine.
//
// That also means this script frees no disk space by itself. Reclaiming the space is a
// separate, destructive act on the quarantine directory, taken only once the restore
// path has been exercised. Saying otherwise would make a two-phase design sound like a
// one-phase one.
//
// Nothing is moved on the manifest's word alone. A file is a candidate only if, right
// now: it is older than the retention window, the archive entry exists, the live file
// still hashes to what was archived, and the archive still decompresses to that same
// hash. A file that drifted since archiving is reported and left alone, because the
// archive no longer represents it.
import { createHash } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough } from 'node:stream';
import { createZstdDecompress } from 'node:zlib';

function parseArgs(argv) {
  const options = { keepDays: 14, limit: Infinity, execute: false, restore: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') { options.execute = true; continue; }
    if (argument === '--restore') { options.restore = true; continue; }
    const value = argv[index + 1];
    switch (argument) {
      case '--source': options.source = value; index += 1; break;
      case '--archive': options.archive = value; index += 1; break;
      case '--quarantine': options.quarantine = value; index += 1; break;
      case '--ledger': options.ledger = value; index += 1; break;
      case '--keep-days': options.keepDays = Number(value); index += 1; break;
      case '--limit': options.limit = Number(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.source || !options.archive || !options.quarantine) {
    throw new Error('usage: prune-archived-corpus.mjs --source <dir> --archive <dir> ' +
      '--quarantine <dir> [--ledger <path>] [--keep-days 14] [--limit n] [--execute] [--restore]');
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

function ledgerEntries(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

// Leave the tree tidy without ever removing a directory that still holds anything.
function pruneEmptyParents(path, stopAt) {
  let current = dirname(path);
  const boundary = resolve(stopAt);
  while (resolve(current).startsWith(boundary) && resolve(current) !== boundary) {
    try { rmdirSync(current); } catch { return; }
    current = dirname(current);
  }
}

const options = parseArgs(process.argv.slice(2));
const source = resolve(options.source);
const archive = resolve(options.archive);
const quarantine = resolve(options.quarantine);
// The ledger defaults to living inside the quarantine, which is convenient and also the
// one place it should not be if the quarantine is ever deleted: that deletion would take
// the record of what was removed with it. --ledger keeps it somewhere that outlives the
// files it describes, and restore reads it from there.
const ledgerPath = options.ledger
  ? resolve(options.ledger)
  : join(quarantine, 'prune-ledger.jsonl');

if (options.restore) {
  const entries = ledgerEntries(ledgerPath);
  console.log('quarantine    : ' + quarantine);
  console.log('ledger entries: ' + entries.length);
  console.log('mode          : ' + (options.execute ? 'execute' : 'plan (no moves)'));
  console.log('');
  if (!options.execute) {
    console.log('plan only; rerun with --execute to restore');
    process.exit(0);
  }

  let restored = 0;
  let mismatched = 0;
  let absent = 0;
  let occupied = 0;
  for (const entry of entries) {
    const held = join(quarantine, entry.relativePath);
    const target = join(source, entry.relativePath);
    if (!existsSync(held)) { absent += 1; continue; }
    if (existsSync(target)) {
      // Something recreated the original. Restoring would destroy it, so refuse.
      occupied += 1;
      console.error('  TARGET OCCUPIED, NOT RESTORED: ' + entry.relativePath);
      continue;
    }
    // Hash before the move, so a corrupted quarantine is caught rather than moved back.
    const digest = await hashFile(held);
    if (digest !== entry.sha256) {
      mismatched += 1;
      console.error('  QUARANTINE CONTENT CHANGED: ' + entry.relativePath);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    renameSync(held, target);
    pruneEmptyParents(held, quarantine);
    restored += 1;
  }

  console.log('restored      : ' + restored + ' / ' + entries.length);
  if (absent) console.log('already gone  : ' + absent);
  if (occupied) console.log('blocked       : ' + occupied + ' (a live file occupies the path)');
  if (mismatched) console.log('corrupted     : ' + mismatched);
  const failures = mismatched + occupied;
  console.log('');
  console.log(failures === 0
    ? 'restore complete: every restored file matches the hash it had when pruned'
    : 'restore incomplete: ' + failures + ' file(s) above were left in quarantine');
  process.exit(failures === 0 ? 0 : 1);
}

const manifestPath = join(archive, 'manifest.jsonl');
if (!existsSync(manifestPath)) throw new Error('no manifest at ' + manifestPath);
const manifest = readFileSync(manifestPath, 'utf8').split('\n')
  .filter((line) => line.trim()).map((line) => JSON.parse(line));

const cutoff = Date.now() - (options.keepDays * 24 * 3600 * 1000);
const alreadyPruned = new Set(ledgerEntries(ledgerPath).map((entry) => entry.relativePath));

const candidates = [];
const held = { recent: 0, unverified: 0, gone: 0, alreadyPruned: 0 };
for (const entry of manifest) {
  if (alreadyPruned.has(entry.relativePath)) { held.alreadyPruned += 1; continue; }
  if (entry.roundTrip !== 'verified') { held.unverified += 1; continue; }
  const path = join(source, entry.relativePath);
  if (!existsSync(path)) { held.gone += 1; continue; }
  // The retention window is the point of "not all of them": the newest, still-active
  // transcripts stay where the agents expect them.
  if (statSync(path).mtimeMs > cutoff) { held.recent += 1; continue; }
  candidates.push({ entry, path });
}
candidates.sort((left, right) => left.entry.relativePath.localeCompare(right.entry.relativePath));
const selected = candidates.slice(0, options.limit);

console.log('source        : ' + source);
console.log('archive       : ' + archive);
console.log('quarantine    : ' + quarantine);
console.log('manifest      : ' + manifest.length + ' entry(ies)');
console.log('retention     : keep files modified in the last ' + options.keepDays + ' day(s)');
console.log('  held, recent      : ' + held.recent);
console.log('  held, unverified  : ' + held.unverified);
console.log('  already pruned    : ' + held.alreadyPruned);
console.log('  no longer present : ' + held.gone);
console.log('candidates    : ' + candidates.length +
  (selected.length !== candidates.length ? ' (limited to ' + selected.length + ')' : ''));
console.log('mode          : ' + (options.execute ? 'execute' : 'plan (no moves)'));
console.log('');

let bytes = 0;
let verified = 0;
let drifted = 0;
let unreadable = 0;
const ready = [];
for (const candidate of selected) {
  const live = await hashFile(candidate.path);
  if (live !== candidate.entry.originalSha256) {
    drifted += 1;
    console.error('  CHANGED SINCE ARCHIVE, NOT PRUNABLE: ' + candidate.entry.relativePath);
    continue;
  }
  const packedPath = join(archive, candidate.entry.relativePath + '.zst');
  let restoredDigest = null;
  try {
    restoredDigest = await hashFile(packedPath, createZstdDecompress());
  } catch {
    unreadable += 1;
    console.error('  ARCHIVE ENTRY UNREADABLE, NOT PRUNABLE: ' + candidate.entry.relativePath);
    continue;
  }
  if (restoredDigest !== live) {
    unreadable += 1;
    console.error('  ARCHIVE DOES NOT RESTORE THIS FILE: ' + candidate.entry.relativePath);
    continue;
  }
  verified += 1;
  bytes += candidate.entry.originalBytes;
  // Remember what the file looked like when it was verified, so the move can refuse if it
  // changed in between. Codex rewrites rollouts in place and this loop can run for
  // minutes across a large corpus.
  const stamp = statSync(candidate.path);
  ready.push({ ...candidate, sha256: live, verifiedSize: stamp.size, verifiedMtimeMs: stamp.mtimeMs });
}

console.log('re-verified   : ' + verified + ' / ' + selected.length);
if (drifted) console.log('drifted       : ' + drifted + ' (archive no longer represents these)');
if (unreadable) console.log('unrestorable  : ' + unreadable);
console.log('would move    : ' + (bytes / 1024 ** 3).toFixed(2) + ' GB into quarantine');
console.log('');

if (!options.execute) {
  console.log('plan only; rerun with --execute to move these files into quarantine');
  process.exit(0);
}

mkdirSync(quarantine, { recursive: true });
let moved = 0;
let blocked = 0;
let raced = 0;
for (const item of ready) {
  const target = join(quarantine, item.entry.relativePath);
  if (existsSync(target)) {
    blocked += 1;
    console.error('  QUARANTINE PATH OCCUPIED: ' + item.entry.relativePath);
    continue;
  }
  // Re-check immediately before the move. Verification happened earlier in the run, and a
  // file rewritten since then is no longer the one the archive holds.
  const now = existsSync(item.path) ? statSync(item.path) : null;
  if (!now || now.size !== item.verifiedSize || now.mtimeMs !== item.verifiedMtimeMs) {
    raced += 1;
    console.error('  CHANGED SINCE VERIFICATION, NOT MOVED: ' + item.entry.relativePath);
    continue;
  }
  mkdirSync(dirname(target), { recursive: true });
  renameSync(item.path, target);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  writeFileSync(ledgerPath, JSON.stringify({
    schemaVersion: 1,
    relativePath: item.entry.relativePath,
    sha256: item.sha256,
    bytes: item.entry.originalBytes,
    archivedPacked: item.entry.relativePath + '.zst',
    sourceRoot: source,
    prunedAt: new Date().toISOString()
  }) + '\n', { flag: 'a' });
  pruneEmptyParents(item.path, source);
  moved += 1;
}

console.log('moved         : ' + moved + ' file(s) into quarantine');
if (blocked) console.log('blocked       : ' + blocked);
if (raced) console.log('changed late  : ' + raced + ' (rewritten after verification, left in place)');
console.log('ledger        : ' + ledgerPath);
console.log('');
console.log('These files are still on disk, so no space has been reclaimed yet. Restore');
console.log('them with --restore, or reclaim the space by deleting the quarantine');
console.log('directory once you are satisfied - that deletion is the irreversible step.');
process.exit(blocked === 0 && raced === 0 ? 0 : 1);
