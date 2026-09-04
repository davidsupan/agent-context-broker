[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)
$packageRoot = Split-Path -Parent $PSScriptRoot
$installer = Join-Path $PSScriptRoot 'Install-AgentContextBroker.ps1'
$uninstaller = Join-Path $PSScriptRoot 'Uninstall-AgentContextBroker.ps1'
$powerShellExecutable = [IO.Path]::GetFullPath((Get-Command pwsh -ErrorAction Stop).Source)
$verifierRelative = 'tool/scripts/Test-AgentContextBrokerInstallation.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('agent-context-broker-installer-' + [guid]::NewGuid().ToString('N'))

function Write-Utf8Text {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, $utf8)
}

function Invoke-InstallPlan {
    param(
        [Parameter(Mandatory)][string]$CaseRoot,
        [Parameter(Mandatory)][ValidateSet('Both', 'Codex', 'Claude')][string]$Provider
    )
    $raw = & $installer -Provider $Provider -PackageRoot $packageRoot `
        -InstallRoot (Join-Path $CaseRoot 'install') `
        -CodexHome (Join-Path $CaseRoot 'codex') `
        -ClaudeHome (Join-Path $CaseRoot 'claude') `
        -RuntimeHome (Join-Path $CaseRoot 'runtime') | Out-String
    return $raw | ConvertFrom-Json -Depth 100
}

function Invoke-Install {
    param(
        [Parameter(Mandatory)][string]$CaseRoot,
        [Parameter(Mandatory)][ValidateSet('Both', 'Codex', 'Claude')][string]$Provider,
        [Parameter(Mandatory)][object]$Plan
    )
    $raw = & $installer -Provider $Provider -PackageRoot $packageRoot `
        -InstallRoot (Join-Path $CaseRoot 'install') `
        -CodexHome (Join-Path $CaseRoot 'codex') `
        -ClaudeHome (Join-Path $CaseRoot 'claude') `
        -RuntimeHome (Join-Path $CaseRoot 'runtime') `
        -ExpectedManifestDigest $Plan.manifestDigest `
        -ExpectedPlanDigest $Plan.planDigest -Execute | Out-String
    return $raw | ConvertFrom-Json -Depth 100
}

function Invoke-UninstallPlan {
    param(
        [Parameter(Mandatory)][string]$CaseRoot,
        [Parameter(Mandatory)][ValidateSet('Remove', 'Rollback')][string]$Action
    )
    $installedUninstaller = Join-Path $CaseRoot 'install/tool/scripts/Uninstall-AgentContextBroker.ps1'
    $uninstallCommand = if (Test-Path -LiteralPath $installedUninstaller) { $installedUninstaller } else { $uninstaller }
    $raw = & $uninstallCommand -Action $Action -PackageRoot $packageRoot `
        -InstallRoot (Join-Path $CaseRoot 'install') `
        -CodexHome (Join-Path $CaseRoot 'codex') `
        -ClaudeHome (Join-Path $CaseRoot 'claude') `
        -RuntimeHome (Join-Path $CaseRoot 'runtime') | Out-String
    return $raw | ConvertFrom-Json -Depth 100
}

