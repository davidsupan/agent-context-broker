[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'inventory', 'related', 'reconcile', 'sweep', 'context-refresh',
        'context-route', 'context-query', 'context-publish', 'progress-publish', 'event-append', 'event-verify',
        'event-repair', 'read-model', 'source-attest', 'source-verify',
        'correction-propose', 'correction-decide', 'migrate-events', 'doctor'
    )]
    [string]$Command,

    [string]$Source,

    [ValidateSet('codex', 'claude-code')]
    [string]$Provider = 'codex',

    [string]$Batch,
    [string]$Event,
    [string]$Attestation,
    [string]$Provenance,
    [string]$Proposal,
    [string]$Decision,
    [string]$Config,
    [string]$RuntimeRoot,
    [string]$EventRuntimeRoot,
    [string]$ReadModelRoot,
    [string]$AttestationRuntimeRoot,
    [string]$Output,
    [string]$Deltas,
    [string]$Checkpoint,
    [string]$LedgerDirectory,
    [string]$AuditDirectory,
    [string]$GlobalAuditDirectory,
    [string]$TicketPackageRoot,
    [string]$TicketPackagesRoot,
    [string]$TicketAuditRoot,
    [string]$ReviewLedgersRoot,
    [string]$ThreadRef,
    [string]$ThreadAuditRoot,
    [string]$Profile,
    [string]$Profiles,
    [string]$TaskKind,
    [string[]]$Query,
    [ValidateSet('global', 'project', 'workstream', 'ticket', 'merge-request')]
    [string]$ScopeKind,
    [string]$ScopeKey,
    [int]$MaxFiles = 20,
    [long]$MaxScanBytes = 16777216,
    [long]$TailBootstrapBytes = 1048576,
    [int]$AfterSequence = 0,
    [int]$MaxLedgerFiles = 100,
    [int]$MinimumIntervalSeconds = 900,
    [int]$MaxDeltas = 10,
    [int]$MaxSnapshots = 3,
    [int]$MaxClaims = 20,
    [int]$MaxValueBytes = 4096,
    [int]$MaxContextBytes = 16384,
    [switch]$Recursive,
    [switch]$IncludeSelf,
    [switch]$ProjectScope,
    [switch]$StrictIsolation,
    [switch]$RequireSourceAttestation,
    [switch]$Execute
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path (Split-Path -Parent $PSScriptRoot) 'src\cli.mjs'
$arguments = @($cli, $Command)

if ($Command -in @('inventory', 'related', 'context-refresh')) {
    if (-not $Source) {
        throw "$Command mode requires Source."
    }
    $arguments += @('--provider', $Provider, '--source', $Source)
}

if ($Command -eq 'reconcile') {
    if (-not $Batch -or -not $RuntimeRoot) {
        throw 'Reconcile mode requires Batch and RuntimeRoot.'
    }
    $arguments += @('--batch', $Batch, '--runtime-root', $RuntimeRoot)
    if ($RequireSourceAttestation) {
        if (-not $AttestationRuntimeRoot) {
            throw 'RequireSourceAttestation requires AttestationRuntimeRoot.'
        }
        $arguments += @(
            '--require-source-attestation',
            '--attestation-runtime-root', $AttestationRuntimeRoot
        )
    }
}

if ($Command -in @('context-publish', 'progress-publish')) {
    if (-not $Proposal -or -not $RuntimeRoot -or -not $EventRuntimeRoot) {
        throw 'Publication requires Proposal, RuntimeRoot, and EventRuntimeRoot.'
    }
    $arguments += @(
        '--provider', $Provider,
        '--proposal', $Proposal,
        '--runtime-root', $RuntimeRoot,
        '--event-runtime-root', $EventRuntimeRoot
    )
    if ($TicketPackagesRoot) {
        $arguments += @('--ticket-packages-root', $TicketPackagesRoot)
    }
    if ($ReviewLedgersRoot) {
        $arguments += @('--review-ledgers-root', $ReviewLedgersRoot)
    }
}

