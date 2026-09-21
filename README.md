# Agent Context Broker

Agent Context Broker is a local-first, provider-neutral open-source beta for sharing small, source-linked pieces of context between coding agents. It turns bounded provider metadata and explicitly observed decisions into structured context that another agent can query, without copying whole conversations.

The repository contains a provider-neutral core, schemas, and optional provider bridges. Its current adapters are for Claude Code and Codex; Claude Code is the operational provider, and the Codex adapter is retained for parity (see [Providers](#providers)).

> **Beta:** `0.11.0-beta.1` is the current source version. The API and storage contracts can change while the project is being evaluated.

Visit the [Agent Context Broker project site](https://davidsupan.github.io/agent-context-broker/) for a visual introduction, or continue below for the complete technical overview.

## Why it exists

Coding agents often need a small amount of trusted context from earlier work, but passing complete transcripts between tools creates unnecessary privacy, size, and provenance problems. The broker is designed to:

- carry forward bounded facts and short-lived work state;
- keep provider histories as private source material;
- make provenance, freshness, and verification state visible; and
- keep provider-specific integration behind a common adapter contract.

## Trust and privacy

The broker treats provider transcripts as private source material.

- Adapters inventory bounded metadata and derived claims. They do not pass raw prompts, responses, tool arguments, tool results, native session identifiers, or credentials to another agent.
- Adapters are read-only by default, use bounded configured roots, and do not modify, archive, or delete native histories. Corpus archiving and pruning exist as separately invoked scripts that keep a per-file restore proof and never delete anything on their own.
- Three kinds of context are kept apart. Accepted context is reconciled and hash-checked before it is used as durable context. Live peer progress is always labeled unverified and expires by TTL. The model-assisted lane holds conclusions extracted from transcripts for human review and can never enter accepted context on its own.
- Caller identity on progress and audits is self-declared description — kind, harness, model, hashed instance — and never authorization: it changes no acceptance, ranking, or scope decision.
- Strict isolation returns before reading broker registries or writing audits. Provider hooks fail open for agent availability, while schema, path, integrity, attestation, and secret checks fail closed.
- Runtime state is intended for private local storage. Audit records contain bounded metadata such as hashes, counts, watermarks, warnings, and dispositions.

Read the [security model](docs/security-model.md) before enabling a lifecycle bridge. The [getting started guide](docs/getting-started.md) describes runtime configuration and the strict-isolation setting.

## Supported providers and platforms

### Providers

The current repository includes these provider adapters and lifecycle bridge packages:

- Claude Code: [`providers/claude-code`](providers/claude-code) — the operational provider.
- Codex: [`providers/codex`](providers/codex) — retained in the package for parity and conformance tests. Since 2026-09-15 it is not in operational use in the maintainer's environment; it is neither removed nor advertised as actively exercised.

Other providers are not advertised as supported by this beta. A new provider needs an adapter that follows [`adapters/CONTRACT.md`](adapters/CONTRACT.md).

### Runtime and platform notes

- Bun `1.4.x` is the only runtime dependency.
- Windows, Linux, and macOS 13 or newer are supported.
- macOS supports Apple Silicon and Intel hardware supported by Bun 1.4.
- PowerShell and Node.js are not required.

No package installation is required for the broker itself.

## Quick start

Clone the repository and validate the checkout:

```sh
git clone https://github.com/davidsupan/agent-context-broker.git
cd agent-context-broker
bun run validate
bun pm pack --dry-run
```

These commands check the Bun sources, schemas, fixtures, and package files. They do not read provider history. Start with [`docs/getting-started.md`](docs/getting-started.md), then review [`docs/security-model.md`](docs/security-model.md) before enabling provider hooks.

## Install

Installation is plan-only by default. Review the generated target list, then activate that exact source manifest and target-state plan:

```sh
bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider both > install-plan.json

bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider both \
  --expected-manifest-digest <manifestDigest-from-plan> \
  --expected-plan-digest <planDigest-from-plan> \
  --execute
```

The installer preserves existing Codex and Claude Code lifecycle handlers, writes byte-exact backups, and copies a verifier and uninstaller into the managed installation. Removal and rollback are also plan-bound; see the [getting started guide](docs/getting-started.md) for the complete flow.

The managed tool payload includes the complete `scripts/` directory, documentation, and license files. Corpus archive, verification, pruning, and handoff-candidate commands are available from the installed tool, not only from a checkout. Installing them does not run corpus processing or accept extracted claims. Use `bun run check:installed` from the installed `tool/` directory to check its package contents; repository CI and the project site remain outside that payload.

## Core workflows

### Query accepted context

Use the high-level launcher to route a bounded query to a provider and project scope:

```sh
bun scripts/agent-context.mjs query \
  --provider claude-code \
  --profile custom-project \
  --project-scope \
  --query "context broker" \
  --query release
```

Use `codex` for the retained Codex adapter. Commands plan changes by default. Add `--execute` only after reviewing the planned operation; an executed query writes the metadata-only audit described in the security model.

### Inventory provider metadata

The lower-level command inventories a bounded provider source. Keep source files private and use the matching provider name:

```sh
bun src/cli.mjs inventory \
  --provider claude-code \
  --source <provider-source.jsonl>
```

Inventory output is normalized into source records and deltas. It does not modify the native history.

### Reconcile and publish context

Candidate claims are submitted as structured proposals. Reconciliation checks schema, safety, source evidence, freshness, and compare-and-swap state before a claim can become accepted context. Conversation-only handoffs remain pending and unverified.

See [`examples/candidate-claim-batch.json`](examples/candidate-claim-batch.json), [`examples/agent-handoff-batch.json`](examples/agent-handoff-batch.json), and the `context-publish` command in [`src/cli.mjs`](src/cli.mjs) for the proposal shapes and execution boundary.

### Publish short-lived progress

Use peer progress for bounded updates that another related task may need while work is in flight:

```sh
bun scripts/agent-context.mjs progress \
  --provider claude-code \
  --proposal ./examples/peer-progress-proposal.json
```

Progress is immutable, time-limited, and explicitly labeled unverified. The example is a shape to adapt to the current task, not a substitute for checking the proposal and its scope.

Add `--agent-kind`, `--agent-model`, `--agent-harness`, and `--agent-instance` to record which agent published a checkpoint or read context. The descriptor is stored as self-declared description with a hashed instance id; it never acts as authorization, and an artifact written without one carries no `agent` key, so older readers keep working. A reader older than 0.11.0-beta.1 rejects an entire read when it meets an artifact that does carry the key, so the launcher refuses these flags unless `AGENT_CONTEXT_BROKER_DESCRIPTORS=1` is set: upgrade every reader in a fleet before declaring callers anywhere. See [Runtime configuration](docs/getting-started.md#runtime-configuration).

### How a query resolves its scope

A query resolves scope as a small relation graph rather than one exact key: a claim on a parent ticket is visible while working its child, and a merge-request scope reaches its ledger-confirmed tickets. When no scope is given, the lifecycle bridge derives one from the prompt, the workstream key, the ticket-shaped working directory, and finally the **current git branch**, which is the most reliable signal on a machine that uses one worktree per ticket. See [Scope resolution](docs/architecture.md#scope-resolution).

### Backfill history without quadratic cost

Ingested history keeps two clocks: `occurredAt` is taken from the source's newest record (valid time), `recordedAt` from the run (transaction time), so old threads never outrank current context. Batched appends verify the tip once and publish one head per batch, which makes ingestion roughly linear in the number of events:

```sh
bun src/cli.mjs migrate-events \
  --ledger-dir <inventory-ledger-dir> \
  --runtime-root <runtime> \
  --event-runtime-root <runtime>/events \
  --execute

bun scripts/audit-ingested-events.mjs <runtime>/events
```

The audit reports the valid/transaction time split, lists any event dated ahead of its own write by sequence number, and flags payloads containing long non-hash strings. That last check is a heuristic for leaked prose, not a proof that no conversation text or secret is present; the content-safety layer at write time is the actual boundary.

### Archive, verify, and prune a transcript corpus

Provider transcripts grow far faster than the broker does. These scripts are deliberately not adapter functions and never delete anything:

```sh
bun scripts/archive-corpus.mjs --source <transcripts> --archive <archive> --execute
bun scripts/verify-archive.mjs --archive <archive> --source <transcripts> --full
bun scripts/prune-archived-corpus.mjs --source <transcripts> --archive <archive> \
  --quarantine <quarantine> --ledger <ledger-outside-quarantine> --keep-days 14 --execute
```

Every archived file carries a per-file round-trip proof; verification re-reads the archive from disk and fails on any original that changed since it was archived; pruning is a rename into a quarantine with a restore ledger, so reclaiming space is a separate, deliberate deletion. See [Corpus archiving](docs/architecture.md#corpus-archiving).

### Propose conclusions through the model-assisted lane

Conclusions extracted from transcripts enter the broker only as review material:

```sh
bun scripts/extract-handoff-candidates.mjs --source <transcripts> --provider claude-code \
  --scope-kind project --scope-key <project> --out proposal.json
bun scripts/propose-handoff-claims.mjs --proposal proposal.json --runtime-root <runtime>/reconciliation --execute
```

The extractor mines operator turns only — sidechain and tool-result records are excluded structurally — and the submitter forces `agent-handoff` / `unverified` regardless of what the proposal asked for, then fails unless reconciliation held the batch for evidence review. Promotion means resubmitting a claim with evidence the broker can check. See [The model-assisted lane](docs/architecture.md#the-model-assisted-lane).

### Enable a provider bridge

Bridge packages live under [`providers/`](providers/). Validate the checkout and review the security model before integrating a bridge with a provider lifecycle hook. Hooks are optional, and the supported lifecycle events vary by provider. Set `AGENT_CONTEXT_BROKER_STRICT_ISOLATION=1` when a provider hook must return before broker reads and writes.

## Repository map

- [`src/`](src/): provider-neutral inventory, routing, reconciliation, publication, event, and read-model code.
- [`providers/`](providers/): Codex and Claude Code bridge packages.
- [`schemas/`](schemas/): JSON Schema contracts for sources, claims, snapshots, events, and progress.
- [`scripts/`](scripts/): Bun launchers, guarded installation and removal, POSIX helpers, package validation, corpus archiving/verification/pruning (`archive-corpus`, `verify-archive`, `prune-archived-corpus`), the model-assisted lane (`extract-handoff-candidates`, `propose-handoff-claims`), and the ingestion audit (`audit-ingested-events`).
- [`site/`](site/): the dependency-free static source for the GitHub Pages project site.
- [`docs/`](docs/): getting started, architecture, security, release, and repository-maintenance guidance.

## Project participation

- Start with [SUPPORT.md](SUPPORT.md) for help and reporting routes.
- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing or implementing a change.
- See [GOVERNANCE.md](GOVERNANCE.md) for the maintainer-led decision model.
- Follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) in project spaces.
- Report vulnerabilities privately according to [SECURITY.md](SECURITY.md).

## Beta status

This is an early public beta. The current source version is `0.11.0-beta.1`; APIs, storage formats, provider bridges, and platform coverage are still subject to change. The repository is suitable for evaluation and focused integration work, but integrations should review the contracts and security behavior before relying on them.

Security fixes are supported on the latest published revision only. See [`SECURITY.md`](SECURITY.md) for responsible disclosure guidance.

Bug reports, design discussions, and focused reproductions are welcome through the contribution process in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Agent Context Broker is available under the Apache License 2.0. See [`LICENSE.md`](LICENSE.md) for a short summary and [`LICENSE`](LICENSE) for the full license text.
