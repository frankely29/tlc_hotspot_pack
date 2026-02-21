from __future__ import annotations

import json
import zipfile
from pathlib import Path
from typing import List, Tuple
from datetime import datetime, timedelta

import duckdb
import pandas as pd
import geopandas as gpd
import requests


TAXI_ZONES_ZIP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip"
TAXI_ZONE_LOOKUP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv"


def ensure_dir(p: Path) -> None:
    p.mkdir(parents=True, exist_ok=True)


def download_to(url: str, out_path: Path) -> None:
    ensure_dir(out_path.parent)
    if out_path.exists() and out_path.stat().st_size > 0:
        return
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

    if "LocationID" not in zones_gdf.columns:
        cols_lower = {c.lower(): c for c in zones_gdf.columns}
        if "locationid" in cols_lower:
            zones_gdf = zones_gdf.rename(columns={cols_lower["locationid"]: "LocationID"})
        else:
            raise ValueError(f"Taxi zones shapefile missing LocationID. Columns: {list(zones_gdf.columns)}")

    if zones_gdf.crs is None:
        zones_gdf = zones_gdf.set_crs("EPSG:4326", allow_override=True)

    zones_gdf = zones_gdf.to_crs(epsg=4326)
    return zones_gdf, lookup_df


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def score_to_color_hex(score01: float) -> str:
    s = max(0.0, min(1.0, float(score01)))
    # red -> yellow -> green
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
    s = max(0.0, min(1.0, float(score01)))
    return int(round(1 + 99 * s))


def build_metrics(parquet_files: List[Path], bin_minutes: int) -> Tuple[pd.DataFrame, pd.DataFrame]:
    con = duckdb.connect(database=":memory:")
    parquet_list = [str(p) for p in parquet_files]
    parquet_sql = ", ".join("'" + p.replace("'", "''") + "'" for p in parquet_list)

    sql_total = f"""
    WITH base AS (
      SELECT
        CAST(PULocationID AS INTEGER) AS PULocationID,
        pickup_datetime
      FROM read_parquet([{parquet_sql}])
      WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
    )
    SELECT
      PULocationID,
      COUNT(*) AS pickups_total
    FROM base
    GROUP BY 1;
    """

    sql_win = f"""
    WITH base AS (
      SELECT
        CAST(PULocationID AS INTEGER) AS PULocationID,
        pickup_datetime,
        TRY_CAST(driver_pay AS DOUBLE) AS driver_pay,
        TRY_CAST(tips AS DOUBLE) AS tips
      FROM read_parquet([{parquet_sql}])
      WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
    ),
    t AS (
      SELECT
        PULocationID,
        EXTRACT('dow' FROM pickup_datetime) AS dow_i,  -- 0=Sun..6=Sat
        EXTRACT('hour' FROM pickup_datetime) AS hour_i,
        EXTRACT('minute' FROM pickup_datetime) AS minute_i,
        driver_pay,
        tips
      FROM base
    ),
    binned AS (
      SELECT
        PULocationID,
        dow_i,
        CAST(FLOOR((hour_i*60 + minute_i) / {int(bin_minutes)}) * {int(bin_minutes)} AS INTEGER) AS bin_start_min,
        driver_pay,
        tips
      FROM t
    )
    SELECT
      PULocationID,
      dow_i,
      bin_start_min,
      COUNT(*) AS pickups,
      AVG(driver_pay) AS avg_driver_pay,
      AVG(tips) AS avg_tips
    FROM binned
    GROUP BY 1,2,3;
    """

    df_total = con.execute(sql_total).df()
    df_win = con.execute(sql_win).df()

    # Normalize DOW: Monday=0..Sunday=6
    df_win["dow_i"] = df_win["dow_i"].astype(int)
    df_win["dow_m"] = df_win["dow_i"].apply(lambda d: 6 if d == 0 else d - 1)
    dow_names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    df_win["dow"] = df_win["dow_m"].apply(lambda i: dow_names[int(i)])

    df_win["bin_start_min"] = df_win["bin_start_min"].astype(int)
    return df_total, df_win


