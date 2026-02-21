// =======================
// TLC Hotspot Map - app.js
// RULES (strict):
// - Read data from Railway only
// - Color by rating (1–100) for selected 20-minute window:
//   Green = Best, Blue = Medium, Sky = Normal, Red = Avoid
// - Slider uses NYC time and starts closest to current NYC time
// - No checkmarks / X icons
// - No heavy perimeter outlines
// =======================

function requireRailwayBaseUrl(){
  const u = window.RAILWAY_BASE_URL;
  if (!u || typeof u !== "string" || !u.startsWith("http")){
    throw new Error('Missing window.RAILWAY_BASE_URL in index.html');
  }
  return u.replace(/\/+$/, "");
}

function setStatus(ok, msg){
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "statusLine " + (ok ? "statusOk" : "statusBad");
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

function formatNYC(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// Convert an ISO timestamp (which is in the "week template") into minutes since that template week start.
// Your generator uses week_start = Monday 2025-01-06 00:00.
const WEEK_START_ISO = "2025-01-06T00:00:00";
const WEEK_START_MS = new Date(WEEK_START_ISO).getTime();

function minutesSinceWeekStart(iso){
  const ms = new Date(iso).getTime();
  return Math.round((ms - WEEK_START_MS) / 60000);
}

// Current NYC minutes since Monday 00:00 (0..10079)
function currentNYCWeekMinute(){
  const now = new Date();
  // Get current NYC day/hour/minute using Intl parts (reliable)
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false
  }).formatToParts(now);

  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  const wd = (p.weekday || "").toLowerCase(); // "mon"
  const hour = Number(p.hour ?? 0);
  const minute = Number(p.minute ?? 0);

  const map = { mon:0, tue:1, wed:2, thu:3, fri:4, sat:5, sun:6 };
  const dow = map[wd.slice(0,3)] ?? 0;

  return dow * 1440 + hour * 60 + minute;
}

// Circular distance on a week (10080 minutes)
function circDist(a, b){
  const W = 10080;
  const d = Math.abs(a - b);
  return Math.min(d, W - d);
}

// Strict 4-bucket color mapping from rating 1..100
function ratingToBucketColor(rating){
  const r = clamp(Number(rating || 1), 1, 100);

  // Buckets (adjustable, but stable and simple):
  //  1-25  = Red (Avoid)
  // 26-50  = Sky (Normal)
  // 51-75  = Blue (Medium)
  // 76-100 = Green (Best)
  if (r <= 25) return "#e53935";   // Red
  if (r <= 50) return "#79c7ff";   // Sky
  if (r <= 75) return "#1e5bff";   // Blue
  return "#22c55e";                // Green
}

function styleFromFeature(feature){
  const p = feature && feature.properties ? feature.properties : {};
  const rating =
    p.rating ?? p.rating_1_100 ?? p.rating1_100 ??
    p.rating_overall_1_100 ?? p.r ?? null;

  const fill = ratingToBucketColor(rating);
  return {
    stroke: false,          // remove perimeter outline (you asked)
    weight: 0,
    fillColor: fill,
    fillOpacity: 0.55
  };
}

// ---------- Leaflet init ----------
const map = L.map("map", { zoomControl: true }).setView([40.72, -73.98], 12);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);

const polyLayer = L.geoJSON(null, {
  style: styleFromFeature,
  onEachFeature: (feature, layer) => {
    const p = feature && feature.properties ? feature.properties : {};
    // If popup exists, keep it. If not, create a minimal one.
    const rating = p.rating ?? p.rating_1_100 ?? p.rating_overall_1_100 ?? null;

    if (p.popup){
      layer.bindPopup(p.popup, { maxWidth: 360 });
    } else {
      const zone = p.zone ?? p.Zone ?? p.name ?? "Zone";
      const borough = p.borough ?? p.Borough ?? "";
      const html = `
        <div style="font-family:Arial; font-size:13px;">
          <div style="font-weight:900; font-size:14px;">${zone}</div>
          ${borough ? `<div style="color:#666; margin-bottom:4px;">${borough}</div>` : ""}
          <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
        </div>`;
      layer.bindPopup(html, { maxWidth: 360 });
    }
  }
}).addTo(map);

