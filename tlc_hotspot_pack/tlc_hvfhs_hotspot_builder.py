#!/usr/bin/env python3
"""
TLC HVFHV Hotspot Builder (20-min slider ready)
- Builds a Folium map with:
  1) Static GOOD/BAD markers (overall selection)
  2) Time-slider polygons (top/bottom zones per time window to keep HTML small)
- Supports true minute-level binning (e.g., 20 minutes)
- Rating scale is 1–100 (not 1–10)
- Slider label uses AM/PM format

Output:
- outputs/hotspots_timeslider_zones.html
"""

from __future__ import annotations

import argparse
import zipfile
from pathlib import Path
from typing import List, Tuple
from datetime import datetime, timedelta

import duckdb
import pandas as pd
import geopandas as gpd
import folium
from folium.plugins import TimestampedGeoJson
import requests


TAXI_ZONES_ZIP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip"
TAXI_ZONE_LOOKUP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv"


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def download_to(url: str, out_path: Path) -> None:
    ensure_dir(out_path.parent)
    if out_path.exists() and out_path.stat().st_size > 0:
        return
    print(f"Downloading {url} -> {out_path}")
    r = requests.get(url, timeout=60)
    r.raise_for_status()
    out_path.write_bytes(r.content)


def fetch_taxi_zones(meta_dir: Path) -> Tuple[gpd.GeoDataFrame, pd.DataFrame]:
    zip_path = meta_dir / "taxi_zones.zip"
    lookup_path = meta_dir / "taxi_zone_lookup.csv"

    download_to(TAXI_ZONES_ZIP_URL, zip_path)
    download_to(TAXI_ZONE_LOOKUP_URL, lookup_path)

    lookup_df = pd.read_csv(lookup_path)
    if "LocationID" not in lookup_df.columns:
        raise ValueError("taxi_zone_lookup.csv missing LocationID")

    extract_dir = meta_dir / "taxi_zones_extracted"
    if not extract_dir.exists():
        ensure_dir(extract_dir)
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(extract_dir)

    shp_files = list(extract_dir.rglob("*.shp"))
    if not shp_files:
        raise ValueError("Could not find .shp in taxi_zones_extracted")

    zones_gdf = gpd.read_file(shp_files[0])

    # Ensure LocationID exists
    if "LocationID" not in zones_gdf.columns:
        cols_lower = {c.lower(): c for c in zones_gdf.columns}
        if "locationid" in cols_lower:
            zones_gdf = zones_gdf.rename(columns={cols_lower["locationid"]: "LocationID"})
        else:
            raise ValueError(f"Taxi zones shapefile missing LocationID. Columns: {list(zones_gdf.columns)}")

    # Ensure CRS
    if zones_gdf.crs is None:
        zones_gdf = zones_gdf.set_crs("EPSG:4326", allow_override=True)
    zones_gdf = zones_gdf.to_crs(epsg=4326)

    return zones_gdf, lookup_df


def month_files(data_dir: Path, months: List[str]) -> List[Path]:
    files = []
    for m in months:
        f = data_dir / f"fhvhv_tripdata_{m}.parquet"
        if not f.exists():
            raise FileNotFoundError(f"Missing parquet: {f}")
        files.append(f)
    return files


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def score_to_color_hex(score01: float) -> str:
    """Red -> Yellow -> Green gradient based on score in [0,1]."""
    s = max(0.0, min(1.0, float(score01)))
    if s <= 0.5:
        t = s / 0.5
        r = int(lerp(230, 255, t))
        g = int(lerp(0, 215, t))
        b = 0
    else:
        t = (s - 0.5) / 0.5
        r = int(lerp(255, 0, t))
        g = int(lerp(215, 176, t))
        b = int(lerp(0, 80, t))
    return f"#{r:02x}{g:02x}{b:02x}"


def score_to_rating_1_100(score01: float) -> int:
    """Maps score in [0,1] to integer rating [1,100]."""
    s = max(0.0, min(1.0, float(score01)))
    return int(round(1 + 99 * s))


