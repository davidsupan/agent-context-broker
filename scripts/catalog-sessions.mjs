#!/usr/bin/env bun
// Builds a deterministic, token-free catalog of agent transcript sessions.
//
// This is the first, cheap layer of historical distillation: before a single model token
// is spent, every session gets a row saying what it is - provider, thread name, working
// directory, ticket keys, time span, turn count, how many bytes of it are actually operator
// prompts and assistant answers rather than tool output - so the expensive layer can be
// pointed at the sessions that carry meaning and skip the ones that do not.
//
// Operator text is identified with the same structural filters the Lane B extractor uses:
// Codex `response_item/message` with role user/assistant, ignoring harness preamble that
// starts with `<`; Claude Code `type: user|assistant` records that are not sidechain
// (agent-authored), not tool results, not meta or compaction summaries, with injected
// `<system-reminder>` blocks stripped. Nothing here reads the broker or writes to it.
//
// The catalog is incremental: a manifest keyed by relative path records the size and
// mtime that were catalogued, and unchanged files are skipped on the next run, so it can
// follow corpora that are still being written to.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join, relative, resolve } from 'node:path';

function parseArgs(argv) {
  const options = { sources: [], minSemanticBytes: 2000, ticketProjects: ['OC', 'APP'], rebuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--rebuild') { options.rebuild = true; continue; }
    const value = argv[index + 1];
    switch (argv[index]) {
      // Only these project keys count as tickets. A letters-then-number pattern alone
      // accepts EVENT-2, GPT-5 and CONSULTS-2026, which are not tickets in any tracker.
      case '--ticket-projects':
        options.ticketProjects = String(value).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
        index += 1; break;
      // --source <provider>=<dir>, repeatable
      case '--source': {
        const [provider, dir] = String(value).split('=');
        if (!['codex', 'claude-code'].includes(provider) || !dir) {
          throw new Error('--source expects <codex|claude-code>=<directory>');
        }
        options.sources.push({ provider, dir: resolve(dir) });
        index += 1; break;
      }
      case '--out': options.out = resolve(value); index += 1; break;
      case '--codex-index': options.codexIndex = resolve(value); index += 1; break;
      case '--min-semantic-bytes': options.minSemanticBytes = Number(value); index += 1; break;
      default: throw new Error('unknown argument: ' + argv[index]);
    }
  }
  if (options.sources.length === 0 || !options.out) {
    throw new Error('usage: catalog-sessions.mjs --source codex=<dir> [--source claude-code=<dir>] ' +
      '--out <dir> [--codex-index <session_index.jsonl>] [--min-semantic-bytes 2000] ' +
      '[--ticket-projects OC,APP] [--rebuild]');
  }
  return options;
}

const sha = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const TICKET = /(?<![A-Z0-9])(?<project>[A-Z]{2,10})-(?<number>\d{1,9})(?![A-Z0-9])/gu;
// GitLab merge requests are referenced as !1234 in prose and as mr-1234 in ledgers.
const MERGE_REQUEST = /(?:(?<![\w])!|\bMR-)(?<iid>\d{3,7})\b/giu;

function collectRefs(text, projects, tickets, mergeRequests) {
  const upper = text.toUpperCase();
  for (const match of upper.matchAll(TICKET)) {
    if (projects.includes(match.groups.project)) tickets.add(`${match.groups.project}-${match.groups.number}`);
  }
  for (const match of text.matchAll(MERGE_REQUEST)) mergeRequests.add(`!${match.groups.iid}`);
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'prune-ledger.jsonl') out.push(path);
  }
  return out;
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

