import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { planContextQuery } from '../src/context-query.mjs';
import { reconcileClaimBatch } from '../src/reconciliation.mjs';

const roots = [];
const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const relation = (kind, key) => `${kind}:${hash(key.toLowerCase())}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function home() {
  const root = join(tmpdir(), `snapshot-ranking-${randomUUID()}`);
  roots.push(root);
  const runtime = join(root, 'runtime', 'reconciliation');
  const events = join(root, 'runtime', 'events');
  mkdirSync(runtime, { recursive: true });
  mkdirSync(events, { recursive: true });
  return { runtime, events };
}

async function publish(h, scope, relationKeys, claimKey, value, observedAt, expected = {}) {
  return reconcileClaimBatch({
    runtimeRoot: h.runtime, eventRuntimeRoot: h.events, execute: true, now: observedAt,
    batch: {
      schemaVersion: 1, batchId: `r-${randomUUID()}`, expectedSnapshotHash: expected.snapshotHash ?? null, scope, relationKeys,
      claims: [{
        claimKey, claimType: 'procedure', subject: 'team', predicate: 'follows', value, observedAt, confidence: 1, sensitivity: 'shared',
        evidenceClass: 'canonical-artifact', verification: 'verified', expectedCurrentClaimId: expected.claimId ?? null,
        canonicalRefs: [`context://agent-context-broker/${claimKey}`],
        provenance: [{ provider: 'claude-code', sessionKey: hash('s'), recordKey: hash(`${claimKey}-${value}`), sourceHash: hash(`${claimKey}-${value}-src`) }],
      }],
    },
  });
}

describe('snapshot ranking before the cap', () => {
  test('a project rule at version 1 survives more workstream snapshots at version 2 than the cap', async () => {
    const h = home();
    const project = { kind: 'project', key: 'example-project' };
    await publish(h, project, [relation('project', project.key)], 'rule.standing', 'every change goes through review', '2026-10-01T08:00:00.000Z');
    // Seven workstreams of the project, each at version 2 and newer than the project snapshot.
    for (let i = 0; i < 7; i += 1) {
      const scope = { kind: 'workstream', key: `stream-${i}` };
      const keys = [relation('workstream', scope.key), relation('project', project.key)];
      const first = await publish(h, scope, keys, `stream.${i}.a`, `stream ${i} first note`, `2026-10-0${2 + (i % 5)}T08:00:00.000Z`);
      await publish(h, scope, keys, `stream.${i}.b`, `stream ${i} second note`, `2026-10-0${2 + (i % 5)}T09:00:00.000Z`, { snapshotHash: first.snapshotHash });
    }
    const result = await planContextQuery({ provider: 'claude-code', runtimeRoot: h.runtime, profileId: 'implementation',
      terms: ['review'], scopeKind: 'project', scopeKey: project.key });
    assert.ok(result.warnings.includes('accepted-snapshot-limit-reached'), 'the cap applies');
    assert.ok(result.claims.some((claim) => claim.claimKey === 'rule.standing'), 'the requested scope is always selected');
  });
});
