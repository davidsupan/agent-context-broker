[CmdletBinding()]
param([string]$RuntimeHome)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Resolve-AgentContextBrokerHome.ps1')

$RuntimeHome = Resolve-AgentContextBrokerHome -Path $RuntimeHome
$statePath = Join-Path $RuntimeHome 'install-state.json'
if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "No installation state was found at $statePath."
}

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-DirectoryDigest {
    param([Parameter(Mandatory)][string]$Path)
    $utf8 = [Text.UTF8Encoding]::new($false)
    $root = [IO.Path]::GetFullPath($Path)
    $manifest = @(
        Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object FullName | ForEach-Object {
            [ordered]@{
                path = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
                sha256 = Get-Sha256 $_.FullName
            }
        }
    )
    $json = ($manifest | ConvertTo-Json -Compress -Depth 20).Replace("`r`n", "`n") + "`n"
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($utf8.GetBytes($json))).ToLowerInvariant()
}

$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 100
$targets = @(
    foreach ($target in @($state.targets)) {
        $present = if ($target.kind -eq 'directory') {
            Test-Path -LiteralPath $target.path -PathType Container
        }
        else {
            Test-Path -LiteralPath $target.path -PathType Leaf
        }
        $actual = if (-not $present) {
            $null
        }
        elseif ($target.kind -eq 'directory') {
            Get-DirectoryDigest $target.path
        }
        else {
            Get-Sha256 $target.path
        }
        $matches = if (-not $present) {
            $false
        }
        elseif ($target.kind -eq 'config') {
            $document = Get-Content -LiteralPath $target.path -Raw | ConvertFrom-Json -Depth 100
            $eventMatches = @(
                foreach ($eventName in @($target.events)) {
                    $commands = @(
                        $eventNames = @($document.hooks.PSObject.Properties | ForEach-Object Name)
                        if ($eventNames -contains $eventName) {
                            foreach ($group in @($document.hooks.$eventName)) {
                                foreach ($handler in @($group.hooks)) {
                                    if ($handler.command -eq $target.command) { $handler.command }
                                }
                            }
                        }
                    )
                    $commands.Count -eq 1
                }
            )
            $eventMatches.Count -eq @($target.events).Count -and
                @($eventMatches | Where-Object { -not $_ }).Count -eq 0
        }
        else {
            $actual -eq $target.proposedSha256
        }
        [ordered]@{
            name = [string]$target.name
            present = $present
            expectedSha256 = [string]$target.proposedSha256
            actualSha256 = $actual
            matches = $matches
        }
    }
)

[ordered]@{
    schemaVersion = 1
    package = 'agent-context-broker'
    version = [string]$state.version
    installedAt = [string]$state.installedAt
    runtimeHome = $RuntimeHome
    healthy = @($targets | Where-Object { -not $_.matches }).Count -eq 0
    targets = $targets
} | ConvertTo-Json -Depth 20
