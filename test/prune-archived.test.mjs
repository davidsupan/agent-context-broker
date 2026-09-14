import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const roots = [];

function testRoot(name) {
  const path = join(tmpdir(), `acb-prune-${name}-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

// `days` old, so the retention window can be exercised without waiting.
function corpus(root, files = 4, days = 40) {
  mkdirSync(join(root, '2026', '09'), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    const lines = [];
    for (let line = 0; line < 200; line += 1) {
      lines.push(JSON.stringify({ type: 'message', session: index, turn: line }));
    }
    const path = join(root, '2026', '09', `rollout-${index}.jsonl`);
    writeFileSync(path, lines.join('\n') + '\n');
    const when = new Date(Date.now() - (days * 24 * 3600 * 1000));
    utimesSync(path, when, when);
  }
  return root;
}

function run(script, args) {
  return spawnSync(process.execPath, [join(packageRoot, 'scripts', script), ...args], {
    encoding: 'utf8'
  });
}

function archive(source, target) {
  return run('archive-corpus.mjs', [
    '--source', source, '--archive', target, '--min-age-hours', '0', '--execute'
  ]);
}

function prune(source, target, quarantine, extra = []) {
  return run('prune-archived-corpus.mjs', [
    '--source', source, '--archive', target, '--quarantine', quarantine, ...extra
  ]);
}

function original(root, index) {
  return join(root, '2026', '09', `rollout-${index}.jsonl`);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('pruning is reversible and never runs on the manifest alone', () => {
  test('moves archived originals to quarantine and restores them byte-for-byte', () => {
    const source = corpus(testRoot('source'));
    const target = testRoot('target');
    const quarantine = testRoot('quarantine');
    assert.equal(archive(source, target).status, 0);

    const before = [0, 1, 2, 3].map((index) => readFileSync(original(source, index)));

    const pruned = prune(source, target, quarantine, ['--keep-days', '7', '--execute']);
    assert.equal(pruned.status, 0, pruned.stderr);
    assert.match(pruned.stdout, /moved {9}: 4 file\(s\)/);
    for (let index = 0; index < 4; index += 1) {
      assert.equal(existsSync(original(source, index)), false);
      assert.equal(existsSync(join(quarantine, '2026', '09', `rollout-${index}.jsonl`)), true);
    }
    // The point of a rename: the bytes never left the disk, so nothing is reclaimed yet.
    assert.match(pruned.stdout, /no space has been reclaimed yet/);

    const restored = prune(source, target, quarantine, ['--restore', '--execute']);
    assert.equal(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /restored {6}: 4 \/ 4/);
    for (let index = 0; index < 4; index += 1) {
      assert.equal(Buffer.compare(readFileSync(original(source, index)), before[index]), 0);
    }
  });

  test('keeps recent files and prunes only what is past the retention window', () => {
    const source = corpus(testRoot('source-window'));
    // Two of the four are active work; they must stay where the agents expect them.
    const fresh = new Date();
    utimesSync(original(source, 2), fresh, fresh);
    utimesSync(original(source, 3), fresh, fresh);
    const target = testRoot('target-window');
    const quarantine = testRoot('quarantine-window');
    assert.equal(archive(source, target).status, 0);

    const result = prune(source, target, quarantine, ['--keep-days', '14', '--execute']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /held, recent {6}: 2/);
    assert.match(result.stdout, /moved {9}: 2 file\(s\)/);
    assert.equal(existsSync(original(source, 2)), true);
    assert.equal(existsSync(original(source, 3)), true);
    assert.equal(existsSync(original(source, 0)), false);
  });

  test('plans without moving anything', () => {
    const source = corpus(testRoot('source-plan'));
    const target = testRoot('target-plan');
    const quarantine = testRoot('quarantine-plan');
    assert.equal(archive(source, target).status, 0);

    const result = prune(source, target, quarantine, ['--keep-days', '7']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /plan only/);
    for (let index = 0; index < 4; index += 1) {
      assert.equal(existsSync(original(source, index)), true);
    }
  });

  test('honours a limit, so a small batch can be proven before the rest', () => {
    const source = corpus(testRoot('source-limit'));
    const target = testRoot('target-limit');
    const quarantine = testRoot('quarantine-limit');
    assert.equal(archive(source, target).status, 0);

    assert.equal(prune(source, target, quarantine,
      ['--keep-days', '7', '--limit', '1', '--execute']).status, 0);
    assert.equal(existsSync(original(source, 0)), false);
    assert.equal(existsSync(original(source, 1)), true);

    // A second run must not re-offer what the ledger already records.
    const second = prune(source, target, quarantine, ['--keep-days', '7']);
    assert.match(second.stdout, /already pruned {4}: 1/);
    assert.match(second.stdout, /candidates {4}: 3/);
  });
});

describe('a file the archive cannot restore is never pruned', () => {
  test('refuses a file that changed after it was archived', () => {
    const source = corpus(testRoot('source-drift'));
    const target = testRoot('target-drift');
    const quarantine = testRoot('quarantine-drift');
    assert.equal(archive(source, target).status, 0);

    // Codex rewrites rollouts in place. The archived copy is then not this file.
    const path = original(source, 1);
    writeFileSync(path, JSON.stringify({ type: 'message', content: 'rewritten' }) + '\n');
    const old = new Date(Date.now() - (40 * 24 * 3600 * 1000));
    utimesSync(path, old, old);

    const result = prune(source, target, quarantine, ['--keep-days', '7', '--execute']);
    assert.match(result.stdout + result.stderr, /CHANGED SINCE ARCHIVE, NOT PRUNABLE/);
    assert.match(result.stdout, /re-verified {3}: 3 \/ 4/);
    assert.equal(existsSync(path), true, 'a drifted original must stay put');
  });

  test('refuses a file whose archive entry is corrupted', () => {
    const source = corpus(testRoot('source-corrupt'));
    const target = testRoot('target-corrupt');
    const quarantine = testRoot('quarantine-corrupt');
    assert.equal(archive(source, target).status, 0);

    const packed = join(target, '2026', '09', 'rollout-2.jsonl.zst');
    const bytes = readFileSync(packed);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(packed, bytes);

    const result = prune(source, target, quarantine, ['--keep-days', '7', '--execute']);
    assert.match(result.stdout + result.stderr, /NOT PRUNABLE|DOES NOT RESTORE/);
    assert.equal(existsSync(original(source, 2)), true);
    assert.match(result.stdout, /moved {9}: 3 file\(s\)/);
  });

  test('refuses to restore over a file that came back on its own', () => {
    const source = corpus(testRoot('source-occupied'));
    const target = testRoot('target-occupied');
    const quarantine = testRoot('quarantine-occupied');
    assert.equal(archive(source, target).status, 0);
    assert.equal(prune(source, target, quarantine, ['--keep-days', '7', '--execute']).status, 0);

    // A new session wrote to the same path after the prune; restoring must not clobber it.
    const path = original(source, 0);
    mkdirSync(join(source, '2026', '09'), { recursive: true });
    writeFileSync(path, JSON.stringify({ type: 'message', content: 'new session' }) + '\n');
    const live = readFileSync(path);

    const restored = prune(source, target, quarantine, ['--restore', '--execute']);
    assert.equal(restored.status, 1);
    assert.match(restored.stdout + restored.stderr, /TARGET OCCUPIED/);
    assert.equal(Buffer.compare(readFileSync(path), live), 0);
  });

  test('refuses to restore quarantined content that was tampered with', () => {
    const source = corpus(testRoot('source-tamper'));
    const target = testRoot('target-tamper');
    const quarantine = testRoot('quarantine-tamper');
    assert.equal(archive(source, target).status, 0);
    assert.equal(prune(source, target, quarantine, ['--keep-days', '7', '--execute']).status, 0);

    writeFileSync(join(quarantine, '2026', '09', 'rollout-1.jsonl'), 'tampered\n');

    const restored = prune(source, target, quarantine, ['--restore', '--execute']);
    assert.equal(restored.status, 1);
    assert.match(restored.stdout + restored.stderr, /QUARANTINE CONTENT CHANGED/);
    assert.equal(existsSync(original(source, 1)), false, 'tampered content must not be restored');
    // The other three still come back; one bad file does not block the rest.
    assert.match(restored.stdout, /restored {6}: 3 \/ 4/);
  });

  test('the ledger records the hash each file had when it was moved', () => {
    const source = corpus(testRoot('source-ledger'));
    const target = testRoot('target-ledger');
    const quarantine = testRoot('quarantine-ledger');
    const expected = [0, 1, 2, 3].map((index) => sha(readFileSync(original(source, index))));
    assert.equal(archive(source, target).status, 0);
    assert.equal(prune(source, target, quarantine, ['--keep-days', '7', '--execute']).status, 0);

    const ledger = readFileSync(join(quarantine, 'prune-ledger.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    assert.equal(ledger.length, 4);
    assert.deepEqual(ledger.map((entry) => entry.sha256).sort(), [...expected].sort());
    for (const entry of ledger) assert.equal(entry.sourceRoot, source);
  });
});
