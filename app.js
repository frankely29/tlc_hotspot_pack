// =========================
// CONFIG (EDIT THIS)
// =========================
const RAILWAY_BASE = "https://web-production-78f67.up.railway.app"; // <-- your Railway base URL
const BIN_MINUTES = 20;

// =========================
// Helpers
// =========================
function parseIsoNoTz(iso) {
  // "YYYY-MM-DDTHH:MM:SS"
  const [d, t] = iso.split("T");
  const [Y, M, D] = d.split("-").map(Number);
  const [h, m, s] = t.split(":").map(Number);
  return { Y, M, D, h, m, s };
}

function dowMon0FromIso(iso) {
  // Treat as UTC so it’s stable across devices.
  // Date.UTC uses real weekday for the baseline date in timeline.
  const { Y, M, D, h, m, s } = parseIsoNoTz(iso);
  const dt = new Date(Date.UTC(Y, M - 1, D, h, m, s));
  const dowSun0 = dt.getUTCDay(); // 0..6
  return dowSun0 === 0 ? 6 : dowSun0 - 1; // Mon=0..Sun=6
}

function minuteOfWeekFromIso(iso) {
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  return dow_m * 1440 + (h * 60 + m);
}

function formatNYCLabel(iso) {
  // Display label as "Sat 6:20 PM" based on iso components (NYC-local by contract)
  const { h, m } = parseIsoNoTz(iso);
  const dow_m = dowMon0FromIso(iso);
  const names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const hr12 = ((h + 11) % 12) + 1;
  const ampm = h >= 12 ? "PM" : "AM";
  const mm = String(m).padStart(2, "0");
  return `${names[dow_m]} ${hr12}:${mm} ${ampm}`;
}

function getNowNYCMinuteOfWeekRounded() {
  // Use Intl to get NYC local time regardless of user device timezone
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date());

  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const weekday = map.weekday; // "Mon" etc
  const hour = Number(map.hour);
  const minute = Number(map.minute);

  const dowMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const dow_m = dowMap[weekday] ?? 0;

  const total = dow_m * 1440 + hour * 60 + minute;
  const rounded = Math.floor(total / BIN_MINUTES) * BIN_MINUTES;
  return rounded;
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

function setSummary(el, summary) {
  if (!summary) {
    el.textContent = "";
    return;
  }
  const order = ["green", "blue", "sky", "yellow", "red"];
  const labels = {
    green: "Green",
    blue: "Blue",
    sky: "Sky",
    yellow: "Yellow",
    red: "Red",
  };
  el.innerHTML = order
    .map((k) => `<span class="pill">${labels[k]}: ${summary[k] ?? 0}</span>`)
    .join("");
}

// =========================
// Map init
// =========================
const map = L.map("map", { zoomControl: true }).setView([40.7128, -74.0060], 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  attribution: '&copy; OpenStreetMap &copy; CARTO',
  maxZoom: 19,
}).addTo(map);

let geoLayer = null;

// UI
const slider = document.getElementById("slider");
const timeLabel = document.getElementById("timeLabel");
const summaryEl = document.getElementById("summary");

// Data
let timeline = [];
let minutesOfWeek = [];

// =========================
// Loading frames
// =========================
async function fetchJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return await res.json();
}

async function loadTimeline() {
  const t = await fetchJSON(`${RAILWAY_BASE}/timeline`);
  timeline = t.timeline || [];
  if (!timeline.length) throw new Error("Timeline empty.");

  minutesOfWeek = timeline.map(minuteOfWeekFromIso);

  slider.min = "0";
  slider.max = String(timeline.length - 1);
  slider.step = "1";

  // Init slider to closest NYC "now" window
  const nowMinWeek = getNowNYCMinuteOfWeekRounded();
  const idx = pickClosestIndex(minutesOfWeek, nowMinWeek);
  slider.value = String(idx);

  await loadFrame(idx);
}

function buildPopupHTML(props) {
  const rating = props.rating ?? "";
  const bucket = props.bucket ?? "";
  const pickups = props.pickups ?? "";
  const pay = props.avg_driver_pay == null ? "n/a" : props.avg_driver_pay.toFixed(2);
  const eta = props.eta_minutes ?? "n/a";

  return `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial; font-size:13px;">
      <div style="font-weight:800; margin-bottom:4px;">Zone ${props.LocationID}</div>
      <div><b>Rating:</b> ${rating} (${bucket})</div>
      <div><b>Pickups:</b> ${pickups}</div>
      <div><b>Avg Driver Pay:</b> $${pay}</div>
      <div><b>ETA (activity):</b> ~${eta} min</div>
      <div style="opacity:0.75; margin-top:6px;">ETA is based on pickup frequency in this zone/time window.</div>
    </div>
  `;
}

async function loadFrame(idx) {
  const frame = await fetchJSON(`${RAILWAY_BASE}/frame/${idx}`);
  const iso = frame.time;
  timeLabel.textContent = formatNYCLabel(iso);
  setSummary(summaryEl, frame.summary);

  if (geoLayer) {
    geoLayer.remove();
    geoLayer = null;
  }

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
      layer.bindPopup(buildPopupHTML(props), { maxWidth: 280 });
    }
  }).addTo(map);
}

// slider events
let sliderDebounce = null;
slider.addEventListener("input", () => {
  const idx = Number(slider.value);
  // debounce to avoid spamming requests while dragging
  if (sliderDebounce) clearTimeout(sliderDebounce);
  sliderDebounce = setTimeout(() => loadFrame(idx).catch(console.error), 80);
});

// Boot
loadTimeline().catch((err) => {
  console.error(err);
  timeLabel.textContent = "Error loading timeline. Check Railway /timeline.";
});