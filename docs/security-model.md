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

Provider hooks fail open so an unavailable broker does not block the coding
agent. Integrity, attestation, schema, and path checks fail closed: invalid data
is not imported or promoted.

## Responsible disclosure

Do not open a public issue for a suspected vulnerability that contains secrets,
private transcript data, or exploit details. Contact the maintainer privately
through the security reporting channel configured on the GitHub repository.
