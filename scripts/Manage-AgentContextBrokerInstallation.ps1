[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(Mandatory)]
    [ValidateSet('Install', 'Remove', 'Rollback')]
    [string]$Action,

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

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$utf8 = [Text.UTF8Encoding]::new($false)

if ($PSVersionTable.PSVersion.Major -lt 7) {
    throw 'Agent Context Broker installation requires PowerShell 7 or newer.'
}
if ($Action -eq 'Install' -and -not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Agent Context Broker installation requires Node.js on PATH.'
}
$powerShellExecutable = [IO.Path]::GetFullPath((Get-Command pwsh -ErrorAction Stop).Source)

. (Join-Path $PSScriptRoot 'Resolve-AgentContextBrokerHome.ps1')

$PackageRoot = [IO.Path]::GetFullPath($PackageRoot)
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$CodexHome = [IO.Path]::GetFullPath($CodexHome)
$ClaudeHome = [IO.Path]::GetFullPath($ClaudeHome)
$RuntimeHome = Resolve-AgentContextBrokerHome -Path $RuntimeHome
foreach ($path in @($PackageRoot, $InstallRoot, $CodexHome, $ClaudeHome, $RuntimeHome)) {
    if ($path -match '["\r\n]') {
        throw 'Installation paths must not contain quotes or line breaks.'
    }
}
if ($powerShellExecutable -match '["\r\n]') {
    throw 'The PowerShell executable path must not contain quotes or line breaks.'
}
$statePath = Join-Path $RuntimeHome 'install-state.json'
$activationLock = Join-Path $RuntimeHome 'runtime/activation/activation.lock'
$comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
$sourceRootPrefix = $PackageRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
$installToolPath = [IO.Path]::GetFullPath((Join-Path $InstallRoot 'tool'))
$installToolPrefix = $installToolPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
if ($Action -eq 'Install' -and ($PackageRoot.Equals($installToolPath, $comparison) -or
    $installToolPath.StartsWith($sourceRootPrefix, $comparison) -or
    $PackageRoot.StartsWith($installToolPrefix, $comparison))) {
    throw 'PackageRoot and the managed tool destination must not overlap.'
}
$payloadDirectories = @('adapters', 'examples', 'fixtures', 'profiles', 'providers', 'schemas', 'src', 'test')
$payloadFiles = @(
    'package.json',
    'scripts/agent-context-broker.ps1',
    'scripts/agent-context.ps1',
    'scripts/Install-AgentContextBroker.ps1',
    'scripts/Manage-AgentContextBrokerInstallation.ps1',
    'scripts/Resolve-AgentContextBrokerHome.ps1',
    'scripts/Test-AgentContextBrokerInstallation.ps1',
    'scripts/Uninstall-AgentContextBroker.ps1'
)

