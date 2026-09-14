import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');
const roots = [];

function testRoot(name) {
  const path = join(tmpdir(), `acb-archive-${name}-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  roots.push(path);
  return path;
}

// Transcript-shaped content: repetitive enough that zstd has something to find, which is
// what makes the ratio assertions below meaningful rather than incidental.
function corpus(root, files = 4) {
  mkdirSync(join(root, '2026', '09'), { recursive: true });
  for (let index = 0; index < files; index += 1) {
    const lines = [];
    for (let line = 0; line < 400; line += 1) {
      lines.push(JSON.stringify({
        type: 'message',
        role: line % 2 === 0 ? 'user' : 'assistant',
        timestamp: new Date(Date.UTC(2026, 8, 1, 0, line % 60)).toISOString(),
        content: `session ${index} turn ${line} discussing the archive round trip`
      }));
    }
    writeFileSync(join(root, '2026', '09', `rollout-${index}.jsonl`), lines.join('\n') + '\n');
  }
  return root;
}

function run(script, args) {
  return spawnSync(process.execPath, [join(packageRoot, 'scripts', script), ...args], {
    encoding: 'utf8'
  });
}

function archive(source, target, extra = []) {
  // min-age-hours 0 because the fixture was written a moment ago; the production default
  // deliberately skips files that may still be rewritten in place.
  return run('archive-corpus.mjs', [
    '--source', source, '--archive', target, '--min-age-hours', '0', '--execute', ...extra
  ]);
}

function entries(target) {
  return readFileSync(join(target, 'manifest.jsonl'), 'utf8')
    .split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe('corpus archiving proves recoverability per file', () => {
  test('archives every settled file and verifies the round trip', () => {
    const source = corpus(testRoot('source'));
    const target = testRoot('target');

    const result = archive(source, target);
    assert.equal(result.status, 0, result.stderr);

    const manifest = entries(target);
    assert.equal(manifest.length, 4);
    for (const entry of manifest) {
      assert.equal(entry.roundTrip, 'verified');
      // The recorded proof is the decompressed hash matching the original, not a claim
      // that compression succeeded.
      assert.equal(entry.restoredSha256, entry.originalSha256);
      assert.ok(entry.packedBytes < entry.originalBytes);
      assert.equal(entry.codec, 'node-zlib-zstd-stream');
    }

    const verify = run('verify-archive.mjs', ['--archive', target, '--source', source, '--full']);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    assert.match(verify.stdout, /archive verified/);
  });

  test('leaves the originals untouched, so archiving is never destructive', () => {
    const source = corpus(testRoot('source-intact'));
    const target = testRoot('target-intact');
    const before = readFileSync(join(source, '2026', '09', 'rollout-0.jsonl'));
    const stat = statSync(join(source, '2026', '09', 'rollout-0.jsonl'));

    assert.equal(archive(source, target).status, 0);

    const after = readFileSync(join(source, '2026', '09', 'rollout-0.jsonl'));
    assert.equal(Buffer.compare(before, after), 0);
    assert.equal(statSync(join(source, '2026', '09', 'rollout-0.jsonl')).size, stat.size);
  });

  test('resumes instead of rewriting what is already archived', () => {
    const source = corpus(testRoot('source-resume'));
    const target = testRoot('target-resume');

    assert.equal(archive(source, target).status, 0);
    const first = entries(target);

    writeFileSync(join(source, '2026', '09', 'rollout-4.jsonl'),
      JSON.stringify({ type: 'message', content: 'added later' }) + '\n');
    const second = archive(source, target);

    assert.equal(second.status, 0);
    assert.match(second.stdout, /resuming: 4 file\(s\) already archived/);
    assert.match(second.stdout, /archived {6}: 1 file\(s\)/);
    // Earlier entries must not be re-hashed under a new timestamp; resume means resume.
    const after = entries(target);
    assert.equal(after.length, 5);
    assert.deepEqual(after.slice(0, 4).map((e) => e.archivedAt), first.map((e) => e.archivedAt));
  });

  test('skips files that are still being written in place', () => {
    const source = corpus(testRoot('source-fresh'), 2);
    const target = testRoot('target-fresh');

    // Default min age: a rollout touched minutes ago is not settled, so it must not be
    // archived and then treated as prunable.
    const result = run('archive-corpus.mjs', [
      '--source', source, '--archive', target, '--execute'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /settled \(>24h\) : 0/);
  });
});

describe('the verifier fails when the archive is not actually intact', () => {
  test('detects a corrupted archive entry', () => {
    const source = corpus(testRoot('source-corrupt'));
    const target = testRoot('target-corrupt');
    assert.equal(archive(source, target).status, 0);

    const packed = join(target, '2026', '09', 'rollout-1.jsonl.zst');
    const bytes = readFileSync(packed);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    writeFileSync(packed, bytes);

    const verify = run('verify-archive.mjs', ['--archive', target, '--full']);
    assert.equal(verify.status, 1);
    assert.match(verify.stdout + verify.stderr, /PACKED HASH MISMATCH/);
    assert.match(verify.stdout, /archive NOT verified/);
  });

  test('detects a missing archive entry', () => {
    const source = corpus(testRoot('source-missing'));
    const target = testRoot('target-missing');
    assert.equal(archive(source, target).status, 0);

    rmSync(join(target, '2026', '09', 'rollout-2.jsonl.zst'));

    const verify = run('verify-archive.mjs', ['--archive', target, '--full']);
    assert.equal(verify.status, 1);
    assert.match(verify.stdout + verify.stderr, /MISSING/);
  });

  test('detects an original that changed after it was archived', () => {
    const source = corpus(testRoot('source-drift'));
    const target = testRoot('target-drift');
    assert.equal(archive(source, target).status, 0);

    // Codex rewrites rollouts in place. If that happened after archiving, the archive is
    // still valid but no longer represents the live file, and pruning it would lose data.
    writeFileSync(join(source, '2026', '09', 'rollout-3.jsonl'),
      JSON.stringify({ type: 'message', content: 'rewritten in place' }) + '\n');

    const verify = run('verify-archive.mjs', ['--archive', target, '--source', source, '--full']);
    assert.match(verify.stdout + verify.stderr, /SOURCE CHANGED SINCE ARCHIVE/);
    assert.match(verify.stdout, /NOT safe to prune/);
  });
});
