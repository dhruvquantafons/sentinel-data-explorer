"""
Sentinel Satellite Data Acquisition — Interactive Multi-Mission Fetcher
=========================================================================

Flow:
  1. Authenticate.
  2. Ask which Sentinel data product you want, grouped by mission
     (Sentinel-1, -2, -3, -5P).
  3. Ask for the AOI bounding box.
  4. Ask for a date range (or use sensible defaults).
  5. Search the Catalog API, fetch via the Process API, and save the
     result into an `outputs/` folder inside this project directory,
     with a filename that encodes product + coordinates + timestamp so
     nothing ever gets overwritten.

Setup
-----
1. Create a free account:        https://dataspace.copernicus.eu/
2. Generate OAuth credentials from the Sentinel Hub dashboard to get a
   CLIENT_ID and CLIENT_SECRET.
3. Install dependencies:
       pip install requests

IMPORTANT — coverage and accuracy notes
----------------------------------------
- Sentinel-1, -2, -3, and -5P products below are wired up based on
  Sentinel Hub's documented collections and evalscript patterns. The
  Sentinel-2 products (options 1-6) are the ones we've already tested
  successfully together. Sentinel-1/-3/-5P (options 7-14) use the
  standard documented band names but have NOT been live-tested in this
  conversation — if any of them return a 400 error, paste the printed
  error text back and we'll fix the specific collection/band name.
- Sentinel-6 (sea-level altimetry) is NOT included. It's non-image,
  along-track altimetry data that Sentinel Hub's Process API does not
  serve the same way as the raster missions above. To get Sentinel-6
  data you'd use a different service — e.g. the Copernicus Marine
  Service (marine.copernicus.eu) or NASA/EUMETSAT PO.DAAC — which is
  a separate integration from what's built here.
- This is a solid, extensible template — not a claim of "every possible
  Sentinel data product." Each mission has many more band/index
  combinations than are listed here; add more entries to PRODUCTS
  following the same pattern as needed.
"""

import os
import sys
import csv
import json
import requests
from datetime import date, datetime, timedelta
from dotenv import load_dotenv

# Load environment variables from .env file if present
load_dotenv()

# ---------------------------------------------------------------------
# 0. Configuration
# ---------------------------------------------------------------------
CLIENT_ID = os.getenv("CLIENT_ID", "")
CLIENT_SECRET = os.getenv("CLIENT_SECRET", "")

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
CATALOG_URL = "https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search"
PROCESS_URL = "https://sh.dataspace.copernicus.eu/api/v1/process"

# Save each run's files in its own subfolder in "output" inside this project.
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if os.environ.get("VERCEL") or os.environ.get("AWS_EXECUTION_ENV"):
    OUTPUT_DIR = "/tmp/output"
else:
    OUTPUT_DIR = os.path.join(BASE_DIR, "output")
os.makedirs(OUTPUT_DIR, exist_ok=True)


# ---------------------------------------------------------------------
# Evalscripts — Sentinel-2
# ---------------------------------------------------------------------
S2_TRUECOLOR = """
//VERSION=3
function setup() { return { input: ["B04","B03","B02"], output: { bands: 3 } }; }
function evaluatePixel(s) { return [2.5*s.B04, 2.5*s.B03, 2.5*s.B02]; }
"""

S2_NDVI = """
//VERSION=3
function setup() { return { input: ["B04","B08"], output: { bands: 1, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [(s.B08 - s.B04) / (s.B08 + s.B04)]; }
"""

S2_NDWI = """
//VERSION=3
function setup() { return { input: ["B03","B08"], output: { bands: 1, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [(s.B03 - s.B08) / (s.B03 + s.B08)]; }
"""

S2_NDBI = """
//VERSION=3
function setup() { return { input: ["B08","B11"], output: { bands: 1, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [(s.B11 - s.B08) / (s.B11 + s.B08)]; }
"""

S2_NDSI = """
//VERSION=3
function setup() { return { input: ["B03","B11"], output: { bands: 1, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [(s.B03 - s.B11) / (s.B03 + s.B11)]; }
"""

S2_EVI = """
//VERSION=3
function setup() { return { input: ["B02","B04","B08"], output: { bands: 1, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) {
  return [2.5 * (s.B08 - s.B04) / (s.B08 + 6*s.B04 - 7.5*s.B02 + 1)];
}
"""

# ---------------------------------------------------------------------
# Evalscripts — Sentinel-1 (SAR radar)
# ---------------------------------------------------------------------
S1_RADAR = """
//VERSION=3
function setup() { return { input: ["VV","VH"], output: { bands: 2, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [s.VV, s.VH]; }
"""

