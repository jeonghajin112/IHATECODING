$ErrorActionPreference = 'Stop'
$project = Join-Path $PSScriptRoot 'PowerWorkspace\PowerWorkspace.csproj'
$webTerminal = Join-Path $PSScriptRoot 'PowerWorkspace\WebTerminal'
$publish = Join-Path $PSScriptRoot 'publish-csharp'
$target = Join-Path $PSScriptRoot 'IHATECODING.CSharp.exe'

Write-Host 'Building the frozen C# rollback application...' -ForegroundColor Cyan
$xtermBundle = Join-Path $webTerminal 'node_modules\@xterm\xterm\lib\xterm.js'
$nodePtyBundle = Join-Path $webTerminal 'node_modules\node-pty\prebuilds\win32-x64\conpty.node'
if (-not (Test-Path -LiteralPath $xtermBundle) -or
    -not (Test-Path -LiteralPath $nodePtyBundle)) {
    npm ci --prefix $webTerminal --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'C# terminal asset restore failed.' }
}

if (Test-Path -LiteralPath $publish) {
    $workspaceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
    $publishPath = [IO.Path]::GetFullPath($publish)
    if (-not $publishPath.StartsWith(
        $workspaceRoot + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a publish folder outside the workspace: $publishPath"
    }
    Remove-Item -LiteralPath $publishPath -Recurse -Force
}

dotnet publish $project -c Release -r win-x64 --self-contained false -o $publish --nologo
if ($LASTEXITCODE -ne 0) { throw 'C# rollback build failed.' }
Get-ChildItem -LiteralPath $publish -Filter '*.pdb' -File -Recurse | Remove-Item -Force
Copy-Item -LiteralPath (Join-Path $publish 'IHATECODING.exe') -Destination $target -Force
Write-Host "Built rollback executable: $target" -ForegroundColor Green