// Text the harness put into a "user" turn is not the operator speaking. Both providers
// inject instruction files and environment blocks as user-role messages; counting them as
// operator text inflates a session's weight by the size of AGENTS.md times the number of
// turns, and makes the "first prompt" the preamble instead of the request.
function isInjectedOperatorText(text) {
  return text.startsWith('<') ||
    /^#\s*(AGENTS|CLAUDE)\.md/iu.test(text) ||
    text.includes('<INSTRUCTIONS>') ||
    text.includes('<environment_context>') ||
    text.startsWith('[Request interrupted') ||
    /^\[SYSTEM NOTIFICATION/u.test(text);
}

// Codex rollout record -> { role, text } for operator/assistant messages, else null.
function codexMessage(record) {
  if (record?.type !== 'response_item' || record.payload?.type !== 'message') return null;
  const role = record.payload.role;
  if (!['user', 'assistant'].includes(role)) return null;
  const text = textOf(record.payload.content).trim();
  if (!text || (role === 'user' && isInjectedOperatorText(text))) return null;
  return { role, text };
}

function claudeMessage(record) {
  if (!['user', 'assistant'].includes(record?.type)) return null;
  if (record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  if (record.toolUseResult !== undefined) return null;
  const text = stripInjected(textOf(record.message?.content)).trim();
  if (!text || (record.type === 'user' && isInjectedOperatorText(text))) return null;
  return { role: record.type, text };
}

async function catalogFile(provider, path, relativePath, options) {
  const row = {
    provider,
    relativePath,
    sessionHash: sha(`${provider}:${relativePath}`),
    fileBytes: statSync(path).size,
    firstAt: null,
    lastAt: null,
    turns: 0,
    operatorTurns: 0,
    operatorBytes: 0,
    assistantBytes: 0,
    firstOperatorPrompt: null,
    cwd: null,
    gitBranch: null,
    nativeSessionId: null,
    ticketKeys: [],
    mergeRequests: [],
    terminalState: null,
    parseErrors: 0
  };
  const tickets = new Set();
  const mergeRequests = new Set();
  const stream = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { row.parseErrors += 1; continue; }

    const at = record.timestamp ?? record.payload?.timestamp ?? null;
    if (typeof at === 'string' && !Number.isNaN(Date.parse(at))) {
      if (!row.firstAt || at < row.firstAt) row.firstAt = at;
      if (!row.lastAt || at > row.lastAt) row.lastAt = at;
    }
    if (provider === 'codex') {
      if (record.type === 'session_meta') {
        row.cwd = record.payload?.cwd ?? row.cwd;
        row.nativeSessionId = record.payload?.id ?? row.nativeSessionId;
      }
      if (record.type === 'turn_context') row.cwd = record.payload?.cwd ?? row.cwd;
      if (record.type === 'event_msg' && record.payload?.type === 'task_complete') row.terminalState = 'completed';
    } else {
      row.cwd = record.cwd ?? row.cwd;
      row.gitBranch = record.gitBranch ?? row.gitBranch;
      row.nativeSessionId = record.sessionId ?? row.nativeSessionId;
    }

    const message = provider === 'codex' ? codexMessage(record) : claudeMessage(record);
    if (!message) continue;
    row.turns += 1;
    if (message.role === 'user') {
      row.operatorTurns += 1;
      row.operatorBytes += message.text.length;
      if (!row.firstOperatorPrompt) row.firstOperatorPrompt = message.text.slice(0, 240);
      collectRefs(message.text, options.ticketProjects, tickets, mergeRequests);
    } else {
      row.assistantBytes += message.text.length;
    }
  }
  if (row.gitBranch) collectRefs(row.gitBranch, options.ticketProjects, tickets, mergeRequests);
  row.ticketKeys = [...tickets].sort();
  row.mergeRequests = [...mergeRequests].sort();
  row.semanticBytes = row.operatorBytes + row.assistantBytes;
  // The native id never leaves this row un-hashed; the catalog is meant to be shareable
  // between sessions and the hash is enough to join on.
  row.nativeSessionIdHash = row.nativeSessionId ? sha(`${provider}-session:${row.nativeSessionId}`) : null;
  delete row.nativeSessionId;
  return row;
}

function loadCodexThreadNames(indexPath) {
  const names = new Map();
  if (!indexPath || !existsSync(indexPath)) return names;
  for (const line of readFileSync(indexPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.id && entry.thread_name) names.set(entry.id, entry.thread_name);
    } catch { /* skip */ }
  }
  return names;
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.out, { recursive: true });
const manifestPath = join(options.out, 'catalog-manifest.json');
const catalogPath = join(options.out, 'catalog-sessions.jsonl');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
// A rebuild recomputes everything and drops rows for files that no longer exist; carrying
// old rows forward would keep sessions that were rotated away and leave them with an
// older row shape than the rest of the catalog.
const existing = new Map();
if (!options.rebuild && existsSync(catalogPath)) {
  for (const line of readFileSync(catalogPath, 'utf8').split('\n')) {
    if (line.trim()) { const row = JSON.parse(line); existing.set(`${row.provider}:${row.relativePath}`, row); }
  }
}
const codexNames = loadCodexThreadNames(options.codexIndex);

