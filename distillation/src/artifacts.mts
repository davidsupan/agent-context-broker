import { lstatSync } from 'node:fs';
import { readPrefix, sha256Hasher } from './platform.mts';
import { z } from 'zod';
import { noLinks } from './store.mts';

const LimitSchema = z.number().int().min(1).max(2 ** 40);

/** SHA-256 of bounded bytes actually read, not a claim of source immutability. */
export async function hashArtifact(path: string, maxBytes: number) {
  LimitSchema.parse(maxBytes);
  noLinks(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.size > maxBytes) throw new Error('artifact-size-or-kind');
  const hasher = sha256Hasher();
  let bytes = 0;
  // Slice caps I/O even if the file grows while streaming. No whole-file buffer.
  for await (const chunk of readPrefix(path, maxBytes + 1)) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new Error('artifact-size-limit');
    hasher.update(chunk);
  }
  noLinks(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size) {
    throw new Error('artifact-changed');
  }
  return { sha256: hasher.digest('hex'), bytes };
}
