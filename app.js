// =======================
// TLC Hotspot Map - app.js (NO icons, NO checkmarks)
// - Loads timeline/frames from Railway
// - NYC timezone label restored
// - Fixes “everything red” by computing color from rating buckets
// - Robust: auto-generate if not ready
// =======================

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function setStatus(msg){
  const el = document.getElementById("statusText");
  if (el) el.textContent = msg;
}

function nycTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// ✅ Your desired color rules (discrete buckets)
function ratingToBucketColor(rating){
  const r = clamp(Number(rating || 0), 0, 100);
  // Red = lowest (avoid), Sky = normal, Blue = medium, Green = best
  if (r <= 25) return "#e53935";     // red
  if (r <= 50) return "#81d4fa";     // sky
  if (r <= 75) return "#1e88e5";     // blue
  return "#43a047";                 // green
}

function getRailwayBase(){
  // 1) window variable from index.html
  if (window.RAILWAY_BASE_URL && String(window.RAILWAY_BASE_URL).trim()){
    return String(window.RAILWAY_BASE_URL).replace(/\/+$/, "");
  }

  // 2) allow URL override: ?railway=https://xxxx.up.railway.app
  const qs = new URLSearchParams(location.search);
  const q = qs.get("railway");
  if (q) return String(q).replace(/\/+$/, "");

  return null;
}

const BASE = getRailwayBase();

// Leaflet setup
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};

    // Try to locate rating in multiple possible fields:
    const rating =
      p.rating ??
      p.rating_1_100 ??
      p.rating01 ? Math.round(1 + 99 * Number(p.rating01)) :
      p.score01 ? Math.round(1 + 99 * Number(p.score01)) :
      null;

    // If rating exists, force our bucket colors (prevents “all red” bugs)
    if (rating !== null && rating !== undefined && !Number.isNaN(Number(rating))){
      return {
        color: "#0b0b0b",
        weight: 2,
        opacity: 0.9,
        fillColor: ratingToBucketColor(rating),
        fillOpacity: 0.45
      };
    }

    // Fallback: use style from data if present
    if (p.style && typeof p.style === "object"){
      return {
        color: p.style.color || "#0b0b0b",
        weight: p.style.weight ?? 2,
        opacity: 0.9,
        fillColor: p.style.fillColor || "#cccccc",
        fillOpacity: p.style.fillOpacity ?? 0.35
      };
    }

    // Final fallback
    return { color:"#0b0b0b", weight:2, fillColor:"#cccccc", fillOpacity:0.25 };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};

    // Clean popup: show rating if available
    const rating =
      p.rating ??
      p.rating_1_100 ??
      (p.score01 ? Math.round(1 + 99 * Number(p.score01)) : null);

    let popup = "";
    if (p.popup) {
      popup = p.popup;
    } else {
      popup = `
        <div style="font-family:Arial; font-size:13px;">
          <div style="font-weight:900;">Zone</div>
          <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
        </div>
      `;
    }
    layer.bindPopup(popup, { maxWidth: 360 });
  }
}).addTo(map);

// UI elements
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnGenerate = document.getElementById("btnGenerate");
const btnReload = document.getElementById("btnReload");

let timeline = [];

// ---- Railway API helpers ----

async function apiGET(path){
  const url = `${BASE}${path}`;
  const res = await fetch(url, { cache: "no-store" });
  return res;
}

