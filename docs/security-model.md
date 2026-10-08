# Security model

Agent Context Broker treats provider transcripts as private source material.
It inventories bounded metadata and derived claims; it does not expose raw
prompts, responses, tool arguments, tool results, native session identifiers,
or credentials to another agent.

## Trust boundaries

- Accepted claims require reconciliation and content-addressed snapshots.
- Ticket and MR keys extracted from prompts are untrusted input. Sample keys or
  another team's references cannot route lifecycle context without local evidence:
  a ticket's branch, validated package, prior evidenced session route, or verified
  same-provider work in that exact scope; an MR's review ledger or prior evidenced
  session route. Other-provider and merely related records do not establish this
  evidence. Explicit caller scopes retain their existing behavior.
- Unconfirmed prompt keys are trace-only suggestions containing kind, SHA-256 of
  the lowercase key, and `no-local-evidence`. Raw keys and suggestion prose are
  not added to advisories. Session routing history stores relation hashes only.
  Routing evidence does not bypass provider read policy or promote peer progress
  into accepted claims, and requires no network access.
- Live peer progress is always labelled unverified and expires by TTL.
- Publications require a source token backed by the same verified event store.
- Strict isolation returns before reading registries or writing audits.
- Path validation constrains transcript, ticket, review, and runtime roots.
- Secret-like content, absolute paths, identity data, and oversized values are
  rejected or suppressed by the content-safety layer.
- The model-assisted lane is a dead end for trust. Claims extracted from
  transcripts are forced to `agent-handoff` / `unverified` regardless of what
  the extractor asked for, are held for evidence review, never reach the event
  store, and never appear in accepted context. Promotion means resubmitting a
  claim with canonical-artifact or observed-tool-result evidence.
- Caller identity is self-declared description, never authorization. A
  descriptor (kind, harness, model, hashed instance) changes no acceptance,
  ranking, TTL, or scope decision and is stored marked `self-declared`. The raw
  instance id is hashed on the way in; free text is rejected.
- Artifacts written without a descriptor carry no `agent` key at all, so a
  reader that predates the field keeps verifying every plain publish. New
  fields are checked against the **deployed** reader, not only old records
  against new code.
- A records directory holding two files for one sequence is reported as a
  parallel chain, by sequence, rather than as a generic chain failure.
- Lifecycle delivery refuses to seed an empty event store once that lifecycle
  has delivered before. A delivered receipt proves the chain existed, so a
  missing head afterwards means the hook is looking at the wrong or a partially
  visible directory, not at a fresh store. Activation and `migrate-events`
  opt in deliberately.

Provider hooks fail open so an unavailable broker does not block the coding
agent. Integrity, attestation, schema, and path checks fail closed: invalid data
is not imported or promoted.

## Runtime home

The live runtime is whatever `AGENT_CONTEXT_BROKER_HOME` resolves to (or the
platform default below it). Older layouts can leave a second runtime tree on
disk that nothing reads. Verifying, repairing, or backfilling that tree proves
nothing about the store agents use. Print the resolved root first; `doctor`
names the store it verified.

## Incident record: divergent runtime views, 2026-09-14/15

What was observed, in the order it became known:

- Agents reported `Broker event chain verification failed.` from the installed
  launcher for roughly eighteen hours. In the process view the launcher used,
  the records directory held two files each for sequences 1–4: a legitimate
  chain and a second genesis written by a lifecycle hook whose view showed no
  head and no records. Moving the four foreign files aside (backup first, head
  untouched) made that view verify again and the failing query return.
- The same period also contained a real defect of this project's own making: a
  peer-progress artifact carrying the then-new `agent` field had been published
  into a store read by an installed tool that predates the field. That reader
  verifies every current artifact before scoping, so one unrelated artifact
  failed every query until it was superseded by a plain revision.
- Different processes then read different contents at the same pathname. The
  mechanism is **MSIX AppData virtualization**: the packaged desktop agent and
  every process it spawns — its tools, the runtime, and therefore the agents' lifecycle
  hooks — have `%LOCALAPPDATA%` writes redirected into the package's
  `Packages\<app>\LocalCache\Local\…` tree, and `doctor` run from such a process
  reports that path as the resolved root. A native, non-elevated shell on the
  same machine saw the unvirtualised directory: a `head.json` committing to the
  foreign four-event genesis and an empty records directory, i.e. a broken store
  that no agent reads. An elevated process reported a junction into an older
  host application's `…\<host>\…` tree holding a third, unforked 4,033-event chain. None of these is
  "the" store; the one that matters operationally is the one the hooks' process
  kind resolves, and the fix is to bind identity to the resolved path and head
  hash — or to move the runtime home out of the virtualised area altogether.

Conclusions that hold regardless of which view is called real: the pathname
does not identify the store; identity is the resolved path **and** the head
hash, reported by `doctor`; artifacts must stay readable by the deployed reader;
a records directory with two files for one sequence is a parallel chain, named
as such; and a hook must not start a genesis once receipts exist. Nothing in
this record authorises merging, re-ingesting, or deleting either tree.

## The ambient project of a narrow scope

A query bound to a ticket, merge request or workstream also admits the claims and
progress of one project: the project the operator configured as the default. The
reason is that standing practice is recorded once, at the project, while work
happens in tickets; without this, a rule has to be re-recorded per ticket to be
readable from it.

The widening stays a gate rather than a hole. It adds exactly one scope, always
of kind project, only to a scope narrower than a project, and the key comes from
operator configuration or an explicit flag, never from prompt text, a transcript,
or any other untrusted input. A query already at project scope does not widen.
Claims of a different project remain unreachable, and term filtering still
applies to everything the ambient project contributes.

