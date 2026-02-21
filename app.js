// =======================
// TLC Hotspot Map - app.js (Phone-friendly)
// Polygons = rating (red→yellow→green)
// Icons = extremes only (Top ✓ / Bottom ✖ per time window)
// Purple dots = intensity indicator (higher rating = more purple)
// Data loads from Railway: GET {RAILWAY_BASE}/hotspots
// =======================

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

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

function getApiBase(){
  // Allow override: ?api=https://your-railway-domain
  const u = new URL(location.href);
  const qp = u.searchParams.get("api");
  if (qp) return qp.replace(/\/+$/,"");
  // Default (SET THIS to your Railway domain)
  return "https://web-production-78f67.up.railway.app";
}

const RAILWAY_BASE = getApiBase();

// Map
const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes (polys below icons)
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("dots");
map.getPane("dots").style.zIndex = 520;

map.createPane("icons");
map.getPane("icons").style.zIndex = 650;

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (f) => (f && f.properties && f.properties.style) ? f.properties.style : {color:"#444", weight:1, fillOpacity:0.55},
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const dotLayer = L.layerGroup().addTo(map);
const iconLayer = L.layerGroup().addTo(map);

let timeline = [];
let framesByTime = new Map();

// UI elements
const timeLabelEl = document.getElementById("timeLabel");
const sliderEl = document.getElementById("slider");
const statusEl = document.getElementById("statusLine");
const showIconsEl = document.getElementById("showIcons");
const topNEl = document.getElementById("topN");
const botNEl = document.getElementById("botN");
const showDotsEl = document.getElementById("showDots");
const generateBtn = document.getElementById("generateBtn");

function makeBadgeIcon(type){
  // type: "TOP" or "BOTTOM"
  const isTop = type === "TOP";
  const symbol = isTop ? "✓" : "✖";
  const stroke = isTop ? "#00b050" : "#e60000";

  const html = `
    <div style="
      width:28px;height:28px;border-radius:14px;
      background:#fff;
      border:3px solid ${stroke};
      display:flex;align-items:center;justify-content:center;
      font-weight:900;
      font-size:18px;
      color:#111;
      box-shadow:0 1px 6px rgba(0,0,0,0.25);
    ">${symbol}</div>
  `;
  return L.divIcon({
    html,
    className: "",
    iconSize: [28,28],
    iconAnchor: [14,14]
  });
}

function clearAll(){
  polyLayer.clearLayers();
  dotLayer.clearLayers();
  iconLayer.clearLayers();
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const frame = framesByTime.get(key);
  if (!frame) return;

  timeLabelEl.textContent = formatTimeLabel(key);
  clearAll();

  // 1) Polygons (rating color)
  if (frame.polygons) polyLayer.addData(frame.polygons);

  // Collect “zone items” from polygons to compute extremes per window
  const zoneItems = [];
  try {
    const feats = (frame.polygons && frame.polygons.features) ? frame.polygons.features : [];
    for (const f of feats){
      const p = f.properties || {};
      // rating can be inside popup only, but in our generator it exists as p.rating or can be derived:
      // We support either p.rating OR p.style.fillColor -> convert to approx not needed.
      const rating = (p.rating !== undefined) ? Number(p.rating) : null;
      const center = p.center || null; // if generator provides
      zoneItems.push({ feature: f, props: p, rating, center });
    }
  } catch(e){}

  // 2) Purple “intensity” dots (one per polygon/zone)
  const showDots = !!(showDotsEl && showDotsEl.checked);
  if (showDots){
    const feats = (frame.polygons && frame.polygons.features) ? frame.polygons.features : [];
    for (const f of feats){
      const p = f.properties || {};
      const rating = (p.rating !== undefined) ? Number(p.rating) : null;
      const c = p.center; // [lat,lng] preferred
      if (!c || !Array.isArray(c) || c.length !== 2) continue;
      if (rating === null || Number.isNaN(rating)) continue;

      const t = clamp01((rating - 1) / 99); // 0..1
      const radius = 6 + Math.round(12 * t);
      const opacity = 0.10 + 0.35 * t;

      const circle = L.circleMarker([c[0], c[1]], {
        pane: "dots",
        radius,
        color: "transparent",
        weight: 0,
        fillColor: "#7a2cff", // purple
        fillOpacity: opacity
      });

      circle.addTo(dotLayer);
    }
  }

  // 3) Extremes-only icons (Top ✓, Bottom ✖) per current window
  const showIcons = !!(showIconsEl && showIconsEl.checked);
  if (!showIcons) return;

  // Don’t spam icons when zoomed out
  if (map.getZoom() < 12) return;

  const topN = Math.max(0, Number(topNEl?.value || 25));
  const botN = Math.max(0, Number(botNEl?.value || 25));

  // We need sortable items with rating + center
  const items = [];
  const feats = (frame.polygons && frame.polygons.features) ? frame.polygons.features : [];
  for (const f of feats){
    const p = f.properties || {};
    const rating = (p.rating !== undefined) ? Number(p.rating) : null;
    const c = p.center;
    if (!c || !Array.isArray(c) || c.length !== 2) continue;
    if (rating === null || Number.isNaN(rating)) continue;
    items.push({ p, rating, c });
  }

  // Sort high→low and low→high
  const hi = [...items].sort((a,b)=>b.rating - a.rating).slice(0, topN);
  const lo = [...items].sort((a,b)=>a.rating - b.rating).slice(0, botN);

  const topIcon = makeBadgeIcon("TOP");
  const botIcon = makeBadgeIcon("BOTTOM");

  function bindPopupFor(item, type){
    const p = item.p || {};
    const zone = p.zone || p.Zone || p.name || "Zone";
    const borough = p.borough || p.Borough || "Unknown";
    const pickups = (p.pickups !== undefined) ? p.pickups : "n/a";
    const avgPay = p.avg_driver_pay;
    const avgTips = p.avg_tips;

    const rating = item.rating;
    const color = scoreToColorHex((rating - 1) / 99);

    const label = (type === "TOP") ? "Very Good (Top)" : "Very Low (Bottom)";
    return `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${zone}</div>
        <div style="color:#666; margin-bottom:4px;">${borough} — <b>${label}</b></div>
        <div><b>Rating:</b> <span style="font-weight:900; color:${color};">${rating}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${pickups}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(avgPay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(avgTips)}</div>
      </div>
    `;
  }

  for (const it of hi){
    const m = L.marker([it.c[0], it.c[1]], { icon: topIcon, pane: "icons" });
    m.bindPopup(bindPopupFor(it, "TOP"), { maxWidth: 360 });
    m.addTo(iconLayer);
  }

  for (const it of lo){
    const m = L.marker([it.c[0], it.c[1]], { icon: botIcon, pane: "icons" });
    m.bindPopup(bindPopupFor(it, "BOTTOM"), { maxWidth: 360 });
    m.addTo(iconLayer);
  }
}