function Get-Sha256 {
    param([Parameter(Mandatory)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-TextSha256 {
    param([Parameter(Mandatory)][string]$Text)
    return [Convert]::ToHexString(
        [Security.Cryptography.SHA256]::HashData($utf8.GetBytes($Text))
    ).ToLowerInvariant()
}

function ConvertTo-StableJson {
    param([Parameter(Mandatory)][object]$Value, [switch]$Compress)
    $json = if ($Compress) {
        $Value | ConvertTo-Json -Compress -Depth 100
    }
    else {
        $Value | ConvertTo-Json -Depth 100
    }
    return $json.Replace("`r`n", "`n") + "`n"
}

function Get-DirectoryManifest {
    param([Parameter(Mandatory)][string]$Path)
    $root = [IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Directory is missing: $root"
    }
    return @(
        Get-ChildItem -LiteralPath $root -File -Recurse | Sort-Object FullName | ForEach-Object {
            if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are not supported: $($_.FullName)"
            }
            [ordered]@{
                path = [IO.Path]::GetRelativePath($root, $_.FullName).Replace('\', '/')
                sha256 = Get-Sha256 $_.FullName
            }
        }
    )
}

function Get-DirectoryDigest {
    param([Parameter(Mandatory)][string]$Path)
    return Get-TextSha256 (ConvertTo-StableJson (Get-DirectoryManifest $Path) -Compress)
}

function Get-PayloadManifest {
    param([Parameter(Mandatory)][string]$Root)
    $rootPath = [IO.Path]::GetFullPath($Root)
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($directory in $payloadDirectories) {
        $directoryPath = Join-Path $rootPath $directory
        if (-not (Test-Path -LiteralPath $directoryPath -PathType Container)) {
            throw "Payload directory is missing: $directory"
        }
        foreach ($file in Get-ChildItem -LiteralPath $directoryPath -File -Recurse) {
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "Reparse points are not supported: $($file.FullName)"
            }
            $paths.Add([IO.Path]::GetRelativePath($rootPath, $file.FullName).Replace('\', '/'))
        }
    }
    foreach ($relativePath in $payloadFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $rootPath $relativePath) -PathType Leaf)) {
            throw "Payload file is missing: $relativePath"
        }
        $paths.Add($relativePath.Replace('\', '/'))
    }
    return @(
        $paths | Sort-Object -Unique | ForEach-Object {
            $path = Join-Path $rootPath $_
            [ordered]@{ path = $_; sha256 = Get-Sha256 $path }
        }
    )
}

function Copy-PayloadExact {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][object[]]$Manifest
    )
    if (Test-Path -LiteralPath $Destination) {
        [IO.Directory]::Delete($Destination, $true)
    }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($entry in $Manifest) {
        $sourcePath = Join-Path $Source $entry.path
        $targetPath = Join-Path $Destination $entry.path
        [IO.Directory]::CreateDirectory((Split-Path -Parent $targetPath)) | Out-Null
        [IO.File]::Copy($sourcePath, $targetPath, $true)
    }
}

function Copy-DirectoryExact {
    param(
        [Parameter(Mandatory)][string]$Source,
        [Parameter(Mandatory)][string]$Destination
    )
    if (Test-Path -LiteralPath $Destination) {
        [IO.Directory]::Delete($Destination, $true)
    }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    $sourceRoot = [IO.Path]::GetFullPath($Source)
    foreach ($file in Get-ChildItem -LiteralPath $sourceRoot -File -Recurse) {
        $relative = [IO.Path]::GetRelativePath($sourceRoot, $file.FullName)
        $target = Join-Path $Destination $relative
        [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
        [IO.File]::Copy($file.FullName, $target, $true)
    }
}

function Write-AtomicText {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Text)
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::WriteAllText($temporary, $Text, $utf8)
        [IO.File]::Move($temporary, $Path, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            [IO.File]::Delete($temporary)
        }
    }
}

function Write-AtomicCopy {
    param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string]$Source)
    $parent = Split-Path -Parent $Path
    [IO.Directory]::CreateDirectory($parent) | Out-Null
    $temporary = Join-Path $parent ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
        [IO.File]::Copy($Source, $temporary, $true)
        [IO.File]::Move($temporary, $Path, $true)
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            [IO.File]::Delete($temporary)
        }
    }
}

