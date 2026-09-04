[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path -Parent $PSScriptRoot

$requiredFiles = @(
    'README.md',
    'LICENSE',
    'LICENSE.md',
    'SECURITY.md',
    'CONTRIBUTING.md',
    'package.json',
    'adapters\CONTRACT.md',
    'fixtures\codex-active.jsonl',
    'fixtures\codex-completed.jsonl',
    'fixtures\codex-malformed.jsonl',
    'fixtures\claude-active.jsonl',
    'examples\candidate-claim-batch.json',
    'examples\agent-handoff-batch.json',
    'examples\fallback-sweep.json',
    'examples\peer-progress-proposal.json',
    'examples\peer-standalone-thread-progress-proposal.json',
    'src\cli.mjs',
    'src\metadata-inventory.mjs',
    'src\codex-inventory.mjs',
    'src\codex-inventory-v2.mjs',
    'src\claude-inventory.mjs',
    'src\reconciliation.mjs',
    'src\content-safety.mjs',
    'src\fallback-sweep.mjs',
    'src\lifecycle-events.mjs',
    'src\lifecycle-consumer.mjs',
    'src\operations.mjs',
    'src\context-refresh.mjs',
    'src\context-router.mjs',
    'src\context-query.mjs',
    'src\peer-progress.mjs',
    'src\event-store.mjs',
    'src\source-attestation.mjs',
    'src\corrections.mjs',
    'src\read-model.mjs',
    'test\codex-inventory.test.mjs',
    'test\claude-inventory.test.mjs',
    'test\reconciliation.test.mjs',
    'test\fallback-sweep.test.mjs',
    'test\lifecycle-consumer.test.mjs',
    'test\operations.test.mjs',
    'test\context-refresh.test.mjs',
    'test\context-router.test.mjs',
    'test\context-query.test.mjs',
    'test\peer-progress.test.mjs',
    'test\event-store.test.mjs',
    'test\source-attestation.test.mjs',
    'test\corrections.test.mjs',
    'test\read-model.test.mjs',
    'scripts\agent-context-broker.ps1',
    'scripts\agent-context.ps1',
    'scripts\cross-thread-provider-proof.mjs',
    'schemas\source-record.schema.json',
    'schemas\context-claim.schema.json',
    'schemas\candidate-claim-batch.schema.json',
    'schemas\context-snapshot.schema.json',
    'schemas\reconciliation-result.schema.json',
    'schemas\source-inventory.schema.json',
    'schemas\context-delta.schema.json',
    'schemas\codex-checkpoint.schema.json',
    'schemas\related-context.schema.json',
    'schemas\manual-context-refresh.schema.json',
    'schemas\context-profile.schema.json',
    'schemas\context-query-result.schema.json',
    'schemas\peer-progress-proposal.schema.json',
    'schemas\broker-event.schema.json',
    'schemas\source-attestation.schema.json',
    'schemas\freshness.schema.json',
    'schemas\correction-proposal.schema.json',
    'schemas\correction-decision.schema.json',
    'schemas\read-model-manifest.schema.json',
    'schemas\read-model-node.schema.json',
    'schemas\read-model-edge.schema.json',
    'profiles\context-profiles.json'
)

foreach ($relativePath in $requiredFiles) {
    $path = Join-Path $packageRoot $relativePath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required package file is missing: $relativePath"
    }
}

$utf8 = [System.Text.UTF8Encoding]::new($false, $true)
$textFiles = Get-ChildItem -LiteralPath $packageRoot -Recurse -File |
    Where-Object { $_.Extension -in @('.md', '.json', '.jsonl', '.mjs', '.ps1') }

foreach ($file in $textFiles) {
    $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
    if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
        throw "UTF-8 BOM is not allowed: $($file.FullName)"
    }

    [void]$utf8.GetString($bytes)
}

Get-ChildItem -LiteralPath (Join-Path $packageRoot 'schemas') -Filter '*.json' -File |
    ForEach-Object {
        $schema = Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json
        if ($schema.'$schema' -ne 'https://json-schema.org/draft/2020-12/schema') {
            throw "Unexpected JSON Schema dialect: $($_.Name)"
        }
    }

$adapterContract = Get-Content -LiteralPath (Join-Path $packageRoot 'adapters\CONTRACT.md') -Raw
foreach ($heading in @('## Read Contract', '## Bootstrap Contract', '## Evidence Contract', '## Manual Refresh Contract', '## Reconciliation Contract', '## Failure Contract')) {
    if (-not $adapterContract.Contains($heading)) {
        throw "Adapter contract heading is missing: $heading"
    }
}

Get-ChildItem -LiteralPath (Join-Path $packageRoot 'src') -Filter '*.mjs' -File |
    ForEach-Object {
        & node --check $_.FullName
        if ($LASTEXITCODE -ne 0) {
            throw "Agent Context Broker syntax validation failed: $($_.Name)"
        }
    }

Get-ChildItem -LiteralPath (Join-Path $packageRoot 'scripts') -Filter '*.ps1' -File |
    ForEach-Object {
        [void][scriptblock]::Create((Get-Content -LiteralPath $_.FullName -Raw))
    }

& node --test (Join-Path $packageRoot 'test\*.test.mjs')
if ($LASTEXITCODE -ne 0) {
    throw 'Agent Context Broker conformance tests failed.'
}

Write-Output "Agent Context Broker package validation passed ($($textFiles.Count) text files)."
