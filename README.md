# Agent Context Broker

Agent Context Broker is a local-first, metadata-only context exchange for coding
agents. It lets Codex and Claude Code share bounded, source-linked facts and
short-lived progress without copying raw conversations, prompts, responses,
credentials, or tool output.

The project is dependency-free at runtime, fail-closed at trust boundaries, and
ships provider adapters, JSON Schemas, a hash-chained event store, deterministic
read models, and PowerShell launchers.

Current release: `0.10.0-beta.4`. The API and storage contracts are still beta.

## Quick start

Requirements: Node.js 20 or newer. PowerShell 7 is needed only for the
PowerShell launchers and Windows integration tests.

```powershell
git clone git@github.com:davidsupan/agent-context-broker.git
Set-Location agent-context-broker
npm run validate
pwsh -NoProfile -File .\scripts\Test-AgentContextBrokerPackage.ps1
```

The commands are plan-only unless `-Execute` is supplied. Start with
[`docs/getting-started.md`](docs/getting-started.md), then review the
[`docs/security-model.md`](docs/security-model.md) before enabling lifecycle
hooks.

## Contents

- `schemas/source-record.schema.json`: normalized provider source record
- `schemas/candidate-claim-batch.schema.json`: structured reconciliation input
- `schemas/context-claim.schema.json`: atomic provenance-bearing claim
- `schemas/context-snapshot.schema.json`: accepted bootstrap snapshot
- `schemas/reconciliation-result.schema.json`: lifecycle reconciliation result
- `src/metadata-inventory.mjs`: provider-neutral bounded JSONL inventory core
- `src/codex-inventory.mjs`: manifest-pinned Codex v1 metadata adapter used by the active fail-open bridge
- `src/codex-inventory-v2.mjs`: provider-neutral Codex adapter for the isolated v2 candidate and shared read-only tools
- `src/claude-inventory.mjs`: Claude Code metadata adapter
- `src/reconciliation.mjs`: deterministic claim CAS and review routing
- `src/fallback-sweep.mjs`: bounded low-frequency provider sweep
- `src/lifecycle-consumer.mjs`: provider-neutral advisory consumer
- `src/lifecycle-events.mjs`: crash-recoverable lifecycle event outbox
- `src/operations.mjs`: incremental ledger migration and read-only diagnostics
- `src/context-refresh.mjs`: bounded user-requested reinjection of accepted context and related metadata
- `profiles/context-profiles.json`: deterministic work-mode profiles and strict-isolation contract
- `src/context-router.mjs`: prompt-independent profile routing
- `src/context-query.mjs`: bounded, hash-verified cross-provider accepted-context query and audit
- `src/context-publish.mjs`: task-token-bound proposal, provenance derivation, and CAS-safe publication
- `src/peer-progress.mjs`: immutable live-progress artifacts with ticket/review relation matching and TTL
- `src/work-ledgers.mjs`: bounded ticket-package and review-ledger relationship discovery
- `src/content-safety.mjs`: shared secret, identity, and local-path suppression rules
- `src/event-store.mjs`: append-only, hash-chained lifecycle event store and repair
- `src/source-attestation.mjs`: provenance attestation backed by verified inventory events
- `src/corrections.mjs`: hash-pinned correction proposal and terminal-decision CAS
- `src/read-model.mjs`: deterministic filesystem projection for operational queries
- `adapters/CONTRACT.md`: provider adapter requirements
- `scripts/Test-AgentContextBrokerPackage.ps1`: lightweight package validation
- `scripts/cross-thread-provider-proof.mjs`: disposable same-provider and cross-provider thread-awareness proof

## Peer Progress

`progress-publish` lets Codex and Claude Code exchange bounded work state without
copying conversations. The proposal records the primary ticket or MR, state,
stage, summary, changed surfaces, limitations, next steps, canonical references,
optional revision/CI metadata, and confirmed related scopes. The lifecycle
source token binds it to an attested provider task.

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command progress-publish -Provider codex `
  -Proposal .\examples\peer-progress-proposal.json `
  -RuntimeRoot <reconciliation-runtime> `
  -EventRuntimeRoot <event-runtime> `
  -TicketPackagesRoot <workspace>\tickets `
  -ReviewLedgersRoot <workspace>\runtime\reviews
```

