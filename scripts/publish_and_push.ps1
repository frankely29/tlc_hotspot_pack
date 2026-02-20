$ErrorActionPreference = "Stop"

param(
  [string]$CommitMessage = "Update published map",
  [string]$Remote = "origin",
  [string]$Branch = "",
  [switch]$BuildFirst
)

$ProjectDir = Split-Path -Parent $PSScriptRoot
$PublishScript = Join-Path $PSScriptRoot "publish_github_pages.ps1"

if (!(Test-Path $PublishScript)) { throw "Missing script: $PublishScript" }
if (!(Get-Command git -ErrorAction SilentlyContinue)) { throw "git is not installed or not on PATH." }

if ($BuildFirst) {
  $BuildScript = Join-Path $PSScriptRoot "build_map.ps1"
  if (!(Test-Path $BuildScript)) { throw "Missing build script: $BuildScript" }
  Write-Host "Running build script..." -ForegroundColor Cyan
  & $BuildScript
}

# Copy latest map to docs/index.html
& $PublishScript

Set-Location $ProjectDir

if ([string]::IsNullOrWhiteSpace($Branch)) {
  $Branch = (git rev-parse --abbrev-ref HEAD).Trim()
}
if ([string]::IsNullOrWhiteSpace($Branch)) { throw "Could not determine git branch." }

# Stage map output for Pages
& git add docs/index.html

# Commit only if there are staged changes
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & git commit -m $CommitMessage
} else {
  Write-Host "No changes to commit (docs/index.html unchanged)." -ForegroundColor Yellow
}

& git push -u $Remote $Branch

$RemoteUrl = (& git remote get-url $Remote).Trim()
$PhoneUrl = ""
if ($RemoteUrl -match 'github\.com[:/](?<owner>[^/]+)/(?<repo>[^/.]+)(\.git)?$') {
  $PhoneUrl = "https://$($Matches.owner).github.io/$($Matches.repo)/"
}

Write-Host "" 
Write-Host "Done. GitHub Pages deploy may take 1-2 minutes." -ForegroundColor Green
if ($PhoneUrl) {
  Write-Host "Phone URL: $PhoneUrl" -ForegroundColor Green
}
Write-Host "If this is the first time, enable: Settings -> Pages -> Deploy from branch -> $Branch /docs" -ForegroundColor Cyan
