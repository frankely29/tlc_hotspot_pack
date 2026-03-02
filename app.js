/* =========================================================
   NYC TLC Hotspot Map (Frontend) - SIMPLE + STABLE
   + Weather badge + rain/snow + day/night theme
   + PRECISE SLIDER (RESTORED)
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

const REFRESH_MS = 5 * 60 * 1000;
const NYC_CLOCK_TICK_MS = 60 * 1000;
const USER_SLIDER_GRACE_MS = 25 * 1000;

/* =========================================================
   MANHATTAN MODE — DEFAULT SETTINGS (SAFE TO EDIT)
   ========================================================= */
const LS_KEY_MANHATTAN = "manhattan_mode_enabled";

// (your current values)
const MANHATTAN_PAY_WEIGHT = 0.55;
const MANHATTAN_VOL_WEIGHT = 0.45;
const MANHATTAN_GLOBAL_PENALTY = 0.98;

// You said you set 40. Keep it.
const MANHATTAN_MIN_ZONES = 40;

// Uptown exclusion
const MANHATTAN_CORE_MAX_LAT = 40.795;

/* =========================================================
   Legend minimize
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
   Label visibility rules (mobile-friendly)
   ========================================================= */
const LABEL_ZOOM_MIN = 10;
const BOROUGH_ZOOM_SHOW = 15;
const LABEL_MAX_CHARS_MID = 14;

function shouldShowLabel(bucket, zoom) {
  if (zoom < LABEL_ZOOM_MIN) return false;
  const b = (bucket || "").trim();
  if (zoom >= 15) return true;
  if (zoom === 14) return b !== "red";
  if (zoom === 13) return b === "green" || b === "purple" || b === "blue" || b === "sky";
  if (zoom === 12) return b === "green" || b === "purple" || b === "blue";
  if (zoom === 11) return b === "green" || b === "purple";
  return b === "green";
}

/* =========================================================
   Time helpers
   ========================================================= */
