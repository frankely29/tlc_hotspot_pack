// =======================
// TLC Hotspot Map - app.js (Phone-first)
// DATA SOURCE: Railway /hotspots (NOT GitHub)
// VISUAL RULES:
// - Top zones = GREEN shades only
// - Bottom zones = RED shades only
// - Others = GRAY (neutral / very low)
// - Icons only for extremes (Top/Bottom) -> no mixed signals
// =======================

function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function lerp(a,b,t){ return a + (b-a)*t; }

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit"
  });
}

// green shade intensity (0..1) => light green -> strong green
function greenShade(t){
  t = clamp01(t);
  const r = Math.round(lerp(190,  20, t));
  const g = Math.round(lerp(240, 170, t));
  const b = Math.round(lerp(190,  20, t));
  const toHex = (n)=>n.toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// red shade intensity (0..1) => light red -> strong red
function redShade(t){
  t = clamp01(t);
  const r = Math.round(lerp(255, 170, t));
  const g = Math.round(lerp(210,  20, t));
  const b = Math.round(lerp(210,  20, t));
  const toHex = (n)=>n.toString(16).padStart(2,'0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

function getRailwayBase(){
  // index.html sets window.RAILWAY_BASE
  return (window.RAILWAY_BASE || "").replace(/\/+$/,"");
}

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes: keep markers above polygons
map.createPane("polys");   map.getPane("polys").style.zIndex = 400;
map.createPane("markers"); map.getPane("markers").style.zIndex = 650;

const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: () => ({ color:"#888", weight:1, fillColor:"#ddd", fillOpacity:0.18 })
}).addTo(map);

const markerLayer = L.layerGroup([], { pane: "markers" }).addTo(map);

let timeline = [];
let dataByTime = new Map();
let currentIndex = 0;

// UI elements
const elTime = () => document.getElementById("timeLabel");
const elSlider = () => document.getElementById("slider");
const elTopN = () => document.getElementById("topN");
const elBotN = () => document.getElementById("botN");
const elShowIcons = () => document.getElementById("showIcons");
const elStatus = () => document.getElementById("statusLine");

// Read rating from feature properties (robust against schema changes)
function getRatingFromFeature(f){
  const p = (f && f.properties) ? f.properties : {};
  const r =
    p.rating_1_100 ??
    p.rating ??
    p.rating100 ??
    p.r ??
    null;

  const num = Number(r);
  if (!Number.isFinite(num)) return null;
  return Math.max(1, Math.min(100, num));
}

// Build popup with whatever fields exist
function makePopupHTML(f, category){
  const p = (f && f.properties) ? f.properties : {};
  const rating = getRatingFromFeature(f);
  const zone = p.zone || p.Zone || p.name || p.LocationID || "Zone";
  const borough = p.borough || p.Borough || "";

  const pickups = (p.pickups ?? p.Pickups ?? null);
  const pay = (p.avg_driver_pay ?? p.avgPay ?? null);
  const tips = (p.avg_tips ?? p.avgTips ?? null);

  return `
    <div style="font-family:Arial; font-size:13px;">
      <div style="font-weight:900; font-size:14px;">${zone}</div>
      <div style="color:#666; margin-bottom:4px;">${borough} ${borough ? "—" : ""} <b>${category}</b></div>
      <div><b>Rating:</b> <span style="font-weight:900;">${rating ?? "n/a"}/100</span></div>
      <hr style="margin:6px 0;">
      <div><b>Pickups:</b> ${pickups ?? "n/a"}</div>
      <div><b>Avg driver pay:</b> ${fmtMoney(pay)}</div>
      <div><b>Avg tips:</b> ${fmtMoney(tips)}</div>
    </div>
  `;
}

function rebuildAtIndex(idx){
  currentIndex = idx;

  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  elTime().textContent = formatTimeLabel(key);

  polyLayer.clearLayers();
  markerLayer.clearLayers();

  const topN = Math.max(1, Math.min(200, Number(elTopN().value || 25)));
  const botN = Math.max(1, Math.min(200, Number(elBotN().value || 25)));
  const showIcons = !!elShowIcons().checked;

  // Expect bundle.polygons as GeoJSON FeatureCollection or array of features
  let features = [];
  if (bundle.polygons && bundle.polygons.features) features = bundle.polygons.features;
  else if (Array.isArray(bundle.polygons)) features = bundle.polygons;
  else if (bundle.polygons && bundle.polygons.type === "FeatureCollection") features = bundle.polygons.features;
  else features = [];

  // Compute ratings
  const rated = features
    .map(f => ({ f, rating: getRatingFromFeature(f) }))
    .filter(x => x.rating !== null);

  if (rated.length === 0){
    elStatus().textContent = "No polygon data for this time window.";
    return;
  }

  // Determine Top and Bottom sets for THIS time window
  const sortedDesc = [...rated].sort((a,b)=>b.rating - a.rating);
  const sortedAsc  = [...rated].sort((a,b)=>a.rating - b.rating);

  const topSet = new Set(sortedDesc.slice(0, topN).map(x => x.f));
  const botSet = new Set(sortedAsc.slice(0, botN).map(x => x.f));

  // For shading intensity inside top/bottom groups
  const topMin = sortedDesc.slice(0, topN).reduce((m,x)=>Math.min(m,x.rating), 100);
  const topMax = sortedDesc.slice(0, topN).reduce((m,x)=>Math.max(m,x.rating), 1);
  const botMin = sortedAsc.slice(0, botN).reduce((m,x)=>Math.min(m,x.rating), 100);
  const botMax = sortedAsc.slice(0, botN).reduce((m,x)=>Math.max(m,x.rating), 1);

  function norm(v, a, b){
    if (a === b) return 1;
    return clamp01((v - a) / (b - a));
  }

  // Add polygons with our clear styling
  const fc = {
    type: "FeatureCollection",
    features: features.map(f => {
      const rating = getRatingFromFeature(f);
      const isTop = topSet.has(f);
      const isBot = botSet.has(f);

      let fillColor = "#d9d9d9"; // neutral gray
      let border = "#888";
      let fillOpacity = 0.12;
      let category = "Neutral (Very Low)";

      if (rating !== null && isTop){
        const t = norm(rating, topMin, topMax);
        fillColor = greenShade(t);
        border = "#1f8f3a";
        fillOpacity = 0.38;
        category = "Top (Good)";
      } else if (rating !== null && isBot){
        const t = norm(rating, botMin, botMax);
        fillColor = redShade(t);
        border = "#b02020";
        fillOpacity = 0.33;
        category = "Bottom (Avoid)";
      }

      // attach popup
      const p = f.properties || {};
      const popup = makePopupHTML(f, category);

      return {
        ...f,
        properties: {
          ...p,
          __category: category,
          __rating: rating,
          popup: popup,
          style: {
            color: border,
            weight: isTop || isBot ? 3 : 1,
            fillColor: fillColor,
            fillOpacity: fillOpacity
          }
        }
      };
    })
  };

  polyLayer.addData(fc);
  polyLayer.eachLayer(layer => {
    const p = layer.feature?.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  });

  // Icons ONLY for extremes (no mixed signals)
  if (showIcons){
    const makeIcon = (type) => {
      const isTop = (type === "TOP");
      const html = isTop
        ? '<div style="width:28px;height:28px;border-radius:14px;background:#fff;border:3px solid #1f8f3a;display:flex;align-items:center;justify-content:center;font-weight:900;color:#1f8f3a;font-size:16px;">✓</div>'
        : '<div style="width:28px;height:28px;border-radius:14px;background:#fff;border:3px solid #b02020;display:flex;align-items:center;justify-content:center;font-weight:900;color:#b02020;font-size:16px;">×</div>';
      return L.divIcon({ html, className:"", iconSize:[28,28], iconAnchor:[14,14] });
    };

    // Use polygon bounds center as fallback (no centroid data required)
    function addIconForFeature(f, type){
      try{
        const layer = L.geoJSON(f);
        const bounds = layer.getBounds();
        if (!bounds.isValid()) return;
        const c = bounds.getCenter();
        const icon = makeIcon(type);

        const category = (type === "TOP") ? "Top (Good)" : "Bottom (Avoid)";
        const popup = makePopupHTML(f, category);

        L.marker([c.lat, c.lng], { icon, pane:"markers" })
          .bindPopup(popup, { maxWidth: 360 })
          .addTo(markerLayer);
      } catch(e){}
    }

    sortedDesc.slice(0, topN).forEach(x => addIconForFeature(x.f, "TOP"));
    sortedAsc.slice(0, botN).forEach(x => addIconForFeature(x.f, "BOT"));
  }

  elStatus().textContent =
    `Showing Top ${topN} (green), Bottom ${botN} (red), others gray.`;
}

async function fetchHotspots(){
  const base = getRailwayBase();
  if (!base) throw new Error("RAILWAY_BASE not set in index.html");

  const url = `${base}/hotspots`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    const text = await res.text().catch(()=> "");
    throw new Error(`Failed to fetch hotspots (${res.status}). ${text}`);
  }
  return await res.json();
}

