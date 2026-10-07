import { join } from 'node:path';
import { mkdirSync, openSync, closeSync, fsyncSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { CaptureConfig, runCapture } from './capture.mts';
import { prepareSlices } from './slice-queue.mts';
import { consumeSlice, WorkerPolicy, type ModelRunner } from './consumer.mts';
import { noLinks, openStore, status } from './store.mts';
import { BrokerConfig, publishPending, type BrokerTransport } from './publication.mts';
import { recover } from './recovery.mts';
import { probeOwner, probeNamedJob } from './windows-job.mts';
import { canonical, digest } from './slicing.mts';
import { ProviderConfigSchema } from './provider.mts';
import { prepareDocumentSlices, type DocumentGuard } from './documents.mts';

export const DailyConfig = z.strictObject({
  capture: CaptureConfig,
  semantic: WorkerPolicy,
  broker: BrokerConfig.optional(),
  adapters: ProviderConfigSchema.optional(),
  maxCaptureTicks: z.number().int().min(1).max(8).default(1),
  maxPreparationJobs: z.number().int().min(1).max(32).default(4),
  maxModelCalls: z.number().int().min(1).max(64).default(6)
}).superRefine((value, ctx) => {
  const norm = (items: string[]) => [...new Set(items.map(s => s.normalize('NFC').toLowerCase()))].sort();
  if (JSON.stringify(norm(value.capture.excludedSources)) !== JSON.stringify(norm(value.semantic.excludedSources))) {
    ctx.addIssue({ code: 'custom', message: 'exclusion-policy-mismatch' });
  }
});

type DailyOptions = { synthetic?: boolean; now?: number; rereadConfig?: () => unknown; brokerTransport?: BrokerTransport };
type Daily = z.infer<typeof DailyConfig>;

/** Adapter auth homes and pinned receipts that no document root may overlap. */
function documentGuard(config: Daily): DocumentGuard {
  const bindings = Object.values(config.adapters?.providers ?? {}).filter(binding => binding !== undefined);
  return { authHomes: bindings.map(binding => binding.authHome),
    receipts: bindings.flatMap(binding => [binding.capabilityReceipt.path, ...(binding.liveProfileReceipt ? [binding.liveProfileReceipt.path] : [])]) };
}
const enabledDocuments = (config: Daily) => config.capture.documentSources.filter(source => source.enabled);

function record(path: string, value: unknown) {
  noLinks(path);
  const fd = openSync(path, 'wx');
  try { writeFileSync(fd, canonical(value) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
}

async function executeDaily(config: z.infer<typeof DailyConfig>, input: unknown, home: string,
  runner: ModelRunner | undefined, options: DailyOptions) {
  const capture = [];
  const documents = enabledDocuments(config), documentIds = documents.map(source => source.id);
  for (let index = 0; index < config.maxCaptureTicks; index++) {
    const result = runCapture(config.capture, home, true, documentGuard(config)); capture.push(result);
    if (result.state === 'busy' || result.state === 'complete-tick') break;
  }
  const prepared = [];
  for (let index = 0; index < config.maxPreparationJobs; index++) {
    const result = prepareSlices(home, config.semantic.excludedSources, config.semantic.sliceChars, true);
    prepared.push(result);
    if (result.state !== 'prepared') break;
  }
  const preparedDocuments = [];
  for (let index = 0; documents.length && index < config.maxPreparationJobs; index++) {
    const result = prepareDocumentSlices(home, documentIds, config.semantic.sliceChars, true);
    preparedDocuments.push(result);
    if (result.state !== 'prepared') break;
  }
  const recovery = await recover(home, config.semantic, true, {
    ownerStatus: probeOwner,
    containmentStatus: descriptor => probeNamedJob(z.object({ jobName: z.string() }).parse(descriptor).jobName)
  });
  const attempts = [];
  const publications = [];
  let modelCalls = 0;
  for (let index = 0; index < config.maxModelCalls; index++) {
    const current = DailyConfig.parse(options.rereadConfig?.() ?? input);
    // Never broaden roots or exclusions during an already admitted daily run.
    if (JSON.stringify(current.capture) !== JSON.stringify(config.capture)) throw new Error('capture-policy-changed');
    const result = await consumeSlice(home, current.semantic, runner, {
      ...(options.synthetic !== undefined ? { synthetic: options.synthetic } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(documents.length ? { documents: { sourceIds: documentIds,
        reread: () => enabledDocuments(DailyConfig.parse(options.rereadConfig?.() ?? input)).map(source => source.id) } } : {}),
      rereadPolicy: () => DailyConfig.parse(options.rereadConfig?.() ?? input).semantic
    });
    attempts.push(result);
    if (result.invoked) modelCalls++;
    if (!['pending-review', 'quota-unavailable'].includes(result.state)) break;
  }
  if (config.broker) {
    for (let index = 0; index < config.maxModelCalls; index++) {
      const current = DailyConfig.parse(options.rereadConfig?.() ?? input);
      if (JSON.stringify(current.broker) !== JSON.stringify(config.broker)) throw new Error('broker-policy-changed');
      const result = await publishPending(home, current.semantic, config.broker, true, options.brokerTransport, undefined, documents);
      publications.push(result);
      if (result.state === 'idle') break;
    }
  }
  using db = openStore(join(home, 'queue.sqlite3'));
  return { state: runner ? (attempts.at(-1)?.state ?? 'no-attempt') : 'capture-only-adapter-unverified', writes: true,
    modelCalls, capture, prepared, ...(documents.length ? { preparedDocuments } : {}), recovery, attempts, publications,
    status: status(db, options.now), fullyCurrent: false, productionEnabled: false };
}

export async function runDaily(input: unknown, home: string, execute = false, runner?: ModelRunner, options: DailyOptions = {}) {
  const config = DailyConfig.parse(input);
  const capturePlan = runCapture(config.capture, home, false, documentGuard(config));
  if (!execute) return { state: 'plan', writes: false, modelCalls: 0, fullyCurrent: false, capture: capturePlan };
  const id = randomUUID();
  const directory = join(home, 'daily-runs');
  noLinks(directory); mkdirSync(directory, { recursive: true });
  record(join(directory, `${id}.started.json`), { schemaVersion: 1, runId: id,
    recordedAt: new Date().toISOString(), configSha256: digest(config), mode: options.synthetic ? 'synthetic' : 'production-candidate' });
  try {
    const result = await executeDaily(config, input, home, runner, options);
    record(join(directory, `${id}.finished.json`), { schemaVersion: 1, runId: id, recordedAt: new Date().toISOString(), result });
    return result;
  } catch (error) {
    record(join(directory, `${id}.failed.json`), { schemaVersion: 1, runId: id, recordedAt: new Date().toISOString(), code: 'daily-run-failed', fullyCurrent: false });
    throw error;
  }
}
