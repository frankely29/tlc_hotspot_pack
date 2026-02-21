// =======================
// app.js (STRICT RULES)
// - Railway ONLY
// - 4 discrete colors by rating(1-100):
//   Green Best, Blue Medium, Sky Normal, Red Avoid
// - NYC time label
// - Slider starts at closest time window to "NOW" in NYC (not index 0)
// - No icons, no checkmarks, no X
// - No polygon outline (stroke disabled)
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

function getNYCParts(date = new Date()){
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value])
  );

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return {
    dow: dowMap[parts.weekday] ?? 0,
    minuteOfDay: (Number(parts.hour) || 0) * 60 + (Number(parts.minute) || 0)
  };
}

function timelineMinuteOfWeekNYC(iso){
  const d = new Date(iso);
  const parts = getNYCParts(d);
  return parts.dow * 1440 + parts.minuteOfDay;
}

function addMinutesISO(iso, minutes){
  const d = new Date(iso);
  return new Date(d.getTime() + minutes * 60 * 1000).toISOString();
}

// ✅ STRICT bucket colors
function ratingToColor(rating){
  const r = clamp(Number(rating || 0), 0, 100);

  // Red = Avoid (lowest)
  if (r <= 25) return "#d32f2f";

  // Sky = Normal
  if (r <= 50) return "#81d4fa";

  // Blue = Medium
  if (r <= 75) return "#1976d2";

  // Green = Best
  return "#2e7d32";
}

function getRailwayBase(){
  const base = window.RAILWAY_BASE_URL;
  if (!base || !String(base).trim()) return null;
  return String(base).replace(/\/+$/, "");
}

const BASE = getRailwayBase();
const BIN_MINUTES = 20;

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

    // Try multiple property names (backend variations)
    const rating =
      p.rating ??
      p.rating_1_100 ??
      (p.rating01 !== undefined ? Math.round(1 + 99 * Number(p.rating01)) : null) ??
      (p.score01 !== undefined ? Math.round(1 + 99 * Number(p.score01)) : null);

    // ✅ IMPORTANT: NO OUTLINE
    // stroke:false removes the perimeter outline completely
    if (rating !== null && rating !== undefined && !Number.isNaN(Number(rating))){
      return {
        stroke: false,
        fillColor: ratingToColor(rating),
        fillOpacity: 0.72
      };
    }

    // Missing rating -> neutral light gray (NOT red)
    return {
      stroke: false,
      fillColor: "#e0e0e0",
      fillOpacity: 0.20
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature?.properties || {};
    const rating =
      p.rating ??
      p.rating_1_100 ??
      (p.score01 !== undefined ? Math.round(1 + 99 * Number(p.score01)) : null);

    const zone = p.zone || p.name || "Zone";
    const borough = p.borough || "";

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        ${borough ? `<div style="color:#666; margin-bottom:6px;">${borough}</div>` : ""}
        <div><b>Rating:</b> ${rating ?? "n/a"} / 100</div>
      </div>
    `;
    layer.bindPopup(popup, { maxWidth: 360 });
  }
}).addTo(map);

const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const btnNow = document.getElementById("btnNow");
const btnGenerate = document.getElementById("btnGenerate");

let timeline = [];

// ---------- API (Railway only) ----------
async function apiGET(path){
  const url = `${BASE}${path}`;
  return await fetch(url, { cache: "no-store" });
}
async function apiPOST(path){
  const url = `${BASE}${path}`;
  return await fetch(url, {
    method: "POST",
    headers: { "accept": "application/json" },
    body: ""
  });
}

function sortTimeline(){
  timeline.sort((a,b) => new Date(a).getTime() - new Date(b).getTime());
}

function setSliderBounds(){
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
}

// Pick index closest to CURRENT NYC day/time, regardless of anchor date.
function pickIndexClosestToNow(){
  if (!timeline.length) return 0;

  const nycNow = getNYCParts();
  const nowMinuteOfWeek = nycNow.dow * 1440 + nycNow.minuteOfDay;
  let bestIdx = 0;
  let bestDiff = Infinity;
  const weekMinutes = 7 * 24 * 60;

  for (let i=0; i<timeline.length; i++){
    const tMinuteOfWeek = timelineMinuteOfWeekNYC(timeline[i]);
    const directDiff = Math.abs(tMinuteOfWeek - nowMinuteOfWeek);
    const wrapDiff = weekMinutes - directDiff;
    const diff = Math.min(directDiff, wrapDiff);
    if (diff < bestDiff){
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

async function loadTimeline(){
  // expects Railway to expose /timeline
  const res = await apiGET("/timeline");
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Failed /timeline (${res.status}). ${txt}`);
  }
  const data = await res.json();
  timeline = data.timeline || [];
  sortTimeline();
}

async function loadFrame(i){
  // Railway exposes /frame/{idx}
  const res = await apiGET(`/frame/${encodeURIComponent(i)}`);
  if (!res.ok){
    const txt = await res.text().catch(()=> "");
    throw new Error(`Failed /frame (${res.status}). ${txt}`);
  }
  return await res.json();
}

function renderFrame(frame){
  const t = frame?.time;
  if (t){
    const endISO = addMinutesISO(t, BIN_MINUTES);
    const startNY = nycTimeLabel(t);
    const endNY = nycTimeLabel(endISO).replace(/^[A-Za-z]{3}\s/, "");
    timeLabel.textContent = `${startNY} – ${endNY} (NYC)`;
  } else {
    timeLabel.textContent = "Unknown time (NYC)";
  }

  polyLayer.clearLayers();
  if (frame?.polygons) polyLayer.addData(frame.polygons);
}

async function goToIndex(i){
  const idx = clamp(Number(i||0), 0, timeline.length - 1);
  slider.value = String(idx);
  const frame = await loadFrame(idx);
  renderFrame(frame);
}

let pending = null;
slider.addEventListener("input", () => {
  pending = Number(slider.value);
  if (slider._raf) return;

  slider._raf = requestAnimationFrame(async () => {
    slider._raf = null;
    try {
      await goToIndex(pending);
    } catch (e) {
      console.error(e);
      setStatus("Load failed");
      timeLabel.textContent = "Load failed";
    }
  });
});

btnNow?.addEventListener("click", async () => {
  try {
    const idx = pickIndexClosestToNow();
    await goToIndex(idx);
  } catch (e) {
    console.error(e);
    setStatus("Load failed");
  }
});

btnGenerate?.addEventListener("click", async () => {
  if (!BASE){
    alert("Missing window.RAILWAY_BASE_URL in index.html");
    return;
  }
  try {
    setStatus("Generating…");
    const res = await apiPOST("/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25");
    if (!res.ok) throw new Error(`Generate failed (${res.status})`);

    // reload timeline + go to NOW
    await boot();
  } catch (e) {
    console.error(e);
    setStatus("Generate failed");
    alert(String(e.message || e));
  }
});

async function boot(){
  if (!BASE){
    setStatus("Load failed");
    timeLabel.textContent = "ERROR: Missing Railway base URL";
    return;
  }

  try {
    setStatus("Loading…");
    await loadTimeline();

    if (!timeline.length){
      setStatus("No timeline");
      timeLabel.textContent = "No timeline data";
      return;
    }

    setSliderBounds();

    // ✅ start slider at current time window (closest)
    const idx = pickIndexClosestToNow();
    setStatus(`Loaded ${timeline.length} steps`);
    await goToIndex(idx);
  } catch (e) {
    console.error(e);
    setStatus("Load failed");
    timeLabel.textContent = "Load failed";
  }
}

boot();