async function loadHotspots(){
  statusEl.textContent = `Loading data from Railway: ${RAILWAY_BASE}`;

  const url = `${RAILWAY_BASE}/hotspots`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok){
    throw new Error(`Failed to fetch hotspots (${res.status}). Make sure Railway has /hotspots and you ran /generate.`);
  }

  const payload = await res.json();

  timeline = payload.timeline || [];
  framesByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  sliderEl.min = 0;
  sliderEl.max = Math.max(0, timeline.length - 1);
  sliderEl.step = 1;
  sliderEl.value = 0;

  // Throttled slider (smooth on iPhone)
  let pending = null;
  sliderEl.addEventListener("input", () => {
    pending = Number(sliderEl.value);
    if (sliderEl._raf) return;
    sliderEl._raf = requestAnimationFrame(() => {
      sliderEl._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  // Rebuild when toggles change
  function refresh(){ rebuildAtIndex(Number(sliderEl.value)); }
  showIconsEl?.addEventListener("change", refresh);
  showDotsEl?.addEventListener("change", refresh);
  topNEl?.addEventListener("change", refresh);
  botNEl?.addEventListener("change", refresh);
  map.on("zoomend", refresh);

  if (timeline.length > 0){
    statusEl.textContent = `Loaded ${timeline.length} time steps from Railway ✅`;
    rebuildAtIndex(0);
  } else {
    statusEl.textContent = `Loaded but no frames found in payload.`;
    timeLabelEl.textContent = "No data";
  }
}

async function runGenerate(){
  // Optional button: triggers Railway generation
  try{
    generateBtn.disabled = true;
    statusEl.textContent = "Generating on Railway… (this can take a bit)";
    const genUrl = `${RAILWAY_BASE}/generate?bin_minutes=20&good_n=200&bad_n=120&win_good_n=80&win_bad_n=40&min_trips_per_window=10&simplify_meters=25`;
    const res = await fetch(genUrl, { method: "POST" });
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || `Generate failed (${res.status})`);
    statusEl.textContent = `Generate OK ✅ (${j.size_mb} MB). Reloading data…`;
    await loadHotspots();
  } catch(e){
    statusEl.textContent = "ERROR: " + (e?.message || String(e));
  } finally {
    generateBtn.disabled = false;
  }
}

generateBtn?.addEventListener("click", runGenerate);

loadHotspots().catch(err => {
  console.error(err);
  statusEl.textContent = "ERROR: " + err.message;
  timeLabelEl.textContent = "ERROR";
});