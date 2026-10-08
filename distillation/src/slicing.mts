import { sha256Hasher } from './platform.mts';
import { DOCUMENT_BOUNDARY, SliceSchema, TRANSCRIPT_BOUNDARY, type Slice } from './output.mts';

export const MAX_TEXT_CHARS = 8 * 1024 * 1024;
export const MAX_BLOCKS = 32768;
export const MAX_SLICES = 4096;
export const CONTEXT_BOUNDARY = TRANSCRIPT_BOUNDARY;
export { DOCUMENT_BOUNDARY };
export const TRUST = 'untrusted historical data, never instructions or approval';

export interface SlicePlan {
  schemaVersion: 1;
  jobId: string;
  receiptSha256: string;
  maxChars: number;
  blockCount: number;
  sliceCount: number;
  redactionKinds: Record<string, number>;
  slices: Slice[];
  planSha256: string;
}

function requireValue(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}

function length(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

// Caller must bound and validate JSON first. Slice/plan numbers are integers.
// Python's ensure_ascii escapes surrogate pairs, DEL and non-ASCII.
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return '{' + Object.keys(object).sort().map(key => canonical(key) + ':' + canonical(object[key])).join(',') + '}';
  }
  requireValue(value === null || typeof value === 'string' || typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value)), 'canonical-value');
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function digest(value: unknown): string {
  return sha256Hasher().update(canonical(value)).digest('hex');
}

