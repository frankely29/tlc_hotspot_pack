/* =========================================================
   CONFIG
   ========================================================= */

// Railway backend base URL (must host /timeline and /frame/{idx})
const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";

// Timeline window size (must match backend generation bin_minutes)
const BIN_MINUTES = 20;

// Auto-refresh current frame every 5 minutes (reloads same slider index)
const REFRESH_MS = 5 * 60 * 1000;

// Auto-center behavior: if following, do not allow zoom below this
// NOTE: Larger number = closer zoom-in (15 is fairly close)
const AUTO_CENTER_MIN_ZOOM = 15;

/* =========================================================
   LEGEND MINIMIZE UI
   - toggles .minimized class on the legend
   ========================================================= */

const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");

if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/* =========================================================
   LABEL VISIBILITY RULES (mobile-friendly)
   - show more labels as you zoom in
   - prioritize high-demand buckets at lower zoom
   ========================================================= */

const LABEL_ZOOM_MIN = 10;         // below this: no labels
const BOROUGH_ZOOM_SHOW = 15;      // show borough name only at zoom 15
const LABEL_MAX_CHARS_MID = 14;    // shorten zone name mid-zoom to avoid clutter

function shouldShowLabel(bucket, zoom) {
  if (zoom < LABEL_ZOOM_MIN) return false;

  const b = (bucket || "").trim();

  // At max zoom: show all labels (including reds)
  if (zoom >= 15) return true;

  // As you zoom out, hide the lower buckets first
  if (zoom === 14) return b !== "red";
  if (zoom === 13) return b === "green" || b === "purple" || b === "blue" || b === "sky";
  if (zoom === 12) return b === "green" || b === "purple" || b === "blue";
  if (zoom === 11) return b === "green" || b === "purple";
  return b === "green";
}

/* =========================================================
   TIME HELPERS
   - Timeline frame 'time' uses a fixed anchor week
   - We display it as NYC time label
   - We pick the closest frame index to "now" in NYC
   ========================================================= */

function parseIsoNoTz(iso) {
  // ISO format: YYYY-MM-DDTHH:MM:SS
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
  return { Y, M, D, h, m, s };
}

function dowMon0FromIso(iso) {
  // Converts ISO date to day-of-week (Mon=0..Sun=6)
  const { Y, M, D, h, m, s } = parseIsoNoTz(iso);
  const dt = new Date(Date.UTC(Y, M - 1, D, h, m, s));
  const dowSun0 = dt.getUTCDay();
  return dowSun0 === 0 ? 6 : dowSun0 - 1;
}

function minuteOfWeekFromIso(iso) {
  // Returns minute index in week: 0..10079 (Mon 00:00 = 0)
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  return dow_m * 1440 + (h * 60 + m);
}

function formatNYCLabel(iso) {
  // Displays: "Mon 3:40 PM"
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${names[dow_m]} ${hr12}:${mm} ${ampm}`;
}

function getNowNYCMinuteOfWeekRounded() {
  // Get current NYC time (timezone-safe) and round DOWN to BIN_MINUTES boundary
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow_m = dowMap[map.weekday] ?? 0;

  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const total = dow_m * 1440 + hour * 60 + minute;
  return Math.floor(total / BIN_MINUTES) * BIN_MINUTES;
}

function cyclicDiff(a, b, mod) {
  // Used to compare minutes-of-week around wrap boundary
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}

function pickClosestIndex(minutesOfWeekArr, target) {
  // Find timeline index closest to NYC "now", with week wrap-around
  let bestIdx = 0;
  let bestDiff = Infinity;

  for (let i = 0; i < minutesOfWeekArr.length; i++) {
    const diff = cyclicDiff(minutesOfWeekArr[i], target, 7 * 1440);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestIdx = i;
    }
  }
  return bestIdx;
}

/* =========================================================
   NETWORK HELPERS
   - fetch JSON from Railway with no-cache
   ========================================================= */

async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store", mode: "cors" });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} @ ${url} :: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON @ ${url} :: ${text.slice(0, 200)}`);
  }
}

