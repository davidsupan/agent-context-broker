import { sha256Hasher } from './platform.mts';
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { noLinks } from './store.mts';
import { buildSlices, digest, type SlicePlan } from './slicing.mts';

// A browser capture of one claude.ai (Cowork) session: the rendered message rows in order. There is no
// role field and no per-message time; a user turn carries the rendered "You said: " prefix. The capture
// time is transaction time, never the valid time of what was said. Read-only; nothing is cached.

export const COWORK_USER_PREFIX = 'You said: ';
const MAX_BYTES = 32 * 1024 * 1024;

export const CoworkCaptureSchema = z.strictObject({
  session: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/),
  title: z.string().max(500),
  url: z.string().max(2000),
  captured: z.iso.datetime(),
  rows: z.array(z.strictObject({ index: z.number().int().min(0), text: z.string().min(1).max(200000) })).min(1).max(20000),
});
export type CoworkCapture = z.infer<typeof CoworkCaptureSchema>;

export function readCoworkCapture(path: string): { capture: CoworkCapture; fileSha256: string } {
  noLinks(path);
  if (statSync(path).size > MAX_BYTES) throw new Error('capture-cowork-too-large');
  const bytes = readFileSync(path);
  const fileSha256 = sha256Hasher().update(bytes).digest('hex');
  const parsed = CoworkCaptureSchema.safeParse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!parsed.success) throw new Error('capture-cowork-shape');
  // Order is the only chronology, so the rows must be complete and in order.
  if (!parsed.data.rows.every((row, position) => row.index === position)) throw new Error('capture-cowork-row-order');
  return { capture: parsed.data, fileSha256 };
}

/** Dialogue rows in capture order: block = row index; the user prefix is removed, never inferred otherwise. */
export function coworkDialogue(capture: CoworkCapture): Array<{ role: 'user' | 'assistant'; text: string }> {
  return capture.rows.map(row => row.text.startsWith(COWORK_USER_PREFIX)
    ? { role: 'user' as const, text: row.text.slice(COWORK_USER_PREFIX.length) }
    : { role: 'assistant' as const, text: row.text });
}

export type CoworkPlan = {
  sourceKey: string; sessionId: string; captured: string; fileSha256: string; jobId: string; receiptSha256: string;
  rows: number; userRows: number; assistantRows: number; chars: number; plan: SlicePlan;
};

/** The slices a capture becomes, with the same redaction and slice identity as transcripts. */
export function planCoworkCapture(path: string, maxChars = 16000): CoworkPlan {
  const { capture, fileSha256 } = readCoworkCapture(path);
  const dialogue = coworkDialogue(capture);
  const sourceKey = `cowork-capture:${capture.session}`;
  const receiptSha256 = digest({ schemaVersion: 1, source: 'cowork-capture', session: capture.session,
    captured: capture.captured, fileSha256 });
  const jobId = digest({ schemaVersion: 1, sourceKey, receiptSha256 });
  const plan = buildSlices(dialogue, jobId, receiptSha256, maxChars);
  return { sourceKey, sessionId: capture.session, captured: capture.captured, fileSha256, jobId, receiptSha256,
    rows: dialogue.length, userRows: dialogue.filter(row => row.role === 'user').length,
    assistantRows: dialogue.filter(row => row.role === 'assistant').length,
    chars: dialogue.reduce((n, row) => n + [...row.text].length, 0), plan };
}
