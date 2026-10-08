import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

export type WorkRelation = { kind: string; key: string; relationship: string };
export type MergeRequestKey = { key: string; project: string; iid: string };
export type ReviewLedgerContext = { directory: string; mergeRequestKey: string; relations: WorkRelation[]; ticketKeys: string[] };
export type RelationScope = { kind?: string; key: string };
export type RelationOptions = { ticketPackagesRoot?: string; reviewLedgersRoot?: string; requireReviewLedger?: boolean };
type TicketLink = { key?: string };
type TicketContext = { issue?: { key?: string }; relatedTickets?: { parent?: TicketLink; subtasks?: TicketLink[]; issueLinks?: TicketLink[] } };
type JsonIdentityInput = Record<string, unknown> & { references?: { full?: string } };
type LedgerIdentity = { full: string | null; tickets: string[] };

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedRead(path: string): string | null {
  if (!existsSync(path)) return null;
  const size = statSync(path).size;
  if (size <= 0 || size > MAX_LEDGER_SOURCE_BYTES) {
    throw new Error(`Review ledger identity source exceeds the bounded contract: ${path}.`);
  }
  return readFileSync(path, 'utf8');
}

function withinRoot(root: string, path: string, label: string): void {
  const pathFromRoot = relative(root, path);
  if (!pathFromRoot || pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) {
    throw new Error(`${label} escapes its configured root.`);
  }
}

function ticketKeysFrom(values: unknown[]): string[] {
  const tickets = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    for (const match of value.matchAll(ISSUE_KEY)) tickets.add(match[0]);
  }
  return [...tickets].sort().slice(0, MAX_RELATED_TICKETS);
}

function projectScopeKey(project: string): string {
  return project.toLowerCase().replaceAll('/', '-');
}

function jsonIdentity(value: unknown): LedgerIdentity | null {
  if (!isRecord(value)) return null;
  const candidate = value as JsonIdentityInput;
  const iid = candidate.iid ?? candidate.mergeRequest;
  const project = candidate.references?.full?.split('!')[0] ?? candidate.project;
  const full = candidate.references?.full ?? (
    typeof project === 'string' && Number.isSafeInteger(Number(iid))
      ? `${project}!${iid}`
      : null
  );
  return {
    full,
    tickets: ticketKeysFrom([
      candidate.issue,
      candidate.title,
      candidate.description,
      candidate.source_branch,
      candidate.sourceBranch,
      candidate.web_url
    ])
  };
}

function summaryIdentity(value: string, mergeRequestKey: string, iid: string): LedgerIdentity | null {
  const hasIid = new RegExp(`(?:merge_requests/${iid}\\b|MR\\s*!${iid}\\b|!${iid}\\b)`, 'iu').test(value);
  if (!hasIid) return null;
  return { full: mergeRequestKey, tickets: ticketKeysFrom([value]) };
}

export function parseMergeRequestKey(value: unknown): MergeRequestKey | null {
  const match = MERGE_REQUEST_KEY.exec(String(value ?? ''));
  if (!match) return null;
  return { key: match[0], project: match.groups!.project, iid: match.groups!.iid };
}

export function ticketPackageContext(ticketPackagesRoot: string | null | undefined, issueKey: string): TicketContext | null {
  if (!ticketPackagesRoot || !EXACT_ISSUE_KEY.test(issueKey ?? '')) return null;
  const packageRoot = join(resolve(ticketPackagesRoot), issueKey);
  const contextPath = join(packageRoot, 'jira-context.json');
  if (!existsSync(contextPath)) return null;
  const parsedContext: unknown = JSON.parse(readFileSync(contextPath, 'utf8'));
  const context = parsedContext !== null && typeof parsedContext === 'object'
    ? parsedContext as TicketContext : null;
  if (context?.issue?.key !== issueKey || !isRecord(context.relatedTickets)) {
    throw new Error(`Ticket relation context is invalid for ${issueKey}.`);
  }
  return context;
}

export function ticketPackageRelations(ticketPackagesRoot: string | null | undefined, issueKey: string): WorkRelation[] {
  const context = ticketPackageContext(ticketPackagesRoot, issueKey);
  if (!context?.relatedTickets) return [];
  const relations: WorkRelation[] = [];
  if (EXACT_ISSUE_KEY.test(context.relatedTickets.parent?.key ?? '')) {
    relations.push({ kind: 'ticket', key: context.relatedTickets.parent!.key!, relationship: 'jira-parent' });
    relations.push({ kind: 'workstream', key: context.relatedTickets.parent!.key!, relationship: 'jira-parent' });
  }
  for (const item of Array.isArray(context.relatedTickets.subtasks) ? context.relatedTickets.subtasks : []) {
    if (EXACT_ISSUE_KEY.test(item?.key ?? '')) {
      relations.push({ kind: 'ticket', key: item.key!, relationship: 'jira-subtask' });
    }
  }
  for (const item of Array.isArray(context.relatedTickets.issueLinks) ? context.relatedTickets.issueLinks : []) {
    if (EXACT_ISSUE_KEY.test(item?.key ?? '')) {
      relations.push({ kind: 'ticket', key: item.key!, relationship: 'jira-link' });
    }
  }
  return relations;
}

export function reviewLedgerContext(reviewLedgersRoot: string | null | undefined, mergeRequestKey: string, options: { required: true }): ReviewLedgerContext;
export function reviewLedgerContext(reviewLedgersRoot: string | null | undefined, mergeRequestKey: string, options?: { required?: boolean }): ReviewLedgerContext | null;
export function reviewLedgerContext(reviewLedgersRoot: string | null | undefined, mergeRequestKey: string, options: { required?: boolean } = {}): ReviewLedgerContext | null {
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

  let identity: LedgerIdentity | null = null;
  for (const candidate of JSON_CANDIDATES) {
    const text = boundedRead(join(realDirectory, candidate));
    if (!text) continue;
    const parsedIdentity: unknown = JSON.parse(text);
    identity = jsonIdentity(parsedIdentity);
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

export function reviewLedgerRelations(reviewLedgersRoot: string | null | undefined, mergeRequestKey: string): WorkRelation[] {
  return reviewLedgerContext(reviewLedgersRoot, mergeRequestKey)?.relations ?? [];
}

export function relationsForScope(scope: RelationScope | null | undefined, options: RelationOptions = {}): WorkRelation[] {
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
