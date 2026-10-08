import { lstatSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { emergencyHome, type EmergencyOptions } from './emergency.mts';

const filename = /^\d{4}-\d{2}-\d{2}T\d{9}Z-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/u;
export function pruneInjectionAudit(options: EmergencyOptions) {
  const days = Number(options.olderThanDays ?? 30);
  if (!Number.isFinite(days) || days < 0) throw Object.assign(new Error('--older-than-days must be nonnegative.'), { exitCode: 2 });
  const home = emergencyHome(options);
  if (!home) throw new Error('A runtime home is required.');
  const directory = resolve(home, 'runtime', 'query-audit', 'injections');
  // Refuse directory symlinks/junctions, including all intermediate directories.
  for (const path of [home, join(home, 'runtime'), join(home, 'runtime', 'query-audit'), directory]) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())) throw new Error('Audit directory must be a regular directory.');
  }
  const cutoff = +new Date(options.now ?? Date.now()) - days * 86400000;
  const kept: string[] = [];
  let candidates = 0, bytesFreed = 0, deleted = 0;
  for (const entry of existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []) {
    if (!entry.isFile() || !filename.test(entry.name)) continue;
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const stamp = entry.name.slice(0, 21);
    const iso = `${stamp.slice(0, 13)}:${stamp.slice(13, 15)}:${stamp.slice(15, 17)}.${stamp.slice(17, 20)}Z`;
    if (!Number.isFinite(Date.parse(iso))) continue;
    if (Date.parse(iso) >= cutoff) { kept.push(iso); continue; }
    candidates++; bytesFreed += stat.size;
    if (options.execute) {
      const current = lstatSync(path);
      if (!current.isFile() || current.isSymbolicLink() || current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs) throw new Error('Audit file changed during prune.');
      unlinkSync(path); deleted++;
    }
  }
  kept.sort();
  return { schemaVersion: 1, writesEnabled: options.execute === true, olderThanDays: days,
    candidates, deleted, kept: kept.length, oldestKept: kept[0] ?? null, newestKept: kept.at(-1) ?? null, bytesFreed };
}
