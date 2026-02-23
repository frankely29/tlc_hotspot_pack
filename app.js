<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>NYC TLC Hotspot Map</title>

  <!-- Leaflet -->
  <link
    rel="stylesheet"
    href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"
    integrity="sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY="
    crossorigin=""
  />
  <script
    src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"
    integrity="sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo="
    crossorigin=""
  ></script>

  <style>
    html, body { height: 100%; margin: 0; }
    #map { height: 100vh; width: 100vw; }

    /* Legend box (top-left) + minimize */
    .legend {
      position: absolute;
      top: 10px;
      left: 10px;
      z-index: 1000;
      background: rgba(255,255,255,0.92);
      padding: 8px 8px 7px 8px;
      border-radius: 12px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.15);
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
      max-width: 240px;
    }
    .legendHeader{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin-bottom:6px;
    }
    .legend h3 { margin: 0; font-size: 14px; font-weight: 900; }
    .legendToggleBtn{
      border: none;
      background: rgba(0,0,0,0.06);
      border-radius: 10px;
      padding: 6px 10px;
      font-weight: 950;
      font-size: 13px;
      cursor: pointer;
    }
    .legendToggleBtn:active{ transform: scale(0.98); }
    .legendBody{ display:block; }
    .legend.minimized .legendBody{ display:none; }

    .legend .recommendLine{
      margin: 0 0 6px 0;
      font-size: 11px;
      font-weight: 900;
      opacity: 0.92;
      line-height: 1.15;
    }
    .legend .row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 5px 0;
      font-size: 13px;
      font-weight: 800;
    }
    .legend .swatch {
      width: 14px;
      height: 14px;
      border-radius: 4px;
      border: 1px solid rgba(0,0,0,0.15);
      flex: 0 0 14px;
    }
    .legend .sub {
      margin-top: 7px;
      font-size: 11px;
      opacity: 0.85;
      line-height: 1.25;
      font-weight: 700;
    }

    /* Bottom slider bar (compact) */
    .sliderWrap {
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 10px;
      z-index: 1000;
      background: rgba(255,255,255,0.92);
      border-radius: 14px;
      box-shadow: 0 6px 18px rgba(0,0,0,0.15);
      padding: 8px 10px 10px 10px;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
    }
    .timeRow{
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:10px;
      margin: 0 0 6px 0;
    }
    .timeLabel {
      font-size: 18px;
      font-weight: 950;
      margin: 0;
      line-height: 1.1;
    }
    input[type="range"] {
      width: 100%;
      height: 22px;
      margin: 0;
    }

    /* Auto-center button INSIDE slider box, small */
    .autoCenterBtnInline{
      border: none;
      border-radius: 999px;
      padding: 7px 10px;
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial;
      font-weight: 950;
      font-size: 12px;
      cursor: pointer;
      background: rgba(255,255,255,0.96);
      box-shadow: 0 4px 12px rgba(0,0,0,0.14);
      white-space: nowrap;
      flex: 0 0 auto;
    }
    .autoCenterBtnInline:active { transform: scale(0.98); }
    .autoCenterBtnInline.on { outline: 2px solid rgba(0,160,255,0.35); }

    /* Zone labels */
    .zone-label {
      background: transparent;
      border: none;
      box-shadow: none;
      color: #111;
      text-align: center;
      pointer-events: none;
    }
    .zone-label .zn,
    .zone-label .br {
      display: inline-block;
      background: rgba(255,255,255,0.86);
      border: 1px solid rgba(0,0,0,0.18);
      border-radius: 999px;
      padding: 2px 8px;
      margin: 1px 0;
      white-space: nowrap;
      max-width: 210px;
      overflow: hidden;
      text-overflow: ellipsis;
      box-shadow: 0 2px 6px rgba(0,0,0,0.08);
    }
    .zone-label .zn { font-weight: 950; letter-spacing: 0.1px; }
    .zone-label .br { font-weight: 900; opacity: 0.7; padding: 1px 6px; border-radius: 10px; }

    .zone-label.z10 .zn { font-size: 10px; }
    .zone-label.z11 .zn { font-size: 11px; }
    .zone-label.z12 .zn { font-size: 12px; }
    .zone-label.z13 .zn { font-size: 13px; }
    .zone-label.z14 .zn { font-size: 14px; }
    .zone-label.z15 .zn { font-size: 15px; }

    .zone-label.z10 .br,
    .zone-label.z11 .br,
    .zone-label.z12 .br,
    .zone-label.z13 .br,
    .zone-label.z14 .br { font-size: 0px; padding: 0; border: 0; }
    .zone-label.z15 .br { font-size: 4px; }

    @media (max-width: 420px) {
      .legend { max-width: 220px; }
      .legend .row { font-size: 12px; }
      .legend .sub { font-size: 10px; }
      .timeLabel { font-size: 16px; }
      .autoCenterBtnInline{ font-size: 11px; padding: 7px 9px; }
      .zone-label .zn, .zone-label .br { max-width: 170px; }
    }

    /* Live location arrow marker */
    .navArrowWrap{
      width: 30px;
      height: 30px;
      position: relative;
      transform-origin: 50% 50%;
      will-change: transform, filter;
    }
    .navArrow{
      position: absolute;
      left: 50%;
      top: 50%;
      width: 0;
      height: 0;
      transform: translate(-50%, -55%);
      border-left: 9px solid transparent;
      border-right: 9px solid transparent;
      border-bottom: 18px solid #111;
      filter: drop-shadow(0 2px 2px rgba(0,0,0,0.35));
    }
    .navMoving .navArrow{
      filter:
        drop-shadow(0 2px 2px rgba(0,0,0,0.35))
        drop-shadow(0 0 6px rgba(0,160,255,0.95))
        drop-shadow(0 0 12px rgba(0,160,255,0.75));
    }
    @keyframes pulseRing {
      0%   { transform: translate(-50%, -50%) scale(0.8); opacity: 0.75; }
      70%  { transform: translate(-50%, -50%) scale(1.25); opacity: 0.05; }
      100% { transform: translate(-50%, -50%) scale(1.25); opacity: 0.0; }
    }
    .navPulse::after{
      content:"";
      position:absolute;
      left:50%;
      top:50%;
      width: 26px;
      height: 26px;
      border-radius: 999px;
      border: 2px solid rgba(0,160,255,0.9);
      transform: translate(-50%, -50%);
      animation: pulseRing 1.5s ease-out infinite;
      pointer-events:none;
    }
  </style>
