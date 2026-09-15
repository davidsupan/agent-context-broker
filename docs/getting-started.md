# Getting started

## Requirements

- Bun `1.4.x`
- Codex or Claude Code only when installing a provider bridge
- Windows, Linux, or macOS 13 or newer

PowerShell, Node.js, and npm are not required. The broker has no package
dependencies, so validation and installation do not run a dependency install.

Install Bun using its [official installation instructions](https://bun.sh/docs/installation),
then verify the runtime before continuing:

```sh
bun --version
bun --revision
```

## Validate the checkout

```sh
bun run validate
bun pm pack --dry-run
```

On Linux and macOS, also validate and exercise the native shell entrypoints:

```sh
sh -n scripts/*.sh
./scripts/test-shell-installation.sh
```

## Install provider bridges

Installation is plan-only by default. The plan binds the package manifest,
resolved Bun executable, selected providers, target paths, and current target
hashes. Review it, then pass both exact digests back to the unchanged command:

```sh
bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider both > install-plan.json

bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider both \
  --expected-manifest-digest <manifestDigest-from-install-plan> \
  --expected-plan-digest <planDigest-from-install-plan> \
  --execute
```

The portable command works unchanged on Windows, Linux, and macOS. Linux and
macOS users may run `./scripts/install-agent-context-broker.sh` with the same
options instead.

The installer copies the broker to `$HOME/.agent-context-broker`, adds only its
own lifecycle handlers to existing Codex and Claude Code configuration, and
stores byte-exact backups outside the installation tree. The generated hook
commands pin the resolved absolute Bun executable and call the provider CLI
without a PowerShell or Node.js wrapper.

Restart the installed providers after activation, review their hook
configuration, then inspect the installation:

```sh
bun "$HOME/.agent-context-broker/tool/scripts/test-agent-context-broker-installation.mjs"
```

Use `--provider codex` or `--provider claude` to install only one bridge.
Override `--codex-home`, `--claude-home`, `--install-root`, or `--runtime-home`
for a non-default layout.

## Query safely

The high-level launcher chooses a private runtime directory below:

- `%LOCALAPPDATA%\AgentContextBroker` on Windows;
- `${XDG_STATE_HOME:-$HOME/.local/state}/agent-context-broker` on Linux; or
- `$HOME/Library/Application Support/AgentContextBroker` on macOS.

`AGENT_CONTEXT_BROKER_HOME` overrides that default, and the installed lifecycle
bridges export it, so **the runtime the agents actually use is whatever that
variable resolves to** — not necessarily the directory you happen to be looking
at. Older layouts may leave a second runtime behind (for example an
`…\Ocean\AgentContextBroker` tree on Windows); nothing in this version reads
it, and verifying or repairing it tells you nothing about the live store. Print
the resolved root before any diagnosis:

```sh
bun scripts/agent-context.mjs route --provider claude-code --project-scope
bun src/cli.mjs doctor --runtime-root "$AGENT_CONTEXT_BROKER_HOME/runtime" \
  --event-runtime-root "$AGENT_CONTEXT_BROKER_HOME/runtime/events"
```

`doctor` names the event store it verified; if that path is not the one your
hooks resolve, you are looking at the wrong runtime.

Commands plan changes by default:

```sh
bun scripts/agent-context.mjs query \
  --provider codex \
  --profile custom-project \
  --project-scope \
  --query "context broker" \
  --query release
```

Linux and macOS users can use `./scripts/agent-context.sh` with the same
arguments. Set `AGENT_CONTEXT_BROKER_DEFAULT_PROJECT` when lifecycle hooks
should route otherwise unscoped prompts to one project. Leave it unset to avoid
implicit project routing.

## Runtime configuration

| Variable | Purpose |
|---|---|
| `AGENT_CONTEXT_BROKER_HOME` | Private runtime root |
| `AGENT_CONTEXT_BROKER_DEFAULT_PROJECT` | Explicit lifecycle fallback project |
| `AGENT_CONTEXT_BROKER_STRICT_ISOLATION=1` | Disable broker reads and writes in provider hooks |
| `AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS` | Extra allowed Codex transcript roots |
| `AGENT_CONTEXT_BROKER_CLAUDE_TRANSCRIPT_ROOTS` | Extra allowed Claude transcript roots |
| `AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT` | Optional review metadata root |
| `AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME` | Override the reconciliation root (defaults below the runtime home) |
| `AGENT_CONTEXT_BROKER_EVENT_RUNTIME` | Override the event-store root (defaults below the runtime home) |
| `ACB_AGENT_KIND` | Self-declared caller kind for descriptors: `interactive`, `subagent`, `scheduled`, `sdk` |
| `ACB_AGENT_MODEL` / `ANTHROPIC_MODEL` | Self-declared model name recorded on progress and audits |

## Backfill history

`migrate-events` turns inventory ledgers into events in batches, taking valid
time from each source's newest record and transaction time from the run:

```sh
bun src/cli.mjs migrate-events --ledger-dir <ledger-dir> \
  --runtime-root "$AGENT_CONTEXT_BROKER_HOME/runtime" \
  --event-runtime-root "$AGENT_CONTEXT_BROKER_HOME/runtime/events" --execute
bun scripts/audit-ingested-events.mjs "$AGENT_CONTEXT_BROKER_HOME/runtime/events"
```

Point it at the runtime the agents use (see above); a backfill into a runtime
nobody reads is indistinguishable from a successful one until someone queries.

## Archive, verify, and prune a corpus

These scripts operate on provider transcript directories, not on the broker, and
never delete anything themselves:

```sh
bun scripts/archive-corpus.mjs --source <transcripts> --archive <archive> --execute
bun scripts/verify-archive.mjs --archive <archive> --source <transcripts> --full
bun scripts/prune-archived-corpus.mjs --source <transcripts> --archive <archive> \
  --quarantine <quarantine> --ledger <ledger-path-outside-quarantine> \
  --keep-days 14 --execute
bun scripts/prune-archived-corpus.mjs ... --ledger <ledger-path> --restore --execute
```

`verify-archive` exits non-zero when any archived file cannot be restored or any
original changed after archiving; treat its exit code, not its prose, as the
gate before deleting originals. Keep the prune ledger outside the quarantine so
deleting the quarantine cannot delete the record of what it held.

## Remove or roll back

Removal is also plan-only. It deletes managed files and handlers while
preserving unrelated configuration changes made after installation:

```sh
bun scripts/manage-agent-context-broker-installation.mjs remove \
  --runtime-home <runtime-home> > remove-plan.json

bun scripts/manage-agent-context-broker-installation.mjs remove \
  --runtime-home <runtime-home> \
  --expected-plan-digest <planDigest-from-remove-plan> \
  --execute
```

Use `rollback` instead of `remove` to restore the complete pre-install state. A
rollback is blocked if any managed target changed after installation, because
silently overwriting that drift would be unsafe. Both operations retain backup
evidence under the private runtime root.
