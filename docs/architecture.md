# Architecture

Agent Context Broker shares bounded, source-linked context without treating raw
agent conversations as a cross-provider data plane.

## Components

- `providers/` contains thin Codex and Claude Code adapters. They translate
  provider lifecycle input into the provider-neutral command surface.
- `src/` contains inventory, routing, reconciliation, publication, event-store,
  progress, installation, and read-model behavior.
- `schemas/` defines the persisted and exchanged JSON contracts.
- `profiles/` defines bounded query profiles and routing behavior.
- `examples/` contains synthetic proposal shapes used by people and installed
  agents.
- `scripts/` contains the high-level launcher, package checks, and guarded
  install, verification, removal, and rollback entry points.

## Data flow

1. A provider adapter inventories bounded metadata or receives a structured
   proposal.
2. The core validates paths, schemas, source attestation, content safety,
   freshness, and expected state.
3. Reconciliation either accepts a durable claim, leaves it pending, or rejects
   it with a reason.
4. Queries route the smallest matching accepted context and separately label
   short-lived peer progress as unverified.
5. Metadata-only audit records capture hashes, counts, and dispositions without
   storing raw provider conversations.

## Scope resolution

A query is bound to one explicit scope, but scope is resolved as a small graph
rather than a single exact key.

- **Primary scope** is the ticket, merge request, workstream, or project the
  query names.
- **Related scopes** are derived from trusted local ledger files: a ticket
  package's `jira-context.json` contributes its parent, subtasks, and issue
  links; a review ledger contributes the relations recorded for that merge
  request. Accepted claims and peer progress resolve scope the same way, so a
  claim published against a parent ticket is visible while working its child.
- Relation expansion is enrichment, never a gate. A missing or unreadable ledger
  removes related scopes but never the primary one, and a snapshot must still
  carry a relation the query accepts before it is verified and read.

Scope itself is derived from the hook event when the agent does not state one:
an explicit merge-request reference wins, then a single ticket key in the
prompt, then a workstream key, then a ticket-shaped working directory, then the
**current git branch** — the most reliable signal on a machine that uses one
worktree per ticket. An ambiguous prompt naming several tickets falls through to
the branch rather than failing closed with no scope at all.

Query terms narrow results within the resolved scope. For a ticket or merge
request the agent is actively working, claims on that exact scope survive a term
miss, because returning nothing for the current task is worse than returning a
little. Broader project and workstream scopes stay term-filtered, and related
scopes always require a term match so a parent ticket cannot flood a query.

## Trust boundaries

Provider histories remain private source material. Accepted claims are not
trusted merely because an agent proposed them; they must pass the reconciliation
and integrity contracts. Peer progress is useful coordination data, but remains
unverified and expires. Strict isolation returns before broker registry reads or
audit writes.

Installation is a separate trust boundary. It is plan-only by default, binds an
activation to exact manifest and plan digests, preserves existing lifecycle
handlers, and supports verified removal or rollback.

See [security-model.md](security-model.md) for security invariants and
[`adapters/CONTRACT.md`](../adapters/CONTRACT.md) for provider integration rules.
