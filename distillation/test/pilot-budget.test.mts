import { expect, test } from './expect.mts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, setup } from '../src/store.mts';
import { liveProbeCoordinator } from '../src/pilot-budget.mts';

(process.platform === 'win32' ? test : test.skip)('pilots share budget and lease, consume approval once and never claim quota fallback', async () => {
  const home = mkdtempSync(join(tmpdir(), 'acb-pilot-budget-'));
  try {
    using initial = openStore(join(home, 'queue.sqlite3'), { readonly: false, create: true }); setup(initial);
    const coordinator = liveProbeCoordinator(home, 'synthetic-test-approval');
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
