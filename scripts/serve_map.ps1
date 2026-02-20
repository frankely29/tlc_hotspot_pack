$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $ProjectDir "outputs"
$Py     = Join-Path $ProjectDir ".venv\Scripts\python.exe"

if (!(Test-Path $OutDir)) { throw "Outputs folder not found: $OutDir" }
if (!(Test-Path $Py))     { throw "Python not found: $Py" }

$LatestHtml = Get-ChildItem $OutDir -Filter "*.html" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$LatestHtml) { throw "No .html found in: $OutDir" }

$Port = 8000
try {
  $tcp = New-Object Net.Sockets.TcpClient
  $tcp.Connect("127.0.0.1", $Port)
  $tcp.Close()
  $Port = 8001
} catch {}

$server = Start-Process -FilePath $Py -ArgumentList "-m http.server $Port" -WorkingDirectory $OutDir -PassThru
$Url = "http://localhost:$Port/$($LatestHtml.Name)"

Write-Host "Server running (PID $($server.Id))" -ForegroundColor Cyan
Write-Host "Opening: $Url" -ForegroundColor Green
Start-Process $Url

Write-Host "To stop: Stop-Process -Id $($server.Id)" -ForegroundColor Yellow