def safe_float(x):
    try:
        if pd.isna(x):
            return None
        return float(x)
    except Exception:
        return None


def build_metrics(files: List[Path]) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """
    Returns:
      df_total: per-zone totals (pickups_total, avg_driver_pay_all, avg_tips_all)
      df_win_raw: per-zone per-(dow,hour,minute) aggregates
    """
    con = duckdb.connect(database=":memory:")
    parquet_list = [str(f) for f in files]
    parquet_sql = ", ".join("'" + p.replace("'", "''") + "'" for p in parquet_list)

    sql_total = f"""
    WITH base AS (
      SELECT
        CAST(PULocationID AS INTEGER) AS PULocationID,
        pickup_datetime,
        TRY_CAST(driver_pay AS DOUBLE) AS driver_pay,
        TRY_CAST(tips AS DOUBLE) AS tips
      FROM read_parquet([{parquet_sql}])
      WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
    )
    SELECT
      PULocationID,
      COUNT(*) AS pickups_total,
      AVG(driver_pay) AS avg_driver_pay_all,
      AVG(tips) AS avg_tips_all
    FROM base
    GROUP BY 1;
    """

    # Include minute so we can truly bin by 20 minutes
    sql_win = f"""
    WITH base AS (
      SELECT
        CAST(PULocationID AS INTEGER) AS PULocationID,
        pickup_datetime,
        TRY_CAST(driver_pay AS DOUBLE) AS driver_pay,
        TRY_CAST(base_passenger_fare AS DOUBLE) AS base_passenger_fare,
        TRY_CAST(tips AS DOUBLE) AS tips,
        TRY_CAST(trip_miles AS DOUBLE) AS trip_miles,
        TRY_CAST(trip_time AS DOUBLE) AS trip_time
      FROM read_parquet([{parquet_sql}])
      WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
    )
    SELECT
      PULocationID,
      EXTRACT('dow' FROM pickup_datetime) AS dow_i,   -- 0=Sun..6=Sat
      EXTRACT('hour' FROM pickup_datetime) AS hour,
      EXTRACT('minute' FROM pickup_datetime) AS minute,
      COUNT(*) AS pickups,
      AVG(trip_miles) AS avg_trip_miles,
      AVG(trip_time)/60.0 AS avg_trip_minutes,
      AVG(driver_pay) AS avg_driver_pay,
      AVG(base_passenger_fare) AS avg_base_fare,
      AVG(tips) AS avg_tips
    FROM base
    GROUP BY 1,2,3,4;
    """

    df_total = con.execute(sql_total).df()
    df_win_raw = con.execute(sql_win).df()

    df_win_raw["dow_i"] = df_win_raw["dow_i"].astype(int)
    # Convert to Monday=0 .. Sunday=6
    df_win_raw["dow_m"] = df_win_raw["dow_i"].apply(lambda d: 6 if d == 0 else d - 1)
    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    df_win_raw["dow"] = df_win_raw["dow_m"].apply(lambda i: dow_names[int(i)])

    df_win_raw["hour"] = df_win_raw["hour"].astype(int)
    df_win_raw["minute"] = df_win_raw["minute"].astype(int)

    return df_total, df_win_raw