Add `-Execute` only after the plan is clean. The immutable artifact is stored
under ignored reconciliation runtime; the append-only event contains hashes,
counts, state, stage, and a content-addressed pointer. Repeated identical
publication is idempotent, updates replace the same actor/work checkpoint, and
concurrent updates serialize through the event chain.

Ticket relations come from `jira-context.json` parent, subtask, and issue-link
fields, with explicit related scopes as fallback. A one-sided direct link is
enough for bidirectional visibility. This supports BE ticket A, DB ticket B,
and FE ticket C progressing independently while sharing only relevant findings.
Unrelated tickets are suppressed; common-parent siblings need additional task
relevance rather than flooding every ticket under an epic.

Reviews are equally first-class. Use primary scope
`merge-request:acme/widgets!<iid>`. The broker reads only fixed, bounded identity
sources under `<workspace>\runtime\reviews\mr-<iid>` and derives the project
and linked ticket keys. It never imports patches, findings, proposed comments,
consults, prompts, or responses. Queries and publications append metadata-only
rows to that review package's `CONTEXT_LEDGER.jsonl`, so review work remains
auditable without inventing a ticket package.

Standalone project threads are equally valid work. Use project scope
`example-project` with `work.kind = thread` and `work.key = current`; the broker
replaces `current` with a source-derived opaque thread ref. Later tasks receive
that checkpoint only when bounded query terms match, so unrelated custom work
does not become project-wide noise. The same opaque ref owns a private
metadata-only thread ledger and requires no ticket, documentation, or review package.

`context-query` returns this as `peerProgress` and renders a separate
`Live peer progress (unverified)` section. Accepted claims remain the durable,
verified channel. Conflicting current reports remain visible with
`conflicted: true`; the broker never chooses one silently.

## Validate

```powershell
pwsh -NoProfile -File .\scripts\Test-AgentContextBrokerPackage.ps1
```

The validator parses all schemas, checks required documents and headings, and
rejects UTF-8 BOMs. It also runs Node syntax and the small fixture suite. It does
not read any provider history.

## Provider Inventory

Plan only; no files are written:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command inventory `
  -Provider codex `
  -Source <codex-session.jsonl>
```

Execute into ignored private runtime storage:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command inventory `
  -Provider claude-code `
  -Source <claude-code-session.jsonl> `
  -Output <runtime-root>\inventory.json `
  -Deltas <runtime-root>\deltas.jsonl `
  -Checkpoint <runtime-root>\checkpoint.json `
  -LedgerDirectory <runtime-root>\ledger `
  -Execute
```

The same command accepts `codex` or `claude-code`. Claude metadata may appear
across several initial JSONL records, so the adapter uses a bounded metadata
window rather than assuming the first line contains the workspace identity.

Pull related same-provider peer deltas after a consuming session's watermark:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command related `
  -Provider codex `
  -Source <current-codex-session.jsonl> `
  -LedgerDirectory <runtime-root>\ledger `
  -AfterSequence 42
```

## Reconciliation

Plan a structured claim batch without writing:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command reconcile `
  -Batch .\examples\candidate-claim-batch.json `
  -RuntimeRoot <private-runtime-root>\reconciliation
```

Add `-Execute` only after the plan is acceptable. A batch publishes a new
versioned snapshot only when every claim is verified, safe, nonconflicting, and
based on the current snapshot hash. Stale bases and claim conflicts are atomic:
nothing in that batch becomes current, and a private review item is created.
Unverified handoffs remain pending. Secret or absolute-path markers are blocked
without persisting the rejected payload.

The accepted registry is derived from committed state. If publication is
interrupted after the state pointer changes, the next idempotent invocation
repairs the registry. A metadata-only outbox binds accepted claims and published
snapshots to the event stream. It is prepared before state publication and
delivered only after the committed result hash matches, so either side of a
process interruption is safely replayable.

Pass `--require-source-attestation --attestation-runtime-root <root>` to make
reconciliation fail closed unless every provenance tuple was previously
attested through a verified `source.inventoryed` event.

Agents should normally use the higher-level `context-publish` command instead
of constructing reconciliation provenance and CAS fields themselves. The
lifecycle advisory provides an opaque `acb://source/<hash>` token for the
current task. `context-publish` resolves that exact attested source, checks the
provider, derives the current snapshot and claim CAS values, and then invokes
the same fail-closed reconciliation path. The token is correlation evidence,
not an authorization credential.

