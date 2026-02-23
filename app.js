const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// Refresh current frame every 5 minutes
const REFRESH_MS = 5 * 60 * 1000;

// Persisted settings
const LS_AUTOCENTER = "tlc_autocenter";
const LS_COMPASS = "tlc_compass";

// Tesla browser is often older Chromium; compass events may be missing/blocked.
const UA = navigator.userAgent || "";
const IS_TESLA = /Tesla/i.test(UA);

// ---------- Legend minimize ----------
const legendEl = document.getElementById("legend");
const legendToggleBtn = document.getElementById("legendToggle");
if (legendEl && legendToggleBtn) {
  legendToggleBtn.addEventListener("click", () => {
    const minimized = legendEl.classList.toggle("minimized");
    legendToggleBtn.textContent = minimized ? "+" : "–";
  });
}

/** LABEL VISIBILITY (mobile-friendly, demand-priority)
 * z10: green only
 * z11: green + purple
 * z12: + blue
 * z13: + sky
 * z14: + yellow
 * z15+: + red (everything)
 */
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

// ---------- Time helpers ----------
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

// ---------- Network ----------
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

// ---------- Bucket label ----------
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

// ---------- Label helpers ----------
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
function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const bucket = (props.bucket || "").trim();
  if (!shouldShowLabel(bucket, Math.round(zoom))) return "";

  const zoneText = zoom < 13 ? shortenLabel(name, LABEL_MAX_CHARS_MID) : name;

  const borough = (props.borough || "").trim();
  const showBorough = zoom >= BOROUGH_ZOOM_SHOW && borough;

  return `
    <div class="zn">${escapeHtml(zoneText)}</div>
    ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
  `;
}
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// ---------- Recommendation helpers ----------
const recommendEl = document.getElementById("recommendLine");
let userLatLng = null;

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

function geometryCenter(geom) {
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

function updateRecommendation(frame) {
  if (!recommendEl) return;

  if (!userLatLng) {
    recommendEl.textContent = "Recommended: enable location to get suggestions";
    return;
  }

  const feats = frame?.polygons?.features || [];
  if (!feats.length) {
    recommendEl.textContent = "Recommended: …";
    return;
  }

  const DIST_PENALTY_PER_MILE = 2.0;
  let best = null;

  for (const f of feats) {
    const props = f.properties || {};
    const geom = f.geometry;

    const rating = Number(props.rating ?? NaN);
    if (!Number.isFinite(rating)) continue;

    const center = geometryCenter(geom);
    if (!center) continue;

    const dMi = haversineMiles(userLatLng, center);
    const bucket = (props.bucket || "").trim();
    const hardAvoid = bucket === "red";

    const score = rating - dMi * DIST_PENALTY_PER_MILE - (hardAvoid ? 12 : 0);

    if (!best || score > best.score) {
      best = {
        score,
        dMi,
        rating,
        name: (props.zone_name || "").trim() || `Zone ${props.LocationID ?? ""}`,
        borough: (props.borough || "").trim(),
      };
    }
  }

  if (!best) {
    recommendEl.textContent = "Recommended: not enough data for your area";
    return;
  }

  const distTxt = best.dMi >= 10 ? `${best.dMi.toFixed(0)} mi` : `${best.dMi.toFixed(1)} mi`;
  const bTxt = best.borough ? ` (${best.borough})` : "";
  recommendEl.textContent = `Recommended: ${best.name}${bTxt} — Rating ${best.rating} — ${distTxt}`;
}

// ---------- Leaflet map ----------
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");

const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO",
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

// Popup
function buildPopupHTML(props) {
  const zoneName = (props.zone_name || "").trim();
  const borough = (props.borough || "").trim();

  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:2px;">${escapeHtml(zoneName || `Zone ${props.LocationID ?? ""}`)}</div>
      ${borough ? `<div style="opacity:0.8; margin-bottom:6px;">${escapeHtml(borough)}</div>` : `<div style="margin-bottom:6px;"></div>`}
      <div><b>Rating:</b> ${rating} (${prettyBucket(bucket)})</div>
      <div><b>Pickups (last ${BIN_MINUTES} min):</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
    </div>
  `;
}

function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  geoLayer = L.geoJSON(frame.polygons, {
    style: (feature) => {
      const st = feature?.properties?.style || {};
      return {
        color: st.color || st.fillColor || "#000",
        weight: st.weight ?? 0,
        opacity: st.opacity ?? 0,
        fillColor: st.fillColor || st.color || "#000",
        fillOpacity: st.fillOpacity ?? 0.82,
      };
    },
    onEachFeature: (feature, layer) => {
      const props = feature.properties || {};
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 300 });

      const html = labelHTML(props, zoomNow);
      if (!html) return;

      layer.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label ${zClass}`,
        opacity: 0.92,
        interactive: false,
      });
    },
  }).addTo(map);

  updateRecommendation(frame);
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

  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

