// =======================
// TLC Hotspot Map - app.js (Phone-first)
// FIXED:
// - Polygons use smooth gradient (red -> yellow -> green) like you wanted
// - Icons show ONLY extremes per time window (top good / bottom bad)
// - No more confusing mismatched colors vs icons
// - NYC time labels
// - Marker declutter + zoom gating for iPhone
// - Loads hotspots JSON from Railway (NOT GitHub)
// =======================

// IMPORTANT: put your Railway domain here (no trailing slash)
const API_BASE = "https://web-production-78f67.up.railway.app";

// ---------- helpers ----------
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

// smooth red -> yellow -> green
function scoreToColorHex(score01){
  const s = clamp01(score01);
  let r,g,b;
  if (s <= 0.5){
    const t = s/0.5;
    r = Math.round(lerp(230,255,t));
    g = Math.round(lerp(0,215,t));
    b = 0;
  } else {
    const t = (s-0.5)/0.5;
    r = Math.round(lerp(255,0,t));
    g = Math.round(lerp(215,176,t));
    b = Math.round(lerp(0,80,t));
  }
  const toHex = (n)=>n.toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

// Force NYC timezone
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// Get rating from polygon feature
function getPolyRating(feature){
  const p = feature?.properties || {};
  const r =
    p.rating ??
    p.rating_1_100 ??
    p.rating_window ??
    p.rating01 != null ? Math.round(1 + 99 * Number(p.rating01)) : null;
  if (r === null || r === undefined || Number.isNaN(Number(r))) return null;
  return Number(r);
}

// Compute percentile threshold (simple)
function percentile(sortedArr, q){
  if (!sortedArr.length) return null;
  const pos = (sortedArr.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sortedArr[base + 1] === undefined) return sortedArr[base];
  return sortedArr[base] + rest * (sortedArr[base + 1] - sortedArr[base]);
}

// ---------- map ----------
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
}).addTo(map);

// PANES so polygons never cover icons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    // If builder already provided a style, use it (THIS keeps your gradient).
    if (p.style && p.style.fillColor) {
      // ensure readable borders
      return {
        color: p.style.color || "#222",
        weight: p.style.weight ?? 2,
        dashArray: p.style.dashArray ?? null,
        fillColor: p.style.fillColor,
        fillOpacity: p.style.fillOpacity ?? 0.45,
      };
    }

    // fallback: compute from rating
    const r = getPolyRating(feature);
    const fill = scoreToColorHex(((r ?? 1) - 1) / 99);
    return { color:"#222", weight:2, fillColor: fill, fillOpacity:0.45 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  },
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

// data
let timeline = [];
let dataByTime = new Map();

function setStatus(msg){
  const el = document.getElementById("timeLabel");
  if (el) el.textContent = msg;
}

function showError(msg){
  console.error(msg);
  setStatus("ERROR: " + msg);
}