/* =========================================================
   BUCKET LABEL TEXT
   ========================================================= */

function prettyBucket(b) {
  const m = {
    green: "Highest",
    purple: "High",
    blue: "Medium",
    sky: "Normal",
    yellow: "Below Normal",
    red: "Very Low / Avoid",
  };
  return m[b] || (b ?? "");
}

/* =========================================================
   LABEL / HTML HELPERS
   ========================================================= */

function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}

function zoomClass(zoom) {
  // Creates z10..z15 class name
  const z = Math.max(10, Math.min(15, Math.round(zoom)));
  return `z${z}`;
}

function escapeHtml(s) {
  // Prevent HTML injection in labels and popups
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================================================
   STATEN ISLAND MODE
   - Toggle button persists in localStorage
   - When ON: Staten Island zones recolor by SI-only percentile
   - Other boroughs remain NYC-wide colors
   ========================================================= */

const btnStatenIsland = document.getElementById("btnStatenIsland");
const modeNote = document.getElementById("modeNote");

const LS_KEY_STATEN = "staten_island_mode_enabled";
let statenIslandMode = (localStorage.getItem(LS_KEY_STATEN) || "0") === "1";

function isStatenIslandFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("staten");
}

function colorFromLocalRating(r) {
  // Same thresholds as NYC-wide rating buckets
  const x = Math.max(1, Math.min(100, Math.round(r)));
  if (x >= 90) return { bucket: "green", color: "#00b050" };
  if (x >= 80) return { bucket: "purple", color: "#8000ff" };
  if (x >= 65) return { bucket: "blue", color: "#0066ff" };
  if (x >= 45) return { bucket: "sky", color: "#66ccff" };
  if (x >= 25) return { bucket: "yellow", color: "#ffd400" };
  return { bucket: "red", color: "#e60000" };
}

function applyStatenLocalView(frame) {
  // Adds derived properties:
  // - si_local_rating, si_local_bucket, si_local_color
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  // Collect SI ratings only
  const siRatings = [];
  for (const f of feats) {
    const props = f.properties || {};
    if (!isStatenIslandFeature(props)) continue;
    const r = Number(props.rating ?? NaN);
    if (!Number.isFinite(r)) continue;
    siRatings.push(r);
  }

  // Not enough samples => no local recolor
  if (siRatings.length < 3) return frame;

  const sorted = siRatings.slice().sort((a, b) => a - b);
  const n = sorted.length;

  function percentileOfRating(r) {
    // returns p in [0..1] percentile rank (robust)
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= r) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (n <= 1) return 0;
    return Math.max(0, Math.min(1, ans / (n - 1)));
  }

  // Assign SI-local bucket/color for SI zones
  for (const f of feats) {
    const props = f.properties || {};
    if (!isStatenIslandFeature(props)) {
      props.si_local_rating = null;
      props.si_local_bucket = null;
      props.si_local_color = null;
      continue;
    }
    const r = Number(props.rating ?? NaN);
    if (!Number.isFinite(r)) continue;

    const p = percentileOfRating(r);
    const localRating = 1 + 99 * p;

    const { bucket, color } = colorFromLocalRating(localRating);
    props.si_local_rating = Math.round(localRating);
    props.si_local_bucket = bucket;
    props.si_local_color = color;
  }

  return frame;
}

function syncStatenIslandUI() {
  // Updates button text + note text based on mode state
  if (btnStatenIsland) {
    btnStatenIsland.textContent = statenIslandMode ? "Staten Island Mode: ON" : "Staten Island Mode: OFF";
    btnStatenIsland.classList.toggle("on", !!statenIslandMode);
  }
  if (modeNote) {
    modeNote.innerHTML = statenIslandMode
      ? `Staten Island Mode is <b>ON</b>: Staten Island colors are <b>relative within Staten Island</b> only.<br/>Other boroughs remain NYC-wide.`
      : `Colors come from rating (1–100) for the selected 20-minute window.<br/>Time label is NYC time.`;
  }
}
syncStatenIslandUI();

