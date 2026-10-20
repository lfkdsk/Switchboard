<#
  Build the embedded Node runtime that ships next to Switchboard.exe:
    <Dest>\node.exe    the Node binary
    <Dest>\cli\        the daemon sources + production node_modules

  A tray app started at sign-in can't rely on the user having Node on PATH (or
  the right version of it), so we bundle our own.

  Usage:  scripts\fetch-runtime.ps1 -Dest <dir>

  Env:
    NODE_VERSION=v20.18.0   Node release to fetch (same default as macOS)
    NODE_ARCH=x64           x64 | arm64 (default: this machine's)
#>
param([Parameter(Mandatory = $true)][string]$Dest)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue' # Invoke-WebRequest is painfully slow with it

$WindowsDir = Split-Path $PSScriptRoot -Parent
$RepoDir = Split-Path $WindowsDir -Parent
$NodeVersion = if ($env:NODE_VERSION) { $env:NODE_VERSION } else { 'v20.18.0' }
$Arch = if ($env:NODE_ARCH) { $env:NODE_ARCH }
        elseif ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' }
        else { 'x64' }

$Work = Join-Path ([IO.Path]::GetTempPath()) ("switchboard-runtime-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $Work | Out-Null
try {
  $dist = "node-$NodeVersion-win-$Arch"
  $base = "https://nodejs.org/dist/$NodeVersion"
  Write-Host "  download $base/$dist.zip"
  Invoke-WebRequest "$base/$dist.zip" -OutFile "$Work\$dist.zip"
  Invoke-WebRequest "$base/SHASUMS256.txt" -OutFile "$Work\SHASUMS256.txt"

  # Check the download against the release's own manifest before shipping it.
  $line = Get-Content "$Work\SHASUMS256.txt" | Where-Object { $_ -match "^[0-9a-f]{64}\s+$([regex]::Escape("$dist.zip"))$" }
  if (-not $line) { throw "no checksum for $dist.zip in SHASUMS256.txt" }
  $expected = ($line -split '\s+')[0]
  $actual = (Get-FileHash "$Work\$dist.zip" -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch for $dist.zip ($actual, want $expected)" }

  # bsdtar reads zip and is far faster than Expand-Archive on npm's many files.
  tar -xf "$Work\$dist.zip" -C $Work
  if ($LASTEXITCODE) { throw "could not extract $dist.zip" }
  $NodeDir = Join-Path $Work $dist

  New-Item -ItemType Directory -Force -Path $Dest, "$Dest\cli" | Out-Null
  Copy-Item "$NodeDir\node.exe" "$Dest\node.exe"

  # Everything below runs on the Node we are shipping, so node-pty's native
  # addon (prebuilt or compiled) matches it.
  $env:PATH = "$NodeDir;$env:PATH"
  $npm = Join-Path $NodeDir 'npm.cmd'

  # Stage the daemon from `npm pack` rather than copying named files: the
  # package's own `files` field already declares exactly what the daemon needs
  # to run, so this stays byte-identical to the published package.
  Push-Location "$RepoDir\cli"
  try {
    $tgz = (& $npm pack --silent --pack-destination $Work | Select-Object -Last 1).Trim()
    if ($LASTEXITCODE) { throw "npm pack failed" }
  } finally { Pop-Location }
  tar -xzf "$Work\$tgz" -C $Work
  if ($LASTEXITCODE) { throw "could not extract $tgz" }
  Copy-Item "$Work\package\*" "$Dest\cli" -Recurse -Force

  Write-Host "  installing cli production deps"
  Push-Location "$Dest\cli"
  try {
    & $npm install --omit=dev --no-audit --no-fund
    if ($LASTEXITCODE) { throw "npm install failed" }
  } finally { Pop-Location }

  Write-Host "OK: runtime staged at $Dest"
} finally {
  Remove-Item -Recurse -Force $Work -ErrorAction SilentlyContinue
}