async function runGenerate(){
  const base = getRailwayBase();
  const url = `${base}/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25`;
  const res = await fetch(url, { method:"POST" });
  if (!res.ok){
    const msg = await res.text().catch(()=> "");
    throw new Error(`Generate failed (${res.status}). ${msg}`);
  }
  return await res.json();
}

function wireUI(){
  const slider = elSlider();

  slider.addEventListener("input", () => {
    const idx = Number(slider.value);

    // iPhone-friendly throttle
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      rebuildAtIndex(idx);
    });
  });

  // re-style without refetching
  elTopN().addEventListener("change", () => rebuildAtIndex(currentIndex));
  elBotN().addEventListener("change", () => rebuildAtIndex(currentIndex));
  elShowIcons().addEventListener("change", () => rebuildAtIndex(currentIndex));

  const btnGen = document.getElementById("btnGenerate");
  if (btnGen){
    btnGen.addEventListener("click", async () => {
      try{
        btnGen.disabled = true;
        elStatus().textContent = "Generating on Railway...";
        await runGenerate();
        elStatus().textContent = "Reloading hotspots...";
        await loadAndRender();
      } catch(e){
        elStatus().textContent = `ERROR: ${e.message}`;
      } finally {
        btnGen.disabled = false;
      }
    });
  }

  const btnMin = document.getElementById("btnMin");
  if (btnMin){
    btnMin.addEventListener("click", () => {
      const panel = document.getElementById("panel");
      panel.classList.toggle("min");
      btnMin.textContent = panel.classList.contains("min") ? "Max" : "Min";
    });
  }
}

async function loadAndRender(){
  const payload = await fetchHotspots();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = elSlider();
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  if (timeline.length > 0){
    rebuildAtIndex(0);
    elStatus().textContent = `Loaded ${timeline.length} steps from Railway ✅`;
  } else {
    elTime().textContent = "No data";
    elStatus().textContent = "hotspots file has no timeline.";
  }
}

async function main(){
  wireUI();

  try{
    elTime().textContent = "Loading...";
    elStatus().textContent = "Fetching hotspots from Railway...";
    await loadAndRender();
  } catch(err){
    console.error(err);
    elTime().textContent = "ERROR";
    elStatus().textContent = "ERROR: " + err.message;
  }
}

main();