[CmdletBinding(PositionalBinding = $false)]
param(
    [ValidateSet('Both', 'Codex', 'Claude')]
    [string]$Provider = 'Both',
    [string]$PackageRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallRoot = (Join-Path $HOME '.agent-context-broker'),
    [string]$CodexHome = (Join-Path $HOME '.codex'),
    [string]$ClaudeHome = (Join-Path $HOME '.claude'),
    [string]$RuntimeHome,
    [string]$ExpectedManifestDigest,
    [string]$ExpectedPlanDigest,
    [switch]$Execute
)

$arguments = @{
    Action = 'Install'
    Provider = $Provider
    PackageRoot = $PackageRoot
    InstallRoot = $InstallRoot
    CodexHome = $CodexHome
    ClaudeHome = $ClaudeHome
}
if ($RuntimeHome) { $arguments.RuntimeHome = $RuntimeHome }
if ($ExpectedManifestDigest) { $arguments.ExpectedManifestDigest = $ExpectedManifestDigest }
if ($ExpectedPlanDigest) { $arguments.ExpectedPlanDigest = $ExpectedPlanDigest }
if ($Execute) { $arguments.Execute = $true }

& (Join-Path $PSScriptRoot 'Manage-AgentContextBrokerInstallation.ps1') @arguments
