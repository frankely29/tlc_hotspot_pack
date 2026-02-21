// =======================
// TLC Hotspot Map - app.js (Phone-first, Clear signals)
// - Polygons: Red/Yellow/Green/Purple only (no confusing mismatches)
// - Icons: ✔ only for good/purple zones, ✖ only for bad/red zones
// - Declutter markers to avoid overlap (screen-space spacing)
// - Markers show only when zoomed in (clean view)
// - Time label forced to NYC time
// - Fetch from Railway /download (so no GitHub 25MB limits)
// =======================

// >>> SET THIS to your Railway domain <<<
const API_BASE = "https://web-production-78f67.up.railway.app"; // change if your domain changes
const HOTSPOTS_URL = `${API_BASE}/download`;

function clamp01(x){ return Math.max(0, Math.min(1, x)); }

function formatTimeLabel(iso){
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday:"short",
    hour:"numeric",
    minute:"2-digit"
  });
}

function fmtMoney(x){
  if (x === null || x === undefined || Number.isNaN(x)) return "n/a";
  return `$${Number(x).toFixed(2)}`;
}

// --- Color rules (clear + consistent) ---
// We use rating 1..100 (from your builder output)
function ratingToFill(r){
  const rating = Number(r || 0);

  // Purple = elite hotspots (top tier)
  if (rating >= 90) return { fill: "#7a2cff", border: "#2f7dff" }; // purple fill, blue-ish border

  // Green = good
  if (rating >= 65) return { fill: "#00b050", border: "#007a38" };

  // Yellow = mid
  if (rating >= 45) return { fill: "#ffd700", border: "#b59b00" };

  // Red = bad
  return { fill: "#e60000", border: "#990000" };
}

function ratingToIcon(rating){
  const r = Number(rating || 0);
  if (r >= 65) return "GOOD"; // ✔
  if (r <= 44) return "BAD";  // ✖
  return "NONE";              // no icon for mid zones (less clutter)
}

const map = L.map('map', { zoomControl: true }).setView([40.72, -73.98], 12);
L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; OpenStreetMap &copy; CARTO'
}).addTo(map);

// Panes so markers always sit above polygons
map.createPane("polys");
map.getPane("polys").style.zIndex = 400;

map.createPane("markers");
map.getPane("markers").style.zIndex = 650;

// Dynamic legend (top)
const legend = document.getElementById("legend");
if (legend){
  legend.innerHTML = `
    <div style="
      position: fixed; top: 18px; left: 18px; width: 420px; z-index: 9999;
      background: rgba(255,255,255,0.97); padding: 12px;
      border: 2px solid #111; border-radius: 10px;
      font-family: Arial; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    ">
      <div style="font-weight:900; margin-bottom:8px; font-size:15px;">
        NYC HVFHV Pickup Zones (1–100)
      </div>

      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-bottom:8px;">
        <div><span style="display:inline-block;width:14px;height:14px;background:#7a2cff;border:1px solid #111;vertical-align:middle;"></span> Purple = Elite</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#00b050;border:1px solid #111;vertical-align:middle;"></span> Green = Good</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#ffd700;border:1px solid #111;vertical-align:middle;"></span> Yellow = Mid</div>
        <div><span style="display:inline-block;width:14px;height:14px;background:#e60000;border:1px solid #111;vertical-align:middle;"></span> Red = Bad</div>
      </div>

      <div style="display:flex; gap:14px; align-items:center; margin-bottom:6px;">
        <div><span style="color:#00b050; font-weight:900;">✔</span> Only shown on Good/Elite zones</div>
        <div><span style="color:#e60000; font-weight:900;">✖</span> Only shown on Bad zones</div>
      </div>

      <div style="margin-top:8px; color:#444; font-size:12px; line-height:1.35;">
        • Slide time at bottom (NYC time).<br/>
        • Zoom in to see more icons (prevents overlap).<br/>
        • Data is loaded from Railway (persistent).
      </div>
    </div>
  `;
}

// Layers
const polyLayer = L.geoJSON(null, {
  pane: "polys",
  style: (feature) => {
    const p = feature?.properties || {};
    const rating = p.rating ?? p.rating_1_100 ?? p?.meta?.rating ?? null;

    // Use our clean color system regardless of what came from the file
    const c = ratingToFill(rating);
    return {
      color: c.border,
      weight: 2,
      fillColor: c.fill,
      fillOpacity: 0.42
    };
  },
  onEachFeature: (feature, layer) => {
    const p = feature.properties || {};
    if (p.popup) layer.bindPopup(p.popup, { maxWidth: 360 });
  }
}).addTo(map);