## Ambient global rules

Global-scope snapshots join every query below global scope. Only snapshots the
operator published at kind global take part, the provider's read rules still
decide per scope, and the snapshot cap still bounds the total. Their claims are
admitted without a term match, so keep the global scope for rules that truly
hold everywhere; anything narrower belongs at a project or workstream.

Claims and live progress differ here, deliberately. A standing claim recorded at
the project is what a narrow query is missing, so it surfaces without a term
match. Live progress published against the project is another agent's current
work, which would drown a ticket query if it always appeared, so it reaches a
narrow scope only when a query term matches it.

## Caller descriptors and reader compatibility

A caller descriptor is self-declared metadata and never authorization. It is also
a compatibility boundary: a reader that predates the `agent` field rejects an
entire read when it meets an artifact that carries one, so a single descriptor
artifact can blind every un-upgraded reader in a fleet. Artifacts written without
a declared descriptor carry no `agent` key at all, which is what keeps mixed
fleets working.

The `AGENT_CONTEXT_BROKER_DESCRIPTORS` switch is an operational safeguard in the
launcher, not a security control: it refuses the descriptor flags unless the
operator has opted in. The library and `src/cli.mjs` do not enforce it, so a
second wrapper that skips the check can still declare descriptors. Treat the
switch as a deployment gate to be lifted once every installed reader is upgraded
and rollback is no longer wanted, and audit any other wrapper for the same check.

## Team-shared notices

Team-shared notices have an additional untrusted-content boundary: offline
branch ancestry, strict record revalidation, quarantine without text, local
audience policy, a data envelope and per-call byte limits.

The pattern list is a heuristic, not the control. It can miss malicious prose in
any language and can flag harmless text. The controls are review on the protected
branch with recorded approval provenance, the secret-derived nonce envelope, unread-only
injection, the lane byte cap, quarantine, and never placing notice text in a system
prompt. Only approved, unread notices at primary or visible audience level enter
the injected lane. A failed lane returns no notice text and a `team-shared-error`
warning code; accepted claims keep working. Offline CI receipts must match the
record ID and raw-byte digest, with a host-verified manifest binding the artifact
to the configured repository, project, reachable checkout commit and protected
pipeline. Missing receipts remain unverified; malformed receipts quarantine.
The legacy metadata approval map grants no authority. The host is responsible
for authenticated artifact sync and cache integrity. The trust anchor is the local
receipt producer and authenticated host sync, together with protection of the
runtime home. Anything that can write that home can forge `trust.json`; this is
the same local trust boundary as the broker store.

Envelope-marker false positives quarantine the notice without exposing its text.
The reported reason id identifies the marker the author must change before the
notice can be reviewed and included again.

Envelope nonces use HMAC-SHA256 with a private per-installation secret and sorted
included notice/snapshot digests. Identical inputs preserve payload digests;
record content alone cannot predict the nonce. First use atomically publishes the
secret. On POSIX the file uses mode 0600. Windows skips the POSIX mode check and
relies on the user profile ACL to protect the runtime home. For new Windows
secrets, the fixed PowerShell host helper also sets an explicit owner-only ACL
with inheritance disabled on the empty file before secret bytes are written.
Creation is serialized, with an exclusive in-place fallback if hard links are
unavailable. ACL setup runs once; existing Windows secrets retain their ACLs
and reads never spawn a process. If ACL setup fails, the secret is retained and
`team-shared-secret-acl-unverified` persists in warnings, preserving stable nonces.
Unsafe/unavailable secret storage uses random nonces and reports
`team-shared-nonce-ephemeral`, losing stable digest behavior for that query.

See
[Team-shared notices](provider-policy.md#team-shared-notices) for configuration,
rule ids, local trust assumptions and host responsibilities.

## Responsible disclosure

Do not open a public issue for a suspected vulnerability that contains secrets,
private transcript data, or exploit details. Contact the maintainer privately
through the security reporting channel configured on the GitHub repository.

## Emergency ledger

Emergency access is an operator-controlled policy exception, limited by an
absolute expiry. Caller-requested strict isolation still wins. The append-only
`emergency/grants.jsonl` hash chain binds the recorded ordering, grant metadata,
and metadata-only use records. A separate local `head.json` checkpoint detects
removal of the final record or of the ledger alone. Modified lines, missing
interior lines, reordering, missing checkpoints and partial appends fail closed
to ordinary provider policy. No automatic repair is attempted. A crash between
the ledger append and checkpoint replacement can therefore require operator
investigation even if the preceding records were legitimate.

The ledger proves internal consistency against the local checkpoint, not who
performed an operation or whether an operator's stated reason is true. Anyone
who can write the runtime home can also write the ledger and checkpoint, recompute
the chain, or restore both from an earlier copy. The hash chain makes edits
evident, not impossible. It is not an external signature, trusted timestamp,
remote attestation or protection against a malicious local writer.

Publication use records are durable write-ahead reservations. Storage failures
after reservation may leave a recorded attempt with no persisted claim; reports
resolve current accepted, pending, withdrawn or not-persisted state instead of
claiming the ledger alone proves commitment. Query ledger failures are warnings;
they do not withhold an otherwise permitted answer. The ledger covers broker
commands, not arbitrary provider filesystem reads or writes. It contains claim
keys and ids but never claim values or payload text. Operator-supplied reasons
are stored verbatim, so they should describe the handover without private content.

Injection audit payloads are separate local artifacts and can contain rendered
context. Manual `audit prune` deletes only eligible old injection files, without
changing the emergency ledger or other audit records. Runtime-home filesystem
permissions remain the trust boundary for both storage and pruning.