function Get-JsonDocument {
    param([Parameter(Mandatory)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return [pscustomobject]@{ hooks = [pscustomobject]@{} }
    }
    $document = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -Depth 100
    if (-not ($document.PSObject.Properties.Name -contains 'hooks')) {
        $document | Add-Member -MemberType NoteProperty -Name hooks -Value ([pscustomobject]@{})
    }
    return $document
}

function Add-LifecycleHandler {
    param(
        [Parameter(Mandatory)][object]$Document,
        [Parameter(Mandatory)][string]$EventName,
        [Parameter(Mandatory)][string]$Command,
        [string]$Matcher,
        [Parameter(Mandatory)][int]$Timeout,
        [Parameter(Mandatory)][string]$StatusMessage,
        [switch]$LimitContext
    )
    $eventNames = @($Document.hooks.PSObject.Properties | ForEach-Object Name)
    $groups = if ($eventNames -contains $EventName) { @($Document.hooks.$EventName) } else { @() }
    $matches = @(
        foreach ($group in $groups) {
            foreach ($handler in @($group.hooks)) {
                if ($handler.command -eq $Command) { $handler }
            }
        }
    )
    if ($matches.Count -gt 1) {
        throw "Duplicate Agent Context Broker handlers found for $EventName."
    }
    if ($matches.Count -eq 1) {
        throw "An Agent Context Broker handler already exists for $EventName without installation state."
    }
    $handler = [ordered]@{
        type = 'command'
        command = $Command
        timeout = $Timeout
        statusMessage = $StatusMessage
    }
    if ($LimitContext) {
        $handler.additionalContextLimit = 500
    }
    $compatibleGroups = @(
        foreach ($existingGroup in $groups) {
            $hasMatcher = $existingGroup.PSObject.Properties.Name -contains 'matcher'
            if ($Matcher) {
                if ($hasMatcher -and [string]$existingGroup.matcher -eq $Matcher) { $existingGroup }
            }
            elseif (-not $hasMatcher -or [string]::IsNullOrWhiteSpace([string]$existingGroup.matcher)) {
                $existingGroup
            }
        }
    )
    if ($compatibleGroups.Count -gt 1) {
        throw "Multiple compatible hook groups found for $EventName."
    }
    if ($compatibleGroups.Count -eq 1) {
        $compatibleGroups[0].hooks = @($compatibleGroups[0].hooks) + @([pscustomobject]$handler)
        return
    }
    $group = if ($Matcher) {
        [ordered]@{ matcher = $Matcher; hooks = @([pscustomobject]$handler) }
    }
    else {
        [ordered]@{ hooks = @([pscustomobject]$handler) }
    }
    if ($eventNames -contains $EventName) {
        $Document.hooks.$EventName = @($groups) + @([pscustomobject]$group)
    }
    else {
        $Document.hooks | Add-Member -MemberType NoteProperty -Name $EventName -Value @([pscustomobject]$group)
    }
}

function Remove-LifecycleHandler {
    param(
        [Parameter(Mandatory)][object]$Document,
        [Parameter(Mandatory)][string]$EventName,
        [Parameter(Mandatory)][string]$Command
    )
    $eventNames = @($Document.hooks.PSObject.Properties | ForEach-Object Name)
    if (-not ($eventNames -contains $EventName)) {
        return 0
    }
    $removed = 0
    $remainingGroups = [Collections.Generic.List[object]]::new()
    foreach ($group in @($Document.hooks.$EventName)) {
        $remainingHandlers = @(
            foreach ($handler in @($group.hooks)) {
                if ($handler.command -eq $Command) { $removed++ } else { $handler }
            }
        )
        if ($remainingHandlers.Count -gt 0) {
            $group.hooks = $remainingHandlers
            $remainingGroups.Add($group)
        }
    }
    if ($remainingGroups.Count -eq 0) {
        $Document.hooks.PSObject.Properties.Remove($EventName)
    }
    else {
        $Document.hooks.$EventName = @($remainingGroups)
    }
    return $removed
}

function Get-TargetState {
    param([Parameter(Mandatory)][object]$Target)
    $present = if ($Target.kind -eq 'directory') {
        Test-Path -LiteralPath $Target.path -PathType Container
    }
    else {
        Test-Path -LiteralPath $Target.path -PathType Leaf
    }
    $hash = if (-not $present) {
        $null
    }
    elseif ($Target.kind -eq 'directory') {
        Get-DirectoryDigest $Target.path
    }
    else {
        Get-Sha256 $Target.path
    }
    return [ordered]@{ state = if ($present) { 'present' } else { 'absent' }; sha256 = $hash }
}

function Get-InstallTargets {
    param([Parameter(Mandatory)][object[]]$PayloadManifest)
    $targets = [Collections.Generic.List[object]]::new()
    $targets.Add([pscustomobject]@{
        name = 'tool'; kind = 'directory'; path = (Join-Path $InstallRoot 'tool')
        source = $PackageRoot; payloadManifest = $PayloadManifest
    })
    foreach ($target in @(
        @{ name = 'shared-launcher'; path = (Join-Path $InstallRoot 'scripts/agent-context.ps1'); source = (Join-Path $PackageRoot 'scripts/agent-context.ps1') },
        @{ name = 'shared-resolver'; path = (Join-Path $InstallRoot 'scripts/Resolve-AgentContextBrokerHome.ps1'); source = (Join-Path $PackageRoot 'scripts/Resolve-AgentContextBrokerHome.ps1') }
    )) {
        $targets.Add([pscustomobject]@{ name = $target.name; kind = 'file'; path = $target.path; source = $target.source })
    }
    return @($targets)
}

function Get-ConfigTargets {
    $targets = [Collections.Generic.List[object]]::new()
    if ($Provider -in @('Both', 'Codex')) {
        $path = Join-Path $CodexHome 'hooks.json'
        $command = "`"$powerShellExecutable`" -NoProfile -File `"$(Join-Path $InstallRoot 'tool/providers/codex/scripts/Invoke-CodexLifecycleBridge.ps1')`" -RuntimeHome `"$RuntimeHome`""
        $document = Get-JsonDocument $path
        Add-LifecycleHandler $document SessionStart $command 'startup|resume|clear|compact' 15 'Checking reconciled context' -LimitContext
        Add-LifecycleHandler $document UserPromptSubmit $command $null 15 'Refreshing reconciled context' -LimitContext
        Add-LifecycleHandler $document Stop $command $null 10 'Recording context progress'
        $targets.Add([pscustomobject]@{
            name = 'codex-hooks'; kind = 'config'; path = $path; command = $command
            events = @('SessionStart', 'UserPromptSubmit', 'Stop')
            proposedText = ConvertTo-StableJson $document
        })
    }
    if ($Provider -in @('Both', 'Claude')) {
        $path = Join-Path $ClaudeHome 'settings.json'
        $command = "`"$powerShellExecutable`" -NoProfile -File `"$(Join-Path $InstallRoot 'tool/providers/claude-code/scripts/Invoke-ClaudeLifecycleBridge.ps1')`" -RuntimeHome `"$RuntimeHome`""
        $document = Get-JsonDocument $path
        Add-LifecycleHandler $document SessionStart $command 'startup|resume|clear|compact|fork' 15 'Checking reconciled context'
        Add-LifecycleHandler $document UserPromptSubmit $command $null 15 'Refreshing reconciled context'
        Add-LifecycleHandler $document SessionEnd $command $null 10 'Recording context progress'
        $targets.Add([pscustomobject]@{
            name = 'claude-settings'; kind = 'config'; path = $path; command = $command
            events = @('SessionStart', 'UserPromptSubmit', 'SessionEnd')
            proposedText = ConvertTo-StableJson $document
        })
    }
    return @($targets)
}

function Backup-Target {
    param([Parameter(Mandatory)][object]$Target, [Parameter(Mandatory)][string]$BackupRoot)
    $state = Get-TargetState $Target
    if ($state.state -eq 'absent') {
        return $state
    }
    if ($Target.kind -eq 'directory') {
        Copy-DirectoryExact $Target.path (Join-Path $BackupRoot $Target.name)
    }
    else {
        [IO.Directory]::CreateDirectory($BackupRoot) | Out-Null
        [IO.File]::Copy($Target.path, (Join-Path $BackupRoot "$($Target.name).file"), $true)
    }
    return $state
}

function Get-PlanDigest {
    param([Parameter(Mandatory)][object]$Plan)
    return Get-TextSha256 (ConvertTo-StableJson $Plan -Compress)
}

function Assert-ExpectedDigest {
    param([Parameter(Mandatory)][string]$Name, [string]$Expected, [Parameter(Mandatory)][string]$Actual)
    if (-not $Expected) {
        throw "$Name is required with -Execute. Run the same command without -Execute first."
    }
    if ($Expected -ne $Actual) {
        throw "$Name mismatch. Re-run the plan and review the changed inputs."
    }
}

function Open-ActivationLock {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $activationLock)) | Out-Null
    try {
        return [IO.File]::Open($activationLock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    }
    catch [IO.IOException] {
        throw "Another installation operation is active: $activationLock"
    }
}

