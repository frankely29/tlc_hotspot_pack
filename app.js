/* =========================================================
   NYC TLC Hotspot Map (Frontend) - SIMPLE + STABLE
   ---------------------------------------------------------
   GOALS:
   1) Keep your original map zoom behavior (NO forced zoom-in changes)
   2) Keep Auto-center stable: ON follows you, OFF lets you explore
   3) Keep page updating in Safari without manual refresh:
      - every 60s: if NYC moved to a new 20-min bin -> move slider + load frame
      - every 5 min: refresh the current frame (same index)

   =========================================================
   MANHATTAN MODE (NEW) — DEFAULT behavior, do not change unless you know why
   ---------------------------------------------------------
   Problem: Manhattan has high demand but can be over-saturated with drivers.
   Your backend rating = demand-heavy. That can overrate Manhattan.

   Solution (data-driven, Manhattan-only):
   - When Manhattan Mode is ON, we compute a Manhattan-only adjusted rating
     from the CURRENT frame’s data:
       * Pay percentile (primary signal) + Pickup percentile (secondary)
       * Optional small global penalty applied ONLY to Manhattan

   UPDATE (ONLY CHANGE WE MADE NOW):
   - Manhattan Mode applies ONLY to Midtown + Lower Manhattan (NOT Uptown)
   - Uptown Manhattan stays NYC-wide
   - We detect this by zone centroid latitude cutoff

   WARNING:
   - This does NOT increase Railway load. It only changes frontend coloring.
   - It does NOT change your backend frames; it only recalculates Manhattan
     presentation and recommendation weighting on the fly.
   ========================================================= */

const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes (re-fetch same slider idx)
const REFRESH_MS = 5 * 60 * 1000;

// NYC clock tick: check if the correct 20-min window changed
const NYC_CLOCK_TICK_MS = 60 * 1000;

// If user recently touched slider, don't auto-advance for a bit
const USER_SLIDER_GRACE_MS = 25 * 1000;

/* =========================================================
   MANHATTAN MODE — DEFAULT SETTINGS (SAFE TO EDIT)
   ---------------------------------------------------------
   These only affect Manhattan when Manhattan Mode is ON.
   ========================================================= */
const LS_KEY_MANHATTAN = "manhattan_mode_enabled";

// Manhattan adjusted rating uses percentiles inside Manhattan ONLY:
// score = (PAY_WEIGHT * payPercentile) + (VOL_WEIGHT * pickupPercentile)
const MANHATTAN_PAY_WEIGHT = 0.60;   // higher = favor higher pay zones in Manhattan more
const MANHATTAN_VOL_WEIGHT = 0.40;   // lower = de-emphasize pure demand (saturation risk proxy)

// Optional penalty to gently push Manhattan down overall when mode is ON.
// Example 0.90 = 10% penalty, 0.85 = 15% penalty.
const MANHATTAN_GLOBAL_PENALTY = 0.95;

// Minimum Manhattan zones in frame needed to compute percentiles reliably
const MANHATTAN_MIN_ZONES = 10;

/* =========================================================
   MANHATTAN MODE — UPTOWN EXCLUSION (ONLY CHANGE)
   ---------------------------------------------------------
   Manhattan Mode should ONLY affect Midtown + Lower Manhattan.
   Uptown Manhattan stays NYC-wide.
   We do this using centroid latitude cutoff (data-driven).
   ========================================================= */
// ~96th St-ish cutoff (excludes Harlem / Inwood / Wash Heights / etc)
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
   Time helpers (backend timeline is "no TZ" ISO strings)
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
  const dowSun0 = dt.getUTCDay(); // 0=Sun..6=Sat
  return dowSun0 === 0 ? 6 : dowSun0 - 1; // Mon=0..Sun=6
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

// Get NYC minute-of-week rounded DOWN to current BIN_MINUTES bucket
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

// Cyclic distance in a 7-day week
function cyclicDiff(a, b, mod) {
  const d = Math.abs(a - b);
  return Math.min(d, mod - d);
}