function Invoke-Uninstall {
    param(
        [Parameter(Mandatory)][string]$CaseRoot,
        [Parameter(Mandatory)][ValidateSet('Remove', 'Rollback')][string]$Action,
        [Parameter(Mandatory)][object]$Plan
    )
    $installedUninstaller = Join-Path $CaseRoot 'install/tool/scripts/Uninstall-AgentContextBroker.ps1'
    $uninstallCommand = if (Test-Path -LiteralPath $installedUninstaller) { $installedUninstaller } else { $uninstaller }
    $raw = & $uninstallCommand -Action $Action -PackageRoot $packageRoot `
        -InstallRoot (Join-Path $CaseRoot 'install') `
        -CodexHome (Join-Path $CaseRoot 'codex') `
        -ClaudeHome (Join-Path $CaseRoot 'claude') `
        -RuntimeHome (Join-Path $CaseRoot 'runtime') `
        -ExpectedPlanDigest $Plan.planDigest -Execute | Out-String
    return $raw | ConvertFrom-Json -Depth 100
}

try {
    $removeCase = Join-Path $root 'remove'
    $codexHooks = Join-Path $removeCase 'codex/hooks.json'
    $claudeSettings = Join-Path $removeCase 'claude/settings.json'
    Write-Utf8Text $codexHooks '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing-codex-handler"}]}]},"owner":"test"}'
    Write-Utf8Text $claudeSettings '{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"existing-claude-handler"}]}]},"owner":"test"}'

    $installPlan = Invoke-InstallPlan $removeCase Both
    if ($installPlan.writesEnabled -ne $false -or -not $installPlan.manifestDigest -or -not $installPlan.planDigest) {
        throw 'Install planning did not return the required digests.'
    }
    try {
        & $installer -Provider Both -PackageRoot $packageRoot `
            -InstallRoot (Join-Path $removeCase 'install') `
            -CodexHome (Join-Path $removeCase 'codex') `
            -ClaudeHome (Join-Path $removeCase 'claude') `
            -RuntimeHome (Join-Path $removeCase 'runtime') `
            -ExpectedManifestDigest ('0' * 64) `
            -ExpectedPlanDigest $installPlan.planDigest -Execute | Out-Null
        throw 'An incorrect manifest digest was accepted.'
    }
    catch {
        if ($_.Exception.Message -notmatch 'ExpectedManifestDigest mismatch') { throw }
    }
    if (Test-Path -LiteralPath (Join-Path $removeCase 'runtime/install-state.json')) {
        throw 'A rejected install wrote installation state.'
    }
    try {
        & $installer -Provider Both -PackageRoot $packageRoot `
            -InstallRoot (Join-Path $removeCase 'install') `
            -CodexHome (Join-Path $removeCase 'codex') `
            -ClaudeHome (Join-Path $removeCase 'claude') `
            -RuntimeHome (Join-Path $removeCase 'runtime') `
            -ExpectedManifestDigest $installPlan.manifestDigest `
            -ExpectedPlanDigest ('0' * 64) -Execute | Out-Null
        throw 'An incorrect plan digest was accepted.'
    }
    catch {
        if ($_.Exception.Message -notmatch 'ExpectedPlanDigest mismatch') { throw }
    }

    $installResult = Invoke-Install $removeCase Both $installPlan
    if ($installResult.package -ne 'agent-context-broker') {
        throw 'Install result did not identify the package.'
    }
    $verification = & (Join-Path $removeCase "install/$verifierRelative") `
        -RuntimeHome (Join-Path $removeCase 'runtime') | Out-String | ConvertFrom-Json -Depth 100
    if (-not $verification.healthy) {
        throw 'Installed target verification failed.'
    }
    $installedQuery = & (Join-Path $removeCase 'install/scripts/agent-context.ps1') `
        -Command query -Provider codex -StrictIsolation | Out-String | ConvertFrom-Json -Depth 100
    if (-not $installedQuery.strictIsolation -or @($installedQuery.claims).Count -ne 0) {
        throw 'The installed high-level launcher did not resolve the managed tool.'
    }

    $codexDocument = Get-Content -LiteralPath $codexHooks -Raw | ConvertFrom-Json -Depth 100
    $claudeDocument = Get-Content -LiteralPath $claudeSettings -Raw | ConvertFrom-Json -Depth 100
    if ((@($codexDocument.hooks.SessionStart.hooks.command) -notcontains 'existing-codex-handler') -or
        (@($claudeDocument.hooks.SessionStart.hooks.command) -notcontains 'existing-claude-handler')) {
        throw 'Installation did not preserve existing provider handlers.'
    }
    $installedCommands = @($codexDocument.hooks.PSObject.Properties.Value.hooks.command) +
        @($claudeDocument.hooks.PSObject.Properties.Value.hooks.command)
    if (@($installedCommands | Where-Object { $_ -match [regex]::Escape((Join-Path $removeCase 'runtime')) }).Count -ne 6) {
        throw 'Provider handlers did not bind lifecycle writes to the selected runtime home.'
    }
    $previousTranscriptRoots = $env:AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS
    try {
        $env:AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS = Join-Path $packageRoot 'fixtures'
        $hookEvent = [ordered]@{
            session_id = 'synthetic-install-test'
            transcript_path = (Join-Path $packageRoot 'fixtures/codex-active.jsonl')
            hook_event_name = 'SessionStart'
        } | ConvertTo-Json -Compress
        $bridge = Join-Path $removeCase 'install/tool/providers/codex/scripts/Invoke-CodexLifecycleBridge.ps1'
        $bridgeResult = $hookEvent | & pwsh -NoProfile -File $bridge `
            -RuntimeHome (Join-Path $removeCase 'runtime') |
            Out-String | ConvertFrom-Json -Depth 100
        if (-not $bridgeResult.hookSpecificOutput.additionalContext) {
            throw 'Installed Codex lifecycle bridge did not return its bounded advisory.'
        }
        $auditRoot = Join-Path $removeCase 'runtime/runtime/codex-lifecycle/audit'
        if (@(Get-ChildItem -LiteralPath $auditRoot -Filter '*.json' -File).Count -eq 0) {
            throw 'Installed Codex lifecycle bridge did not use the selected runtime home.'
        }
    }
    finally {
        $env:AGENT_CONTEXT_BROKER_CODEX_TRANSCRIPT_ROOTS = $previousTranscriptRoots
    }
    $codexDocument | Add-Member -MemberType NoteProperty -Name afterInstall -Value 'preserve-me'
    Write-Utf8Text $codexHooks (($codexDocument | ConvertTo-Json -Depth 100) + "`n")
    $verificationAfterDrift = & (Join-Path $removeCase "install/$verifierRelative") `
        -RuntimeHome (Join-Path $removeCase 'runtime') | Out-String | ConvertFrom-Json -Depth 100
    if (-not $verificationAfterDrift.healthy) {
        throw 'Verifier treated an unrelated provider configuration change as managed drift.'
    }

    $removePlan = Invoke-UninstallPlan $removeCase Remove
    $removeResult = Invoke-Uninstall $removeCase Remove $removePlan
    if (-not $removeResult.stateRemoved -or (Test-Path -LiteralPath (Join-Path $removeCase 'install/tool'))) {
        throw 'Remove did not delete the managed installation.'
    }
    $removedCodex = Get-Content -LiteralPath $codexHooks -Raw | ConvertFrom-Json -Depth 100
    if ($removedCodex.afterInstall -ne 'preserve-me' -or
        @($removedCodex.hooks.SessionStart.hooks.command) -notcontains 'existing-codex-handler') {
        throw 'Remove did not preserve unrelated provider configuration.'
    }
    if ((Get-Content -LiteralPath $codexHooks -Raw) -match 'Invoke-CodexLifecycleBridge') {
        throw 'Remove left a managed Codex lifecycle handler behind.'
    }

    $rollbackCase = Join-Path $root 'rollback'
    $rollbackHooks = Join-Path $rollbackCase 'codex/hooks.json'
    $originalBytes = [Text.Encoding]::UTF8.GetBytes("{`"hooks`":{},`"marker`":`"original`"}`n")
    [IO.Directory]::CreateDirectory((Split-Path -Parent $rollbackHooks)) | Out-Null
    [IO.File]::WriteAllBytes($rollbackHooks, $originalBytes)
    $rollbackInstallPlan = Invoke-InstallPlan $rollbackCase Codex
    [void](Invoke-Install $rollbackCase Codex $rollbackInstallPlan)
    $rollbackPlan = Invoke-UninstallPlan $rollbackCase Rollback
    [void](Invoke-Uninstall $rollbackCase Rollback $rollbackPlan)
    $restoredBytes = [IO.File]::ReadAllBytes($rollbackHooks)
    if ([Convert]::ToHexString($originalBytes) -ne [Convert]::ToHexString($restoredBytes)) {
        throw 'Rollback did not restore the original provider configuration byte-for-byte.'
    }

    $createdConfigCase = Join-Path $root 'created-config-remove'
    $createdConfigInstallPlan = Invoke-InstallPlan $createdConfigCase Claude
    [void](Invoke-Install $createdConfigCase Claude $createdConfigInstallPlan)
    $createdConfigRemovePlan = Invoke-UninstallPlan $createdConfigCase Remove
    [void](Invoke-Uninstall $createdConfigCase Remove $createdConfigRemovePlan)
    if (Test-Path -LiteralPath (Join-Path $createdConfigCase 'claude/settings.json')) {
        throw 'Remove left a provider configuration file that the installer created from scratch.'
    }

    $conflictCase = Join-Path $root 'unmanaged-handler-conflict'
    $conflictRuntime = Join-Path $conflictCase 'runtime'
    $conflictBridge = Join-Path $conflictCase 'install/tool/providers/codex/scripts/Invoke-CodexLifecycleBridge.ps1'
    $conflictCommand = "`"$powerShellExecutable`" -NoProfile -File `"$conflictBridge`" -RuntimeHome `"$conflictRuntime`""
    $conflictHooks = [ordered]@{
        hooks = [ordered]@{
            SessionStart = @([ordered]@{
                hooks = @([ordered]@{ type = 'command'; command = $conflictCommand })
            })
        }
    }
    Write-Utf8Text (Join-Path $conflictCase 'codex/hooks.json') `
        (($conflictHooks | ConvertTo-Json -Depth 20) + "`n")
    try {
        [void](Invoke-InstallPlan $conflictCase Codex)
        throw 'An unmanaged pre-existing broker handler was adopted.'
    }
    catch {
        if ($_.Exception.Message -notmatch 'already exists') { throw }
    }

    Write-Output 'Agent Context Broker installer tests passed (guarded activation, safe removal, and byte-exact rollback).'
}
finally {
    if (Test-Path -LiteralPath $root) {
        [IO.Directory]::Delete($root, $true)
    }
}
