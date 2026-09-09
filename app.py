"""
FastAPI backend for TeraVerify.
Wraps the existing sentinel_data_api_example_second.py pipeline as REST endpoints.
"""

import os
import io
import numpy as np
from PIL import Image

from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Optional

# Import existing pipeline functions
from sentinel_data_api_example_second import (
    get_access_token,
    search_scenes,
    fetch_product,
    save_scenes_csv,
    build_run_paths,
    PRODUCTS,
    CLIENT_ID,
    CLIENT_SECRET,
    OUTPUT_DIR,
)

# ─── App setup ───────────────────────────────────────────────────────

app = FastAPI(title="TeraVerify API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


# ─── Colormaps for TIFF → PNG preview ────────────────────────────────

def _build_lut(colors: list[tuple[int, int, int]], n: int = 256) -> np.ndarray:
    """Build an Nx4 RGBA look-up table by linearly interpolating *colors*."""
    lut = np.zeros((n, 4), dtype=np.uint8)
    segs = len(colors) - 1
    for i in range(segs):
        lo = int(i * n / segs)
        hi = int((i + 1) * n / segs)
        for c in range(3):
            lut[lo:hi, c] = np.linspace(colors[i][c], colors[i + 1][c], hi - lo)
        lut[lo:hi, 3] = 200          # semi-transparent overlay
    return lut


COLORMAPS = {
    "vegetation": _build_lut([
        (165, 0, 38), (215, 48, 39), (253, 174, 97),
        (255, 255, 191), (166, 217, 106), (26, 152, 80), (0, 104, 55),
    ]),
    "water": _build_lut([
        (139, 90, 43), (210, 180, 140), (255, 255, 255),
        (135, 206, 250), (30, 144, 255), (0, 0, 139),
    ]),
    "thermal": _build_lut([
        (0, 0, 80), (0, 80, 200), (0, 200, 200),
        (200, 200, 0), (200, 80, 0), (150, 0, 0),
    ]),
    "grayscale": _build_lut([(0, 0, 0), (128, 128, 128), (255, 255, 255)]),
}

# Map product IDs → colormap names (None = direct preview for RGB images)
PRODUCT_CMAP: dict[str, Optional[str]] = {
    "1": None,            # True Color
    "2": "vegetation",    # NDVI
    "3": "water",         # NDWI
    "4": "thermal",       # NDBI
    "5": "water",         # NDSI
    "6": "vegetation",    # EVI
    "7": "grayscale",     # Radar
    "8": None,            # OLCI True Color
    "9": "thermal",       # SLSTR BT
    "10": "thermal",      # NO2
    "11": "thermal",      # CH4
    "12": "thermal",      # CO
    "13": "thermal",      # O3
    "14": "thermal",      # SO2
    "15": "thermal",      # AER_AI
}


# ─── Request / response models ───────────────────────────────────────

class ProcessRequest(BaseModel):
    bbox: List[float]
    product_id: str
    date_from: str
    date_to: str


# ─── Routes ──────────────────────────────────────────────────────────

@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/api/products")
async def get_products():
    """Return the full product catalog as JSON (no secrets)."""
    result = {}
    for key, prod in PRODUCTS.items():
        result[key] = {
            "mission": prod["mission"],
            "label": prod["label"],
            "format": prod["format"],
            "has_cloud_filter": prod["has_cloud_filter"],
        }
    return JSONResponse(result)


@app.post("/api/process")
async def process_data(req: ProcessRequest):
    """
    Search the Sentinel catalog for the given bbox + product + date range.
    Returns a list of matching scenes and saves scene CSV.
    Does NOT auto-fetch any raster — the user picks which scene to fetch.
    """
    if req.product_id not in PRODUCTS:
        raise HTTPException(400, f"Invalid product_id: {req.product_id}")
    if len(req.bbox) != 4:
        raise HTTPException(400, "bbox must have exactly 4 values [west, south, east, north]")

    product = PRODUCTS[req.product_id]

    # 1. Authenticate
    try:
        token = get_access_token(CLIENT_ID, CLIENT_SECRET)
    except Exception as e:
        raise HTTPException(500, f"Authentication failed: {e}")

    # 2. Search catalog
    try:
        scenes = search_scenes(
            token, product["collection"], req.bbox,
            req.date_from, req.date_to, product["has_cloud_filter"],
        )
    except Exception as e:
        raise HTTPException(502, f"Catalog search failed: {e}")

    if not scenes:
        raise HTTPException(
            404,
            "No scenes found for this AOI and date range. "
            "Try widening the area or the date range.",
        )

    # 3. Build output paths & save scene CSV
    output_path, csv_path = build_run_paths(
        product["mission"], product["label"], req.bbox, product["extension"],
    )
    save_scenes_csv(scenes, csv_path)

    # 4. Build response — scenes only, no raster
    csv_rel = os.path.relpath(csv_path, OUTPUT_DIR)

    scene_summaries = []
    for s in scenes[:20]:
        props = s.get("properties", {})
        scene_summaries.append({
            "id": s.get("id", "N/A"),
            "datetime": props.get("datetime", ""),
            "platform": props.get("platform", ""),
            "cloud_cover": props.get("eo:cloud_cover"),
        })

    return JSONResponse({
        "success": True,
        "scenes_count": len(scenes),
        "scenes": scene_summaries,
        "csv_path": csv_rel,
        "bbox": req.bbox,
        "product_id": req.product_id,
        "product": {
            "mission": product["mission"],
            "label": product["label"],
            "format": product["format"],
            "extension": product["extension"],
        },
    })


class FetchSceneRequest(BaseModel):
    bbox: List[float]
    product_id: str
    scene_date: str  # "YYYY-MM-DD" — the specific scene date to fetch


@app.post("/api/fetch-scene")
async def fetch_scene(req: FetchSceneRequest):
    """
    Fetch the processed raster for a specific scene date.
    Called when the user clicks 'Fetch' on a particular scene.
    """
    if req.product_id not in PRODUCTS:
        raise HTTPException(400, f"Invalid product_id: {req.product_id}")
    if len(req.bbox) != 4:
        raise HTTPException(400, "bbox must have exactly 4 values")

    product = PRODUCTS[req.product_id]

    # Authenticate
    try:
        token = get_access_token(CLIENT_ID, CLIENT_SECRET)
    except Exception as e:
        raise HTTPException(500, f"Authentication failed: {e}")

    # Fetch raster for the exact date (1-day window)
    output_path, _ = build_run_paths(
        product["mission"], product["label"], req.bbox, product["extension"],
    )

    try:
        data_bytes = fetch_product(
            token, product, req.bbox, req.scene_date, req.scene_date,
        )
        with open(output_path, "wb") as f:
            f.write(data_bytes)
    except Exception as e:
        raise HTTPException(502, f"Data processing failed: {e}")

    raster_rel = os.path.relpath(output_path, OUTPUT_DIR)

    return JSONResponse({
        "success": True,
        "raster_path": raster_rel,
        "bbox": req.bbox,
        "product_id": req.product_id,
    })


@app.get("/api/runs")
async def list_runs():
    """Return metadata for every past run stored in the output directory."""
    import re
    from datetime import datetime as _dt

    runs = []
    if not os.path.isdir(OUTPUT_DIR):
        return JSONResponse(runs)

    for name in sorted(os.listdir(OUTPUT_DIR), reverse=True):
        run_dir = os.path.join(OUTPUT_DIR, name)
        if not os.path.isdir(run_dir):
            continue

        # Find the scenes CSV inside the run folder
        csv_file = None
        for f in os.listdir(run_dir):
            if f.endswith("_scenes.csv"):
                csv_file = f
                break
        if not csv_file:
            continue

        # Parse folder name: Mission_Product_W_S_E_N_YYYYMMDD_HHMMSS
        # e.g. Sentinel2_NDVI_72.1325_21.7563_72.1555_21.7761_20260908_163504
        # or   Sentinel5P_CO_73.4930_22.2383_73.8776_22.5620_20260909_111427
        m = re.match(
            r'^(Sentinel\d+\w?)_(.+?)_'
            r'(-?\d+\.\d{4})_(-?\d+\.\d{4})_(-?\d+\.\d{4})_(-?\d+\.\d{4})_'
            r'(\d{8})_(\d{6})$',
            name,
        )
        if not m:
            continue

        mission_raw, product_raw = m.group(1), m.group(2)
        west, south, east, north = float(m.group(3)), float(m.group(4)), float(m.group(5)), float(m.group(6))
        ts_str = m.group(7) + m.group(8)

        # Pretty-format mission (Sentinel2 -> Sentinel-2)
        mission = re.sub(r'(Sentinel)(\d)', r'\1-\2', mission_raw)
        product_label = product_raw.replace("_", " ")

        try:
            fetched_at = _dt.strptime(ts_str, "%Y%m%d%H%M%S").isoformat()
        except ValueError:
            fetched_at = ""

        csv_rel = os.path.join(name, csv_file)

        runs.append({
            "id": name,
            "mission": mission,
            "product": product_label,
            "bbox": [west, south, east, north],
            "fetched_at": fetched_at,
            "csv_path": csv_rel,
        })

    return JSONResponse(runs)


@app.get("/api/download/{filepath:path}")
async def download_file(filepath: str):
    """Serve a generated file from the output directory."""
    full = os.path.join(OUTPUT_DIR, filepath)
    if not os.path.isfile(full):
        raise HTTPException(404, "File not found")
    if not os.path.realpath(full).startswith(os.path.realpath(OUTPUT_DIR)):
        raise HTTPException(403, "Access denied")
    return FileResponse(full, filename=os.path.basename(full))


@app.get("/api/preview/{filepath:path}")
async def preview_file(
    filepath: str,
    product_id: Optional[str] = Query(None),
):
    """
    Return a coloured PNG suitable for a Leaflet ImageOverlay.
    - PNGs are served directly.
    - TIFFs are normalised, colormapped, and returned as semi-transparent PNGs.
    """
    full = os.path.join(OUTPUT_DIR, filepath)
    if not os.path.isfile(full):
        raise HTTPException(404, "File not found")
    if not os.path.realpath(full).startswith(os.path.realpath(OUTPUT_DIR)):
        raise HTTPException(403, "Access denied")

    # PNG → serve directly
    if full.lower().endswith(".png"):
        return FileResponse(full, media_type="image/png")

    # TIFF → convert to coloured PNG
    try:
        img = Image.open(full)
        arr = np.array(img, dtype=np.float32)

        cmap_name = "grayscale"
        if product_id and product_id in PRODUCT_CMAP:
            cmap_name = PRODUCT_CMAP[product_id] or "grayscale"

        if arr.ndim == 2 or (arr.ndim == 3 and arr.shape[2] == 1):
            # ── single-band index (NDVI, NDWI, …) ──
            if arr.ndim == 3:
                arr = arr[:, :, 0]
            valid = np.isfinite(arr)
            if valid.any():
                vmin, vmax = np.percentile(arr[valid], [2, 98])
                if vmin == vmax:
                    vmax = vmin + 1
                normed = np.clip((arr - vmin) / (vmax - vmin), 0, 1)
            else:
                normed = np.zeros_like(arr)
            idx = (normed * 255).astype(np.uint8)
            lut = COLORMAPS.get(cmap_name, COLORMAPS["grayscale"])
            rgba = lut[idx]
            rgba[~valid, 3] = 0     # transparent where NaN
            result = Image.fromarray(rgba, mode="RGBA")

        elif arr.ndim == 3 and arr.shape[2] >= 2:
            # ── multi-band (RGB, SAR VV/VH) ──
            if arr.shape[2] == 2:
                band = arr[:, :, 0]
                valid = np.isfinite(band)
                if valid.any():
                    vmin, vmax = np.percentile(band[valid], [2, 98])
                    if vmin == vmax:
                        vmax = vmin + 1
                    normed = np.clip((band - vmin) / (vmax - vmin), 0, 1)
                else:
                    normed = np.zeros_like(band)
                grey = (normed * 255).astype(np.uint8)
                rgba = np.stack([grey, grey, grey, np.full_like(grey, 200)], axis=-1)
                result = Image.fromarray(rgba, mode="RGBA")
            else:
                channels = []
                for c in range(min(arr.shape[2], 3)):
                    ch = arr[:, :, c]
                    valid = np.isfinite(ch)
                    if valid.any():
                        vmin, vmax = np.percentile(ch[valid], [2, 98])
                        if vmin == vmax:
                            vmax = vmin + 1
                        ch = np.clip((ch - vmin) / (vmax - vmin) * 255, 0, 255)
                    else:
                        ch = np.zeros(ch.shape)
                    channels.append(ch.astype(np.uint8))
                alpha = np.full_like(channels[0], 200)
                rgba = np.stack(channels + [alpha], axis=-1)
                result = Image.fromarray(rgba, mode="RGBA")
        else:
            raise HTTPException(400, "Unsupported TIFF band layout")

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png")

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Preview generation failed: {e}")


# ─── Entry point ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
