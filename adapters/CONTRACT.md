# Provider Adapter Contract

## Required Adapter Metadata

Every adapter declares:

- provider and adapter version
- supported surfaces and lifecycle events
- source roots and source formats
- checkpoint strategy
- privacy and redaction behavior
- unsupported capabilities

## Read Contract

- default to read-only
- use bounded roots selected by configuration
- never modify, archive, or delete native histories
- emit normalized source records with a stable source hash
- preserve explicit parent/fork links and label inferred lineage
- checkpoint only after a complete record batch is accepted
- preserve immutable per-run inventory and delta artifacts before checkpointing
- serialize shared checkpoint updates with bounded locking and stale-lock recovery
- make malformed or skipped records visible

## Bootstrap Contract

- provide repository, worktree, branch, task, and session identity when available
- request the smallest matching accepted snapshot
- inject digest and canonical pointers, not raw transcripts
- label stale snapshots and unsupported freshness checks

## Evidence Contract

- emit candidate events only for explicit decisions or observed tool outcomes
- include timestamp, source identity, action identity, and result class
- redact secrets before persistence
- route ticket evidence to the ticket package and review evidence to the
  configured MR review ledger
- never infer external-write success from an attempted tool call

## Manual Refresh Contract

- run only after explicit user invocation and target the current session
- derive relation keys from the current provider source, not raw prompt text
- include only clean accepted snapshots whose registry and snapshot hashes match
- expose only the content-addressed accepted claim key/value projection and
  snapshot-level canonical references
- keep related thread input metadata-only and exclude the current source
- bound snapshots, claims, deltas, claim-value bytes, and rendered context bytes
- fail closed on accepted snapshot or claim integrity drift
- persist only counts, hashes, watermarks, warnings, and dispositions in audit
- never mutate, reprompt, resume, or send content to another session

## Reconciliation Contract

- submit structured candidate claims, never inferred prompt or transcript text
- use hashed session and record keys with a source hash for provenance
- obey the broker state: clean, pending, conflicted, or blocked
- compare the expected snapshot hash and expected current claim id before replace
- reject missing or unknown structural fields and duplicate claim keys before persistence
- treat a non-null current claim id without a current claim as a CAS conflict
- suppress the full candidate payload when any field or object key contains a
  credential, private path, email address, or raw JWT marker
- publish a whole batch or route the whole batch to private review
- keep automatic retry and corrective prompting disabled
- never auto-approve or perform an external write
- expose blocked and unsupported states to the user

## Profiled Query Contract

- route from an explicit task kind or profile, never from stored prompt text
- let strict isolation override every profile and return before reading history
- read only accepted claims whose registry, snapshot, value, and claim hashes match
- expose provider names for cross-provider accountability, but suppress native
  session, record, and source identifiers
- bound terms, snapshots, claims, claim values, and rendered context bytes
- write metadata-only global audit evidence plus optional ticket-package or
  review-ledger evidence
- keep conversation-only agent handoffs unverified and pending

## Failure Contract

Adapters fail open only for context availability, never by claiming success.
Failures must emit an audit event with provider, event, error class, and whether
the session continued without current context.

## Conformance Fixtures

Every adapter must cover:

- clean start with current snapshot
- stale snapshot
- missing parent lineage
- malformed source record
- secret redaction
- duplicate record replay
- conflicting claims
- unsupported lifecycle event
- pending unverified handoff
- stale snapshot compare-and-swap failure
- interrupted snapshot publication
- disabled adapter rollback
