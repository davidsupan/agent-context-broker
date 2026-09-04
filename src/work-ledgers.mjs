import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const ISSUE_KEY = /\b[A-Z][A-Z0-9]{1,15}-\d+\b/gu;
const EXACT_ISSUE_KEY = /^[A-Z][A-Z0-9]{1,15}-\d+$/u;
const MERGE_REQUEST_KEY = /^(?<project>[A-Za-z0-9][A-Za-z0-9._/-]{0,95})!(?<iid>\d{1,12})$/u;
const MAX_LEDGER_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RELATED_TICKETS = 12;
const JSON_CANDIDATES = [
  'metadata.json',
  'mr.json',
  'mr-final-readback.json',
  join('artifacts', 'mr.json')
];
const SUMMARY_CANDIDATES = [
  'REVIEW_SUMMARY.md',
  'final-summary.md',
  'REVIEW_PACKAGE.md',
  'README.md'
];

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedRead(path) {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_LEDGER_SOURCE_BYTES) {
    throw new Error(`Review ledger identity source exceeds the bounded contract: ${path}.`);
  }
  return readFileSync(path, 'utf8');
}

function withinRoot(root, path, label) {
  const pathFromRoot = relative(root, path);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} escapes its configured root.`);
  }
}

function ticketKeysFrom(values) {
  const tickets = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(ISSUE_KEY)) tickets.add(match[0]);
  }
  return [...tickets].sort().slice(0, MAX_RELATED_TICKETS);
}

function projectScopeKey(project) {
  return project.toLowerCase().replaceAll('/', '-');
}

function jsonIdentity(value) {
  if (!isRecord(value)) return null;
  const iid = value.iid ?? value.mergeRequest;
  const project = value.references?.full?.split('!')[0] ?? value.project;
  const full = value.references?.full ?? (
    typeof project === 'string' && Number.isSafeInteger(Number(iid))
      ? `${project}!${iid}`
      : null
  );
  return {
    full,
    tickets: ticketKeysFrom([
      value.issue,
      value.title,
      value.description,
      value.source_branch,
      value.sourceBranch,
      value.web_url
    ])
  };
}

function summaryIdentity(value, mergeRequestKey, iid) {
  const hasIid = new RegExp(`(?:merge_requests/${iid}\\b|MR\\s*!${iid}\\b|!${iid}\\b)`, 'iu').test(value);
  if (!hasIid) return null;
  return { full: mergeRequestKey, tickets: ticketKeysFrom([value]) };
}

export function parseMergeRequestKey(value) {
  const match = MERGE_REQUEST_KEY.exec(String(value ?? ''));
  if (!match) return null;
  return { key: match[0], project: match.groups.project, iid: match.groups.iid };
}

export function ticketPackageRelations(ticketPackagesRoot, issueKey) {
  if (!ticketPackagesRoot || !EXACT_ISSUE_KEY.test(issueKey ?? '')) return [];
  const packageRoot = join(resolve(ticketPackagesRoot), issueKey);
  const contextPath = join(packageRoot, 'jira-context.json');
  if (!existsSync(contextPath)) return [];
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  if (context?.issue?.key !== issueKey || !isRecord(context.relatedTickets)) {
    throw new Error(`Ticket relation context is invalid for ${issueKey}.`);
  }
  const relations = [];
  if (EXACT_ISSUE_KEY.test(context.relatedTickets.parent?.key ?? '')) {
    relations.push({ kind: 'ticket', key: context.relatedTickets.parent.key, relationship: 'jira-parent' });
    relations.push({ kind: 'workstream', key: context.relatedTickets.parent.key, relationship: 'jira-parent' });
  }
  for (const item of Array.isArray(context.relatedTickets.subtasks) ? context.relatedTickets.subtasks : []) {
    if (EXACT_ISSUE_KEY.test(item?.key ?? '')) {
      relations.push({ kind: 'ticket', key: item.key, relationship: 'jira-subtask' });
    }
  }
  for (const item of Array.isArray(context.relatedTickets.issueLinks) ? context.relatedTickets.issueLinks : []) {
    if (EXACT_ISSUE_KEY.test(item?.key ?? '')) {
      relations.push({ kind: 'ticket', key: item.key, relationship: 'jira-link' });
    }
  }
  return relations;
}

export function reviewLedgerContext(reviewLedgersRoot, mergeRequestKey, options = {}) {
  const parsed = parseMergeRequestKey(mergeRequestKey);
  if (!parsed) {
    if (options.required) throw new Error(`Merge request key is invalid: ${mergeRequestKey}.`);
    return null;
  }
  if (!reviewLedgersRoot) {
    if (options.required) throw new Error('Review ledgers root is required.');
    return null;
  }
  if (!existsSync(reviewLedgersRoot)) {
    if (options.required) throw new Error('Review ledgers root is missing.');
    return null;
  }
  const allowedRoot = realpathSync(resolve(reviewLedgersRoot));
  const directory = resolve(allowedRoot, `mr-${parsed.iid}`);
  withinRoot(allowedRoot, directory, 'Review ledger directory');
  if (!existsSync(directory)) {
    if (options.required) throw new Error(`Review ledger is missing for ${mergeRequestKey}.`);
    return null;
  }
  const realDirectory = realpathSync(directory);
  withinRoot(allowedRoot, realDirectory, 'Review ledger directory');

  let identity = null;
  for (const candidate of JSON_CANDIDATES) {
    const text = boundedRead(join(realDirectory, candidate));
    if (!text) continue;
    identity = jsonIdentity(JSON.parse(text));
    if (identity?.full === mergeRequestKey) break;
    identity = null;
  }
  if (!identity) {
    for (const candidate of SUMMARY_CANDIDATES) {
      const text = boundedRead(join(realDirectory, candidate));
      if (!text) continue;
      identity = summaryIdentity(text, mergeRequestKey, parsed.iid);
      if (identity) break;
    }
  }
  if (!identity) {
    if (options.required) throw new Error(`Review ledger identity is missing for ${mergeRequestKey}.`);
    return null;
  }
  const relations = [
    { kind: 'project', key: projectScopeKey(parsed.project), relationship: 'review-project' },
    ...identity.tickets.map((key) => ({ kind: 'ticket', key, relationship: 'review-ticket' }))
  ];
  return { directory: realDirectory, mergeRequestKey, relations, ticketKeys: identity.tickets };
}

export function reviewLedgerRelations(reviewLedgersRoot, mergeRequestKey) {
  return reviewLedgerContext(reviewLedgersRoot, mergeRequestKey)?.relations ?? [];
}

export function relationsForScope(scope, options = {}) {
  if (scope?.kind === 'ticket') {
    return ticketPackageRelations(options.ticketPackagesRoot, scope.key);
  }
  if (scope?.kind === 'merge-request') {
    return reviewLedgerContext(
      options.reviewLedgersRoot,
      scope.key,
      { required: options.requireReviewLedger === true }
    )?.relations ?? [];
  }
  return [];
}
