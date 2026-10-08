import { test, expect } from './expect.mts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashArtifact } from '../src/artifacts.mts';

test('streaming SHA-256 matches a standard known vector', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-artifact-'));
  try {
    const path = join(root, 'input');
    writeFileSync(path, 'abc');
    expect(await hashArtifact(path, 3)).toEqual({ bytes: 3,
      sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' });
    await expect(hashArtifact(path, 2)).rejects.toThrow('artifact-size-or-kind');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('empty artifact is hashed without inventing bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bun-artifact-'));
  try {
    const path = join(root, 'empty');
    writeFileSync(path, '');
    expect(await hashArtifact(path, 1)).toEqual({ bytes: 0,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