// Touch/click hardening (prevents map drag from swallowing the click)
if (btnStatenIsland) {
  btnStatenIsland.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnStatenIsland.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnStatenIsland.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    statenIslandMode = !statenIslandMode;
    localStorage.setItem(LS_KEY_STATEN, statenIslandMode ? "1" : "0");
    syncStatenIslandUI();
    if (currentFrame) renderFrame(currentFrame); // re-render to apply new colors
  });
}

// When Staten Mode is on, use SI-local bucket/color for SI zones
function effectiveBucket(props) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
  return (props.bucket || "").trim();
}
function effectiveColor(props) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
  const st = props?.style || {};
  return st.fillColor || st.color || "#000";
}

function labelHTML(props, zoom) {
  // Builds tooltip HTML for zone labels (center of polygons)
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const b = effectiveBucket(props);
  if (!shouldShowLabel(b, Math.round(zoom))) return "";

  const zoneText = zoom < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  const borough = (props.borough || "").trim();
  const showBorough = zoom >= BOROUGH_ZOOM_SHOW && borough;

  return `
    <div class="zn">${escapeHtml(zoneText)}</div>
    ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
  `;
}

/* =========================================================
   RECOMMENDATION + NAVIGATION
   - Only recommends Blue/Purple/Green zones
   - Prefers closer zones using a distance penalty
   - Creates Google Maps "Navigate" URL
   ========================================================= */

const recommendEl = document.getElementById("recommendLine");
const navBtn = document.getElementById("navBtn");

let userLatLng = null;
let recommendedDest = null;

function setNavDisabled(disabled) {
  if (!navBtn) return;
  navBtn.classList.toggle("disabled", !!disabled);
}

function setNavDestination(dest) {
  // Sets destination used by Navigate button
  recommendedDest = dest || null;
  if (!navBtn) return;

  if (!recommendedDest) {
    navBtn.href = "#";
    setNavDisabled(true);
    return;
  }

  const { lat, lng } = recommendedDest;
  navBtn.href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(
    `${lat},${lng}`
  )}&travelmode=driving`;

  setNavDisabled(false);
}

function haversineMiles(a, b) {
  // Haversine distance in miles
  const R = 3958.7613;
  const toRad = (x) => (x * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const s1 = Math.sin(dLat / 2);
  const s2 = Math.sin(dLng / 2);
  const h = s1 * s1 + Math.cos(lat1) * Math.cos(lat2) * s2 * s2;

  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function geometryCenter(geom) {
  // Gets approximate center by averaging polygon points
  let pts = [];
  if (!geom) return null;

  if (geom.type === "Polygon") {
    pts = geom.coordinates?.[0] || [];
  } else if (geom.type === "MultiPolygon") {
    const polys = geom.coordinates || [];
    for (const p of polys) {
      const ring = p?.[0] || [];
      pts.push(...ring);
    }
  } else {
    return null;
  }

  if (!pts.length) return null;

  let sumLng = 0, sumLat = 0;
  for (const [lng, lat] of pts) {
    sumLng += lng;
    sumLat += lat;
  }
  return { lat: sumLat / pts.length, lng: sumLng / pts.length };
}

// Recommendation uses effective bucket (SI-local if enabled)
function updateRecommendation(frame) {
  if (!recommendEl) return;

  if (!userLatLng) {
    recommendEl.textContent = "Recommended: enable location to get suggestions";
    setNavDestination(null);
    return;
  }

  const feats = frame?.polygons?.features || [];
  if (!feats.length) {
    recommendEl.textContent = "Recommended: …";
    setNavDestination(null);
    return;
  }

  // Only recommend top buckets
  const allowed = new Set(["blue", "purple", "green"]);

  // Distance penalty: higher = prefers closer zones more strongly
  const DIST_PENALTY_PER_MILE = 4.0;

  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const geom = f.geometry;

    const b = effectiveBucket(props);
    if (!allowed.has(b)) continue;

    const rating = (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating)))
      ? Number(props.si_local_rating)
      : Number(props.rating ?? NaN);

    if (!Number.isFinite(rating)) continue;

    const center = geometryCenter(geom);
    if (!center) continue;

    const dMi = haversineMiles(userLatLng, center);
    const score = rating - dMi * DIST_PENALTY_PER_MILE;

    if (!best || score > best.score) {
      best = {
        score,
        dMi,
        rating,
        lat: center.lat,
        lng: center.lng,
        name: (props.zone_name || "").trim() || `Zone ${props.LocationID ?? ""}`,
        borough: (props.borough || "").trim(),
        usedLocal: (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))),
      };
    }
  }

  if (!best) {
    recommendEl.textContent = "Recommended: no Blue+ zone nearby right now";
    setNavDestination(null);
    return;
  }

  const distTxt = best.dMi >= 10 ? `${best.dMi.toFixed(0)} mi` : `${best.dMi.toFixed(1)} mi`;
  const bTxt = best.borough ? ` (${best.borough})` : "";
  const modeTag = best.usedLocal ? " (SI-local)" : "";
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating}${modeTag} — ${distTxt}`;

  setNavDestination({
    lat: best.lat,
    lng: best.lng,
    name: best.name,
    borough: best.borough,
    rating: best.rating,
    distMi: best.dMi,
  });
}

