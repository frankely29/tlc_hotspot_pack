from __future__ import annotations

import json
import zipfile
from pathlib import Path
from datetime import datetime, timedelta
from typing import Iterable

import duckdb
import pandas as pd
import geopandas as gpd
import requests

TAXI_ZONES_ZIP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zones.zip"
TAXI_ZONE_LOOKUP_URL = "https://d37ci6vzurychx.cloudfront.net/misc/taxi_zone_lookup.csv"


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def score_to_color_hex(score01: float) -> str:
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
    s = max(0.0, min(1.0, float(score01)))
    return int(round(1 + 99 * s))


def minmax(series: pd.Series) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    mn = s.min(skipna=True)
    mx = s.max(skipna=True)
    if pd.isna(mn) or pd.isna(mx) or mx == mn:
        return pd.Series([0.0] * len(s), index=s.index)
    return (s - mn) / (mx - mn)


def download(url: str, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.stat().st_size > 0:
        return
    r = requests.get(url, timeout=120)
    r.raise_for_status()
    path.write_bytes(r.content)


def load_taxi_zones(work_dir: Path, simplify_meters: float) -> tuple[gpd.GeoDataFrame, pd.DataFrame]:
    zzip = work_dir / "taxi_zones.zip"
    lookup = work_dir / "taxi_zone_lookup.csv"
    extract_dir = work_dir / "taxi_zones_extracted"

    download(TAXI_ZONES_ZIP_URL, zzip)
    download(TAXI_ZONE_LOOKUP_URL, lookup)

    if not extract_dir.exists():
        extract_dir.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(zzip, "r") as zf:
            zf.extractall(extract_dir)

    shp_files = list(extract_dir.rglob("*.shp"))
    if not shp_files:
        raise RuntimeError("Could not find .shp inside taxi_zones.zip")

    zones = gpd.read_file(shp_files[0]).to_crs(epsg=4326)
    if "LocationID" not in zones.columns:
        # sometimes it is locationid
        cols_lower = {c.lower(): c for c in zones.columns}
        if "locationid" in cols_lower:
            zones = zones.rename(columns={cols_lower["locationid"]: "LocationID"})
        else:
            raise RuntimeError(f"Taxi zones shapefile missing LocationID. Columns: {list(zones.columns)}")
    zones["LocationID"] = zones["LocationID"].astype(int)

    # simplify in meters (project to 3857)
    if simplify_meters and simplify_meters > 0:
        z3857 = zones.to_crs(epsg=3857)
        z3857["geometry"] = z3857.geometry.simplify(float(simplify_meters), preserve_topology=True)
        zones = z3857.to_crs(epsg=4326)

    lookup_df = pd.read_csv(lookup)
    return zones[["LocationID", "geometry"]].copy(), lookup_df


def build_hotspots_json(
    parquet_files: Iterable[Path],
    out_path: Path,
    bin_minutes: int = 20,
    good_n: int = 200,
    bad_n: int = 120,
    win_good_n: int = 80,
    win_bad_n: int = 40,
    min_trips_per_window: int = 10,
    simplify_meters: float = 25.0,
) -> None:
    bin_minutes = int(bin_minutes)
    if bin_minutes <= 0:
        bin_minutes = 20

    con = duckdb.connect(database=":memory:")
    paths = [str(p) for p in parquet_files]

    # DuckDB can read list of paths
    # Bin time into 20-min windows in a synthetic week:
    # - dow_i: 0=Sun..6=Sat  => convert to Mon=0..Sun=6
    # - bin_start_min: minute-of-day bucket start (0..1439)
    df_total = con.execute(
        """
        SELECT
          CAST(PULocationID AS INTEGER) AS PULocationID,
          COUNT(*) AS pickups_total
        FROM read_parquet($1)
        WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
        GROUP BY 1
        """,
        [paths],
    ).df()

    df_win = con.execute(
        f"""
        WITH base AS (
          SELECT
            CAST(PULocationID AS INTEGER) AS PULocationID,
            pickup_datetime,
            TRY_CAST(driver_pay AS DOUBLE) AS driver_pay,
            TRY_CAST(tips AS DOUBLE) AS tips
          FROM read_parquet($1)
          WHERE PULocationID IS NOT NULL AND pickup_datetime IS NOT NULL
        ),
        t AS (
          SELECT
            PULocationID,
            EXTRACT('dow' FROM pickup_datetime) AS dow_i,
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
            CAST(FLOOR((hour_i*60 + minute_i) / {bin_minutes}) * {bin_minutes} AS INTEGER) AS bin_start_min,
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
        """,
        [paths],
    ).df()

    df_win["dow_i"] = df_win["dow_i"].astype(int)
    df_win["dow_m"] = df_win["dow_i"].apply(lambda d: 6 if d == 0 else d - 1)  # Mon=0..Sun=6
    df_win["bin_start_min"] = df_win["bin_start_min"].astype(int)

    # Pick GOOD/BAD zone ids overall by volume
    df_total = df_total.sort_values("pickups_total", ascending=False).copy()
    good_ids = df_total.head(int(good_n))["PULocationID"].astype(int).tolist()

    bad_pool = df_total[~df_total["PULocationID"].astype(int).isin(set(good_ids))].copy()
    bad_ids = bad_pool.sort_values("pickups_total", ascending=True).head(int(bad_n))["PULocationID"].astype(int).tolist()

    good_set, bad_set = set(good_ids), set(bad_ids)
    shown_ids = sorted(set(good_ids + bad_ids))

    # Filter windows and shown ids
    df_win = df_win[df_win["pickups"] >= int(min_trips_per_window)].copy()
    df_win = df_win[df_win["PULocationID"].astype(int).isin(shown_ids)].copy()

    # Score per (dow, bin) across zones
    df_win["vol_n"] = df_win.groupby(["dow_m", "bin_start_min"])["pickups"].transform(minmax)
    df_win["pay_n"] = df_win.groupby(["dow_m", "bin_start_min"])["avg_driver_pay"].transform(minmax)
    df_win["tip_n"] = df_win.groupby(["dow_m", "bin_start_min"])["avg_tips"].transform(minmax)
    df_win["score01"] = (0.60 * df_win["vol_n"]) + (0.30 * df_win["pay_n"]) + (0.10 * df_win["tip_n"])
    df_win["rating"] = df_win["score01"].apply(score_to_rating_1_100)
    df_win["fill"] = df_win["score01"].apply(score_to_color_hex)

    # Select top/bottom per window to keep JSON small
    df_win["rank_good"] = df_win.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=False)
    df_win["rank_bad"] = df_win.groupby(["dow_m", "bin_start_min"])["score01"].rank(method="first", ascending=True)
    df_sel = df_win[(df_win["rank_good"] <= int(win_good_n)) | (df_win["rank_bad"] <= int(win_bad_n))].copy()

    # Load taxi polygons + lookup
    work_dir = Path("work")
    zones_gdf, lookup_df = load_taxi_zones(work_dir, simplify_meters=simplify_meters)
    lookup_df["LocationID"] = lookup_df["LocationID"].astype(int)
    lookup_df = lookup_df.set_index("LocationID")

    zones_gdf = zones_gdf[zones_gdf["LocationID"].isin(shown_ids)].copy()
    zones_by_id = zones_gdf.set_index("LocationID")

    # Centroids for markers
    centroids = zones_gdf.to_crs(epsg=3857)
    centroids["centroid"] = centroids.geometry.centroid
    centroids = gpd.GeoDataFrame(centroids[["LocationID"]], geometry=centroids["centroid"], crs="EPSG:3857").to_crs(epsg=4326)
    centroid_by_id = centroids.set_index("LocationID").geometry

    # Build frames in the exact schema your app.js expects
    week_start = datetime(2025, 1, 6, 0, 0, 0)  # Monday baseline
    timeline = []
    frames = []

    def zone_name(zid: int) -> tuple[str, str]:
        if zid in lookup_df.index:
            row = lookup_df.loc[zid]
            return str(row.get("Zone", f"Zone {zid}")), str(row.get("Borough", "Unknown"))
        return f"Zone {zid}", "Unknown"

    # group rows by (dow_m, bin_start_min)
    for (dow_m, bin_start_min), grp in df_sel.groupby(["dow_m", "bin_start_min"]):
        hour = int(bin_start_min) // 60
        minute = int(bin_start_min) % 60
        ts = week_start + timedelta(days=int(dow_m), hours=hour, minutes=minute)
        tstr = ts.strftime("%Y-%m-%dT%H:%M:%SZ")
        timeline.append(tstr)

        poly_features = []
        markers = []

        for _, r in grp.iterrows():
            zid = int(r["PULocationID"])
            if zid not in zones_by_id.index:
                continue

            geom = zones_by_id.loc[zid].geometry
            if geom is None or geom.is_empty:
                continue

            tag = "GOOD" if zid in good_set else "BAD"
            border = "#00b050" if tag == "GOOD" else "#e60000"
            dash = None if tag == "GOOD" else "6,6"

            zn, br = zone_name(zid)
            pickups = int(r["pickups"])
            rating = int(r["rating"])
            pay = None if pd.isna(r["avg_driver_pay"]) else float(r["avg_driver_pay"])
            tips = None if pd.isna(r["avg_tips"]) else float(r["avg_tips"])

            popup = (
                f"<b>{zn}</b><br/>"
                f"{br} — <b>{tag}</b><br/>"
                f"Rating: <b>{rating}/100</b><br/>"
                f"Pickups: <b>{pickups}</b><br/>"
                f"Avg driver pay: <b>${pay:.2f}</b><br/>" if pay is not None else ""
            )
            if tips is not None:
                popup += f"Avg tips: <b>${tips:.2f}</b><br/>"

            poly_features.append({
                "type": "Feature",
                "geometry": geom.__geo_interface__,
                "properties": {
                    "style": {
                        "color": border,
                        "weight": 2,
                        "dashArray": dash,
                        "fillColor": str(r["fill"]),
                        "fillOpacity": 0.55,
                    },
                    "popup": popup
                }
            })

            # marker centroid
            if zid in centroid_by_id.index:
                pt = centroid_by_id.loc[zid]
                if pt is not None and (not pt.is_empty):
                    markers.append({
                        "tag": tag,
                        "lat": float(pt.y),
                        "lng": float(pt.x),
                        "zone": zn,
                        "borough": br,
                        "rating": rating,
                        "color": str(r["fill"]),
                        "pickups": pickups,
                        "avg_driver_pay": pay,
                        "avg_tips": tips,
                    })

        frames.append({
            "time": tstr,
            "polygons": {"type": "FeatureCollection", "features": poly_features},
            "markers": markers
        })

    # sort timeline/frames just in case
    frames.sort(key=lambda f: f["time"])
    timeline = [f["time"] for f in frames]

    out = {
        "meta": {
            "bin_minutes": bin_minutes,
            "generated_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
            "source_files": [Path(p).name for p in paths],
        },
        "timeline": timeline,
        "frames": frames
    }

    out_path.write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