// ---------- Data state ----------
let timeline = [];
let frames = new Map(); // time -> frame
let slider = document.getElementById("slider");

function rebuildAtIndex(idx){
  const t = timeline[idx];
  const frame = frames.get(t);
  if (!frame) return;

  document.getElementById("timeLabel").textContent = formatNYC(t);

  polyLayer.clearLayers();

  // frame.polygons should be a FeatureCollection, or {type,features}
  if (frame.polygons){
    polyLayer.addData(frame.polygons);
  }
}

// Throttled slider (smooth on iPhone)
function attachSlider(){
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

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

// Pick initial slider index closest to current NYC time (week wrap safe)
function chooseInitialIndex(){
  if (!timeline.length) return 0;

  const target = currentNYCWeekMinute();

  let bestIdx = 0;
  let bestD = Infinity;

  for (let i = 0; i < timeline.length; i++){
    const t = timeline[i];
    const m = minutesSinceWeekStart(t);
    const d = circDist(m, target);
    if (d < bestD){
      bestD = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ---------- Railway fetch ----------
async function fetchTimeline(){
  const base = requireRailwayBaseUrl();

  // Try multiple endpoints (because you had different versions earlier)
  const candidates = [
    base + "/download",     // current main.py
  ];

  let lastErr = null;

  for (const url of candidates){
    try{
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok){
        // Try to read json error
        let detail = "";
        try{
          const j = await res.json();
          detail = JSON.stringify(j);
        } catch {}
        throw new Error(`HTTP ${res.status} ${detail}`.trim());
      }
      return await res.json();
    } catch (e){
      lastErr = e;
    }
  }

  throw lastErr || new Error("Failed to fetch timeline from Railway");
}

async function callGenerate(){
  const base = requireRailwayBaseUrl();
  // Keep params stable (your working ones)
  const url = base + "/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25";
  const res = await fetch(url, { method: "POST" });
  let txt = "";
  try { txt = JSON.stringify(await res.json()); } catch {}
  if (!res.ok) throw new Error(`Generate failed: HTTP ${res.status} ${txt}`);
  return true;
}

async function loadAll(){
  setStatus(true, "Loading from Railway…");

  let payload;
  try{
    payload = await fetchTimeline();
  } catch (e){
    setStatus(false, "Load failed ✖");
    document.getElementById("timeLabel").textContent = "Load failed";
    throw e;
  }

  // Expected payload: { timeline: [...], frames: [{time, polygons, markers?...}, ...] }
  timeline = Array.isArray(payload.timeline) ? payload.timeline : [];
  frames = new Map((payload.frames || []).map(f => [f.time, f]));

  if (!timeline.length){
    setStatus(false, "No timeline (run Generate) ✖");
    document.getElementById("timeLabel").textContent = "No data";
    return;
  }

  attachSlider();

  const initIdx = chooseInitialIndex();
  slider.value = String(initIdx);
  rebuildAtIndex(initIdx);

  setStatus(true, `Loaded ${timeline.length} steps ✓`);
}

// Buttons
document.getElementById("btnReload").addEventListener("click", () => {
  loadAll().catch(err => console.error(err));
});

document.getElementById("btnGenerate").addEventListener("click", async () => {
  try{
    setStatus(true, "Generating on Railway…");
    await callGenerate();
    await loadAll();
  } catch (e){
    console.error(e);
    setStatus(false, "Generate failed ✖");
    document.getElementById("timeLabel").textContent = "Generate failed";
  }
});

// Boot
loadAll().catch(err => {
  console.error(err);
  const msg = (err && err.message) ? err.message : String(err);
  setStatus(false, "Load failed ✖");
  document.getElementById("timeLabel").textContent = "ERROR: " + msg;
});