if ($Action -eq 'Install') {
    if (Test-Path -LiteralPath $statePath -PathType Leaf) {
        throw 'An installation is already recorded. Remove or roll it back before installing again.'
    }
    $payloadManifest = Get-PayloadManifest $PackageRoot
    $manifestDigest = Get-TextSha256 (ConvertTo-StableJson $payloadManifest -Compress)
    $version = [string](Get-Content -LiteralPath (Join-Path $PackageRoot 'package.json') -Raw | ConvertFrom-Json).version
    $targets = @(Get-InstallTargets $payloadManifest) + @(Get-ConfigTargets)
    $targetPlan = @(
        foreach ($target in $targets) {
            $current = Get-TargetState $target
            $proposedHash = if ($target.kind -eq 'directory') {
                $manifestDigest
            }
            elseif ($target.kind -eq 'file') {
                Get-Sha256 $target.source
            }
            else {
                Get-TextSha256 $target.proposedText
            }
            [ordered]@{
                name = $target.name; kind = $target.kind; path = $target.path
                baseState = $current.state; baseSha256 = $current.sha256
                proposedSha256 = $proposedHash
            }
        }
    )
    $plan = [ordered]@{
        action = 'Install'; version = $version; provider = $Provider.ToLowerInvariant()
        manifestDigest = $manifestDigest; targets = $targetPlan
    }
    $planDigest = Get-PlanDigest $plan
    if (-not $Execute) {
        $plan.writesEnabled = $false
        $plan.planDigest = $planDigest
        $plan.execution = [ordered]@{
            expectedManifestDigest = $manifestDigest
            expectedPlanDigest = $planDigest
        }
        $plan | ConvertTo-Json -Depth 30
        exit 0
    }
    Assert-ExpectedDigest 'ExpectedManifestDigest' $ExpectedManifestDigest $manifestDigest
    Assert-ExpectedDigest 'ExpectedPlanDigest' $ExpectedPlanDigest $planDigest

    $backupRoot = Join-Path $RuntimeHome ('backups/' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    $lockStream = Open-ActivationLock
    $written = [Collections.Generic.List[object]]::new()
    try {
        foreach ($target in $targets) {
            $planned = $targetPlan | Where-Object name -eq $target.name
            $current = Get-TargetState $target
            if ($current.state -ne $planned.baseState -or $current.sha256 -ne $planned.baseSha256) {
                throw "Installation target state changed after planning: $($target.name)"
            }
        }
        $records = @(
            foreach ($target in $targets) {
                $base = Backup-Target $target $backupRoot
                $planned = $targetPlan | Where-Object name -eq $target.name
                [ordered]@{
                    name = $target.name; kind = $target.kind; path = $target.path
                    baseState = $base.state; baseSha256 = $base.sha256
                    proposedSha256 = $planned.proposedSha256
                    command = if ($target.kind -eq 'config') { $target.command } else { $null }
                    events = if ($target.kind -eq 'config') { @($target.events) } else { @() }
                }
            }
        )
        foreach ($target in $targets) {
            $written.Add($target)
            if ($target.kind -eq 'directory') {
                Copy-PayloadExact $target.source $target.path $payloadManifest
            }
            elseif ($target.kind -eq 'file') {
                Write-AtomicCopy $target.path $target.source
            }
            else {
                Write-AtomicText $target.path $target.proposedText
            }
            $expected = ($records | Where-Object name -eq $target.name).proposedSha256
            if ((Get-TargetState $target).sha256 -ne $expected) {
                throw "Post-write verification failed: $($target.name)"
            }
        }
        $state = [ordered]@{
            schemaVersion = 1; package = 'agent-context-broker'; version = $version
            provider = $Provider.ToLowerInvariant(); installedAt = [DateTimeOffset]::UtcNow.ToString('o')
            installRoot = $InstallRoot; runtimeHome = $RuntimeHome
            manifestDigest = $manifestDigest; planDigest = $planDigest
            backupDirectory = $backupRoot; targets = $records
        }
        Write-AtomicText $statePath (ConvertTo-StableJson $state)
    }
    catch {
        $failure = $_
        for ($index = $written.Count - 1; $index -ge 0; $index--) {
            $target = $written[$index]
            $record = $targetPlan | Where-Object name -eq $target.name
            if ($record.baseState -eq 'absent') {
                if ($target.kind -eq 'directory' -and (Test-Path -LiteralPath $target.path)) {
                    [IO.Directory]::Delete($target.path, $true)
                }
                elseif ($target.kind -ne 'directory' -and (Test-Path -LiteralPath $target.path)) {
                    [IO.File]::Delete($target.path)
                }
            }
            elseif ($target.kind -eq 'directory') {
                Copy-DirectoryExact (Join-Path $backupRoot $target.name) $target.path
            }
            else {
                Write-AtomicCopy $target.path (Join-Path $backupRoot "$($target.name).file")
            }
        }
        throw $failure
    }
    finally {
        $lockStream.Dispose()
        if (Test-Path -LiteralPath $activationLock) { [IO.File]::Delete($activationLock) }
    }
    Get-Content -LiteralPath $statePath -Raw
    exit 0
}

if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    throw "No installation state was found at $statePath."
}
$stateDigest = Get-Sha256 $statePath
$state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -Depth 100
$stateTargets = @($state.targets)
$targetPlan = @(
    foreach ($target in $stateTargets) {
        $current = Get-TargetState $target
        [ordered]@{
            name = $target.name; kind = $target.kind; path = $target.path
            currentState = $current.state; currentSha256 = $current.sha256
            installedSha256 = $target.proposedSha256; baseState = $target.baseState
        }
    }
)
$plan = [ordered]@{
    action = $Action; version = [string]$state.version; provider = [string]$state.provider
    stateDigest = $stateDigest; targets = $targetPlan
}
$planDigest = Get-PlanDigest $plan
if (-not $Execute) {
    $plan.writesEnabled = $false
    $plan.planDigest = $planDigest
    $plan.execution = [ordered]@{ expectedPlanDigest = $planDigest }
    $plan | ConvertTo-Json -Depth 30
    exit 0
}
Assert-ExpectedDigest 'ExpectedPlanDigest' $ExpectedPlanDigest $planDigest

