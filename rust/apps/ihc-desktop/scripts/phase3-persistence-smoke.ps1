[CmdletBinding()]
param(
    [Parameter()]
    [string] $Executable = (Join-Path $PSScriptRoot '..\src-tauri\target\release\ihatecoding-rust-preview.exe'),

    [Parameter()]
    [ValidateScript({
        if ($_ -ne 20) {
            throw 'The Phase 3 persistence smoke test requires exactly 20 panes.'
        }
        return $true
    })]
    [int] $PaneCount = 20,

    [Parameter()]
    [ValidateSet('Normal', 'Forced', 'RapidNormal')]
    [string] $CloseMode = 'Normal',

    [Parameter()]
    [ValidateRange(10, 180)]
    [int] $StartupTimeoutSeconds = 90,

    [Parameter()]
    [ValidateRange(2, 30)]
    [int] $ShutdownTimeoutSeconds = 8
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not ('IhcSmokeNativeProcess' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class IhcSmokeNativeProcess
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessBasicInformation
    {
        public IntPtr Reserved1;
        public IntPtr PebBaseAddress;
        public IntPtr Reserved2_0;
        public IntPtr Reserved2_1;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(
        IntPtr processHandle,
        int processInformationClass,
        ref ProcessBasicInformation processInformation,
        int processInformationLength,
        out int returnLength);

    public static int GetParentProcessId(IntPtr processHandle)
    {
        var information = new ProcessBasicInformation();
        int returnLength;
        var status = NtQueryInformationProcess(
            processHandle,
            0,
            ref information,
            Marshal.SizeOf(information),
            out returnLength);
        if (status != 0)
        {
            throw new InvalidOperationException(
                "NtQueryInformationProcess failed with NTSTATUS 0x" +
                status.ToString("X8"));
        }
        return checked((int)information.InheritedFromUniqueProcessId.ToInt64());
    }
}
'@
}

$previewStoreEnvironmentVariable = 'IHATECODING_RUST_PREVIEW_PROJECTS_DIR'
$legacyPaneEnvironmentVariable = 'IHC_PHASE2_INITIAL_PANES'
$catalogFileName = 'projects-v1.json'
$smokeDirectoryPrefix = 'ihatecoding-phase3-smoke-'
$smokeMarkerFileName = '.ihatecoding-phase3-smoke-root'

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

function Get-FastCreationTicks {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process
    )

    try {
        $creationTicks = $Process.StartTime.ToUniversalTime().Ticks
        # Win32_Process.CreationDate is exposed at microsecond precision.
        return $creationTicks - ($creationTicks % 10)
    }
    catch {
        return $null
    }
}

