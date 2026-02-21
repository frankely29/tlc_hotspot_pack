import os
import json
import gzip
import subprocess
from pathlib import Path
from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
OUT_JSON = DATA_DIR / "hotspots_20min.json"
OUT_GZ   = DATA_DIR / "hotspots_20min.json.gz"

app = FastAPI()

# ✅ Allow GitHub Pages to call Railway
# Add more origins if you have a custom domain later.
ALLOWED_ORIGINS = [
    "https://frankely29.github.io",
    "http://localhost:8000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Extra compression for JSON responses (not for .gz files)
app.add_middleware(GZipMiddleware, minimum_size=1000)


def list_parquets():
    if not DATA_DIR.exists():
        return []
    return sorted([p.name for p in DATA_DIR.glob("*.parquet")])


def has_output():
    return OUT_GZ.exists() and OUT_GZ.stat().st_size > 0


def output_mb():
    if not OUT_GZ.exists():
        return 0.0
    return round(OUT_GZ.stat().st_size / (1024 * 1024), 2)


def gzip_file(src: Path, dst: Path):
    with src.open("rb") as f_in, gzip.open(dst, "wb", compresslevel=6) as f_out:
        f_out.write(f_in.read())


@app.get("/status")
def status():
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": list_parquets(),
        "has_output": has_output(),
        "output_mb": output_mb(),
    }


@app.post("/generate")
def generate(
    bin_minutes: int = Query(20),
    good_n: int = Query(200),
    bad_n: int = Query(120),
    win_good_n: int = Query(80),
    win_bad_n: int = Query(40),
    min_trips_per_window: int = Query(10),
    simplify_meters: float = Query(25),
):
    """
    Runs your builder to create hotspots_20min.json in /data, then gzips it.
    IMPORTANT: This does NOT reduce data quality. It only compresses transfer size.
    """

    # If you already have a working build_hotspots.py, we call it as a subprocess.
    # Adjust command if your script uses different flags.
    cmd = [
        "python",
        "build_hotspots.py",
        "--data-dir", str(DATA_DIR),
        "--bin-minutes", str(bin_minutes),
        "--good-n", str(good_n),
        "--bad-n", str(bad_n),
        "--win-good-n", str(win_good_n),
        "--win-bad-n", str(win_bad_n),
        "--min-trips-per-window", str(min_trips_per_window),
        "--simplify-meters", str(simplify_meters),
        "--out", str(OUT_JSON),
    ]

    try:
        proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    except subprocess.CalledProcessError as e:
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": "generate failed",
                "stdout": e.stdout[-2000:],
                "stderr": e.stderr[-2000:],
            },
        )

    if not OUT_JSON.exists() or OUT_JSON.stat().st_size == 0:
        return JSONResponse(status_code=500, content={"ok": False, "error": "builder produced no output json"})

    gzip_file(OUT_JSON, OUT_GZ)

    return {
        "ok": True,
        "output": OUT_GZ.name,
        "size_mb": output_mb(),
    }


@app.get("/hotspots")
def hotspots():
    """
    Returns gzipped JSON. Browser auto-decompresses.
    """
    if not has_output():
        return JSONResponse(status_code=404, content={"error": "timeline not ready. Call /generate first."})

    data = OUT_GZ.read_bytes()
    return Response(
        content=data,
        media_type="application/json",
        headers={
            "Content-Encoding": "gzip",
            "Cache-Control": "no-store",
        },
    )