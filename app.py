"""
FastAPI backend for TeraVerify.
Wraps the existing sentinel_data_api_example_second.py pipeline as REST endpoints.
"""

import os
import io
import re
import sys
import numpy as np
from PIL import Image

try:
    import tifffile
except ImportError:      # optional, Pillow fallback below
    tifffile = None

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
    build_run_paths,
    PRODUCTS,
    CLIENT_ID,
    CLIENT_SECRET,
    OUTPUT_DIR,
)
from scene_report import build_report, write_report_csv, catalog_filter_for, matches_product
import requests
import air_indicators
import carbon_report
import climate_trace as ct_client
from climate_trace import ClimateTraceError, ClimateTraceNotFound

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
        lut[lo:hi, 3] = 235         # semi-transparent overlay
    return lut


def _read_raster(path: str) -> np.ndarray:
    """
    Decode a GeoTIFF into a float32 array.

    Sentinel Hub returns big-endian ("MM") float32 TIFFs. Pillow's libtiff
    path hands those back without byte-swapping, which turns real index values
    (roughly -1..1) into denormals and ~1e38 spikes, and it refuses to open the
    2-band float radar files at all. tifffile decodes both correctly, so it is
    preferred; Pillow stays as a fallback with an explicit swap.
    """
    if tifffile is not None:
        return np.asarray(tifffile.imread(path), dtype=np.float32)

    img = Image.open(path)
    raw = np.array(img)
    bits = img.tag_v2.get(258, (8,))
    if not isinstance(bits, (tuple, list)):
        bits = (bits,)
    if img.tag_v2.prefix == b"MM" and sys.byteorder == "little" and max(bits) > 8:
        raw = raw.byteswap()
    return raw.astype(np.float32)


def _stretch(band: np.ndarray) -> tuple[np.ndarray, np.ndarray, Optional[tuple[float, float]]]:
    """
    Percentile-stretch a single band to 0..1.

    Returns (normalised, valid, (vmin, vmax)); the range is None when the band
    has no valid pixels. Besides NaN/Inf, pixels with absurd magnitudes are
    excluded: Sentinel Hub writes ~±3.4e38 sentinels where a band has no data,
    and letting those into the percentiles collapses the whole scene onto one
    flat colour.
    """
    valid = np.isfinite(band) & (np.abs(band) < 1e6)
    if not valid.any():
        return np.zeros(band.shape, dtype=np.float32), valid, None

    vmin, vmax = np.percentile(band[valid], [2, 98])
    if vmin == vmax:
        vmax = vmin + 1
    normed = np.zeros(band.shape, dtype=np.float32)
    normed[valid] = np.clip((band[valid] - vmin) / (vmax - vmin), 0, 1)
    return normed, valid, (float(vmin), float(vmax))


# Colour stops, low → high. The frontend draws its legend from these too
# (see /api/products), so the map key always matches the rendered raster.
COLORMAP_STOPS: dict[str, list[tuple[int, int, int]]] = {
    "vegetation": [
        (165, 0, 38), (215, 48, 39), (253, 174, 97),
        (255, 255, 191), (166, 217, 106), (26, 152, 80), (0, 104, 55),
    ],
    "water": [
        (139, 90, 43), (210, 180, 140), (255, 255, 255),
        (135, 206, 250), (30, 144, 255), (0, 0, 139),
    ],
    "thermal": [
        (0, 0, 80), (0, 80, 200), (0, 200, 200),
        (200, 200, 0), (200, 80, 0), (150, 0, 0),
    ],
    "grayscale": [(0, 0, 0), (128, 128, 128), (255, 255, 255)],
}

COLORMAPS = {name: _build_lut(stops) for name, stops in COLORMAP_STOPS.items()}

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

# GeoTIFF georeferencing tags, with the TIFF data type used to rewrite them.
# 12 = double, 3 = short, 2 = ascii.
GEO_TAGS = {
    33550: 12,   # ModelPixelScale
    33922: 12,   # ModelTiepoint
    34264: 12,   # ModelTransformation
    34735: 3,    # GeoKeyDirectory
    34736: 12,   # GeoDoubleParams
    34737: 2,    # GeoAsciiParams
}

OPAQUE = 255


def _cmap_for(product_id: Optional[str]) -> str:
    """Colormap name for a product, defaulting to grayscale."""
    if product_id and product_id in PRODUCT_CMAP:
        return PRODUCT_CMAP[product_id] or "grayscale"
    return "grayscale"


