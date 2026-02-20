$ErrorActionPreference = "Stop"

$OutDir = "C:\Users\eloko\Downloads\tlc_hotspot_pack\tlc_hotspot_pack\outputs"
$Py     = "C:\Users\eloko\Downloads\tlc_hotspot_pack\tlc_hotspot_pack\.venv\Scripts\python.exe"

if (!(Test-Path $OutDir)) { throw "Outputs folder not found: $OutDir" }
if (!(Test-Path $Py))     { throw "Python not found: $Py" }

# Pick the newest HTML in outputs (so you don't hardcode the name)
$LatestHtml = Get-ChildItem $OutDir -Filter "*.html" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$LatestHtml) { throw "No .html files found in: $OutDir" }

# Pick a port (8000 if free, otherwise 8001)
$Port = 8000
try {
  $tcp = New-Object Net.Sockets.TcpClient
  $tcp.Connect("127.0.0.1", $Port)
  $tcp.Close()
  # If connect worked, something is already using 8000 -> switch
  $Port = 8001
} catch {
  # connect failed -> port is probably free, keep 8000
}

# Start server in background
$server = Start-Process -FilePath $Py -ArgumentList "-m http.server $Port" -WorkingDirectory $OutDir -PassThru

# Wait until server responds (max ~10 seconds)
$Url = "http://localhost:$Port/$($LatestHtml.Name)"
$Ready = $false
for ($i=0; $i -lt 20; $i++) {
  try {
    Invoke-WebRequest -Uri $Url -Method Head -TimeoutSec 2 | Out-Null
    $Ready = $true
    break
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

if (!$Ready) {
  Write-Host "Server didn't respond yet. Try opening manually:" -ForegroundColor Yellow
  Write-Host $Url -ForegroundColor Cyan
} else {
  Write-Host "Opening:" $Url -ForegroundColor Green
  Start-Process $Url
}

Write-Host ""
Write-Host "Server running (PID $($server.Id)) serving: $OutDir" -ForegroundColor Cyan
Write-Host "To stop it later:  Stop-Process -Id $($server.Id)" -ForegroundColor Cyan