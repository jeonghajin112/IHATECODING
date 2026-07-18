[CmdletBinding()]
param(
    [Parameter()]
    [string] $RustExecutable = (Join-Path $PSScriptRoot '..\rust\apps\ihc-desktop\src-tauri\target\release\ihatecoding.exe'),

    [Parameter()]
    [string] $CSharpExecutable = '',

    [Parameter()]
    [string] $CSharpBaselineTag = 'csharp-final-2026-07-16',

    [Parameter()]
    [switch] $BuildCSharpBaselineFromTag,

    [Parameter()]
    [ValidateSet(1, 8, 20)]
    [int[]] $PaneCounts = @(1, 8, 20),

    [Parameter()]
    [ValidateRange(5, 120)]
    [int] $StartupTimeoutSeconds = 45,

    [Parameter()]
    [ValidateRange(2, 30)]
    [int] $ShutdownTimeoutSeconds = 8,

    [Parameter()]
    [ValidateRange(500, 10000)]
    [int] $SteadySampleMilliseconds = 1500,

    [Parameter()]
    [string] $RustStateRootEnvironmentVariable = 'IHATECODING_PHASE6_STATE_ROOT',

    [Parameter()]
    [string] $OutputPath = (Join-Path $PSScriptRoot '..\artifacts\phase6-comparison.json'),

    [Parameter()]
    [switch] $SkipCSharp,

    [Parameter()]
    [switch] $RustImportFromLegacy
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$fixtureToken = 'C:\__IHATECODING_PHASE6_PROJECT__'
$smokePrefix = 'ihatecoding-phase6-'
$markerName = '.ihatecoding-phase6-root'
$utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')).TrimEnd('\', '/')
$fixtureRoot = Join-Path $repoRoot 'rust\fixtures'
$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\', '/')
$token = [Guid]::NewGuid().ToString('N')
$smokeRoot = Join-Path $tempBase "$smokePrefix$token"
$markerPath = Join-Path $smokeRoot $markerName
$savedEnvironment = @{}

function Set-ProcessEnvironment {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [AllowNull()] [string] $Value
    )
    if (-not $savedEnvironment.ContainsKey($Name)) {
        $savedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, 'Process')
    }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Restore-ProcessEnvironment {
    foreach ($entry in $savedEnvironment.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process')
    }
}

function Write-Utf8Json {
    param(
        [Parameter(Mandatory)] $Value,
        [Parameter(Mandatory)] [string] $Path
    )
    $parent = [System.IO.Path]::GetDirectoryName($Path)
    if ($parent) { [void] [System.IO.Directory]::CreateDirectory($parent) }
    $json = $Value | ConvertTo-Json -Depth 40
    [System.IO.File]::WriteAllText($Path, $json + [Environment]::NewLine, $utf8WithoutBom)
}

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
    $path = [string] $ProcessRecord.ExecutablePath
    if ($Identity.ExecutablePath -and $path -and $path -ine $Identity.ExecutablePath) {
        return $false
    }
    return $true
}

function Expand-TrackedProcesses {
    param(
        [Parameter(Mandatory)] [hashtable] $Tracked,
        [Parameter(Mandatory)] [hashtable] $ProcessTable
    )
    $verifiedLive = @{}
    foreach ($identity in $Tracked.Values) {
        if ($ProcessTable.ContainsKey($identity.ProcessId) -and
            (Test-ProcessIdentity $identity $ProcessTable[$identity.ProcessId])) {
            $verifiedLive[$identity.ProcessId] = $true
        }
    }
    $changed = $true
    while ($changed) {
        $changed = $false
        foreach ($item in $ProcessTable.Values) {
            $processId = [int] $item.ProcessId
            $parentId = [int] $item.ParentProcessId
            if (-not $Tracked.ContainsKey($processId) -and $verifiedLive.ContainsKey($parentId)) {
                $Tracked[$processId] = New-ProcessIdentity $item
                $verifiedLive[$processId] = $true
                $changed = $true
            }
        }
    }
}