def _render_rgba(
    arr: np.ndarray, cmap_name: str, alpha: Optional[int] = None,
) -> tuple[np.ndarray, Optional[tuple[float, float]]]:
    """
    Colourise a raster array into an HxWx4 uint8 RGBA image.

    Single-band data (NDVI, EVI, radar VV, the S5P gases …) runs through the
    product's colormap; 3-band data is treated as true-colour RGB. No-data
    pixels come out fully transparent. *alpha* overrides the opacity of valid
    pixels — the map overlay uses the colormap's built-in value, downloads
    pass OPAQUE.

    Returns (rgba, value_range), where value_range is the (low, high) data
    value the colormap ends map to, or None for true-colour images.
    """
    if arr.ndim == 3 and arr.shape[2] == 1:
        arr = arr[:, :, 0]

    value_range = None
    if arr.ndim == 2 or (arr.ndim == 3 and arr.shape[2] == 2):
        # Single-band index, or the first band of a 2-band radar scene.
        band = arr if arr.ndim == 2 else arr[:, :, 0]
        normed, valid, value_range = _stretch(band)
        lut = COLORMAPS.get(cmap_name, COLORMAPS["grayscale"])
        rgba = lut[(normed * 255).astype(np.uint8)].copy()

    elif arr.ndim == 3 and arr.shape[2] >= 3:
        # True-colour / multispectral: stretch each channel independently.
        channels = []
        valid = np.zeros(arr.shape[:2], dtype=bool)
        for c in range(3):
            normed, ch_valid, _ = _stretch(arr[:, :, c])
            valid |= ch_valid
            channels.append((normed * 255).astype(np.uint8))
        opacity = np.full(arr.shape[:2], COLORMAPS["grayscale"][128, 3], dtype=np.uint8)
        rgba = np.stack(channels + [opacity], axis=-1)

    else:
        raise HTTPException(400, "Unsupported TIFF band layout")

    if alpha is not None:
        rgba[..., 3] = alpha
    rgba[~valid, 3] = 0          # transparent where there is no data
    return rgba, value_range


def _colorize_tiff(path: str, product_id: Optional[str]) -> bytes:
    """
    Render a data GeoTIFF into an RGBA GeoTIFF that looks like the map preview.

    The georeferencing tags are copied across, so the coloured file still lines
    up in QGIS/ArcGIS — but the pixel values are display colours, not the
    original measurements. The raw float raster stays available via ?raw=1.
    """
    if tifffile is None:
        raise HTTPException(
            500, "Coloured downloads need the 'tifffile' package (pip install tifffile)"
        )

    rgba, _ = _render_rgba(_read_raster(path), _cmap_for(product_id), alpha=OPAQUE)

    extratags = []
    with tifffile.TiffFile(path) as tif:
        tags = tif.pages[0].tags
        for code, dtype in GEO_TAGS.items():
            tag = tags.get(code)
            if tag is None or tag.value is None:
                continue
            value = tag.value
            count = len(value) if not isinstance(value, str) else len(value) + 1
            extratags.append((code, dtype, count, value, True))

    buf = io.BytesIO()
    tifffile.imwrite(buf, rgba, photometric="rgb", extrasamples="unassalpha",
                     compression="deflate", extratags=extratags)
    return buf.getvalue()


class LoginRequest(BaseModel):
    username: str
    password: str

class ProcessRequest(BaseModel):
    bbox: List[float]
    product_id: str
    date_from: str
    date_to: str


# Demo credentials
DEMO_USERNAME = "admin"
DEMO_PASSWORD = "admin"


# ─── Routes ──────────────────────────────────────────────────────────

@app.get("/")
async def login_page():
    return FileResponse(os.path.join(STATIC_DIR, "login.html"))


@app.get("/app")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.post("/api/login")
async def login(req: LoginRequest):
    """Demo login endpoint — accepts hardcoded credentials."""
    if req.username == DEMO_USERNAME and req.password == DEMO_PASSWORD:
        return JSONResponse({"success": True, "message": "Login successful"})
    return JSONResponse({"success": False, "message": "Invalid credentials"}, status_code=401)


