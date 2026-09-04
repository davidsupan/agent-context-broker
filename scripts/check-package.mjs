#!/usr/bin/env bun

import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertSupportedBun } from '../src/installation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requiredFiles = Object.freeze([
  '.editorconfig',
  '.github/CODEOWNERS',
  '.github/dependabot.yml',
  '.github/ISSUE_TEMPLATE/bug_report.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/PULL_REQUEST_TEMPLATE.md',
  '.github/release.yml',
  '.github/workflows/ci.yml',
  '.github/workflows/pages.yml',
  'CODE_OF_CONDUCT.md',
  'GOVERNANCE.md',
  'README.md',
  'LICENSE',
  'LICENSE.md',
  'SECURITY.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'package.json',
  'adapters/CONTRACT.md',
  'docs/architecture.md',
  'docs/releasing.md',
  'docs/repository-settings.md',
  'fixtures/codex-active.jsonl',
  'fixtures/codex-completed.jsonl',
  'fixtures/codex-malformed.jsonl',
  'fixtures/claude-active.jsonl',
  'examples/candidate-claim-batch.json',
  'examples/agent-handoff-batch.json',
  'examples/fallback-sweep.json',
  'examples/peer-progress-proposal.json',
  'examples/peer-standalone-thread-progress-proposal.json',
  'src/cli.mjs',
  'src/installation.mjs',
  'src/platform-paths.mjs',
  'scripts/agent-context-broker.sh',
  'scripts/agent-context.mjs',
  'scripts/agent-context.sh',
  'scripts/check-package.mjs',
  'scripts/cross-thread-provider-proof.mjs',
  'scripts/install-agent-context-broker.sh',
  'scripts/manage-agent-context-broker-installation.mjs',
  'scripts/test-agent-context-broker-installation.mjs',
  'scripts/test-agent-context-broker-installation.sh',
  'scripts/test-shell-installation.sh',
  'scripts/uninstall-agent-context-broker.sh',
  'site/.nojekyll',
  'site/index.html',
  'site/robots.txt',
  'site/sitemap.xml',
  'site/styles.css',
  'test/installation.test.mjs',
  'providers/codex/src/bridge.mjs',
  'providers/codex/src/cli.mjs',
  'providers/claude-code/src/bridge.mjs',
  'providers/claude-code/src/cli.mjs',
  'profiles/context-profiles.json'
]);

