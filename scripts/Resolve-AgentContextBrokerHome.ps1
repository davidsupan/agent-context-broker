function Resolve-AgentContextBrokerHome {
    [CmdletBinding()]
    param([string]$Path)

    if ($Path) {
        return [IO.Path]::GetFullPath($Path)
    }
    if ($env:AGENT_CONTEXT_BROKER_HOME) {
        return [IO.Path]::GetFullPath($env:AGENT_CONTEXT_BROKER_HOME)
    }
    if ($IsWindows) {
        $localAppData = if ($env:LOCALAPPDATA) {
            $env:LOCALAPPDATA
        }
        else {
            Join-Path $HOME 'AppData\Local'
        }
        return [IO.Path]::GetFullPath((Join-Path $localAppData 'AgentContextBroker'))
    }
    if ($IsLinux) {
        $stateRoot = if ($env:XDG_STATE_HOME) {
            $env:XDG_STATE_HOME
        }
        else {
            Join-Path $HOME '.local/state'
        }
        return [IO.Path]::GetFullPath((Join-Path $stateRoot 'agent-context-broker'))
    }

    throw 'This release supports Windows and Linux. Set AGENT_CONTEXT_BROKER_HOME only for unsupported-platform development.'
}
