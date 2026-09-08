"""
FastAPI backend for Sentinel Data Explorer.
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

app = FastAPI(title="Sentinel Data Explorer API")

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
    Accept bbox + product + date range, run the Sentinel pipeline, and
    return paths to the generated raster and CSV.
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

    # 2b. Pick the best scene (lowest cloud cover) so the Process API
    #     fetches clear imagery instead of the most-recent (often cloudy) one.
    best_scene = None
    if product["has_cloud_filter"]:
        scored = []
        for s in scenes:
            cc = s.get("properties", {}).get("eo:cloud_cover")
            scored.append((cc if cc is not None else 100, s))
        scored.sort(key=lambda x: x[0])
        best_scene = scored[0][1]
    else:
        best_scene = scenes[0]

    # Use the best scene's date for a tight 1-day window so the Process
    # API doesn't mosaic with cloudier imagery from other dates.
    best_dt = best_scene.get("properties", {}).get("datetime", "")
    if best_dt:
        best_date = best_dt[:10]          # "YYYY-MM-DD"
        fetch_from = best_date
        fetch_to = best_date
    else:
        fetch_from = req.date_from
        fetch_to = req.date_to

    # 3. Build output paths & save scene CSV
    output_path, csv_path = build_run_paths(
        product["mission"], product["label"], req.bbox, product["extension"],
    )
    save_scenes_csv(scenes, csv_path)

    # 4. Fetch processed raster using the best scene's date
    try:
        data_bytes = fetch_product(
            token, product, req.bbox, fetch_from, fetch_to,
        )
        with open(output_path, "wb") as f:
            f.write(data_bytes)
    except Exception as e:
        raise HTTPException(502, f"Data processing failed: {e}")

    # 5. Build response
    raster_rel = os.path.relpath(output_path, OUTPUT_DIR)
    csv_rel = os.path.relpath(csv_path, OUTPUT_DIR)

    scene_summaries = []
    for s in scenes[:10]:
        props = s.get("properties", {})
        scene_summaries.append({
            "id": s.get("id", "N/A"),
            "datetime": props.get("datetime", ""),
            "platform": props.get("platform", ""),
            "cloud_cover": props.get("eo:cloud_cover"),
        })

    best_props = best_scene.get("properties", {})

    return JSONResponse({
        "success": True,
        "scenes_count": len(scenes),
        "scenes": scene_summaries,
        "raster_path": raster_rel,
        "csv_path": csv_rel,
        "bbox": req.bbox,
        "product_id": req.product_id,
        "product": {
            "mission": product["mission"],
            "label": product["label"],
            "format": product["format"],
        },
        "best_scene": {
            "id": best_scene.get("id", "N/A"),
            "datetime": best_props.get("datetime", ""),
            "cloud_cover": best_props.get("eo:cloud_cover"),
        },
    })


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