// Re-render on zoom (no network)
map.on("zoomend", () => {
  if (currentFrame) renderFrame(currentFrame);
});

// Debounced slider
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

// ---------- Auto-refresh every 5 minutes ----------
async function refreshCurrentFrame() {
  try {
    const idx = Number(slider.value || "0");
    await loadFrame(idx);
  } catch (e) {
    console.warn("Auto-refresh failed:", e);
  }
}
setInterval(refreshCurrentFrame, REFRESH_MS);

// =========================================================
// LIVE LOCATION ARROW (rotates) + Auto-center toggle
// - Map is NOT rotated (prevents disappearing tiles on Tesla).
// =========================================================

const btnAutoCenter = document.getElementById("btnAutoCenter");
const btnCompass = document.getElementById("btnCompass");

// Defaults:
// - Auto-center ON by default
// - Compass ON by default on iPhone, OFF by default on Tesla
let autoCenter = (localStorage.getItem(LS_AUTOCENTER) ?? "1") === "1";
let compassOn = (localStorage.getItem(LS_COMPASS) ?? (IS_TESLA ? "0" : "1")) === "1";

function paintBtn(btn, on, textOn, textOff) {
  if (!btn) return;
  btn.classList.toggle("on", !!on);
  btn.textContent = on ? textOn : textOff;
}

function saveAutoCenter() {
  localStorage.setItem(LS_AUTOCENTER, autoCenter ? "1" : "0");
}
function saveCompass() {
  localStorage.setItem(LS_COMPASS, compassOn ? "1" : "0");
}

paintBtn(btnAutoCenter, autoCenter, "Auto-center: ON", "Auto-center: OFF");
paintBtn(btnCompass, compassOn, "Compass: ON", "Compass: OFF");

if (btnAutoCenter) {
  btnAutoCenter.addEventListener("click", () => {
    autoCenter = !autoCenter;
    saveAutoCenter();
    paintBtn(btnAutoCenter, autoCenter, "Auto-center: ON", "Auto-center: OFF");
    if (autoCenter && userLatLng) map.panTo(userLatLng, { animate: true });
  });
}

let compassListenerAdded = false;

// iOS Safari: requestPermission must be called from a user gesture
async function requestCompassPermissionIfNeeded() {
  try {
    if (typeof DeviceOrientationEvent === "undefined") return true;
    if (typeof DeviceOrientationEvent.requestPermission !== "function") return true; // not iOS permission model
    const res = await DeviceOrientationEvent.requestPermission();
    return res === "granted";
  } catch {
    return false;
  }
}

function startCompassListener() {
  if (compassListenerAdded) return;
  compassListenerAdded = true;

  const handler = (e) => {
    // iOS Safari
    if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading)) {
      compassHeadingDeg = e.webkitCompassHeading;
      return;
    }
    // Fallback (many browsers)
    if (typeof e.alpha === "number" && Number.isFinite(e.alpha)) {
      // alpha can be relative; still useful as a “facing” hint
      compassHeadingDeg = (360 - e.alpha) % 360;
      return;
    }
  };

  window.addEventListener("deviceorientationabsolute", handler, true);
  window.addEventListener("deviceorientation", handler, true);
}

if (btnCompass) {
  btnCompass.addEventListener("click", async () => {
    compassOn = !compassOn;
    saveCompass();
    paintBtn(btnCompass, compassOn, "Compass: ON", "Compass: OFF");

    if (compassOn) {
      const ok = await requestCompassPermissionIfNeeded();
      if (!ok) {
        compassOn = false;
        saveCompass();
        paintBtn(btnCompass, compassOn, "Compass: ON", "Compass: OFF");
        alert("Compass permission not granted. Compass stays OFF.");
        return;
      }
      startCompassListener();
    }
  });
}

