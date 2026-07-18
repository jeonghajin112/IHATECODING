[CmdletBinding()]
param(
    [Parameter()]
    [string] $Executable = (Join-Path $PSScriptRoot '..\src-tauri\target\release\ihatecoding.exe'),

    [Parameter()]
    [ValidateRange(1, 20)]
    [int] $PaneCount = 20,

    [Parameter()]
    [ValidateSet('Normal', 'Forced')]
    [string] $CloseMode = 'Normal',

    [Parameter()]
    [ValidateRange(5, 120)]
    [int] $StartupTimeoutSeconds = 45,

    [Parameter()]
    [ValidateRange(2, 30)]
    [int] $ShutdownTimeoutSeconds = 5
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-ProcessTable {
    $table = @{}
    foreach ($item in Get-CimInstance -ClassName Win32_Process) {
        $table[[int] $item.ProcessId] = $item
    }
    return $table
}

function ConvertTo-CreationTicks {
    param([Parameter(Mandatory)] $CreationDate)

    return ([DateTime] $CreationDate).ToUniversalTime().Ticks
}

function New-ProcessIdentity {
    param([Parameter(Mandatory)] $ProcessRecord)

    return [pscustomobject]@{
        ProcessId = [int] $ProcessRecord.ProcessId
        Name = [string] $ProcessRecord.Name
        ParentProcessId = [int] $ProcessRecord.ParentProcessId
        CreationTicks = ConvertTo-CreationTicks $ProcessRecord.CreationDate
        ExecutablePath = [string] $ProcessRecord.ExecutablePath
        SessionId = [int] $ProcessRecord.SessionId
    }
}

function Test-ProcessIdentity {
    param(
        [Parameter(Mandatory)] $Identity,
        [Parameter(Mandatory)] $ProcessRecord
    )

    if ([int] $ProcessRecord.ProcessId -ne $Identity.ProcessId) { return $false }
    if ([string] $ProcessRecord.Name -ine $Identity.Name) { return $false }
    if ([int] $ProcessRecord.SessionId -ne $Identity.SessionId) { return $false }
    if ((ConvertTo-CreationTicks $ProcessRecord.CreationDate) -ne $Identity.CreationTicks) {
        return $false
    }

    $currentPath = [string] $ProcessRecord.ExecutablePath
    if ($Identity.ExecutablePath -and $currentPath -and $currentPath -ine $Identity.ExecutablePath) {
        return $false
    }
    return $true
}

function Expand-TrackedProcesses {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        [hashtable] $ProcessTable
    )

    $verifiedLive = @{}
    foreach ($identity in $Tracked.Values) {
        if ($ProcessTable.ContainsKey($identity.ProcessId) -and
            (Test-ProcessIdentity -Identity $identity -ProcessRecord $ProcessTable[$identity.ProcessId])) {
            $verifiedLive[$identity.ProcessId] = $true
        }
    }

    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $ProcessTable.Values) {
            $processId = [int] $item.ProcessId
            $parentId = [int] $item.ParentProcessId
            # Never attach a new child to a tracked PID whose original process has
            # already disappeared. That PID may now belong to an unrelated process.
            if (-not $Tracked.ContainsKey($processId) -and $verifiedLive.ContainsKey($parentId)) {
                $Tracked[$processId] = New-ProcessIdentity $item
                $verifiedLive[$processId] = $true
                $changed = $true
            }
        }
    }
}

function Get-LiveTrackedChildren {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        [int] $RootProcessId
    )

    $table = Get-ProcessTable
    Expand-TrackedProcesses -Tracked $Tracked -ProcessTable $table
    return @(
        $Tracked.Values |
            Where-Object {
                $_.ProcessId -ne $RootProcessId -and
                $table.ContainsKey($_.ProcessId) -and
                (Test-ProcessIdentity -Identity $_ -ProcessRecord $table[$_.ProcessId])
            }
    )
}

function Stop-LaunchedProcessObject {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process
    )

    # This Process object was returned directly by this script's Start-Process call.
    # Using its OS handle avoids selecting any process by name or a reused PID.
    try {
        $Process.Kill()
    }
    catch {
        $Process.Refresh()
        if (-not $Process.HasExited) { throw }
    }
}

function Stop-OwnedApplication {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process
    )

    $RootProcessId = $Process.Id
    $table = Get-ProcessTable
    if (-not $Tracked.ContainsKey($RootProcessId) -or -not $table.ContainsKey($RootProcessId)) {
        return
    }
    $identity = $Tracked[$RootProcessId]
    if (-not (Test-ProcessIdentity -Identity $identity -ProcessRecord $table[$RootProcessId])) {
        throw "Refusing to stop PID $RootProcessId because its process identity changed."
    }

    # Only terminate the verified app root. The app's Job Object owns its
    # descendants; killing child PIDs directly would risk PID-reuse mistakes.
    # Kill through the Process object captured by Start-Process rather than
    # looking the process up again by PID after the identity check.
    Stop-LaunchedProcessObject -Process $Process
}

$resolvedExecutable = [System.IO.Path]::GetFullPath($Executable)
if (-not (Test-Path -LiteralPath $resolvedExecutable -PathType Leaf)) {
    throw "Phase 2 executable not found: $resolvedExecutable"
}
$executableDirectory = [System.IO.Path]::GetDirectoryName($resolvedExecutable)