if ($Command -in @('event-append', 'source-attest', 'source-verify', 'correction-propose', 'correction-decide')) {
    $inputName = @{
        'event-append' = 'event'
        'source-attest' = 'attestation'
        'source-verify' = 'provenance'
        'correction-propose' = 'proposal'
        'correction-decide' = 'decision'
    }[$Command]
    $inputValue = @{
        'event-append' = $Event
        'source-attest' = $Attestation
        'source-verify' = $Provenance
        'correction-propose' = $Proposal
        'correction-decide' = $Decision
    }[$Command]
    if (-not $inputValue -or -not $RuntimeRoot) {
        throw "$Command requires $inputName and RuntimeRoot."
    }
    $arguments += @("--$inputName", $inputValue, '--runtime-root', $RuntimeRoot)
}

if ($Command -in @('event-verify', 'event-repair', 'read-model')) {
    if (-not $RuntimeRoot -and -not ($Command -eq 'read-model' -and $StrictIsolation)) {
        throw "$Command requires RuntimeRoot."
    }
    if ($RuntimeRoot) {
        $arguments += @('--runtime-root', $RuntimeRoot)
    }
    if ($Command -eq 'read-model' -and $ReadModelRoot) {
        $arguments += @('--read-model-root', $ReadModelRoot)
    }
    if ($Command -eq 'read-model' -and $StrictIsolation) {
        $arguments += '--strict-isolation'
    }
}

if ($Command -eq 'migrate-events') {
    if (-not $LedgerDirectory -or -not $RuntimeRoot -or -not $EventRuntimeRoot) {
        throw 'Migrate events requires LedgerDirectory, RuntimeRoot, and EventRuntimeRoot.'
    }
    $arguments += @(
        '--ledger-dir', $LedgerDirectory,
        '--runtime-root', $RuntimeRoot,
        '--event-runtime-root', $EventRuntimeRoot
    )
}

if ($Command -eq 'doctor') {
    if (-not $RuntimeRoot) {
        throw 'Doctor requires RuntimeRoot.'
    }
    $arguments += @('--runtime-root', $RuntimeRoot)
    if ($EventRuntimeRoot) {
        $arguments += @('--event-runtime-root', $EventRuntimeRoot)
    }
    if ($ReadModelRoot) {
        $arguments += @('--read-model-root', $ReadModelRoot)
    }
}

if ($Command -eq 'sweep') {
    if (-not $Config -or -not $RuntimeRoot) {
        throw 'Sweep mode requires Config and RuntimeRoot.'
    }
    $arguments += @(
        '--config', $Config,
        '--runtime-root', $RuntimeRoot,
        '--minimum-interval-seconds', $MinimumIntervalSeconds
    )
}

if ($Command -eq 'context-refresh') {
    if (-not $LedgerDirectory -or -not $RuntimeRoot) {
        throw 'Context refresh requires LedgerDirectory and RuntimeRoot.'
    }
    $arguments += @(
        '--ledger-dir', $LedgerDirectory,
        '--runtime-root', $RuntimeRoot,
        '--after-sequence', $AfterSequence,
        '--max-ledger-files', $MaxLedgerFiles,
        '--max-deltas', $MaxDeltas,
        '--max-snapshots', $MaxSnapshots,
        '--max-claims', $MaxClaims,
        '--max-value-bytes', $MaxValueBytes,
        '--max-context-bytes', $MaxContextBytes
    )
    if ($IncludeSelf) {
        $arguments += '--include-self'
    }
    if ($Execute) {
        if (-not $AuditDirectory) {
            throw 'Audited context refresh requires AuditDirectory.'
        }
        $arguments += @('--execute', '--audit-dir', $AuditDirectory)
    }
}