@app.get("/api/products")
async def get_products():
    """Return the full product catalog as JSON (no secrets)."""
    result = {}
    for key, prod in PRODUCTS.items():
        cmap = PRODUCT_CMAP.get(key)
        result[key] = {
            "mission": prod["mission"],
            "label": prod["label"],
            "format": prod["format"],
            "has_cloud_filter": prod["has_cloud_filter"],
            # Legend colours for the map preview (None for true-colour imagery)
            "colormap": COLORMAP_STOPS[cmap] if cmap else None,
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
            extra_filter=catalog_filter_for(req.product_id),
        )
    except Exception as e:
        raise HTTPException(502, f"Catalog search failed: {e}")

    # Keep only scenes of the chosen product (e.g. the selected gas for 5P)
    scenes = [s for s in scenes if matches_product(s, req.product_id)]

    if not scenes:
        raise HTTPException(
            404,
            "No scenes found for this AOI and date range. "
            "Try widening the area or the date range.",
        )

    # 3. Build output paths & save a plain-language scene report CSV, with
    #    product-specific measurements per date (vegetation cover, water
    #    area, gas levels, …) from the Statistical API
    output_path, csv_path = build_run_paths(
        product["mission"], product["label"], req.bbox, product["extension"],
    )
    fieldnames, report_rows, measured = build_report(
        token, req.product_id, product, req.bbox, scenes,
    )
    write_report_csv(fieldnames, report_rows, csv_path)

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
        "measurements_available": measured,
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


# ─── Carbon footprint (Climate TRACE) ────────────────────────────────

class CarbonReportRequest(BaseModel):
    bbox: Optional[List[float]] = None    # [west, south, east, north]; finds the district(s)
    district_id: Optional[str] = None     # GADM id, e.g. "IND.11.1_1"; overrides bbox
    year: Optional[int] = None            # defaults to the latest full year


@app.get("/api/carbon/districts")
async def carbon_district_search(name: str = Query(..., min_length=2)):
    """District suggestions for the search box (GADM spellings, e.g. "Ahmadabad")."""
    try:
        return JSONResponse(carbon_report.search_districts(name))
    except ClimateTraceError as e:
        raise HTTPException(502, str(e))


@app.post("/api/carbon-report")
def carbon_footprint_report(req: CarbonReportRequest):
    """
    Carbon footprint of the district covering a drawn rectangle (or of a
    district picked by id): yearly totals, sector breakdown, summary and a
    readable CSV. Sync handler: FastAPI runs it in a worker thread, so the
    blocking Climate TRACE calls don't stall other requests.
    """
    if not req.bbox and not req.district_id:
        raise HTTPException(400, "Provide a bbox or a district_id")
    if req.bbox and len(req.bbox) != 4:
        raise HTTPException(400, "bbox must have exactly 4 values [west, south, east, north]")

    try:
        districts = carbon_report.districts_for_bbox(req.bbox) if req.bbox else []
        district_id = req.district_id or (districts[0]["id"] if districts else None)
        if not district_id:
            raise HTTPException(404, "No district with emissions data covers this area. "
                                     "Try drawing over land, or search for a district by name.")
        report = carbon_report.build_footprint(district_id, req.year)
        csv_path = carbon_report.write_footprint_csv(report, OUTPUT_DIR)

        # Named facilities: inside the rectangle (across every district it
        # touches), or the whole district when it was picked by id
        area = districts if req.bbox else [report["district"]]
        facilities = carbon_report.build_facilities(
            area, req.bbox, report["year"], report["district"]["id"], report["tonnes"])
        facilities_csv = carbon_report.write_facilities_csv(facilities, csv_path)
    except ClimateTraceNotFound:
        raise HTTPException(404, f"District not found: {district_id}")
    except LookupError as e:                 # district exists but has no data
        raise HTTPException(404, str(e))
    except ClimateTraceError as e:
        raise HTTPException(502, str(e))

    report.pop("_yearly", None)
    facilities.pop("_all", None)
    # District outline for the map (~100 m precision keeps it small)
    report["boundary"] = air_indicators.simplify_geometries(
        ct_client.admin_geometries(report["district"]["id"]), digits=3)
    report["area_districts"] = districts
    report["facilities"] = facilities
    report["csv_path"] = os.path.relpath(csv_path, OUTPUT_DIR)
    report["facilities_csv_path"] = os.path.relpath(facilities_csv, OUTPUT_DIR)
    return JSONResponse(report)


class CarbonIndicatorsRequest(BaseModel):
    bbox: Optional[List[float]] = None    # measure over this rectangle…
    district_id: Optional[str] = None     # …or this district; with both, compare them


