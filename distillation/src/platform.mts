// The runtime services the distillation module needs, on Node 24 only: hashing, a bounded file read, stdin,
// glob matching and the one TOML value it reads. Everything that used to come from Bun goes through here, so the
// rest of the module never touches a runtime global.

import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { matchesGlob } from 'node:path';

/** An incremental SHA-256: `update` as often as needed, then one `digest('hex')`. */
export type Sha256 = { update(data: string | Uint8Array): Sha256; digest(encoding: 'hex'): string };

export function sha256Hasher(): Sha256 {
  const hash: Hash = createHash('sha256');
  const self: Sha256 = {
    update(data) { hash.update(data); return self; },
    digest(encoding) { return hash.digest(encoding); },
  };
  return self;
}

/** The hex SHA-256 of a string (UTF-8) or bytes. */
export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The first `maxBytes` bytes of a file as a stream of chunks (fewer when the file is shorter). */
export async function* readPrefix(path: string, maxBytes: number): AsyncGenerator<Uint8Array> {
  if (maxBytes <= 0) return;
  for await (const chunk of createReadStream(path, { start: 0, end: maxBytes - 1 })) yield chunk as Uint8Array;
}

/** All of standard input as UTF-8 text. */
export async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString('utf8');
}

/** A compiled glob with `match(path)` for the module's patterns. Paths use forward slashes. */
export type Glob = { match(path: string): boolean };

export function glob(pattern: string): Glob {
  const normal = pattern.replaceAll('\\', '/');
  return { match: (path: string) => matchesGlob(path.replaceAll('\\', '/'), normal) };
}

/**
 * The value of one top-level string key in a TOML document, or undefined. The module reads exactly one such key
 * (an automation's `status`), so a full TOML parser is not needed; a value it cannot read counts as absent.
 */
export function tomlString(text: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break; // the first table ends the top level
    if (!new RegExp(`^\\s*${escaped}\\s*=`).test(line)) continue;
    if (value !== undefined) return undefined;
    const match = new RegExp(`^\\s*${escaped}\\s*=\\s*(?:"""([^"\\r\\n]*)"""|"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')\\s*(?:#.*)?$`).exec(line);
    if (!match) return undefined;
    try { value = match[1] ?? (match[2] !== undefined ? JSON.parse(`"${match[2]}"`) : match[3]); }
    catch { return undefined; }
  }
  return value;
}
