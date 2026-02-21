// =======================
// TLC Hotspot Map - app.js (Frontend)
// Reads ONLY Railway JSON: /hotspots_20min.json
// Colors are provided by backend via feature.properties.style
// Slider time label forced to NYC time
// =======================

function formatTimeLabelNYC(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Railway URL is set in index.html
const BASE = (window.RAILWAY_BASE_URL || "").replace(/\/$/, "");

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Ensure polygons render cleanly
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => {
    const st = f && f.properties && f.properties.style;
    return st || { color:"#999", weight:0, fillColor:"#999", fillOpacity:0.0 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    const rating = p.rating;
    const pickups = p.pickups;
    const pay = p.avg_driver_pay;
    const tips = p.avg_tips;

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">Zone ${p.LocationID}</div>
        <div><b>Rating:</b> ${rating}/100</div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${pickups}</div>
        <div><b>Avg driver pay:</b> ${pay == null ? "n/a" : "$" + pay.toFixed(2)}</div>
        <div><b>Avg tips:</b> ${tips == null ? "n/a" : "$" + tips.toFixed(2)}</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 320 });
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function renderIndex(idx){
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = formatTimeLabelNYC(key);

  polyLayer.clearLayers();
  if (frame.polygons) polyLayer.addData(frame.polygons);
}

async function main(){
  if (!BASE) throw new Error("Missing RAILWAY_BASE_URL in index.html");

  const url = `${BASE}/hotspots_20min.json`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load hotspots JSON from Railway: ${res.status}`);

  const payload = await res.json();
  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) renderIndex(pending);
    });
  });

  if (timeline.length > 0) renderIndex(0);
  else document.getElementById("timeLabel").textContent = "No frames in hotspots JSON";
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
});