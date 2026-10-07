#!/usr/bin/env node
// Stages the npm package in build/package: TypeScript sources (.mts) become plain JavaScript (.mjs), types stripped
// by Node, and every relative import of a .mts module is rewritten to .mjs. The installed layout therefore stays
// .mjs only: hooks, launchers, install-state and archives name the same paths as before the TypeScript migration,
// and the package also runs under node_modules, where Node refuses to strip types.
//
//   node scripts/build-package.mjs           stage build/package (then: npm pack ./build/package)
//   node scripts/build-package.mjs --json    print the staged file counts as JSON
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// stripTypeScriptTypes is experimental on Node 24 and warns once; the build output is checked below instead.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = /** @type {typeof process.emitWarning} */ ((warning, ...rest) => {
  if (!String(warning).includes('stripTypeScriptTypes')) emitWarning(warning, .../** @type {[any]} */ (rest));
});

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, 'build', 'package');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const slash = (path) => relative(stage, path).split(sep).join('/');

// A relative module specifier that names a .mts file: static import or export, side-effect import, dynamic import.
const MTS_SPECIFIER = /((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"])(\.{1,2}\/[^'"\n]+?)\.mts(['"])/g;
export const rewriteSpecifiers = (text) => text.replace(MTS_SPECIFIER, (_, head, path, quote) => `${head}${path}.mjs${quote}`);

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    if (name === 'node_modules' || name === 'runtime') continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function main() {
  rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });
  // npm always packs package.json, the README and the LICENSE; the rest is the manifest's files allowlist.
  const alwaysPacked = readdirSync(root).filter((name) => /^(readme|license|licence|notice|changelog)(.|$)/i.test(name));
  const entries = [...new Set(['package.json', ...alwaysPacked, ...manifest.files])];
  for (const entry of entries) {
    const from = join(root, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(stage, entry), { recursive: true, filter: (source) => !/[\\/](node_modules|runtime)([\\/]|$)/.test(relative(root, source)) });
  }
  // The staged manifest has no build-time dependencies.
  const staged = { ...manifest };
  delete staged.devDependencies;
  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`);

  let stripped = 0;
  let rewritten = 0;
  for (const file of walk(stage)) {
    if (extname(file) === '.mts') {
      const target = file.slice(0, -'.mts'.length) + '.mjs';
      if (existsSync(target)) throw new Error(`Both ${slash(file)} and its .mjs exist; keep one source.`);
      // Strip mode keeps every line where it was, so a stack trace from an installed broker points at the source line.
      const javascript = `${rewriteSpecifiers(stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })).trimEnd()}
// Generated from ${slash(file).split('/').pop()} by scripts/build-package.mjs; edit the .mts source.
`;
      writeFileSync(target, javascript);
      rmSync(file);
      stripped += 1;
    } else if (extname(file) === '.mjs') {
      const text = readFileSync(file, 'utf8');
      const next = rewriteSpecifiers(text);
      if (next !== text) { writeFileSync(file, next); rewritten += 1; }
    }
  }

  // Nothing in the staged package may still import a .mts module, and every module must parse. Files that the
  // runtime names by path (src/cli.mjs, the bridges, the launchers' targets) stay .mjs entry points in the source.
  const modules = walk(stage).filter((file) => extname(file) === '.mjs');
  for (const file of walk(stage)) {
    if (extname(file) === '.mts') throw new Error(`Unstripped TypeScript in the package: ${slash(file)}`);
    if (extname(file) === '.mjs' && new RegExp(MTS_SPECIFIER.source).test(readFileSync(file, 'utf8'))) throw new Error(`A staged module still imports a .mts path: ${slash(file)}`);
  }
  for (const file of modules) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Syntax check failed in the package: ${slash(file)}\n${result.stderr}`);
  }
  const summary = { stage: relative(root, stage).split(sep).join('/'), modules: modules.length, stripped, rewritten };
  process.stdout.write(process.argv.includes('--json') ? `${JSON.stringify(summary, null, 2)}\n` : `staged ${summary.stage}: ${modules.length} modules, ${stripped} stripped from .mts, ${rewritten} with rewritten imports\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
