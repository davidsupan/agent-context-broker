#!/usr/bin/env node
// Type-checks the sources with `tsc` (strict, --checkJs for the JavaScript) against a committed baseline. The gate
// fails only on errors the baseline does not hold, so existing errors can be fixed one at a time and new ones
// cannot creep in. Migrated TypeScript files (.mts) have no baseline: any error in one fails the gate.
// An error is keyed by file, code and message, without line numbers, so an unrelated edit does not move it.
//
//   node scripts/check-types.mjs            check against typecheck-baseline.json
//   node scripts/check-types.mjs --update   rewrite the baseline; refused while any key grew, so it only shrinks
//   node scripts/check-types.mjs --init     write the first baseline; refused once one exists
//   node scripts/check-types.mjs --json     print the comparison as JSON
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baselinePath = join(root, 'typecheck-baseline.json');
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const args = new Set(process.argv.slice(2));

if (!existsSync(tsc)) {
  process.stderr.write('typescript is not installed: run npm ci first.\n');
  process.exit(2);
}

const run = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.json'), '--pretty', 'false'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.error) throw run.error;
const lines = `${run.stdout}${run.stderr}`.split(/\r?\n/);
const counts = {};
let unparsed = 0;
for (const line of lines) {
  const match = /^(.+?)\(\d+,\d+\): error (TS\d+): (.*)$/.exec(line);
  if (match) {
    const key = `${match[1].replace(/\\/g, '/')} | ${match[2]} | ${match[3]}`;
    counts[key] = (counts[key] ?? 0) + 1;
  } else if (/error TS\d+/.test(line)) unparsed += 1;
}
if (unparsed) {
  process.stderr.write(`tsc reported ${unparsed} error(s) outside a source file; fix the configuration first.\n${lines.filter((l) => /error TS/.test(l)).slice(0, 5).join('\n')}\n`);
  process.exit(2);
}

// TypeScript sources (.mts) are migrated files: they must be clean, so the baseline never holds them.
const typescriptErrors = Object.keys(counts).filter((key) => /\.mts \| /.test(key));
if (typescriptErrors.length) {
  for (const key of typescriptErrors) process.stderr.write(`migrated file must be clean: ${key} (${counts[key]})\n`);
  process.exit(1);
}

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, 'utf8')).errors ?? {} : {};
const grew = Object.entries(counts).filter(([key, n]) => n > (baseline[key] ?? 0)).map(([key, n]) => ({ key, now: n, baseline: baseline[key] ?? 0 }));
const shrank = Object.entries(baseline).filter(([key, n]) => (counts[key] ?? 0) < n).map(([key, n]) => ({ key, now: counts[key] ?? 0, baseline: n }));
const total = (o) => Object.values(o).reduce((s, n) => s + n, 0);
const summary = { errors: total(counts), baseline: total(baseline), new: grew.length, fixed: shrank.length };

if (args.has('--init') && existsSync(baselinePath)) {
  process.stderr.write('A baseline exists; use --update, which only shrinks it.\n');
  process.exit(1);
}
if (args.has('--update') || args.has('--init')) {
  if (grew.length && !args.has('--init')) {
    process.stderr.write(`Refusing to update: ${grew.length} key(s) grew. Fix them; the baseline only shrinks.\n`);
    for (const g of grew.slice(0, 20)) process.stderr.write(`  + ${g.key} (${g.baseline} -> ${g.now})\n`);
    process.exit(1);
  }
  const sorted = Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(baselinePath, `${JSON.stringify({ schemaVersion: 1, note: 'Known tsc --checkJs errors; only shrinks (scripts/check-types.mjs --update).', total: total(sorted), errors: sorted }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ updated: true, ...summary })}\n`);
  process.exit(0);
}

if (args.has('--json')) process.stdout.write(`${JSON.stringify({ ...summary, grew, shrank }, null, 2)}\n`);
else {
  for (const g of grew) process.stderr.write(`new: ${g.key} (${g.baseline} -> ${g.now})\n`);
  if (shrank.length) process.stdout.write(`${shrank.length} baseline key(s) fixed; run node scripts/check-types.mjs --update to shrink the baseline.\n`);
  process.stdout.write(`typecheck: ${summary.errors} known error(s), baseline ${summary.baseline}, ${summary.new} new.\n`);
}
process.exit(grew.length ? 1 : 0);
