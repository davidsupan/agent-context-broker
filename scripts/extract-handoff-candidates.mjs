#!/usr/bin/env bun
// Extracts candidate conclusions from provider transcripts into a Lane B proposal.
//
// What this is: a deterministic candidate generator. It finds operator turns that carry
// correction or decision markers and proposes them verbatim. It does not understand the
// conversation, and it is not a summariser - a model-assisted extractor would replace the
// matching step here and keep everything else, because everything else is the part that
// makes the output safe to look at.
//
// What it is not: a path into trusted context. Output goes to propose-handoff-claims.mjs,
// which forces evidenceClass 'agent-handoff' and verification 'unverified' no matter what
// this script asks for, so every candidate lands in evidence review. Precision here buys
// a shorter review queue, never trust.
//
// Valid time comes from the transcript record, never from this run. A conclusion drawn in
// April is an April observation recorded today, which is what keeps old threads from
// outranking current context.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, relative, resolve } from 'node:path';

function parseArgs(argv) {
  const options = { limit: Infinity, maxPerSession: 3, minLength: 24, maxLength: 400 };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    switch (argv[index]) {
      case '--source': options.source = value; index += 1; break;
      case '--provider': options.provider = value; index += 1; break;
      case '--scope-kind': options.scopeKind = value; index += 1; break;
      case '--scope-key': options.scopeKey = value; index += 1; break;
      case '--out': options.out = value; index += 1; break;
      case '--limit': options.limit = Number(value); index += 1; break;
      case '--max-per-session': options.maxPerSession = Number(value); index += 1; break;
      case '--since': options.since = value; index += 1; break;
      default: throw new Error('unknown argument: ' + argv[index]);
    }
  }
  if (!options.source || !options.provider || !options.out) {
    throw new Error('usage: extract-handoff-candidates.mjs --source <dir> --provider <codex|claude-code> ' +
      '--out <proposal.json> [--scope-kind project] [--scope-key <key>] [--limit n] ' +
      '[--max-per-session 3] [--since <iso date>]');
  }
  if (!['codex', 'claude-code'].includes(options.provider)) {
    throw new Error('provider must be codex or claude-code');
  }
  return options;
}

const sha = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');

// Markers for a turn where the operator settled something: a correction, a standing rule,
// or a choice between options. Both working languages, because half this corpus is
// Slovenian and an English-only matcher would silently mine half the history.
const MARKERS = [
  { weight: 0.75, pattern: /\b(ne|nikoli|nikakor|narobe|napačno|ni prav|ne delaj|ne uporabljaj)\b/iu },
  { weight: 0.75, pattern: /\b(vedno|obvezno|nujno|mora|moraš|naj bo|raje|namesto)\b/iu },
  { weight: 0.7, pattern: /\b(no,|not |never |don't|do not|stop |instead of|rather than|wrong)\b/iu },
  { weight: 0.7, pattern: /\b(always |must |should never|from now on|going forward|prefer )\b/iu },
  { weight: 0.6, pattern: /\b(odločil|odločiva|dogovor|pravilo|standard|konvencij)/iu },
  { weight: 0.6, pattern: /\b(decided|decision|convention|the rule is|policy is)\b/iu }
];

// Turns that are scaffolding rather than instruction. Mining these produces confident
// nonsense, which is the expensive failure for a review queue.
const NOISE = [
  /^<[a-z-]+[\s>]/iu,
  /^\s*(nadaljuj|continue|ok|okay|da|ja|potrdim|yes|no|thanks|hvala|preveri)\s*[.!]?\s*$/iu,
  /environment_context|permissions instructions|system-reminder|<command-name>/iu,
  /^\s*\[?(image|attachment|tool_result|caveat)/iu,
  // Scoping for one task reads exactly like a standing rule: "do not edit any files"
  // bounds a research run, it is not a policy. Only the unambiguous phrasings are listed;
  // filtering every imperative opener also removes real operator instructions, which cost
  // more than the false positives it saves.
  /\b(read[- ]only research|do not edit any files?|don't edit anything)\b/iu,
  // Pasted code and diff hunks match the markers ("not", "must") without stating anything
  // the operator decided.
  /^\s*[+-]\s|^\s*(if|for|while|function|const|let|var|return|import|export|#|\/\/|\$)\b/u,
  /[{}();]\s*$|=>|\|\||&&/u
];

function textFromCodex(record) {
  if (record?.type !== 'response_item') return null;
  const payload = record.payload;
  if (payload?.type !== 'message') return null;
  if (!['user', 'assistant'].includes(payload.role)) return null;
  const parts = Array.isArray(payload.content) ? payload.content : [];
  const text = parts
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('\n').trim();
  return text ? { role: payload.role, text } : null;
}

// Claude Code stores far more than operator prose in `user` records: tool results, hook
// output, compaction summaries, and - the big one - sidechain turns, which are subagent
// prompts written by an agent. Mining those would launder agent-authored text into
// operator decisions, which is the exact trust inversion this lane exists to prevent, so
// they are excluded structurally rather than by how they read.
function textFromClaude(record) {
  if (!['user', 'assistant'].includes(record?.type)) return null;
  if (record.isSidechain || record.isMeta || record.isCompactSummary) return null;
  if (record.toolUseResult !== undefined) return null;
  // promptSource is deliberately not used as a filter. It reads like a human/programmatic
  // split and is not one: prompts typed into the desktop app arrive as 'sdk', so treating
  // that as agent-authored discards precisely the operator turns worth mining.
  const content = record?.message?.content;
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
      : '';
  const trimmed = text.trim();
  return trimmed ? { role: record.type, text: trimmed } : null;
}

// One operator turn can hold several separate instructions; score them individually so a
// long message does not become one unreviewable claim.
function segments(text) {
  return text
    // Injected blocks ride along inside a genuine operator turn. They are appended by the
    // harness, so they are stripped before anything is attributed to the operator.
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, ' ')
    .replace(/<local-command-[\s\S]*?>[\s\S]*?<\/local-command-[a-z-]*>/giu, ' ')
    .replace(/<command-(name|message|args)>[\s\S]*?<\/command-[a-z]*>/giu, ' ')
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
}

function score(segment) {
  let value = 0;
  for (const marker of MARKERS) if (marker.pattern.test(segment)) value = Math.max(value, marker.weight);
  return value;
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name !== 'prune-ledger.jsonl') {
      out.push(path);
    }
  }
  return out;
}

const options = parseArgs(process.argv.slice(2));
const source = resolve(options.source);
const since = options.since ? Date.parse(options.since) : null;
const files = walk(source).sort();

const candidates = new Map();
let scanned = 0;
let turns = 0;
// The scan always covers the whole corpus. --limit caps what is proposed, never what is
// read: repetition across sessions is the main signal that an instruction is a standing
// rule rather than one task's scoping, and stopping early destroys exactly that signal.
for (const file of files) {
  if (since && statSync(file).mtimeMs < since) continue;
  scanned += 1;

  const relativePath = relative(source, file).split('\\').join('/');
  const sessionKey = sha(`${options.provider}-session:${relativePath}`);
  const sourceHash = sha(`${options.provider}-source:${relativePath}`);
  const found = [];

  const stream = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  });
  for await (const line of stream) {
    if (!line.trim()) continue;
    let record = null;
    try { record = JSON.parse(line); } catch { continue; }
    const message = options.provider === 'codex' ? textFromCodex(record) : textFromClaude(record);
    // Operator turns only. An assistant restating a rule is not evidence the rule exists.
    if (!message || message.role !== 'user') continue;
    turns += 1;

    const observedAt = record.timestamp ?? record?.payload?.timestamp ?? null;
    if (!observedAt || Number.isNaN(Date.parse(observedAt))) continue;

    for (const segment of segments(message.text)) {
      if (segment.length < options.minLength || segment.length > options.maxLength) continue;
      if (NOISE.some((pattern) => pattern.test(segment))) continue;
      const confidence = score(segment);
      if (confidence === 0) continue;
      found.push({ segment, confidence, observedAt, sessionKey, sourceHash, relativePath });
    }
  }

  // Keep the strongest few per session so one talkative thread cannot dominate the queue.
  found.sort((left, right) => right.confidence - left.confidence ||
    Date.parse(right.observedAt) - Date.parse(left.observedAt));
  for (const item of found.slice(0, options.maxPerSession)) {
    // Deduplicate on normalised text: the same instruction repeated across sessions is one
    // claim, and the earliest observation is the one that dates it.
    const key = sha(item.segment.toLowerCase().replace(/\s+/gu, ' '));
    const existing = candidates.get(key);
    if (existing && Date.parse(existing.observedAt) <= Date.parse(item.observedAt)) {
      existing.repeats += 1;
      continue;
    }
    candidates.set(key, { ...item, key, repeats: existing ? existing.repeats + 1 : 1 });
  }
}

