[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('query', 'route', 'publish', 'progress')]
    [string]$Command,

    [ValidateSet('codex', 'claude-code')]
    [string]$Provider = 'codex',

    [ValidateSet('review', 'build', 'implementation', 'bugfix', 'ticket-qa', 'custom-project', 'strict-isolation')]
    [string]$Profile,

    [string]$TaskKind,
    [string[]]$Query,
    [string]$Proposal,

    [ValidateSet('global', 'project', 'workstream', 'ticket', 'merge-request')]
    [string]$ScopeKind,

    [string]$ScopeKey,
    [string]$TicketPackagesRoot,
    [string]$ReviewLedgersRoot,
    [string]$RuntimeHome,
    [ValidatePattern('^[A-Z][A-Z0-9]{1,15}-\d+$')]
    [string]$IssueKey,
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9._/-]{0,95}!\d{1,12}$')]
    [string]$ReviewKey,
    [switch]$ProjectScope,
    [switch]$StrictIsolation,
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'

$runtimeHomeResolver = @(
    (Join-Path $PSScriptRoot 'Resolve-AgentContextBrokerHome.ps1'),
    (Join-Path $HOME '.agent-context-broker/tool/scripts/Resolve-AgentContextBrokerHome.ps1')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
if (-not $runtimeHomeResolver) {
    throw 'Agent Context Broker runtime-home resolver is missing.'
}
. $runtimeHomeResolver

function Add-ContextLedgerRow {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$JsonLine
    )
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $lockPath = "$Path.lock"
    $deadline = [DateTimeOffset]::UtcNow.AddSeconds(5)
    $lock = $null
    while (-not $lock) {
        try {
            $lock = [IO.File]::Open(
                $lockPath,
                [IO.FileMode]::CreateNew,
                [IO.FileAccess]::Write,
                [IO.FileShare]::None
            )
        }
        catch [IO.IOException] {
            if ((Test-Path -LiteralPath $lockPath -PathType Leaf) -and
                ([DateTimeOffset]::UtcNow -
                    [DateTimeOffset][IO.File]::GetLastWriteTimeUtc($lockPath)).TotalMinutes -gt 10) {
                Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
                continue
            }
            if ([DateTimeOffset]::UtcNow -ge $deadline) {
                throw 'Ticket context ledger is busy.'
            }
            Start-Sleep -Milliseconds 50
        }
    }
    try {
        [IO.File]::AppendAllText($Path, ($JsonLine + "`n"), [Text.UTF8Encoding]::new($false))
    }
    finally {
        $lock.Dispose()
        Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
    }
}

function Resolve-ReviewLedgerDirectory {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Key
    )
    if ($Key -notmatch '!(?<iid>\d{1,12})$') {
        throw "Invalid merge request key: $Key"
    }
    $allowedRoot = [IO.Path]::GetFullPath($Root)
    $directory = [IO.Path]::GetFullPath((Join-Path $allowedRoot "mr-$($Matches.iid)"))
    $prefix = $allowedRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if (-not $directory.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Review ledger directory escaped its configured root.'
    }
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
        throw "Review ledger is missing for $Key."
    }
    return $directory
}

