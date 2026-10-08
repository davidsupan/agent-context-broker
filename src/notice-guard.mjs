import { createHash } from 'node:crypto';
import { z } from 'zod';

export const NOTICE_ID = /^NTC-\d{8}-[a-f0-9]{6}$/u;
export const ROLE_ID = /^[a-z][a-z0-9-]*(?:\/[a-z][a-z0-9-]*)?$/u;
export const MAX_RECORD_BYTES = 128 * 1024;
const shortText = z.string().min(1).max(200);
const timestamp = z.iso.datetime();
const role = z.string().max(64).regex(ROLE_ID);
const rendering = z.strictObject({
  headline: z.string().min(1).max(140).refine((v) => !/[\r\n]/u.test(v)),
  summary: z.string().min(1).max(600), full: z.string().min(1).max(4000)
});
const change = z.strictObject({
  changeId: z.string().regex(/^CHG-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu),
  category: z.enum(['token', 'component', 'layout', 'pattern', 'behaviour', 'fix', 'breaking', 'docs']),
  target: shortText, before: z.string().max(600), after: z.string().max(600),
  renderings: z.record(role, rendering).refine((v) => Object.keys(v).length > 0 && Object.keys(v).length <= 32)
});
const common = {
  schemaVersion: z.literal(1), recordType: z.literal('notice'), recordId: z.string().regex(NOTICE_ID),
  subject: z.strictObject({ type: z.enum(['design-kit', 'prototype', 'pack']), id: shortText,
    fromVersion: shortText.nullable(), toVersion: shortText }),
  author: z.string().max(100).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u),
  recordedAt: timestamp, sensitivity: z.literal('shared'),
  audience: z.array(role).min(1).max(32).refine((v) => new Set(v).size === v.length),
  expiresAt: timestamp.nullable(), supersedes: z.array(z.string().regex(NOTICE_ID)).max(128),
  changes: z.array(change).min(1).max(32),
  links: z.array(z.strictObject({ rel: shortText, href: z.string().max(2048) })).max(32)
};
export const noticeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('announcement'), expectedAt: timestamp, expectedScope: z.string().min(1).max(600) }),
  z.strictObject({ ...common, kind: z.literal('release'), publishedAt: timestamp,
    artifact: z.strictObject({ href: z.string().max(2048), digest: z.string().regex(/^[a-f0-9]{64}$/u) }) })
]);

const multilingualPatterns = [
  { id: 'policy-instruction-sl', literals: [
    ...['prezri', 'ignoriraj'].flatMap((verb) => ['prejšnja', 'predhodna', 'vsa'].map((word) => `${verb} ${word} navodila`)),
    'pozabi navodila', 'ti si zdaj', 'sistemski poziv', 'izvedi ukaz', 'zaženi', 'potisni na main'
  ] },
  { id: 'policy-instruction-de', literals: [
    'ignoriere vorherige anweisungen', 'ignoriere alle anweisungen', 'ignoriere frühere anweisungen',
    'vergiss die anweisungen', 'du bist jetzt', 'systemprompt', 'system prompt',
    'führe den befehl aus', 'starte', 'pushe auf main'
  ] },
  { id: 'policy-instruction-hr', literals: [
    'zanemari prethodne upute', 'ignoriraj prethodne upute', 'ignoriraj sve upute',
    'zanemari sve upute', 'zaboravi upute', 'ti si sada', 'sistemski upit',
    'izvrši naredbu', 'pokreni', 'pošalji na main'
  ] }
];
// Policy configures language literals and can add patterns; never arbitrary regexes.
export const guardPolicySchema = z.strictObject({
  schemaVersion: z.literal(1),
  allowedHosts: z.array(z.string().max(253).regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u)).max(128).default([]),
  patterns: z.array(z.strictObject({ id: z.string().regex(/^policy-[a-z0-9-]{1,64}$/u),
    literals: z.array(z.string().min(1).max(200)).min(1).max(32) })).max(64).default(multilingualPatterns)
});
/** @typedef {z.infer<typeof noticeSchema>} NoticeRecord */
/** @typedef {z.infer<typeof guardPolicySchema>} GuardPolicy */
/** @typedef {{ recordId: string|null, contentDigest: string, quarantineReasons: string[], record?: NoticeRecord }} GuardedNotice */

