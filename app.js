const RAILWAY = (window.RAILWAY_BASE_URL || "").replace(/\/+$/, "");
if (!RAILWAY) throw new Error("Missing window.RAILWAY_BASE_URL in index.html");

function formatNYCTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

function setErr(msg) {
  const el = document.getElementById("err");
  el.style.display = "block";
  el.textContent = msg;
}

function clearErr() {
  const el = document.getElementById("err");
  el.style.display = "none";
  el.textContent = "";
}

function setTopStatus(ok, msg) {
  const el = document.getElementById("topStatus");
  el.classList.toggle("bad", !ok);
  el.textContent = msg;
}

const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => (f && f.properties && f.properties.style) ? f.properties.style : { color:"#999", weight:1, fillOpacity:0.2 },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 320 });
  }
}).addTo(map);

let timeline = [];
let framesByTime = new Map();

function closestIndexToNow() {
  if (!timeline.length) return 0;
  const nowMs = Date.now();

  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < timeline.length; i++) {
    const tMs = new Date(timeline[i]).getTime();
    const diff = Math.abs(tMs - nowMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function renderAtIndex(idx) {
  const key = timeline[idx];
  const bundle = framesByTime.get(key);
  if (!bundle) return;

  document.getElementById("timeLabel").textContent = formatNYCTime(key);

  polyLayer.clearLayers();
  if (bundle.polygons) polyLayer.addData(bundle.polygons);
}

async function fetchHotspots() {
  clearErr();
  setTopStatus(false, "Loading from Railway…");

  const res = await fetch(`${RAILWAY}/hotspots_20min.json`, { cache: "no-store" });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${txt}`);
  }
  const payload = await res.json();

  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  if (!timeline.length) throw new Error("No timeline in hotspots_20min.json");

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  const startIdx = closestIndexToNow();
  slider.value = String(startIdx);
  renderAtIndex(startIdx);

  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) renderAtIndex(pending);
    });
  });

  setTopStatus(true, `Loaded ${timeline.length} steps ✓`);
}

async function callGenerate() {
  clearErr();
  setTopStatus(false, "Generating on Railway…");

  const qs = new URLSearchParams({
    bin_minutes: "20",
    min_trips_per_window: "10",
    normal_lo: "40",
    medium_lo: "60",
    best_lo: "80"
  });

  const res = await fetch(`${RAILWAY}/generate?${qs.toString()}`, {
    method: "POST",
    headers: { "accept": "application/json" }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Generate failed (${res.status}). ${txt}`);
  }

  await res.json();
  await fetchHotspots();
}

document.getElementById("btnReload").addEventListener("click", () => {
  fetchHotspots().catch(err => {
    console.error(err);
    setErr(String(err.message || err));
    setTopStatus(false, "Load failed ✗");
  });
});

document.getElementById("btnGenerate").addEventListener("click", () => {
  callGenerate().catch(err => {
    console.error(err);
    setErr(String(err.message || err));
    setTopStatus(false, "Generate failed ✗");
  });
});

fetchHotspots().catch(err => {
  console.error(err);
  setErr(String(err.message || err));
  setTopStatus(false, "Load failed ✗");
});
