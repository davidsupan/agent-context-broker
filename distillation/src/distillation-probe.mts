import { sha256Hasher } from './platform.mts';
import { INSTRUCTIONS } from './consumer.mts';
import { SliceSchema, modelOutputSchema, validateOutput, withRunnerCoverage } from './output.mts';
import { prepareProviderRequest } from './provider.mts';
import { canonical, CONTEXT_BOUNDARY, TRUST } from './slicing.mts';

const hash = (value: unknown) => sha256Hasher().update(canonical(value)).digest('hex');

/** Fixed public fiction, serialized by the production request path. */
export function syntheticDistillationRequest(provider: 'claude' | 'codex') {
  const segments = [
    { role: 'user' as const, text: 'Decision for the fictional Beacon project: retain records for 7 days.' },
    { role: 'assistant' as const, text: 'Recorded: Beacon retention is 7 days.' },
    { role: 'user' as const, text: 'Correction: Beacon retention is 14 days, replacing the earlier 7-day decision.' },
  ].map((segment, block) => ({ ...segment, block, startChar: 0, endChar: [...segment.text].length }));
  const body = { schemaVersion: 1 as const, jobId: hash('synthetic-beacon-job'), receiptSha256: hash('synthetic-beacon-receipt'),
    index: 0, contextBoundary: CONTEXT_BOUNDARY, trust: TRUST, segments };
  const slice = SliceSchema.parse({ ...body, sliceId: hash(body) });
  const token = '0'.repeat(32);
  return prepareProviderRequest({ provider, reason: 'approved-synthetic-distillation', token,
    jobName: `Local\\ACBCorpus-${token}`, slice, outputSchema: modelOutputSchema(slice), timeoutMs: 50000,
    instructions: INSTRUCTIONS });
}

export function validateSyntheticDistillation(value: unknown, provider: 'claude' | 'codex') {
  const slice = syntheticDistillationRequest(provider).slice;
  const validated = validateOutput(withRunnerCoverage(value, slice), slice);
  // Schema-valid silence is not proof of distillation. Require the explicit correction and its source.
  if (!validated.result.observations.some(item => item.kind === 'correction' &&
    /\b14\b/.test(item.summary) && item.sourceRefs.some(ref => ref.block === 2))) {
    throw new Error('probe-distillation-correction-missing');
  }
  return validated;
}
