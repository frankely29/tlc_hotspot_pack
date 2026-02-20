$ErrorActionPreference = "Stop"

# =================== SETTINGS ===================
$ProjectDir   = "C:\Users\eloko\Downloads\tlc_hotspot_pack\tlc_hotspot_pack"
$OutDir       = Join-Path $ProjectDir "outputs"
$VenvPy       = Join-Path $ProjectDir ".venv\Scripts\python.exe"

# Your current map bin size (what you built with). Example: you used --hour_bin 2
$HourBinHours = 2

# What you want the slider to step by
$StepMinutes  = 20

# Output file name (this will be overwritten each time, no script spam)
$PatchedName  = "hotspots_timeslider_zones.patched.html"
# ================================================

if (!(Test-Path $OutDir)) { throw "Outputs folder not found: $OutDir" }
if (!(Test-Path $VenvPy)) { throw "Venv python not found: $VenvPy" }

# Find newest HTML map in outputs
$LatestHtml = Get-ChildItem $OutDir -Filter "*.html" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (!$LatestHtml) { throw "No .html files found in: $OutDir" }

$InHtml  = $LatestHtml.FullName
$OutHtml = Join-Path $OutDir $PatchedName

Write-Host "Input map:  $InHtml"  -ForegroundColor Cyan
Write-Host "Output map: $OutHtml" -ForegroundColor Cyan

# -------- Python patcher (runs inside your venv) --------
$pyCode = @"
import re, json, math
from datetime import datetime, timedelta, timezone

IN_HTML  = r'''$InHtml'''
OUT_HTML = r'''$OutHtml'''
HOUR_BIN_HOURS = int($HourBinHours)
STEP_MIN = int($StepMinutes)

def iso_parse(s: str) -> datetime:
    # handles: 2024-01-01T12:00:00 or ...Z
    s = s.strip().replace('Z','+00:00')
    return datetime.fromisoformat(s)

def iso_out(dt: datetime) -> str:
    # keep Z format if possible
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00','Z')

html = open(IN_HTML, 'r', encoding='utf-8', errors='ignore').read()

# 1) Force AM/PM time display in the slider label
# Folium/Leaflet.TimeDimension often uses 'date_options' or 'dateOptions' or 'date_options:' patterns
html = re.sub(r'(date_options\\s*[:=]\\s*)[\"\\\'][^\"\\\']*[\"\\\']', r'\\1"ddd h:mm A"', html)
html = re.sub(r'(dateOptions\\s*[:=]\\s*)[\"\\\'][^\"\\\']*[\"\\\']', r'\\1"ddd h:mm A"', html)

# 2) Force slider period to PT20M (visual step)
# (This helps the control; timestamps still matter too.)
html = re.sub(r'(period\\s*[:=]\\s*)[\"\\\']PT\\d+[HhMm][\"\\\']', rf'\\1"PT{STEP_MIN}M"', html)

# 3) Find GeoJSON blocks Folium embeds as: var geo_json_xxx = {...};
geo_pat = re.compile(r'var\\s+(geo_json_[A-Za-z0-9_]+)\\s*=\\s*(\\{.*?\\})\\s*;\\s*', re.S)

blocks = list(geo_pat.finditer(html))
if not blocks:
    raise SystemExit("Couldn't find embedded geo_json_* block in the HTML. (Unexpected map format)")

def choose_score_key(props: dict):
    # prefer exact keys if present
    for k in ("score", "rating", "hotspot_score", "zone_score"):
        if k in props and isinstance(props[k], (int,float)) and not math.isnan(float(props[k])):
            return k
    # otherwise pick first numeric-looking key
    for k,v in props.items():
        if isinstance(v,(int,float)):
            return k
    return None

def rescale_to_1_100(values):
    vals = [float(v) for v in values if v is not None and not math.isnan(float(v))]
    if not vals:
        return None, None, None
    vmin = min(vals)
    vmax = max(vals)
    if vmax == vmin:
        return vmin, vmax, lambda x: 50
    def f(x):
        x = float(x)
        scaled = 1.0 + 99.0 * (x - vmin) / (vmax - vmin)
        # round to nearest int, clamp
        out = int(round(scaled))
        if out < 1: out = 1
        if out > 100: out = 100
        return out
    return vmin, vmax, f