function Get-TrackedSnapshot {
    param(
        [Parameter(Mandatory)] [hashtable] $Tracked,
        [Parameter(Mandatory)] [int] $RootProcessId
    )
    $table = Get-ProcessTable
    Expand-TrackedProcesses -Tracked $Tracked -ProcessTable $table
    $live = @(
        $Tracked.Values | Where-Object {
            $table.ContainsKey($_.ProcessId) -and
            (Test-ProcessIdentity $_ $table[$_.ProcessId])
        }
    )
    [long] $rootWorkingSet = 0
    [long] $treeWorkingSet = 0
    foreach ($identity in $live) {
        try {
            $process = Get-Process -Id $identity.ProcessId -ErrorAction Stop
            [long] $workingSet = $process.WorkingSet64
            $treeWorkingSet += $workingSet
            if ($identity.ProcessId -eq $RootProcessId) { $rootWorkingSet = $workingSet }
        }
        catch {
            # A verified process may exit between CIM identity capture and memory sampling.
        }
    }
    return [pscustomobject]@{
        Live = $live
        PowerShellCount = @($live | Where-Object { $_.Name -ieq 'powershell.exe' }).Count
        RootWorkingSetBytes = $rootWorkingSet
        TreeWorkingSetBytes = $treeWorkingSet
    }
}

function Get-Median {
    param([Parameter(Mandatory)] [long[]] $Values)
    if ($Values.Count -eq 0) { return [long] 0 }
    $sorted = @($Values | Sort-Object)
    $middle = [int] [Math]::Floor($sorted.Count / 2)
    if (($sorted.Count % 2) -eq 1) { return [long] $sorted[$middle] }
    return [long] [Math]::Round(($sorted[$middle - 1] + $sorted[$middle]) / 2.0)
}

function Test-BinaryContainsAscii {
    param(
        [Parameter(Mandatory)] [string] $Path,
        [Parameter(Mandatory)] [string] $Text
    )
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $needle = [System.Text.Encoding]::ASCII.GetBytes($Text)
    if ($needle.Length -eq 0 -or $bytes.Length -lt $needle.Length) { return $false }
    for ($index = 0; $index -le $bytes.Length - $needle.Length; $index++) {
        $match = $true
        for ($offset = 0; $offset -lt $needle.Length; $offset++) {
            if ($bytes[$index + $offset] -ne $needle[$offset]) {
                $match = $false
                break
            }
        }
        if ($match) { return $true }
    }
    return $false
}

function Get-StateGuardFingerprint {
    param([Parameter(Mandatory)] [string] $Root)
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return '<absent>' }
    $entries = @()
    foreach ($file in Get-ChildItem -LiteralPath $Root -File -Recurse -Force -ErrorAction Stop) {
        $relative = $file.FullName.Substring($Root.Length).TrimStart('\', '/')
        $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
        $entries += "$relative|$($file.Length)|$hash"
    }
    return ($entries | Sort-Object) -join "`n"
}

function Read-ValidatedFixture {
    param(
        [Parameter(Mandatory)] [int] $PaneCount,
        [Parameter(Mandatory)] [string] $ProjectDirectory
    )
    $path = Join-Path $fixtureRoot "phase6-$PaneCount-pane.projects.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing sanitized Phase 6 fixture for $PaneCount panes."
    }
    $catalog = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if (@($catalog.Projects).Count -ne 1) { throw 'A Phase 6 fixture must contain one project.' }
    $project = @($catalog.Projects)[0]
    if (@($project.Terminals).Count -ne $PaneCount) {
        throw "The $PaneCount-pane fixture has an unexpected terminal count."
    }
    if ($project.FolderPath -ne $fixtureToken) {
        throw 'The Phase 6 fixture project path token changed.'
    }
    $terminalIds = @{}
    foreach ($terminal in @($project.Terminals)) {
        if ($terminal.StartDirectory -ne $fixtureToken -or
            $null -ne $terminal.CodexThreadId -or
            $null -ne $terminal.GrokSessionId -or
            $terminal.CompletionPending -ne $false) {
            throw 'A Phase 6 fixture contains resumable or unread user state.'
        }
        if ($terminalIds.ContainsKey([string] $terminal.Id)) {
            throw 'A Phase 6 fixture contains a duplicate terminal ID.'
        }
        $terminalIds[[string] $terminal.Id] = $true
        $terminal.StartDirectory = $ProjectDirectory
    }
    $project.FolderPath = $ProjectDirectory
    return $catalog
}

