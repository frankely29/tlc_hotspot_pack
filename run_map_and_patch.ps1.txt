# run_map_and_patch.ps1
$ErrorActionPreference = "Stop"

# ===================== SETTINGS =====================
$ProjectDir   = "C:\Users\eloko\Downloads\tlc_hotspot_pack\tlc_hotspot_pack"
$Months       = @("2024-01","2024-02")     # change if you want
$BuildMap     = $true                      # set to $false if you only want to patch + serve existing HTML

# Builder inputs
$DataDir      = Join-Path $ProjectDir "data"
$OutDir       = Join-Path $ProjectDir "outputs"
$Py           = Join-Path $ProjectDir ".venv\Scripts\python.exe"
$BuilderPy    = Join-Path $ProjectDir "tlc_hvfhs_hotspot_builder.py"

# Your builder params (keep what you like)
$HourBin          = 2          # this is the builder's real aggregation (2-hour bins in your current build)
$SimplifyMeters   = 60
$WinGoodN         = 40
$WinBadN          = 20

# Display tweaks (HTML patch)
$SliderStepMinutes = 20        # show slider stepping at 20 minutes
$UseAmPm           = $true      # show AM/PM (12-hour clock)
$ScaleTo100        = $true      # convert score/rating to 0-100 in the HTML if present
# ====================================================


function Assert-Path($p, $msg) {
  if (!(Test-Path $p)) { throw $msg }
}

function Get-FreePort([int]$Preferred = 8000) {
  $port = $Preferred
  try {
    $tcp = New-Object Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", $port)
    $tcp.Close()
    # port in use -> use next
    $port = $Preferred + 1
  } catch {
    # port likely free
  }
  return $port
}

function Kill-HttpServersOnPort([int]$Port) {
  # Best-effort: kill python http.server that was started with "-m http.server PORT"
  $procs = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
    Where-Object { $_.CommandLine -match "http\.server\s+$Port(\s|$)" }

  foreach ($p in $procs) {
    try { Stop-Process -Id $p.ProcessId -Force } catch {}
  }
}

function Patch-HtmlFile([string]$HtmlPath) {
  Write-Host "Patching HTML:" $HtmlPath -ForegroundColor Cyan
  $html = Get-Content -Raw -Encoding UTF8 $HtmlPath

  # 1) Slider step: set period to PT20M (works for Leaflet.TimeDimension control configs when present)
  $html = $html -replace '("period"\s*:\s*")PT[^"]+(")', "`$1PT${SliderStepMinutes}M`$2"
  $html = $html -replace '(period\s*=\s*")PT[^"]+(")', "`$1PT${SliderStepMinutes}M`$2"

  # 2) AM/PM formatting
  if ($UseAmPm) {
    # Folium TimestampedGeoJson often uses a moment.js format string.
    # "ddd h:mm A" => Thu 7:20 PM
    $html = $html -replace '("dateOptions"\s*:\s*")[^"]+(")', "`$1ddd h:mm A`$2"
    $html = $html -replace '(date_options\s*=\s*")[^"]+(")', "`$1ddd h:mm A`$2"
    $html = $html -replace '("timeFormat"\s*:\s*")[^"]+(")', "`$1ddd h:mm A`$2"
  }

  # 3) Add right-side legend (inject before </body>)
  if ($html -notmatch 'Legend \(FHV Profit Hotspots\)') {
    $legend = @"
<div id="fhv-legend" style="
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 9999;
  background: rgba(255,255,255,0.95);
  padding: 12px 14px;
  border: 1px solid #999;
  border-radius: 10px;
  font-size: 13px;
  line-height: 18px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.15);
  max-width: 260px;
">
  <div style="font-weight:700; margin-bottom:6px;">Legend (FHV Profit Hotspots)</div>

  <div style="margin:4px 0;"><span style="display:inline-block;width:14px;height:14px;background:#2ecc71;border:1px solid #333;margin-right:6px;"></span>
    Better zone (higher score)
  </div>

  <div style="margin:4px 0;"><span style="display:inline-block;width:14px;height:14px;background:#f1c40f;border:1px solid #333;margin-right:6px;"></span>
    Medium
  </div>

  <div style="margin:4px 0;"><span style="display:inline-block;width:14px;height:14px;background:#e74c3c;border:1px solid #333;margin-right:6px;"></span>
    Worse zone (lower score)
  </div>

  <div style="margin-top:8px;color:#444;">
    Tip: “Good/Bad” depends on the selected time window.
  </div>
</div>
"@

    $html = $html -replace '</body>', ($legend + "`n</body>")
  }

  # 4) Scale score/rating values in embedded GeoJSON/properties from 0-10-ish to 0-100-ish (best-effort)
  if ($ScaleTo100) {
    $pattern = '("(?:score|rating)"\s*:\s*)(\d+(?:\.\d+)?)'
    $html = [regex]::Replace($html, $pattern, {
      param($m)
      $prefix = $m.Groups[1].Value
      $val = [double]$m.Groups[2].Value
      $new = [math]::Round([math]::Min(100, [math]::Max(0, $val * 10)), 0)
      return "$prefix$new"
    })
  }

  # Save back (overwrite)
  Set-Content -Encoding UTF8 -Path $HtmlPath -Value $html
  Write-Host "HTML patched OK." -ForegroundColor Green
}

# -------------------- checks --------------------
Assert-Path $ProjectDir "ProjectDir not found: $ProjectDir"
Assert-Path $Py         "Python venv not found: $Py"
Assert-Path $DataDir    "Data folder not found: $DataDir"
if (!(Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir | Out-Null }

# -------------------- (optional) build --------------------
if ($BuildMap) {
  Assert-Path $BuilderPy "Builder not found: $BuilderPy"
  Set-Location $ProjectDir
  Write-Host "Running builder..." -ForegroundColor Cyan

  & $Py $BuilderPy `
    --months $Months `
    --data_dir $DataDir `
    --out_dir "outputs" `
    --hour_bin $HourBin `
    --simplify_meters $SimplifyMeters `
    --win_good_n $WinGoodN `
    --win_bad_n $WinBadN

  Write-Host "Builder finished." -ForegroundColor Green
}

# -------------------- pick newest html --------------------
$LatestHtml = Get-ChildItem $OutDir -Filter "*.html" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

if (!$LatestHtml) { throw "No .html found in outputs: $OutDir" }

# -------------------- patch html --------------------
Patch-HtmlFile -HtmlPath $LatestHtml.FullName

# -------------------- serve + open --------------------
$Port = Get-FreePort 8000
Kill-HttpServersOnPort $Port

Write-Host "Starting local server on port $Port..." -ForegroundColor Cyan
$server = Start-Process -FilePath $Py -ArgumentList "-m http.server $Port" -WorkingDirectory $OutDir -PassThru

$Url = "http://localhost:$Port/$($LatestHtml.Name)"
Write-Host "Opening:" $Url -ForegroundColor Yellow
Start-Process $Url

Write-Host ""
Write-Host "Server PID: $($server.Id)" -ForegroundColor Cyan
Write-Host "Stop it later with:  Stop-Process -Id $($server.Id)" -ForegroundColor Cyan