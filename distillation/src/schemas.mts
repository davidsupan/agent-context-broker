import { z } from 'zod';

export const DAILY_SECONDS = 1800;
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const TokenSchema = z.string().regex(/^[a-f0-9]{32}$/);
export const UnixSecondsSchema = z.number().finite().nonnegative().max(8.64e12);
export const OpenOptionsSchema = z.strictObject({
  readonly: z.boolean().default(true),
  create: z.boolean().default(false)
});
export const ReservationSchema = z.strictObject({
  jobId: z.string().min(1).max(128),
  sliceId: z.string().min(1).max(128),
  payloadSha: HashSchema,
  sourceReceiptSha: HashSchema,
  owner: z.json().optional(),
  containment: z.json().optional(),
  claudeAvailable: z.boolean().default(false),
  codexAvailable: z.boolean().default(false),
  claudeUnavailableReason: z.string().max(100).optional(),
  seconds: z.number().int().min(1).max(DAILY_SECONDS).default(300),
  now: UnixSecondsSchema.default(() => Date.now() / 1000),
  // The document lane has its own cap inside the global budget; transcript is the unchanged default.
  lane: z.enum(['transcript', 'document']).default('transcript'),
  laneCapSeconds: z.number().int().min(0).max(DAILY_SECONDS).default(0)
});
export type ReservationInput = z.input<typeof ReservationSchema>;
export const ReservationResultSchema = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('reserved'), token: TokenSchema,
    provider: z.enum(['claude', 'codex']), reason: z.enum(['primary', 'claude-quota-unavailable']),
    reservedSeconds: z.number().int().min(1).max(DAILY_SECONDS), utcDay: z.iso.date(), invoked: z.literal(false)
  }),
  z.strictObject({
    state: z.enum(['paused-day-boundary', 'leased', 'paused-quota', 'paused-unavailable',
      'paused-budget', 'paused-lane-budget', 'source-state-changed', 'busy']), invoked: z.literal(false)
  })
]);
export type ReservationResult = z.infer<typeof ReservationResultSchema>;
export const BudgetRowSchema = z.object({ seconds: z.number().int().min(0).max(DAILY_SECONDS) });
export const SliceRowSchema = z.object({ payload_sha: HashSchema, receipt_hash: HashSchema });
export const ColumnRowsSchema = z.array(z.object({ name: z.string() }));
export const CountRowsSchema = z.array(z.object({ state: z.string(), n: z.number().int().nonnegative() }));
export const StatusSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runtime: z.literal('bun'),
  utcDay: z.iso.date(),
  dailyLimitSeconds: z.literal(DAILY_SECONDS),
  reservedSeconds: z.number().int().min(0).max(DAILY_SECONDS),
  fullyCurrent: z.literal(false),
  productionEnabled: z.literal(false),
  boundary: z.string(),
  sourcesByState: z.record(z.string(), z.number().int().nonnegative()).optional(),
  jobsByState: z.record(z.string(), z.number().int().nonnegative()).optional(),
  attemptsByState: z.record(z.string(), z.number().int().nonnegative()).optional(),
  oldestPendingAt: UnixSecondsSchema.nullable().optional(),
  slicesByState: z.record(z.string(), z.number().int().nonnegative()).optional(),
  brokerPublicationsByState: z.record(z.string(), z.number().int().nonnegative()).optional(),
  acceptedState: z.literal('not-observed')
});
export type StoreStatus = z.infer<typeof StatusSchema>;
