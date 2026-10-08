import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { sha256 as digest, stableJson } from './event-store.mjs';
export { stableJson } from './event-store.mjs';
import { loadProviderPolicy } from './provider-policy.mjs';
import { defaultRuntimeHome } from './platform-paths.mjs';

// This ledger is independent of the broker event schema. No payloads belong here.
export type RecordData = { type: string; grantId: string; [key: string]: any };
export type LedgerRecord = RecordData & { prevHash: string; hash: string };
export type EmergencyOptions = { runtimeHome?: string; runtimeRoot?: string; runtimeRoots?: (string | undefined)[];
  providerPolicyPath?: string; provider?: string; now?: string | Date; execute?: boolean; env?: NodeJS.ProcessEnv; [key: string]: any };
const zero = '0'.repeat(64);
const identifier = z.string().min(1).max(200);
const hashString = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.iso.datetime({ offset: true });
const baseRecord = { grantId: identifier };
const recordSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...baseRecord, type: z.literal('opened'), schemaVersion: z.literal(1),
    provider: z.enum(['codex', 'claude-code']), mode: z.literal('full'), trigger: z.enum(['primary-rate-limit', 'manual']),
    reason: z.string().min(1).max(500).regex(/^[^\x00-\x1f\x7f\u2028\u2029]+$/u),
    window: z.enum(['five_hour', 'seven_day', 'other']).nullable(), openedAt: timestamp, expiresAt: timestamp,
    openedBy: z.enum(['host', 'cli']), supersedes: identifier.optional() }),
  z.strictObject({ ...baseRecord, type: z.literal('closed'), closedAt: timestamp, reason: z.enum(['expired', 'primary-restored', 'manual']) }),
  z.strictObject({ ...baseRecord, type: z.literal('used'), at: timestamp, command: z.enum(['query', 'publish', 'progress', 'refresh']),
    scopes: z.array(z.strictObject({ relationKey: z.string().regex(/^[a-z-]+:[a-f0-9]{64}$/u), kind: identifier })),
    profile: z.string().nullable(), routeReason: z.string(), claimIds: z.array(hashString), claimKeys: z.array(z.string()),
    peerProgressIds: z.array(hashString), teamNoticeIds: z.array(identifier),
    counts: z.strictObject({ claims: z.number().int().nonnegative(), peerProgress: z.number().int().nonnegative(),
      teamNotices: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
    publishedClaimKeys: z.array(z.string()).optional(),
    writes: z.array(z.strictObject({ claimId: hashString, claimKey: z.string(), scopeKey: z.string(), reviewId: identifier.optional() })).optional() })
]);

