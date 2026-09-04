# Agent Context Broker

Agent Context Broker is a local-first, provider-neutral open-source beta for sharing small, source-linked pieces of context between coding agents. It turns bounded provider metadata and explicitly observed decisions into structured context that another agent can query, without copying whole conversations.

The repository contains a provider-neutral core, schemas, and optional provider bridges. Its current adapters are for Codex and Claude Code.

> **Beta:** `0.10.0-beta.5` is the current release. The API and storage contracts can change while the project is being evaluated.

## Why it exists

Coding agents often need a small amount of trusted context from earlier work, but passing complete transcripts between tools creates unnecessary privacy, size, and provenance problems. The broker is designed to:

- carry forward bounded facts and short-lived work state;
- keep provider histories as private source material;
- make provenance, freshness, and verification state visible; and
- keep provider-specific integration behind a common adapter contract.

## Trust and privacy

The broker treats provider transcripts as private source material.

- Adapters inventory bounded metadata and derived claims. They do not pass raw prompts, responses, tool arguments, tool results, native session identifiers, or credentials to another agent.
- Adapters are read-only by default, use bounded configured roots, and do not modify, archive, or delete native histories.
- Accepted context is reconciled and hash-checked before it is used as durable context. Live peer progress is always labeled unverified and expires by TTL; it is not treated as a verified fact.
- Strict isolation returns before reading broker registries or writing audits. Provider hooks fail open for agent availability, while schema, path, integrity, attestation, and secret checks fail closed.
- Runtime state is intended for private local storage. Audit records contain bounded metadata such as hashes, counts, watermarks, warnings, and dispositions.

Read the [security model](docs/security-model.md) before enabling a lifecycle bridge. The [getting started guide](docs/getting-started.md) describes runtime configuration and the strict-isolation setting.

## Supported providers and platforms

### Providers

The current repository includes these provider adapters and lifecycle bridge packages:

- Codex: [`providers/codex`](providers/codex)
- Claude Code: [`providers/claude-code`](providers/claude-code)

Other providers are not advertised as supported by this beta. A new provider needs an adapter that follows [`adapters/CONTRACT.md`](adapters/CONTRACT.md).

### Runtime and platform notes

- The core CLI requires Node.js 20 or newer.
- PowerShell 7 is required for the launchers, installer, uninstaller, and integration tests.
- This release supports Windows and Linux. macOS lifecycle and installation support is not part of the current compatibility promise.

No npm dependencies are required for the package itself.

## Quick start

Clone the repository and run the two local validation commands:

```powershell
git clone https://github.com/davidsupan/agent-context-broker.git
Set-Location agent-context-broker
npm run validate
pwsh -NoProfile -File ./scripts/Test-AgentContextBrokerPackage.ps1
```

These commands check the Node.js sources, schemas, fixtures, and package files. They do not read provider history. Start with [`docs/getting-started.md`](docs/getting-started.md), then review [`docs/security-model.md`](docs/security-model.md) before enabling provider hooks.

## Install

Installation is plan-only by default. Review the generated target list, then activate that exact source manifest and target-state plan:

```powershell
$plan = ./scripts/Install-AgentContextBroker.ps1 -Provider Both |
  ConvertFrom-Json

./scripts/Install-AgentContextBroker.ps1 `
  -Provider Both `
  -ExpectedManifestDigest $plan.manifestDigest `
  -ExpectedPlanDigest $plan.planDigest `
  -Execute
```

The installer preserves existing Codex and Claude Code lifecycle handlers, writes byte-exact backups, and copies a verifier and uninstaller into the managed installation. Removal and rollback are also plan-bound; see the [getting started guide](docs/getting-started.md) for the complete flow.

## Core workflows

### Query accepted context

Use the high-level launcher to route a bounded query to a provider and project scope:

```powershell
./scripts/agent-context.ps1 `
  -Command query `
  -Provider codex `
  -Profile custom-project `
  -ProjectScope `
  -Query 'context broker','release'
```

Use `claude-code` for the Claude Code adapter. Commands plan changes by default. Add `-Execute` only after reviewing the planned operation; an executed query writes the metadata-only audit described in the security model.

### Inventory provider metadata

The lower-level command inventories a bounded provider source. Keep source files private and use the matching provider name:

```powershell
./scripts/agent-context-broker.ps1 `
  -Command inventory `
  -Provider codex `
  -Source <provider-source.jsonl>
```

Inventory output is normalized into source records and deltas. It does not modify the native history.

### Reconcile and publish context

Candidate claims are submitted as structured proposals. Reconciliation checks schema, safety, source evidence, freshness, and compare-and-swap state before a claim can become accepted context. Conversation-only handoffs remain pending and unverified.

See [`examples/candidate-claim-batch.json`](examples/candidate-claim-batch.json), [`examples/agent-handoff-batch.json`](examples/agent-handoff-batch.json), and the `context-publish` command in [`src/cli.mjs`](src/cli.mjs) for the proposal shapes and execution boundary.

### Publish short-lived progress

Use peer progress for bounded updates that another related task may need while work is in flight:

```powershell
./scripts/agent-context.ps1 `
  -Command progress `
  -Provider codex `
  -Proposal .\examples\peer-progress-proposal.json
```

Progress is immutable, time-limited, and explicitly labeled unverified. The example is a shape to adapt to the current task, not a substitute for checking the proposal and its scope.

### Enable a provider bridge

Bridge packages live under [`providers/`](providers/). Validate the checkout and review the security model before integrating a bridge with a provider lifecycle hook. Hooks are optional, and the supported lifecycle events vary by provider. Set `AGENT_CONTEXT_BROKER_STRICT_ISOLATION=1` when a provider hook must return before broker reads and writes.

## Repository map

- [`src/`](src/): provider-neutral inventory, routing, reconciliation, publication, event, and read-model code.
- [`providers/`](providers/): Codex and Claude Code bridge packages.
- [`schemas/`](schemas/): JSON Schema contracts for sources, claims, snapshots, events, and progress.
- [`scripts/`](scripts/): PowerShell launchers, guarded installation and removal, and package validation.
- [`docs/`](docs/): getting started and security guidance.

## Beta status

This is an early public beta. The current release is `0.10.0-beta.5`; APIs, storage formats, provider bridges, and platform coverage are still subject to change. The repository is suitable for evaluation and focused integration work, but integrations should review the contracts and security behavior before relying on them.

Security fixes are supported on the latest published revision only. See [`SECURITY.md`](SECURITY.md) for responsible disclosure guidance.

Bug reports, design discussions, and focused reproductions are welcome through the contribution process in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

Agent Context Broker is available under the Apache License 2.0. See [`LICENSE.md`](LICENSE.md) for a short summary and [`LICENSE`](LICENSE) for the full license text.