function New-FastProcessIdentity {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process
    )

    try {
        $parentProcessId = [IhcSmokeNativeProcess]::GetParentProcessId($Process.Handle)
        $creationTicks = Get-FastCreationTicks $Process
        if ($null -eq $creationTicks) { return $null }
        return [pscustomobject]@{
            ProcessId = [int] $Process.Id
            Name = "$($Process.ProcessName).exe"
            ParentProcessId = $parentProcessId
            CreationTicks = $creationTicks
            # Handle-derived parent, creation time, name and session are enough
            # for the rapid terminal-only path; module lookup is comparatively slow.
            ExecutablePath = ''
            SessionId = [int] $Process.SessionId
        }
    }
    catch {
        # A candidate may exit between Get-Process and handle inspection.
        return $null
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
            $verifiedLive[$identity.ProcessId] = $identity
        }
    }

    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $ProcessTable.Values) {
            $processId = [int] $item.ProcessId
            $parentId = [int] $item.ParentProcessId
            if (-not $Tracked.ContainsKey($processId) -and $verifiedLive.ContainsKey($parentId)) {
                $parentIdentity = $verifiedLive[$parentId]
                $childIdentity = New-ProcessIdentity $item
                # Windows preserves the numeric PPID even after the real parent
                # exits. If that PID is reused, old unrelated processes can look
                # like children of the new process. A real child must be born no
                # earlier than its verified parent and in the same logon session.
                if ($childIdentity.CreationTicks -lt $parentIdentity.CreationTicks -or
                    $childIdentity.SessionId -ne $parentIdentity.SessionId) {
                    continue
                }
                $Tracked[$processId] = $childIdentity
                $verifiedLive[$processId] = $childIdentity
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

function Test-IsPowerShellIdentity {
    param([Parameter(Mandatory)] $Identity)

    return $Identity.Name -ieq 'powershell.exe' -or $Identity.Name -ieq 'pwsh.exe'
}

function Test-IsConPtyHostIdentity {
    param([Parameter(Mandatory)] $Identity)

    return $Identity.Name -ieq 'conhost.exe' -or $Identity.Name -ieq 'OpenConsole.exe'
}

function Test-CapturedIdentity {
    param(
        [Parameter(Mandatory)] $Expected,
        [Parameter(Mandatory)] $Actual
    )

    if ($Expected.ProcessId -ne $Actual.ProcessId -or
        $Expected.Name -ine $Actual.Name -or
        $Expected.CreationTicks -ne $Actual.CreationTicks -or
        $Expected.SessionId -ne $Actual.SessionId) {
        return $false
    }
    if ($Expected.ExecutablePath -and $Actual.ExecutablePath -and
        $Expected.ExecutablePath -ine $Actual.ExecutablePath) {
        return $false
    }
    return $true
}

function Get-LiveTrackedTerminalChildren {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        $RootIdentity,

        [Parameter(Mandatory)]
        [hashtable] $BaselineCreationTicks,

        [Parameter()]
        [switch] $Discover
    )

    $current = @{}
    foreach ($process in @(
        Get-Process `
            -Name 'powershell', 'pwsh', 'conhost', 'OpenConsole' `
            -ErrorAction SilentlyContinue
    )) {
        $processId = [int] $process.Id
        if ($BaselineCreationTicks.ContainsKey($processId)) {
            $creationTicks = Get-FastCreationTicks $process
            if ($null -ne $creationTicks -and
                $creationTicks -eq $BaselineCreationTicks[$processId]) {
                continue
            }
        }
        $identity = New-FastProcessIdentity $process
        if ($null -ne $identity) {
            $current[$identity.ProcessId] = $identity
        }
    }

    if ($Discover) {
        $verifiedParents = @{}
        $verifiedParents[[int] $RootIdentity.ProcessId] = $RootIdentity

        # PowerShell panes are spawned directly by the verified preview root.
        foreach ($identity in $current.Values) {
            if ((Test-IsPowerShellIdentity $identity) -and
                $identity.ParentProcessId -eq $RootIdentity.ProcessId -and
                $identity.CreationTicks -ge $RootIdentity.CreationTicks -and
                $identity.SessionId -eq $RootIdentity.SessionId) {
                $Tracked[$identity.ProcessId] = $identity
                $verifiedParents[$identity.ProcessId] = $identity
            }
        }

        # Only terminal-host executable names can extend this chain. Creation
        # time and session checks rule out stale Windows PPIDs after PID reuse.
        $changed = $true
        while ($changed) {
            $changed = $false
            foreach ($identity in $current.Values) {
                if (-not (Test-IsConPtyHostIdentity $identity) -or
                    $verifiedParents.ContainsKey($identity.ProcessId) -or
                    -not $verifiedParents.ContainsKey($identity.ParentProcessId)) {
                    continue
                }
                $parent = $verifiedParents[$identity.ParentProcessId]
                if ($identity.CreationTicks -lt $parent.CreationTicks -or
                    $identity.SessionId -ne $parent.SessionId) {
                    continue
                }
                $Tracked[$identity.ProcessId] = $identity
                $verifiedParents[$identity.ProcessId] = $identity
                $changed = $true
            }
        }
    }

    return @(
        $Tracked.Values |
            Where-Object {
                ((Test-IsPowerShellIdentity $_) -or (Test-IsConPtyHostIdentity $_)) -and
                $current.ContainsKey($_.ProcessId) -and
                (Test-CapturedIdentity -Expected $_ -Actual $current[$_.ProcessId])
            }
    )
}

function Stop-LaunchedProcessObject {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process
    )

    # This Process object came directly from this script's Start-Process call.
    # Do not replace this with a name-based or broad PID search.
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

    $rootProcessId = $Process.Id
    $table = Get-ProcessTable
    if (-not $Tracked.ContainsKey($rootProcessId) -or -not $table.ContainsKey($rootProcessId)) {
        return
    }
    if (-not (Test-ProcessIdentity -Identity $Tracked[$rootProcessId] -ProcessRecord $table[$rootProcessId])) {
        throw "Refusing to stop PID $rootProcessId because its process identity changed."
    }

    # The Rust preview owns its descendants through a kill-on-close Job Object.
    # Terminate only the identity-checked app root; never enumerate processes by
    # executable name for termination.
    Stop-LaunchedProcessObject -Process $Process
}

