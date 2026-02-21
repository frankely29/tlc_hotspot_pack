// =======================
// TLC Hotspot Map - app.js (GitHub Pages)
// - Loads data from Railway (NOT from GitHub)
// - Polygons are ONLY rating gradient (red→yellow→green)
// - Markers are ONLY extremes (very good / very bad) to avoid confusion
// - Purple outline = selected zone highlight
// - Marker toggle in legend
// - NYC timezone label
// - Slider throttled for iPhone
// =======================

// IMPORTANT: Put your Railway domain here
const API_BASE = "https://web-production-78f67.up.railway.app"; // <- keep this updated if Railway domain changes
const HOTSPOTS_URL = `${API_BASE}/hotspots`;

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

// red -> yellow -> green
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

function fmtNum(x, nd=2){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return Number(x).toFixed(nd);
}

// Force NYC timezone so labels match NYC
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes: polygons below markers, selection above polygons
map.createPane("polys");     map.getPane("polys").style.zIndex = 400;
map.createPane("selection"); map.getPane("selection").style.zIndex = 520;
map.createPane("markers");   map.getPane("markers").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => f?.properties?.style || {color:"#444", weight:1, fillOpacity:0.55},
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });

    layer.on("click", () => {
      highlightZone(feature);
    });
  }
}).addTo(map);

const selectionLayer = L.geoJSON(null, {
  pane: "selection",
  style: () => ({
    color: "#7b2cff",   // purple selection outline
    weight: 5,
    fillOpacity: 0.0
  })
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();
let markersEnabled = true;

// Keep a quick lookup for the currently displayed polygons by LocationID
let currentPolysById = new Map();

function getLocationIdFromFeature(f){
  const p = f?.properties || {};
  // accept a few possible keys depending on generator
  return p.LocationID ?? p.location_id ?? p.locationId ?? p.zone_id ?? p.zoneId ?? null;
}

// highlight selected polygon with purple outline
function highlightZone(feature){
  selectionLayer.clearLayers();
  if (!feature) return;

  // For multi-polygons, still ok
  selectionLayer.addData(feature);

  // bring selection to top
  try { selectionLayer.bringToFront(); } catch(e) {}
}

function buildMarkerIcon(type){
  // type: "GOOD" or "BAD"
  const html = (type === "GOOD")
    ? '<div style="font-weight:900; color:#00b050; font-size:18px; line-height:18px;">✔</div>'
    : '<div style="font-weight:900; color:#e60000; font-size:18px; line-height:18px;">✖</div>';

  return L.divIcon({
    html,
    className: "",
    iconSize: [18,18],
    iconAnchor: [9,9]
  });
}

// Decide GOOD/BAD based on rating only (keeps meaning consistent)
function markerTypeFromRating(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return null;
  if (r >= 70) return "GOOD";
  if (r <= 30) return "BAD";
  return null; // don't show "middle" markers
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  selectionLayer.clearLayers();
  markerLayer.clearLayers();
  currentPolysById = new Map();

  // Polygons for this time window
  if (bundle.polygons){
    polyLayer.addData(bundle.polygons);

    // Build lookup for selection-by-id (if needed later)
    try {
      const feats = bundle.polygons.features || [];
      for (const f of feats){
        const id = getLocationIdFromFeature(f);
        if (id !== null) currentPolysById.set(String(id), f);
      }
    } catch(e){}
  }

  // Markers (extremes only) — optional toggle
  if (markersEnabled){
    for (const m of (bundle.markers || [])){
      const type = markerTypeFromRating(m.rating);
      if (!type) continue;

      const icon = buildMarkerIcon(type);
      const marker = L.marker([m.lat, m.lng], { icon, pane: "markers" });

      const popup = `
        <div style="font-family:Arial; font-size:13px;">
          <div style="font-weight:900; font-size:14px;">${m.zone}</div>
          <div style="color:#666; margin-bottom:4px;">${m.borough || "Unknown"}</div>
          <div><b>Rating:</b> <span style="font-weight:900; color:${m.color || "#111"};">${m.rating}/100</span></div>
          <hr style="margin:6px 0;">
          <div><b>Pickups:</b> ${m.pickups ?? "n/a"}</div>
          <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
          <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
        </div>
      `;

      marker.bindPopup(popup, { maxWidth: 360 });

      // When marker clicked, try highlight corresponding polygon (if LocationID exists)
      marker.on("click", () => {
        if (m.LocationID !== undefined && m.LocationID !== null){
          const f = currentPolysById.get(String(m.LocationID));
          if (f) highlightZone(f);
        }
      });

      marker.addTo(markerLayer);
    }
  }

  // Ensure markers are always on top
  try { markerLayer.bringToFront(); } catch(e){}
}

function setLegendStatus(text){
  const el = document.getElementById("legendStatus");
  if (el) el.textContent = text;
}

async function main(){
  setLegendStatus("Loading data from Railway...");

  // Pull hotspots JSON from Railway (CORS enabled in main.py)
  const res = await fetch(HOTSPOTS_URL, { cache: "no-store" });
  if (!res.ok){
    const msg = await res.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${msg}`.slice(0, 200));
  }

  const payload = await res.json();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Marker toggle
  const toggle = document.getElementById("toggleMarkers");
  if (toggle){
    toggle.checked = true;
    toggle.addEventListener("change", () => {
      markersEnabled = !!toggle.checked;
      rebuildAtIndex(Number(slider.value));
    });
  }

  // Throttled slider for iPhone smoothness
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
    rebuildAtIndex(0);
    setLegendStatus("Loaded ✅");
  } else {
    document.getElementById("timeLabel").textContent = "No data in hotspots response";
    setLegendStatus("No frames found");
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
  setLegendStatus("ERROR");
});