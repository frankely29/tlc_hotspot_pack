import argparse, re, json
from datetime import datetime, timedelta

def find_balanced_braces(s, start_idx):
    # start_idx points at '{'
    depth = 0
    for i in range(start_idx, len(s)):
        c = s[i]
        if c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return i
    return None

def parse_time(t):
    # try common formats
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M"):
        try:
            return datetime.strptime(t, fmt)
        except ValueError:
            pass
    # last resort: let JS handle if weird
    return None

def fmt_time(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S")

def scale_1_100(v):
    try:
        v = float(v)
    except Exception:
        return v
    # Only scale if it looks like 0-10-ish
    if 0 <= v <= 10.5:
        v = v * 10.0
    v = round(v)
    if v < 1: v = 1
    if v > 100: v = 100
    return int(v)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True)
    ap.add_argument("--step", type=int, default=20)
    args = ap.parse_args()

    html = open(args.html, "r", encoding="utf-8").read()

    # 1) Find the GeoJSON JS variable assignment that contains FeatureCollection
    m = re.search(r'var\s+(geo_json_[A-Za-z0-9_]+)\s*=\s*{', html)
    if not m:
        raise SystemExit("Could not find geo_json_* variable in HTML (pattern var geo_json_... = { )")

    geo_var = m.group(1)
    brace_start = m.end() - 1
    brace_end = find_balanced_braces(html, brace_start)
    if brace_end is None:
        raise SystemExit("Could not parse GeoJSON object braces.")

    geo_text = html[brace_start:brace_end+1]
    geo = json.loads(geo_text)

    # 2) Expand timestamps to 20-min stepping (duplicates inside each original bin)
    # Works when features have properties.time
    features = geo.get("features", [])
    # Collect unique times
    times = []
    for f in features:
        p = f.get("properties", {})
        t = p.get("time")
        if isinstance(t, str):
            dt = parse_time(t)
            if dt:
                times.append(dt)

    if times:
        uniq = sorted(set(times))
        # estimate step from median diff
        diffs = []
        for i in range(1, len(uniq)):
            diffs.append(int((uniq[i]-uniq[i-1]).total_seconds()//60))
        base = sorted(diffs)[len(diffs)//2] if diffs else args.step

        if base > args.step and base % args.step == 0:
            # Build lookup of next time boundary
            next_map = {uniq[i]: (uniq[i+1] if i+1 < len(uniq) else uniq[i] + timedelta(minutes=base)) for i in range(len(uniq))}
            new_features = []
            step = timedelta(minutes=args.step)

            for f in features:
                p = f.get("properties", {})
                t = p.get("time")
                dt = parse_time(t) if isinstance(t, str) else None
                if not dt:
                    new_features.append(f)
                    continue

                # always keep original
                new_features.append(f)

                # duplicate up to (but not including) the next boundary
                boundary = next_map.get(dt, dt + timedelta(minutes=base))
                d = dt + step
                while d < boundary:
                    ff = json.loads(json.dumps(f))
                    ff["properties"]["time"] = fmt_time(d)
                    new_features.append(ff)
                    d += step

            geo["features"] = new_features

    # 3) Scale rating/score keys to clean 1-100 (no double-scaling)
    for f in geo.get("features", []):
        p = f.get("properties", {})
        for k in ("rating","score","zone_score"):
            if k in p:
                p[k] = scale_1_100(p[k])

    # Write geo back
    new_geo_text = json.dumps(geo, separators=(",", ":"))
    html = html[:brace_start] + new_geo_text + html[brace_end+1:]

    # 4) Inject a right-side legend + dynamic / markers + AM/PM time label
    # Find map var
    mm = re.search(r'var\s+(map_[A-Za-z0-9_]+)\s*=\s*L\.map\(', html)
    map_var = mm.group(1) if mm else None
    if not map_var:
        raise SystemExit("Could not find map_* variable in HTML.")

    if "fhv-legend-dyn" not in html:
        legend = r'''
<div id="fhv-legend-dyn" style="
  position: fixed; top: 80px; right: 20px; z-index: 9999;
  background: rgba(255,255,255,0.95); padding: 12px 14px;
  border: 1px solid #999; border-radius: 10px; font-size: 13px; line-height: 18px;
  box-shadow: 0 2px 10px rgba(0,0,0,0.15); max-width: 280px;">
  <div style="font-weight:700; margin-bottom:6px;">Legend (FHV Profit Hotspots)</div>

  <div style="margin:4px 0;">
    <span style="display:inline-block;width:14px;height:14px;background:#2ecc71;border:1px solid #333;margin-right:6px;"></span>
    Higher score (better)
  </div>
  <div style="margin:4px 0;">
    <span style="display:inline-block;width:14px;height:14px;background:#f1c40f;border:1px solid #333;margin-right:6px;"></span>
    Medium
  </div>
  <div style="margin:4px 0;">
    <span style="display:inline-block;width:14px;height:14px;background:#e74c3c;border:1px solid #333;margin-right:6px;"></span>
    Lower score (worse)
  </div>

  <div style="margin-top:10px; padding-top:8px; border-top:1px solid #ddd;">
    <div style="font-weight:600; margin-bottom:4px;">Dynamic Top/Bottom (this time)</div>
    <div> Top zones +  Bottom zones update when the time changes.</div>
  </div>
</div>
'''

        js = f"""
<script>
(function() {{
  var map = {map_var};
  var gj  = {geo_var};
  var markers = L.layerGroup().addTo(map);

  function getScore(p) {{
    return (p.rating ?? p.score ?? p.zone_score ?? null);
  }}

  function centroidFromGeom(g) {{
    try {{
      if (!g) return null;
      var coords = g.coordinates;
      var minLat=  90, maxLat= -90, minLng= 180, maxLng=-180;

      function scan(arr) {{
        if (typeof arr[0] === "number" && typeof arr[1] === "number") {{
          var lng = arr[0], lat = arr[1];
          if (lat < minLat) minLat = lat;
          if (lat > maxLat) maxLat = lat;
          if (lng < minLng) minLng = lng;
          if (lng > maxLng) maxLng = lng;
          return;
        }}
        for (var i=0;i<arr.length;i++) scan(arr[i]);
      }}
      scan(coords);
      return [ (minLat+maxLat)/2, (minLng+maxLng)/2 ];
    }} catch(e) {{
      return null;
    }}
  }}

  function parseTimeToMs(t) {{
    // your HTML uses "YYYY-MM-DD HH:mm:ss"
    // Convert to "YYYY-MM-DDTHH:mm:ss" (local time)
    if (!t) return null;
    var iso = t.replace(" ", "T");
    var d = new Date(iso);
    var ms = d.getTime();
    return isNaN(ms) ? null : ms;
  }}

  // Build index: ms -> array of feature summaries
  var byTime = new Map();
  gj.features.forEach(function(f) {{
    var p = f.properties || {{}};
    var t = p.time;
    var ms = parseTimeToMs(t);
    var s  = getScore(p);
    if (ms === null || s === null || s === undefined) return;

    var c = centroidFromGeom(f.geometry);
    if (!c) return;

    var rec = {{ lat:c[0], lng:c[1], score:Number(s), name:(p.name||p.zone||p.borough||p.boro||p.LocationID||"zone") }};
    if (!byTime.has(ms)) byTime.set(ms, []);
    byTime.get(ms).push(rec);
  }});

  var cachedTimes = Array.from(byTime.keys()).sort(function(a,b){{return a-b;}});
  function nearestTime(ms) {{
    if (!cachedTimes.length) return null;
    // if exact exists
    if (byTime.has(ms)) return ms;
    // find nearest
    var lo=0, hi=cachedTimes.length-1;
    while (lo < hi) {{
      var mid = (lo+hi)>>1;
      if (cachedTimes[mid] < ms) lo = mid+1; else hi = mid;
    }}
    var cand = cachedTimes[lo];
    if (lo>0) {{
      var prev = cachedTimes[lo-1];
      cand = (Math.abs(prev-ms) < Math.abs(cand-ms)) ? prev : cand;
    }}
    return cand;
  }}

  function fmtAmPm(ms) {{
    var d = new Date(ms);
    return d.toLocaleString("en-US", {{
      weekday:"short", hour:"numeric", minute:"2-digit", hour12:true
    }});
  }}

  var last = null;
  function refresh() {{
    if (!map.timeDimension) return;
    var ms = map.timeDimension.getCurrentTime();
    if (ms === last) return;
    last = ms;

    var key = nearestTime(ms);
    markers.clearLayers();
    if (key === null) return;

    var arr = (byTime.get(key) || []).slice();
    if (!arr.length) return;

    // sort by score desc
    arr.sort(function(a,b){{ return b.score - a.score; }});
    var topN = arr.slice(0, 8);
    var botN = arr.slice(-8).reverse();

    function add(rec, sym) {{
      var icon = L.divIcon({{
        className: "",
        html: '<div style="font-size:18px; line-height:18px;">'+sym+'</div>',
        iconSize: [18,18],
        iconAnchor: [9,9]
      }});
      var tip = sym + " " + rec.name + " | score " + rec.score;
      L.marker([rec.lat, rec.lng], {{icon:icon}}).bindTooltip(tip).addTo(markers);
    }}

    topN.forEach(function(r){{ add(r, ""); }});
    botN.forEach(function(r){{ add(r, ""); }});

    // Try to force the time label to AM/PM by updating any visible control text
    var el = document.querySelector(".timecontrol-date") || document.querySelector(".leaflet-control-timecontrol");
    if (el) {{
      // dont break control; just append readable time
      var stamp = fmtAmPm(ms);
      el.setAttribute("data-fhv-time", stamp);
    }}
  }}

  // Poll because different Leaflet.TimeDimension builds emit different events
  setInterval(refresh, 300);
  setTimeout(refresh, 800);
}})();
</script>
"""

        html = html.replace("</body>", legend + "\n" + js + "\n</body>")

    open(args.html, "w", encoding="utf-8").write(html)
    print("PATCHED:", args.html)

if __name__ == "__main__":
    main()