def add_window_scores(df_win: pd.DataFrame) -> pd.DataFrame:
    """
    Scores within each time window (dow_m + minute_of_day):
      score01 = 0.60*vol + 0.30*pay + 0.10*tips
    """
    df = df_win.copy()

    def minmax(s: pd.Series) -> pd.Series:
        s2 = pd.to_numeric(s, errors="coerce")
        mn = s2.min(skipna=True)
        mx = s2.max(skipna=True)
        if pd.isna(mn) or pd.isna(mx) or mx == mn:
            return pd.Series([0.0] * len(s2), index=s2.index)
        return (s2 - mn) / (mx - mn)

    key = ["dow_m", "minute_of_day"]
    df["vol_n"] = df.groupby(key)["pickups"].transform(minmax)
    df["pay_n"] = df.groupby(key)["avg_driver_pay"].transform(minmax)
    df["tip_n"] = df.groupby(key)["avg_tips"].transform(minmax)

    df["score01"] = (0.60 * df["vol_n"]) + (0.30 * df["pay_n"]) + (0.10 * df["tip_n"])
    df["rating_1_100"] = df["score01"].apply(score_to_rating_1_100)
    df["color_hex"] = df["score01"].apply(score_to_color_hex)
    return df


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--data_dir", type=str, default="data")
    p.add_argument("--months", nargs="+", required=True)

    # marker selection (overall)
    p.add_argument("--good_n", type=int, default=200)
    p.add_argument("--bad_n", type=int, default=120)

    # polygon selection per window (keeps HTML small)
    p.add_argument("--win_good_n", type=int, default=80)
    p.add_argument("--win_bad_n", type=int, default=40)

    p.add_argument("--min_trips_per_window", type=int, default=10)

    # If bin_minutes is set, it overrides hour_bin.
    # Default is 20 minutes (what you asked for).
    p.add_argument("--bin_minutes", type=int, default=20, help="time bin in minutes (overrides hour_bin)")
    p.add_argument("--hour_bin", type=int, default=2, help="legacy hour bin (used only if --bin_minutes is None)")

    # simplify polygons in meters (0 disables)
    p.add_argument("--simplify_meters", type=float, default=25.0)

    p.add_argument("--out_dir", type=str, default="outputs")
    return p.parse_args()


