#!/usr/bin/env bun

import { readFileSync } from 'node:fs';

import * as claudeCode from './claude-inventory.mjs';
import * as codex from './codex-inventory-v2.mjs';
import { planContextQuery, runContextQuery } from './context-query.mjs';
import { planContextPublication, publishContext } from './context-publish.mjs';
import {
  planPeerProgressPublication,
  publishPeerProgress
} from './peer-progress.mjs';
import { planContextRefresh, runContextRefresh } from './context-refresh.mjs';
import { loadContextProfiles, routeContextProfile } from './context-router.mjs';
import {
  decideCorrection,
  planCorrectionDecision,
  planCorrectionProposal,
  proposeCorrection
} from './corrections.mjs';
import {
  appendBrokerEvent,
  planBrokerEvent,
  repairEventHead,
  verifyEventStore
} from './event-store.mjs';
import { planFallbackSweep, runFallbackSweep } from './fallback-sweep.mjs';
import { planReadModel, projectReadModel } from './read-model.mjs';
import { planReconciliation, reconcileClaimBatch } from './reconciliation.mjs';
import {
  diagnoseBroker,
  migrateLifecycleLedger,
  planLifecycleMigration
} from './operations.mjs';
import {
  attestSource,
  isSourceAttested,
  planSourceAttestation
} from './source-attestation.mjs';

const ADAPTERS = Object.freeze({ codex, 'claude-code': claudeCode });

function usage() {
  return [
    'Usage:',
    '  bun src/cli.mjs inventory --provider <provider> --source <path> [limits]',
    '  bun src/cli.mjs inventory --provider <provider> --source <path> --execute --output <path> --deltas <path> --checkpoint <path> --ledger-dir <path> [limits]',
    '  bun src/cli.mjs related --provider <provider> --source <path> --ledger-dir <path> [--after-sequence <n>] [--include-self]',
    '  bun src/cli.mjs reconcile --batch <json> --runtime-root <path> [--execute]',
    '  bun src/cli.mjs sweep --config <json> --runtime-root <path> [--execute] [--minimum-interval-seconds <n>]',
    '  bun src/cli.mjs context-refresh --provider <provider> --source <path> --ledger-dir <path> --runtime-root <path> [--execute --audit-dir <path>]',
    '  bun src/cli.mjs context-route [--profile <id> | --task-kind <kind> | --project-scope] [--strict-isolation]',
    '  bun src/cli.mjs context-query --provider <provider> --runtime-root <path> --scope-kind <kind> --scope-key <key> [--profile <id> | --task-kind <kind> | --project-scope] [--term <value> ...] [--strict-isolation]',
    '  bun src/cli.mjs context-query ... --execute --global-audit-dir <path> [--ticket-package-root <path> --ticket-audit-root <path>] [--review-ledgers-root <path>] [--thread-ref <ref> --thread-audit-root <path>]',
    '  bun src/cli.mjs context-publish --provider <provider> --proposal <json> --runtime-root <path> --event-runtime-root <path> [--ticket-packages-root <path>] [--review-ledgers-root <path>] [--execute]',
    '  bun src/cli.mjs progress-publish --provider <provider> --proposal <json> --runtime-root <path> --event-runtime-root <path> [--ticket-packages-root <path>] [--review-ledgers-root <path>] [--execute]',
    '  bun src/cli.mjs event-append --event <json> --runtime-root <path> [--execute]',
    '  bun src/cli.mjs event-verify --runtime-root <path>',
    '  bun src/cli.mjs event-repair --runtime-root <path> [--execute]',
    '  bun src/cli.mjs read-model --runtime-root <path> [--read-model-root <path>] [--execute] [--strict-isolation]',
    '  bun src/cli.mjs source-attest --attestation <json> --runtime-root <path> [--execute]',
    '  bun src/cli.mjs source-verify --provenance <json> --runtime-root <path>',
    '  bun src/cli.mjs correction-propose --proposal <json> --runtime-root <path> [--execute]',
    '  bun src/cli.mjs correction-decide --decision <json> --runtime-root <path> [--execute]',
    '  bun src/cli.mjs migrate-events --ledger-dir <path> --runtime-root <path> --event-runtime-root <path> [--execute]',
    '  bun src/cli.mjs doctor --runtime-root <path> [--event-runtime-root <path>] [--read-model-root <path>]',
    '',
    'Limits:',
    '  --max-files <n>',
    '  --max-scan-bytes <n>',
    '  --tail-bootstrap-bytes <n>',
    '  --active-window-seconds <n>',
    '  --peer-ttl-seconds <n>',
    '  --recursive'
  ].join('\n');
}

function nonNegativeInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function parseArgs(argv) {
  const [command, ...args] = argv;
  if (![
    'inventory', 'related', 'reconcile', 'sweep', 'context-refresh',
    'context-route', 'context-query', 'event-append', 'event-verify',
    'event-repair', 'read-model', 'source-attest', 'source-verify',
    'correction-propose', 'correction-decide', 'migrate-events', 'doctor',
    'context-publish', 'progress-publish'
  ].includes(command)) {
    throw new Error(usage());
  }

  const options = { command, provider: 'codex' };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if ([
      '--execute', '--recursive', '--include-self', '--project-scope',
      '--strict-isolation', '--require-source-attestation'
    ].includes(argument)) {
      const flagName = argument === '--include-self'
        ? 'includeSelf'
        : argument === '--project-scope'
          ? 'projectScope'
        : argument === '--strict-isolation'
            ? 'strictIsolation'
          : argument === '--require-source-attestation'
            ? 'requireSourceAttestation'
        : argument.slice(2);
      options[flagName] = true;
      continue;
    }

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}.`);
    }
    index += 1;

    switch (argument) {
      case '--source': options.source = value; break;
      case '--provider': options.provider = value; break;
      case '--batch': options.batchPath = value; break;
      case '--event': options.eventPath = value; break;
      case '--attestation': options.attestationPath = value; break;
      case '--provenance': options.provenancePath = value; break;
      case '--proposal': options.proposalPath = value; break;
      case '--decision': options.decisionPath = value; break;
      case '--config': options.configPath = value; break;
      case '--runtime-root': options.runtimeRoot = value; break;
      case '--event-runtime-root': options.eventRuntimeRoot = value; break;
      case '--attestation-runtime-root': options.attestationRuntimeRoot = value; break;
      case '--read-model-root':
        options.outputRoot = value;
        options.readModelRoot = value;
        break;
      case '--output': options.output = value; break;
      case '--deltas': options.deltas = value; break;
      case '--checkpoint': options.checkpoint = value; break;
      case '--ledger-dir': options.ledgerDir = value; break;
      case '--audit-dir': options.auditDir = value; break;
      case '--global-audit-dir': options.globalAuditDirectory = value; break;
      case '--ticket-package-root': options.ticketPackageRoot = value; break;
      case '--ticket-audit-root': options.ticketAuditRoot = value; break;
      case '--ticket-packages-root': options.ticketPackagesRoot = value; break;
      case '--review-ledgers-root': options.reviewLedgersRoot = value; break;
      case '--thread-ref': options.threadRef = value; break;
      case '--thread-audit-root': options.threadAuditRoot = value; break;
      case '--profile': options.profileId = value; break;
      case '--profiles': options.profilesPath = value; break;
      case '--task-kind': options.taskKind = value; break;
      case '--term': options.terms = [...(options.terms ?? []), value]; break;
      case '--scope-kind': options.scopeKind = value; break;
      case '--scope-key': options.scopeKey = value; break;
      case '--after-sequence': options.afterSequence = nonNegativeInteger(value, argument); break;
      case '--max-ledger-files': options.maxLedgerFiles = positiveInteger(value, argument); break;
      case '--max-files': options.maxFiles = positiveInteger(value, argument); break;
      case '--max-scan-bytes': options.maxScanBytes = positiveInteger(value, argument); break;
      case '--tail-bootstrap-bytes': options.tailBootstrapBytes = positiveInteger(value, argument); break;
      case '--active-window-seconds': options.activeWindowSeconds = positiveInteger(value, argument); break;
      case '--peer-ttl-seconds': options.peerTtlSeconds = positiveInteger(value, argument); break;
      case '--minimum-interval-seconds': options.minimumIntervalSeconds = nonNegativeInteger(value, argument); break;
      case '--max-deltas': options.maxDeltas = positiveInteger(value, argument); break;
      case '--max-snapshots': options.maxSnapshots = positiveInteger(value, argument); break;
      case '--max-claims': options.maxClaims = positiveInteger(value, argument); break;
      case '--max-value-bytes': options.maxValueBytes = positiveInteger(value, argument); break;
      case '--max-context-bytes': options.maxContextBytes = positiveInteger(value, argument); break;
      default: throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (['inventory', 'related'].includes(command) && !options.source) {
    throw new Error('--source is required.');
  }
  if (['inventory', 'related'].includes(command) && !ADAPTERS[options.provider]) {
    throw new Error(`Unsupported provider: ${options.provider}.`);
  }
  if (command === 'related' && !options.ledgerDir) {
    throw new Error('--ledger-dir is required for related context.');
  }
  if (command === 'reconcile' && (!options.batchPath || !options.runtimeRoot)) {
    throw new Error('--batch and --runtime-root are required for reconciliation.');
  }
  if (command === 'sweep' && (!options.configPath || !options.runtimeRoot)) {
    throw new Error('--config and --runtime-root are required for fallback sweep.');
  }
  if (
    command === 'context-refresh' &&
    (!options.source || !options.ledgerDir || !options.runtimeRoot)
  ) {
    throw new Error('--source, --ledger-dir, and --runtime-root are required for context refresh.');
  }
  if (command === 'context-refresh' && !ADAPTERS[options.provider]) {
    throw new Error(`Unsupported provider: ${options.provider}.`);
  }
  if (command === 'context-refresh' && options.execute && !options.auditDir) {
    throw new Error('--audit-dir is required for audited context refresh.');
  }
  if (['context-route', 'context-query'].includes(command) &&
      !ADAPTERS[options.provider]) {
    throw new Error(`Unsupported provider: ${options.provider}.`);
  }
  if (command === 'context-query' && !options.strictIsolation && !options.runtimeRoot) {
    throw new Error('--runtime-root is required for context query.');
  }
  if (command === 'context-query' && options.execute && !options.globalAuditDirectory) {
    throw new Error('--global-audit-dir is required for audited context query.');
  }
  if (command === 'context-query' && options.ticketPackageRoot && !options.ticketPackagesRoot) {
    throw new Error('--ticket-packages-root is required with --ticket-package-root.');
  }
  if (command === 'context-query' && options.ticketPackageRoot && !options.ticketAuditRoot) {
    throw new Error('--ticket-audit-root is required with --ticket-package-root.');
  }
  if (command === 'context-query' && options.execute &&
      options.scopeKind === 'merge-request' && !options.reviewLedgersRoot) {
    throw new Error('--review-ledgers-root is required for audited merge request queries.');
  }
  if (command === 'context-query' && options.threadRef && !options.threadAuditRoot) {
    throw new Error('--thread-audit-root is required with --thread-ref.');
  }
  if (command === 'event-append' && (!options.eventPath || !options.runtimeRoot)) {
    throw new Error('--event and --runtime-root are required for event append.');
  }
  if (['event-verify', 'event-repair', 'read-model'].includes(command) &&
      !options.runtimeRoot && !options.strictIsolation) {
    throw new Error('--runtime-root is required for this command.');
  }
  if (command === 'source-attest' && (!options.attestationPath || !options.runtimeRoot)) {
    throw new Error('--attestation and --runtime-root are required for source attestation.');
  }
  if (command === 'source-verify' && (!options.provenancePath || !options.runtimeRoot)) {
    throw new Error('--provenance and --runtime-root are required for source verification.');
  }
  if (command === 'correction-propose' && (!options.proposalPath || !options.runtimeRoot)) {
    throw new Error('--proposal and --runtime-root are required for correction proposal.');
  }
  if (command === 'correction-decide' && (!options.decisionPath || !options.runtimeRoot)) {
    throw new Error('--decision and --runtime-root are required for correction decision.');
  }
  if (command === 'reconcile' && options.requireSourceAttestation &&
      !options.attestationRuntimeRoot) {
    throw new Error('--attestation-runtime-root is required when source attestation is enforced.');
  }
  if (command === 'migrate-events' &&
      (!options.ledgerDir || !options.runtimeRoot || !options.eventRuntimeRoot)) {
    throw new Error('--ledger-dir, --runtime-root, and --event-runtime-root are required.');
  }
  if (command === 'doctor' && !options.runtimeRoot) {
    throw new Error('--runtime-root is required for doctor.');
  }
  if (['context-publish', 'progress-publish'].includes(command) &&
      (!options.proposalPath || !options.runtimeRoot || !options.eventRuntimeRoot)) {
    throw new Error('--proposal, --runtime-root, and --event-runtime-root are required for publication.');
  }
  return options;
}

try {
  const options = parseArgs(process.argv.slice(2));
  const command = options.command;
  delete options.command;
  const execute = options.execute === true;
  delete options.execute;
  let result;

  if (command === 'progress-publish') {
    const proposal = JSON.parse(readFileSync(options.proposalPath, 'utf8'));
    result = execute
      ? await publishPeerProgress({ ...options, proposal, execute: true })
      : planPeerProgressPublication({ ...options, proposal });
  } else if (command === 'context-publish') {
    const proposal = JSON.parse(readFileSync(options.proposalPath, 'utf8'));
    result = execute
      ? await publishContext({ ...options, proposal, execute: true })
      : planContextPublication({ ...options, proposal });
  } else if (command === 'migrate-events') {
    const migrationOptions = {
      ...options,
      ledgerDirectory: options.ledgerDir
    };
    result = execute
      ? await migrateLifecycleLedger({ ...migrationOptions, execute: true })
      : planLifecycleMigration(migrationOptions);
  } else if (command === 'doctor') {
    result = diagnoseBroker(options);
  } else if (command === 'source-attest') {
    const attestation = JSON.parse(readFileSync(options.attestationPath, 'utf8'));
    result = execute
      ? await attestSource({ ...options, attestation, execute: true })
      : planSourceAttestation({ ...options, attestation });
  } else if (command === 'source-verify') {
    const provenance = JSON.parse(readFileSync(options.provenancePath, 'utf8'));
    result = {
      schemaVersion: 1,
      mode: 'source-verification',
      attested: isSourceAttested({ ...options, provenance })
    };
  } else if (command === 'correction-propose') {
    const proposal = JSON.parse(readFileSync(options.proposalPath, 'utf8'));
    result = execute
      ? await proposeCorrection({ ...options, proposal, execute: true })
      : planCorrectionProposal({ ...options, proposal });
  } else if (command === 'correction-decide') {
    const decision = JSON.parse(readFileSync(options.decisionPath, 'utf8'));
    result = execute
      ? await decideCorrection({ ...options, decision, execute: true })
      : planCorrectionDecision({ ...options, decision });
  } else if (command === 'event-append') {
    const event = JSON.parse(readFileSync(options.eventPath, 'utf8'));
    result = execute
      ? await appendBrokerEvent({ ...options, event, execute: true })
      : planBrokerEvent({ ...options, event });
  } else if (command === 'event-verify') {
    const verified = verifyEventStore(options);
    result = {
      schemaVersion: 1,
      mode: 'event-verify',
      eventCount: verified.events.length,
      head: verified.head
    };
  } else if (command === 'event-repair') {
    result = execute
      ? await repairEventHead({ ...options, execute: true })
      : {
          schemaVersion: 1,
          mode: 'event-repair',
          writesEnabled: false,
          runtimeRoot: options.runtimeRoot
        };
  } else if (command === 'read-model') {
    result = execute
      ? projectReadModel({ ...options, execute: true })
      : planReadModel(options);
  } else if (command === 'context-route') {
    const profiles = loadContextProfiles(options.profilesPath);
    result = routeContextProfile({ ...options, profiles });
  } else if (command === 'context-query') {
    result = execute
      ? await runContextQuery({ ...options, execute: true })
      : await planContextQuery(options);
  } else if (command === 'context-refresh') {
    result = execute
      ? await runContextRefresh({ ...options, execute: true })
      : await planContextRefresh(options);
  } else if (command === 'reconcile') {
    const batch = JSON.parse(readFileSync(options.batchPath, 'utf8'));
    result = execute
      ? await reconcileClaimBatch({ ...options, batch, execute: true })
      : planReconciliation({ ...options, batch });
  } else if (command === 'sweep') {
    const config = JSON.parse(readFileSync(options.configPath, 'utf8'));
    const sweepOptions = { ...config, ...options, sources: config.sources };
    result = execute
      ? await runFallbackSweep({ ...sweepOptions, execute: true })
      : await planFallbackSweep(sweepOptions);
  } else {
    const adapter = ADAPTERS[options.provider];
    delete options.provider;
    result = command === 'related'
      ? await adapter.readRelatedDeltas(options)
      : execute
        ? await adapter.runInventory(options)
        : await adapter.planInventory(options);
  }

  if (command !== 'inventory' || !execute) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify({
      provider: result.inventory.provider,
      mode: 'observe',
      sourcesProcessed: result.inventory.sources.length,
      sourcesSkipped: result.inventory.skipped.length,
      deltasWritten: result.deltas.length,
      ledgerArtifacts: result.ledgerArtifacts,
      checkpointSequence: result.checkpoint.sequence
    }));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