function Test-ByteArraysEqual {
    param(
        [Parameter(Mandatory)]
        [byte[]] $Expected,

        [Parameter(Mandatory)]
        [byte[]] $Actual
    )

    if ($Expected.Length -ne $Actual.Length) { return $false }
    for ($index = 0; $index -lt $Expected.Length; $index += 1) {
        if ($Expected[$index] -ne $Actual[$index]) { return $false }
    }
    return $true
}

function Assert-CatalogInvariant {
    param(
        [Parameter(Mandatory)]
        [string] $CatalogPath,

        [Parameter(Mandatory)]
        [byte[]] $ExpectedBytes,

        [Parameter(Mandatory)]
        [string] $ExpectedProjectId,

        [Parameter(Mandatory)]
        [string[]] $ExpectedPaneIds,

        [Parameter(Mandatory)]
        [string[]] $ExpectedPaneNames
    )

    if (-not (Test-Path -LiteralPath $CatalogPath -PathType Leaf)) {
        throw 'The isolated preview catalog disappeared during the smoke test.'
    }
    $actualBytes = [System.IO.File]::ReadAllBytes($CatalogPath)
    if (-not (Test-ByteArraysEqual -Expected $ExpectedBytes -Actual $actualBytes)) {
        throw 'The isolated preview catalog bytes changed during a read-only restore cycle.'
    }

    $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
    $catalogText = $utf8.GetString($actualBytes)
    $catalog = $catalogText | ConvertFrom-Json
    if (@($catalog.Projects).Count -ne 1) {
        throw 'The isolated preview catalog no longer contains exactly one smoke project.'
    }
    if ([string] $catalog.SelectedProjectId -cne $ExpectedProjectId) {
        throw 'The selected smoke project changed during restart restore.'
    }

    $project = @($catalog.Projects)[0]
    if ([string] $project.Id -cne $ExpectedProjectId) {
        throw 'The smoke project identifier changed during restart restore.'
    }
    $terminals = @($project.Terminals)
    if ($terminals.Count -ne $ExpectedPaneIds.Count) {
        throw "Expected $($ExpectedPaneIds.Count) persisted panes, found $($terminals.Count)."
    }
    for ($index = 0; $index -lt $terminals.Count; $index += 1) {
        if ([string] $terminals[$index].Id -cne $ExpectedPaneIds[$index]) {
            throw "Persisted pane ID or order changed at index $index."
        }
        if ([string] $terminals[$index].Name -cne $ExpectedPaneNames[$index]) {
            throw "Persisted pane name or order changed at index $index."
        }
    }
}