let scanned = 0;
let skipped = 0;
const started = performance.now();
for (const source of options.sources) {
  for (const path of walk(source.dir).sort()) {
    const relativePath = relative(source.dir, path).split('\\').join('/');
    const key = `${source.provider}:${relativePath}`;
    const stat = statSync(path);
    const stamp = `${stat.size}:${Math.floor(stat.mtimeMs)}`;
    if (!options.rebuild && manifest[key] === stamp && existing.has(key)) { skipped += 1; continue; }
    const row = await catalogFile(source.provider, path, relativePath, options);
    row.sourceRoot = source.dir;
    if (source.provider === 'codex') {
      // Rollout filenames end in the native session id; the thread index maps it to a name.
      const id = basename(path).replace(/^rollout-.*?-(?=[0-9a-f]{8}-)/u, '').replace(/\.jsonl$/u, '');
      row.threadName = codexNames.get(id) ?? null;
    } else {
      row.threadName = null;
    }
    row.trivial = row.semanticBytes < options.minSemanticBytes;
    row.cataloguedAt = new Date().toISOString();
    existing.set(key, row);
    manifest[key] = stamp;
    scanned += 1;
  }
}

const rows = [...existing.values()].sort((left, right) =>
  right.semanticBytes - left.semanticBytes || left.relativePath.localeCompare(right.relativePath));
writeFileSync(catalogPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

const total = rows.reduce((sum, row) => sum + row.semanticBytes, 0);
let cumulative = 0;
let eighty = rows.length;
for (let index = 0; index < rows.length; index += 1) {
  cumulative += rows[index].semanticBytes;
  if (cumulative >= 0.8 * total) { eighty = index + 1; break; }
}
const byProvider = {};
for (const row of rows) {
  byProvider[row.provider] ??= { sessions: 0, semanticBytes: 0, trivial: 0, withTickets: 0 };
  byProvider[row.provider].sessions += 1;
  byProvider[row.provider].semanticBytes += row.semanticBytes;
  if (row.trivial) byProvider[row.provider].trivial += 1;
  if (row.ticketKeys.length > 0) byProvider[row.provider].withTickets += 1;
}
console.log('catalogued now   : ' + scanned + '   unchanged, skipped: ' + skipped);
console.log('sessions total   : ' + rows.length);
for (const [provider, stats] of Object.entries(byProvider)) {
  console.log('  ' + provider.padEnd(12) + ' sessions=' + stats.sessions + ' semantic=' +
    (stats.semanticBytes / 1024 / 1024).toFixed(1) + ' MB trivial=' + stats.trivial + ' withTickets=' + stats.withTickets);
}
console.log('80% of meaning in: ' + eighty + ' sessions');
console.log('catalog          : ' + catalogPath);
console.log('elapsed          : ' + ((performance.now() - started) / 1000).toFixed(1) + ' s');