def add_window_scores(df_win: pd.DataFrame) -> pd.DataFrame:
    df = df_win.copy()

    def minmax(s: pd.Series) -> pd.Series:
        s2 = pd.to_numeric(s, errors="coerce")
        mn = s2.min(skipna=True)
        mx = s2.max(skipna=True)
        if pd.isna(mn) or pd.isna(mx) or mx == mn:
            return pd.Series([0.0] * len(s2), index=s2.index)
        return (s2 - mn) / (mx - mn)

    # Compare within same dow + time-bin across zones
    df["vol_n"] = df.groupby(["dow_m", "bin_start_min"])["pickups"].transform(minmax)
    df["pay_n"] = df.groupby(["dow_m", "bin_start_min"])["avg_driver_pay"].transform(minmax)
    df["tip_n"] = df.groupby(["dow_m", "bin_start_min"])["avg_tips"].transform(minmax)

    df["score01"] = (0.60 * df["vol_n"]) + (0.30 * df["pay_n"]) + (0.10 * df["tip_n"])
    df["rating"] = df["score01"].apply(score_to_rating_1_100)
    df["fillColor"] = df["score01"].apply(score_to_color_hex)
    return df


def build_hotspots_json(
    parquet_files: List[Path],
    out_path: Path,
    bin_minutes: int = 20,
    good_n: int = 200,
    bad_n: int = 120,
    win_good_n: int = 80,
    win_bad_n: int = 40,
    min_trips_per_window: int = 10,
    simplify_meters: float = 25.0,
) -> None:
    out_path = Path(out_path)
    ensure_dir(out_path.parent)

    meta_dir = out_path.parent / "meta"
    ensure_dir(meta_dir)

    zones_gdf, lookup_df = fetch_taxi_zones(meta_dir)
    lookup_df = lookup_df.copy()
    lookup_df["LocationID"] = lookup_df["LocationID"].astype(int)
    lookup_df = lookup_df.set_index("LocationID")

    df_total, df_win = build_metrics(parquet_files, bin_minutes=bin_minutes)

    # Keep only official TLC taxi zones to avoid out-of-range IDs skewing scores.
    # Some parquet batches can contain synthetic/unknown location IDs (e.g. 264/265),
    # which are not present in the zone geometry and can force most real zones toward
    # low min-max values (appearing overly red).
    valid_zone_ids = set(zones_gdf["LocationID"].astype(int).tolist())
    df_total = df_total[df_total["PULocationID"].astype(int).isin(valid_zone_ids)].copy()
    df_win = df_win[df_win["PULocationID"].astype(int).isin(valid_zone_ids)].copy()

    # overall good/bad selection pool by total pickups
    df_total = df_total.sort_values("pickups_total", ascending=False).copy()
    good_ids = df_total.head(int(good_n))["PULocationID"].astype(int).tolist()

    bad_pool = df_total[~df_total["PULocationID"].astype(int).isin(set(good_ids))].copy()
    bad_ids = bad_pool.sort_values("pickups_total", ascending=True).head(int(bad_n))["PULocationID"].astype(int).tolist()

    shown_ids = sorted(set(good_ids + bad_ids))
    good_set = set(good_ids)
    bad_set = set(bad_ids)

    # keep only zones we show
    zones_gdf = zones_gdf[zones_gdf["LocationID"].astype(int).isin(shown_ids)].copy()
    zones_gdf["LocationID"] = zones_gdf["LocationID"].astype(int)

    # simplify polygons
    if float(simplify_meters) > 0:
        tol = float(simplify_meters)
        z3857 = zones_gdf.to_crs(epsg=3857)
        z3857["geometry"] = z3857.geometry.simplify(tolerance=tol, preserve_topology=True)
        zones_gdf = z3857.to_crs(epsg=4326)

    # centroids for markers
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

    # filter low-signal windows
    df_win = df_win[df_win["pickups"] >= int(min_trips_per_window)].copy()

    df_scored = add_window_scores(df_win)
    df_scored = df_scored[df_scored["PULocationID"].astype(int).isin(shown_ids)].copy()

    # per-window select top/bottom zones for polygons (keeps JSON smaller)
    df_scored["rank_good"] = df_scored.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=False)
    df_scored["rank_bad"] = df_scored.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=True)
    df_poly = df_scored[(df_scored["rank_good"] <= int(win_good_n)) | (df_scored["rank_bad"] <= int(win_bad_n))].copy()

    zones_by_id = zones_gdf.set_index("LocationID")

    # build timeline frames
    week_start = datetime(2025, 1, 6, 0, 0, 0)  # Monday
    frames = []
    timeline = []

    # group by time window
    for (dow_m, bin_start_min), g in df_poly.groupby(["dow_m", "bin_start_min"]):
        dow_m = int(dow_m)
        bin_start_min = int(bin_start_min)
        hour = bin_start_min // 60
        minute = bin_start_min % 60

        ts = week_start + timedelta(days=dow_m, hours=hour, minutes=minute)
        ts_iso = ts.strftime("%Y-%m-%dT%H:%M:%S")

        features = []
        markers = []

        # polygons
        for _, r in g.iterrows():
            zid = int(r["PULocationID"])
            if zid not in zones_by_id.index:
                continue
            geom = zones_by_id.loc[zid].geometry
            if geom is None or geom.is_empty:
                continue

            zone_name, borough = zone_label(zid)

            pickups = int(r["pickups"])
            rating = int(r["rating"])
            fill = str(r["fillColor"])

            # IMPORTANT: tag is ONLY for icons, not for polygon color
            # Polygon color ALWAYS = rating gradient.
            tag = "TOP" if float(r["rank_good"]) <= int(win_good_n) else "BOTTOM"
            border = "#00b050" if tag == "TOP" else "#e60000"
            dash = None if tag == "TOP" else "6,6"

            popup = (
                f"<div style='font-family:Arial; font-size:13px;'>"
                f"<div style='font-weight:900; font-size:14px;'>{zone_name}</div>"
                f"<div style='color:#666; margin-bottom:4px;'>{borough} — <b>{tag}</b></div>"
                f"<div><b>Window:</b> {r['dow']} {hour:02d}:{minute:02d} ({bin_minutes}m)</div>"
                f"<div><b>Rating:</b> <span style='font-weight:900; color:{fill};'>{rating}/100</span></div>"
                f"<hr style='margin:6px 0;'>"
                f"<div><b>Pickups:</b> {pickups}</div>"
                f"</div>"
            )

            features.append({
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {
                    # ✅ REAL numeric fields (frontend can trust these)
                    "time": ts_iso,
                    "LocationID": zid,
                    "zone": zone_name,
                    "borough": borough,
                    "tag": tag,             # TOP or BOTTOM (extremes only)
                    "pickups": pickups,     # numeric
                    "rating": rating,       # numeric 1-100
                    "popup": popup,
                    "style": {
                        "color": border,
                        "weight": 2,
                        "dashArray": dash,
                        "fillColor": fill,    # gradient color already computed
                        "fillOpacity": 0.55,
                    },
                },
            })

            # markers = ONLY extremes (TOP/BOTTOM)
            pt = centroid_by_id.get(zid)
            if pt is not None and (not pt.is_empty):
                markers.append({
                    "lat": float(pt.y),
                    "lng": float(pt.x),
                    "zone": zone_name,
                    "borough": borough,
                    "tag": "GOOD" if tag == "TOP" else "BAD",
                    "pickups": pickups,
                    "rating": rating,
                    "color": fill,
                    "avg_driver_pay": float(r["avg_driver_pay"]) if pd.notna(r["avg_driver_pay"]) else None,
                    "avg_tips": float(r["avg_tips"]) if pd.notna(r["avg_tips"]) else None,
                })

        fc = {"type": "FeatureCollection", "features": features}
        frames.append({"time": ts_iso, "polygons": fc, "markers": markers})
        timeline.append(ts_iso)

    payload = {
        "meta": {
            "bin_minutes": int(bin_minutes),
            "min_trips_per_window": int(min_trips_per_window),
            "win_good_n": int(win_good_n),
            "win_bad_n": int(win_bad_n),
        },
        "timeline": timeline,
        "frames": frames,
    }

    out_path.write_text(json.dumps(payload, ensure_ascii=False))