$resolvedRuntimeHome = if ($RuntimeHome) {
    Resolve-AgentContextBrokerHome -Path $RuntimeHome
}
else {
    Resolve-AgentContextBrokerHome
}
$ticketPackagesRoot = if ($TicketPackagesRoot) {
    [IO.Path]::GetFullPath($TicketPackagesRoot)
}
else {
    Join-Path $resolvedRuntimeHome 'tickets'
}
$reviewLedgersRoot = if ($ReviewLedgersRoot) {
    [IO.Path]::GetFullPath($ReviewLedgersRoot)
}
elseif ($env:AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT) {
    [IO.Path]::GetFullPath($env:AGENT_CONTEXT_BROKER_REVIEW_LEDGERS_ROOT)
}
else {
    Join-Path $resolvedRuntimeHome 'runtime/reviews'
}
if ($ReviewKey) {
    Resolve-ReviewLedgerDirectory -Root $reviewLedgersRoot -Key $ReviewKey | Out-Null
}
$toolScript = @(
    (Join-Path $PSScriptRoot 'agent-context-broker.ps1'),
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'tool/scripts/agent-context-broker.ps1'),
    (Join-Path $HOME '.agent-context-broker/tool/scripts/agent-context-broker.ps1')
) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
$runtimeRoot = if ($env:AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME) {
    $env:AGENT_CONTEXT_BROKER_RECONCILIATION_RUNTIME
}
else {
    Join-Path $resolvedRuntimeHome 'runtime/reconciliation'
}
$eventRuntimeRoot = if ($env:AGENT_CONTEXT_BROKER_EVENT_RUNTIME) {
    $env:AGENT_CONTEXT_BROKER_EVENT_RUNTIME
}
else {
    Join-Path $resolvedRuntimeHome 'runtime/events'
}
$auditRoot = Join-Path $resolvedRuntimeHome 'runtime/query-audit'
$ticketAuditRoot = Join-Path $resolvedRuntimeHome 'runtime/ticket-audit'

if (-not (Test-Path -LiteralPath $toolScript -PathType Leaf)) {
    throw "Agent Context Broker launcher is missing: $toolScript"
}

$toolCommand = @{
    query = 'context-query'
    route = 'context-route'
    publish = 'context-publish'
    progress = 'progress-publish'
}[$Command]
$arguments = @{
    Command = $toolCommand
    Provider = $Provider
}
if ($IssueKey -and $ReviewKey) {
    throw 'IssueKey and ReviewKey are mutually exclusive.'
}
if ($Profile) { $arguments.Profile = $Profile }
if ($TaskKind) { $arguments.TaskKind = $TaskKind }
if ($Query) { $arguments.Query = $Query }
if ($ScopeKind) { $arguments.ScopeKind = $ScopeKind }
if ($ScopeKey) { $arguments.ScopeKey = $ScopeKey }
if ($ProjectScope) { $arguments.ProjectScope = $true }
if ($StrictIsolation) { $arguments.StrictIsolation = $true }

if ($Command -in @('publish', 'progress')) {
    if (-not $Proposal) {
        throw 'Context publication requires Proposal.'
    }
    if ($StrictIsolation) {
        throw 'Context publication is unavailable in strict isolation.'
    }
    $arguments.Proposal = $Proposal
    $arguments.RuntimeRoot = $runtimeRoot
    $arguments.EventRuntimeRoot = $eventRuntimeRoot
    $arguments.TicketPackagesRoot = $ticketPackagesRoot
    $arguments.ReviewLedgersRoot = $reviewLedgersRoot
    if ($Execute) { $arguments.Execute = $true }
}

if ($Command -eq 'query' -and -not $StrictIsolation) {
    $arguments.RuntimeRoot = $runtimeRoot
    $arguments.EventRuntimeRoot = $eventRuntimeRoot
    $arguments.TicketPackagesRoot = $ticketPackagesRoot
    $arguments.ReviewLedgersRoot = $reviewLedgersRoot
    if (-not $ScopeKind) {
        $arguments.ScopeKind = if ($IssueKey) { 'ticket' } elseif ($ReviewKey) { 'merge-request' } else { 'project' }
    }
    if (-not $ScopeKey) {
        $arguments.ScopeKey = if ($IssueKey) {
            $IssueKey
        }
        elseif ($ReviewKey) {
            $ReviewKey
        }
        elseif ($env:AGENT_CONTEXT_BROKER_DEFAULT_PROJECT) {
            $env:AGENT_CONTEXT_BROKER_DEFAULT_PROJECT
        }
        else {
            'default-project'
        }
    }
}
if ($Command -eq 'query' -and $Execute) {
    $arguments.Execute = $true
    $arguments.GlobalAuditDirectory = $auditRoot
    if ($IssueKey) {
        $ticketRoot = Join-Path $ticketPackagesRoot $IssueKey
        if (-not (Test-Path -LiteralPath (Join-Path $ticketRoot 'README.md') -PathType Leaf)) {
            throw "Ticket package is missing for audited context query: $IssueKey"
        }
        $arguments.TicketPackageRoot = $ticketRoot
        $arguments.TicketPackagesRoot = $ticketPackagesRoot
        $arguments.TicketAuditRoot = $ticketAuditRoot
    }
}