// Pick the closest frame index to a target minute-of-week
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
   Manhattan Mode (pay-weight Manhattan-only recolor)
   DEFAULT behavior, do not change unless you know why.
   ---------------------------------------------------------
   We create the button dynamically if it doesn't exist in HTML,
   so you do NOT need to edit index.html.
   ========================================================= */
let manhattanMode = (localStorage.getItem(LS_KEY_MANHATTAN) || "0") === "1";

function isManhattanFeature(props) {
  const b = (props?.borough || "").toString().toLowerCase();
  return b.includes("manhattan");
}

/* =========================================================
   Manhattan Mode — UPTOWN EXCLUSION (ONLY CHANGE)
   ---------------------------------------------------------
   Midtown + Lower Manhattan ONLY:
   - require borough=Manhattan
   - require centroid.lat <= MANHATTAN_CORE_MAX_LAT
   ========================================================= */
function isCoreManhattan(props, geom) {
  if (!isManhattanFeature(props)) return false;
  const c = geometryCenter(geom);
  if (!c || !Number.isFinite(c.lat)) return false;
  return c.lat <= MANHATTAN_CORE_MAX_LAT;
}

function ensureManhattanButton() {
  // If you already added a button in HTML with id="btnManhattan", we reuse it.
  let btn = document.getElementById("btnManhattan");
  if (btn) return btn;

  // Otherwise, create it and place it near the other mode buttons (best-effort).
  btn = document.createElement("button");
  btn.id = "btnManhattan";
  btn.type = "button";
  btn.className = "navBtn"; // uses your existing styles (safe even if class differs)
  btn.style.marginLeft = "6px";
  btn.style.padding = "6px 10px";
  btn.style.borderRadius = "10px";
  btn.style.border = "1px solid rgba(0,0,0,0.2)";
  btn.style.background = "rgba(255,255,255,0.95)";
  btn.style.fontWeight = "700";
  btn.style.fontSize = "12px";

  // Try to insert into the same row as other legend buttons
  const navRow =
    document.getElementById("navRow") ||
    (legendEl ? legendEl.querySelector(".navRow") : null) ||
    (legendEl ? legendEl : null);

  if (navRow) {
    // Insert after Staten Island button if present, otherwise append
    if (btnStatenIsland && btnStatenIsland.parentElement === navRow) {
      btnStatenIsland.insertAdjacentElement("afterend", btn);
    } else {
      navRow.appendChild(btn);
    }
  } else {
    // Last resort: add to body (won't break app)
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

    // Re-render immediately to recolor Manhattan without changing slider/backend
    if (currentFrame) renderFrame(currentFrame);
  });
}

/* =========================================================
   Shared rating->color helper (same thresholds as backend)
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
   Manhattan Mode — compute Manhattan-only adjusted rating per frame
   DEFAULT behavior, do not change unless you know why.
   ---------------------------------------------------------
   Uses CURRENT frame data only:
     - pickups percentile within Manhattan
     - avg_driver_pay percentile within Manhattan
   Then:
     score = PAY_WEIGHT*payP + VOL_WEIGHT*volP
     rating = 1 + 99*score
     then apply optional GLOBAL_PENALTY

   UPTOWN EXCLUSION (ONLY CHANGE):
   - We only include CORE Manhattan zones in the percentile pool
   - Uptown Manhattan zones are cleared back to NYC-wide
   ========================================================= */