/* =========================================================
   LEAFLET MAP SETUP
   ========================================================= */

const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

// Base map view
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 10);

// Tile layer (Carto basemap)
L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

// Panes keep nav arrow above labels/tooltips
const labelsPane = map.createPane("labelsPane");
labelsPane.style.zIndex = 450; // above polygons, below marker
const navPane = map.createPane("navPane");
navPane.style.zIndex = 1000; // always on top

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

function buildPopupHTML(props) {
  // Popup shows NYC rating and optionally SI-local rating
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  let extra = "";
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    extra = `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(props.si_local_bucket)})</div>`;
  }

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>NYC Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      ${extra}
      <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function renderFrame(frame) {
  // Save current frame for re-render on zoom or SI-mode toggles
  currentFrame = frame;

  // SI recolor is applied on top of the frame properties
  if (statenIslandMode) applyStatenLocalView(currentFrame);

  // Update bottom time label
  timeLabel.textContent = formatNYCLabel(currentFrame.time);

  // Remove old polygons
  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  // Draw polygons for this frame
  geoLayer = L.geoJSON(currentFrame.polygons, {
    style: (feature) => {
      const props = feature?.properties || {};
      const st = props.style || {};
      const fill = effectiveColor(props);

      return {
        color: fill,
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: fill,
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      // Popup on zone tap
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 320 });

      // Center label tooltip (demand-priority visibility)
      const html = labelHTML(props, zoomNow);
      if (!html) return;

      layer.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label ${zClass}`,
        opacity: 0.92,
        interactive: false,
        pane: "labelsPane", // keep labels under nav arrow
      });
    },
  }).addTo(map);

  // Update recommendation line & navigate link based on current frame
  updateRecommendation(currentFrame);
}

async function loadFrame(idx) {
  // Loads one frame JSON by index
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

async function loadTimeline() {
  // Loads timeline once, sets slider range, starts at NYC "now"
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = Array.isArray(t) ? t : (t.timeline || []);
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

// Re-render on zoom to update label visibility and sizes
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Slider input loads that frame (debounced so it feels smooth)
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   AUTO-CENTER TOGGLE (stable logic)
   - Auto-center turns OFF if user drags/zooms manually
   - Programmatic pan/zoom is protected from disabling it
   ========================================================= */

const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;

// Prevent autoCenter from turning OFF when we do programmatic pan/zoom
let suppressAutoDisableUntil = 0;

function suppressAutoDisableFor(ms, fn) {
  suppressAutoDisableUntil = Date.now() + ms;
  fn();
}

function syncCenterButton() {
  if (!btnCenter) return;
  btnCenter.textContent = autoCenter ? "Auto-center: ON" : "Auto-center: OFF";
  btnCenter.classList.toggle("on", !!autoCenter);
}
syncCenterButton();

if (btnCenter) {
  // Stop map gestures from swallowing the click
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    autoCenter = !autoCenter;
    syncCenterButton();

    // If turning ON and we have location, jump to you
    if (autoCenter && userLatLng) {
      const z = Math.max(map.getZoom(), AUTO_CENTER_MIN_ZOOM);
      suppressAutoDisableFor(900, () => map.setView(userLatLng, z, { animate: true }));
    }
  });
}

function disableAutoCenterBecauseUserIsExploring() {
  // Only disable if user gesture AND not currently suppressed
  if (Date.now() < suppressAutoDisableUntil) return;
  if (!autoCenter) return;
  autoCenter = false;
  syncCenterButton();
}
map.on("dragstart", disableAutoCenterBecauseUserIsExploring);
map.on("zoomstart", disableAutoCenterBecauseUserIsExploring);

/* =========================================================
   LIVE LOCATION ARROW (navigation triangle)
   - Uses geolocation.watchPosition
   - Uses heading if available, else uses movement bearing
   - Auto-centers when enabled
   ========================================================= */

let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeNavIcon() {
  // Marker is a divIcon containing triangle + pulse
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse"><div class="navArrow"></div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function setNavVisual(isMoving) {
  // moving => glow, stationary => pulse ring
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}

function setNavRotation(deg) {
  // rotate the wrapper (triangle points toward heading)
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.style.transform = `rotate(${deg}deg)`;
}

function computeBearingDeg(from, to) {
  // Bearing from A -> B in degrees (0..360)
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;

  const lat1 = toRad(from.lat);
  const lat2 = toRad(to.lat);
  const dLng = toRad(to.lng - from.lng);

  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);

  let brng = toDeg(Math.atan2(y, x));
  brng = (brng + 360) % 360;
  return brng;
}

function startLocationWatch() {
  if (!("geolocation" in navigator)) {
    if (recommendEl) recommendEl.textContent = "Recommended: location not supported";
    return;
  }

  // Marker pane keeps it above labels/polygons
  navMarker = L.marker([40.7128, -74.0060], {
    icon: makeNavIcon(),
    interactive: false,
    zIndexOffset: 2000000,
    pane: "navPane",
  }).addTo(map);

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const heading = pos.coords.heading; // may be null on some devices
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
      if (navMarker) navMarker.setLatLng(userLatLng);

      let isMoving = false;

      if (lastPos) {
        // Determine movement speed
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;

        isMoving = mph >= 2.0;

        // Use device heading if available, else compute bearing from movement
        if (typeof heading === "number" && Number.isFinite(heading)) {
          lastHeadingDeg = heading;
        } else if (dMi > 0.01) {
          lastHeadingDeg = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        }

        if (isMoving) lastMoveTs = ts;
      }

      lastPos = { lat, lng, ts };

      setNavRotation(lastHeadingDeg);
      setNavVisual(isMoving);

      // Follow behavior + keep minimum zoom when following
      const desiredZoom = Math.max(map.getZoom(), AUTO_CENTER_MIN_ZOOM);

      if (!gpsFirstFixDone) {
        // First fix: jump to you
        gpsFirstFixDone = true;
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, desiredZoom, { animate: true }));
      } else if (autoCenter) {
        // If user is zoomed out too far, bring them back in; else just pan
        if (map.getZoom() < AUTO_CENTER_MIN_ZOOM) {
          suppressAutoDisableFor(900, () => map.setView(userLatLng, desiredZoom, { animate: true }));
        } else {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

      // Keep recommendation updated as you move
      if (currentFrame) updateRecommendation(currentFrame);
    },
    (err) => {
      console.warn("Geolocation error:", err);
      if (recommendEl) recommendEl.textContent = "Recommended: location blocked (enable it)";
      setNavDestination(null);
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    }
  );

  // Visual: if you haven't moved in ~5 seconds, show pulse ring
  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   AUTO-REFRESH CURRENT FRAME (no page reload)
   - Keeps slider position but refreshes the same frame index
   ========================================================= */

async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

/* =========================================================
   BOOT
   ========================================================= */

setNavDestination(null);

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

startLocationWatch();