if ($Command -in @('publish', 'progress')) {
    $proposalPayload = Get-Content -LiteralPath $Proposal -Raw | ConvertFrom-Json -Depth 100
    $ticketRoot = $null
    $reviewRoot = $null
    if ($proposalPayload.scope.kind -eq 'ticket') {
        if ($proposalPayload.scope.key -notmatch '^[A-Z][A-Z0-9]{1,15}-\d+$') {
            throw 'Ticket-scoped context publication requires a valid issue key.'
        }
        if ($Execute) {
            $ticketRoot = Join-Path $ticketPackagesRoot $proposalPayload.scope.key
            if (-not (Test-Path -LiteralPath (Join-Path $ticketRoot 'README.md') -PathType Leaf)) {
                throw "Ticket package is missing for context publication: $($proposalPayload.scope.key)"
            }
        }
    }
    elseif ($proposalPayload.scope.kind -eq 'merge-request' -and $Execute) {
        $reviewRoot = Resolve-ReviewLedgerDirectory `
            -Root $reviewLedgersRoot `
            -Key $proposalPayload.scope.key
    }
    $rawResult = (& $toolScript @arguments | Out-String)
    if ($LASTEXITCODE -ne 0) {
        throw "Agent Context Broker launcher exited with code $LASTEXITCODE."
    }
    $result = $rawResult | ConvertFrom-Json -Depth 100
    if ($Execute -and ($ticketRoot -or $reviewRoot)) {
        $scopeKey = $proposalPayload.scope.key
        $row = [ordered]@{
            schemaVersion = 1
            recordedAt = [DateTimeOffset]::UtcNow.ToString('o')
            operation = if ($Command -eq 'progress') { 'peer-progress-publish' } else { 'context-publish' }
            scopeKind = $proposalPayload.scope.kind
            scopeKey = $scopeKey
            issueKey = if ($ticketRoot) { $scopeKey } else { $null }
            reviewKey = if ($reviewRoot) { $scopeKey } else { $null }
            provider = $Provider
            proposalIdHash = if ($result.proposalIdHash) { $result.proposalIdHash } else { $null }
            sourceTokenHash = if ($result.sourceTokenHash) { $result.sourceTokenHash } else { $null }
            snapshotHash = if ($result.snapshotHash) { $result.snapshotHash } else { $null }
            snapshotVersion = if ($result.snapshotVersion) { $result.snapshotVersion } else { $null }
            acceptedClaimCount = if ($null -ne $result.acceptedClaimCount) { $result.acceptedClaimCount } else { $null }
            progressId = if ($result.progressId) { $result.progressId } else { $null }
            progressState = if ($Command -eq 'progress') { $result.state } else { $null }
            progressStage = if ($Command -eq 'progress') { $result.stage } else { $null }
            expiresAt = if ($Command -eq 'progress') { $result.expiresAt } else { $null }
            result = if ($Command -eq 'progress') { 'published' } else { $result.state }
            issueCodes = @($result.issues | ForEach-Object { $_.code })
        }
        $ledgerPath = if ($ticketRoot) {
            Join-Path $ticketAuditRoot "$scopeKey\CONTEXT_LEDGER.jsonl"
        }
        else {
            Join-Path $reviewRoot 'CONTEXT_LEDGER.jsonl'
        }
        Add-ContextLedgerRow -Path $ledgerPath `
            -JsonLine ($row | ConvertTo-Json -Compress -Depth 20)
    }
    $result | ConvertTo-Json -Depth 100
    exit 0
}

& $toolScript @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Agent Context Broker launcher exited with code $LASTEXITCODE."
}
