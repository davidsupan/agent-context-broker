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