export const DEFAULT_GUARD_POLICY = guardPolicySchema.parse({ schemaVersion: 1 });
const forbidden = /[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/u;
const patterns = Object.freeze({
  'html': /<\/?[a-z!][^>]*>|&(?:#\d+|#x[a-f0-9]+|lt|gt);/iu,
  'markdown-image': /!\s*\[/u,
  'markdown-link': /\[[^\]]*\]\s*(?:\(|\[)|^\s*\[[^\]]+\]:/mu,
  'instruction-override': /\b(?:ignore|disregard|forget|override)\b[\s\S]{0,50}\b(?:previous|prior|above|instructions?|rules?)\b|\bsystem\s+prompt\b|\byou\s+are\s+now\b|\bas\s+an?\s+ai\b/iu,
  'role-prefix': /(?:^|[\r\n\s])(?:assistant|system|developer|user|tool)\s*:/iu,
  'agent-tool': /\b(?:exec_command|write_stdin|apply_patch|read_file|write_file|run_command|shell_exec|tool_use|multi_tool_use|function_call|WebFetch|WebSearch|TodoWrite|TodoRead|mcp__[\w_]+)\b|\b(?:functions|tools)\s*\.|\b(?:Read|Write|Edit|Grep|Glob|Task)\s*\(/iu,
  'shell-command': /\b(?:powershell|pwsh|bash|cmd\.exe|invoke-expression|invoke-webrequest|start-process|remove-item|curl|wget|sudo|chmod)\b|\b(?:rm|ls|cat|sh|cmd|python|node|npm|git)\s+(?:-[a-z]|install\b|clone\b|reset\b|clean\b)|\$\(|`[^`]+`|\beval\s*\(|\bnew\s+Function\b/iu,
  'encoded-blob': /(?:^|[^a-z0-9+/])[a-z0-9+/]{40,}={0,2}(?:$|[^a-z0-9+/=])/iu
});
export const GUARD_RULE_IDS = Object.freeze(['schema', 'record-size', 'record-json', 'unicode', 'folder', 'filename',
  'raw-url', 'link-allowlist', 'envelope-marker', ...Object.keys(patterns), ...multilingualPatterns.map((p) => p.id), 'audience-rendering', 'audience-policy', 'duplicate-id',
  'supersedes-missing', 'supersedes-cycle', 'supersedes-quarantined']);

/** Normalise heuristics identically for policy literals and record text. @param {string} text */
function folded(text) {
  return text.normalize('NFKC').toLowerCase().replace(/ß/gu, 'ss').replace(/ς/gu, 'σ')
    .normalize('NFD').replace(/[\p{M}\p{Default_Ignorable_Code_Point}]/gu, '').replace(/\s+/gu, ' ');
}

/** @param {string} text @param {number} cap */
export function sanitiseNoticeText(text, cap) {
  return Array.from(text.normalize('NFKC').replace(/\r\n?/gu, '\n')
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029]/gu, (c) => c === '\n' || c === '\t' ? c : '')).slice(0, cap).join('');
}

/** @param {string} href @param {GuardPolicy} policy */
function allowedLink(href, policy) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') &&
      policy.allowedHosts.includes(url.hostname) && !/[\s\\]/u.test(href);
  } catch { return false; }
}

/** Validate every field, including unused renderings. Never return a failed record or parser diagnostic containing text.
 * @param {Buffer} bytes @param {string} path @param {GuardPolicy} [policy] @returns {GuardedNotice} */
export function guardNotice(bytes, path, policy = DEFAULT_GUARD_POLICY) {
  const name = path.split('/').at(-1)?.replace(/\.json$/u, '') ?? '';
  const result = { recordId: NOTICE_ID.test(name) ? name : null,
    contentDigest: createHash('sha256').update(bytes).digest('hex'), quarantineReasons: /** @type {string[]} */ ([]) };
  const reasons = new Set();
  if (bytes.length > MAX_RECORD_BYTES) reasons.add('record-size');
  let raw;
  try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return { ...result, quarantineReasons: ['record-json', ...reasons] }; }
  const parsed = noticeSchema.safeParse(raw);
  if (!parsed.success) return { ...result, quarantineReasons: ['schema', ...reasons] };
  const record = parsed.data;
  if (path !== `records/notices/${record.subject.type}/${record.recordId}.json`) {
    if (name !== record.recordId) reasons.add('filename');
    if (path.split('/').length !== 4 || path.split('/')[2] !== record.subject.type) reasons.add('folder');
  }
  for (const item of record.changes) {
    if (record.audience.some((r) => !Object.hasOwn(item.renderings, r))) reasons.add('audience-rendering');
  }
  /** @param {unknown} value @param {string[]} [keys] */
  function lint(value, keys = []) {
    if (typeof value === 'string') {
      if (forbidden.test(value.replace(/[\n\r\t]/gu, ''))) reasons.add('unicode');
      const normal = value.normalize('NFKC');
      const heuristic = folded(value);
      const compact = heuristic.replace(/[\p{White_Space}\p{P}\p{S}]/gu, '');
      if (['teamnoticedatanotinstructions', 'endteamnoticedata', 'teamnoticedata'].some((marker) => compact.includes(marker))) {
        reasons.add('envelope-marker');
      }
      if (keys.at(-1) === 'href') {
        if (!allowedLink(normal, policy)) reasons.add('link-allowlist');
        return;
      }
      // Digests and structured ids are not encoded prose.
      if (['digest', 'changeId', 'recordId'].includes(keys.at(-1) ?? '')) return;
      if (/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|mailto:|data:|javascript:)/iu.test(normal)) reasons.add('raw-url');
      // Preserve line-sensitive structural checks as well as folded heuristic matching.
      for (const [id, pattern] of Object.entries(patterns)) if (pattern.test(normal) || pattern.test(heuristic)) reasons.add(id);
      for (const pattern of policy.patterns) {
        if (pattern.literals.some((literal) => heuristic.includes(folded(literal)))) reasons.add(pattern.id);
      }
    } else if (Array.isArray(value)) value.forEach((item) => lint(item, keys));
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) lint(item, [...keys, key]);
  }
  lint(record);
  if (reasons.size) return { ...result, quarantineReasons: [...reasons].sort() };
  return { ...result, record };
}

/** Quarantine invalid graphs before computing statuses. Invalid records cannot supersede valid ones.
 * @param {GuardedNotice[]} notices */
export function guardSupersedes(notices) {
  const byId = new Map();
  for (const notice of notices) {
    if (!notice.record) continue;
    const previous = byId.get(notice.record.recordId);
    if (previous) { previous.quarantineReasons.push('duplicate-id'); notice.quarantineReasons.push('duplicate-id'); }
    else byId.set(notice.record.recordId, notice);
  }
  // Iterative reachability avoids a malicious chain overflowing the call stack.
  for (const notice of notices) {
    if (!notice.record) continue;
    const pending = [...notice.record.supersedes];
    const visited = new Set();
    while (pending.length) {
      const id = pending.pop();
      if (id === notice.record.recordId) { notice.quarantineReasons.push('supersedes-cycle'); break; }
      if (visited.has(id)) continue;
      visited.add(id);
      const target = byId.get(id);
      if (!target) { notice.quarantineReasons.push('supersedes-missing'); continue; }
      pending.push(...target.record.supersedes);
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const notice of notices) {
      if (notice.record && !notice.quarantineReasons.length && notice.record.supersedes.some((id) => byId.get(id)?.quarantineReasons.length)) {
        notice.quarantineReasons.push('supersedes-quarantined'); changed = true;
      }
    }
  }
  for (const notice of notices) if (notice.quarantineReasons.length) {
    notice.quarantineReasons = [...new Set(notice.quarantineReasons)].sort();
    delete notice.record;
  }
  return notices;
}