export function emergencyHome(options: EmergencyOptions): string | null {
  if (options.runtimeHome) return resolve(options.runtimeHome);
  const roots = options.runtimeRoots ?? [options.runtimeRoot].filter(Boolean);
  if (roots.length) {
    const homes = new Set(roots.filter(Boolean).map(root => {
      const parent = dirname(resolve(root!));
      return basename(parent).toLowerCase() === 'runtime' ? dirname(parent) : null;
    }));
    return homes.size === 1 ? [...homes][0] ?? null : null;
  }
  if (options.providerPolicyPath) return dirname(resolve(options.providerPolicyPath));
  return defaultRuntimeHome({ env: options.env ?? process.env });
}
export function verifyEmergency(home: string | null): { valid: boolean; records: LedgerRecord[]; warnings: string[] } {
  if (!home) return { valid: true, records: [], warnings: [] };
  const path = join(home, 'emergency', 'grants.jsonl');
  try {
    if (!existsSync(path)) {
      if (existsSync(join(home, 'emergency', 'head.json'))) throw new Error('missing ledger');
      return { valid: true, records: [], warnings: [] };
    }
    const text = readFileSync(path, 'utf8');
    if (text && !text.endsWith('\n')) throw new Error('partial record');
    const records: LedgerRecord[] = [];
    let previous = zero;
    const grants = new Map<string, LedgerRecord>();
    for (const line of text.split('\n').filter(Boolean)) {
      const record = JSON.parse(line) as LedgerRecord;
      const { hash, ...core } = record;
      const { prevHash: _previous, ...data } = core;
      recordSchema.parse(data);
      if (record.prevHash !== previous || digest(stableJson(core)) !== hash) throw new Error('chain');
      if (record.type === 'opened') {
        validateOpen({ provider: record.provider, until: record.expiresAt, reason: record.reason,
          trigger: record.trigger, window: record.window }, new Date(record.openedAt));
        if (record.schemaVersion !== 1 || grants.has(record.grantId) || !['cli', 'host'].includes(record.openedBy)) throw new Error('open');
        if (record.supersedes && !grants.has(record.supersedes)) throw new Error('supersedes');
        grants.set(record.grantId, record);
      } else if (!grants.has(record.grantId) || !['used', 'closed'].includes(record.type)) throw new Error('record');
      previous = hash;
      records.push(record);
    }
    const headPath = join(home, 'emergency', 'head.json');
    const head = existsSync(headPath) ? JSON.parse(readFileSync(headPath, 'utf8')) : null;
    if (head?.hash === previous && head?.records === records.length) return { valid: true, records, warnings: [] };
    // A writer that stopped between the fsynced append and the checkpoint rename leaves the
    // checkpoint exactly one valid record behind. A missing tail record is still detected.
    const behind = records.length - 1;
    const expected = behind === 0 ? null : { hash: records[behind - 1]!.hash, records: behind };
    if (records.length && (expected ? head?.hash === expected.hash && head?.records === expected.records : head === null))
      return { valid: true, records, warnings: ['emergency-head-behind'] };
    throw new Error('head mismatch');
  } catch { return { valid: false, records: [], warnings: ['emergency-ledger-invalid'] }; }
}
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30000;
function lockOwnerGone(path: string): boolean {
  try {
    const owner = JSON.parse(readFileSync(path, 'utf8'));
    if (!Number.isInteger(owner?.pid) || typeof owner?.at !== 'string') return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS;
    if (Date.now() - Date.parse(owner.at) > LOCK_STALE_MS) return true;
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
  } catch (error) {
    // A lock file that is being written has no owner yet; only an old one is abandoned.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    try { return Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS; } catch { return false; }
  }
}
export function withEmergencyLock<T>(home: string, action: () => T): T {
  const directory = join(home, 'emergency');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'ledger.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try { fd = openSync(path, 'wx'); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= deadline) throw error;
      // Appends hold the lock for milliseconds. Reclaim only a lock whose owner exited or
      // that is far older than any append; a live writer is always waited for.
      const seen = statSync(path, { throwIfNoEntry: false });
      if (seen && lockOwnerGone(path)) {
        // Remove only the lock that was judged; another waiter may already hold a new one.
        const current = statSync(path, { throwIfNoEntry: false });
        if (current && current.ino === seen.ino && current.mtimeMs === seen.mtimeMs) {
          try { unlinkSync(path); } catch { /* another writer reclaimed it */ }
        }
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  try {
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
    return action();
  } finally { closeSync(fd); unlinkSync(path); }
}
function appendUnlocked(home: string, record: RecordData) {
  recordSchema.parse(record);
  const ledger = verifyEmergency(home);
  if (!ledger.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { exitCode: 3 });
  const core = { ...record, prevHash: ledger.records.at(-1)?.hash ?? zero };
  const entry = { ...core, hash: digest(stableJson(core)) };
  const fd = openSync(join(home, 'emergency', 'grants.jsonl'), 'a');
  try { appendFileSync(fd, `${stableJson(entry)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const headPath = join(home, 'emergency', 'head.json');
  const temporary = `${headPath}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ hash: entry.hash, records: ledger.records.length + 1 })}\n`, { flag: 'wx' });
  renameSync(temporary, headPath);
  return entry;
}
export function appendEmergency(home: string, record: RecordData) {
  return withEmergencyLock(home, () => appendUnlocked(home, record));
}
export function openGrants(records: LedgerRecord[]) {
  const open = new Map<string, LedgerRecord>();
  for (const record of records) {
    if (record.type === 'opened') open.set(record.provider, record);
    if (record.type === 'closed') for (const [provider, grant] of open) if (grant.grantId === record.grantId) open.delete(provider);
  }
  return [...open.values()];
}
export function evaluateEmergency(options: EmergencyOptions) {
  const home = emergencyHome(options);
  let ledger = verifyEmergency(home);
  const warnings = [...ledger.warnings];
  const now = new Date(options.now ?? Date.now());
  if (home && ledger.valid && options.execute !== false && openGrants(ledger.records).some(g => Date.parse(g.expiresAt) <= +now)) {
    try {
      withEmergencyLock(home, () => {
        const fresh = verifyEmergency(home);
        if (!fresh.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { warnings: ['emergency-ledger-invalid'], exitCode: 3 });
        for (const grant of openGrants(fresh.records)) if (Date.parse(grant.expiresAt) <= +now)
          appendUnlocked(home, { type: 'closed', grantId: grant.grantId, closedAt: now.toISOString(), reason: 'expired' });
      });
      ledger = verifyEmergency(home);
    } catch {
      warnings.push('emergency-ledger-append-failed');
      ledger = verifyEmergency(home);
      warnings.push(...ledger.warnings);
    }
  }
  const grant = ledger.valid ? openGrants(ledger.records).find(g => g.provider === options.provider && Date.parse(g.expiresAt) > +now) ?? null : null;
  return { home, grant, warnings, valid: ledger.valid };
}
function validateOpen(input: any, now: Date) {
  if (!['codex', 'claude-code'].includes(input.provider) || typeof input.reason !== 'string' ||
      !input.reason.trim() || input.reason.length > 500 || /[\x00-\x1f\x7f\u2028\u2029]/u.test(input.reason) ||
      typeof input.until !== 'string' || !timestamp.safeParse(input.until).success ||
      !Number.isFinite(Date.parse(input.until)) || !Number.isFinite(+now) || Date.parse(input.until) <= +now ||
      Date.parse(input.until) - +now > (7 * 24 + 1) * 3600000 ||
      !['manual', 'primary-rate-limit'].includes(input.trigger ?? 'manual') ||
      ![null, undefined, 'five_hour', 'seven_day', 'other'].includes(input.window))
    throw Object.assign(new Error('Invalid emergency grant: provider, plain reason and absolute --until within 7 days 1 hour are required.'), { exitCode: 2 });
}
export function openEmergency(options: EmergencyOptions) {
  const now = new Date(options.now ?? Date.now());
  validateOpen(options, now);
  const home = emergencyHome(options)!;
  const build = () => {
    const ledger = verifyEmergency(home);
    if (!ledger.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { exitCode: 3 });
    const prior = openGrants(ledger.records).find(g => g.provider === options.provider && Date.parse(g.expiresAt) > +now);
    if (prior && Date.parse(options.until) <= Date.parse(prior.expiresAt)) throw Object.assign(new Error('A replacement grant must extend expiresAt.'), { exitCode: 2 });
    return { type: 'opened', schemaVersion: 1, grantId: options.grantId ?? randomUUID(), provider: options.provider,
      mode: 'full', trigger: options.trigger ?? 'manual', reason: options.reason, window: options.window ?? null,
      openedAt: now.toISOString(), expiresAt: new Date(options.until).toISOString(), openedBy: options.openedBy ?? 'cli',
      ...(prior ? { supersedes: prior.grantId } : {}) };
  };
  return options.execute ? withEmergencyLock(home, () => {
    const record = build();
    for (const prior of openGrants(verifyEmergency(home).records)) if (Date.parse(prior.expiresAt) <= +now)
      appendUnlocked(home, { type: 'closed', grantId: prior.grantId, closedAt: now.toISOString(), reason: 'expired' });
    return appendUnlocked(home, record);
  }) : { ...build(), writesEnabled: false };
}
export function closeEmergency(options: EmergencyOptions) {
  if (!['codex', 'claude-code'].includes(options.provider ?? '') || !['manual', 'primary-restored'].includes(options.reason ?? 'manual'))
    throw Object.assign(new Error('Invalid close provider or reason.'), { exitCode: 2 });
  const home = emergencyHome(options)!;
  const close = () => {
    const ledger = verifyEmergency(home);
    if (!ledger.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { exitCode: 3 });
    const grant = openGrants(ledger.records).find(g => g.provider === options.provider);
    if (!grant) return { grant: null, writesEnabled: false };
    const record = { type: 'closed', grantId: grant.grantId, closedAt: new Date(options.now ?? Date.now()).toISOString(), reason: options.reason ?? 'manual' };
    return options.execute ? appendUnlocked(home, record) : { ...record, writesEnabled: false };
  };
  return options.execute ? withEmergencyLock(home, close) : close();
}
export function emergencyUse(options: EmergencyOptions, emergency: ReturnType<typeof evaluateEmergency>, command: string, metadata: any) {
  if (!emergency.grant || !emergency.home) return;
  const claims = (metadata.trace?.candidates ?? []).filter((c: any) => c.decision === 'included' && c.claimId);
  const claimIds = metadata.claimIds ?? claims.map((c: any) => c.claimId);
  const peerProgressIds = metadata.peerProgressIds ?? (metadata.trace?.peerProgress ?? []).filter((p: any) => p.decision === 'included').map((p: any) => p.progressId);
  const teamNoticeIds = (metadata.teamNotices ?? []).filter((n: any) => n.text).map((n: any) => n.recordId);
  const scopes = metadata.scopes ?? (metadata.trace?.scopes ?? []).map((s: any) => ({ relationKey: s.relationKey, kind: s.relationKey.split(':')[0] }));
  withEmergencyLock(emergency.home, () => {
    const fresh = verifyEmergency(emergency.home);
    if (!fresh.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { warnings: ['emergency-ledger-invalid'], exitCode: 3 });
    if (!openGrants(fresh.records).some(g => g.grantId === emergency.grant!.grantId && Date.parse(g.expiresAt) > +new Date(options.now ?? Date.now()))) throw new Error('Emergency grant is no longer active.');
    appendUnlocked(emergency.home!, { type: 'used', grantId: emergency.grant!.grantId, at: new Date(options.now ?? Date.now()).toISOString(), command,
    scopes, profile: metadata.profile ?? null, routeReason: metadata.routeReason ?? command,
    claimIds, claimKeys: metadata.claimKeys ?? claims.map((c: any) => c.claimKey).filter(Boolean), peerProgressIds, teamNoticeIds,
    counts: { claims: claimIds.length, peerProgress: peerProgressIds.length, teamNotices: teamNoticeIds.length, bytes: metadata.bytes ?? Buffer.byteLength(metadata.context ?? '') },
    ...(metadata.publishedClaimKeys ? { publishedClaimKeys: metadata.publishedClaimKeys } : {}),
    ...(metadata.writes ? { writes: metadata.writes } : {}) });
  });
}
export function prepareEmergency<T extends EmergencyOptions>(options: T) {
  const emergency = evaluateEmergency(options);
  const policy = options.providerPolicy ?? loadProviderPolicy({ ...options, runtimeRoots: options.runtimeRoots ?? [options.runtimeRoot, options.eventRuntimeRoot].filter(Boolean) });
  return { ...options, emergency, providerPolicy: { ...(policy ?? {}), emergency } };
}
const read = (path: string): any => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
export function emergencyReport(options: EmergencyOptions) {
  const home = emergencyHome(options)!;
  const ledger = verifyEmergency(home);
  if (!ledger.valid) throw Object.assign(new Error('emergency-ledger-invalid'), { exitCode: 3 });
  const root = options.runtimeRoot ?? join(home, 'runtime', 'reconciliation');
  const state = read(join(root, 'state.json'));
  const now = new Date(options.now ?? Date.now());
  const grants = ledger.records.filter(r => r.type === 'opened' && (!options.grant || options.grant === r.grantId) &&
    (!options.since || Date.parse(r.openedAt) >= Date.parse(options.since))).map(grant => {
    const uses = ledger.records.filter(r => r.type === 'used' && r.grantId === grant.grantId);
    const close = ledger.records.find(r => r.type === 'closed' && r.grantId === grant.grantId);
    const successor = ledger.records.find(r => r.type === 'opened' && r.supersedes === grant.grantId);
    const ends = [close?.closedAt, successor?.openedAt, Date.parse(grant.expiresAt) <= +now ? grant.expiresAt : null].filter(Boolean).sort();
    const end = ends[0] ?? null;
    const unique = (items: any[]) => [...new Set(items)].sort();
    const writes = uses.flatMap(u => u.writes ?? []).map((w: any) => {
      const withdrawn = state?.withdrawnPublicationIds?.[w.claimId] ?? state?.tombstones?.[w.scopeKey]?.[digest(w.claimKey)];
      const accepted = existsSync(join(root, 'claims', `${w.claimId}.json`));
      const review = w.reviewId ? read(join(root, 'review', `${w.reviewId}.json`)) : null;
      const pending = review?.candidateClaims?.some((c: any) => c.claimKey === digest(w.claimKey));
      return { claimId: w.claimId, claimKey: w.claimKey, state: withdrawn ? 'withdrawn' : accepted ? 'accepted' : pending ? 'pending' : 'not-persisted' };
    });
    return { grantId: grant.grantId, provider: grant.provider, reason: grant.reason, trigger: grant.trigger, window: grant.window,
      openedAt: grant.openedAt, expiresAt: grant.expiresAt, closedAt: close?.closedAt ?? null,
      expiredAt: end === grant.expiresAt || close?.reason === 'expired' ? grant.expiresAt : null,
      supersededAt: successor?.openedAt ?? null, closeReason: close?.reason ?? null, state: end ? 'closed' : 'open',
      durationMs: Math.max(0, Date.parse(end ?? now.toISOString()) - Date.parse(grant.openedAt)),
      counts: { queries: uses.filter(u => u.command === 'query').length, publishes: uses.filter(u => u.command === 'publish').length,
        progress: uses.filter(u => u.command === 'progress').length, refreshes: uses.filter(u => u.command === 'refresh').length,
        claimsRead: uses.filter(u => ['query', 'refresh'].includes(u.command)).reduce((sum, u) => sum + u.counts.claims, 0),
        teamNotices: uses.reduce((sum, u) => sum + (u.counts.teamNotices ?? 0), 0), bytes: uses.reduce((sum, u) => sum + u.counts.bytes, 0) },
      scopes: unique(uses.flatMap(u => u.scopes.map((s: any) => s.relationKey))),
      claimKeysRead: unique(uses.filter(u => ['query', 'refresh'].includes(u.command)).flatMap(u => u.claimKeys)),
      claimKeysPublished: unique(uses.flatMap(u => u.publishedClaimKeys ?? [])),
      peerProgressIds: unique(uses.filter(u => u.command === 'progress').flatMap(u => u.peerProgressIds)),
      teamNoticeIds: unique(uses.flatMap(u => u.teamNoticeIds ?? [])),
      writes: [...new Map(writes.map((w: any) => [`${w.claimId}:${w.claimKey}`, w])).values()] };
  });
  return { schemaVersion: 1, chainVerified: true, grants };
}
export function emergencyAdvisory(options: EmergencyOptions): string {
  const home = emergencyHome(options);
  if (!home || options.provider !== 'claude-code') return '';
  if (!existsSync(join(home, 'emergency', 'grants.jsonl'))) return '';
  return withEmergencyLock(home, () => {
    const report = emergencyReport(options);
    const path = join(home, 'emergency', 'summarised.json');
    const previous: string[] = read(path) ?? [];
    const grants = report.grants.filter(g => g.provider !== options.provider && !previous.includes(g.grantId));
    if (!grants.length) return '';
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify([...previous, ...grants.map(g => g.grantId)])}\n`, { flag: 'wx' });
    renameSync(temporary, path);
    return grants.map(g => `Emergency access: ${g.provider} had full access ${g.openedAt}\u2013${g.expiredAt ?? g.closedAt ?? g.supersededAt ?? 'ongoing'} (${g.reason}): ${g.counts.queries} queries, ${g.counts.claimsRead} claims read, ${g.counts.publishes} publications. Details: emergency report --grant ${g.grantId}.`).join('\n');
  });
}
