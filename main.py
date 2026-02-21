from fastapi import FastAPI, UploadFile, File
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
from pathlib import Path
import os
import traceback
import gzip

from build_hotspots import build_hotspots_json

app = FastAPI()

# Persistent Railway Volume should be mounted here:
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
OUT_JSON = Path(os.getenv("OUT_JSON", "/data/hotspots_20min.json"))
OUT_GZ = Path(str(OUT_JSON) + ".gz")

# Allow GitHub Pages to fetch from Railway
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # ok for your use case; can lock down later
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return status()

@app.get("/status")
def status():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    parquets = sorted([p.name for p in DATA_DIR.glob("*.parquet")])
    has_output = OUT_JSON.exists()
    out_mb = round(OUT_JSON.stat().st_size / 1024 / 1024, 2) if has_output else 0
    return {
        "status": "ok",
        "data_dir": str(DATA_DIR),
        "parquets": parquets,
        "has_output": has_output,
        "output_mb": out_mb,
    }

@app.post("/upload")
async def upload(file: UploadFile = File(...)):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    out_path = DATA_DIR / file.filename
    content = await file.read()
    out_path.write_bytes(content)
    return {"saved": str(out_path), "size_mb": round(len(content) / 1024 / 1024, 2)}

def _gzip_file(src: Path, dst: Path) -> None:
    with src.open("rb") as f_in:
        with gzip.open(dst, "wb", compresslevel=6) as f_out:
            f_out.writelines(f_in)

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
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        parquets = list(DATA_DIR.glob("*.parquet"))
        if not parquets:
            return JSONResponse(
                {"error": "No .parquet files found in /data. Upload first via /upload."},
                status_code=400
            )

        # Build hotspots JSON
        build_hotspots_json(
            parquet_files=parquets,
            out_path=OUT_JSON,
            bin_minutes=bin_minutes,
            good_n=good_n,
            bad_n=bad_n,
            win_good_n=win_good_n,
            win_bad_n=win_bad_n,
            min_trips_per_window=min_trips_per_window,
            simplify_meters=simplify_meters,
        )

        # Create gz version (for phone-friendly download)
        _gzip_file(OUT_JSON, OUT_GZ)

        return {
            "ok": True,
            "output": str(OUT_JSON),
            "gzip": str(OUT_GZ),
            "size_mb": round(OUT_JSON.stat().st_size / 1024 / 1024, 2),
        }

    except Exception as e:
        return JSONResponse(
            {"error": str(e), "trace": traceback.format_exc()},
            status_code=500
        )

@app.get("/hotspots")
def hotspots():
    """
    Returns hotspots JSON gzip-compressed (faster on phone).
    Browser fetch() will transparently decompress it.
    """
    if not OUT_JSON.exists():
        return JSONResponse(
            {"error": "hotspots_20min.json not generated yet. Call /generate first."},
            status_code=404
        )

    # Prefer gzip if available
    if OUT_GZ.exists():
        data = OUT_GZ.read_bytes()
        return Response(
            content=data,
            media_type="application/json",
            headers={
                "Content-Encoding": "gzip",
                "Cache-Control": "no-store",
            },
        )

    # Fallback (not gz)
    data = OUT_JSON.read_bytes()
    return Response(
        content=data,
        media_type="application/json",
        headers={"Cache-Control": "no-store"},
    )