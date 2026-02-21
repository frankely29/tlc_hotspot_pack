// =======================
// TLC Hotspot Map - app.js (NO ICONS)
// - Loads data from Railway /hotspots (with /download fallback)
// - Colors polygons by wait time (Green→Yellow→Red)
// - Clear error messages if anything fails
// - Slider throttled for iPhone
// =======================

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

// Force NYC timezone labels
function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Rating color scale (1..100):
// Low rating -> red, mid -> yellow, high -> green
function ratingToColor(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return { fill:"#ffcc00", op:0.5 };

  if (r >= 67){
    return { fill:"#00d66b", op:0.72 };
  }

  if (r >= 34){
    return { fill:"#ffcc00", op:0.66 };
  }

  return { fill:"#ff2a2a", op:0.66 };
}

const RAILWAY_BASE_URL = (window.RAILWAY_BASE_URL || "").replace(/\/+$/,"");

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// keep polygons clean and readable
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    const rating = p.rating ?? null;
    const waitMinutes = p.wait_minutes ?? p.wait_time_minutes ?? p.wait_time ?? p.wait ?? null;

    const { fill, op } = rating !== null && rating !== undefined
      ? ratingToColor(rating)
      : ratingToColor(waitMinutes);

    // Prefer builder-provided color (already computed from score/rating)
    const finalFill = p.style?.fillColor || fill;
    const finalOp = p.style?.fillOpacity ?? op;

    return {
      color: "#1b1b1b",
      weight: 2,
      fillColor: finalFill,
      fillOpacity: finalOp
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    if (p.popup){
      layer.bindPopup(p.popup, { maxWidth: 360 });
    } else {
      // safe fallback popup
      const rating = p.rating ?? "n/a";
      const pickups = p.pickups ?? "n/a";
      layer.bindPopup(
        `<div style="font-family:Arial;font-size:13px;">
          <div style="font-weight:900;">${p.zone || "Zone"}</div>
          <div><b>Rating:</b> ${rating}/100</div>
          <div><b>Pickups:</b> ${pickups}</div>
        </div>`,
        { maxWidth: 320 }
      );
    }
  }
}).addTo(map);

let timeline = [];
let dataByTime = new Map();

function setStatus(ok, msg){
  const el = document.getElementById("statusLine");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("bad", !ok);
}

function clearMap(){
  polyLayer.clearLayers();
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatTimeLabel(key);

  clearMap();

  if (bundle.polygons){
    polyLayer.addData(bundle.polygons);
  }
}

async function fetchHotspots(){
  if (!RAILWAY_BASE_URL){
    throw new Error("Missing window.RAILWAY_BASE_URL (set it in index.html)");
  }

  // quick ping so you know Railway is reachable
  const ping = await fetch(`${RAILWAY_BASE_URL}/?ts=${Date.now()}`, { cache:"no-store" });
  if (!ping.ok){
    throw new Error(`Railway not reachable (GET / failed: ${ping.status})`);
  }

  // load the hotspot json from Railway
  let res = await fetch(`${RAILWAY_BASE_URL}/hotspots?ts=${Date.now()}`, { cache:"no-store" });

  // backward-compatible fallback if a deployment still exposes /download
  if (!res.ok && res.status === 404){
    res = await fetch(`${RAILWAY_BASE_URL}/download?ts=${Date.now()}`, { cache:"no-store" });
  }

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Hotspot download failed (${res.status}). ${txt.slice(0,120)}`);
  }

  const payload = await res.json();

  // Expect: { timeline: [...], frames: [{time, polygons, ...}, ...] }
  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  if (!timeline.length || !dataByTime.size){
    throw new Error("Data format missing timeline/frames (JSON shape changed).");
  }

  setStatus(true, `Loaded ${timeline.length} steps from Railway ✅`);
}

function setupSlider(){
  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // iPhone smoothness
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });
}

function setupPanel(){
  const panel = document.getElementById("panel");
  const body = document.getElementById("panelBody");
  const btn = document.getElementById("minBtn");

  btn.addEventListener("click", () => {
    const minimized = body.classList.toggle("hidden");
    btn.textContent = minimized ? "Max" : "Min";
    panel.style.width = minimized ? "auto" : "230px";
  });
}

async function main(){
  setupPanel();

  try{
    setStatus(true, "Loading…");
    await fetchHotspots();
  } catch (e){
    console.error(e);
    setStatus(false, "ERROR: " + e.message);
    document.getElementById("timeLabel").textContent = "Load failed";
    return;
  }

  setupSlider();

  // show first frame
  rebuildAtIndex(0);
}

main();
