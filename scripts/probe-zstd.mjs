#!/usr/bin/env bun
// Probes what zstd can actually do here before the archive design commits to it.
// Uses the Bun-native API, which is what the rest of this repo uses, and cross-checks
// it against the node:zlib shim so the archive does not depend on which one wrote it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const sample = process.argv[2];
const capMb = Number(process.argv[3] ?? 32);
if (!sample) {
  console.error('usage: bun scripts/probe-zstd.mjs <file-or-dir> [capMB]');
  process.exit(1);
}

function pickFile(path) {
  if (statSync(path).isFile()) return path;
  const scored = readdirSync(path)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => ({ name, size: statSync(join(path, name)).size }))
    .sort((left, right) => right.size - left.size);
  if (scored.length === 0) throw new Error('no .jsonl found in ' + path);
  return join(path, scored[0].name);
}

const file = pickFile(sample);
const raw = readFileSync(file);
const cap = capMb * 1024 * 1024;
const input = raw.length > cap ? raw.subarray(0, cap) : raw;

console.log('probe file : ' + file.split(/[\\/]/).at(-1).slice(0, 48));
console.log('probe bytes: ' + (input.length / 1024 / 1024).toFixed(1) + ' MB');
console.log('');
console.log('level |  ratio |   packed |  compress | round-trip');
console.log('------|--------|----------|-----------|-----------');

let best = null;
for (const level of [3, 9, 19]) {
  const started = performance.now();
  const packed = Bun.zstdCompressSync(input, { level });
  const elapsed = performance.now() - started;
  const back = Bun.zstdDecompressSync(packed);
  const identical = Buffer.compare(Buffer.from(back), input) === 0;
  console.log(
    String(level).padStart(5) + ' | ' +
    (input.length / packed.length).toFixed(2).padStart(5) + 'x | ' +
    (packed.length / 1024 / 1024).toFixed(1).padStart(6) + ' MB | ' +
    (elapsed / 1000).toFixed(1).padStart(7) + ' s | ' +
    (identical ? 'identical' : 'MISMATCH')
  );
  if (level === 19) best = packed;
}

console.log('');
// The archive must be reproducible, or "verify by re-compressing" is not available.
const again = Bun.zstdCompressSync(input, { level: 19 });
console.log('deterministic at level 19      : ' + (Buffer.compare(best, again) === 0));

// And it must not matter which implementation produced the file.
const zlib = await import('node:zlib');
const viaZlib = zlib.zstdCompressSync(input, {
  params: { [zlib.constants.ZSTD_c_compressionLevel]: 19 }
});
const crossOk = Buffer.compare(
  Buffer.from(Bun.zstdDecompressSync(viaZlib)),
  input
) === 0;
console.log('node:zlib output reads in Bun  : ' + crossOk);
console.log('byte-identical across the two  : ' + (Buffer.compare(best, viaZlib) === 0));
