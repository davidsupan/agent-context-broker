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
