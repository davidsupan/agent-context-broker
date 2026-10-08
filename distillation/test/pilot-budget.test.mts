import { expect, test } from './expect.mts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, setup } from '../src/store.mts';
import { liveProbeCoordinator } from '../src/pilot-budget.mts';

const owner = async () => ({ platform: 'windows' as const, pid: 123, creationFiletime: '123', machineIdSha256: '1'.repeat(64) });
test('pilots share budget and lease, consume approval once and never claim quota fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acb-pilot-budget-'));
  try {
    using initial = openStore(join(home, 'queue.sqlite3'), { readonly: false, create: true }); setup(initial);
    const coordinator = liveProbeCoordinator(home, 'synthetic-test-approval', { owner, job: async () => 'empty' });
    const request = { approvalId: 'synthetic-test-approval', provider: 'claude' as const, seconds: 60 as const, globalBudgetSeconds: 1800 as const };
    await expect(coordinator.reserve({ ...request, approvalId: 'wrong' })).rejects.toThrow('pilot-approval-mismatch');
    const first = await coordinator.reserve(request);
    await expect(coordinator.reserve({ ...request, provider: 'codex' })).rejects.toThrow('pilot-worker-busy');
    await first.settle({ completionProof: 'process-tree-empty-v1', durationMs: 0, exitCode: 0 });
    await expect(coordinator.reserve(request)).rejects.toThrow('pilot-already-reserved');
    const second = await coordinator.reserve({ ...request, provider: 'codex' });
    await second.settle({ completionProof: 'windows-job-empty-v1', durationMs: 0, exitCode: 1 });
    using check = openStore(join(home, 'queue.sqlite3'), { readonly: true });
    expect(check.query('SELECT seconds FROM semantic_budget').get()).toEqual({ seconds: 120 });
    expect(check.query('SELECT DISTINCT reason FROM semantic_attempts').all()).toEqual([{ reason: 'user-approved-synthetic-pilot' }]);
    expect(check.query('SELECT * FROM semantic_pilot_results').all()).toHaveLength(2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('missing dispatched registry evidence retains pilot lease; proven-empty overrun records failure and releases it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'pilot-proof-'));
  try {
    using initial = openStore(join(home, 'queue.sqlite3'), { readonly: false, create: true }); setup(initial);
    let state: 'absent' | 'unknown' | 'empty' = 'absent';
    const coordinator = liveProbeCoordinator(home, 'synthetic-overrun', { owner, job: async () => state });
    const request = { approvalId: 'synthetic-overrun', provider: 'claude' as const, seconds: 60 as const, globalBudgetSeconds: 1800 as const };
    const permit = await coordinator.reserve(request);
    const proof = { completionProof: 'windows-job-empty-v1' as const, durationMs: 62000, exitCode: 0 };
    for (const value of ['absent', 'unknown'] as const) {
      state = value;
      await expect(permit.settle(proof)).rejects.toThrow('pilot-containment-unresolved');
      expect(initial.query('SELECT state FROM semantic_attempts').get()).toEqual({ state: 'running' });
    }
    state = 'empty'; await permit.settle(proof);
    expect(initial.query('SELECT state,error FROM semantic_attempts').get()).toEqual({ state: 'pilot-process-failed', error: 'pilot-deadline-exceeded' });
    expect(initial.query('SELECT seconds FROM semantic_budget').get()).toEqual({ seconds: 60 });
    expect(JSON.parse((initial.query('SELECT proof_json FROM semantic_pilot_results').get() as { proof_json: string }).proof_json)).toEqual(proof);
    await coordinator.reserve({ ...request, provider: 'codex' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
