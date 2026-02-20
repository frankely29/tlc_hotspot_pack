function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function lerp(a,b,t){ return a + (b-a)*t; }

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

function formatTimeLabel(iso){
  const d = new Date(iso);
  // Example: Mon 7:40 PM
  return d.toLocaleString(undefined, { weekday:"short", hour:"numeric", minute:"2-digit" });
}

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

const polyLayer = L.geoJSON(null, {
  style: (f) => f?.properties?.style || {color:"#555", weight:1, fillOpacity:0.4},
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

let timeline = [];
let dataByTime = new Map();

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  // Add polygons
  polyLayer.addData(bundle.polygons);

  // Add markers (dynamic)
  for (const m of (bundle.markers || [])){
    const tag = m.tag; // GOOD/BAD
    const iconHtml = tag === "GOOD"
      ? '<div style="font-weight:900; color:#00b050; font-size:18px;">✔</div>'
      : '<div style="font-weight:900; color:#e60000; font-size:18px;">✖</div>';

    const icon = L.divIcon({ html: iconHtml, className: "", iconSize: [18,18] });

    const marker = L.marker([m.lat, m.lng], { icon });
    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough} — <b>${m.tag}</b></div>
        <div><b>Rating:</b> <span style="font-weight:900; color:${m.color};">${m.rating}/100</span></div>
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

async function main(){
  // You must create this file in your repo root:
  // hotspots_20min.json
  const res = await fetch("./hotspots_20min.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Missing hotspots_20min.json in repo root");
  const payload = await res.json();

  timeline = payload.timeline || [];
  dataByTime = new Map(payload.frames?.map(f => [f.time, f]) || []);

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  slider.addEventListener("input", () => {
    rebuildAtIndex(Number(slider.value));
  });

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    document.getElementById("timeLabel").textContent = "No data in hotspots_20min.json";
  }
}

main().catch(err => {
  console.error(err);
  document.getElementById("timeLabel").textContent = "ERROR: " + err.message;
});
