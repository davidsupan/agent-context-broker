import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { openStore, setup } from './store.mts';
import { ownProcessIdentity, probeNamedJob } from './windows-job.mts';
import { digest, canonical } from './slicing.mts';
import type { LiveProbeCoordinator } from './capability-probe.mts';

const Approval = z.string().regex(/^[A-Za-z0-9_.:-]{1,120}$/);
const Request = z.strictObject({ approvalId: Approval, provider: z.enum(['claude', 'codex']),
  seconds: z.literal(60), globalBudgetSeconds: z.literal(1800) });
const Proof = z.strictObject({ completionProof: z.enum(['process-tree-empty-v1', 'windows-atomic-job-empty-v1', 'windows-job-empty-v1']),
  durationMs: z.number().finite().min(0).max(60000), exitCode: z.number().int() });

/** Separate approved synthetic probes, but the SAME ledger and active-worker
 * table as corpus work. A Codex probe is not mislabelled as a quota fallback.
 */
export function liveProbeCoordinator(home: string, approvedId: string): LiveProbeCoordinator {
  Approval.parse(approvedId);
  return { async reserve(input) {
    const request = Request.parse(input);
    if (request.approvalId !== approvedId) throw new Error('pilot-approval-mismatch');
    const owner = await ownProcessIdentity();
    if (!owner) throw new Error('pilot-owner-unverified');
    using db = openStore(join(home, 'queue.sqlite3'), { readonly: false }); setup(db);
    const now = Date.now() / 1000, day = new Date(now * 1000).toISOString().slice(0, 10);
    if (86400 - now % 86400 < 60) throw new Error('pilot-day-boundary');
    const token = randomBytes(16).toString('hex'), jobName = `Local\\ACBCorpus-${token}`;
    db.transaction(() => {
      db.run('CREATE TABLE IF NOT EXISTS semantic_pilot_approvals(approval_id TEXT,provider TEXT,token TEXT UNIQUE,PRIMARY KEY(approval_id,provider))');
      if (db.query("SELECT 1 FROM semantic_attempts WHERE state='running' LIMIT 1").get()) throw new Error('pilot-worker-busy');
      if (db.query('SELECT 1 FROM semantic_pilot_approvals WHERE approval_id=? AND provider=?').get(approvedId, request.provider)) throw new Error('pilot-already-reserved');
      const row = db.query('SELECT seconds FROM semantic_budget WHERE day=?').get(day);
      const used = row ? z.object({ seconds: z.number().int().min(0).max(1800) }).parse(row).seconds : 0;
      if (used + 60 > 1800) throw new Error('pilot-budget-exhausted');
      db.query(`INSERT INTO semantic_attempts(job_id,token,state,day,reserved_seconds,started_at,
        provider,reason,slice_id,owner_json,execution_phase,containment_json)
        VALUES(?,?,'running',?,60,?,?,'user-approved-synthetic-pilot',?,?,'dispatch-intent',?)`).run(
        `pilot:${digest(approvedId)}`, token, day, now, request.provider, digest({ approvedId, provider: request.provider }),
        canonical(owner), canonical({ schemaVersion: 1, platform: owner.platform, jobName, attemptToken: token, machineIdSha256: owner.machineIdSha256 }));
      db.query('INSERT INTO semantic_pilot_approvals VALUES(?,?,?)').run(approvedId, request.provider, token);
      db.query('INSERT INTO semantic_budget(day,seconds) VALUES(?,60) ON CONFLICT(day) DO UPDATE SET seconds=seconds+60').run(day);
    }).immediate();
    return { reservationId: token, jobName, async settle(inputProof) {
      const proof = Proof.parse(inputProof);
      const state = await probeNamedJob(jobName);
      if (state !== 'empty' && state !== 'absent') throw new Error('pilot-containment-unresolved');
      using current = openStore(join(home, 'queue.sqlite3'), { readonly: false });
      current.transaction(() => {
        // Receipt and lease release commit together. No refund or approval reuse.
        current.run('CREATE TABLE IF NOT EXISTS semantic_pilot_results(token TEXT PRIMARY KEY,proof_json TEXT NOT NULL)');
        const result = current.query("UPDATE semantic_attempts SET state='pilot-process-ended',finished_at=?,execution_phase='finished' WHERE token=? AND state='running' AND reason='user-approved-synthetic-pilot'")
          .run(Date.now() / 1000, token);
        if (result.changes !== 1) throw new Error('pilot-reservation-changed');
        current.query('INSERT INTO semantic_pilot_results VALUES(?,?)').run(token, canonical(proof));
      }).immediate();
    } };
  } };
}