if ($Command -in @('context-route', 'context-query')) {
    $arguments += @('--provider', $Provider)
    if ($Profile) {
        $arguments += @('--profile', $Profile)
    }
    if ($Profiles) {
        $arguments += @('--profiles', $Profiles)
    }
    if ($TaskKind) {
        $arguments += @('--task-kind', $TaskKind)
    }
    foreach ($term in @($Query)) {
        if ($term) {
            $arguments += @('--term', $term)
        }
    }
    if ($ScopeKind) {
        $arguments += @('--scope-kind', $ScopeKind)
    }
    if ($ScopeKey) {
        $arguments += @('--scope-key', $ScopeKey)
    }
    if ($ProjectScope) {
        $arguments += '--project-scope'
    }
    if ($StrictIsolation) {
        $arguments += '--strict-isolation'
    }
}

if ($Command -eq 'context-query') {
    if ($RuntimeRoot) {
        $arguments += @('--runtime-root', $RuntimeRoot)
    }
    if ($EventRuntimeRoot) {
        $arguments += @('--event-runtime-root', $EventRuntimeRoot)
    }
    if ($TicketPackagesRoot) {
        $arguments += @('--ticket-packages-root', $TicketPackagesRoot)
    }
    if ($ReviewLedgersRoot) {
        $arguments += @('--review-ledgers-root', $ReviewLedgersRoot)
    }
    if ($ThreadRef) {
        if (-not $ThreadAuditRoot) {
            throw 'ThreadRef requires ThreadAuditRoot.'
        }
        $arguments += @('--thread-ref', $ThreadRef, '--thread-audit-root', $ThreadAuditRoot)
    }
    if (-not $RuntimeRoot -and -not $StrictIsolation) {
        throw 'Context query requires RuntimeRoot unless StrictIsolation is set.'
    }
    if ($Execute) {
        if (-not $GlobalAuditDirectory) {
            throw 'Audited context query requires GlobalAuditDirectory.'
        }
        $arguments += @('--execute', '--global-audit-dir', $GlobalAuditDirectory)
        if ($TicketPackageRoot) {
            if (-not $TicketPackagesRoot) {
                throw 'TicketPackageRoot requires TicketPackagesRoot.'
            }
            $arguments += @(
                '--ticket-package-root', $TicketPackageRoot,
                '--ticket-packages-root', $TicketPackagesRoot
            )
            if ($TicketAuditRoot) {
                $arguments += @('--ticket-audit-root', $TicketAuditRoot)
            }
        }
    }
}

if ($Command -eq 'related') {
    if (-not $LedgerDirectory) {
        throw 'Related mode requires LedgerDirectory.'
    }
    $arguments += @(
        '--ledger-dir', $LedgerDirectory,
        '--after-sequence', $AfterSequence,
        '--max-ledger-files', $MaxLedgerFiles
    )
    if ($IncludeSelf) {
        $arguments += '--include-self'
    }
} elseif ($Command -eq 'inventory') {
    $arguments += @(
        '--max-files', $MaxFiles,
        '--max-scan-bytes', $MaxScanBytes,
        '--tail-bootstrap-bytes', $TailBootstrapBytes
    )
}

if ($Command -eq 'inventory' -and $Recursive) {
    $arguments += '--recursive'
}

if ($Command -eq 'inventory' -and $Execute) {
    if (-not $Output -or -not $Deltas -or -not $Checkpoint -or -not $LedgerDirectory) {
        throw 'Execute mode requires Output, Deltas, Checkpoint, and LedgerDirectory.'
    }

    $arguments += @(
        '--execute',
        '--output', $Output,
        '--deltas', $Deltas,
        '--checkpoint', $Checkpoint,
        '--ledger-dir', $LedgerDirectory
    )
}

if ($Command -in @(
    'reconcile', 'sweep', 'event-append', 'event-repair', 'read-model',
    'source-attest', 'correction-propose', 'correction-decide', 'migrate-events',
    'context-publish', 'progress-publish'
) -and $Execute) {
    $arguments += '--execute'
}

& node @arguments
if ($LASTEXITCODE -ne 0) {
    throw "Agent Context Broker exited with code $LASTEXITCODE."
}
