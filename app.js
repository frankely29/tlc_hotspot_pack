const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

/**
 * ✅ Label policy: show important zones sooner, still decluttered.
 */
const LABEL_ZOOM_START = 8;      // start showing labels sooner
const LABEL_ZOOM_ALL = 11;       // allow all buckets (still decluttered)
const BOROUGH_ZOOM_SHOW = 13;    // show borough line only when zoomed in
const LABEL_MAX_CHARS_LOW = 11;  // shorten at low zoom
const LABEL_MAX_CHARS_MID = 15;  // shorten at mid zoom

/**
 * Declutter: base padding.
 * We'll apply smaller padding for higher-demand buckets (so they can fit more easily).
 */
const DECLUTTER_PADDING_BASE = 5;

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

// ---------- Buckets ----------
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
function bucketPriority(bucket) {
  switch (bucket) {
    case "green": return 600;
    case "purple": return 500;
    case "blue": return 400;
    case "sky": return 300;
    case "yellow": return 200;
    case "red": return 100;
    default: return 0;
  }
}

// ✅ tighter padding for important buckets so they appear more often
function declutterPaddingForBucket(bucket) {
  if (bucket === "green" || bucket === "purple") return 2;
  if (bucket === "blue") return 3;
  if (bucket === "sky") return 4;
  return DECLUTTER_PADDING_BASE; // yellow/red
}

// ---------- Text / HTML ----------
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}
function zoomClass(zoom) {
  const z = Math.max(8, Math.min(14, Math.round(zoom)));
  return `z${z}`;
}

/**
 * ✅ Bucket visibility by zoom:
 * - z<8: none
 * - z8-9: green/purple/blue ONLY
 * - z10: add sky
 * - z11+: allow all (still declutter)
 */
function bucketAllowedAtZoom(bucket, zoom) {
  if (zoom < LABEL_ZOOM_START) return false;
  if (zoom < 10) return bucket === "green" || bucket === "purple" || bucket === "blue";
  if (zoom < LABEL_ZOOM_ALL) return bucket !== "red"; // allow most, skip red
  return true;
}

function labelHTML(props, zoom) {
  const name = (props.zone_name || "").trim();
  if (!name) return "";

  const bucket = (props.bucket || "").trim();
  if (!bucketAllowedAtZoom(bucket, zoom)) return "";

  let maxChars = LABEL_MAX_CHARS_MID;
  if (zoom <= 10) maxChars = LABEL_MAX_CHARS_LOW;

  const zoneText = shortenLabel(name, maxChars);

  const borough = (props.borough || "").trim();
  const showBorough = zoom >= BOROUGH_ZOOM_SHOW && borough;

  return `
    <div class="zn">${escapeHtml(zoneText)}</div>
    ${showBorough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
  `;
}

// ---------- Label placement (inside polygon) ----------
function interiorLabelLatLng(feature) {
  try {
    const pt = turf.polylabel(feature, { precision: 1.0 });
    const coords = pt?.geometry?.coordinates;
    if (coords && coords.length === 2) return L.latLng(coords[1], coords[0]);
  } catch {}
  try {
    const pt2 = turf.centerOfMass(feature);
    const c2 = pt2?.geometry?.coordinates;
    if (c2 && c2.length === 2) return L.latLng(c2[1], c2[0]);
  } catch {}
  return null;
}

function estimateLabelBox(zoom, zoneText, showBorough) {
  const z = Math.max(8, Math.min(14, Math.round(zoom)));
  const charW = (z <= 10) ? 6.0 : (z <= 12 ? 6.5 : 7.0);
  const padW = 18;
  const w = Math.min(240, Math.max(56, zoneText.length * charW + padW));
  const h = showBorough ? (z <= 10 ? 30 : 34) : (z <= 10 ? 20 : 22);
  return { w, h };
}
function rectsOverlap(a, b) {
  return !(a.x2 < b.x1 || a.x1 > b.x2 || a.y2 < b.y1 || a.y1 > b.y2);
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
let labelLayer = null;
let timeline = [];
let minutesOfWeek = [];
let currentFrame = null;

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

function clearLayers() {
  if (geoLayer) { geoLayer.remove(); geoLayer = null; }
  if (labelLayer) { labelLayer.remove(); labelLayer = null; }
}

function renderPolygons(frame) {
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
    },
  }).addTo(map);
}

function renderLabels(frame) {
  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  labelLayer = L.layerGroup().addTo(map);

  const candidates = [];
  for (const f of (frame.polygons?.features || [])) {
    const props = f.properties || {};
    const bucket = (props.bucket || "").trim();
    const name = (props.zone_name || "").trim();
    if (!name) continue;
    if (!bucketAllowedAtZoom(bucket, zoomNow)) continue;

    let maxChars = LABEL_MAX_CHARS_MID;
    if (zoomNow <= 10) maxChars = LABEL_MAX_CHARS_LOW;
    const zoneText = shortenLabel(name, maxChars);

    const borough = (props.borough || "").trim();
    const showBorough = zoomNow >= BOROUGH_ZOOM_SHOW && !!borough;

    const latlng = interiorLabelLatLng(f);
    if (!latlng) continue;

    const pickups = Number(props.pickups || 0);
    const pr = bucketPriority(bucket);

    candidates.push({ props, bucket, pickups, pr, zoneText, showBorough, latlng });
  }

  // ✅ Important: sort so top-demand wins collision wars
  candidates.sort((a, b) => {
    if (b.pr !== a.pr) return b.pr - a.pr;
    return b.pickups - a.pickups;
  });

  const occupied = [];

  for (const c of candidates) {
    const html = labelHTML(c.props, zoomNow);
    if (!html) continue;

    const pad = declutterPaddingForBucket(c.bucket);

    const pt = map.latLngToContainerPoint(c.latlng);
    const box = estimateLabelBox(zoomNow, c.zoneText, c.showBorough);

    const rect = {
      x1: pt.x - box.w / 2 - pad,
      y1: pt.y - box.h / 2 - pad,
      x2: pt.x + box.w / 2 + pad,
      y2: pt.y + box.h / 2 + pad,
    };

    let ok = true;
    for (const r of occupied) {
      if (rectsOverlap(rect, r)) { ok = false; break; }
    }
    if (!ok) continue;

    occupied.push(rect);

    const icon = L.divIcon({
      className: `zone-label ${zClass} bucket-${c.bucket}`,
      html,
      iconSize: null,
    });

    L.marker(c.latlng, { icon, interactive: false }).addTo(labelLayer);
  }
}

function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  clearLayers();
  renderPolygons(frame);
  renderLabels(frame);
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

map.on("zoomend", () => {
  if (!currentFrame) return;
  if (labelLayer) { labelLayer.remove(); labelLayer = null; }
  renderLabels(currentFrame);
});

let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});