# TLC FHV Hotspot Map (Uber/Lyft)

This repo builds an interactive HTML hotspot map from NYC TLC FHVHV tripdata parquet files.

## Local setup
1) Create/activate venv and install requirements:
- `python -m venv .venv`
- `.\.venv\Scripts\activate`
- `pip install -r requirements.txt`

2) Put parquet files into:
- `.\data\fhvhv_tripdata_YYYY-MM.parquet`

## Script organization (use these)
All runnable PowerShell scripts are now in `scripts/`.

- `scripts/build_map.ps1` → build hotspot HTML from parquet data.
- `scripts/serve_map.ps1` → serve newest output locally.
- `scripts/publish_github_pages.ps1` → copy newest output to `docs/index.html`.
- `scripts/publish_and_push.ps1` → one command to publish + commit + push.
- `scripts/open_latest_map.ps1` → open newest output HTML in browser via local server.
- `scripts/run_map_and_patch.ps1` → build + patch + serve workflow.
- `scripts/patch_map.ps1` → HTML patch workflow script.

## Fastest phone publish (no PC server after push)
Run this in Windows PowerShell from repo root:

```powershell
.\scripts\publish_and_push.ps1 -BuildFirst
```

Then open on phone:
- `https://frankely29.github.io/tlc_hotspot_pack/`

First time only (GitHub):
- **Settings -> Pages -> Deploy from branch -> main -> /docs**

## Manual publish mode
```powershell
.\scripts\build_map.ps1
.\scripts\publish_github_pages.ps1
git add docs/index.html
git commit -m "Update published map"
git push -u origin main
```

If commit says "nothing to commit":
```powershell
git push -u origin main
```

## Important
Only run command lines in PowerShell.
Do **not** paste patch/diff text (for example lines starting with `+`, `-`, `@@`, `diff --git`, `EOF`, or `PS C:\...>`).
