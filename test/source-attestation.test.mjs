import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import { sha256 } from '../src/event-store.mjs';
import {
  attestSource,
  isSourceAttested,
  planSourceAttestation,
  provenanceForSourceToken
} from '../src/source-attestation.mjs';

const roots = [];

function root(name) {
  const value = join(tmpdir(), `acb-attestation-${name}-${randomUUID()}`);
  mkdirSync(value, { recursive: true });
  roots.push(value);
  return value;
}

function candidate(overrides = {}) {
  return {
    schemaVersion: 1,
    provider: 'codex',
    sessionKey: sha256('session-a'),
    recordKey: sha256('record-a'),
    sourceHash: sha256('source-a'),
    inventoryHash: sha256('inventory-a'),
    observedAt: '2026-08-25T10:00:00.000Z',
    scope: { kind: 'ticket', keyHash: sha256('APP-FIXTURE') },
    sensitivity: 'private',
    ...overrides
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('source attestation', () => {
  test('plan is read-only', () => {
    const runtimeRoot = root('plan');
    const plan = planSourceAttestation({ attestation: candidate() });
    assert.equal(plan.writesEnabled, false);
    assert.match(plan.threadRef, /^context:\/\/thread\/[a-f0-9]{64}$/u);
    assert.equal(existsSync(join(runtimeRoot, 'events')), false);
  });

  test('attested provenance is verified through the event chain', async () => {
    const runtimeRoot = root('verify');
    const attestation = candidate();
    const result = await attestSource({ runtimeRoot, attestation, execute: true });
    assert.match(result.attestationId, /^[a-f0-9]{64}$/u);
    assert.match(result.subjectRef, /^acb:\/\/source\/[a-f0-9]{64}$/u);
    assert.match(result.threadRef, /^context:\/\/thread\/[a-f0-9]{64}$/u);
    assert.equal(
      provenanceForSourceToken({ runtimeRoot, sourceToken: result.subjectRef }).threadRef,
      result.threadRef
    );
    assert.equal(isSourceAttested({ runtimeRoot, provenance: attestation }), true);
    assert.equal(isSourceAttested({
      runtimeRoot,
      provenance: { ...attestation, sourceHash: sha256('different') }
    }), false);
  });
});