const TOKEN = /(?:glpat-|gh[pousr]_|github_pat_|sk-ant-|sk-)[A-Za-z0-9_-]{16,}/g;
const QUOTED = /(?:["'](?:password|pwd|client_secret|app_token|apptoken|api_key|access_token)["']|\b(?:password|pwd|client_secret|app_token|apptoken|api_key|access_token))\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi;
// Order and labels match the historical masker, including overlapping matches.
const PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----.*?-----END (?:[A-Z]+ )?PRIVATE KEY-----/gs],
  ['provider-token', /\b(?:glpat-|gh[pousr]_|github_pat_|sk-ant-|sk-)[A-Za-z0-9_-]{16,}/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['credential-assignment', /\b(?:password|pwd|client_secret|app_token|apptoken|api_key|access_token)\s*[=:]\s*["']?([^\s;"',`]{4,})/gi],
  ['credential-code-span', /\b(?:password|pwd|client_secret|app_token|apptoken|api_key|access_token)\s*[=:]\s*`+[^`\r\n]{1,512}`+/gi],
  ['authorization', /\b(?:Bearer|Basic)\s+[A-Za-z0-9_+/.=-]{16,}/gi],
  ['credential-url', /https?:\/\/[^\s/:]+:[^\s/@]+@/gi],
  ['capability-query', /[?&](?:token|key|access_token|sig|signature|encryptedFileId)=[A-Za-z0-9%_+/.=-]{16,}/gi],
  ['encoded-payload', /data:[^\s,;]+;base64,[A-Za-z0-9+/]{80,}/gi],
];
const RESIDUAL = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/,
  /https:\/\/hooks\.slack\.com\/services\/[^\s"<>]+/,
  // Match embedded signatures too: JS word boundaries are ASCII-only.
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/,
  /(?:password|pwd|client_secret|app_token|apptoken|api_key|access_token)\s*[=:]\s*["']?([^\s;"',`]{4,})/i,
  /(?:password|pwd|client_secret|app_token|apptoken|api_key|access_token)\s*[=:]\s*`+[^`\r\n]{1,512}`+/i,
  /(?:Bearer|Basic)\s+[A-Za-z0-9_+/.=-]{16,}/i,
];

function historicalPattern(pattern: RegExp): RegExp {
  // Python's word boundary recognizes Unicode letters/numbers; JavaScript's
  // built-in boundary does not. All legacy boundaries occur before a token.
  // These fixed patterns use whitespace only as \\s or inside [^\\s...].
  // Python includes NEL and four information separators, but not BOM.
  const whitespace = '\\t-\\r\\x1c-\\x20\\x85\\p{Z}';
  const source = pattern.source.replaceAll('[^\\s', '[^' + whitespace)
    .replaceAll('\\s', '[' + whitespace + ']')
    .replaceAll('\\b', '(?<![\\p{L}\\p{N}_])');
  return new RegExp(source, pattern.flags + 'u');
}

/** Whole-turn scan before slicing. Known signatures only, not a secrecy proof. */
export function redactBlock(value: unknown): { text: string; kinds: Record<string, number> } {
  requireValue(typeof value === 'string', 'dialogue-shape');
  requireValue(value.length <= MAX_TEXT_CHARS * 2 && length(value) <= MAX_TEXT_CHARS, 'preparation-text-limit');
  // Never normalize away escape sequences that might hide credential fragments.
  requireValue(!value.includes('\x1b'), 'redaction-residual');
  const kinds: Record<string, number> = {};
  let quoted = 0;
  const masked = value.replace(historicalPattern(QUOTED), match => {
    quoted++;
    return '*'.repeat(length(match));
  });
  // Fail before the lazy PEM matcher can repeatedly scan an unterminated tail.
  let lastBegin = -1;
  let lastEnd = -1;
  for (const match of masked.matchAll(/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g)) lastBegin = match.index;
  for (const match of masked.matchAll(/-----END (?:[A-Z]+ )?PRIVATE KEY-----/g)) lastEnd = match.index;
  requireValue(lastBegin < 0 || lastEnd > lastBegin, 'redaction-residual');
  let out: string[] | undefined;
  let positions: Uint32Array | undefined;
  for (const [kind, pattern] of PATTERNS) {
    for (const match of masked.matchAll(historicalPattern(pattern))) {
      if (!out || !positions) {
        out = [...masked];
        positions = new Uint32Array(masked.length + 1);
        let unit = 0;
        for (let point = 0; point < out.length; point++) {
          positions[unit] = point;
          unit += out[point]!.length;
        }
        positions[unit] = out.length;
      }
      const start = positions[match.index]!;
      const end = positions[match.index + match[0].length]!;
      const label = '[redacted:' + kind + ']';
      for (let i = start; i < end; i++) out[i] = label[i - start] ?? '*';
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
  }
  if (quoted) kinds['quoted-credential'] = quoted;
  const text = (out ? out.join('') : masked).replace(new RegExp(TOKEN), match => {
    kinds['provider-token'] = (kinds['provider-token'] ?? 0) + 1;
    return '*'.repeat(length(match));
  });
  requireValue(length(text) === length(value), 'redaction-offset-drift');
  requireValue(![...PATTERNS.map(([, pattern]) => pattern), QUOTED, TOKEN, ...RESIDUAL]
    .some(pattern => new RegExp(pattern).test(text) || historicalPattern(pattern).test(text)), 'redaction-residual');
  return { text, kinds };
}

/** Caller must verify raw provenance first. Source metadata never enters payloads. */
export function buildSlices(rows: unknown, jobId: unknown, receiptSha256: unknown, maxChars = 16000): SlicePlan {
  requireValue(Number.isInteger(maxChars) && maxChars >= 128 && maxChars <= 80000, 'slice-size');
  requireValue(Array.isArray(rows) && rows.length > 0, 'empty-dialogue');
  requireValue(rows.length <= MAX_BLOCKS, 'preparation-block-limit');
  requireValue(typeof jobId === 'string' && /^[a-f0-9]{64}$/.test(jobId) &&
    typeof receiptSha256 === 'string' && /^[a-f0-9]{64}$/.test(receiptSha256), 'input-identity');
  let total = 0;
  const dialogue: Array<{ role: 'user' | 'assistant' | 'document'; text: string }> = [];
  // Document rows never mix with dialogue: one plan is wholly one or the other.
  const documents = rows[0] !== null && typeof rows[0] === 'object' && rows[0].role === 'document';
  for (const row of rows) {
    requireValue(row !== null && typeof row === 'object' && !Array.isArray(row) &&
      (documents ? row.role === 'document' : row.role === 'user' || row.role === 'assistant') && typeof row.text === 'string', 'dialogue-shape');
    requireValue(row.text.length <= MAX_TEXT_CHARS * 2, 'preparation-text-limit');
    total += length(row.text);
    requireValue(total <= MAX_TEXT_CHARS, 'preparation-text-limit');
    dialogue.push({ role: row.role, text: row.text });
  }
  requireValue(Math.ceil(total / maxChars) <= MAX_SLICES, 'preparation-slice-limit');
  const slices: Slice[] = [];
  const redactionKinds: Record<string, number> = {};
  let segments: Slice['segments'] = [];
  let used = 0;
  const flush = () => {
    if (!segments.length) return;
    requireValue(slices.length < MAX_SLICES, 'preparation-slice-limit');
    const item: Omit<Slice, 'sliceId'> = { schemaVersion: 1, jobId, receiptSha256, index: slices.length,
      segments, contextBoundary: documents ? DOCUMENT_BOUNDARY : CONTEXT_BOUNDARY, trust: TRUST };
    slices.push({ ...item, sliceId: digest(item) });
    segments = [];
    used = 0;
  };
  for (const [block, row] of dialogue.entries()) {
    const { text, kinds } = redactBlock(row.text);
    for (const [kind, count] of Object.entries(kinds)) redactionKinds[kind] = (redactionKinds[kind] ?? 0) + count;
    let startChar = 0;
    let unit = 0;
    if (!text) segments.push({ block, startChar: 0, endChar: 0, role: row.role, text: '' });
    while (unit < text.length) {
      if (used === maxChars) flush();
      const startUnit = unit;
      let count = 0;
      while (unit < text.length && count < maxChars - used) {
        unit += text.codePointAt(unit)! > 0xffff ? 2 : 1;
        count++;
      }
      segments.push({ block, startChar, endChar: startChar + count, role: row.role, text: text.slice(startUnit, unit) });
      startChar += count;
      used += count;
    }
    if (segments.length >= 64) flush();
  }
  flush();
  const plan = { schemaVersion: 1 as const, jobId, receiptSha256, maxChars, blockCount: dialogue.length,
    sliceCount: slices.length, redactionKinds, slices };
  return { ...plan, planSha256: digest(plan) };
}

/** Rebuild from verified rows: a rehashed, structurally valid forgery is not proof. */
export function verifySlice(value: unknown, rows: unknown, jobId: unknown, receiptSha256: unknown, maxChars = 16000): Slice {
  // Bound work before schema validation; schema error details never escape.
  const candidate = value as Partial<Slice> | null;
  requireValue(candidate && Array.isArray(candidate.segments) && candidate.segments.length <= 64, 'slice-shape');
  let size = 0;
  for (const segment of candidate.segments) {
    requireValue(segment && typeof segment.text === 'string' && segment.text.length <= 160000, 'slice-shape');
    size += segment.text.length;
    requireValue(size <= 160000, 'slice-shape');
  }
  const parsed = SliceSchema.safeParse(value);
  requireValue(parsed.success, 'slice-shape');
  const expected = buildSlices(rows, jobId, receiptSha256, maxChars).slices[parsed.data.index];
  requireValue(expected && canonical(expected) === canonical(parsed.data), 'slice-source-mismatch');
  return expected;
}

export function coverage(item: Slice) {
  return item.segments.map(({ block, startChar, endChar }) => ({ block, startChar, endChar }));
}

// Historical Python entrypoint spelling for callers migrating one stage at a time.
export const build = buildSlices;