async function apiPOST(path){
  const url = `${BASE}${path}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json" },
    body: ""
  });
  return res;
}

async function loadTimeline(){
  // Preferred: /timeline (fast)
  let res = await apiGET("/timeline");

  // Fallback: if /timeline not implemented, try /download and read timeline from file
  if (res.status === 404) {
    res = await apiGET("/download");
    if (!res.ok) throw new Error(`Failed to fetch /download (${res.status})`);
    const payload = await res.json();
    if (!payload.timeline) throw new Error("Download JSON missing timeline");
    timeline = payload.timeline;
    setStatus(`Loaded ${timeline.length} steps ✓`);
    return;
  }

  if (!res.ok) {
    // often 404 with message "timeline not ready. Call /generate first."
    const txt = await res.text().catch(()=> "");
    throw new Error(`Timeline not ready (${res.status}). ${txt}`);
  }

  const data = await res.json();
  timeline = data.timeline || [];
  setStatus(`Loaded ${timeline.length} steps ✓`);
}

async function loadFrameByIndex(i){
  // Preferred: /frame?i= (fast)
  let res = await apiGET(`/frame?i=${encodeURIComponent(i)}`);

  // Fallback: if /frame not implemented, use /download and slice locally (slow but works)
  if (res.status === 404){
    res = await apiGET("/download");
    if (!res.ok) throw new Error(`Failed to fetch /download (${res.status})`);
    const payload = await res.json();
    const frames = payload.frames || [];
    const frame = frames[i];
    if (!frame) throw new Error("Frame not found in download JSON");
    return frame;
  }

  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Frame fetch failed (${res.status}). ${txt}`);
  }

  return await res.json();
}

function renderFrame(frame){
  const t = frame?.time;
  if (t) timeLabel.textContent = nycTimeLabel(t);

  polyLayer.clearLayers();

  // frame.polygons can be FeatureCollection or array; handle both
  const polys = frame?.polygons;
  if (polys){
    polyLayer.addData(polys);
  }
}

function setSliderBounds(){
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;
}

// Throttled slider updates (smooth on iPhone)
let pendingIdx = null;
slider.addEventListener("input", () => {
  pendingIdx = Number(slider.value);
  if (slider._raf) return;
  slider._raf = requestAnimationFrame(async () => {
    slider._raf = null;
    if (pendingIdx === null) return;
    try {
      const frame = await loadFrameByIndex(pendingIdx);
      renderFrame(frame);
    } catch (e) {
      console.error(e);
      setStatus("Load failed ✖");
      timeLabel.textContent = "Load failed";
    }
  });
});

btnReload?.addEventListener("click", () => {
  location.reload();
});

btnGenerate?.addEventListener("click", async () => {
  if (!BASE) {
    alert("Missing Railway base URL. Edit index.html: window.RAILWAY_BASE_URL = 'https://...'");
    return;
  }
  setStatus("Generating…");
  try {
    const res = await apiPOST("/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25");
    if (!res.ok) throw new Error(`Generate failed (${res.status})`);
    // After generate, reload timeline + first frame
    await boot(true);
  } catch (e) {
    console.error(e);
    setStatus("Generate failed ✖");
    alert(String(e.message || e));
  }
});

// Main boot
async function boot(forceRegenerateIfNeeded=false){
  if (!BASE){
    setStatus("Load failed ✖");
    timeLabel.textContent = "ERROR: Missing Railway base URL";
    return;
  }

  try {
    setStatus("Loading…");

    // Try timeline first
    await loadTimeline();
    setSliderBounds();

    // Load first frame
    if (timeline.length > 0){
      const frame0 = await loadFrameByIndex(0);
      renderFrame(frame0);
      setStatus(`Loaded ${timeline.length} steps ✓`);
      return;
    }

    setStatus("No data ✖");
    timeLabel.textContent = "No timeline data";
  } catch (e) {
    // If timeline not ready, optionally auto-generate once
    console.error(e);

    if (forceRegenerateIfNeeded || String(e.message || "").includes("not ready")) {
      try {
        setStatus("Not ready. Generating…");
        const r = await apiPOST("/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25");
        if (!r.ok) throw new Error(`Generate failed (${r.status})`);

        // Retry timeline + first frame
        await loadTimeline();
        setSliderBounds();
        const frame0 = await loadFrameByIndex(0);
        renderFrame(frame0);
        setStatus(`Loaded ${timeline.length} steps ✓`);
        return;
      } catch (e2) {
        console.error(e2);
      }
    }

    setStatus("Load failed ✖");
    timeLabel.textContent = "Load failed";
  }
}

boot(false);