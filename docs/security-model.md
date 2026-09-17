# Security model

Agent Context Broker treats provider transcripts as private source material.
It inventories bounded metadata and derived claims; it does not expose raw
prompts, responses, tool arguments, tool results, native session identifiers,
or credentials to another agent.

## Trust boundaries

- Accepted claims require reconciliation and content-addressed snapshots.
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
  every process it spawns — its tools, Bun, and therefore the agents' lifecycle
  hooks — have `%LOCALAPPDATA%` writes redirected into the package's
  `Packages\<app>\LocalCache\Local\…` tree, and `doctor` run from such a process
  reports that path as the resolved root. A native, non-elevated shell on the
  same machine saw the unvirtualised directory: a `head.json` committing to the
  foreign four-event genesis and an empty records directory, i.e. a broken store
  that no agent reads. An elevated process reported a junction into an older
  `…\Ocean\…` tree holding a third, unforked 4,033-event chain. None of these is
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
Claims of a different project remain unreachable. Term filtering still applies to
everything the ambient project contributes, so a narrow query does not fill with
unrelated project material.

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

## Responsible disclosure

Do not open a public issue for a suspected vulnerability that contains secrets,
private transcript data, or exploit details. Contact the maintainer privately
through the security reporting channel configured on the GitHub repository.