function ConvertTo-CanonicalWorkspace {
    param([Parameter(Mandatory)] $Catalog)
    $projects = @(
        foreach ($legacyProject in @($Catalog.Projects)) {
            [ordered]@{
                id = [string] $legacyProject.Id
                name = [string] $legacyProject.Name
                folderPath = [string] $legacyProject.FolderPath
                terminals = @(
                    foreach ($legacyTerminal in @($legacyProject.Terminals)) {
                        [ordered]@{
                            id = [string] $legacyTerminal.Id
                            name = [string] $legacyTerminal.Name
                            startDirectory = [string] $legacyTerminal.StartDirectory
                            codexThreadId = $null
                            grokSessionId = $null
                            createdAtUtc = [string] $legacyTerminal.CreatedAtUtc
                            completionPending = $false
                            legacyExtensions = [ordered]@{}
                        }
                    }
                )
                paneWidthRatios = $legacyProject.PaneWidthRatios
                legacyExtensions = [ordered]@{}
            }
        }
    )
    $projectId = [string] $Catalog.SelectedProjectId
    return [ordered]@{
        schemaVersion = 1
        revision = 1
        writtenAtUtc = '2026-01-01T00:00:00Z'
        selectedProjectId = $projectId
        projects = $projects
        tabs = @(
            [ordered]@{
                id = "phase6-tab-$projectId"
                kind = 'project'
                title = [string] $projects[0].name
                projectId = $projectId
                browser = $null
                output = $null
                extensions = [ordered]@{}
            }
        )
        activeTabId = "phase6-tab-$projectId"
        importProvenance = $null
        extensions = [ordered]@{}
        legacyExtensions = [ordered]@{}
    }
}

function Stop-VerifiedProcessTree {
    param(
        [Parameter(Mandatory)] [hashtable] $Tracked,
        [Parameter(Mandatory)] [int] $RootProcessId
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)
    do {
        $table = Get-ProcessTable
        Expand-TrackedProcesses -Tracked $Tracked -ProcessTable $table
        $live = @(
            $Tracked.Values | Where-Object {
                $table.ContainsKey($_.ProcessId) -and
                (Test-ProcessIdentity $_ $table[$_.ProcessId])
            }
        )
        if ($live.Count -eq 0) { return }

        # Stop the verified root first so it cannot create more descendants while
        # cleanup walks the already-observed process tree.
        foreach ($identity in @($live | Sort-Object @{ Expression = {
            if ($_.ProcessId -eq $RootProcessId) { 0 } else { 1 }
        } }, CreationTicks)) {
            $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($identity.ProcessId)"
            if ($null -eq $current -or -not (Test-ProcessIdentity $identity $current)) { continue }
            try {
                $process = Get-Process -Id $identity.ProcessId -ErrorAction Stop
                if (-not $process.HasExited) { $process.Kill() }
                [void] $process.WaitForExit(2000)
                $process.Dispose()
            }
            catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
                # The identity was verified immediately before the process exited.
            }
            catch [System.ArgumentException] {
                # GetProcessById/Get-Process can race a normal process exit.
            }
        }
        Start-Sleep -Milliseconds 75
    } while ([DateTime]::UtcNow -lt $deadline)

    $remaining = Get-TrackedSnapshot -Tracked $Tracked -RootProcessId $RootProcessId
    if (@($remaining.Live).Count -gt 0) {
        throw 'Verified processes remained after emergency cleanup.'
    }
}

