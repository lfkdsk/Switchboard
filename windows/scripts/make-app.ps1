<#
  Assemble the Windows app folder from the dotnet build output:
    build\Switchboard\Switchboard.exe (+ .exe.config)
    build\Switchboard\runtime\        embedded Node + cli (fetch-runtime.ps1)

  That folder is what the installer (installer\Switchboard.iss) and the
  portable zip both ship.

  Usage:
    scripts\make-app.ps1                      # release build + embedded runtime
    scripts\make-app.ps1 -Version 1.2.3       # stamp the version
    scripts\make-app.ps1 -SkipRuntime         # dev: falls back to env/PATH Node
#>
param(
  [string]$Version = '0.1.0',
  [string]$Configuration = 'Release',
  [switch]$SkipRuntime
)
$ErrorActionPreference = 'Stop'

$WindowsDir = Split-Path $PSScriptRoot -Parent
$App = Join-Path $WindowsDir 'build\Switchboard'

Write-Host "==> dotnet build -c $Configuration (version $Version)"
dotnet build "$WindowsDir\Switchboard.csproj" -c $Configuration "-p:Version=$Version" --nologo
if ($LASTEXITCODE) { throw "dotnet build failed" }
$Bin = Join-Path $WindowsDir "bin\$Configuration\net48"

Write-Host "==> assembling $App"
if (Test-Path $App) { Remove-Item -Recurse -Force $App }
New-Item -ItemType Directory -Force -Path $App | Out-Null
Copy-Item "$Bin\Switchboard.exe", "$Bin\Switchboard.exe.config" $App

if (-not $SkipRuntime) {
  Write-Host "==> embedding Node runtime"
  & "$PSScriptRoot\fetch-runtime.ps1" -Dest "$App\runtime"
} else {
  Write-Host "==> -SkipRuntime - app will fall back to env/PATH Node (dev only)"
}

Write-Host "OK: built $App"