# We will patch ALL geojson blocks (some maps have more than one)
for m in blocks:
    name = m.group(1)
    raw  = m.group(2)

    try:
        gj = json.loads(raw)
    except Exception:
        # sometimes folium embeds JS-like JSON that still parses; if not, skip
        continue

    feats = gj.get("features") or []
    if not feats:
        continue

    # 4) Expand timestamps to 20-min steps inside each bin (so slider moves every 20m)
    steps = max(1, (HOUR_BIN_HOURS * 60) // STEP_MIN)

    # 5) Rescale score/rating to 1..100 cleanly
    first_props = (feats[0].get("properties") or {})
    score_key = choose_score_key(first_props)

    all_scores = []
    if score_key:
        for f in feats:
            p = f.get("properties") or {}
            v = p.get(score_key)
            if isinstance(v,(int,float)):
                all_scores.append(v)

    vmin, vmax, scaler = (None, None, None)
    if all_scores:
        vmin, vmax, scaler = rescale_to_1_100(all_scores)

    for f in feats:
        p = f.get("properties") or {}
        # expand times
        times = f.get("properties", {}).get("times") or f.get("times")
        if isinstance(times, list) and len(times) == 1 and isinstance(times[0], str):
            t0 = iso_parse(times[0])
            new_times = [iso_out(t0 + timedelta(minutes=STEP_MIN*i)) for i in range(steps)]
            # folium sometimes stores under feature["properties"]["times"]
            if "properties" in f and isinstance(f["properties"], dict) and "times" in f["properties"]:
                f["properties"]["times"] = new_times
            else:
                f["times"] = new_times

        # rescale score
        if scaler and score_key and score_key in p and isinstance(p[score_key], (int,float)):
            p[score_key] = scaler(p[score_key])
            # keep a copy name for tooltips if you want later
            p["score_1_100"] = p[score_key]
            f["properties"] = p

    gj["features"] = feats

    # Replace the block in HTML
    new_raw = json.dumps(gj, separators=(",", ":"), ensure_ascii=False)
    html = html.replace(raw, new_raw)

# 6) Inject a dynamic legend + updater (updates on slider movement)
legend_html = r'''
<style>
#fhv-legend {
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
  font-family: -apple-system, Segoe UI, Roboto, Arial, sans-serif;
}
#fhv-legend .title { font-weight: 700; margin-bottom: 6px; }
#fhv-legend .row { margin: 6px 0; display:flex; align-items:center; gap:8px; }
#fhv-legend .sw { width:14px; height:14px; border:1px solid #333; display:inline-block; }
#fhv-legend .meta { margin-top:8px; color:#444; font-size:12px; }
</style>

<div id="fhv-legend">
  <div class="title">Legend (FHV profit hotspots)</div>

  <div class="row"><span class="sw" style="background:#2ecc71;"></span>
    <div><b>Better</b> <span id="lg-good">(loading…)</span></div>
  </div>
  <div class="row"><span class="sw" style="background:#f1c40f;"></span>
    <div><b>Medium</b> <span id="lg-mid">(loading…)</span></div>
  </div>
  <div class="row"><span class="sw" style="background:#e74c3c;"></span>
    <div><b>Worse</b> <span id="lg-bad">(loading…)</span></div>
  </div>

  <div class="meta">
    Ratings are computed from TLC zone activity for the selected time.<br/>
    Dynamic thresholds update as you move the slider.
  </div>
</div>

<script>
(function(){
  function pickTimeDimensionMap(){
    // Folium creates one main map variable; try to find it
    for (var k in window){
      try{
        var v = window[k];
        if (v && v.timeDimension && typeof v.timeDimension.getCurrentTime === "function"){
          return v;
        }
      }catch(e){}
    }
    return null;
  }

  function pickTDGeoJsonLayer(map){
    // Find a TimeDimension GeoJSON layer (it has _currentLayer and/or _baseLayer)
    var found = null;
    map.eachLayer(function(layer){
      if (found) return;
      if (layer && (layer._currentLayer || layer._baseLayer) && layer._timeDimension){
        found = layer;
      }
    });
    return found;
  }

  function quantile(arr, q){
    if (!arr.length) return null;
    var a = arr.slice().sort(function(x,y){return x-y;});
    var pos = (a.length - 1) * q;
    var base = Math.floor(pos);
    var rest = pos - base;
    if (a[base+1] !== undefined) return a[base] + rest*(a[base+1]-a[base]);
    return a[base];
  }

  function getScores(tdLayer){
    var scores = [];
    var cur = tdLayer._currentLayer || tdLayer._baseLayer;
    if (!cur || !cur.eachLayer) return scores;

    cur.eachLayer(function(ly){
      try{
        var p = ly.feature && ly.feature.properties ? ly.feature.properties : null;
        if (!p) return;
        // prefer the patched 1..100 key
        var s = (typeof p.score_1_100 === "number") ? p.score_1_100 :
                (typeof p.score === "number") ? p.score :
                (typeof p.rating === "number") ? p.rating : null;
        if (typeof s === "number" && isFinite(s)) scores.push(s);
      }catch(e){}
    });
    return scores;
  }

  function updateLegend(tdLayer){
    var scores = getScores(tdLayer);
    if (!scores.length){
      document.getElementById("lg-good").textContent = "";
      document.getElementById("lg-mid").textContent  = "";
      document.getElementById("lg-bad").textContent  = "";
      return;
    }
    // dynamic thresholds: bottom 20%, middle 60%, top 20%
    var q20 = quantile(scores, 0.20);
    var q80 = quantile(scores, 0.80);

    var goodTxt = "(≥ " + Math.round(q80) + ")";
    var badTxt  = "(≤ " + Math.round(q20) + ")";
    var midTxt  = "(" + Math.round(q20) + " – " + Math.round(q80) + ")";

    document.getElementById("lg-good").textContent = goodTxt;
    document.getElementById("lg-mid").textContent  = midTxt;
    document.getElementById("lg-bad").textContent  = badTxt;
  }

  var map = pickTimeDimensionMap();
  if (!map){
    console.warn("Could not find map with TimeDimension.");
    return;
  }
  var td = pickTDGeoJsonLayer(map);
  if (!td){
    console.warn("Could not find TimeDimension GeoJSON layer.");
    return;
  }

  // Update now + whenever time changes
  updateLegend(td);
  map.timeDimension.on("timeload", function(){ updateLegend(td); });
  map.timeDimension.on("timechange", function(){ updateLegend(td); });
})();
</script>
'''

if "id=\"fhv-legend\"" not in html:
    html = html.replace("</body>", legend_html + "\n</body>")

open(OUT_HTML, "w", encoding="utf-8").write(html)
print("WROTE:", OUT_HTML)
"@

# Write patcher to a temp file inside outputs
$PatchPy = Join-Path $OutDir "_patch_html.py"
Set-Content -Encoding UTF8 -Path $PatchPy -Value $pyCode

# Run patcher
& $VenvPy $PatchPy

Write-Host "`nPatched HTML created:" -ForegroundColor Green
Write-Host $OutHtml -ForegroundColor Yellow

Write-Host "`nOpen it with your server:" -ForegroundColor Cyan
Write-Host "http://localhost:8000/$PatchedName" -ForegroundColor Cyan