if ($Action -eq 'Rollback') {
    foreach ($target in $stateTargets) {
        $current = Get-TargetState $target
        if ($current.state -ne 'present' -or $current.sha256 -ne $target.proposedSha256) {
            throw "Rollback blocked because the installed target changed: $($target.name)"
        }
    }
}
else {
    foreach ($target in $stateTargets | Where-Object kind -ne 'config') {
        $current = Get-TargetState $target
        if ($current.state -eq 'present' -and $current.sha256 -ne $target.proposedSha256) {
            throw "Removal blocked because the installed target changed: $($target.name)"
        }
    }
    foreach ($target in $stateTargets | Where-Object kind -eq 'config') {
        $current = Get-TargetState $target
        if ($current.state -eq 'absent') { continue }
        if ($target.baseState -eq 'absent' -and $current.sha256 -eq $target.proposedSha256) { continue }
        $document = Get-JsonDocument $target.path
        foreach ($eventName in @($target.events)) {
            $eventNames = @($document.hooks.PSObject.Properties | ForEach-Object Name)
            $matches = @(
                if ($eventNames -contains $eventName) {
                    foreach ($group in @($document.hooks.$eventName)) {
                        foreach ($handler in @($group.hooks)) {
                            if ($handler.command -eq $target.command) { $handler }
                        }
                    }
                }
            )
            if ($matches.Count -ne 1) {
                throw "Removal blocked because the installed handler changed: $($target.name)/$eventName"
            }
        }
    }
}

