from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os
import traceback
import shutil

from build_hotspots import build_hotspots_json

app = FastAPI()

# Persist everything in Railway Volume mounted at /data
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
OUT_PATH = DATA_DIR / "hotspots_20min.json"

# Allow GitHub Pages (and your phone browser) to fetch from Railway
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    parquets = sorted([p.name for p in DATA_DIR.glob("*.parquet")])
    has_output = OUT_PATH.exists()
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": has_output,
        "output_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if has_output else 0
    }

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    """
    Upload parquet to the Railway volume (/data).
    Uses streaming copy so it doesn't load the whole file into RAM.
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        out_path = DATA_DIR / file.filename

        with out_path.open("wb") as f:
            shutil.copyfileobj(file.file, f)

        return {
            "saved": str(out_path),
            "size_mb": round(out_path.stat().st_size / 1024 / 1024, 2)
        }
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.post("/generate")
def generate(
    bin_minutes: int = 20,
    good_n: int = 200,
    bad_n: int = 120,
    win_good_n: int = 80,
    win_bad_n: int = 40,
    min_trips_per_window: int = 10,
    simplify_meters: float = 25.0
):
    """
    Builds /data/hotspots_20min.json (persistent)
    """
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = list(DATA_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data. Upload first via /upload."},
                status_code=400
            )

        build_hotspots_json(
            parquet_files=parquets,
            out_path=OUT_PATH,
            bin_minutes=bin_minutes,
            good_n=good_n,
            bad_n=bad_n,
            win_good_n=win_good_n,
            win_bad_n=win_bad_n,
            min_trips_per_window=min_trips_per_window,
            simplify_meters=simplify_meters,
        )

        return {
            "ok": True,
            "output": str(OUT_PATH),
            "size_mb": round(OUT_PATH.stat().st_size / 1024 / 1024, 2)
        }
    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/hotspots")
def hotspots():
    """
    Stable endpoint for GitHub Pages to fetch the JSON.
    """
    if not OUT_PATH.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call /generate first."},
            status_code=404
        )

    resp = FileResponse(
        str(OUT_PATH),
        media_type="application/json",
        filename="hotspots_20min.json",
    )
    # Avoid stale caching on phone
    resp.headers["Cache-Control"] = "no-store, max-age=0"
    return resp

@app.get("/download")
def download():
    # keep /download for convenience too
    return hotspots()