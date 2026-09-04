#!/usr/bin/env bun

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultRuntimeHome } from '../src/platform-paths.mjs';

const COMMANDS = Object.freeze({
  query: 'context-query',
  route: 'context-route',
  publish: 'context-publish',
  progress: 'progress-publish'
});

const VALUE_OPTIONS = Object.freeze({
  '--provider': 'provider',
  '--profile': 'profile',
  '--task-kind': 'taskKind',
  '--proposal': 'proposal',
  '--scope-kind': 'scopeKind',
  '--scope-key': 'scopeKey',
  '--ticket-packages-root': 'ticketPackagesRoot',
  '--review-ledgers-root': 'reviewLedgersRoot',
  '--runtime-home': 'runtimeHome',
  '--issue-key': 'issueKey',
  '--review-key': 'reviewKey',
  '--thread-ref': 'threadRef'
});

function parseArguments(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!COMMANDS[command]) throw new Error(`Expected one command: ${Object.keys(COMMANDS).join(', ')}.`);
  const options = { command, provider: 'codex', query: [] };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (['--execute', '--project-scope', '--strict-isolation'].includes(argument)) {
      options[argument.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (argument === '--query' || argument === '--term') {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a value.`);
      options.query.push(value);
      continue;
    }
    const key = VALUE_OPTIONS[argument];
    if (!key) throw new Error(`Unknown context argument: ${argument}`);
    const value = args[++index];
    if (!value) throw new Error(`${argument} requires a value.`);
    options[key] = value;
  }
  return options;
}

function findToolRoot() {
  const scriptRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(scriptRoot, '..'), resolve(scriptRoot, '..', 'tool')];
  const toolRoot = candidates.find((candidate) => existsSync(join(candidate, 'src', 'cli.mjs')));
  if (!toolRoot) throw new Error('Agent Context Broker tool root is missing.');
  return toolRoot;
}

function isWithin(root, path) {
  const suffix = relative(resolve(root), resolve(path));
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..');
}

function resolveReviewDirectory(root, key, { mustExist = true } = {}) {
  const match = /!(\d{1,12})$/u.exec(key);
  if (!match) throw new Error(`Invalid merge request key: ${key}`);
  const directory = resolve(root, `mr-${match[1]}`);
  if (!isWithin(root, directory)) throw new Error('Review ledger directory escaped its configured root.');
  if (mustExist && !existsSync(directory)) throw new Error(`Review ledger is missing for ${key}.`);
  return directory;
}

function appendLedgerRow(path, row) {
  mkdirSync(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + 5000;
  let lock;
  while (lock === undefined) {
    try {
      lock = openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs > 10 * 60 * 1000) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error('Context ledger is busy.');
      Bun.sleepSync(50);
    }
  }
  try {
    writeFileSync(path, `${JSON.stringify(row)}\n`, { encoding: 'utf8', flag: 'a' });
  } finally {
    closeSync(lock);
    rmSync(lockPath, { force: true });
  }
}

function pushValue(args, name, value) {
  if (value !== undefined && value !== null && value !== '') args.push(name, String(value));
}

function runCore(toolRoot, args) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, join(toolRoot, 'src', 'cli.mjs'), ...args],
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe'
  });
  if (result.exitCode !== 0) {
    const message = result.stderr.toString('utf8').trim();
    throw new Error(message || `Agent Context Broker exited with code ${result.exitCode}.`);
  }
  return result.stdout.toString('utf8');
}

function buildCommonRouteArguments(options) {
  const args = ['--provider', options.provider];
  pushValue(args, '--profile', options.profile);
  pushValue(args, '--task-kind', options.taskKind);
  for (const term of options.query) pushValue(args, '--term', term);
  pushValue(args, '--scope-kind', options.scopeKind);
  pushValue(args, '--scope-key', options.scopeKey);
  if (options.projectScope) args.push('--project-scope');
  if (options.strictIsolation) args.push('--strict-isolation');
  return args;
}

function resolvePaths(options) {
  const runtimeHome = resolve(options.runtimeHome ?? defaultRuntimeHome());
  return {
    runtimeHome,
    runtimeRoot: process.env.AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME ??
      join(runtimeHome, 'runtime', 'reconciliation'),
    eventRuntimeRoot: process.env.AGENT_CONTEXT_BROKER_EVENT_RUNTIME ??
      join(runtimeHome, 'runtime', 'events'),
    auditRoot: join(runtimeHome, 'runtime', 'query-audit'),
    ticketAuditRoot: join(runtimeHome, 'runtime', 'ticket-audit'),
    threadAuditRoot: join(runtimeHome, 'runtime', 'thread-audit'),
    ticketPackagesRoot: resolve(options.ticketPackagesRoot ?? join(runtimeHome, 'tickets')),
    reviewLedgersRoot: resolve(
      options.reviewLedgersRoot ??
      process.env.AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT ??
      join(runtimeHome, 'runtime', 'reviews')
    )
  };
}

function buildQuery(options, paths) {
  if (options.issueKey && options.reviewKey) throw new Error('--issue-key and --review-key are mutually exclusive.');
  if (options.reviewKey) resolveReviewDirectory(paths.reviewLedgersRoot, options.reviewKey);
  const routed = {
    ...options,
    scopeKind: options.scopeKind ?? (options.issueKey
      ? 'ticket'
      : options.reviewKey ? 'merge-request' : 'project'),
    scopeKey: options.scopeKey ?? options.issueKey ?? options.reviewKey ??
      process.env.AGENT_CONTEXT_BROKER_DEFAULT_PROJECT ?? 'default-project'
  };
  const args = [COMMANDS.query, ...buildCommonRouteArguments(routed)];
  if (!options.strictIsolation) {
    args.push(
      '--runtime-root', paths.runtimeRoot,
      '--event-runtime-root', paths.eventRuntimeRoot,
      '--ticket-packages-root', paths.ticketPackagesRoot,
      '--review-ledgers-root', paths.reviewLedgersRoot
    );
    if (options.threadRef) {
      args.push('--thread-ref', options.threadRef, '--thread-audit-root', paths.threadAuditRoot);
    }
  }
  if (options.execute) {
    args.push('--execute', '--global-audit-dir', paths.auditRoot);
    if (options.issueKey) {
      const ticketRoot = join(paths.ticketPackagesRoot, options.issueKey);
      if (!existsSync(join(ticketRoot, 'README.md'))) {
        throw new Error(`Ticket package is missing for audited context query: ${options.issueKey}`);
      }
      args.push(
        '--ticket-package-root', ticketRoot,
        '--ticket-packages-root', paths.ticketPackagesRoot,
        '--ticket-audit-root', paths.ticketAuditRoot
      );
    }
  }
  return args;
}

function buildPublication(options, paths) {
  if (!options.proposal) throw new Error('Context publication requires --proposal.');
  if (options.strictIsolation) throw new Error('Context publication is unavailable in strict isolation.');
  const args = [
    COMMANDS[options.command],
    '--provider', options.provider,
    '--proposal', resolve(options.proposal),
    '--runtime-root', paths.runtimeRoot,
    '--event-runtime-root', paths.eventRuntimeRoot,
    '--ticket-packages-root', paths.ticketPackagesRoot,
    '--review-ledgers-root', paths.reviewLedgersRoot
  ];
  if (options.execute) args.push('--execute');
  return args;
}

function appendPublicationAudit(options, paths, result) {
  if (!options.execute) return;
  const proposal = JSON.parse(readFileSync(resolve(options.proposal), 'utf8'));
  const scope = proposal.scope;
  let ledgerPath;
  if (scope.kind === 'ticket') {
    if (!/^[A-Z][A-Z0-9]{1,15}-\d+$/u.test(scope.key)) {
      throw new Error('Ticket-scoped context publication requires a valid issue key.');
    }
    const ticketRoot = join(paths.ticketPackagesRoot, scope.key);
    if (!existsSync(join(ticketRoot, 'README.md'))) {
      throw new Error(`Ticket package is missing for context publication: ${scope.key}`);
    }
    ledgerPath = join(paths.ticketAuditRoot, scope.key, 'CONTEXT_LEDGER.jsonl');
  } else if (scope.kind === 'merge-request') {
    ledgerPath = join(resolveReviewDirectory(paths.reviewLedgersRoot, scope.key), 'CONTEXT_LEDGER.jsonl');
  } else {
    return;
  }
  appendLedgerRow(ledgerPath, {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    operation: options.command === 'progress' ? 'peer-progress-publish' : 'context-publish',
    scopeKind: scope.kind,
    scopeKey: scope.key,
    issueKey: scope.kind === 'ticket' ? scope.key : null,
    reviewKey: scope.kind === 'merge-request' ? scope.key : null,
    provider: options.provider,
    proposalIdHash: result.proposalIdHash ?? null,
    sourceTokenHash: result.sourceTokenHash ?? null,
    snapshotHash: result.snapshotHash ?? null,
    snapshotVersion: result.snapshotVersion ?? null,
    acceptedClaimCount: result.acceptedClaimCount ?? null,
    progressId: result.progressId ?? null,
    progressState: options.command === 'progress' ? result.state : null,
    progressStage: options.command === 'progress' ? result.stage : null,
    expiresAt: options.command === 'progress' ? result.expiresAt : null,
    result: options.command === 'progress' ? 'published' : result.state,
    issueCodes: (result.issues ?? []).map((issue) => issue.code)
  });
}

export function runAgentContext(argv) {
  const options = parseArguments(argv);
  const toolRoot = findToolRoot();
  const paths = resolvePaths(options);
  const args = options.command === 'route'
    ? [COMMANDS.route, ...buildCommonRouteArguments(options)]
    : options.command === 'query'
      ? buildQuery(options, paths)
      : buildPublication(options, paths);
  const output = runCore(toolRoot, args);
  if (['publish', 'progress'].includes(options.command)) {
    appendPublicationAudit(options, paths, JSON.parse(output));
  }
  return output;
}

if (import.meta.main) {
  try {
    process.stdout.write(runAgentContext(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