</head>

<body>
  <div id="map"></div>

  <div id="legend" class="legend" aria-label="Demand legend">
    <div class="legendHeader">
      <h3>Demand Colors</h3>
      <button id="legendToggle" class="legendToggleBtn" type="button">–</button>
    </div>

    <div class="legendBody">
      <div id="recommendLine" class="recommendLine">Recommended: …</div>

      <div class="row"><span class="swatch" style="background:#00b050"></span> Green = Highest</div>
      <div class="row"><span class="swatch" style="background:#8000ff"></span> Purple = High</div>
      <div class="row"><span class="swatch" style="background:#0066ff"></span> Blue = Medium</div>
      <div class="row"><span class="swatch" style="background:#66ccff"></span> Sky = Normal</div>
      <div class="row"><span class="swatch" style="background:#ffd400"></span> Yellow = Below Normal</div>
      <div class="row"><span class="swatch" style="background:#e60000"></span> Red = Very Low / Avoid</div>

      <div class="sub">
        Colors come from rating (1–100) for the selected 20-minute window.<br/>
        Time label is NYC time.
      </div>
    </div>
  </div>

  <div class="sliderWrap">
    <div class="timeRow">
      <div id="timeLabel" class="timeLabel">Loading…</div>
      <button id="btnCenter" class="autoCenterBtnInline on" type="button">Auto-center: ON</button>
    </div>
    <input id="slider" type="range" min="0" max="0" value="0" step="1" />
  </div>

  <script src="./app.js"></script>
</body>
</html>