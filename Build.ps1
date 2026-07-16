$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'PowerWorkspace\PowerWorkspace.csproj'
$webTerminal = Join-Path $PSScriptRoot 'PowerWorkspace\WebTerminal'
$publish = Join-Path $PSScriptRoot 'publish'
$target = Join-Path $PSScriptRoot 'IHATECODING.exe'

function Get-AvailablePreviousBuildPath {
    $index = 0
    do {
        $suffix = if ($index -eq 0) { '' } else { ".$index" }
        $candidate = Join-Path $PSScriptRoot "IHATECODING.previous$suffix.exe"
        $index++
    } while (Test-Path -LiteralPath $candidate)
    return $candidate
}

Write-Host 'Building IHATECODING...' -ForegroundColor Cyan
$xtermBundle = Join-Path $webTerminal 'node_modules\@xterm\xterm\lib\xterm.js'
$nodePtyBundle = Join-Path $webTerminal 'node_modules\node-pty\prebuilds\win32-x64\conpty.node'
if (-not (Test-Path -LiteralPath $xtermBundle) -or
    -not (Test-Path -LiteralPath $nodePtyBundle)) {
    Write-Host 'Restoring terminal assets...' -ForegroundColor Cyan
    npm ci --prefix $webTerminal --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Terminal asset restore failed.' }
}
if (Test-Path -LiteralPath $publish) {
    $workspaceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $publishPath = [IO.Path]::GetFullPath($publish)
    if (-not $publishPath.StartsWith($workspaceRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a publish folder outside the workspace: $publishPath"
    }
    Remove-Item -LiteralPath $publishPath -Recurse -Force
}
dotnet publish $project -c Release -r win-x64 --self-contained false -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw 'IHATECODING build failed.' }

# Native dependencies can include debug symbols that users do not need.
Get-ChildItem -LiteralPath $publish -Filter '*.pdb' -File -Recurse | Remove-Item -Force

$publishedExecutable = Join-Path $publish 'IHATECODING.exe'
try {
    Copy-Item -LiteralPath $publishedExecutable -Destination $target -Force
}
catch [System.IO.IOException] {
    # Windows allows a running executable to be renamed, so keep the open build alive
    # and place the new build at the normal launch path without stopping user sessions.
    $previous = Get-AvailablePreviousBuildPath
    Move-Item -LiteralPath $target -Destination $previous
    Copy-Item -LiteralPath $publishedExecutable -Destination $target -Force
}

$legacyTargets = @(
    (Join-Path $PSScriptRoot 'XXCODING.exe'),
    (Join-Path $PSScriptRoot 'PowerWorkspace.exe')
)
foreach ($legacyTarget in $legacyTargets) {
    if (Test-Path -LiteralPath $legacyTarget) {
        try {
            Remove-Item -LiteralPath $legacyTarget -Force
        }
        catch {
            # A still-running legacy build can be renamed without closing its window.
            $previous = Get-AvailablePreviousBuildPath
            Move-Item -LiteralPath $legacyTarget -Destination $previous
        }
    }
}
Write-Host "Built: $target" -ForegroundColor Green