function parseIsoNoTz(iso) {
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
  return { Y, M, D, h, m, s };
}
function dowMon0FromIso(iso) {
  const { Y, M, D, h, m, s } = parseIsoNoTz(iso);
  const dt = new Date(Date.UTC(Y, M - 1, D, h, m, s));
  const dowSun0 = dt.getUTCDay();
  return dowSun0 === 0 ? 6 : dowSun0 - 1;
}
function minuteOfWeekFromIso(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  return dow_m * 1440 + (h * 60 + m);
}
function formatNYCLabel(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${names[dow_m]} ${hr12}:${mm} ${ampm}`;
}
function getNowNYCMinuteOfWeekRounded() {
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
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}
function pickClosestIndex(minutesOfWeekArr, target) {
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
   Network helper
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
   Buckets (display names)
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
   Label helpers
   ========================================================= */
function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}
function zoomClass(zoom) {
  const z = Math.max(10, Math.min(15, Math.round(zoom)));
  return `z${z}`;
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* =========================================================
   Staten Island Mode (local percentile recolor)
   ========================================================= */
const btnStatenIsland = document.getElementById("btnStatenIsland");
const modeNote = document.getElementById("modeNote");

const LS_KEY_STATEN = "staten_island_mode_enabled";
let statenIslandMode = (localStorage.getItem(LS_KEY_STATEN) || "0") === "1";

function isStatenIslandFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("staten");
}

/* =========================================================
   Manhattan Mode
   ========================================================= */
let manhattanMode = (localStorage.getItem(LS_KEY_MANHATTAN) || "0") === "1";

function isManhattanFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("manhattan");
}

/* =========================================================
   FIX: Accurate polygon centroid (area-weighted)
   ========================================================= */
function ringCentroidArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;

  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    pts.push([first[0], first[1]]);
  }

  let A = 0;
  let Cx = 0;
  let Cy = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cross = x0 * y1 - x1 * y0;
    A += cross;
    Cx += (x0 + x1) * cross;
    Cy += (y0 + y1) * cross;
  }

  if (Math.abs(A) < 1e-12) return null;
  const inv = 1 / (3 * A);
  return { lng: Cx * inv, lat: Cy * inv, area2: A };
}
function polygonCentroid(geom) {
  const rings = geom?.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return null;

  const outer = ringCentroidArea(rings[0]);
  if (!outer) return null;

  let sumArea2 = outer.area2;
  let sumLng = outer.lng * outer.area2;
  let sumLat = outer.lat * outer.area2;

  for (let i = 1; i < rings.length; i++) {
    const hole = ringCentroidArea(rings[i]);
    if (!hole) continue;
    sumArea2 += hole.area2;
    sumLng += hole.lng * hole.area2;
    sumLat += hole.lat * hole.area2;
  }

  if (Math.abs(sumArea2) < 1e-12) return { lat: outer.lat, lng: outer.lng };
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}
function multiPolygonCentroid(geom) {
  const polys = geom?.coordinates;
  if (!Array.isArray(polys) || polys.length === 0) return null;

  let sumArea2 = 0;
  let sumLat = 0;
  let sumLng = 0;

  for (const poly of polys) {
    const c = polygonCentroid({ type: "Polygon", coordinates: poly });
    if (!c) continue;

    const outer = ringCentroidArea(poly?.[0] || []);
    const w = outer ? outer.area2 : 1;

    sumArea2 += w;
    sumLat += c.lat * w;
    sumLng += c.lng * w;
  }

  if (Math.abs(sumArea2) < 1e-12) return null;
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}
function geometryCenter(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return polygonCentroid(geom);
  if (geom.type === "MultiPolygon") return multiPolygonCentroid(geom);
  return null;
}

/* =========================================================
   Manhattan core zone check (Uptown exclusion)
   ========================================================= */
function isCoreManhattan(props, geom) {
  if (!isManhattanFeature(props)) return false;
  const c = geometryCenter(geom);
  if (!c || !Number.isFinite(c.lat)) return false;
  return c.lat <= MANHATTAN_CORE_MAX_LAT;
}

/* =========================================================
   Manhattan button (create dynamically)
   ========================================================= */
function ensureManhattanButton() {
  let btn = document.getElementById("btnManhattan");
  if (btn) return btn;

  btn = document.createElement("button");
  btn.id = "btnManhattan";
  btn.type = "button";
  btn.className = "navBtn";
  btn.style.marginLeft = "6px";
  btn.style.padding = "6px 10px";
  btn.style.borderRadius = "10px";
  btn.style.border = "1px solid rgba(0,0,0,0.2)";
  btn.style.background = "rgba(255,255,255,0.95)";
  btn.style.fontWeight = "700";
  btn.style.fontSize = "12px";

  const navRow =
    document.getElementById("navRow") ||
    (legendEl ? legendEl.querySelector(".navRow") : null) ||
    (legendEl ? legendEl : null);

  if (navRow) {
    if (btnStatenIsland && btnStatenIsland.parentElement === navRow) {
      btnStatenIsland.insertAdjacentElement("afterend", btn);
    } else {
      navRow.appendChild(btn);
    }
  } else {
    document.body.appendChild(btn);
  }

  return btn;
}

const btnManhattan = ensureManhattanButton();

function syncManhattanUI() {
  if (!btnManhattan) return;
  btnManhattan.textContent = manhattanMode ? "Manhattan Mode: ON" : "Manhattan Mode: OFF";
  btnManhattan.classList.toggle("on", !!manhattanMode);
}
syncManhattanUI();

if (btnManhattan) {
  btnManhattan.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnManhattan.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnManhattan.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    manhattanMode = !manhattanMode;
    localStorage.setItem(LS_KEY_MANHATTAN, manhattanMode ? "1" : "0");
    syncManhattanUI();
    if (currentFrame) renderFrame(currentFrame);
  });
}

/* =========================================================
   Shared rating->color helper
   ========================================================= */
function colorFromLocalRating(r) {
  const x = Math.max(1, Math.min(100, Math.round(r)));
  if (x >= 90) return { bucket: "green", color: "#00b050" };
  if (x >= 80) return { bucket: "purple", color: "#8000ff" };
  if (x >= 65) return { bucket: "blue", color: "#0066ff" };
  if (x >= 45) return { bucket: "sky", color: "#66ccff" };
  if (x >= 25) return { bucket: "yellow", color: "#ffd400" };
  return { bucket: "red", color: "#e60000" };
}

function applyStatenLocalView(frame) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  const siRatings = [];
  for (const f of feats) {
    const props = f.properties || {};
    if (!isStatenIslandFeature(props)) continue;
    const r = Number(props.rating ?? NaN);
    if (!Number.isFinite(r)) continue;
    siRatings.push(r);
  }
  if (siRatings.length < 3) return frame;

  const sorted = siRatings.slice().sort((a, b) => a - b);
  const n = sorted.length;

  function percentileOfRating(r) {
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= r) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (n <= 1) return 0;
    return Math.max(0, Math.min(1, ans / (n - 1)));
  }

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

/* =========================================================
   Manhattan Mode — local view (core Manhattan only)
   ========================================================= */
function applyManhattanLocalView(frame) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  const mPickups = [];
  const mPay = [];

  for (const f of feats) {
    const props = f.properties || {};
    if (!isCoreManhattan(props, f.geometry)) continue;

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    if (Number.isFinite(pu)) mPickups.push(pu);
    if (Number.isFinite(pay)) mPay.push(pay);
  }

  if (mPickups.length < MANHATTAN_MIN_ZONES || mPay.length < MANHATTAN_MIN_ZONES) {
    for (const f of feats) {
      const props = f.properties || {};
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
    }
    return frame;
  }

  const pickSorted = mPickups.slice().sort((a, b) => a - b);
  const paySorted = mPay.slice().sort((a, b) => a - b);

  function percentileFromSorted(sorted, v) {
    const n = sorted.length;
    if (n <= 1) return 0;
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] <= v) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return Math.max(0, Math.min(1, ans / (n - 1)));
  }

  for (const f of feats) {
    const props = f.properties || {};

    if (!isCoreManhattan(props, f.geometry)) {
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    if (!Number.isFinite(pu) || !Number.isFinite(pay)) {
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const volP = percentileFromSorted(pickSorted, pu);
    const payP = percentileFromSorted(paySorted, pay);

    let score = MANHATTAN_PAY_WEIGHT * payP + MANHATTAN_VOL_WEIGHT * volP;
    score = Math.max(0, Math.min(1, score));

    let localRating = 1 + 99 * score;
    localRating = localRating * MANHATTAN_GLOBAL_PENALTY;
    localRating = Math.max(1, Math.min(100, localRating));

    const { bucket, color } = colorFromLocalRating(localRating);
    props.mh_local_rating = Math.round(localRating);
    props.mh_local_bucket = bucket;
    props.mh_local_color = color;
  }

  return frame;
}

function syncStatenIslandUI() {
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

if (btnStatenIsland) {
  btnStatenIsland.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnStatenIsland.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnStatenIsland.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    statenIslandMode = !statenIslandMode;
    localStorage.setItem(LS_KEY_STATEN, statenIslandMode ? "1" : "0");
    syncStatenIslandUI();
    if (currentFrame) renderFrame(currentFrame);
  });
}

/* =========================================================
   Effective selection helpers
   ========================================================= */
function effectiveBucket(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_bucket) return props.mh_local_bucket;
  return (props.bucket || "").trim();
}
function effectiveColor(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_color) return props.mh_local_color;
  const st = props?.style || {};
  return st.fillColor || st.color || "#000";
}
function effectiveRating(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    return Number(props.si_local_rating);
  }
  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) {
    return Number(props.mh_local_rating);
  }
  return Number(props.rating ?? NaN);
}

function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const b = effectiveBucket(props, null);
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
   Recommendation + Navigation
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

  const allowed = new Set(["blue", "purple", "green"]);
  const DIST_PENALTY_PER_MILE = 4.0;

  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const geom = f.geometry;

    const b = effectiveBucket(props, geom);
    if (!allowed.has(b)) continue;

    const rating = effectiveRating(props, geom);
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
        usedSI: (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))),
        usedMH: (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))),
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
  const modeTag = best.usedSI ? " (SI-local)" : (best.usedMH ? " (Manhattan-adjusted)" : "");
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
   Leaflet map setup
   ========================================================= */
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 10);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

const labelsPane = map.createPane("labelsPane");
labelsPane.style.zIndex = 450;

const navPane = map.createPane("navPane");
navPane.style.zIndex = 1000;

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;
let lastUserSliderTs = 0;

/* =========================================================
   PRECISE SLIDER (RESTORED)
   ========================================================= */
const preciseWrap = document.getElementById("preciseWrap");
const preciseTitle = document.getElementById("preciseTitle");
const preciseClose = document.getElementById("preciseClose");
const preciseDay = document.getElementById("preciseDay");
const preciseSlider = document.getElementById("preciseSlider");
const preciseMinus = document.getElementById("preciseMinus");
const precisePlus = document.getElementById("precisePlus");

const DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// day -> list of global indices in that day
let dayToIndices = [[], [], [], [], [], [], []];

let preciseHideTimer = null;
let preciseDebounce = null;

function showPrecisePanel() {
  if (!preciseWrap) return;
  preciseWrap.classList.add("show");
  if (preciseHideTimer) clearTimeout(preciseHideTimer);
}
function hidePrecisePanelSoon(ms = 650) {
  if (!preciseWrap) return;
  if (preciseHideTimer) clearTimeout(preciseHideTimer);
  preciseHideTimer = setTimeout(() => {
    preciseWrap.classList.remove("show");
  }, ms);
}
function hidePrecisePanelNow() {
  if (!preciseWrap) return;
  if (preciseHideTimer) clearTimeout(preciseHideTimer);
  preciseWrap.classList.remove("show");
}

function rebuildDayIndexMap() {
  dayToIndices = [[], [], [], [], [], [], []];
  for (let i = 0; i < timeline.length; i++) {
    const iso = timeline[i];
    const dow = dowMon0FromIso(iso);
    dayToIndices[dow].push(i);
  }
}

// Find which day and which position-within-day the global index belongs to
function dayPosFromGlobalIndex(globalIdx) {
  globalIdx = Math.max(0, Math.min(timeline.length - 1, globalIdx));
  const iso = timeline[globalIdx];
  const dow = dowMon0FromIso(iso);
  const arr = dayToIndices[dow] || [];
  // binary search index inside arr (arr is sorted)
  let lo = 0, hi = arr.length - 1, best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= globalIdx) { best = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return { dow, pos: best };
}

// Set precise slider to match current main slider value
function syncPreciseToMain() {
  if (!timeline.length) return;
  if (!preciseDay || !preciseSlider) return;

  const globalIdx = Number(slider.value || "0");
  const { dow, pos } = dayPosFromGlobalIndex(globalIdx);

  preciseDay.value = String(dow);

  const arr = dayToIndices[dow] || [];
  preciseSlider.min = "0";
  preciseSlider.max = String(Math.max(0, arr.length - 1));
  preciseSlider.step = "1";
  preciseSlider.value = String(Math.max(0, Math.min(arr.length - 1, pos)));

  // Title line
  const iso = timeline[globalIdx];
  const label = formatNYCLabel(iso);
  if (preciseTitle) preciseTitle.textContent = `Precise: ${label}`;
}

// When user changes day in precise panel, keep same “time position” as best-effort
function onPreciseDayChanged() {
  if (!timeline.length) return;
  const dow = Number(preciseDay.value);
  const arr = dayToIndices[dow] || [];

  // If new day has no indices (shouldn't happen), bail
  if (!arr.length) return;

  // Reset to middle-ish of the day or closest to current time label
  // We'll keep same minute-of-day if possible:
  const globalIdx = Number(slider.value || "0");
  const curIso = timeline[globalIdx];
  const { h, m } = parseIsoNoTz(curIso);
  const targetMinOfDay = h * 60 + m;

  // pick closest in that day
  let bestPos = 0;
  let bestDiff = Infinity;
  for (let p = 0; p < arr.length; p++) {
    const iso = timeline[arr[p]];
    const { h: hh, m: mm } = parseIsoNoTz(iso);
    const diff = Math.abs((hh * 60 + mm) - targetMinOfDay);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPos = p;
    }
  }

  preciseSlider.min = "0";
  preciseSlider.max = String(arr.length - 1);
  preciseSlider.value = String(bestPos);

  // Apply selection
  applyPreciseSelection();
}

function applyPreciseSelection() {
  const dow = Number(preciseDay.value);
  const arr = dayToIndices[dow] || [];
  if (!arr.length) return;

  const pos = Number(preciseSlider.value || "0");
  const clampedPos = Math.max(0, Math.min(arr.length - 1, pos));
  const globalIdx = arr[clampedPos];

  // Update main slider + load frame
  slider.value = String(globalIdx);
  lastUserSliderTs = Date.now();

  if (preciseDebounce) clearTimeout(preciseDebounce);
  preciseDebounce = setTimeout(() => {
    loadFrame(globalIdx).catch(console.error);
  }, 60);

  // Title update
  const iso = timeline[globalIdx];
  const label = formatNYCLabel(iso);
  if (preciseTitle) preciseTitle.textContent = `Precise: ${label}`;
}

/* Hook precise UI events */
if (preciseClose) {
  preciseClose.addEventListener("click", (e) => {
    e.preventDefault();
    hidePrecisePanelNow();
  });
}
if (preciseDay) {
  preciseDay.addEventListener("change", () => {
    showPrecisePanel();
    onPreciseDayChanged();
  });
}
if (preciseSlider) {
  preciseSlider.addEventListener("input", () => {
    showPrecisePanel();
    applyPreciseSelection();
  });
}
if (preciseMinus) {
  preciseMinus.addEventListener("click", () => {
    showPrecisePanel();
    const v = Number(preciseSlider.value || "0");
    preciseSlider.value = String(Math.max(Number(preciseSlider.min || "0"), v - 1));
    applyPreciseSelection();
  });
}
if (precisePlus) {
  precisePlus.addEventListener("click", () => {
    showPrecisePanel();
    const v = Number(preciseSlider.value || "0");
    preciseSlider.value = String(Math.min(Number(preciseSlider.max || "0"), v + 1));
    applyPreciseSelection();
  });
}

/* Show precise panel when user touches main slider */
function bindMainSliderToPrecise() {
  if (!slider) return;

  // When user starts touching/dragging, show panel + sync
  slider.addEventListener("pointerdown", () => {
    showPrecisePanel();
    syncPreciseToMain();
  });
  slider.addEventListener("touchstart", () => {
    showPrecisePanel();
    syncPreciseToMain();
  }, { passive: true });

  // While moving, keep panel synced
  slider.addEventListener("input", () => {
    showPrecisePanel();
    syncPreciseToMain();
  });

  // When user finishes, hide soon
  slider.addEventListener("pointerup", () => hidePrecisePanelSoon(800));
  slider.addEventListener("touchend", () => hidePrecisePanelSoon(800));
  slider.addEventListener("change", () => hidePrecisePanelSoon(800));
}
bindMainSliderToPrecise();

/* =========================================================
   Popups
   ========================================================= */
function buildPopupHTML(props, geom) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const nycRating = props.rating ?? "";
  const nycBucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  let extra = "";

  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Staten Local Rating:</b> ${props.si_local_rating} (${prettyBucket(props.si_local_bucket)})</div>`;
  }

  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) {
    extra += `<div style="margin-top:6px;"><b>Manhattan Adjusted:</b> ${props.mh_local_rating} (${prettyBucket(props.mh_local_bucket)})</div>`;
  }

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>NYC Rating:</b> ${nycRating} (${prettyBucket(nycBucket)})</div>
      ${extra}
      <div style="margin-top:6px;"><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function renderFrame(frame) {
  currentFrame = frame;

  if (statenIslandMode) applyStatenLocalView(currentFrame);
  if (manhattanMode) applyManhattanLocalView(currentFrame);

  timeLabel.textContent = formatNYCLabel(currentFrame.time);

  // Keep precise panel title synced when frames change via auto tick / precise
  if (timeline.length) syncPreciseToMain();

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  geoLayer = L.geoJSON(currentFrame.polygons, {
    style: (feature) => {
      const props = feature?.properties || {};
      const st = props.style || {};
      const fill = effectiveColor(props, feature.geometry);

      return {
        color: fill,
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: fill,
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props, feature.geometry), { maxWidth: 320 });

      const html = labelHTML(props, zoomNow);
      if (!html) return;

      layer.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label ${zClass}`,
        opacity: 0.92,
        interactive: false,
        pane: "labelsPane",
      });
    },
  }).addTo(map);

  updateRecommendation(currentFrame);
}

async function loadFrame(idx) {
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  renderFrame(frame);
}

async function loadTimeline() {
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = Array.isArray(t) ? t : (t.timeline || []);
  if (!timeline.length) throw new Error("Timeline empty. Run /generate once on Railway.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  // Build day -> indices for precise slider
  rebuildDayIndexMap();

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  // Init precise panel slider values (hidden until touch)
  syncPreciseToMain();

  await loadFrame(idx);
}

map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

/* Main slider manual control (unchanged) */
let sliderDebounce = null;
slider.addEventListener("input", () => {
  lastUserSliderTs = Date.now();
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center
   ========================================================= */
const btnCenter = document.getElementById("btnCenter");
let autoCenter = true;

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
  btnCenter.addEventListener("pointerdown", (e) => e.stopPropagation());
  btnCenter.addEventListener("touchstart", (e) => e.stopPropagation(), { passive: true });

  btnCenter.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();

    autoCenter = !autoCenter;
    syncCenterButton();

    if (autoCenter && userLatLng) {
      suppressAutoDisableFor(800, () => map.panTo(userLatLng, { animate: true }));
    }
  });
}

function disableAutoCenterBecauseUserIsExploring() {
  if (Date.now() < suppressAutoDisableUntil) return;
  if (!autoCenter) return;
  autoCenter = false;
  syncCenterButton();
}
map.on("dragstart", disableAutoCenterBecauseUserIsExploring);
map.on("zoomstart", disableAutoCenterBecauseUserIsExploring);

/* =========================================================
   Live location arrow + follow behavior
   ========================================================= */
let gpsFirstFixDone = false;
let navMarker = null;
let lastPos = null;
let lastHeadingDeg = 0;
let lastMoveTs = 0;

function makeNavIcon() {
  return L.divIcon({
    className: "",
    html: `<div id="navWrap" class="navArrowWrap navPulse"><div class="navArrow"></div></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

function setNavVisual(isMoving) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.classList.toggle("navMoving", !!isMoving);
  el.classList.toggle("navPulse", !isMoving);
}
function setNavRotation(deg) {
  const el = document.getElementById("navWrap");
  if (!el) return;
  el.style.transform = `rotate(${deg}deg)`;
}
function computeBearingDeg(from, to) {
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
      const heading = pos.coords.heading;
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
      if (navMarker) navMarker.setLatLng(userLatLng);

      let isMoving = false;

      if (lastPos) {
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;

        isMoving = mph >= 2.0;

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

      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 13);
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

      if (currentFrame) updateRecommendation(currentFrame);

      // weather refresh sooner after real GPS
      scheduleWeatherUpdateSoon();
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

  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   AUTO-UPDATE
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

async function tickNYCClockAndAdvanceIfNeeded() {
  try {
    if (Date.now() - lastUserSliderTs < USER_SLIDER_GRACE_MS) return;
    if (!timeline.length || !minutesOfWeek.length) return;

    const nowMinWeek = getNowNYCMinuteOfWeekRounded();
    const bestIdx = pickClosestIndex(minutesOfWeek, nowMinWeek);

    const curIdx = Number(slider.value || "0");
    if (bestIdx === curIdx) return;

    slider.value = String(bestIdx);
    await loadFrame(bestIdx);
  } catch (e) {
    console.warn("NYC clock tick failed:", e);
  }
}
setInterval(tickNYCClockAndAdvanceIfNeeded, NYC_CLOCK_TICK_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
    updateWeatherNow().catch(() => {});
  }
});

/* =========================================================
   WEATHER BADGE + FX (no API key) — unchanged from your code
   ========================================================= */
const weatherBadge = document.getElementById("weatherBadge");
const wxCanvas = document.getElementById("wxCanvas");
const wxCtx = wxCanvas ? wxCanvas.getContext("2d") : null;

let wxState = {
  kind: "none", // "none" | "rain" | "snow"
  intensity: 0, // 0..1
  isNight: false,
  tempF: null,
  label: "Weather…",
  lastLat: null,
  lastLng: null,
};

let wxParticles = [];
let wxAnimRunning = false;
let wxNextUpdateTimer = null;

function wxResizeCanvas() {
  if (!wxCanvas) return;
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  wxCanvas.width = Math.floor(window.innerWidth * dpr);
  wxCanvas.height = Math.floor(window.innerHeight * dpr);
  wxCanvas.style.width = `${window.innerWidth}px`;
  wxCanvas.style.height = `${window.innerHeight}px`;
  if (wxCtx) wxCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", wxResizeCanvas);
wxResizeCanvas();

function wxDescribe(code) {
  const c = Number(code);
  if (c === 0) return { text: "Clear", icon: "☀️", kind: "none", intensity: 0 };
  if (c >= 1 && c <= 3) return { text: "Cloudy", icon: "⛅", kind: "none", intensity: 0 };
  if (c === 45 || c === 48) return { text: "Fog", icon: "🌫️", kind: "none", intensity: 0 };
  if ((c >= 51 && c <= 57) || (c >= 61 && c <= 67) || (c >= 80 && c <= 82)) {
    const intensity = (c >= 65 || c >= 81) ? 0.85 : (c >= 63 ? 0.65 : 0.45);
    return { text: "Rain", icon: "🌧️", kind: "rain", intensity };
  }
  if ((c >= 71 && c <= 77) || (c >= 85 && c <= 86)) {
    const intensity = (c >= 75 || c >= 86) ? 0.85 : 0.6;
    return { text: "Snow", icon: "❄️", kind: "snow", intensity };
  }
  if (c >= 95 && c <= 99) return { text: "Storm", icon: "⛈️", kind: "rain", intensity: 0.95 };
  return { text: "Weather", icon: "⛅", kind: "none", intensity: 0 };
}

function fFromC(c) {
  if (!Number.isFinite(c)) return null;
  return (c * 9) / 5 + 32;
}

function setBodyTheme({ isNight, isSunny }) {
  document.body.classList.toggle("night", !!isNight);
  document.body.classList.toggle("sunny", !!isSunny && !isNight);
}

function setWeatherBadge(icon, text) {
  if (!weatherBadge) return;
  const iconEl = weatherBadge.querySelector(".wxIcon");
  const txtEl = weatherBadge.querySelector(".wxTxt");
  if (iconEl) iconEl.textContent = icon;
  if (txtEl) txtEl.textContent = text;
  weatherBadge.title = text;
}

function getWeatherLatLng() {
  const lat = userLatLng?.lat ?? 40.7128;
  const lng = userLatLng?.lng ?? -74.0060;
  return { lat, lng };
}

function scheduleWeatherUpdateSoon() {
  if (wxNextUpdateTimer) return;
  wxNextUpdateTimer = setTimeout(() => {
    wxNextUpdateTimer = null;
    updateWeatherNow().catch(() => {});
  }, 2500);
}

async function updateWeatherNow() {
  const { lat, lng } = getWeatherLatLng();

  wxState.lastLat = lat;
  wxState.lastLng = lng;

  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(lat)}` +
    `&longitude=${encodeURIComponent(lng)}` +
    `&current=temperature_2m,weather_code,is_day` +
    `&timezone=America%2FNew_York`;

  try {
    const data = await fetchJSON(url);
    const cur = data?.current || {};
    const tempC = Number(cur.temperature_2m ?? NaN);
    const tempF = fFromC(tempC);
    const code = cur.weather_code;
    const isDay = Number(cur.is_day ?? 1) === 1;

    const desc = wxDescribe(code);
    const label = `${desc.text}${tempF != null ? ` • ${Math.round(tempF)}°F` : ""}`;

    wxState.tempF = tempF;
    wxState.kind = desc.kind;
    wxState.intensity = desc.intensity;
    wxState.isNight = !isDay;
    wxState.label = label;

    setBodyTheme({ isNight: wxState.isNight, isSunny: desc.text === "Clear" });
    setWeatherBadge(desc.icon, label);

    updateWxParticlesForState();
    ensureWxAnimationRunning();
  } catch (e) {
    setWeatherBadge("⛅", "Weather unavailable");
  }
}

setInterval(() => {
  updateWeatherNow().catch(() => {});
}, 10 * 60 * 1000);

function updateWxParticlesForState() {
  if (!wxCanvas || !wxCtx) return;

  const kind = wxState.kind;
  const intensity = wxState.intensity;

  if (kind === "none" || intensity <= 0) {
    wxParticles = [];
    return;
  }

  const base = Math.floor((window.innerWidth * window.innerHeight) / 45000);
  const count = Math.max(40, Math.min(240, Math.floor(base * (kind === "rain" ? 2.4 : 1.6) * (0.6 + intensity))));

  wxParticles = [];
  for (let i = 0; i < count; i++) {
    wxParticles.push(makeParticle(kind));
  }
}

function makeParticle(kind) {
  const w = window.innerWidth;
  const h = window.innerHeight;

  if (kind === "rain") {
    return {
      kind: "rain",
      x: Math.random() * w,
      y: Math.random() * h,
      vx: -1.2 - Math.random() * 1.2,
      vy: 10 + Math.random() * 10,
      len: 10 + Math.random() * 14,
      alpha: 0.12 + Math.random() * 0.12,
      w: 1.0,
    };
  }

  return {
    kind: "snow",
    x: Math.random() * w,
    y: Math.random() * h,
    vx: -0.7 + Math.random() * 1.4,
    vy: 1.2 + Math.random() * 2.2,
    r: 1.0 + Math.random() * 2.2,
    alpha: 0.14 + Math.random() * 0.18,
    drift: Math.random() * Math.PI * 2,
  };
}

function stepParticles() {
  if (!wxCanvas || !wxCtx) return;

  const w = window.innerWidth;
  const h = window.innerHeight;

  wxCtx.clearRect(0, 0, w, h);

  const intensity = wxState.intensity;

  if (wxState.kind === "rain") {
    wxCtx.lineCap = "round";
    for (const p of wxParticles) {
      wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
      wxCtx.lineWidth = p.w;

      wxCtx.beginPath();
      wxCtx.moveTo(p.x, p.y);
      wxCtx.lineTo(p.x + p.vx, p.y + p.len);
      wxCtx.strokeStyle = "#0a3d66";
      wxCtx.stroke();

      p.x += p.vx * (0.9 + intensity);
      p.y += p.vy * (0.85 + intensity);

      if (p.y > h + 30 || p.x < -30) {
        p.x = Math.random() * w;
        p.y = -20 - Math.random() * 200;
      }
    }
    wxCtx.globalAlpha = 1;
    return;
  }

  if (wxState.kind === "snow") {
    for (const p of wxParticles) {
      wxCtx.globalAlpha = p.alpha * (0.7 + intensity);
      wxCtx.beginPath();
      wxCtx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      wxCtx.fillStyle = "#ffffff";
      wxCtx.fill();

      p.drift += 0.03;
      p.x += (p.vx + Math.sin(p.drift) * 0.6) * (0.7 + intensity);
      p.y += p.vy * (0.7 + intensity);

      if (p.y > h + 20) {
        p.x = Math.random() * w;
        p.y = -10 - Math.random() * 150;
      }
      if (p.x < -20) p.x = w + 10;
      if (p.x > w + 20) p.x = -10;
    }
    wxCtx.globalAlpha = 1;
  }
}

function ensureWxAnimationRunning() {
  if (!wxCanvas || !wxCtx) return;

  const shouldRun = (wxState.kind !== "none" && wxState.intensity > 0);
  if (!shouldRun) {
    wxAnimRunning = false;
    wxCtx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    return;
  }
  if (wxAnimRunning) return;

  wxAnimRunning = true;

  const loop = () => {
    if (!wxAnimRunning) return;
    stepParticles();
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

/* =========================================================
   Boot
   ========================================================= */
setNavDestination(null);

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

startLocationWatch();
updateWeatherNow().catch(() => {});