## Lifecycle Events And Read Model

Plan and append a metadata-only lifecycle event:

```powershell
.\scripts\agent-context-broker.ps1 -Command event-append `
  -Event <event.json> -RuntimeRoot <runtime-root>

.\scripts\agent-context-broker.ps1 -Command event-append `
  -Event <event.json> -RuntimeRoot <runtime-root> -Execute
```

Verify or repair only the mutable event head; immutable event records are never
rewritten:

```powershell
node .\src\cli.mjs event-verify --runtime-root <runtime-root>
node .\src\cli.mjs event-repair --runtime-root <runtime-root> --execute
```

Build the deterministic read model:

```powershell
node .\src\cli.mjs read-model --runtime-root <runtime-root> --execute
```

An unchanged verified event head produces zero projection writes. Deleting and
rebuilding the projection from the same event records produces byte-identical
nodes, edges, indexes, and manifest files. `--strict-isolation` returns before
opening the event store or read model and performs no writes.

Provider lifecycle consumers prepare their metadata-only event outbox before
advancing the inventory checkpoint. Codex and Claude therefore use the same
idempotent `source.inventoryed` and `thread.delta` path. Set
Set `AGENT_CONTEXT_BROKER_STRICT_ISOLATION=1` for a provider hook to return before
transcript, runtime, event, or audit access.

## Migration And Recovery

Incrementally migrate existing sanitized inventory/delta ledger pairs:

```powershell
.\scripts\agent-context-broker.ps1 -Command migrate-events `
  -LedgerDirectory <private-ledger> -RuntimeRoot <migration-runtime> `
  -EventRuntimeRoot <event-runtime>

.\scripts\agent-context-broker.ps1 -Command migrate-events `
  -LedgerDirectory <private-ledger> -RuntimeRoot <migration-runtime> `
  -EventRuntimeRoot <event-runtime> -Execute
```

The checkpoint stores only input hashes. A repeated run with unchanged ledger
pairs performs zero migrations. Raw provider histories are never migration
inputs; inventory and delta ledgers must already satisfy the metadata-only
adapter contract.

Inspect current state without repairing or writing:

```powershell
.\scripts\agent-context-broker.ps1 -Command doctor `
  -RuntimeRoot <runtime> -EventRuntimeRoot <event-runtime> `
  -ReadModelRoot <read-model>
```

`doctor` verifies the event hash chain and reports reconciliation revision
alignment, lifecycle/reconciliation outbox counts, migrated input count, and
read-model presence. Repair remains a separate explicit command.

## Source Attestation And Freshness

`source-attest` converts only hashed provider/session/record/source inventory
metadata into a `source.inventoryed` event. `source-verify` checks provenance
against that verified event chain. Native paths, source content, prompts, and
transcripts are not accepted by the attestation contract.

Accepted claims may carry an `immutable`, `ttl`, `canonical-head`, or `manual`
freshness policy. An expired TTL claim remains immutable evidence but is
excluded from context-query output with `stale-claim-excluded`.

## Correction Lifecycle

`correction-propose` records the current target hash, proposed replacement hash,
evidence references, confidence, scope, and approval class. It never edits the
target. The owning workflow applies and validates the file change.

`correction-decide` accepts only the unchanged proposal event and the expected
observed revision hash. Accepted and rejected decisions are terminal append-only
events. A stale proposal, repeated terminal decision, or unexpected target hash
fails closed without adding a decision event.

## Manual Context Refresh

Read and render current accepted context plus related metadata without writing:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command context-refresh `
  -Provider codex `
  -Source <current-session.jsonl> `
  -LedgerDirectory <private-lifecycle-runtime>\ledger `
  -RuntimeRoot <private-reconciliation-runtime>
