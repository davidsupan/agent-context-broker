# Getting started

## Requirements

- Node.js 20 or newer
- PowerShell 7 for the PowerShell launchers
- Codex or Claude Code only when installing a provider bridge
- Windows or Linux; macOS support is tracked separately

No npm dependencies are required.

## Validate the checkout

```powershell
npm run validate
pwsh -NoProfile -File ./scripts/Test-AgentContextBrokerPackage.ps1
```

## Install provider bridges

Installation is plan-only by default. Review the targets and digests, then pass
the exact manifest and plan digests back to the unchanged command to activate
the plan:

```powershell
$plan = ./scripts/Install-AgentContextBroker.ps1 -Provider Both |
  ConvertFrom-Json
$plan | ConvertTo-Json -Depth 20

./scripts/Install-AgentContextBroker.ps1 `
  -Provider Both `
  -ExpectedManifestDigest $plan.manifestDigest `
  -ExpectedPlanDigest $plan.planDigest `
  -Execute
```

The installer copies the broker to `$HOME/.agent-context-broker`, adds only its
own lifecycle handlers to existing Codex and Claude Code configuration, and
stores byte-exact backups outside the installation tree. Restart the installed
providers after activation, review their hook configuration, then inspect the
installation:

```powershell
& (Join-Path $HOME '.agent-context-broker/tool/scripts/Test-AgentContextBrokerInstallation.ps1')
```

Use `-Provider Codex` or `-Provider Claude` to install only one bridge. Override
`-CodexHome`, `-ClaudeHome`, `-InstallRoot`, or `-RuntimeHome` for a non-default
layout.

## Query safely

The high-level launcher chooses a private runtime directory below
`%LOCALAPPDATA%\AgentContextBroker` on Windows or
`${XDG_STATE_HOME:-$HOME/.local/state}/agent-context-broker` on Linux. Commands
plan changes by default.

```powershell
./scripts/agent-context.ps1 `
  -Command query `
  -Provider codex `
  -Profile custom-project `
  -ProjectScope `
  -Query 'context broker','release'
```

Set `AGENT_CONTEXT_BROKER_DEFAULT_PROJECT` when lifecycle hooks should route
otherwise unscoped prompts to one project. Leave it unset to avoid implicit
project routing.

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

Removal is also plan-only. `Remove` deletes managed files and handlers while
preserving unrelated configuration changes made after installation:

```powershell
$uninstaller = Join-Path $HOME '.agent-context-broker/tool/scripts/Uninstall-AgentContextBroker.ps1'
$plan = & $uninstaller -Action Remove | ConvertFrom-Json
& $uninstaller -Action Remove -ExpectedPlanDigest $plan.planDigest -Execute
```

Use `-Action Rollback` instead to restore the complete pre-install state. A
rollback is blocked if any managed target changed after installation, because
silently overwriting that drift would be unsafe. Both operations retain the
backup evidence under the private runtime root.