const ordered = [...candidates.values()]
  .sort((left, right) => right.repeats - left.repeats ||
    right.confidence - left.confidence ||
    Date.parse(left.observedAt) - Date.parse(right.observedAt))
  .slice(0, options.limit);

const proposal = {
  scope: {
    kind: options.scopeKind ?? 'project',
    key: options.scopeKey ?? 'agent-history'
  },
  source: {
    provider: options.provider,
    sessionKey: ordered[0]?.sessionKey ?? sha(`${options.provider}:empty`),
    recordKey: sha(`${options.provider}-extract:${source}`),
    sourceHash: ordered[0]?.sourceHash ?? sha(`${options.provider}:empty`)
  },
  // Who produced these candidates. Everything below is agent-authored by construction, and
  // saying so in the record means a reviewer does not have to infer it from the filename.
  agent: {
    kind: 'sdk',
    harness: 'acb-extractor',
    model: 'deterministic-markers',
    instanceId: `extract-handoff-candidates:${options.provider}:${source}`
  },
  claims: ordered.map((item) => ({
    claimKey: `handoff.${item.key.slice(0, 16)}`,
    claimType: 'decision',
    subject: options.scopeKey ?? 'agent-history',
    predicate: 'stated',
    value: item.segment,
    // Valid time from the transcript, not from this run.
    observedAt: new Date(item.observedAt).toISOString(),
    // A repeated instruction is better attested, never verified. The ceiling is well under
    // 1 on purpose: nothing this script emits is allowed to look settled.
    confidence: Math.min(0.85, item.confidence + Math.min(0.1, (item.repeats - 1) * 0.02))
  }))
};

writeFileSync(resolve(options.out), JSON.stringify(proposal, null, 2) + '\n', 'utf8');

console.log('provider        : ' + options.provider);
console.log('sessions scanned: ' + scanned + ' of ' + files.length);
console.log('operator turns  : ' + turns);
console.log('candidates      : ' + proposal.claims.length);
console.log('repeated        : ' + ordered.filter((item) => item.repeats > 1).length);
if (proposal.claims.length > 0) {
  const dates = ordered.map((item) => Date.parse(item.observedAt));
  console.log('valid time span : ' + new Date(Math.min(...dates)).toISOString().slice(0, 10) +
    ' .. ' + new Date(Math.max(...dates)).toISOString().slice(0, 10));
}
console.log('proposal        : ' + resolve(options.out));
console.log('');
console.log('Every candidate enters the review lane unverified. Submit with');
console.log('propose-handoff-claims.mjs, which forces that regardless of what is above.');
