#!/usr/bin/env bun
// Submits model-extracted conclusions into the review lane.
//
// This is the one place a language model's output reaches the broker, and it is
// deliberately a dead end for trust: every claim is forced to evidenceClass
// 'agent-handoff' and verification 'unverified' regardless of what the extractor
// asked for, so reconciliation holds it for evidence review and it can never be
// injected as accepted context. Promotion is a separate, human-initiated act that
// resubmits the claim with evidence the broker can check.
//
// Input is a JSON file: { scope: {kind,key}, source: {provider,sessionKey,recordKey,
// sourceHash}, claims: [{claimKey, claimType, subject, predicate, value, observedAt}] }
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { planReconciliation, reconcileClaimBatch } from '../src/reconciliation.mjs';

function parseArgs(argv) {
  const options = { execute: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--execute') { options.execute = true; continue; }
    const value = argv[index + 1];
    switch (argument) {
      case '--proposal': options.proposal = value; index += 1; break;
      case '--runtime-root': options.runtimeRoot = value; index += 1; break;
      default: throw new Error('unknown argument: ' + argument);
    }
  }
  if (!options.proposal || !options.runtimeRoot) {
    throw new Error('usage: propose-handoff-claims.mjs --proposal <json> --runtime-root <path> [--execute]');
  }
  return options;
}

function hash(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

const options = parseArgs(process.argv.slice(2));
const input = JSON.parse(readFileSync(resolve(options.proposal), 'utf8'));

if (!input?.scope?.kind || !input?.scope?.key) throw new Error('proposal requires a scope');
if (!Array.isArray(input.claims) || input.claims.length === 0) {
  throw new Error('proposal requires at least one claim');
}
const source = input.source ?? {};
if (!source.provider) throw new Error('proposal requires source.provider');

const overridden = [];
const claims = input.claims.map((candidate) => {
  if (candidate.evidenceClass && candidate.evidenceClass !== 'agent-handoff') {
    overridden.push({ claimKey: candidate.claimKey, asked: candidate.evidenceClass });
  }
  if (candidate.verification && candidate.verification !== 'unverified') {
    overridden.push({ claimKey: candidate.claimKey, asked: candidate.verification });
  }
  return {
    claimKey: candidate.claimKey,
    claimType: candidate.claimType ?? 'decision',
    subject: candidate.subject,
    predicate: candidate.predicate ?? 'decided',
    value: candidate.value,
    observedAt: candidate.observedAt,
    confidence: typeof candidate.confidence === 'number' ? candidate.confidence : 0.5,
    sensitivity: 'private',
    // Forced, not defaulted. An extractor does not get to describe its own output as
    // evidence the broker can trust.
    evidenceClass: 'agent-handoff',
    verification: 'unverified',
    expectedCurrentClaimId: null,
    canonicalRefs: candidate.canonicalRefs ?? [
      `context://agent-context-broker/${candidate.claimKey}`
    ],
    provenance: [{
      provider: source.provider,
      sessionKey: source.sessionKey ?? hash(randomUUID()),
      recordKey: source.recordKey ?? hash(randomUUID()),
      sourceHash: source.sourceHash ?? hash(randomUUID())
    }]
  };
});

const batch = {
  schemaVersion: 1,
  batchId: `handoff-${randomUUID()}`,
  expectedSnapshotHash: input.expectedSnapshotHash ?? null,
  scope: input.scope,
  relationKeys: input.relationKeys ?? [`${input.scope.kind}:${hash(String(input.scope.key).toLowerCase())}`],
  claims
};

console.log('claims submitted : ' + claims.length);
console.log('lane             : agent-handoff / unverified (forced)');
if (overridden.length > 0) {
  console.log('overridden       : ' + overridden.length +
    ' field(s) the extractor asked for were replaced');
  for (const item of overridden.slice(0, 5)) {
    console.log('  ' + item.claimKey + ' asked for "' + item.asked + '"');
  }
}
console.log('mode             : ' + (options.execute ? 'execute' : 'plan (no writes)'));
console.log('');

// Plan mode has to go through the planner. reconcileClaimBatch refuses without execute,
// so routing both modes through it made the advertised dry run throw instead of showing
// what would happen - the opposite of what a plan mode is for.
const now = new Date().toISOString();
const result = options.execute
  ? await reconcileClaimBatch({ runtimeRoot: resolve(options.runtimeRoot), batch, execute: true, now })
  : planReconciliation({ runtimeRoot: resolve(options.runtimeRoot), batch, now });

const serialised = JSON.stringify(result);
const heldForReview = serialised.includes('evidence-review');
console.log('held for review  : ' + heldForReview);
if (!heldForReview) {
  console.error('');
  console.error('REFUSING: a handoff claim was not held for evidence review.');
  console.error('The review boundary is the only thing keeping model output out of the');
  console.error('trust path, so this is a failure, not a convenience.');
  process.exit(1);
}
console.log('');
console.log('These claims are visible for review and will not be injected as accepted');
console.log('context. Promotion means resubmitting them with canonical-artifact or');
console.log('observed-tool-result evidence that the broker can check.');
