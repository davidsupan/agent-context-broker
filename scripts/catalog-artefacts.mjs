#!/usr/bin/env bun
// Catalogs the material that was already written for handoff: ledgers, handoffs, ticket
// packages, workstream documents and consult outputs across one or more workbenches.
//
// This is the cheapest layer of historical distillation and the one with the best
// signal-to-noise: these files were written by people and agents specifically to carry
// state forward, so they are worth indexing before any transcript is read. No model is
// involved; the catalog records where each artefact is, what kind it is, which tickets and
// merge requests it names, when it was last touched, and its first heading or line.
//
// Nothing here reads the broker or writes to it, and the catalog never copies file bodies:
// only paths, hashes, keys and a one-line head.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

function parseArgs(argv) {
  const options = { roots: [], ticketProjects: ['OC', 'APP'], maxBytes: 4 * 1024 * 1024, includes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      // --root <label>=<dir>, repeatable
      case '--root': {
        const [label, dir] = String(value).split('=');
        if (!label || !dir) throw new Error('--root expects <label>=<directory>');
        options.roots.push({ label, dir: resolve(dir) });
        index += 1; break;
      }
      case '--out': options.out = resolve(value); index += 1; break;
      case '--ticket-projects':
        options.ticketProjects = String(value).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
        index += 1; break;
      case '--max-bytes': options.maxBytes = Number(value); index += 1; break;
      // --include <relative-dir>, repeatable: catalogue this subtree even though it sits
      // under a skipped directory. Consult outputs live under runtime/consults, which is
      // machine-local state in general but exactly the distilled material this catalog is
      // for, so it is opted in explicitly rather than by dropping the runtime skip.
      case '--include':
        options.includes.push(String(value).split('\\').join('/').replace(/\/+$/u, ''));
        index += 1; break;
      default: throw new Error('unknown argument: ' + argv[index]);
    }
  }
  if (options.roots.length === 0 || !options.out) {
    throw new Error('usage: catalog-artefacts.mjs --root <label>=<dir> [...] --out <dir> ' +
      '[--ticket-projects OC,APP] [--include runtime/consults]');
  }
  return options;
}

const sha = (value) => createHash('sha256').update(value).digest('hex');
const TICKET = /(?<![A-Z0-9])(?<project>[A-Z]{2,10})-(?<number>\d{1,9})(?![A-Z0-9])/gu;
const MERGE_REQUEST = /(?:(?<![\w])!|\bMR-)(?<iid>\d{3,7})\b/giu;

// Directories that hold generated or machine-local material rather than handoff prose.
const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'runtime', 'backups',
  'operation-backups', '.obsidian', 'dist', '.tmp', 'scan-artifacts', 'attachments']);

// Kind is decided from the path, cheapest first. Anything not recognised is still catalogued
// as 'document' so nothing written for handoff is silently dropped.
function classify(relativePath, name) {
  const lower = relativePath.toLowerCase();
  const file = name.toLowerCase();
  if (/ledger/u.test(file)) return 'ledger';
  if (/handoff|handover/u.test(file)) return 'handoff';
  if (/dossier/u.test(file)) return 'dossier';
  if (/^readme\.md$/u.test(file) && /(^|\/)tickets\/[a-z]+-\d+\//u.test(lower)) return 'ticket-package';
  if (/(^|\/)tickets\/[a-z]+-\d+\//u.test(lower)) return 'ticket-artefact';
  if (/(^|\/)consults?\//u.test(lower) || /consult/u.test(file)) return 'consult';
  if (/(^|\/)workstreams?\//u.test(lower)) return 'workstream-document';
  if (/(^|\/)(guidance|docs)\//u.test(lower)) return 'guidance';
  if (/(^|\/)skills?(-active)?\//u.test(lower)) return 'skill';
  if (/findings|evidence|review/u.test(file)) return 'review-evidence';
  return 'document';
}

function* walk(root, base = root, includes = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const path = join(root, entry.name);
      const relativeDir = relative(base, path).split(sep).join('/');
      // A skipped directory is still entered when an include names it or lies beneath it,
      // so `--include runtime/consults` reaches consults without opening all of runtime.
      const onIncludePath = includes.some((include) =>
        include === relativeDir || include.startsWith(relativeDir + '/') || relativeDir.startsWith(include + '/'));
      if (SKIP_DIRS.has(entry.name) && !onIncludePath) continue;
      yield* walk(path, base, includes);
    } else if (entry.isFile() && /\.(md|jsonl|json|txt)$/iu.test(entry.name)) {
      const relativeDir = relative(base, root).split(sep).join('/');
      // Inside a skipped subtree, only files under an include are catalogued.
      const skippedAncestor = relativeDir.split('/').some((segment) => SKIP_DIRS.has(segment));
      if (skippedAncestor && !includes.some((include) => relativeDir === include || relativeDir.startsWith(include + '/'))) continue;
      yield join(root, entry.name);
    }
  }
}

function headLine(text) {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === '---') continue;
    if (/^[a-z_-]+:\s/iu.test(trimmed) && !trimmed.startsWith('#')) continue; // frontmatter key
    return trimmed.replace(/^#+\s*/u, '').slice(0, 160);
  }
  return null;
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const rows = [];
const started = performance.now();
for (const root of options.roots) {
  if (!existsSync(root.dir)) { console.error('missing root: ' + root.dir); continue; }
  for (const path of walk(root.dir, root.dir, options.includes)) {
    const stat = statSync(path);
    if (stat.size > options.maxBytes) continue;
    const relativePath = relative(root.dir, path).split(sep).join('/');
    const bytes = readFileSync(path);
    const text = bytes.toString('utf8');
    const tickets = new Set();
    const mergeRequests = new Set();
    for (const match of (relativePath + '\n' + text).toUpperCase().matchAll(TICKET)) {
      if (options.ticketProjects.includes(match.groups.project)) tickets.add(`${match.groups.project}-${match.groups.number}`);
    }
    for (const match of text.matchAll(MERGE_REQUEST)) mergeRequests.add(`!${match.groups.iid}`);
    rows.push({
      workbench: root.label,
      relativePath,
      kind: classify(relativePath, basename(path)),
      bytes: stat.size,
      sha256: sha(bytes),
      modifiedAt: new Date(stat.mtimeMs).toISOString(),
      ticketKeys: [...tickets].sort(),
      mergeRequests: [...mergeRequests].sort(),
      head: headLine(text)
    });
  }
}

rows.sort((left, right) => left.workbench.localeCompare(right.workbench) || left.relativePath.localeCompare(right.relativePath));
const catalogPath = join(options.out, 'catalog-artefacts.jsonl');
writeFileSync(catalogPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const byKind = {};
const byWorkbench = {};
for (const row of rows) {
  byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
  byWorkbench[row.workbench] = (byWorkbench[row.workbench] ?? 0) + 1;
}
const ticketKeys = new Set(rows.flatMap((row) => row.ticketKeys));
console.log('artefacts         : ' + rows.length + '  (' + (rows.reduce((s, r) => s + r.bytes, 0) / 1024 / 1024).toFixed(1) + ' MB)');
for (const [workbench, count] of Object.entries(byWorkbench)) console.log('  ' + workbench.padEnd(18) + count);
console.log('by kind           : ' + Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + '=' + v).join(', '));
console.log('distinct tickets  : ' + ticketKeys.size);
console.log('catalog           : ' + catalogPath);
console.log('elapsed           : ' + ((performance.now() - started) / 1000).toFixed(1) + ' s');
