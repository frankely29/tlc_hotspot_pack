function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

function nycLabelFromISO(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// STRICT mandatory buckets
function ratingToFill(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return "#64c8ff"; // default Sky if missing
  const x = clamp(r, 1, 100);

  // 4 buckets (adjust thresholds later if you want)
  if (x >= 76) return "#18a84a"; // Green = Best
  if (x >= 51) return "#1f57ff"; // Blue = Medium
  if (x >= 26) return "#64c8ff"; // Sky  = Normal
  return "#e53935";              // Red  = Avoid
}

function setError(msg){
  const el = document.getElementById("errorLine");
  el.textContent = msg || "";
}

async function fetchWithTimeout(url, ms){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    return {
      // You said you don’t want strong perimeter outlines:
      color: "rgba(0,0,0,0.06)",
      weight: 1,
      fillColor: ratingToFill(p.rating),
      fillOpacity: 0.55
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating = (p.rating !== undefined) ? p.rating : "n/a";
    const zone = p.zone || p.zone_name || p.name || "Zone";
    const borough = p.borough || "";
    layer.bindPopup(
      `<div style="font-family:Arial;font-size:13px;">
        <div style="font-weight:900;font-size:14px;">${zone}</div>
        <div style="color:#666;margin-bottom:6px;">${borough}</div>
        <div><b>Rating:</b> ${rating}/100</div>
      </div>`,
      { maxWidth: 320 }
    );
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = nycLabelFromISO(key);

  polyLayer.clearLayers();
  if (frame.polygons) polyLayer.addData(frame.polygons);
}

function pickClosestIndexToNow(){
  if (!timeline.length) return 0;
  const nowMs = Date.now();
  let bestIdx = 0, bestDiff = Infinity;
  for (let i = 0; i < timeline.length; i++){
    const tMs = new Date(timeline[i]).getTime();
    const diff = Math.abs(tMs - nowMs);
    if (diff < bestDiff){ bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

async function main(){
  setError("");
  document.getElementById("tzLabel").textContent = "NYC time";

  const base = (window.RAILWAY_BASE_URL || "").replace(/\/+$/, "");
  if (!base) throw new Error("Missing window.RAILWAY_BASE_URL in index.html");

  // IMPORTANT: pull from Railway only
  const url = `${base}/hotspots`;

  // 30s timeout (mobile networks)
  const res = await fetchWithTimeout(url, 30000);

  if (!res.ok){
    let body = "";
    try { body = await res.text(); } catch {}
    throw new Error(`Railway /hotspots failed (${res.status}). ${body}`.slice(0, 500));
  }

  // Browser auto-decompresses gzip
  const payload = await res.json();

  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  const startIdx = pickClosestIndexToNow();
  slider.value = String(startIdx);

  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  if (timeline.length > 0){
    rebuildAtIndex(startIdx);
  } else {
    document.getElementById("timeLabel").textContent = "No data";
    setError("ERROR: No timeline returned. Run POST /generate on Railway.");
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "Load failed";
  setError("ERROR: " + (err?.message || String(err)));
});