# ---------------------------------------------------------------------
# Evalscripts — Sentinel-3
# ---------------------------------------------------------------------
S3_OLCI_TRUECOLOR = """
//VERSION=3
function setup() {
  return { input: ["B08","B06","B04"], output: { bands: 3 } };
}
function evaluatePixel(s) { return [2.5*s.B08, 2.5*s.B06, 2.5*s.B04]; }
"""

S3_SLSTR_BT = """
//VERSION=3
function setup() { return { input: ["S8","S9"], output: { bands: 2, sampleType: "FLOAT32" } }; }
function evaluatePixel(s) { return [s.S8, s.S9]; }
"""

# ---------------------------------------------------------------------
# Evalscript generator — Sentinel-5P (one band per gas/pollutant)
# ---------------------------------------------------------------------
def s5p_evalscript(band_name: str) -> str:
    return f"""
//VERSION=3
function setup() {{ return {{ input: ["{band_name}"], output: {{ bands: 1, sampleType: "FLOAT32" }} }}; }}
function evaluatePixel(s) {{ return [s.{band_name}]; }}
"""


# ---------------------------------------------------------------------
# Product catalog, grouped by mission for the menu
# ---------------------------------------------------------------------
PRODUCTS = {
    # --- Sentinel-2 ---
    "1": {"mission": "Sentinel-2", "label": "True Color (visual photo)",
          "collection": "sentinel-2-l2a", "evalscript": S2_TRUECOLOR,
          "format": "image/png", "extension": "png", "has_cloud_filter": True},
    "2": {"mission": "Sentinel-2", "label": "NDVI (vegetation health)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDVI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "3": {"mission": "Sentinel-2", "label": "NDWI (water content)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDWI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "4": {"mission": "Sentinel-2", "label": "NDBI (built-up / urban areas)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDBI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "5": {"mission": "Sentinel-2", "label": "NDSI (snow cover)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDSI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "6": {"mission": "Sentinel-2", "label": "EVI (enhanced vegetation index)",
          "collection": "sentinel-2-l2a", "evalscript": S2_EVI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},

    # --- Sentinel-1 ---
    "7": {"mission": "Sentinel-1", "label": "Radar Backscatter VV/VH (works through clouds/night)",
          "collection": "sentinel-1-grd", "evalscript": S1_RADAR,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},

    # --- Sentinel-3 ---
    "8": {"mission": "Sentinel-3", "label": "OLCI True Color (ocean/land)",
          "collection": "sentinel-3-olci", "evalscript": S3_OLCI_TRUECOLOR,
          "format": "image/png", "extension": "png", "has_cloud_filter": False},
    "9": {"mission": "Sentinel-3", "label": "SLSTR Brightness Temp S8/S9 (thermal infrared)",
          "collection": "sentinel-3-slstr", "evalscript": S3_SLSTR_BT,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},

    # --- Sentinel-5P (air quality / atmosphere) ---
    "10": {"mission": "Sentinel-5P", "label": "NO2 (nitrogen dioxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("NO2"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "11": {"mission": "Sentinel-5P", "label": "CH4 (methane)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("CH4"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "12": {"mission": "Sentinel-5P", "label": "CO (carbon monoxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("CO"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "13": {"mission": "Sentinel-5P", "label": "O3 (ozone)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("O3"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "14": {"mission": "Sentinel-5P", "label": "SO2 (sulfur dioxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("SO2"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "15": {"mission": "Sentinel-5P", "label": "AER_AI (aerosol index)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("AER_AI_340_380"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
}


# ---------------------------------------------------------------------
# 1. Authenticate
# ---------------------------------------------------------------------
def get_access_token(client_id: str, client_secret: str) -> str:
    response = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": client_id,
            "client_secret": client_secret,
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()["access_token"]


# ---------------------------------------------------------------------
# 2. Search the catalog for matching scenes
# ---------------------------------------------------------------------
def search_scenes(token: str, collection: str, bbox: list, date_from: str,
                   date_to: str, has_cloud_filter: bool,
                   max_cloud_cover: int = 80) -> list:
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "collections": [collection],
        "bbox": bbox,
        "datetime": f"{date_from}T00:00:00Z/{date_to}T23:59:59Z",
        "limit": 10,
    }
    if has_cloud_filter:
        payload["filter"] = f"eo:cloud_cover <= {max_cloud_cover}"
        payload["filter-lang"] = "cql2-text"

    response = requests.post(CATALOG_URL, json=payload, headers=headers, timeout=30)
    if not response.ok:
        print("Catalog API error:", response.status_code, response.text)
    response.raise_for_status()
    return response.json().get("features", [])


# ---------------------------------------------------------------------
# 3. Fetch the processed data for the chosen product
# ---------------------------------------------------------------------
def fetch_product(token: str, product: dict, bbox: list, date_from: str,
                   date_to: str, width: int = 512, height: int = 512) -> bytes:
    headers = {"Authorization": f"Bearer {token}"}
    data_filter = {
        "timeRange": {
            "from": f"{date_from}T00:00:00Z",
            "to": f"{date_to}T23:59:59Z",
        }
    }
    if product["has_cloud_filter"]:
        data_filter["maxCloudCoverage"] = 80

    payload = {
        "input": {
            "bounds": {"bbox": bbox},
            "data": [{"type": product["collection"], "dataFilter": data_filter}],
        },
        "output": {
            "width": width,
            "height": height,
            "responses": [{"identifier": "default", "format": {"type": product["format"]}}],
        },
        "evalscript": product["evalscript"],
    }
    response = requests.post(PROCESS_URL, json=payload, headers=headers, timeout=60)
    if not response.ok:
        print("Process API error:", response.status_code, response.text)
    response.raise_for_status()
    return response.content


# ---------------------------------------------------------------------
# Helpers — interactive prompts
# ---------------------------------------------------------------------
def prompt_product() -> dict:
    print("\nWhich Sentinel data product do you want?\n")
    current_mission = None
    for key, product in PRODUCTS.items():
        if product["mission"] != current_mission:
            current_mission = product["mission"]
            print(f"\n  -- {current_mission} --")
        print(f"  {key}. {product['label']}")
    choice = input("\nEnter number: ").strip()
    if choice not in PRODUCTS:
        print("Invalid choice, defaulting to Sentinel-2 True Color.")
        choice = "1"
    return PRODUCTS[choice]


def prompt_bbox() -> list:
    raw = input(
        "\nEnter AOI bounding box as: west,south,east,north\n"
        "(e.g. 72.90,22.50,72.95,22.55) — leave blank for a default test box: "
    ).strip()
    if not raw:
        return [72.90, 22.50, 72.95, 22.55]
    try:
        coords = [float(x.strip()) for x in raw.split(",")]
        if len(coords) != 4:
            raise ValueError
        return coords
    except ValueError:
        print("Could not parse that, using default test box instead.")
        return [72.90, 22.50, 72.95, 22.55]


def prompt_date_range() -> tuple:
    raw = input(
        "\nEnter date range as: YYYY-MM-DD,YYYY-MM-DD\n"
        "(leave blank for the last 30 days): "
    ).strip()
    if not raw:
        today = date.today()
        return (today - timedelta(days=30)).isoformat(), today.isoformat()
    try:
        start_str, end_str = [x.strip() for x in raw.split(",")]
        date.fromisoformat(start_str)
        date.fromisoformat(end_str)
        return start_str, end_str
    except ValueError:
        print("Could not parse that, using the last 30 days instead.")
        today = date.today()
        return (today - timedelta(days=30)).isoformat(), today.isoformat()


def build_run_paths(mission: str, product_label: str, bbox: list, extension: str) -> tuple:
    """Create a unique run directory and paths for the raster and scene CSV."""
    safe_label = product_label.split(" (")[0].replace(" ", "_").replace("/", "-")
    safe_mission = mission.replace(" ", "_").replace("-", "")
    west, south, east, north = bbox
    coord_tag = f"{west:.4f}_{south:.4f}_{east:.4f}_{north:.4f}"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    run_name = f"{safe_mission}_{safe_label}_{coord_tag}_{timestamp}"
    run_dir = os.path.join(OUTPUT_DIR, run_name)
    os.makedirs(run_dir, exist_ok=True)
    return (
        os.path.join(run_dir, f"{run_name}.{extension}"),
        os.path.join(run_dir, f"{run_name}_scenes.csv"),
    )


def format_metadata(value) -> str:
    """Return catalogue values in a readable single-line form."""
    if value is None:
        return "N/A"
    if isinstance(value, (list, dict)):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def save_scenes_csv(scenes: list, csv_path: str) -> None:
    """Save useful common fields and complete catalogue metadata for all matching scenes."""
    fieldnames = [
        "scene_id", "datetime", "platform", "constellation", "instruments",
        "collection", "cloud_cover_percent", "gsd_m", "orbit_state",
        "absolute_orbit", "relative_orbit", "epsg_code", "sar_polarizations",
        "sar_mode", "s5p_product_type", "s5p_timeliness", "geometry", "all_properties",
    ]
    with open(csv_path, "w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        for scene in scenes:
            props = scene.get("properties", {})
            writer.writerow({
                "scene_id": scene.get("id", ""),
                "datetime": props.get("datetime", ""),
                "platform": props.get("platform", ""),
                "constellation": props.get("constellation", ""),
                "instruments": format_metadata(props.get("instruments")),
                "collection": ", ".join(scene.get("collection", []))
                if isinstance(scene.get("collection"), list) else scene.get("collection", ""),
                "cloud_cover_percent": props.get("eo:cloud_cover", "") if props.get("eo:cloud_cover") is not None else "",
                "gsd_m": props.get("gsd", ""),
                "orbit_state": props.get("sat:orbit_state", ""),
                "absolute_orbit": props.get("sat:absolute_orbit", ""),
                "relative_orbit": props.get("sat:relative_orbit", ""),
                "epsg_code": props.get("proj:epsg", ""),
                "sar_polarizations": format_metadata(props.get("sar:polarizations")),
                "sar_mode": props.get("sar:instrument_mode", ""),
                "s5p_product_type": props.get("s5p:type", ""),
                "s5p_timeliness": props.get("s5p:timeliness", ""),
                "geometry": json.dumps(scene.get("geometry", {}), ensure_ascii=False),
                "all_properties": json.dumps(props, ensure_ascii=False),
            })


# ---------------------------------------------------------------------
# Run the workflow
# ---------------------------------------------------------------------
if __name__ == "__main__":
    try:
        token = get_access_token(CLIENT_ID, CLIENT_SECRET)
        print("Authenticated successfully.")
    except requests.exceptions.HTTPError as e:
        print(f"Authentication failed: {e}")
        sys.exit(1)

    product = prompt_product()
    bbox = prompt_bbox()
    date_from, date_to = prompt_date_range()

    print(f"\nSelected: {product['mission']} — {product['label']}")
    print(f"AOI: {bbox}")
    print(f"Date range: {date_from} to {date_to}")

    scenes = search_scenes(
        token, product["collection"], bbox, date_from, date_to,
        product["has_cloud_filter"],
    )
    print(f"\nFound {len(scenes)} matching scene(s):")
    for i, scene in enumerate(scenes, 1):
        props = scene.get("properties", {})
        print(f"\n  [{i}] Scene ID: {scene.get('id', 'N/A')}")
        print(f"      Date/Time:        {format_metadata(props.get('datetime'))}")
        if props.get("eo:cloud_cover") is not None:
            print(f"      Cloud Cover:      {props.get('eo:cloud_cover')}%")
        print(f"      Platform:         {format_metadata(props.get('platform'))}")
        if props.get("constellation"):
            print(f"      Constellation:    {props.get('constellation')}")
        print(f"      Instrument(s):    {format_metadata(props.get('instruments'))}")
        if props.get("gsd") is not None:
            print(f"      Resolution (GSD): {props.get('gsd')} m")
        if props.get("proj:epsg"):
            print(f"      CRS (EPSG):       EPSG:{props.get('proj:epsg')}")
        if props.get("sat:orbit_state"):
            print(f"      Orbit State:      {props.get('sat:orbit_state')}")
        if props.get("sat:absolute_orbit"):
            print(f"      Absolute Orbit:   {props.get('sat:absolute_orbit')}")
        if props.get("sar:polarizations"):
            print(f"      Polarizations:    {format_metadata(props.get('sar:polarizations'))}")
        if props.get("sar:instrument_mode"):
            print(f"      Sensor Mode:      {props.get('sar:instrument_mode')}")
        if props.get("s5p:type"):
            print(f"      S5P Product Type: {props.get('s5p:type')} ({props.get('s5p:timeliness', '')})")

    if not scenes:
        print("No scenes found for this AOI/date range — try widening the date range or the bbox.")
        sys.exit(0)

    output_path, csv_path = build_run_paths(
        product["mission"], product["label"], bbox, product["extension"]
    )
    save_scenes_csv(scenes, csv_path)

    data_bytes = fetch_product(token, product, bbox, date_from, date_to)
    with open(output_path, "wb") as f:
        f.write(data_bytes)
    print(f"\nSaved raster: {output_path}")
    print(f"Saved scene metadata CSV: {csv_path}")