function Invoke-Measurement {
    param(
        [Parameter(Mandatory)] [ValidateSet('rust', 'csharp')] [string] $Implementation,
        [Parameter(Mandatory)] [string] $Executable,
        [Parameter(Mandatory)] [int] $PaneCount,
        [Parameter(Mandatory)] [string] $RunRoot
    )
    [void] [System.IO.Directory]::CreateDirectory($RunRoot)
    $binDirectory = Join-Path $RunRoot 'bin'
    $projectDirectory = Join-Path $RunRoot 'project'
    $catalogDirectory = Join-Path $RunRoot 'catalog'
    $stateRoot = Join-Path $RunRoot 'state-root'
    $providerRoot = Join-Path $RunRoot 'providers'
    foreach ($directory in @($binDirectory, $projectDirectory, $catalogDirectory, $stateRoot, $providerRoot)) {
        [void] [System.IO.Directory]::CreateDirectory($directory)
    }
    $copiedExecutable = Join-Path $binDirectory ([System.IO.Path]::GetFileName($Executable))
    Copy-Item -LiteralPath $Executable -Destination $copiedExecutable -Force
    $catalog = Read-ValidatedFixture -PaneCount $PaneCount -ProjectDirectory $projectDirectory
    $catalogPath = Join-Path $catalogDirectory 'projects.json'
    Write-Utf8Json -Value $catalog -Path $catalogPath
    $canonicalPath = Join-Path $stateRoot 'state\workspace-v1.json'

    Set-ProcessEnvironment 'CODEX_HOME' (Join-Path $providerRoot 'codex')
    Set-ProcessEnvironment 'GROK_HOME' (Join-Path $providerRoot 'grok')
    Set-ProcessEnvironment 'POWERWORKSPACE_PROJECTS_PATH' $catalogPath
    Set-ProcessEnvironment 'POWERWORKSPACE_DISABLE_AUTO_RESUME' '1'
    Set-ProcessEnvironment 'IHATECODING_RUST_PREVIEW_PROJECTS_DIR' (Join-Path $stateRoot 'phase3-preview')

    if ($Implementation -eq 'rust') {
        if (-not $RustImportFromLegacy) {
            Write-Utf8Json -Value (ConvertTo-CanonicalWorkspace $catalog) -Path $canonicalPath
        }
        Set-ProcessEnvironment $RustStateRootEnvironmentVariable $stateRoot
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_TEST' $null
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_ADD_ONLY' $null
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_RESTORE_ONLY' $null
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_PROJECT_FOLDER' $null
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_HOLD_MS' $null
    }
    else {
        Set-ProcessEnvironment $RustStateRootEnvironmentVariable $null
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_TEST' '1'
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_VISIBLE' '1'
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_ADD_ONLY' '1'
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_RESTORE_ONLY' '1'
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_PROJECT_FOLDER' $projectDirectory
        Set-ProcessEnvironment 'POWERWORKSPACE_SMOKE_HOLD_MS' '10000'
    }

    $app = $null
    $exitHandle = [IntPtr]::Zero
    $tracked = @{}
    $samples = [System.Collections.Generic.List[object]]::new()
    $steadySamples = [System.Collections.Generic.List[object]]::new()
    $stdoutPath = Join-Path $RunRoot 'app.stdout.log'
    $stderrPath = Join-Path $RunRoot 'app.stderr.log'
    $startup = [System.Diagnostics.Stopwatch]::StartNew()
    [long] $firstReadyMilliseconds = -1
    try {
        $app = Start-Process -FilePath $copiedExecutable -WorkingDirectory $binDirectory -PassThru `
            -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
        $exitHandle = $app.Handle
        $rootRecord = $null
        $identityDeadline = [DateTime]::UtcNow.AddSeconds(5)
        do {
            $rootRecord = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $($app.Id)"
            if ($null -ne $rootRecord) { break }
            Start-Sleep -Milliseconds 20
        } while ([DateTime]::UtcNow -lt $identityDeadline)
        if ($null -eq $rootRecord) { throw 'The launched root process identity was not observable.' }
        $tracked[$app.Id] = New-ProcessIdentity $rootRecord
        $rootPath = [string] $rootRecord.ExecutablePath
        if ($rootPath -and
            -not [System.StringComparer]::OrdinalIgnoreCase.Equals(
                [System.IO.Path]::GetFullPath($rootPath),
                [System.IO.Path]::GetFullPath($copiedExecutable))) {
            throw 'The launched process path did not match the isolated executable copy.'
        }

        $readyStableSince = $null
        $startupDeadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
        do {
            if ($app.HasExited) {
                throw "The application exited before readiness (code $($app.ExitCode))."
            }
            $snapshot = Get-TrackedSnapshot -Tracked $tracked -RootProcessId $app.Id
            $samples.Add($snapshot)
            if ($snapshot.PowerShellCount -gt $PaneCount) {
                throw "Observed more PowerShell children than the $PaneCount-pane fixture allows."
            }
            if ($snapshot.PowerShellCount -eq $PaneCount) {
                if ($firstReadyMilliseconds -lt 0) { $firstReadyMilliseconds = $startup.ElapsedMilliseconds }
                if ($null -eq $readyStableSince) { $readyStableSince = [DateTime]::UtcNow }
                if (([DateTime]::UtcNow - $readyStableSince).TotalMilliseconds -ge 500) { break }
            }
            else {
                $readyStableSince = $null
            }
            Start-Sleep -Milliseconds 50
        } while ([DateTime]::UtcNow -lt $startupDeadline)
        if ($null -eq $readyStableSince -or
            ([DateTime]::UtcNow - $readyStableSince).TotalMilliseconds -lt 500) {
            $maximumObserved = @($samples | ForEach-Object { $_.PowerShellCount } | Measure-Object -Maximum).Maximum
            $liveNames = @($snapshot.Live | ForEach-Object { $_.Name } | Sort-Object -Unique) -join ', '
            throw "The application did not keep exactly $PaneCount PowerShell children stable (maximum observed: $maximumObserved; live process names: $liveNames)."
        }
        $readyMilliseconds = $startup.ElapsedMilliseconds

        $steadyDeadline = [DateTime]::UtcNow.AddMilliseconds($SteadySampleMilliseconds)
        do {
            if ($app.HasExited) { throw 'The application exited during steady-state sampling.' }
            $snapshot = Get-TrackedSnapshot -Tracked $tracked -RootProcessId $app.Id
            if ($snapshot.PowerShellCount -ne $PaneCount) {
                throw 'The PowerShell child count changed during steady-state sampling.'
            }
            $samples.Add($snapshot)
            $steadySamples.Add($snapshot)
            Start-Sleep -Milliseconds 100
        } while ([DateTime]::UtcNow -lt $steadyDeadline)

        [void] (Get-TrackedSnapshot -Tracked $tracked -RootProcessId $app.Id)
        $shutdown = [System.Diagnostics.Stopwatch]::StartNew()
        if (-not $app.CloseMainWindow()) { throw 'The application did not expose a closable main window.' }
        if (-not $app.WaitForExit($ShutdownTimeoutSeconds * 1000)) {
            throw "The application did not exit within $ShutdownTimeoutSeconds seconds."
        }
        # Complete redirected stream draining and refresh ExitCode after the timed wait.
        $app.WaitForExit()
        $app.Refresh()
        $emptySamples = 0
        $remaining = @()
        $orphanDeadline = [DateTime]::UtcNow.AddSeconds($ShutdownTimeoutSeconds)
        do {
            $snapshot = Get-TrackedSnapshot -Tracked $tracked -RootProcessId $app.Id
            $remaining = @($snapshot.Live | Where-Object { $_.ProcessId -ne $app.Id })
            if ($remaining.Count -eq 0) { $emptySamples++ } else { $emptySamples = 0 }
            if ($emptySamples -ge 4) { break }
            Start-Sleep -Milliseconds 75
        } while ([DateTime]::UtcNow -lt $orphanDeadline)
        $shutdown.Stop()
        if ($remaining.Count -gt 0 -or $emptySamples -lt 4) {
            throw 'Verified descendants remained after application shutdown.'
        }
        [uint32] $exitCode = 0
        if (-not [Phase6NativeMethods]::GetExitCodeProcess($exitHandle, [ref] $exitCode)) {
            throw 'The application exit code could not be verified.'
        }
        if ($exitCode -ne 0) { throw "The application returned exit code $exitCode." }

        $legacyImportVerified = $false
        if ($Implementation -eq 'rust' -and $RustImportFromLegacy) {
            if (-not (Test-Path -LiteralPath $canonicalPath -PathType Leaf)) {
                throw 'The Rust production catalog import did not create canonical state.'
            }
            $imported = Get-Content -LiteralPath $canonicalPath -Raw | ConvertFrom-Json
            if (@($imported.projects).Count -ne 1 -or
                @($imported.projects[0].terminals).Count -ne $PaneCount -or
                $null -eq $imported.importProvenance) {
                throw 'The Rust production catalog import did not preserve the fixture workspace.'
            }
            $legacyImportVerified = $true
        }

        $rootValues = [long[]] @($samples | ForEach-Object { $_.RootWorkingSetBytes })
        $treeValues = [long[]] @($samples | ForEach-Object { $_.TreeWorkingSetBytes })
        $steadyRoot = [long[]] @($steadySamples | ForEach-Object { $_.RootWorkingSetBytes })
        $steadyTree = [long[]] @($steadySamples | ForEach-Object { $_.TreeWorkingSetBytes })
        return [ordered]@{
            implementation = $Implementation
            paneCount = $PaneCount
            result = 'pass'
            startupMilliseconds = $firstReadyMilliseconds
            readyMilliseconds = $readyMilliseconds
            shutdownMilliseconds = $shutdown.ElapsedMilliseconds
            peakRootWorkingSetBytes = [long] (($rootValues | Measure-Object -Maximum).Maximum)
            steadyRootWorkingSetBytes = Get-Median $steadyRoot
            peakTreeWorkingSetBytes = [long] (($treeValues | Measure-Object -Maximum).Maximum)
            steadyTreeWorkingSetBytes = Get-Median $steadyTree
            trackedProcessCount = $tracked.Count
            remainingProcessCount = 0
            legacyImportVerified = $legacyImportVerified
        }
    }
    catch {
        $details = [System.Collections.Generic.List[string]]::new()
        foreach ($logPath in @($stderrPath, $stdoutPath)) {
            if (-not (Test-Path -LiteralPath $logPath -PathType Leaf)) { continue }
            $stream = $null
            $reader = $null
            try {
                $stream = [System.IO.FileStream]::new(
                    $logPath,
                    [System.IO.FileMode]::Open,
                    [System.IO.FileAccess]::Read,
                    [System.IO.FileShare]::ReadWrite
                )
                $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $true, 4096, $true)
                $log = $reader.ReadToEnd()
            }
            catch { continue }
            finally {
                if ($null -ne $reader) { $reader.Dispose() }
                if ($null -ne $stream) { $stream.Dispose() }
            }
            if ([string]::IsNullOrWhiteSpace($log)) { continue }
            if ($log.Length -gt 4096) { $log = $log.Substring($log.Length - 4096) }
            $details.Add((Get-SafeMessage $log.Trim()))
        }
        $message = $_.Exception.Message
        if ($details.Count -gt 0) { $message += " Child diagnostic: $($details -join ' | ')" }
        throw $message
    }
    finally {
        if ($null -ne $app) {
            try {
                Stop-VerifiedProcessTree -Tracked $tracked -RootProcessId $app.Id
            }
            finally {
                $app.Dispose()
            }
        }
    }
}

function Resolve-CSharpBaseline {
    if ($SkipCSharp) { return $null }
    if ($CSharpExecutable) {
        $resolved = [System.IO.Path]::GetFullPath($CSharpExecutable)
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            throw 'The explicitly requested C# baseline executable does not exist.'
        }
        return [pscustomobject]@{ Path = $resolved; Source = 'explicit-executable' }
    }
    if ($BuildCSharpBaselineFromTag) {
        if ($CSharpBaselineTag -notmatch '^[A-Za-z0-9._/-]+$') {
            throw 'The C# baseline tag contains unsupported characters.'
        }
        & git -C $repoRoot rev-parse --verify --quiet "refs/tags/$CSharpBaselineTag" *> $null
        if ($LASTEXITCODE -ne 0) { throw 'The requested C# baseline tag does not exist.' }
        $archive = Join-Path $smokeRoot 'csharp-baseline.zip'
        & git -C $repoRoot archive --format=zip --output=$archive $CSharpBaselineTag
        if ($LASTEXITCODE -ne 0) { throw 'The C# baseline tag could not be archived.' }
        $sourceRoot = Join-Path $smokeRoot 'csharp-source'
        Expand-Archive -LiteralPath $archive -DestinationPath $sourceRoot
        $project = Join-Path $sourceRoot 'PowerWorkspace\PowerWorkspace.csproj'
        $publish = Join-Path $smokeRoot 'csharp-publish'
        & dotnet publish $project -c Release -r win-x64 --self-contained false -o $publish --nologo
        if ($LASTEXITCODE -ne 0) { throw 'The C# baseline tag did not build successfully.' }
        $executable = Join-Path $publish 'IHATECODING.exe'
        if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
            throw 'The C# baseline build did not produce IHATECODING.exe.'
        }
        return [pscustomobject]@{ Path = $executable; Source = "git-tag:$CSharpBaselineTag" }
    }
    $workspaceExecutable = Join-Path $repoRoot 'IHATECODING.exe'
    if (Test-Path -LiteralPath $workspaceExecutable -PathType Leaf) {
        return [pscustomobject]@{ Path = $workspaceExecutable; Source = 'workspace-executable' }
    }
    return $null
}

function Get-SafeMessage {
    param([Parameter(Mandatory)] [string] $Message)
    $safe = $Message.Replace($smokeRoot, '<temp>')
    $safe = $safe.Replace($repoRoot, '<repo>')
    $profile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
    if ($profile) { $safe = $safe.Replace($profile, '<user-profile>') }
    return $safe
}

function Remove-VerifiedSmokeRoot {
    if (-not (Test-Path -LiteralPath $smokeRoot -PathType Container)) { return }
    $resolved = [System.IO.Path]::GetFullPath($smokeRoot).TrimEnd('\', '/')
    $expected = Join-Path $tempBase "$smokePrefix$token"
    if (-not [System.StringComparer]::OrdinalIgnoreCase.Equals($resolved, $expected)) {
        throw 'Refusing cleanup because the Phase 6 root escaped the verified temp path.'
    }
    $item = Get-Item -LiteralPath $resolved -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing cleanup because the Phase 6 root became a reparse point.'
    }
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf) -or
        [System.IO.File]::ReadAllText($markerPath) -ne $token) {
        throw 'Refusing cleanup because the Phase 6 ownership marker is missing or changed.'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}

$report = [ordered]@{
    schemaVersion = 1
    generatedAtUtc = [DateTimeOffset]::UtcNow.ToString('O')
    result = 'fail'
    configuration = [ordered]@{
        paneCounts = @($PaneCounts | Sort-Object -Unique)
        startupTimeoutSeconds = $StartupTimeoutSeconds
        shutdownTimeoutSeconds = $ShutdownTimeoutSeconds
        steadySampleMilliseconds = $SteadySampleMilliseconds
        csharpBaselineTag = $CSharpBaselineTag
        rustImportFromLegacy = [bool] $RustImportFromLegacy
    }
    implementations = @()
    runs = @()
    comparisons = @()
    errors = @()
}
$fatal = $null

try {
    if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
        throw 'Phase 6 process comparison is Windows-only.'
    }
    Add-Type @'
using System;
using System.Runtime.InteropServices;

public static class Phase6NativeMethods
{
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr processHandle, out uint exitCode);
}
'@
    [void] [System.IO.Directory]::CreateDirectory($smokeRoot)
    [System.IO.File]::WriteAllText($markerPath, $token, $utf8WithoutBom)

    $resolvedRust = [System.IO.Path]::GetFullPath($RustExecutable)
    if (-not (Test-Path -LiteralPath $resolvedRust -PathType Leaf)) {
        throw 'The Rust release executable does not exist.'
    }
    if (-not (Test-BinaryContainsAscii $resolvedRust $RustStateRootEnvironmentVariable)) {
        throw "The Rust binary does not advertise the required isolated state hook $RustStateRootEnvironmentVariable. Refusing to launch it against user state."
    }
    $isolatedStateRoot = [System.IO.Path]::GetFullPath((Join-Path $smokeRoot 'probe-state'))
    $productionStateRoot = Join-Path (
        [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    ) 'com.ihatecoding.preview'
    if ([System.StringComparer]::OrdinalIgnoreCase.Equals($isolatedStateRoot, $productionStateRoot)) {
        throw 'The isolated Rust state root unexpectedly equals the production state root.'
    }
    $productionBefore = Get-StateGuardFingerprint $productionStateRoot

    $report.implementations += [ordered]@{
        implementation = 'rust'
        source = 'explicit-release-executable'
        sha256 = (Get-FileHash -LiteralPath $resolvedRust -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    $csharp = Resolve-CSharpBaseline
    if ($null -eq $csharp -and -not $SkipCSharp) {
        throw 'No C# baseline is available. Provide -CSharpExecutable, request the baseline tag build, or explicitly use -SkipCSharp for a Rust-only diagnostic.'
    }
    if ($null -ne $csharp) {
        $report.implementations += [ordered]@{
            implementation = 'csharp'
            source = $csharp.Source
            sha256 = (Get-FileHash -LiteralPath $csharp.Path -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    }

    foreach ($paneCount in @($PaneCounts | Sort-Object -Unique)) {
        try {
            $report.runs += Invoke-Measurement 'rust' $resolvedRust $paneCount (Join-Path $smokeRoot "rust-$paneCount")
        }
        catch {
            $report.runs += [ordered]@{
                implementation = 'rust'
                paneCount = $paneCount
                result = 'fail'
                error = Get-SafeMessage $_.Exception.Message
            }
        }
        if ($null -ne $csharp) {
            try {
                $report.runs += Invoke-Measurement 'csharp' $csharp.Path $paneCount (Join-Path $smokeRoot "csharp-$paneCount")
            }
            catch {
                $report.runs += [ordered]@{
                    implementation = 'csharp'
                    paneCount = $paneCount
                    result = 'fail'
                    error = Get-SafeMessage $_.Exception.Message
                }
            }
        }
    }

    $productionAfter = Get-StateGuardFingerprint $productionStateRoot
    if ($productionBefore -ne $productionAfter) {
        throw 'The production Rust state root changed during isolated comparison.'
    }

    if ($null -ne $csharp) {
        foreach ($paneCount in @($PaneCounts | Sort-Object -Unique)) {
            $rustRun = $report.runs | Where-Object {
                $_.implementation -eq 'rust' -and $_.paneCount -eq $paneCount -and $_.result -eq 'pass'
            } | Select-Object -First 1
            $csharpRun = $report.runs | Where-Object {
                $_.implementation -eq 'csharp' -and $_.paneCount -eq $paneCount -and $_.result -eq 'pass'
            } | Select-Object -First 1
            if ($null -ne $rustRun -and $null -ne $csharpRun) {
                $report.comparisons += [ordered]@{
                    paneCount = $paneCount
                    startupMillisecondsDelta = $rustRun.startupMilliseconds - $csharpRun.startupMilliseconds
                    readyMillisecondsDelta = $rustRun.readyMilliseconds - $csharpRun.readyMilliseconds
                    shutdownMillisecondsDelta = $rustRun.shutdownMilliseconds - $csharpRun.shutdownMilliseconds
                    steadyTreeWorkingSetBytesDelta = $rustRun.steadyTreeWorkingSetBytes - $csharpRun.steadyTreeWorkingSetBytes
                    peakTreeWorkingSetBytesDelta = $rustRun.peakTreeWorkingSetBytes - $csharpRun.peakTreeWorkingSetBytes
                }
            }
        }
    }
    if (@($report.runs).Count -eq 0 -or @($report.runs | Where-Object { $_.result -ne 'pass' }).Count -gt 0) {
        throw 'One or more Phase 6 measurement runs failed.'
    }
    $report.result = 'pass'
}
catch {
    $fatal = Get-SafeMessage $_.Exception.Message
    $report.errors += $fatal
    $report.result = 'fail'
}
finally {
    $resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
    $finalizationErrors = [System.Collections.Generic.List[string]]::new()
    try { Restore-ProcessEnvironment }
    catch { $finalizationErrors.Add((Get-SafeMessage $_.Exception.Message)) }
    try { Remove-VerifiedSmokeRoot }
    catch { $finalizationErrors.Add((Get-SafeMessage $_.Exception.Message)) }
    if ($finalizationErrors.Count -gt 0) {
        foreach ($message in $finalizationErrors) { $report.errors += $message }
        $report.result = 'fail'
        if ($null -eq $fatal) { $fatal = $finalizationErrors[0] }
    }
    try {
        Write-Utf8Json -Value $report -Path $resolvedOutput
        Write-Output $resolvedOutput
    }
    catch {
        if ($null -eq $fatal) { $fatal = Get-SafeMessage $_.Exception.Message }
    }
}

if ($null -ne $fatal) { throw $fatal }