```

Add `-Execute -AuditDirectory <private-audit-runtime>` only for an explicit
user-requested refresh. That writes one immutable metadata-only audit record.
The audit contains counts, hashes, watermark, and warning codes, but not
accepted values, native paths, or provider session identifiers.

The refresh fails closed if a snapshot or the content-addressed claim key/value
projection no longer matches its recorded hash. Output is bounded by snapshot,
claim, delta, value-byte, and total context-byte limits. Related thread data is
metadata only; no peer conversation content is read into the packet.

## Profiled Context Query

Route a task without reading broker state:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command context-route -TaskKind review -ProjectScope
```

Query accepted context and relevant live peer progress for either provider:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command context-query -Provider claude-code `
  -RuntimeRoot <local-runtime-root> -Profile review `
  -ScopeKind merge-request -ScopeKey 'acme/widgets!8466' `
  -ReviewLedgersRoot <workspace>\runtime\reviews `
  -Query 'merge request','pipeline'
```

Pass `-EventRuntimeRoot <private-event-runtime>` to include verified live
progress. Add `-Execute -GlobalAuditDirectory <private-audit-root>` for a
metadata-only global audit plus an exact safe injection-payload artifact. Add
`-TicketPackageRoot <tickets\\APP-key> -TicketAuditRoot <private-records\\tickets>`
only when the operation belongs to a real ticket package; this validates the
shared package and appends one metadata-only row to private
`CONTEXT_LEDGER.jsonl`. For a review query, pass `-ReviewLedgersRoot` and a
`merge-request` scope; the same audit contract writes to the existing review
package instead. Pass a lifecycle-provided `-ThreadRef` with
`-ThreadAuditRoot` to append the same metadata-only query audit to the current
thread ledger.

The built-in profiles cover review, build, implementation, bugfix, ticket/QA,
and ad-hoc project work. `strict-isolation` takes precedence over every profile
and returns before opening the accepted registry. An unrelated, unrouted task
also returns without reading broker state.

Every non-strict query requires an explicit bounded scope. Registry entries are
filtered by the hashed scope relation before snapshot and claim limits are
applied. Review snapshots can carry ledger-derived ticket relations, making
accepted review context available to linked implementation work and vice versa.
Strict isolation writes no global, ticket, or review audit.

Accepted claims and peer progress retain their provider name so Codex can consume reconciled
Claude Code context and Claude Code can consume reconciled Codex context. Native
provider session, record, and source identifiers are never exposed. The query
fails closed if accepted registry, snapshot, claim, or value hashes drift.

## Fallback Sweep

Plan the bounded provider sweep:

```powershell
.\scripts\agent-context-broker.ps1 `
  -Command sweep `
  -Config .\examples\fallback-sweep.json `
  -RuntimeRoot <private-runtime-root>\fallback
```

The execute form is sequential, single-writer, limited to four explicit source
roots, and defaults to a 15-minute minimum interval. It is a recovery mechanism,
not a watcher or daemon.

## Privacy

The CLI normally prints summaries and hashed metadata only. The explicit
`context-refresh` command is the sole exception: it may print a bounded,
hash-verified accepted claim key/value projection for reinjection into the
current agent session. It never prints session paths, native identifiers,
prompts, responses, tool arguments, candidate values, provenance identities, or
tool results. Accepted artifacts remain under ignored private runtime storage;
audit records contain hashes, counts, and dispositions only.

Conversation-only updates use `agent-handoff` plus `unverified` and remain
pending. Agents may publish a clean update only from a real canonical artifact
or observed tool result that supports `verified`;
`examples/agent-handoff-batch.json` shows the pending form.

Provider lifecycle adapters may import `readSourceIdentity()` to obtain the
current source id and relationship keys. That API returns hashed metadata only.

## Runtime Boundary

Generated ledgers, checkpoints, source inventories, claims, and snapshots
belong in private runtime storage. Coworker-safe canonical ticket context
remains in its shared package. Review evidence and its metadata-only context
ledger remain in the configured ignored review package root.

The shared package contains no active hooks. Private Codex and Claude wrappers
own machine-specific activation. A private multi-provider installer prepares
hash-bound plans, requires the exact manifest digest for activation, preserves
existing handlers, creates byte-exact backups, and supports rollback.

## License

Agent Context Broker is available under the Apache License 2.0. See
[LICENSE.md](LICENSE.md) for a short summary and [LICENSE](LICENSE) for the full
license text.