const textExtensions = new Set(['.css', '.html', '.json', '.jsonl', '.md', '.mjs', '.sh', '.txt', '.xml', '.yml', '.yaml']);
const decoder = new TextDecoder('utf-8', { fatal: true });

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'runtime') continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link found in package: ${path}`);
    if (entry.isDirectory()) files.push(...walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function slash(path) {
  return relative(root, path).split(sep).join('/');
}

assertSupportedBun();
for (const file of requiredFiles) {
  const path = join(root, ...file.split('/'));
  if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`Required package file is missing: ${file}`);
}

const files = walk(root);
const powershellFiles = files.filter((path) => extname(path).toLowerCase() === '.ps1');
if (powershellFiles.length > 0) {
  throw new Error(`PowerShell files are not allowed in the Bun-only package: ${powershellFiles.map(slash).join(', ')}`);
}

const textFiles = files.filter((path) => textExtensions.has(extname(path).toLowerCase()));
for (const file of textFiles) {
  const bytes = readFileSync(file);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`UTF-8 BOM is not allowed: ${slash(file)}`);
  }
  decoder.decode(bytes);
}

for (const file of files.filter((path) => extname(path).toLowerCase() === '.json')) {
  JSON.parse(readFileSync(file, 'utf8'));
}

const transpiler = new Bun.Transpiler({ loader: 'js', target: 'bun' });
for (const file of files.filter((path) => extname(path).toLowerCase() === '.mjs')) {
  transpiler.transformSync(readFileSync(file, 'utf8'));
}

for (const file of files.filter((path) => extname(path).toLowerCase() === '.sh')) {
  const text = readFileSync(file, 'utf8');
  if (!text.startsWith('#!/bin/sh\n')) throw new Error(`Shell script must use portable /bin/sh: ${slash(file)}`);
  if (text.includes('\r\n')) throw new Error(`Shell script must use LF line endings: ${slash(file)}`);
}

const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (packageManifest.engines?.bun !== '>=1.4.0 <2') throw new Error('The package must require Bun 1.4.');
if (packageManifest.packageManager !== 'bun@1.4.1') throw new Error('The package manager must pin Bun 1.4.1.');
if (packageManifest.homepage !== 'https://davidsupan.github.io/agent-context-broker/') {
  throw new Error('The package homepage must point to the GitHub Pages project site.');
}
if (packageManifest.files.includes('site')) {
  throw new Error('The GitHub Pages source must not be included in the runtime package.');
}
for (const provider of ['codex', 'claude-code']) {
  const manifest = JSON.parse(readFileSync(join(root, 'providers', provider, 'package.json'), 'utf8'));
  if (manifest.version !== packageManifest.version) {
    throw new Error(`Provider package version does not match ${packageManifest.version}: ${provider}`);
  }
}

for (const file of files.filter((path) => slash(path).startsWith('schemas/') && extname(path) === '.json')) {
  const schema = JSON.parse(readFileSync(file, 'utf8'));
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    throw new Error(`Unexpected JSON Schema dialect: ${slash(file)}`);
  }
}

const adapterContract = readFileSync(join(root, 'adapters', 'CONTRACT.md'), 'utf8');
for (const heading of [
  '## Read Contract',
  '## Bootstrap Contract',
  '## Evidence Contract',
  '## Manual Refresh Contract',
  '## Reconciliation Contract',
  '## Failure Contract'
]) {
  if (!adapterContract.includes(heading)) throw new Error(`Adapter contract heading is missing: ${heading}`);
}

const siteIndex = readFileSync(join(root, 'site', 'index.html'), 'utf8');
const siteStyles = readFileSync(join(root, 'site', 'styles.css'), 'utf8');
const siteRobots = readFileSync(join(root, 'site', 'robots.txt'), 'utf8');
const siteMap = readFileSync(join(root, 'site', 'sitemap.xml'), 'utf8');
for (const marker of [
  '<!doctype html>',
  '<html lang="en">',
  '<header',
  '<nav',
  '<main',
  '<section',
  '<table',
  '<caption',
  '<footer',
  'href="./styles.css"',
  'Content-Security-Policy',
  packageManifest.version
]) {
  if (!siteIndex.includes(marker)) throw new Error(`Project site marker is missing: ${marker}`);
}
if ((siteIndex.match(/<h1\b/gi) ?? []).length !== 1) {
  throw new Error('The project site must contain exactly one h1.');
}
if (/<(?:script|style)\b/i.test(siteIndex) || /\sstyle\s*=/i.test(siteIndex)) {
  throw new Error('The project site must not contain scripts or inline styles.');
}
const externalResourceTag = /<(?:audio|embed|iframe|img|object|source|video)\b[^>]*(?:data|src)\s*=\s*["']https?:/i;
const externalLinkTag = [...siteIndex.matchAll(/<link\b[^>]*>/gi)].some((match) =>
  !/\brel="canonical"/i.test(match[0]) && /\bhref\s*=\s*["']https?:/i.test(match[0])
);
if (externalResourceTag.test(siteIndex) || externalLinkTag || /(?:url|@import)\s*\([^)]*https?:/i.test(siteStyles)) {
  throw new Error('The project site must not load third-party resources.');
}
if (/\bhref\s*=\s*["']http:\/\//i.test(siteIndex)) {
  throw new Error('The project site must use HTTPS for external links.');
}
if (/\b(?:linear|radial|conic)-gradient\s*\(/i.test(siteStyles)) {
  throw new Error('The project site must not use decorative gradients.');
}

const ids = [...siteIndex.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(ids).size !== ids.length) throw new Error('The project site contains duplicate ids.');
for (const match of siteIndex.matchAll(/href="#([^"]+)"/g)) {
  if (!ids.includes(match[1])) throw new Error(`Project site fragment has no target: #${match[1]}`);
}
for (const match of siteIndex.matchAll(/https:\/\/github\.com\/davidsupan\/agent-context-broker\/blob\/main\/([^"#?]+)/g)) {
  const linkedPath = decodeURIComponent(match[1]);
  if (!existsSync(join(root, ...linkedPath.split('/')))) {
    throw new Error(`Project site repository link has no local target: ${linkedPath}`);
  }
}
if (!siteRobots.includes('Sitemap: https://davidsupan.github.io/agent-context-broker/sitemap.xml')) {
  throw new Error('The project site robots file must reference its sitemap.');
}
if (!siteMap.includes('<loc>https://davidsupan.github.io/agent-context-broker/</loc>')) {
  throw new Error('The project site sitemap must contain the canonical page URL.');
}

process.stdout.write(`${JSON.stringify({
  package: packageManifest.name,
  version: packageManifest.version,
  runtime: `bun ${globalThis.Bun.version}`,
  files: files.length,
  textFiles: textFiles.length,
  powershellFiles: 0,
  status: 'passed'
}, null, 2)}\n`);