$lockStream = Open-ActivationLock
$operationBackupRoot = Join-Path $RuntimeHome (
    'operation-backups/' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '-' + $Action.ToLowerInvariant()
)
$currentRecords = @()
try {
    $currentRecords = @(
        foreach ($target in $stateTargets) {
            $current = Backup-Target $target $operationBackupRoot
            [ordered]@{ name = $target.name; kind = $target.kind; path = $target.path; state = $current.state }
        }
    )
    $reverseTargets = [object[]]$stateTargets.Clone()
    [array]::Reverse($reverseTargets)
    foreach ($target in $reverseTargets) {
        if ($target.kind -eq 'config' -and $Action -eq 'Remove') {
            if (-not (Test-Path -LiteralPath $target.path -PathType Leaf)) { continue }
            $current = Get-TargetState $target
            if ($target.baseState -eq 'absent' -and $current.sha256 -eq $target.proposedSha256) {
                [IO.File]::Delete($target.path)
                continue
            }
            $document = Get-JsonDocument $target.path
            $removed = 0
            foreach ($eventName in @($target.events)) {
                $removed += Remove-LifecycleHandler $document $eventName $target.command
            }
            if ($removed -eq 0) {
                throw "Removal blocked because installed handlers are missing: $($target.name)"
            }
            Write-AtomicText $target.path (ConvertTo-StableJson $document)
            continue
        }
        if ($target.baseState -eq 'absent') {
            if ($target.kind -eq 'directory' -and (Test-Path -LiteralPath $target.path)) {
                [IO.Directory]::Delete($target.path, $true)
            }
            elseif ($target.kind -ne 'directory' -and (Test-Path -LiteralPath $target.path)) {
                [IO.File]::Delete($target.path)
            }
            continue
        }
        if ($target.kind -eq 'directory') {
            Copy-DirectoryExact (Join-Path $state.backupDirectory $target.name) $target.path
        }
        else {
            Write-AtomicCopy $target.path (Join-Path $state.backupDirectory "$($target.name).file")
        }
    }
    [IO.File]::Delete($statePath)
}
catch {
    $failure = $_
    $reverseCurrent = [object[]]$currentRecords.Clone()
    [array]::Reverse($reverseCurrent)
    foreach ($target in $reverseCurrent) {
        if ($target.state -eq 'absent') {
            if ($target.kind -eq 'directory' -and (Test-Path -LiteralPath $target.path)) {
                [IO.Directory]::Delete($target.path, $true)
            }
            elseif ($target.kind -ne 'directory' -and (Test-Path -LiteralPath $target.path)) {
                [IO.File]::Delete($target.path)
            }
        }
        elseif ($target.kind -eq 'directory') {
            Copy-DirectoryExact (Join-Path $operationBackupRoot $target.name) $target.path
        }
        else {
            Write-AtomicCopy $target.path (Join-Path $operationBackupRoot "$($target.name).file")
        }
    }
    throw $failure
}
finally {
    $lockStream.Dispose()
    if (Test-Path -LiteralPath $activationLock) { [IO.File]::Delete($activationLock) }
}

[ordered]@{
    action = $Action; writesEnabled = $true; version = [string]$state.version
    provider = [string]$state.provider; stateRemoved = $true
} | ConvertTo-Json -Depth 10