// Stop auto-center when user explores map
function disableAutoCenterOnUserPan() {
  if (!autoCenter) return;
  autoCenter = false;
  saveAutoCenter();
  paintBtn(btnAutoCenter, autoCenter, "Auto-center: ON", "Auto-center: OFF");
}
map.on("dragstart", disableAutoCenterOnUserPan);
map.on("zoomstart", disableAutoCenterOnUserPan);

// Arrow marker
let navMarker = null;
let gpsFirstFixDone = false;

let lastPos = null; // {lat,lng,ts}
let lastHeadingDeg = 0;
let lastMoveTs = 0;

let compassHeadingDeg = null;

// Simple smoothing to reduce jitter
let smoothedHeading = 0;
function smoothAngle(prev, next, alpha) {
  // shortest-path interpolation around 360
  const diff = ((((next - prev) % 360) + 540) % 360) - 180;
  return (prev + diff * alpha + 360) % 360;
}

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
    zIndexOffset: 9999,
  }).addTo(map);

  // If compass is ON at load, add listener (permission may still be required on iOS,
  // but it will simply not produce values until granted).
  if (compassOn) startCompassListener();

  navigator.geolocation.watchPosition(
    (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;
      const gpsHeading = pos.coords.heading; // often null unless moving
      const ts = pos.timestamp || Date.now();

      userLatLng = { lat, lng };
      if (navMarker) navMarker.setLatLng(userLatLng);

      let isMoving = false;
      let computedHeading = null;

      if (lastPos) {
        const dMi = haversineMiles({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        const dtSec = Math.max(1, (ts - lastPos.ts) / 1000);
        const mph = (dMi / dtSec) * 3600;

        isMoving = mph >= 2.0;
        if (isMoving) lastMoveTs = ts;

        // Prefer GPS heading when moving and available
        if (isMoving && typeof gpsHeading === "number" && Number.isFinite(gpsHeading)) {
          computedHeading = gpsHeading;
        } else if (dMi > 0.01) {
          computedHeading = computeBearingDeg({ lat: lastPos.lat, lng: lastPos.lng }, userLatLng);
        } else if (compassOn && typeof compassHeadingDeg === "number") {
          computedHeading = compassHeadingDeg;
        }
      } else {
        // First point: compass if available
        if (compassOn && typeof compassHeadingDeg === "number") computedHeading = compassHeadingDeg;
      }

      lastPos = { lat, lng, ts };

      if (typeof computedHeading === "number" && Number.isFinite(computedHeading)) {
        lastHeadingDeg = computedHeading;
      }

      // Smooth the arrow rotation (less jitter)
      smoothedHeading = smoothAngle(smoothedHeading, lastHeadingDeg, 0.25);
      setNavRotation(smoothedHeading);
      setNavVisual(isMoving);

      // One-time zoom to you
      if (!gpsFirstFixDone) {
        gpsFirstFixDone = true;
        const targetZoom = Math.max(map.getZoom(), 14);
        map.setView(userLatLng, targetZoom, { animate: true });
      } else {
        if (autoCenter) map.panTo(userLatLng, { animate: true });
      }

      if (currentFrame) updateRecommendation(currentFrame);
    },
    (err) => {
      console.warn("Geolocation error:", err);
      if (recommendEl) recommendEl.textContent = "Recommended: location blocked (enable it)";
    },
    {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    }
  );

  // Stationary pulse + stationary compass refresh for arrow
  setInterval(() => {
    const now = Date.now();
    const recentlyMoved = lastMoveTs && (now - lastMoveTs) < 5000;
    setNavVisual(!!recentlyMoved);

    // If stationary and compass is ON, keep arrow synced to compass
    if (!recentlyMoved && compassOn && typeof compassHeadingDeg === "number") {
      lastHeadingDeg = compassHeadingDeg;
      smoothedHeading = smoothAngle(smoothedHeading, lastHeadingDeg, 0.20);
      setNavRotation(smoothedHeading);
    }
  }, 1200);
}

// Boot
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});

startLocationWatch();