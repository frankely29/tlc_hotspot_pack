// =======================
// TLC Hotspot Map - app.js (FIXED)
// - Uses backend-provided polygon styles (prevents "everything red")
// - Markers above polygons (Leaflet panes)
// - NYC timezone label
// - Slider throttled (smooth on iPhone)
// - Loads from Railway /hotspots (recommended) with fallback to ./hotspots_20min.json
// =======================

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

function setStatus(msg){
  const el = document.getElementById("statusLine");
  if (el) el.textContent = msg;
}

// ---------- MAP ----------
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// PANES so polygons never cover markers
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// ---------- LAYERS ----------
const polyLayer = L.geoJSON(null, {
  pane: "polys",

  // ✅ CRITICAL FIX:
  // Use style already provided by your builder JSON:
  // feature.properties.style = {color, weight, fillColor, fillOpacity, dashArray?}
  style: (feature) => {
    const p = feature?.properties || {};
    if (p.style && typeof p.style === "object") return p.style;

    // fallback only if style is missing
    return { color:"#555", weight:1, fillColor:"#ffd700", fillOpacity:0.4 };
  },

  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

function makeIcon(tag){
  // tag should be "GOOD" or "BAD" or "TOP"/"BOTTOM" depending on your JSON
  const isGood = (tag === "GOOD" || tag === "TOP");

  const html = isGood
    ? `<div style="
        width:26px;height:26px;border-radius:13px;
        background:#ffffff;border:2px solid #00b050;
        display:flex;align-items:center;justify-content:center;
        font-weight:900;color:#00b050;font-size:18px;
      ">✓</div>`
    : `<div style="
        width:26px;height:26px;border-radius:13px;
        background:#ffffff;border:2px solid #e60000;
        display:flex;align-items:center;justify-content:center;
        font-weight:900;color:#e60000;font-size:18px;
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

  // Polygons
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // Markers (whatever your JSON provides)
  for (const m of (bundle.markers || [])){
    const tag = String(m.tag || "").toUpperCase();

    const marker = L.marker([m.lat, m.lng], { icon: makeIcon(tag), pane: "markers" });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone || "Zone"}</div>
        <div style="color:#666; margin-bottom:4px;">
          ${(m.borough || "Unknown")} — <b>${tag}</b>
        </div>
        <div><b>Rating:</b> <span style="font-weight:900; color:${m.color || "#111"};">${m.rating ?? "n/a"}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups ?? "n/a"}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;
    marker.bindPopup(popup, { maxWidth: 360 });
    marker.addTo(markerLayer);
  }
}

// ---------- LOAD DATA ----------
async function fetchHotspots(){
  // Preferred: Railway endpoint
  // index.html should set:
  // window.RAILWAY_BASE_URL = "https://web-production-78f67.up.railway.app";
  const base = (window.RAILWAY_BASE_URL || "").trim().replace(/\/+$/,"");

  if (base){
    const r = await fetch(`${base}/hotspots`, { cache:"no-store" });
    if (r.ok) return await r.json();
    const txt = await r.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots from Railway (${r.status}). ${txt}`);
  }

  // Fallback: local file in repo (only works if you actually commit it)
  const r2 = await fetch("./hotspots_20min.json", { cache:"no-store" });
  if (!r2.ok) throw new Error("Missing hotspots_20min.json and no RAILWAY_BASE_URL set");
  return await r2.json();
}

async function main(){
  setStatus("Loading…");

  const payload = await fetchHotspots();

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

  if (timeline.length > 0){
    rebuildAtIndex(0);
    setStatus(`Loaded ${timeline.length} steps ✅`);
  } else {
    document.getElementById("timeLabel").textContent = "No data in hotspots JSON";
    setStatus("No timeline");
  }

  // Optional minimize panel if you have button + panel IDs
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