@app.post("/api/carbon-indicators")
def carbon_air_indicators(req: CarbonIndicatorsRequest):
    """
    NO₂ / CH₄ / CO over the last 12 months vs the 12 before (Sentinel-5P).

    - bbox only: measured over the rectangle
    - district_id only: measured over the district boundary
    - both: measured over the rectangle and compared with the district
      ("hotspot-lite": is the drawn area higher or lower than its district?)

    Separate from /api/carbon-report because it takes ~10–35 s: the report
    renders first and this fills in the air card afterwards.
    """
    if not req.bbox and not req.district_id:
        raise HTTPException(400, "Provide a bbox or a district_id")
    if req.bbox and len(req.bbox) != 4:
        raise HTTPException(400, "bbox must have exactly 4 values [west, south, east, north]")

    try:
        district_bounds = district_name = None
        if req.district_id:
            district_name = ct_client.get_admin(req.district_id).get("Name") or req.district_id
            district_bounds = air_indicators.bounds_for_geometries(
                ct_client.admin_geometries(req.district_id))
        token = get_access_token(CLIENT_ID, CLIENT_SECRET)
        if req.bbox:
            result = air_indicators.build_indicators(
                token, {"bbox": req.bbox}, "your area", district_bounds, district_name)
        else:
            result = air_indicators.build_indicators(token, district_bounds, district_name)
        return JSONResponse(result)
    except ClimateTraceNotFound:
        raise HTTPException(404, f"District not found: {req.district_id}")
    except ClimateTraceError as e:
        raise HTTPException(502, str(e))
    except requests.RequestException as e:
        raise HTTPException(502, f"Air indicators unavailable: {e}")


# Run-folder mission prefix → display name. build_run_paths() writes the
# mission name ("Optical_Imagery_…"); runs from older versions used the
# satellite name ("Sentinel2_…").
RUN_MISSIONS = {
    **{p["mission"].replace(" ", "_").replace("-", ""): p["mission"] for p in PRODUCTS.values()},
    "Sentinel1": "Radar (SAR)",
    "Sentinel2": "Optical Imagery",
    "Sentinel3": "Ocean & Land Color",
    "Sentinel5P": "Atmospheric Air Quality",
}
RUN_NAME_RE = re.compile(
    r'^(' + "|".join(re.escape(k) for k in sorted(RUN_MISSIONS, key=len, reverse=True)) + r')_(.+?)_'
    r'(-?\d+\.\d{4})_(-?\d+\.\d{4})_(-?\d+\.\d{4})_(-?\d+\.\d{4})_'
    r'(\d{8})_(\d{6})$'
)


@app.get("/api/runs")
async def list_runs():
    """Return metadata for every past run stored in the output directory."""
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
        # e.g. Optical_Imagery_NDVI_72.1325_21.7563_72.1555_21.7761_20260908_163504
        # or (older runs) Sentinel5P_CO_73.4930_22.2383_73.8776_22.5620_20260909_111427
        m = RUN_NAME_RE.match(name)
        if not m:
            continue

        mission_raw, product_raw = m.group(1), m.group(2)
        west, south, east, north = float(m.group(3)), float(m.group(4)), float(m.group(5)), float(m.group(6))
        ts_str = m.group(7) + m.group(8)

        mission = RUN_MISSIONS.get(mission_raw, mission_raw)
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

    # Newest first (folder names no longer sort by time: prefixes differ)
    runs.sort(key=lambda r: r["fetched_at"], reverse=True)
    return JSONResponse(runs)


@app.get("/api/download/{filepath:path}")
async def download_file(
    filepath: str,
    product_id: Optional[str] = Query(None),
    raw: bool = Query(False),
):
    """
    Serve a generated file from the output directory.

    Data TIFFs are colourised with the same colormap as the map preview, so the
    downloaded file opens in colour instead of as a flat single-band image.
    Pass ?raw=1 to get the untouched float GeoTIFF with the original
    measurement values.
    """
    full = os.path.join(OUTPUT_DIR, filepath)
    if not os.path.isfile(full):
        raise HTTPException(404, "File not found")
    if not os.path.realpath(full).startswith(os.path.realpath(OUTPUT_DIR)):
        raise HTTPException(403, "Access denied")

    is_tiff = full.lower().endswith((".tif", ".tiff"))
    if raw or not is_tiff:
        return FileResponse(full, filename=os.path.basename(full))

    try:
        data = _colorize_tiff(full, product_id)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Colourised download failed: {e}")

    stem, ext = os.path.splitext(os.path.basename(full))
    return StreamingResponse(
        io.BytesIO(data),
        media_type="image/tiff",
        headers={"Content-Disposition": f'attachment; filename="{stem}_color{ext}"'},
    )


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
        rgba, value_range = _render_rgba(_read_raster(full), _cmap_for(product_id))
        result = Image.fromarray(rgba)

        # The data values the colormap ends correspond to, for the map legend
        headers = {}
        if value_range is not None:
            headers["X-Value-Min"] = f"{value_range[0]:.6g}"
            headers["X-Value-Max"] = f"{value_range[1]:.6g}"

        buf = io.BytesIO()
        result.save(buf, format="PNG")
        buf.seek(0)
        return StreamingResponse(buf, media_type="image/png", headers=headers)

    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Preview generation failed: {e}")


# ─── Entry point ─────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)