function applyManhattanLocalView(frame) {
  const feats = frame?.polygons?.features || [];
  if (!feats.length) return frame;

  // Collect CORE Manhattan pickups and pay (only where data is valid)
  const mPickups = [];
  const mPay = [];

  for (const f of feats) {
    const props = f.properties || {};
    if (!isCoreManhattan(props, f.geometry)) continue; // <-- ONLY CHANGE

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    if (Number.isFinite(pu)) mPickups.push(pu);
    if (Number.isFinite(pay)) mPay.push(pay);
  }

  // If too few CORE Manhattan zones in this frame, skip (prevents noisy flips)
  if (mPickups.length < MANHATTAN_MIN_ZONES || mPay.length < MANHATTAN_MIN_ZONES) {
    for (const f of feats) {
      const props = f.properties || {};
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
    }
    return frame;
  }

  // Sort for percentile rank
  const pickSorted = mPickups.slice().sort((a, b) => a - b);
  const paySorted = mPay.slice().sort((a, b) => a - b);

  function percentileFromSorted(sorted, v) {
    // percent based on <= v index
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

    // Non-core Manhattan (UPTOWN) and non-Manhattan: reset (NYC-wide)
    if (!isCoreManhattan(props, f.geometry)) { // <-- ONLY CHANGE
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const pu = Number(props.pickups ?? NaN);
    const pay = Number(props.avg_driver_pay ?? NaN);

    // If missing data, skip (keep null so it falls back to NYC)
    if (!Number.isFinite(pu) || !Number.isFinite(pay)) {
      props.mh_local_rating = null;
      props.mh_local_bucket = null;
      props.mh_local_color = null;
      continue;
    }

    const volP = percentileFromSorted(pickSorted, pu);
    const payP = percentileFromSorted(paySorted, pay);

    // Data-driven Manhattan score: pay-weighted
    let score = MANHATTAN_PAY_WEIGHT * payP + MANHATTAN_VOL_WEIGHT * volP;
    score = Math.max(0, Math.min(1, score));

    // Convert to 1..100 and apply optional global penalty
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
    // Keep your original note text; Manhattan mode doesn't overwrite it.
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
   Effective bucket/color/rating selection
   DEFAULT behavior, do not change unless you know why.
   ---------------------------------------------------------
   Precedence:
   1) Staten Island Mode for Staten Island zones
   2) Manhattan Mode for CORE Manhattan zones ONLY (NOT Uptown)
   3) Backend NYC rating
   ========================================================= */
function effectiveBucket(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_bucket) return props.si_local_bucket;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_bucket) return props.mh_local_bucket; // <-- ONLY CHANGE
  return (props.bucket || "").trim();
}
function effectiveColor(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && props.si_local_color) return props.si_local_color;
  if (manhattanMode && isCoreManhattan(props, geom) && props.mh_local_color) return props.mh_local_color; // <-- ONLY CHANGE
  const st = props?.style || {};
  return st.fillColor || st.color || "#000";
}
function effectiveRating(props, geom) {
  if (statenIslandMode && isStatenIslandFeature(props) && Number.isFinite(Number(props.si_local_rating))) {
    return Number(props.si_local_rating);
  }
  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) { // <-- ONLY CHANGE
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

/* =========================================================
   FIX: Accurate polygon centroid (area-weighted)
   ---------------------------------------------------------
   Your old geometryCenter() averaged points, which can be far
   from the real zone center. That breaks distance -> breaks
   recommendations.
   ========================================================= */

// Centroid of a linear ring (expects [[lng,lat],...], ideally closed)
function ringCentroidArea(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null;

  // Ensure closed ring for math stability
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

  // A is 2*signedArea
  if (Math.abs(A) < 1e-12) return null;

  const inv = 1 / (3 * A);
  return { lng: Cx * inv, lat: Cy * inv, area2: A };
}

// Centroid of Polygon with holes: outer ring minus hole influence (approx)
function polygonCentroid(geom) {
  const rings = geom?.coordinates;
  if (!Array.isArray(rings) || rings.length === 0) return null;

  // Outer ring centroid
  const outer = ringCentroidArea(rings[0]);
  if (!outer) return null;

  // Subtract holes (if any)
  let sumArea2 = outer.area2;
  let sumLng = outer.lng * outer.area2;
  let sumLat = outer.lat * outer.area2;

  for (let i = 1; i < rings.length; i++) {
    const hole = ringCentroidArea(rings[i]);
    if (!hole) continue;
    // Hole ring orientation may be opposite; use its area2 as computed
    sumArea2 += hole.area2;
    sumLng += hole.lng * hole.area2;
    sumLat += hole.lat * hole.area2;
  }

  if (Math.abs(sumArea2) < 1e-12) return { lat: outer.lat, lng: outer.lng };
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}

// Centroid of MultiPolygon: area-weighted average of polygon centroids
function multiPolygonCentroid(geom) {
  const polys = geom?.coordinates;
  if (!Array.isArray(polys) || polys.length === 0) return null;

  let sumArea2 = 0;
  let sumLat = 0;
  let sumLng = 0;

  for (const poly of polys) {
    // poly is [ring1, ring2...]
    const c = polygonCentroid({ type: "Polygon", coordinates: poly });
    if (!c) continue;

    // Approx weight: use outer ring area2
    const outer = ringCentroidArea(poly?.[0] || []);
    const w = outer ? outer.area2 : 1;

    sumArea2 += w;
    sumLat += c.lat * w;
    sumLng += c.lng * w;
  }

  if (Math.abs(sumArea2) < 1e-12) return null;
  return { lat: sumLat / sumArea2, lng: sumLng / sumArea2 };
}

// Replacement for your old geometryCenter()
function geometryCenter(geom) {
  if (!geom) return null;
  if (geom.type === "Polygon") return polygonCentroid(geom);
  if (geom.type === "MultiPolygon") return multiPolygonCentroid(geom);
  return null;
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

    // IMPORTANT: recommendation uses the effective rating
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
        usedMH: (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))), // <-- ONLY CHANGE
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