def main() -> int:
    args = parse_args()

    data_dir = Path(args.data_dir).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    meta_dir = out_dir / "meta"
    ensure_dir(out_dir)
    ensure_dir(meta_dir)

    files = month_files(data_dir, args.months)
    df_total, df_win_raw = build_metrics(files)

    # Select overall GOOD + BAD zones (markers) by total pickup volume
    df_total = df_total.sort_values("pickups_total", ascending=False).copy()
    good_ids = df_total.head(int(args.good_n))["PULocationID"].astype(int).tolist()
    bad_pool = df_total[~df_total["PULocationID"].astype(int).isin(set(good_ids))].copy()
    bad_ids = bad_pool.sort_values("pickups_total", ascending=True).head(int(args.bad_n))["PULocationID"].astype(int).tolist()
    shown_ids = sorted(set(good_ids + bad_ids))
    good_set = set(good_ids)
    bad_set = set(bad_ids)

    # Compute time bin (minutes)
    if args.bin_minutes is not None:
        bin_minutes = max(1, int(args.bin_minutes))
    else:
        hour_bin = max(1, int(args.hour_bin))
        bin_minutes = hour_bin * 60

    # Bin minute into buckets
    dfw = df_win_raw.copy()
    dfw["minute_bin"] = (dfw["minute"] // bin_minutes) * bin_minutes
    dfw["minute_of_day"] = (dfw["hour"] * 60) + dfw["minute_bin"]

    # Re-aggregate at the requested bin size
    # (We already grouped at exact minute in SQL; now we roll up into bin)
    dfw = (
        dfw.groupby(["PULocationID", "dow_m", "dow", "minute_of_day"], as_index=False)
        .agg(
            pickups=("pickups", "sum"),
            avg_trip_miles=("avg_trip_miles", "mean"),
            avg_trip_minutes=("avg_trip_minutes", "mean"),
            avg_driver_pay=("avg_driver_pay", "mean"),
            avg_base_fare=("avg_base_fare", "mean"),
            avg_tips=("avg_tips", "mean"),
        )
    )

    # Filter low-signal windows
    dfw = dfw[dfw["pickups"] >= int(args.min_trips_per_window)].copy()

    # Score
    dfw_scored = add_window_scores(dfw)
    dfw_scored = dfw_scored[dfw_scored["PULocationID"].astype(int).isin(shown_ids)].copy()

    # Per-window TOP/BOTTOM selection (critical optimization)
    win_good_n = int(args.win_good_n)
    win_bad_n = int(args.win_bad_n)

    dfw_scored["rank_good"] = dfw_scored.groupby(["dow_m", "minute_of_day"])["score01"].rank(method="first", ascending=False)
    dfw_scored["rank_bad"] = dfw_scored.groupby(["dow_m", "minute_of_day"])["score01"].rank(method="first", ascending=True)
    df_poly = dfw_scored[(dfw_scored["rank_good"] <= win_good_n) | (dfw_scored["rank_bad"] <= win_bad_n)].copy()

    # Overall stats for marker popup
    df_overall = (
        dfw_scored.groupby("PULocationID", as_index=False)
        .agg(
            score01_mean=("score01", "mean"),
            pickups_window_sum=("pickups", "sum"),
            avg_driver_pay_mean=("avg_driver_pay", "mean"),
            avg_tips_mean=("avg_tips", "mean"),
        )
    )
    df_overall["rating_overall_1_100"] = df_overall["score01_mean"].apply(score_to_rating_1_100)
    df_overall["color_overall"] = df_overall["score01_mean"].apply(score_to_color_hex)
    overall_by_id = df_overall.set_index("PULocationID").to_dict(orient="index")

    # Geo data
    zones_gdf, lookup_df = fetch_taxi_zones(meta_dir)
    lookup_df = lookup_df.copy()
    lookup_df["LocationID"] = lookup_df["LocationID"].astype(int)
    lookup_df = lookup_df.set_index("LocationID")

    zones_gdf = zones_gdf[zones_gdf["LocationID"].astype(int).isin(shown_ids)].copy()
    zones_gdf["LocationID"] = zones_gdf["LocationID"].astype(int)

    # Simplify polygons for size reduction (meters)
    if float(args.simplify_meters) > 0:
        tol = float(args.simplify_meters)
        z3857 = zones_gdf.to_crs(epsg=3857)
        z3857["geometry"] = z3857.geometry.simplify(tolerance=tol, preserve_topology=True)
        zones_gdf = z3857.to_crs(epsg=4326)

    # Centroids (projected)
    zones_proj = zones_gdf.to_crs(epsg=3857)
    zones_proj["centroid"] = zones_proj.geometry.centroid
    centroids = gpd.GeoDataFrame(
        zones_proj[["LocationID"]],
        geometry=zones_proj["centroid"],
        crs="EPSG:3857"
    ).to_crs(epsg=4326)
    centroid_by_id = centroids.set_index("LocationID").geometry

    def zone_label(zid: int) -> Tuple[str, str]:
        zone_name = f"LocationID {zid}"
        borough = "Unknown"
        if zid in lookup_df.index:
            row = lookup_df.loc[zid]
            borough = str(row.get("Borough", "Unknown"))
            zone_name = str(row.get("Zone", zone_name))
        return zone_name, borough

    # Map
    m = folium.Map(location=[40.72, -73.98], zoom_start=12, tiles="CartoDB positron")

    # Legend (1–100, 20-min bins)
    legend_html = f"""
    <div style="
      position: fixed; top: 18px; left: 18px; width: 440px; z-index: 9999;
      background: rgba(255,255,255,0.97); padding: 12px;
      border: 2px solid #111; border-radius: 10px;
      font-family: Arial; font-size: 14px; box-shadow: 0 2px 10px rgba(0,0,0,0.25);
    ">
      <div style="font-weight:900; margin-bottom:8px; font-size:15px;">
        NYC HVFHV Pickup Zones (Dynamic Ratings)
      </div>

      <div style="display:flex; align-items:center; gap:10px; margin-bottom:8px;">
        <div style="height:12px; width:210px; border:1px solid #333;
          background: linear-gradient(90deg, #e60000, #ffd700, #00b050);"></div>
        <div style="display:flex; justify-content:space-between; width:160px;">
          <span>1</span><span>50</span><span>100</span>
        </div>
      </div>

      <div style="display:flex; gap:14px; align-items:center; margin-bottom:6px;">
        <div><span style="color:#00b050; font-weight:900;">✔</span> GOOD marker (overall)</div>
        <div><span style="color:#e60000; font-weight:900;">✖</span> BAD marker (overall)</div>
      </div>

      <div style="margin-top:8px; color:#444; font-size:12px; line-height:1.35;">
        • Polygons show only TOP {win_good_n} + BOTTOM {win_bad_n} zones per window (fast).<br/>
        • Window size: {bin_minutes} minutes. Use slider at bottom.<br/>
        • Click marker = highlight zone outline. Click polygon = window stats.
      </div>
    </div>
    """
    m.get_root().html.add_child(folium.Element(legend_html))

    # Zone outlines (click-highlight)
    outlines = folium.GeoJson(
        zones_gdf[["LocationID", "geometry"]].to_json(),
        name="Zone outlines",
        style_function=lambda _f: {"color": "#555555", "weight": 1, "fillOpacity": 0.0},
    )
    outlines.add_to(m)
    outlines_js_name = outlines.get_name()

    fg_good = folium.FeatureGroup(name="GOOD markers (✔)", show=True)
    fg_bad = folium.FeatureGroup(name="BAD markers (✖)", show=True)
    m.add_child(fg_good)
    m.add_child(fg_bad)

    js_marker_hooks = []

    def fmt(x, nd=2):
        return "n/a" if x is None else f"{x:.{nd}f}"

    # Static markers (overall)
    for zid in shown_ids:
        if zid not in centroid_by_id.index:
            continue
        pt = centroid_by_id.loc[zid]
        if pt is None or pt.is_empty:
            continue

        zone_name, borough = zone_label(zid)
        tag = "GOOD" if zid in good_set else "BAD"

        ov = overall_by_id.get(zid, {})
        rating_overall = int(ov.get("rating_overall_1_100", 1))
        color_overall = str(ov.get("color_overall", "#e60000"))
        trips_sum = int(ov.get("pickups_window_sum", 0))
        pay_mean = safe_float(ov.get("avg_driver_pay_mean"))
        tips_mean = safe_float(ov.get("avg_tips_mean"))

        popup = f"""
        <div style="font-family: Arial; font-size: 13px;">
          <div style="font-weight:900; font-size:14px;">{zone_name}</div>
          <div style="color:#666; margin-bottom:4px;">{borough} — <b>{tag}</b></div>
          <div><b>Overall rating:</b> <span style="font-weight:900; color:{color_overall};">{rating_overall}/100</span></div>
          <hr style="margin:6px 0;">
          <div><b>Pickups (sum of windows):</b> {trips_sum}</div>
          <div><b>Avg driver pay:</b> ${fmt(pay_mean,2)}</div>
          <div><b>Avg tips:</b> ${fmt(tips_mean,2)}</div>
        </div>
        """

        if tag == "GOOD":
            icon = folium.Icon(color="green", icon="ok", prefix="glyphicon")
            layer = fg_good
        else:
            icon = folium.Icon(color="red", icon="remove", prefix="glyphicon")
            layer = fg_bad

        marker = folium.Marker(
            location=[pt.y, pt.x],
            popup=folium.Popup(popup, max_width=360),
            tooltip=f"{tag}: {zone_name} ({borough})",
            icon=icon,
        )
        marker.add_to(layer)

        mk_js_name = marker.get_name()
        js_marker_hooks.append(
            f"""
            {mk_js_name}.on('click', function(e) {{
              var outlines = {outlines_js_name};
              outlines.eachLayer(function(l) {{
                l.setStyle({{color:'#555555', weight:1}});
              }});
              outlines.eachLayer(function(l) {{
                if (l.feature && l.feature.properties && (l.feature.properties.LocationID == {zid})) {{
                  l.setStyle({{color:'#000000', weight:6}});
                  try {{ l.bringToFront(); }} catch(e) {{}}
                }}
              }});
            }});
            """
        )

    m.get_root().html.add_child(folium.Element("<script>\n" + "\n".join(js_marker_hooks) + "\n</script>"))
    folium.LayerControl(collapsed=False).add_to(m)

    # Time slider polygons
    week_start = datetime(2025, 1, 6, 0, 0, 0)  # Monday
    zones_by_id = zones_gdf.set_index("LocationID")

    features = []
    for _, r in df_poly.iterrows():
        zid = int(r["PULocationID"])
        if zid not in zones_by_id.index:
            continue

        geom = zones_by_id.loc[zid].geometry
        if geom is None or geom.is_empty:
            continue

        dow_m = int(r["dow_m"])
        mod = int(r["minute_of_day"])
        ts = week_start + timedelta(days=dow_m, minutes=mod)
        ts_iso = ts.strftime("%Y-%m-%dT%H:%M:%S")

        zone_name, borough = zone_label(zid)
        rating = int(r.get("rating_1_100", 1))
        color = str(r.get("color_hex", "#e60000"))
        pickups = int(r.get("pickups", 0))

        tag = "GOOD" if zid in good_set else "BAD"
        border = "#00b050" if tag == "GOOD" else "#e60000"
        dash = None if tag == "GOOD" else "6, 6"

        miles = safe_float(r.get("avg_trip_miles"))
        mins = safe_float(r.get("avg_trip_minutes"))
        pay = safe_float(r.get("avg_driver_pay"))
        fare = safe_float(r.get("avg_base_fare"))
        tips = safe_float(r.get("avg_tips"))

        # Build a readable window label (AM/PM)
        # e.g., "Mon 7:40 PM"
        window_label = ts.strftime("%a %-I:%M %p") if hasattr(ts, "strftime") else f"{r.get('dow','?')}"

        popup_html = f"""
        <div style="font-family: Arial; font-size: 13px;">
          <div style="font-weight:900; font-size:14px;">{zone_name}</div>
          <div style="color:#666; margin-bottom:4px;">{borough} — <b>{tag}</b></div>
          <div><b>Window:</b> {window_label} (bin {bin_minutes}m)</div>
          <div><b>Rating (this window):</b> <span style="font-weight:900; color:{color};">{rating}/100</span></div>
          <hr style="margin:6px 0;">
          <div><b>Pickups:</b> {pickups}</div>
          <div><b>Avg trip:</b> {fmt(miles,2)} mi, {fmt(mins,1)} min</div>
          <div><b>Avg driver pay:</b> ${fmt(pay,2)}</div>
          <div><b>Avg base fare:</b> ${fmt(fare,2)}</div>
          <div><b>Avg tips:</b> ${fmt(tips,2)}</div>
        </div>
        """

        features.append({
            "type": "Feature",
            "geometry": geom.__geo_interface__,
            "properties": {
                "time": ts_iso,
                "popup": popup_html,
                "style": {
                    "color": border,
                    "weight": 2,
                    "dashArray": dash,
                    "fillColor": color,
                    "fillOpacity": 0.55,
                },
            },
        })

    geojson = {"type": "FeatureCollection", "features": features}

    period = f"PT{bin_minutes}M"

    TimestampedGeoJson(
        data=geojson,
        transition_time=180,
        period=period,
        add_last_point=False,
        auto_play=False,
        loop=False,
        max_speed=3,
        loop_button=True,
        # Moment.js format for Leaflet.TimeDimension control:
        # 12-hour time with AM/PM:
        date_options="ddd h:mm A",
        time_slider_drag_update=True,
        duration=period,
    ).add_to(m)

    out_path = out_dir / "hotspots_timeslider_zones.html"
    m.save(str(out_path))
    print(f"Wrote {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())