$previousInitialPanes = [Environment]::GetEnvironmentVariable('IHC_PHASE2_INITIAL_PANES', 'Process')
$app = $null
$tracked = @{}
$startupWatch = [System.Diagnostics.Stopwatch]::StartNew()
$shutdownMilliseconds = $null

try {
    [Environment]::SetEnvironmentVariable('IHC_PHASE2_INITIAL_PANES', [string] $PaneCount, 'Process')
    # Keep smoke PowerShell sessions out of the caller's repository/project directory.
    $app = Start-Process -FilePath $resolvedExecutable -WorkingDirectory $executableDirectory -PassThru
    $rootRecord = $null
    $rootIdentityDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $rootRecord = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($app.Id)"
        if ($null -ne $rootRecord) { break }
        Start-Sleep -Milliseconds 20
    } while ([DateTime]::UtcNow -lt $rootIdentityDeadline)
    if ($null -eq $rootRecord) {
        throw "Could not capture the preview process identity for PID $($app.Id)."
    }
    $tracked[$app.Id] = New-ProcessIdentity $rootRecord
    $rootExecutablePath = [string] $rootRecord.ExecutablePath
    if ($rootExecutablePath -and
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
            [System.IO.Path]::GetFullPath($rootExecutablePath),
            $resolvedExecutable
        )) {
        throw "Launched PID $($app.Id) did not match the requested executable path."
    }

    $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    $powerShellChildren = @()
    do {
        if ($app.HasExited) {
            throw "The preview exited before $PaneCount PowerShell sessions started (exit code $($app.ExitCode))."
        }

        $liveChildren = @(Get-LiveTrackedChildren -Tracked $tracked -RootProcessId $app.Id)
        $powerShellChildren = @(
            $liveChildren | Where-Object { $_.Name -ieq 'powershell.exe' }
        )
        if ($powerShellChildren.Count -ge $PaneCount) {
            break
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $startupDeadline)

    if ($powerShellChildren.Count -ne $PaneCount) {
        throw "Expected exactly $PaneCount PowerShell children, observed $($powerShellChildren.Count)."
    }

    $startupWatch.Stop()
    Start-Sleep -Milliseconds 750
    $liveChildren = @(Get-LiveTrackedChildren -Tracked $tracked -RootProcessId $app.Id)
    $stablePowerShellCount = @($liveChildren | Where-Object { $_.Name -ieq 'powershell.exe' }).Count
    if ($stablePowerShellCount -ne $PaneCount) {
        throw "PowerShell count was not stable: expected $PaneCount, observed $stablePowerShellCount."
    }

    $shutdownWatch = [System.Diagnostics.Stopwatch]::StartNew()
    $closeTable = Get-ProcessTable
    if (-not $tracked.ContainsKey($app.Id) -or -not $closeTable.ContainsKey($app.Id)) {
        throw "The preview root PID $($app.Id) disappeared before the $CloseMode close check."
    }
    if (-not (Test-ProcessIdentity -Identity $tracked[$app.Id] -ProcessRecord $closeTable[$app.Id])) {
        throw "Refusing the $CloseMode close because PID $($app.Id) changed identity."
    }

    if ($CloseMode -eq 'Normal') {
        if (-not $app.CloseMainWindow()) {
            throw 'The preview did not expose a closable main window.'
        }
    }
    else {
        # Reuse the identity-checked root-only termination path. Never stop a child
        # or any process selected only by executable name.
        Stop-OwnedApplication -Tracked $tracked -Process $app
    }

    if (-not $app.WaitForExit($ShutdownTimeoutSeconds * 1000)) {
        throw "The preview did not exit within $ShutdownTimeoutSeconds seconds."
    }

    $shutdownDeadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)
    $remaining = @()
    do {
        $remaining = @(Get-LiveTrackedChildren -Tracked $tracked -RootProcessId $app.Id)
        if ($remaining.Count -eq 0) {
            break
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $shutdownDeadline)

    $shutdownWatch.Stop()
    $shutdownMilliseconds = $shutdownWatch.ElapsedMilliseconds
    if ($remaining.Count -gt 0) {
        $description = ($remaining | ForEach-Object { "$($_.Name)[$($_.ProcessId)]" }) -join ', '
        throw "Owned child processes remained after shutdown: $description"
    }

    [pscustomobject]@{
        Result = 'PASS'
        Executable = $resolvedExecutable
        PaneCount = $PaneCount
        CloseMode = $CloseMode
        StartupMilliseconds = $startupWatch.ElapsedMilliseconds
        ShutdownMilliseconds = $shutdownMilliseconds
        TrackedProcessCount = $tracked.Count
        RemainingProcessCount = 0
    } | ConvertTo-Json
}
finally {
    [Environment]::SetEnvironmentVariable('IHC_PHASE2_INITIAL_PANES', $previousInitialPanes, 'Process')
    if ($null -ne $app -and -not $app.HasExited) {
        if ($tracked.ContainsKey($app.Id)) {
            Stop-OwnedApplication -Tracked $tracked -Process $app
        }
        else {
            # Identity capture may fail very early, but the Process object itself is
            # still the exact process launched by this script and is safe to close.
            Stop-LaunchedProcessObject -Process $app
        }
    }
}
