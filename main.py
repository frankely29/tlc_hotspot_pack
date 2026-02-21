from fastapi import FastAPI, UploadFile, File
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os
import json
import shutil
import traceback

from build_hotspots import build_hotspots_json

app = FastAPI()

# IMPORTANT: Use Railway Volume mount
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data")).resolve()
PARQUET_DIR = DATA_DIR / "parquets"
OUT_PATH = DATA_DIR / "hotspots_20min.json"

# Split-output for fast phone loading
SPLIT_DIR = DATA_DIR / "split"
FRAMES_DIR = SPLIT_DIR / "frames"
TIMELINE_PATH = SPLIT_DIR / "timeline.json"

# Allow GitHub Pages to call Railway
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

def ensure_dirs():
    PARQUET_DIR.mkdir(parents=True, exist_ok=True)
    FRAMES_DIR.mkdir(parents=True, exist_ok=True)
    SPLIT_DIR.mkdir(parents=True, exist_ok=True)

def list_parquets():
    ensure_dirs()
    return sorted([p.name for p in PARQUET_DIR.glob("*.parquet")])

def has_split_ready():
    return TIMELINE_PATH.exists() and FRAMES_DIR.exists() and any(FRAMES_DIR.glob("*.json"))

@app.get("/")
def root():
    ensure_dirs()
    parquets = list_parquets()
    has_output = OUT_PATH.exists()
    out_mb = round(OUT_PATH.stat().st_size / 1024 / 1024, 2) if has_output else 0
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": has_output,
        "output_mb": out_mb,
        "split_ready": has_split_ready(),
    }

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    ensure_dirs()
    out_path = PARQUET_DIR / file.filename
    content = await file.read()
    out_path.write_bytes(content)
    return {"saved": str(out_path), "size_mb": round(len(content)/1024/1024, 2)}

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
    Generates hotspots_20min.json (large),
    then splits into:
      - /timeline  (small)
      - /frame/{i} (small per time step)
    """
    try:
        ensure_dirs()
        parquets = list(PARQUET_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data/parquets. Upload first via /upload."},
                status_code=400
            )

        # Build the big JSON using your existing builder
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

        # Rebuild split output fresh
        if SPLIT_DIR.exists():
            # wipe only split folder, keep parquets + big json
            if FRAMES_DIR.exists():
                shutil.rmtree(FRAMES_DIR, ignore_errors=True)
            FRAMES_DIR.mkdir(parents=True, exist_ok=True)

        # Load big JSON once on server (better than doing it on phone)
        with OUT_PATH.open("r", encoding="utf-8") as f:
            payload = json.load(f)

        timeline = payload.get("timeline") or []
        frames = payload.get("frames") or []

        # Write timeline.json
        TIMELINE_PATH.write_text(json.dumps({"timeline": timeline}, ensure_ascii=False), encoding="utf-8")

        # Write each frame to its own file (frame_0000.json, frame_0001.json, ...)
        for i, fr in enumerate(frames):
            fp = FRAMES_DIR / f"frame_{i:04d}.json"
            fp.write_text(json.dumps(fr, ensure_ascii=False), encoding="utf-8")

        return {
            "ok": True,
            "output": str(OUT_PATH),
            "size_mb": round(OUT_PATH.stat().st_size/1024/1024, 2),
            "timeline_count": len(timeline),
            "frames_count": len(frames),
            "split_ready": has_split_ready(),
        }

    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/download")
def download_big():
    """Optional: download the big file (not used by phone map anymore)."""
    if not OUT_PATH.exists():
        return JSONResponse({"error": "hotspots_20min.json not generated yet. Call /generate first."}, status_code=404)
    return FileResponse(str(OUT_PATH), media_type="application/json", filename="hotspots_20min.json")

@app.get("/timeline")
def timeline():
    """Small timeline file for fast loading."""
    if not TIMELINE_PATH.exists():
        return JSONResponse({"error": "timeline not ready. Call /generate first."}, status_code=404)
    return FileResponse(str(TIMELINE_PATH), media_type="application/json", filename="timeline.json")

@app.get("/frame/{idx}")
def frame(idx: int):
    """Small frame file for fast per-step loading."""
    fp = FRAMES_DIR / f"frame_{idx:04d}.json"
    if not fp.exists():
        return JSONResponse({"error": f"frame {idx} not found. Call /generate first."}, status_code=404)
    return FileResponse(str(fp), media_type="application/json", filename=f"frame_{idx:04d}.json")