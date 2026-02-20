$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $ProjectDir "outputs"
$DocsDir = Join-Path $ProjectDir "docs"

if (!(Test-Path $OutDir)) { throw "Outputs folder not found: $OutDir" }

$LatestHtml = Get-ChildItem $OutDir -Filter "*.html" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$LatestHtml) { throw "No .html found in: $OutDir. Build the map first." }

New-Item -ItemType Directory -Force -Path $DocsDir | Out-Null
$IndexPath = Join-Path $DocsDir "index.html"
Copy-Item -Path $LatestHtml.FullName -Destination $IndexPath -Force

Write-Host "Copied map to: $IndexPath" -ForegroundColor Green
Write-Host ""
Write-Host "Next commands:" -ForegroundColor Cyan
Write-Host "  git add docs/index.html" -ForegroundColor Yellow
Write-Host "  git commit -m 'Publish map for GitHub Pages'" -ForegroundColor Yellow
Write-Host "  git push" -ForegroundColor Yellow
Write-Host ""
Write-Host "Then on GitHub: Settings -> Pages -> Deploy from branch -> main/master + /docs" -ForegroundColor Cyan
