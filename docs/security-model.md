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

## Incident record: parallel chain, 2026-09-14/15

Every full verification of the shared store failed for about eighteen hours
with `Broker event chain verification failed.` The chain was intact. A lifecycle
hook had run with a filesystem view in which neither the head nor the records
were visible, appended sequences 1–4 as a fresh genesis, and its writes landed
in the real records directory beside the legitimate ones. Two files per
sequence, and every reader stopped.

Repair: back up the runtime; move only the files the committed head does not
reference into a quarantine; verify. The head was never rewritten and no
integrity check was bypassed. Hardening: parallel chains are named by sequence,
and hooks cannot start a genesis once receipts exist. Lesson recorded here so it
is not relearned: the repair was first attempted on a runtime the agents did not
read; always resolve the live root before touching a store.

## Responsible disclosure

Do not open a public issue for a suspected vulnerability that contains secrets,
private transcript data, or exploit details. Contact the maintainer privately
through the security reporting channel configured on the GitHub repository.
