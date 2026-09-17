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
bridges export it. The pathname alone does not identify the store: on one
Windows workstation the same `…\runtime` path resolved to different directories
from different processes (a native elevated process saw a junction into an older
`…\Ocean\AgentContextBroker` tree; harness-spawned processes, including the
agents' hooks, saw a separate directory). A store that verifies cleanly in one
view proves nothing about the store another process reads.

The mechanism behind that case is MSIX AppData virtualisation: processes started
by a packaged desktop application, and therefore the lifecycle hooks it spawns,
have their `%LOCALAPPDATA%` writes redirected into the package's
`Packages\<app>\LocalCache` tree, while native shells see the real directory.
The Windows default home sits inside `%LOCALAPPDATA%`, so when agents run from
a packaged application, set `AGENT_CONTEXT_BROKER_HOME` to a directory outside
`AppData` (for example `%USERPROFILE%\.agent-context-broker\home`) and pass the
same directory as `--runtime-home` at install time, so that hooks, tools and
native shells share one physical store. Move an existing installation with the
plan-bound `adopt` (if the installation predates install state), `remove`, and
`install --runtime-home <new>` sequence described under "Upgrade an existing
installation", then copy the store from the view the hooks were actually writing
and verify it in the new home with `doctor`.

Bind diagnosis to the resolved path **and** the head hash. `doctor` reports the
lexical and resolved roots, whether resolution crossed a reparse point, the record
count, and the head hash, and distinguishes a `missing` store from an initialised
`empty` one. Run it from the same kind of process that will read the store (for
hooks, an ordinary user process), and compare the head hash with what a hook run
reports:

```sh
HOME_DIR="${AGENT_CONTEXT_BROKER_HOME:-<platform default above>}"
bun src/cli.mjs doctor --runtime-root "$HOME_DIR/runtime/reconciliation" \
  --event-runtime-root "$HOME_DIR/runtime/events"
```

If `AGENT_CONTEXT_BROKER_HOME` is unset, substitute the platform default
explicitly; shell interpolation of an unset variable yields `/runtime`, not the
default. `route` returns profile routing metadata and does not print a runtime
root.

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

Caller descriptors are supplied explicitly with `--agent-kind`, `--agent-model`,
`--agent-harness` and `--agent-instance` on `progress`, `publish` and `query`.
No environment variable populates them automatically.

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

`verify-archive` exits non-zero when any archived file cannot be restored, when
any original changed after archiving, or when `--source` matched no originals at
all (a mistyped directory is a failure, not a clean result). Only `--full`
together with `--source` covers every entry; the default run is a sample and
says so. Even a clean full run is evidence for a decision, not the decision:
deletion stays a separate, explicit step. Keep the prune ledger outside the
quarantine so deleting the quarantine cannot delete the record of what it held.

## Upgrade an existing installation

The installer refuses to write over recorded installation state, and that guard
is not bypassed for upgrades. If the existing installation has **no**
`install-state.json` (it was written by an earlier installer, or the state was
lost), first bring it under management without changing it. Adoption verifies
that the tool payload is present and that each selected provider carries the
expected handler exactly once; a handler with a different command is refused,
not approximated:

```sh
bun scripts/manage-agent-context-broker-installation.mjs adopt \
  --provider <provider> --runtime-home <runtime-home> > adopt-plan.json
bun scripts/manage-agent-context-broker-installation.mjs adopt \
  --provider <provider> --runtime-home <runtime-home> \
  --expected-manifest-digest <manifestDigest> --expected-plan-digest <planDigest> --execute
```

An adopted installation can be removed or upgraded, but not rolled back: there
is no pre-install state to return to.

Upgrading is then two explicit, plan-bound steps against the same runtime home,
each with its own digests:

```sh
# 1. remove the managed files and handlers (refuses if a managed target drifted)
bun scripts/manage-agent-context-broker-installation.mjs remove \
  --runtime-home <runtime-home> > remove-plan.json
bun scripts/manage-agent-context-broker-installation.mjs remove \
  --runtime-home <runtime-home> \
  --expected-plan-digest <planDigest-from-remove-plan> --execute

# 2. install the new package
bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider <provider> --runtime-home <runtime-home> > install-plan.json
bun scripts/manage-agent-context-broker-installation.mjs install \
  --provider <provider> --runtime-home <runtime-home> \
  --expected-manifest-digest <manifestDigest> --expected-plan-digest <planDigest> --execute
```

Removal keeps unrelated handlers and configuration changes made after the first
installation, and each step keeps its own backups. Between the two steps the
provider has no broker handlers, so hooks fail open and agents run without
current context until step 2 completes; do it in one sitting, and restart the
provider afterwards. A managed target that changed since installation blocks
step 1 — inspect the drift, do not delete `install-state.json` to get past it.

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
