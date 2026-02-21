// =======================
// TLC Hotspot Map - app.js
// COLOR RULES (your request):
//  - GRAY   = very low activity (pickups too low)
//  - RED    = worse than gray (avoid / bad signal)
//  - YELLOW = medium
//  - GREEN  = good place to be
//
// Data source: Railway /hotspots (preferred) OR local ./hotspots_20min.json fallback
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

// ---------- YOUR COLOR LOGIC ----------
const COLORS = {
  gray:  "#bdbdbd",   // very low activity
  red:   "#e60000",   // worse than gray (avoid)
  yellow:"#ffd700",   // medium
  green: "#00b050"    // good
};

// If pickups are below this → GRAY no matter what rating says
// Tune this. Start with 10 (works well with your min_trips_per_window=10)
let VERY_LOW_PICKUPS = 10;

// rating buckets (1..100)
function bucketFromRating(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return "yellow";
  if (r >= 75) return "green";
  if (r >= 45) return "yellow";
  return "red";
}

function styleForFeature(feature){
  const p = feature?.properties || {};
  const pickups = Number(p.pickups ?? p.PICKUPS ?? p.trips ?? 0);
  const rating  = Number(p.rating ?? p.RATING ?? p.rating_1_100 ?? 0);

  // 1) Very low activity = gray
  if (Number.isFinite(pickups) && pickups > 0 && pickups < VERY_LOW_PICKUPS){
    return {
      color: "#666666",
      weight: 1,
      fillColor: COLORS.gray,
      fillOpacity: 0.25
    };
  }

  // 2) Otherwise use rating bucket
  const b = bucketFromRating(rating);
  const fill = COLORS[b];

  // Make good zones look “stronger”
  const op = (b === "green") ? 0.55 : (b === "yellow") ? 0.40 : 0.35;

  return {
    color: (b === "red") ? "#990000" : (b === "green") ? "#0b7a3a" : "#777777",
    weight: 2,
    fillColor: fill,
    fillOpacity: op
  };
}

// ---------- MAP ----------
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes so markers never go under polygons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;
map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => styleForFeature(f),
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

function makeIcon(tag){
  // We only show icons for extremes to avoid conflicting signals.
  // ✅ = GOOD extreme, ❌ = BAD extreme
  const html = tag === "TOP"
    ? `<div style="
        width:26px;height:26px;border-radius:13px;
        background:#ffffff;border:2px solid ${COLORS.green};
        display:flex;align-items:center;justify-content:center;
        font-weight:900;color:${COLORS.green};font-size:18px;
      ">✓</div>`
    : `<div style="
        width:26px;height:26px;border-radius:13px;
        background:#ffffff;border:2px solid ${COLORS.red};
        display:flex;align-items:center;justify-content:center;
        font-weight:900;color:${COLORS.red};font-size:18px;
      ">×</div>`;

  return L.divIcon({ html, className: "", iconSize:[26,26], iconAnchor:[13,13] });
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  // polygons
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // markers (extremes only)
  for (const m of (bundle.markers || [])){
    // expected: m.tag = "TOP" or "BOTTOM"
    const tag = String(m.tag || "").toUpperCase();
    if (tag !== "TOP" && tag !== "BOTTOM") continue;

    const marker = L.marker([m.lat, m.lng], { icon: makeIcon(tag), pane: "markers" });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone}</div>
        <div style="color:#666; margin-bottom:4px;">
          ${m.borough || "Unknown"} — <b>${tag === "TOP" ? "GOOD (Top)" : "BAD (Bottom)"}</b>
        </div>
        <div><b>Rating:</b> <span style="font-weight:900;">${m.rating}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;
    marker.bindPopup(popup, { maxWidth: 360 });
    marker.addTo(markerLayer);
  }
}

// --------- LOADING DATA (Railway first, fallback local) ---------
function setStatus(msg){
  const el = document.getElementById("statusLine");
  if (el) el.textContent = msg;
}

async function fetchHotspots(){
  // 1) Railway endpoint (recommended)
  // Put your Railway domain here:
  const RAILWAY_BASE = window.RAILWAY_BASE_URL || ""; 
  // If you set RAILWAY_BASE_URL in index.html, it uses that.

  if (RAILWAY_BASE){
    const r1 = await fetch(`${RAILWAY_BASE}/hotspots`, { cache: "no-store" });
    if (r1.ok) return await r1.json();
  }

  // 2) fallback to local file in GitHub Pages repo
  const r2 = await fetch("./hotspots_20min.json", { cache: "no-store" });
  if (!r2.ok) throw new Error("Could not load hotspots. Set RAILWAY_BASE_URL or add ./hotspots_20min.json");
  return await r2.json();
}

async function main(){
  setStatus("Loading from Railway…");

  const payload = await fetchHotspots();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Smooth slider on iPhone (throttle)
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
    setStatus(`Loaded ${timeline.length} steps ✅`);
  } else {
    document.getElementById("timeLabel").textContent = "No data in hotspots JSON";
    setStatus("No timeline in data");
  }

  // Hook the minimize button
  const btn = document.getElementById("togglePanel");
  const panel = document.getElementById("panel");
  if (btn && panel){
    btn.addEventListener("click", () => {
      const isMin = panel.classList.toggle("min");
      btn.textContent = isMin ? "Max" : "Min";
    });
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
  setStatus("Load failed");
});