// Icons ONLY for extremes per window
function renderExtremeIcons(bundle){
  markerLayer.clearLayers();

  const zoom = map.getZoom();
  const MIN_ZOOM = 13;     // hide icons until zoomed in (reduces clutter)
  if (zoom < MIN_ZOOM) return;

  // Prefer markers array if it exists
  const markers = bundle?.markers || [];

  // If markers exist, we compute extremes from their ratings
  // If markers missing, we don't try to invent centroids (would be wrong).
  if (!markers.length) return;

  // ratings list
  const ratings = markers
    .map(m => Number(m.rating))
    .filter(x => !Number.isNaN(x))
    .sort((a,b)=>a-b);

  if (!ratings.length) return;

  // Show top/bottom 15% by default (feels good on phone)
  const lowCut  = percentile(ratings, 0.15);
  const highCut = percentile(ratings, 0.85);

  // declutter spacing (screen pixels)
  const placed = [];
  const MIN_PX = 28;

  // Sort so good icons get placed first (so greens show up)
  const sorted = [...markers].sort((a,b)=>Number(b.rating||0)-Number(a.rating||0));

  for (const m of sorted){
    if (m.lat == null || m.lng == null) continue;
    const r = Number(m.rating);
    if (Number.isNaN(r)) continue;

    let type = null;
    if (r >= highCut) type = "GOOD";
    else if (r <= lowCut) type = "BAD";
    else continue;

    const pt = map.latLngToContainerPoint([m.lat, m.lng]);
    let ok = true;
    for (const q of placed){
      const dx = pt.x - q.x;
      const dy = pt.y - q.y;
      if (dx*dx + dy*dy < MIN_PX*MIN_PX){ ok = false; break; }
    }
    if (!ok) continue;
    placed.push(pt);

    const iconHtml = (type === "GOOD")
      ? '<div style="font-weight:900; color:#00b050; font-size:18px; line-height:18px;">✔</div>'
      : '<div style="font-weight:900; color:#e60000; font-size:18px; line-height:18px;">✖</div>';

    const icon = L.divIcon({
      html: iconHtml,
      className: "",
      iconSize: [18,18],
      iconAnchor: [9,9],
    });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone || "Zone"}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough || "Unknown"}</div>
        <div><b>Rating:</b> <span style="font-weight:900;">${Math.round(r)}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups ?? "n/a"}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
        <div style="margin-top:6px; font-size:12px; color:#444;">
          Icon shown because this zone is in the <b>${type === "GOOD" ? "Top 15%" : "Bottom 15%"}</b> for this time.
        </div>
      </div>
    `;

    L.marker([m.lat, m.lng], { icon, pane:"markers" })
      .bindPopup(popup, { maxWidth: 360 })
      .addTo(markerLayer);
  }
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  setStatus(formatTimeLabel(key));

  polyLayer.clearLayers();
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // ONLY extremes per time window
  renderExtremeIcons(bundle);
}

async function fetchJson(url){
  const res = await fetch(url, { cache: "no-store" });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} :: ${text.slice(0,180)}`);
  try { return JSON.parse(text); }
  catch { throw new Error(`Bad JSON :: ${text.slice(0,180)}`); }
}

// Use /download as the correct endpoint
async function loadHotspotsFromRailway(){
  // fast visibility if output exists
  const status = await fetchJson(`${API_BASE}/status`);
  if (!status.has_output) throw new Error("Railway has no output yet. Run /generate first.");

  // Download the big JSON file
  return await fetchJson(`${API_BASE}/download`);
}

function injectLegend(){
  let el = document.getElementById("legend");
  if (!el){
    el = document.createElement("div");
    el.id = "legend";
    document.body.appendChild(el);
  }

  el.innerHTML = `
    <div style="
      position: fixed; top: 18px; left: 18px; width: 420px; z-index: 9999;
      background: rgba(255,255,255,0.97); padding: 12px;
      border: 2px solid #111; border-radius: 10px;
      font-family: Arial; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    ">
      <div style="font-weight:900; margin-bottom:8px; font-size:15px;">
        NYC HVFHV Pickup Zones (1–100)
      </div>

      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <div style="height:12px; width:210px; border:1px solid #333;
          background: linear-gradient(90deg, #e60000, #ffd700, #00b050);"></div>
        <div style="display:flex; justify-content:space-between; width:160px;">
          <span>Low</span><span>Mid</span><span>High</span>
        </div>
      </div>

      <div style="display:flex; gap:14px; align-items:center; margin-bottom:6px;">
        <div><span style="color:#00b050; font-weight:900;">✔</span> Top 15% zones (this time)</div>
        <div><span style="color:#e60000; font-weight:900;">✖</span> Bottom 15% zones (this time)</div>
      </div>

      <div style="margin-top:8px; color:#444; font-size:12px; line-height:1.35;">
        • Colors are always the rating gradient: red low → green high.<br/>
        • Icons appear only at zoom 13+ (reduces overlap).<br/>
        • Slider is NYC time, 20-minute steps.
      </div>
    </div>
  `;
}

async function main(){
  injectLegend();
  setStatus("Loading hotspots…");

  const payload = await loadHotspotsFromRailway();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Throttle slider for iPhone smoothness
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  // Re-render icons when zoom changes (declutter depends on zoom)
  map.on("zoomend", () => rebuildAtIndex(Number(slider.value || 0)));

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    setStatus("No data in hotspots file.");
  }
}

main().catch(err => showError(err.message));