const markerLayer = L.layerGroup().addTo(map);

// Data structures
let timeline = [];
let dataByTime = new Map();

// Declutter markers: keep a minimum screen-distance between markers
function renderDeclutteredMarkers(markers){
  markerLayer.clearLayers();

  const zoom = map.getZoom();
  const SHOW_MARKERS_ZOOM = 13; // change to 12 if you want more markers earlier
  if (zoom < SHOW_MARKERS_ZOOM) return;

  // Sort: draw best first (so best stays if space is tight)
  const sorted = [...markers].sort((a,b) => (Number(b.rating||0) - Number(a.rating||0)));

  const placed = [];
  const MIN_PX = 26; // minimum distance between icons in screen pixels

  for (const m of sorted){
    if (!m || m.lat == null || m.lng == null) continue;

    const r = Number(m.rating || 0);
    const iconType = ratingToIcon(r);
    if (iconType === "NONE") continue; // skip mid zones for clarity

    const pt = map.latLngToContainerPoint([m.lat, m.lng]);

    let ok = true;
    for (const q of placed){
      const dx = pt.x - q.x;
      const dy = pt.y - q.y;
      if ((dx*dx + dy*dy) < (MIN_PX*MIN_PX)){
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    placed.push(pt);

    const iconHtml = (iconType === "GOOD")
      ? '<div style="font-weight:900; color:#00b050; font-size:16px; line-height:16px;">✔</div>'
      : '<div style="font-weight:900; color:#e60000; font-size:16px; line-height:16px;">✖</div>';

    const icon = L.divIcon({
      html: iconHtml,
      className: "",
      iconSize: [16,16],
      iconAnchor: [8,8]
    });

    const popup = `
      <div style="font-family:Arial; font-size:13px;">
        <div style="font-weight:900; font-size:14px;">${m.zone || "Zone"}</div>
        <div style="color:#666; margin-bottom:4px;">${m.borough || "Unknown"}</div>
        <div><b>Rating:</b> <span style="font-weight:900;">${r}/100</span></div>
        <hr style="margin:6px 0;">
        <div><b>Pickups:</b> ${m.pickups ?? "n/a"}</div>
        <div><b>Avg driver pay:</b> ${fmtMoney(m.avg_driver_pay)}</div>
        <div><b>Avg tips:</b> ${fmtMoney(m.avg_tips)}</div>
      </div>
    `;

    L.marker([m.lat, m.lng], { icon, pane: "markers" })
      .bindPopup(popup, { maxWidth: 360 })
      .addTo(markerLayer);
  }
}

function rebuildAtIndex(idx){
  const key = timeline[idx];
  const bundle = dataByTime.get(key);
  if (!bundle) return;

  const timeEl = document.getElementById("timeLabel");
  if (timeEl) timeEl.textContent = formatTimeLabel(key);

  polyLayer.clearLayers();

  // Polygons
  if (bundle.polygons) polyLayer.addData(bundle.polygons);

  // Markers (declutter + zoom-gated)
  renderDeclutteredMarkers(bundle.markers || []);
}

async function loadHotspots(){
  const res = await fetch(HOTSPOTS_URL, { cache: "no-store" });
  if (!res.ok){
    if (res.status === 404){
      throw new Error("Failed to fetch hotspots (404). Run /generate on Railway first.");
    }
    throw new Error(`Load failed (${res.status})`);
  }
  return await res.json();
}

async function main(){
  const payload = await loadHotspots();

  timeline = payload.timeline || [];
  dataByTime = new Map((payload.frames || []).map(f => [f.time, f]));

  const slider = document.getElementById("slider");
  slider.min = 0;
  slider.max = Math.max(0, timeline.length - 1);
  slider.step = 1;
  slider.value = 0;

  // Smooth slider
  let pending = null;
  slider.addEventListener("input", () => {
    pending = Number(slider.value);
    if (slider._raf) return;
    slider._raf = requestAnimationFrame(() => {
      slider._raf = null;
      if (pending !== null) rebuildAtIndex(pending);
    });
  });

  // Re-render markers when zoom changes (declutter depends on zoom)
  map.on("zoomend", () => {
    rebuildAtIndex(Number(slider.value));
  });

  if (timeline.length > 0){
    rebuildAtIndex(0);
  } else {
    document.getElementById("timeLabel").textContent = "No data in hotspots file";
  }
}

main().catch(err => {
  console.error(err);
  const timeEl = document.getElementById("timeLabel");
  if (timeEl) timeEl.textContent = "ERROR: " + err.message;
});
