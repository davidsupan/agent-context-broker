# Getting started

## Requirements

- Node.js 20 or newer
- PowerShell 7 for the PowerShell launchers
- Codex or Claude Code only when installing a provider bridge

No npm dependencies are required.

## Validate the checkout

```powershell
npm run validate
pwsh -NoProfile -File .\scripts\Test-AgentContextBrokerPackage.ps1
```

## Query safely

The high-level launcher chooses private runtime directories below
`%LOCALAPPDATA%\AgentContextBroker` on Windows. Commands plan changes by
default.

```powershell
.\scripts\agent-context.ps1 `
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

## Enable a provider bridge

Provider bridge packages live under `providers/codex` and
`providers/claude-code`. Integrate the matching bridge with the provider's
lifecycle hook mechanism only after validating the checkout and reviewing the
security model. The bridge fails open for agent availability, while broker data
validation and trust decisions fail closed.
