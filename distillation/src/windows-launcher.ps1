param([string] $ProbeJob = '')
$ErrorActionPreference = 'Stop'
try {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    Add-Type -Path (Join-Path $PSScriptRoot 'windows-launcher.cs') -ReferencedAssemblies System.Web.Extensions
    if ($ProbeJob) {
        [Console]::Out.WriteLine([ContainedLauncher]::ProbeJob($ProbeJob))
    } else {
        [ContainedLauncher]::Run($watch.Elapsed.TotalMilliseconds)
    }
    exit 0
} catch {
    # Host diagnostics never share the framed channel or the child's stderr.
    [Console]::Error.WriteLine('windows-launcher-host-failed: ' + $_.Exception.Message)
    exit 1
}
