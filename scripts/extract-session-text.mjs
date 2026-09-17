#!/usr/bin/env bun
// Extracts the operator and assistant text of selected sessions into plain files, so the
// model-assisted distillation step reads a bounded, pre-filtered input instead of raw
// transcripts.
//
// Selection comes from the session catalog (catalog-sessions.mjs): the top N Codex sessions
// by semantic bytes plus every non-trivial Claude Code session, or an explicit list of
// session hashes. The same structural filters apply as everywhere else in this repository -
// tool output, sidechain (agent-authored) turns, meta and compaction records, and injected
// instruction or environment blocks are not the operator and are not extracted.
//
// Output is one UTF-8 text file per session under <out>/<provider>/<sessionHash>.txt with a
// small JSON header, turns prefixed by their timestamp and role, and an index of what was
// written. Files are chunk-friendly: a line "=== turn <n> <role> <iso-time> ===" precedes
// every turn so a reader can split on it. Nothing here touches the broker.
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, resolve } from 'node:path';

function parseArgs(argv) {
  const options = { topCodex: 107, includeAssistant: true, maxTurnChars: 20000, hashes: [] };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--operator-only') { options.includeAssistant = false; continue; }
    const value = argv[index + 1];
    switch (argv[index]) {
      case '--catalog': options.catalog = resolve(value); index += 1; break;
      case '--out': options.out = resolve(value); index += 1; break;
      case '--top-codex': options.topCodex = Number(value); index += 1; break;
      case '--max-turn-chars': options.maxTurnChars = Number(value); index += 1; break;
      case '--hash': options.hashes.push(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argv[index]);
    }
  }
  if (!options.catalog || !options.out) {
    throw new Error('usage: extract-session-text.mjs --catalog <catalog-sessions.jsonl> --out <dir> ' +
      '[--top-codex 107] [--operator-only] [--max-turn-chars 20000] [--hash <sessionHash> ...]');
  }
  return options;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  return '';
}

function stripInjected(text) {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, ' ')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-[a-z]*>/giu, ' ')
    .replace(/<local-command-[\s\S]*?>[\s\S]*?<\/local-command-[a-z-]*>/giu, ' ');
}

function isInjectedOperatorText(text) {
  return text.startsWith('<') ||
    /^#\s*(AGENTS|CLAUDE)\.md/iu.test(text) ||
    text.includes('<INSTRUCTIONS>') ||
    text.includes('<environment_context>') ||
    text.startsWith('[Request interrupted') ||
    /^\[SYSTEM NOTIFICATION/u.test(text);
}

function codexMessage(record) {
  if (record?.type !== 'response_item' || record.payload?.type !== 'message') return null;
  const role = record.payload.role;
  if (!['user', 'assistant'].includes(role)) return null;
  const text = textOf(record.payload.content).trim();
  if (!text || (role === 'user' && isInjectedOperatorText(text))) return null;
  return { role: role === 'user' ? 'operator' : 'assistant', text, at: record.timestamp ?? null };
}

function claudeMessage(record) {
  if (!['user', 'assistant'].includes(record?.type)) return null;
  if (record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  if (record.toolUseResult !== undefined) return null;
  const text = stripInjected(textOf(record.message?.content)).trim();
  if (!text || (record.type === 'user' && isInjectedOperatorText(text))) return null;
  return { role: record.type === 'user' ? 'operator' : 'assistant', text, at: record.timestamp ?? null };
}

const options = parseArgs(process.argv.slice(2));
const rows = readFileSync(options.catalog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

let selected;
if (options.hashes.length > 0) {
  const wanted = new Set(options.hashes);
  selected = rows.filter((row) => wanted.has(row.sessionHash));
} else {
  const codex = rows.filter((row) => row.provider === 'codex' && !row.trivial)
    .sort((left, right) => right.semanticBytes - left.semanticBytes).slice(0, options.topCodex);
  const claude = rows.filter((row) => row.provider === 'claude-code' && !row.trivial);
  selected = [...codex, ...claude];
}

mkdirSync(options.out, { recursive: true });
const index = [];
let totalChars = 0;
let missing = 0;
for (const row of selected) {
  const path = join(row.sourceRoot, row.relativePath);
  if (!existsSync(path)) { missing += 1; continue; }
  const lines = [];
  let turn = 0;
  let operatorChars = 0;
  let assistantChars = 0;
  const stream = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const message = row.provider === 'codex' ? codexMessage(record) : claudeMessage(record);
    if (!message) continue;
    if (message.role === 'assistant' && !options.includeAssistant) continue;
    turn += 1;
    // Very long turns are almost always pasted material (logs, diffs); keep the head and
    // tail so the decision around them survives without dragging the paste along.
    let text = message.text;
    if (text.length > options.maxTurnChars) {
      const half = Math.floor(options.maxTurnChars / 2);
      text = text.slice(0, half) + `\n[... ${text.length - options.maxTurnChars} chars elided ...]\n` + text.slice(-half);
    }
    if (message.role === 'operator') operatorChars += text.length; else assistantChars += text.length;
    lines.push(`=== turn ${turn} ${message.role} ${message.at ?? '-'} ===`, text, '');
  }
  const header = {
    provider: row.provider,
    sessionHash: row.sessionHash,
    threadName: row.threadName ?? null,
    cwd: row.cwd ?? null,
    gitBranch: row.gitBranch ?? null,
    ticketKeys: row.ticketKeys,
    mergeRequests: row.mergeRequests ?? [],
    firstAt: row.firstAt,
    lastAt: row.lastAt,
    turns: turn,
    operatorChars,
    assistantChars
  };
  const directory = join(options.out, row.provider);
  mkdirSync(directory, { recursive: true });
  const outPath = join(directory, `${row.sessionHash}.txt`);
  writeFileSync(outPath, `${JSON.stringify(header)}\n\n${lines.join('\n')}`, 'utf8');
  index.push({ ...header, path: outPath, chars: operatorChars + assistantChars });
  totalChars += operatorChars + assistantChars;
}
writeFileSync(join(options.out, 'extraction-index.json'), JSON.stringify(index, null, 2) + '\n', 'utf8');

console.log('sessions selected : ' + selected.length + (missing ? '  (missing on disk: ' + missing + ')' : ''));
console.log('written           : ' + index.length + ' files under ' + options.out);
console.log('text extracted    : ' + (totalChars / 1024 / 1024).toFixed(1) + ' MB  (~' + (totalChars / 4 / 1e6).toFixed(1) + ' M tokens at 4 chars/token)');
console.log('  operator        : ' + (index.reduce((s, i) => s + i.operatorChars, 0) / 1024 / 1024).toFixed(1) + ' MB');
console.log('  assistant       : ' + (index.reduce((s, i) => s + i.assistantChars, 0) / 1024 / 1024).toFixed(1) + ' MB');
