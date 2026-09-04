[CmdletBinding()]
param([string]$RuntimeHome)

$ErrorActionPreference = 'Stop'
$toolRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
. (Join-Path $toolRoot 'scripts\Resolve-AgentContextBrokerHome.ps1')
$resolvedRuntimeHome = Resolve-AgentContextBrokerHome -Path $RuntimeHome
$env:AGENT_CONTEXT_BROKER_HOME = $resolvedRuntimeHome
$activationLock = if ($env:AGENT_CONTEXT_BROKER_ACTIVATION_LOCK) {
    $env:AGENT_CONTEXT_BROKER_ACTIVATION_LOCK
}
else {
    Join-Path $resolvedRuntimeHome 'runtime/activation/activation.lock'
}
if (Test-Path -LiteralPath $activationLock -PathType Leaf) {
    Write-Output '{"continue":true}'
    exit 0
}
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\cli.mjs'

try {
    & node $cli
    if ($LASTEXITCODE -ne 0) {
        Write-Output '{"continue":true}'
    }
}
catch {
    Write-Output '{"continue":true}'
}
