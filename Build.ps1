[CmdletBinding()]
param(
    [Parameter()]
    [switch] $NoInstaller,

    [Parameter()]
    [switch] $SkipTests,

    [Parameter()]
    [switch] $Cutover,

    [Parameter()]
    [switch] $AllowUnsignedLocalCutover,

    [Parameter()]
    [string] $CandidatePath,

    [Parameter()]
    [string] $ApprovedPublisherThumbprint
)

$ErrorActionPreference = 'Stop'
$desktop = Join-Path $PSScriptRoot 'apps\ihc-desktop'
$cargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
$defaultReleaseExecutable = Join-Path $desktop 'src-tauri\target\release\ihatecoding.exe'
$releaseExecutable = $defaultReleaseExecutable
$target = Join-Path $PSScriptRoot 'IHATECODING.exe'

if ($CandidatePath) {
    if (-not $Cutover) {
        throw '-CandidatePath is accepted only with -Cutover.'
    }
    $releaseExecutable = [System.IO.Path]::GetFullPath($CandidatePath)
}
else {
    if (-not (Test-Path -LiteralPath (Join-Path $cargoBin 'cargo.exe') -PathType Leaf)) {
        throw 'Rust stable is required. Install it from https://rustup.rs and run this script again.'
    }
    if ($null -eq (Get-Command npm -ErrorAction SilentlyContinue)) {
        throw 'Node.js 22 or newer is required.'
    }
}

function Get-AvailablePreviousBuildPath {
    $index = 0
    do {
        $suffix = if ($index -eq 0) { '' } else { ".$index" }
        $candidate = Join-Path $PSScriptRoot "IHATECODING.previous-build$suffix.exe"
        $index++
    } while (Test-Path -LiteralPath $candidate)
    return $candidate
}

function Test-IHATECODINGRustCandidate {
    param([Parameter(Mandatory)] [string] $Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $version = (Get-Item -LiteralPath $Path).VersionInfo
    if ($version.FileDescription -ne 'IHATECODING' -or
        $version.ProductName -ne 'IHATECODING' -or
        $version.CompanyName -ne 'ihatecoding' -or
        -not [string]::IsNullOrEmpty($version.OriginalFilename)) {
        return $false
    }
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
    return $ascii.Contains('IHATECODING_PHASE6_STATE_ROOT')
}

if (-not $CandidatePath) {
    $env:Path = "$cargoBin;$env:Path"
    Push-Location $desktop
    try {
        Write-Host 'Restoring frontend dependencies...' -ForegroundColor Cyan
        npm ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency restore failed.' }

        if (-not $SkipTests) {
            Write-Host 'Running frontend and Rust verification...' -ForegroundColor Cyan
            npm test
            if ($LASTEXITCODE -ne 0) { throw 'Frontend tests failed.' }
            cargo test --manifest-path .\src-tauri\Cargo.toml --all-targets
            if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
            cargo clippy --manifest-path .\src-tauri\Cargo.toml --all-targets --all-features -- -D warnings
            if ($LASTEXITCODE -ne 0) { throw 'Rust lint failed.' }
        }

        Write-Host 'Building IHATECODING Rust production application...' -ForegroundColor Cyan
        if ($NoInstaller) {
            npx tauri build --no-bundle --ci
        }
        else {
            npx tauri build --bundles nsis --no-sign --ci
        }
        if ($LASTEXITCODE -ne 0) { throw 'IHATECODING Rust build failed.' }
    }
    finally {
        Pop-Location
    }
}

if (-not (Test-Path -LiteralPath $releaseExecutable -PathType Leaf)) {
    throw "The production build did not create $releaseExecutable"
}

if ($CandidatePath) {
    Write-Host "Selected candidate: $releaseExecutable" -ForegroundColor Green
}
else {
    Write-Host "Built candidate: $releaseExecutable" -ForegroundColor Green
}
if (-not $NoInstaller -and -not $CandidatePath) {
    Write-Host (Join-Path $desktop 'src-tauri\target\release\bundle\nsis') -ForegroundColor Green
}

if (-not $Cutover) {
    Write-Host 'The current default executable was not changed. Use -Cutover only after the release checks pass.' -ForegroundColor Yellow
    return
}

if (-not (Test-IHATECODINGRustCandidate $releaseExecutable)) {
    throw 'Cutover rejected a candidate that is not the expected IHATECODING Rust application.'
}

$signature = Get-AuthenticodeSignature -LiteralPath $releaseExecutable
if ($signature.Status -eq [System.Management.Automation.SignatureStatus]::NotSigned) {
    if (-not $AllowUnsignedLocalCutover) {
        throw 'Cutover requires a valid Authenticode signature. Use -AllowUnsignedLocalCutover only for an explicitly accepted local development build.'
    }
}
elseif ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "Cutover rejected an invalid Authenticode signature: $($signature.Status)"
}
else {
    $approved = ($ApprovedPublisherThumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    $actual = if ($null -eq $signature.SignerCertificate) {
        ''
    }
    else {
        ($signature.SignerCertificate.Thumbprint -replace '[^0-9A-Fa-f]', '').ToUpperInvariant()
    }
    if ($approved.Length -lt 40 -or
        -not [System.StringComparer]::OrdinalIgnoreCase.Equals($approved, $actual)) {
        throw 'Cutover rejected a candidate whose publisher thumbprint was not explicitly approved.'
    }
    if ($null -eq $signature.TimeStamperCertificate) {
        throw 'Cutover rejected a signed candidate without a timestamp certificate.'
    }
}

try {
    Copy-Item -LiteralPath $releaseExecutable -Destination $target -Force
}
catch [System.IO.IOException] {
    $previous = Get-AvailablePreviousBuildPath
    Move-Item -LiteralPath $target -Destination $previous
    Copy-Item -LiteralPath $releaseExecutable -Destination $target -Force
    Write-Host "The running previous build remains active and was preserved as: $previous" -ForegroundColor Yellow
}
catch [System.UnauthorizedAccessException] {
    $previous = Get-AvailablePreviousBuildPath
    Move-Item -LiteralPath $target -Destination $previous
    Copy-Item -LiteralPath $releaseExecutable -Destination $target -Force
    Write-Host "The running previous build remains active and was preserved as: $previous" -ForegroundColor Yellow
}

Write-Host "Cut over: $target" -ForegroundColor Green
