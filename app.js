// =======================
// TLC Hotspot Map - app.js (NO ICONS)
// - Loads data from Railway /hotspots (with /download fallback)
// - Colors polygons with 2 bands only (Green best, Yellow medium)
// - Clear error messages if anything fails
// - Slider throttled for iPhone
// =======================

function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }

const NYC_WEEKDAY_INDEX = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function getNycWeekMinute(dateLike){
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(new Date(dateLike));

  const weekday = parts.find(p => p.type === "weekday")?.value;
  const hour = Number(parts.find(p => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find(p => p.type === "minute")?.value ?? 0);
  const dayIndex = NYC_WEEKDAY_INDEX[weekday] ?? 0;

  return (dayIndex * 24 * 60) + (hour * 60) + minute;
}

function getTimelineIndexNearestNow(){
  if (!timeline.length) return 0;

  const week = 7 * 24 * 60;
  const nowNycWeekMinute = getNycWeekMinute(Date.now());
  let bestIdx = 0;
  let bestDiff = Number.POSITIVE_INFINITY;

  for (let i = 0; i < timeline.length; i += 1){
    const t = new Date(timeline[i]);
    if (!Number.isFinite(t.getTime())) continue;
    const frameNycWeekMinute = getNycWeekMinute(t);
    const diff = Math.abs(frameNycWeekMinute - nowNycWeekMinute);
    const wrappedDiff = Math.min(diff, week - diff);
    if (wrappedDiff < bestDiff){
      bestDiff = wrappedDiff;
      bestIdx = i;
    }
  }

  return bestIdx;
}

function updateCurrentTimeLabel(){
  const currentTimeLabel = document.getElementById("currentTimeLabel");
  if (!currentTimeLabel) return;
  currentTimeLabel.textContent = `Current NYC time: ${new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit"
  })}`;
}

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
// Two-color scale: high rating -> green, all other zones -> yellow
function ratingToColor(rating){
  const r = Number(rating);
  if (!Number.isFinite(r)) return { fill:"#ffcc00", op:0.5 };

  if (r >= 67){
    return { fill:"#00d66b", op:0.72 };
  }

  return { fill:"#ffcc00", op:0.66 };
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

    // Enforce app-side two-color scheme (ignore any upstream red style)
    const finalFill = fill;
    const finalOp = op;

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
let liveTimer = null;
let isLiveMode = true;

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

function setLiveBadge(){
  const badge = document.getElementById("liveBadge");
  if (!badge) return;
  badge.textContent = isLiveMode ? "Live mode: ON (follows current NYC time)" : "Live mode: OFF (manual slider)";
  badge.classList.toggle("paused", !isLiveMode);
}

function syncToCurrentTime(){
  if (!timeline.length) return;
  const slider = document.getElementById("slider");
  const idx = getTimelineIndexNearestNow();
  slider.value = idx;
  rebuildAtIndex(idx);
}

function startLiveMode(){
  if (liveTimer) clearInterval(liveTimer);
  isLiveMode = true;
  setLiveBadge();
  syncToCurrentTime();
  liveTimer = setInterval(syncToCurrentTime, 1000 * 30);
}

function stopLiveMode(){
  isLiveMode = false;
  setLiveBadge();
  if (liveTimer){
    clearInterval(liveTimer);
    liveTimer = null;
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
  const nowBtn = document.getElementById("nowBtn");

  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;

  // iPhone smoothness
  let pending = null;
  slider.addEventListener("input", () => {
    stopLiveMode();
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  nowBtn.addEventListener("click", startLiveMode);

  startLiveMode();
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
  updateCurrentTimeLabel();
  setInterval(updateCurrentTimeLabel, 1000 * 30);
}

main();