function Wait-ForNoTrackedChildren {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        [int] $RootProcessId,

        [Parameter(Mandatory)]
        [int] $TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $remaining = @()
    $consecutiveEmptySamples = 0
    do {
        $remaining = @(Get-LiveTrackedChildren -Tracked $Tracked -RootProcessId $RootProcessId)
        if ($remaining.Count -eq 0) {
            $consecutiveEmptySamples += 1
            # A single empty process-table sample is not enough for a shutdown
            # assertion. Require repeated quiescent samples so a late ConPTY
            # child cannot pass between observations.
            if ($consecutiveEmptySamples -ge 4) { return @() }
        }
        else {
            $consecutiveEmptySamples = 0
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -eq 0) {
        throw 'Tracked descendants became empty but did not remain empty for four consecutive samples before timeout.'
    }
    return $remaining
}

function Wait-ForTrackedApplicationExit {
    param(
        [Parameter(Mandatory)]
        [System.Diagnostics.Process] $Process,

        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        [hashtable] $BaselineCreationTicks,

        [Parameter(Mandatory)]
        [int] $TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $Process.Refresh()
        if ($Process.HasExited) { return $true }
        # Rapid close discovers only terminal executable identities. It never
        # follows generic PPID chains into Chrome, extension hosts or OS input
        # helpers, even if Windows exposes a stale reused parent PID.
        [void] @(
            Get-LiveTrackedTerminalChildren `
                -Tracked $Tracked `
                -RootIdentity $Tracked[$Process.Id] `
                -BaselineCreationTicks $BaselineCreationTicks `
                -Discover
        )
        Start-Sleep -Milliseconds 20
    } while ([DateTime]::UtcNow -lt $deadline)

    $Process.Refresh()
    return $Process.HasExited
}

function Wait-ForNoTrackedTerminalChildren {
    param(
        [Parameter(Mandatory)]
        [hashtable] $Tracked,

        [Parameter(Mandatory)]
        $RootIdentity,

        [Parameter(Mandatory)]
        [hashtable] $BaselineCreationTicks,

        [Parameter(Mandatory)]
        [int] $TimeoutSeconds
    )

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $remaining = @()
    $consecutiveEmptySamples = 0
    do {
        $remaining = @(
            Get-LiveTrackedTerminalChildren `
                -Tracked $Tracked `
                -RootIdentity $RootIdentity `
                -BaselineCreationTicks $BaselineCreationTicks
        )
        if ($remaining.Count -eq 0) {
            $consecutiveEmptySamples += 1
            if ($consecutiveEmptySamples -ge 4) { return @() }
        }
        else {
            $consecutiveEmptySamples = 0
        }
        Start-Sleep -Milliseconds 50
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -eq 0) {
        throw 'Tracked terminal descendants did not remain empty for four consecutive samples before timeout.'
    }
    return $remaining
}

function Invoke-SmokeCycle {
    param(
        [Parameter(Mandatory)]
        [ValidateRange(1, 2)]
        [int] $Cycle,

        [Parameter(Mandatory)]
        [string] $ResolvedExecutable,

        [Parameter(Mandatory)]
        [string] $ExecutableDirectory,

        [Parameter(Mandatory)]
        [int] $ExpectedPowerShellCount,

        [Parameter(Mandatory)]
        [ValidateSet('Normal', 'Forced', 'RapidNormal')]
        [string] $RequestedCloseMode,

        [Parameter(Mandatory)]
        [int] $StartupTimeout,

        [Parameter(Mandatory)]
        [int] $ShutdownTimeout
    )

    $app = $null
    $tracked = @{}
    $closedAndVerified = $false
    $terminalBaselineCreationTicks = @{}
    foreach ($process in @(
        Get-Process `
            -Name 'powershell', 'pwsh', 'conhost', 'OpenConsole' `
            -ErrorAction SilentlyContinue
    )) {
        $creationTicks = Get-FastCreationTicks $process
        if ($null -ne $creationTicks) {
            $terminalBaselineCreationTicks[[int] $process.Id] = $creationTicks
        }
    }
    $startupWatch = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        $app = Start-Process -FilePath $ResolvedExecutable -WorkingDirectory $ExecutableDirectory -PassThru
        $rootRecord = $null
        $rootIdentityDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $rootRecord = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($app.Id)"
            if ($null -ne $rootRecord) { break }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $rootIdentityDeadline)
        if ($null -eq $rootRecord) {
            throw "Cycle $Cycle could not capture the preview process identity."
        }

        $tracked[$app.Id] = New-ProcessIdentity $rootRecord
        $rootExecutablePath = [string] $rootRecord.ExecutablePath
        if (-not $rootExecutablePath) {
            throw "Cycle $Cycle could not verify the launched executable path."
        }
        $actualRootExecutable = [System.IO.Path]::GetFullPath($rootExecutablePath)
        if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals(
            $actualRootExecutable,
            $ResolvedExecutable
        )) {
            throw "Cycle $Cycle launched a process that did not match the requested executable."
        }

        $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeout)
        $powerShellChildren = @()
        $conPtyHostChildren = @()
        $liveChildren = @()
        $restoreCompletedBeforeClose = $false
        do {
            if ($app.HasExited) {
                throw "Cycle $Cycle exited before the persisted PowerShell restore checkpoint."
            }
            if ($RequestedCloseMode -eq 'RapidNormal') {
                $liveChildren = @(
                    Get-LiveTrackedTerminalChildren `
                        -Tracked $tracked `
                        -RootIdentity $tracked[$app.Id] `
                        -BaselineCreationTicks $terminalBaselineCreationTicks `
                        -Discover
                )
            }
            else {
                $liveChildren = @(
                    Get-LiveTrackedChildren -Tracked $tracked -RootProcessId $app.Id
                )
            }
            $powerShellChildren = @(
                $liveChildren | Where-Object { Test-IsPowerShellIdentity $_ }
            )
            $conPtyHostChildren = @(
                $liveChildren | Where-Object { Test-IsConPtyHostIdentity $_ }
            )

            if ($RequestedCloseMode -eq 'RapidNormal') {
                if ($powerShellChildren.Count -ge $ExpectedPowerShellCount) {
                    throw "Cycle $Cycle reached all $ExpectedPowerShellCount PowerShell panes before the rapid-close checkpoint."
                }
                if ($powerShellChildren.Count -gt 0 -and $conPtyHostChildren.Count -gt 0) {
                    break
                }
            }
            elseif ($powerShellChildren.Count -ge $ExpectedPowerShellCount) {
                break
            }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $startupDeadline)

        if ($RequestedCloseMode -eq 'RapidNormal') {
            if ($powerShellChildren.Count -eq 0) {
                throw "Cycle $Cycle did not observe persisted PowerShell restoration start."
            }
            # Include starts that raced the ConPTY identity checks, then prove
            # the rapid checkpoint is still strictly before full restoration.
            $liveChildren = @(
                Get-LiveTrackedTerminalChildren `
                    -Tracked $tracked `
                    -RootIdentity $tracked[$app.Id] `
                    -BaselineCreationTicks $terminalBaselineCreationTicks `
                    -Discover
            )
            $powerShellChildren = @(
                $liveChildren | Where-Object { Test-IsPowerShellIdentity $_ }
            )
            $conPtyHostChildren = @(
                $liveChildren | Where-Object { Test-IsConPtyHostIdentity $_ }
            )
            if ($powerShellChildren.Count -ge $ExpectedPowerShellCount) {
                throw "Cycle $Cycle reached all $ExpectedPowerShellCount PowerShell panes before the rapid-close checkpoint."
            }
            if ($conPtyHostChildren.Count -eq 0) {
                throw "Cycle $Cycle did not identity-track a ConPTY host before rapid close."
            }
            # The first observed PowerShell child is process-level proof that
            # catalog restoration started. Close immediately, while queued pane
            # starts are still outstanding; do not wait for terminal readiness.
            $startupWatch.Stop()
            $stablePowerShellCount = $powerShellChildren.Count
        }
        else {
            if ($powerShellChildren.Count -ne $ExpectedPowerShellCount) {
                throw "Cycle $Cycle expected exactly $ExpectedPowerShellCount descendant powershell.exe processes, observed $($powerShellChildren.Count)."
            }

            # No UI input or click is performed. Stability after a short dwell proves
            # that all saved panes restored through catalog startup alone.
            $startupWatch.Stop()
            Start-Sleep -Milliseconds 750
            $liveChildren = @(Get-LiveTrackedChildren -Tracked $tracked -RootProcessId $app.Id)
            $stablePowerShellCount = @(
                $liveChildren | Where-Object { $_.Name -ieq 'powershell.exe' }
            ).Count
            if ($stablePowerShellCount -ne $ExpectedPowerShellCount) {
                throw "Cycle $Cycle PowerShell count was not stable: expected $ExpectedPowerShellCount, observed $stablePowerShellCount."
            }
            $restoreCompletedBeforeClose = $true
        }

        $powerShellCountAtClose = $stablePowerShellCount
        $conPtyHostCountAtClose = @(
            $liveChildren | Where-Object {
                $_.Name -ieq 'conhost.exe' -or $_.Name -ieq 'OpenConsole.exe'
            }
        ).Count

        $shutdownWatch = [System.Diagnostics.Stopwatch]::StartNew()
        $closeTable = Get-ProcessTable
        if (-not $tracked.ContainsKey($app.Id) -or -not $closeTable.ContainsKey($app.Id)) {
            throw "Cycle $Cycle preview root disappeared before the $RequestedCloseMode close check."
        }
        if (-not (Test-ProcessIdentity -Identity $tracked[$app.Id] -ProcessRecord $closeTable[$app.Id])) {
            throw "Cycle $Cycle refused to close because the preview root changed identity."
        }

        if ($RequestedCloseMode -in @('Normal', 'RapidNormal')) {
            $closeRequested = $app.CloseMainWindow()
            if (-not $closeRequested) {
                throw "Cycle $Cycle preview did not expose a closable main window."
            }
        }
        else {
            Stop-OwnedApplication -Tracked $tracked -Process $app
        }

        $exited = if ($RequestedCloseMode -eq 'RapidNormal') {
            Wait-ForTrackedApplicationExit `
                -Process $app `
                -Tracked $tracked `
                -BaselineCreationTicks $terminalBaselineCreationTicks `
                -TimeoutSeconds $ShutdownTimeout
        }
        else {
            $app.WaitForExit($ShutdownTimeout * 1000)
        }
        if (-not $exited) {
            throw "Cycle $Cycle preview did not exit within $ShutdownTimeout seconds."
        }
        $remaining = @(
            if ($RequestedCloseMode -eq 'RapidNormal') {
                Wait-ForNoTrackedTerminalChildren `
                    -Tracked $tracked `
                    -RootIdentity $tracked[$app.Id] `
                    -BaselineCreationTicks $terminalBaselineCreationTicks `
                    -TimeoutSeconds $ShutdownTimeout
            }
            else {
                Wait-ForNoTrackedChildren `
                    -Tracked $tracked `
                    -RootProcessId $app.Id `
                    -TimeoutSeconds $ShutdownTimeout
            }
        )
        $shutdownWatch.Stop()
        if ($remaining.Count -gt 0) {
            $description = ($remaining | ForEach-Object { "$($_.Name)[$($_.ProcessId)]" }) -join ', '
            throw "Cycle $Cycle left tracked descendants after shutdown: $description"
        }
        $trackedPowerShellCount = @(
            $tracked.Values | Where-Object {
                $_.Name -ieq 'powershell.exe' -or $_.Name -ieq 'pwsh.exe'
            }
        ).Count
        $trackedConPtyHostCount = @(
            $tracked.Values | Where-Object {
                $_.Name -ieq 'conhost.exe' -or $_.Name -ieq 'OpenConsole.exe'
            }
        ).Count
        if ($trackedPowerShellCount -eq 0) {
            throw "Cycle $Cycle did not identity-track any PowerShell descendant."
        }
        $closedAndVerified = $true

        return [pscustomobject]@{
            Cycle = $Cycle
            StartupMilliseconds = $startupWatch.ElapsedMilliseconds
            ShutdownMilliseconds = $shutdownWatch.ElapsedMilliseconds
            PowerShellCount = $stablePowerShellCount
            PowerShellCountAtClose = $powerShellCountAtClose
            ConPtyHostCountAtClose = $conPtyHostCountAtClose
            ConPtyHostCountAtCloseObserved = $true
            RestoreCompletedBeforeClose = $restoreCompletedBeforeClose
            TrackedProcessCount = $tracked.Count
            TrackedPowerShellCount = $trackedPowerShellCount
            TrackedConPtyHostCount = $trackedConPtyHostCount
            RemainingProcessCount = 0
            RemainingPowerShellCount = 0
            RemainingConPtyHostCount = 0
        }
    }
    finally {
        if ($null -ne $app -and -not $closedAndVerified) {
            try {
                if (-not $app.HasExited) {
                    if ($tracked.ContainsKey($app.Id)) {
                        # Capture any descendants that appeared before the failure,
                        # then rely on the app's Job Object by stopping only its root.
                        if ($RequestedCloseMode -eq 'RapidNormal') {
                            [void] @(
                                Get-LiveTrackedTerminalChildren `
                                    -Tracked $tracked `
                                    -RootIdentity $tracked[$app.Id] `
                                    -BaselineCreationTicks $terminalBaselineCreationTicks `
                                    -Discover
                            )
                        }
                        else {
                            [void] @(
                                Get-LiveTrackedChildren `
                                    -Tracked $tracked `
                                    -RootProcessId $app.Id
                            )
                        }
                        Stop-OwnedApplication -Tracked $tracked -Process $app
                    }
                    else {
                        Stop-LaunchedProcessObject -Process $app
                    }
                    [void] $app.WaitForExit($ShutdownTimeout * 1000)
                }
            }
            catch {
                Write-Warning "Cycle $Cycle cleanup could not stop the exact launched app process: $($_.Exception.Message)"
            }

            if ($tracked.Count -gt 0) {
                try {
                    $cleanupRemaining = @(
                        if ($RequestedCloseMode -eq 'RapidNormal' -and
                            $tracked.ContainsKey($app.Id)) {
                            Wait-ForNoTrackedTerminalChildren `
                                -Tracked $tracked `
                                -RootIdentity $tracked[$app.Id] `
                                -BaselineCreationTicks $terminalBaselineCreationTicks `
                                -TimeoutSeconds $ShutdownTimeout
                        }
                        else {
                            Wait-ForNoTrackedChildren `
                                -Tracked $tracked `
                                -RootProcessId $app.Id `
                                -TimeoutSeconds $ShutdownTimeout
                        }
                    )
                    if ($cleanupRemaining.Count -gt 0) {
                        Write-Warning "Cycle $Cycle cleanup still observes $($cleanupRemaining.Count) identity-tracked descendants. No process was selected or killed by name."
                    }
                }
                catch {
                    Write-Warning "Cycle $Cycle could not verify descendant cleanup: $($_.Exception.Message)"
                }
            }
        }
    }
}

function Remove-VerifiedSmokeRoot {
    param(
        [Parameter(Mandatory)]
        [string] $Root,

        [Parameter(Mandatory)]
        [string] $TempBase,

        [Parameter(Mandatory)]
        [string] $Token
    )

    if (-not (Test-Path -LiteralPath $Root)) { return }

    $rootInfo = Get-Item -LiteralPath $Root -Force
    if (-not $rootInfo.PSIsContainer) {
        throw 'Refusing smoke cleanup because the expected temporary root is not a directory.'
    }
    if (($rootInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing smoke cleanup because the temporary root became a reparse point.'
    }

    $resolvedRoot = [System.IO.Path]::GetFullPath($rootInfo.FullName).TrimEnd('\', '/')
    $resolvedBase = [System.IO.Path]::GetFullPath($TempBase).TrimEnd('\', '/')
    $expectedLeaf = "$smokeDirectoryPrefix$Token"
    $actualParent = [System.IO.Path]::GetDirectoryName($resolvedRoot)
    $actualLeaf = [System.IO.Path]::GetFileName($resolvedRoot)
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($actualParent, $resolvedBase) -or
        -not [System.StringComparer]::Ordinal.Equals($actualLeaf, $expectedLeaf)) {
        throw 'Refusing smoke cleanup because the temporary root is outside the verified temp location.'
    }

    $markerPath = Join-Path $resolvedRoot $smokeMarkerFileName
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw 'Refusing smoke cleanup because its ownership marker is missing.'
    }
    $marker = [System.IO.File]::ReadAllText($markerPath)
    if ($marker -cne $Token) {
        throw 'Refusing smoke cleanup because its ownership marker changed.'
    }

    # The absolute target, direct temp parent, unique leaf, non-reparse status,
    # and private marker were all verified immediately before recursive removal.
    Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
}

$resolvedExecutableItem = Get-Item -LiteralPath $Executable -ErrorAction Stop
if ($resolvedExecutableItem.PSIsContainer) {
    throw 'The requested Phase 3 executable path is a directory.'
}
$resolvedExecutable = [System.IO.Path]::GetFullPath($resolvedExecutableItem.FullName)
$executableDirectory = [System.IO.Path]::GetDirectoryName($resolvedExecutable)

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$smokeToken = [Guid]::NewGuid().ToString('N')
$smokeRoot = Join-Path $tempBase "$smokeDirectoryPrefix$smokeToken"
if (Test-Path -LiteralPath $smokeRoot) {
    throw 'The randomly generated Phase 3 smoke directory already exists.'
}
try {
    [void] [System.IO.Directory]::CreateDirectory($smokeRoot)
    $smokeRoot = [System.IO.Path]::GetFullPath($smokeRoot).TrimEnd('\', '/')
    $markerPath = Join-Path $smokeRoot $smokeMarkerFileName
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false, $true)
    [System.IO.File]::WriteAllText($markerPath, $smokeToken, $utf8WithoutBom)

    $storeDirectory = Join-Path $smokeRoot 'preview-store'
    $projectDirectory = Join-Path $smokeRoot 'sanitized-project'
    [void] [System.IO.Directory]::CreateDirectory($storeDirectory)
    [void] [System.IO.Directory]::CreateDirectory($projectDirectory)
    $catalogPath = Join-Path $storeDirectory $catalogFileName
    $smokeProjectId = 'phase3-smoke-project'
    $expectedPaneIds = New-Object System.Collections.Generic.List[string]
    $expectedPaneNames = New-Object System.Collections.Generic.List[string]
    $terminals = New-Object System.Collections.Generic.List[object]
    for ($index = 1; $index -le $PaneCount; $index += 1) {
        $paneId = 'phase3-smoke-pane-{0:D2}' -f $index
        $paneName = 'PowerShell {0:D2}' -f $index
        $expectedPaneIds.Add($paneId)
        $expectedPaneNames.Add($paneName)
        $terminals.Add([ordered]@{
            Id = $paneId
            Name = $paneName
            StartDirectory = $projectDirectory
            CodexThreadId = $null
            GrokSessionId = $null
            CreatedAtUtc = '2026-01-01T00:00:00Z'
            CompletionPending = $false
        })
    }

    $seedCatalog = [ordered]@{
        Projects = @(
            [ordered]@{
                Id = $smokeProjectId
                Name = 'Sanitized Phase 3 smoke project'
                FolderPath = $projectDirectory
                Terminals = $terminals.ToArray()
                PaneWidthRatios = [ordered]@{}
            }
        )
        SelectedProjectId = $smokeProjectId
    }
    $seedJson = $seedCatalog | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($catalogPath, $seedJson, $utf8WithoutBom)
    $expectedCatalogBytes = [System.IO.File]::ReadAllBytes($catalogPath)

    $previousPreviewStore = [Environment]::GetEnvironmentVariable(
        $previewStoreEnvironmentVariable,
        'Process'
    )
    $previousLegacyPaneCount = [Environment]::GetEnvironmentVariable(
        $legacyPaneEnvironmentVariable,
        'Process'
    )
    $cycleResults = New-Object System.Collections.Generic.List[object]

    try {
        [Environment]::SetEnvironmentVariable(
            $previewStoreEnvironmentVariable,
            $storeDirectory,
            'Process'
        )
        # Prevent a caller's Phase 2 override from influencing this catalog-only test.
        [Environment]::SetEnvironmentVariable($legacyPaneEnvironmentVariable, $null, 'Process')

        Assert-CatalogInvariant `
            -CatalogPath $catalogPath `
            -ExpectedBytes $expectedCatalogBytes `
            -ExpectedProjectId $smokeProjectId `
            -ExpectedPaneIds $expectedPaneIds.ToArray() `
            -ExpectedPaneNames $expectedPaneNames.ToArray()

        for ($cycle = 1; $cycle -le 2; $cycle += 1) {
            $cycleResult = Invoke-SmokeCycle `
                -Cycle $cycle `
                -ResolvedExecutable $resolvedExecutable `
                -ExecutableDirectory $executableDirectory `
                -ExpectedPowerShellCount $PaneCount `
                -RequestedCloseMode $CloseMode `
                -StartupTimeout $StartupTimeoutSeconds `
                -ShutdownTimeout $ShutdownTimeoutSeconds
            $cycleResults.Add($cycleResult)

            Assert-CatalogInvariant `
                -CatalogPath $catalogPath `
                -ExpectedBytes $expectedCatalogBytes `
                -ExpectedProjectId $smokeProjectId `
                -ExpectedPaneIds $expectedPaneIds.ToArray() `
                -ExpectedPaneNames $expectedPaneNames.ToArray()
        }

        [pscustomobject]@{
            Result = 'PASS'
            Executable = $resolvedExecutable
            PaneCount = $PaneCount
            LaunchCount = $cycleResults.Count
            CloseMode = $CloseMode
            CatalogBytesUnchanged = $true
            PaneIdentityNameOrderUnchanged = $true
            RemainingProcessCount = 0
            Cycles = $cycleResults.ToArray()
        } | ConvertTo-Json -Depth 5
    }
    finally {
        [Environment]::SetEnvironmentVariable(
            $previewStoreEnvironmentVariable,
            $previousPreviewStore,
            'Process'
        )
        [Environment]::SetEnvironmentVariable(
            $legacyPaneEnvironmentVariable,
            $previousLegacyPaneCount,
            'Process'
        )
    }
}
finally {
    if (Test-Path -LiteralPath $smokeRoot) {
        Remove-VerifiedSmokeRoot -Root $smokeRoot -TempBase $tempBase -Token $smokeToken
    }
}
