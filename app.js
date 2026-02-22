const RAILWAY_BASE = "https://web-production-78f67.up.railway.app";
const BIN_MINUTES = 20;

// -------- Label rules (less crowded, priority-based) --------
// Show fewer labels when zoomed out, more as you zoom in.
const Z_SHOW_TOP = 10;     // show green + purple at >=10
const Z_SHOW_MED = 11;     // add blue at >=11
const Z_SHOW_ALL = 12;     // add sky + yellow + red at >=12

// Collision spacing (px). Larger when zoomed out.
function collisionRadiusPx(zoom) {
  if (zoom <= 10) return 55;
  if (zoom === 11) return 45;
  if (zoom === 12) return 36;
  if (zoom === 13) return 28;
  return 22;
}

// Shorten names at low zoom
function maxCharsForZoom(zoom) {
  if (zoom <= 10) return 12;
  if (zoom === 11) return 16;
  if (zoom === 12) return 22;
  return 40;
}

// Bucket priority (higher drawn/kept first)
const BUCKET_PRIORITY = {
  green: 6,
  purple: 5,
  blue: 4,
  sky: 3,
  yellow: 2,
  red: 1,
};

function shouldShowBucket(bucket, zoom) {
  if (zoom < Z_SHOW_TOP) return false;
  if (zoom < Z_SHOW_MED) return bucket === "green" || bucket === "purple";
  if (zoom < Z_SHOW_ALL) return bucket === "green" || bucket === "purple" || bucket === "blue";
  return true;
}

function shortenLabel(text, maxChars) {
  const t = (text || "").trim();
  if (!t) return "";
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars - 1) + "…";
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function zoomClass(zoom) {
  const z = Math.max(7, Math.min(14, Math.round(zoom)));
  return `z${z}`;
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

// ---------- Popup ----------
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

// ---------- Label point inside polygon (polylabel) ----------
function isPolylabelReady() {
  return typeof polylabel === "function";
}

// Convert GeoJSON Polygon/MultiPolygon -> polylabel format
function toPolylabelPolygon(geometry) {
  // polylabel expects: [ [ [x,y], ...ring ] , [holeRing], ...]
  // We'll use lng/lat as x/y (works fine for NYC scale).
  if (!geometry) return null;

  const type = geometry.type;
  const coords = geometry.coordinates;

  if (type === "Polygon") {
    return coords; // already [ring, hole, ...]
  }
  if (type === "MultiPolygon") {
    // pick the largest polygon by outer ring length (cheap + decent)
    let best = null;
    let bestLen = -1;
    for (const poly of coords) {
      const outer = poly?.[0];
      const len = outer ? outer.length : 0;
      if (len > bestLen) { bestLen = len; best = poly; }
    }
    return best;
  }
  return null;
}

function computeInsidePointLatLng(feature) {
  const geom = feature?.geometry;
  const poly = toPolylabelPolygon(geom);
  if (!poly) return null;

  // polylabel wants [ [x,y], ...]
  // GeoJSON is [lng,lat]
  if (isPolylabelReady()) {
    try {
      const p = polylabel(poly, 0.0005); // precision tuned for NYC
      if (Array.isArray(p) && p.length === 2) {
        const lng = p[0], lat = p[1];
        if (Number.isFinite(lat) && Number.isFinite(lng)) return L.latLng(lat, lng);
      }
    } catch (e) {
      // fallthrough
    }
  }

  // fallback: Turf pointOnFeature (also inside, but less optimal)
  if (window.turf && typeof turf.pointOnFeature === "function") {
    try {
      const pt = turf.pointOnFeature(feature);
      const [lng, lat] = pt?.geometry?.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) return L.latLng(lat, lng);
    } catch (e) {}
  }

  return null;
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

function renderFrame(frame) {
  currentFrame = frame;
  timeLabel.textContent = formatNYCLabel(frame.time);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

  const zoomNow = map.getZoom();
  const zClass = zoomClass(zoomNow);

  // 1) Build list of features, compute label points, sort by priority
  const features = (frame.polygons?.features || []).map((f) => {
    if (!f.properties) f.properties = {};
    // cache label point on the feature itself (so zoom rerender is fast)
    if (!f.properties._label_latlng) {
      const ll = computeInsidePointLatLng(f);
      f.properties._label_latlng = ll ? { lat: ll.lat, lng: ll.lng } : null;
    }
    return f;
  });

  features.sort((a, b) => {
    const pa = BUCKET_PRIORITY[(a.properties?.bucket || "").trim()] || 0;
    const pb = BUCKET_PRIORITY[(b.properties?.bucket || "").trim()] || 0;
    // Higher priority first
    if (pb !== pa) return pb - pa;
    // Then higher rating first
    return (b.properties?.rating || 0) - (a.properties?.rating || 0);
  });

  // 2) Collision tracking in screen pixels
  const placedPts = [];
  const R = collisionRadiusPx(zoomNow);
  function collides(pt) {
    for (const p of placedPts) {
      const dx = pt.x - p.x;
      const dy = pt.y - p.y;
      if ((dx * dx + dy * dy) < (R * R)) return true;
    }
    return false;
  }

  // 3) Create GeoJSON layer and tooltips
  geoLayer = L.geoJSON({ type: "FeatureCollection", features }, {
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

      const bucket = (props.bucket || "").trim();
      if (!shouldShowBucket(bucket, zoomNow)) return;

      const rawName = (props.zone_name || "").trim();
      if (!rawName) return;

      const llObj = props._label_latlng;
      if (!llObj) return;

      const labelLatLng = L.latLng(llObj.lat, llObj.lng);

      // collision check using current zoom
      const pt = map.latLngToContainerPoint(labelLatLng);
      if (collides(pt)) return;
      placedPts.push(pt);

      const labelText = shortenLabel(rawName, maxCharsForZoom(zoomNow));
      const borough = (props.borough || "").trim();

      // simple 2-line, like your example (no pill bubbles)
      const html = `
        <div class="zn">${escapeHtml(labelText)}</div>
        ${zoomNow >= 12 && borough ? `<div class="br">${escapeHtml(borough)}</div>` : ""}
      `;

      // Create an invisible marker at label point and attach a permanent tooltip
      const m = L.marker(labelLatLng, { opacity: 0, interactive: false });
      m.bindTooltip(html, {
        permanent: true,
        direction: "center",
        className: `zone-label-flat ${zClass}`,
        opacity: 0.95,
        interactive: false,
      });
      m.addTo(map);

      // Keep reference so we can remove markers when rerendering
      layer._labelMarker = m;
    },
  }).addTo(map);

  // When geoLayer is removed, also remove label markers we created
  geoLayer.eachLayer((layer) => {
    if (layer._labelMarker) {
      layer.on("remove", () => {
        try { map.removeLayer(layer._labelMarker); } catch {}
      });
    }
  });
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

// Boot
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = `Error loading timeline: ${err.message}`;
});