// Panes so the nav arrow is always above labels/tooltips
const labelsPane = map.createPane("labelsPane");
labelsPane.style.zIndex = 450;

const navPane = map.createPane("navPane");
navPane.style.zIndex = 1000;

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

// Track user slider touches so we don't fight them
let lastUserSliderTs = 0;

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

  // ONLY show Manhattan-adjusted if CORE Manhattan
  if (manhattanMode && isCoreManhattan(props, geom) && Number.isFinite(Number(props.mh_local_rating))) { // <-- ONLY CHANGE
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

  // Apply local transforms (do NOT change backend data; only adds extra fields)
  if (statenIslandMode) applyStatenLocalView(currentFrame);
  if (manhattanMode) applyManhattanLocalView(currentFrame);

  timeLabel.textContent = formatNYCLabel(currentFrame.time);

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
      const fill = effectiveColor(props, feature.geometry); // <-- ONLY CHANGE (pass geom)

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
      layer.bindPopup(buildPopupHTML(props, feature.geometry), { maxWidth: 320 }); // <-- ONLY CHANGE

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

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  // Start at NYC "now" bucket (closest available)
  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

// Re-render labels on zoom changes
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Slider manual control (debounced)
let sliderDebounce = null;
slider.addEventListener("input", () => {
  lastUserSliderTs = Date.now();
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

/* =========================================================
   Auto-center button (stable)
   - ON: follows your GPS arrow
   - OFF: you can explore freely
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

    // IMPORTANT: no forced zoom changes here. If you want closer, you manually zoom.
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
   Live location arrow + follow behavior (ORIGINAL ZOOM LOGIC)
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
        const targetZoom = Math.max(map.getZoom(), 13); // ORIGINAL behavior
        suppressAutoDisableFor(1200, () => map.setView(userLatLng, targetZoom, { animate: true }));
      } else {
        if (autoCenter) {
          suppressAutoDisableFor(700, () => map.panTo(userLatLng, { animate: true }));
        }
      }

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

  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    setNavVisual(!!recentlyMoved);
  }, 1200);
}

/* =========================================================
   AUTO-UPDATE (no manual refresh needed)
   ========================================================= */

// Every 5 minutes: refresh the current frame (same slider index)
async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

// Every minute: if NYC moved into a NEW 20-min bucket, move slider + load that frame
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

// When tab becomes visible again (Safari), refresh immediately
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    refreshCurrentFrame().catch(() => {});
    tickNYCClockAndAdvanceIfNeeded().catch(() => {});
  }
});

/* =========================================================
   Boot
   ========================================================= */
setNavDestination(null);

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

startLocationWatch();