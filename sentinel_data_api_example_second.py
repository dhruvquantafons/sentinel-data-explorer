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
# Uses dataMask to write NaN where no valid observation exists, which
# prevents the garbage-float problem seen with raw S5P rasters.
# ---------------------------------------------------------------------
def s5p_evalscript(band_name: str) -> str:
    return f"""
//VERSION=3
function setup() {{
  return {{
    input: ["{band_name}", "dataMask"],
    output: {{ bands: 1, sampleType: "FLOAT32" }}
  }};
}}
function evaluatePixel(s) {{
  if (s.dataMask === 0) return [NaN];
  return [s.{band_name}];
}}
"""


# ---------------------------------------------------------------------
# Product catalog, grouped by mission for the menu
# ---------------------------------------------------------------------
PRODUCTS = {
    # --- Optical Imagery ---
    "1": {"mission": "Optical Imagery", "label": "True Color (visual photo)",
          "collection": "sentinel-2-l2a", "evalscript": S2_TRUECOLOR,
          "format": "image/png", "extension": "png", "has_cloud_filter": True},
    "2": {"mission": "Optical Imagery", "label": "NDVI (vegetation health)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDVI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "3": {"mission": "Optical Imagery", "label": "NDWI (water content)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDWI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "4": {"mission": "Optical Imagery", "label": "NDBI (built-up / urban areas)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDBI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "5": {"mission": "Optical Imagery", "label": "NDSI (snow cover)",
          "collection": "sentinel-2-l2a", "evalscript": S2_NDSI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},
    "6": {"mission": "Optical Imagery", "label": "EVI (enhanced vegetation index)",
          "collection": "sentinel-2-l2a", "evalscript": S2_EVI,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},

    # --- Radar (SAR) ---
    "7": {"mission": "Radar (SAR)", "label": "Radar Backscatter VV/VH (works through clouds/night)",
          "collection": "sentinel-1-grd", "evalscript": S1_RADAR,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},

    # --- Ocean & Land Color ---
    "8": {"mission": "Ocean & Land Color", "label": "OLCI True Color (ocean/land)",
          "collection": "sentinel-3-olci", "evalscript": S3_OLCI_TRUECOLOR,
          "format": "image/png", "extension": "png", "has_cloud_filter": False},
    "9": {"mission": "Ocean & Land Color", "label": "SLSTR Brightness Temp S8/S9 (thermal infrared)",
          "collection": "sentinel-3-slstr", "evalscript": S3_SLSTR_BT,
          "format": "image/tiff", "extension": "tiff", "has_cloud_filter": True},

    # --- Atmospheric Air Quality ---
    "10": {"mission": "Atmospheric Air Quality", "label": "NO2 (nitrogen dioxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("NO2"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "11": {"mission": "Atmospheric Air Quality", "label": "CH4 (methane)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("CH4"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "12": {"mission": "Atmospheric Air Quality", "label": "CO (carbon monoxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("CO"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "13": {"mission": "Atmospheric Air Quality", "label": "O3 (ozone)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("O3"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "14": {"mission": "Atmospheric Air Quality", "label": "SO2 (sulfur dioxide)",
           "collection": "sentinel-5p-l2", "evalscript": s5p_evalscript("SO2"),
           "format": "image/tiff", "extension": "tiff", "has_cloud_filter": False},
    "15": {"mission": "Atmospheric Air Quality", "label": "AER_AI (aerosol index)",
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
                   max_cloud_cover: int = 80, extra_filter: str = None) -> list:
    """
    extra_filter: optional CQL2 condition, e.g. "s5p:type = 'NO2'" so a
    Sentinel-5P search returns only the chosen gas instead of every product
    in the collection.
    """
    headers = {"Authorization": f"Bearer {token}"}
    payload = {
        "collections": [collection],
        "bbox": bbox,
        "datetime": f"{date_from}T00:00:00Z/{date_to}T23:59:59Z",
        "limit": 10,
    }
    conditions = []
    if has_cloud_filter:
        conditions.append(f"eo:cloud_cover <= {max_cloud_cover}")
    if extra_filter:
        conditions.append(extra_filter)
    if conditions:
        payload["filter"] = " and ".join(conditions)
        payload["filter-lang"] = "cql2-text"

    response = requests.post(CATALOG_URL, json=payload, headers=headers, timeout=30)
    if response.status_code == 400 and extra_filter:
        # Catalog rejected the extra condition: search without it
        # (callers can still filter the results locally).
        print("Catalog rejected filter, retrying without:", extra_filter)
        return search_scenes(token, collection, bbox, date_from, date_to,
                             has_cloud_filter, max_cloud_cover)
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

    # Sentinel-5P needs explicit mosaicking + timeliness so the Process
    # API actually returns valid atmospheric data instead of empty bytes.
    is_s5p = product["collection"] == "sentinel-5p-l2"
    if is_s5p:
        data_filter["mosaickingOrder"] = "mostRecent"
        data_filter["timeliness"] = "OFFL"

    data_entry = {"type": product["collection"], "dataFilter": data_filter}

    # S5P processing options: apply quality filter so only reliable
    # measurements come through (qa_value >= 50%).
    if is_s5p:
        data_entry["processing"] = {"minQa": 50}

    payload = {
        "input": {
            "bounds": {"bbox": bbox},
            "data": [data_entry],
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


def format_cell_value(val) -> str:
    """Format catalogue cell values into clean, unclustered scalar strings."""
    if val is None:
        return ""
    if isinstance(val, list):
        if not val:
            return ""
        if all(isinstance(x, (str, int, float, bool)) for x in val):
            return ", ".join(str(x) for x in val)
        return json.dumps(val, ensure_ascii=False)
    if isinstance(val, dict):
        if not val:
            return ""
        items = []
        for k, v in val.items():
            if isinstance(v, (str, int, float, bool)):
                items.append(f"{k}={v}")
        if items:
            return "; ".join(items)
        return json.dumps(val, ensure_ascii=False)
    return str(val)


def save_scenes_csv(scenes: list, csv_path: str) -> None:
    """
    Save scene catalog metadata into a clean, unclustered CSV table.
    Flattens geometry into distinct spatial columns (bbox, center, type)
    and expands all STAC properties into individual columns instead of raw JSON blobs.
    """
    primary_fields = [
        "scene_id", "datetime", "instruments",
        "cloud_cover_percent", "gsd_m", "orbit_state",
        "absolute_orbit", "relative_orbit", "epsg_code", "sar_polarizations",
        "sar_mode", "s5p_product_type", "s5p_timeliness",
    ]

    spatial_fields = [
        "geometry_type", "bbox_west", "bbox_south", "bbox_east", "bbox_north",
        "center_lon", "center_lat",
    ]

    # Handled keys to exclude from generic property expansion
    handled_prop_keys = {
        "datetime", "platform", "constellation", "collection", "instruments", "eo:cloud_cover",
        "gsd", "sat:orbit_state", "sat:absolute_orbit", "sat:relative_orbit",
        "proj:epsg", "sar:polarizations", "sar:instrument_mode", "s5p:type",
        "s5p:timeliness",
    }

    rows = []
    extra_prop_fields = set()

    for scene in scenes:
        props = scene.get("properties", {})
        geom = scene.get("geometry", {})
        bbox = scene.get("bbox", [])

        # Parse spatial coordinates
        geom_type = geom.get("type", "") if isinstance(geom, dict) else ""
        b_west = b_south = b_east = b_north = c_lon = c_lat = ""
        if isinstance(bbox, list) and len(bbox) == 4:
            b_west, b_south, b_east, b_north = bbox[0], bbox[1], bbox[2], bbox[3]
            c_lon = round((b_west + b_east) / 2, 6)
            c_lat = round((b_south + b_north) / 2, 6)

        row = {
            "scene_id": scene.get("id", ""),
            "datetime": props.get("datetime", ""),
            "instruments": format_cell_value(props.get("instruments")),
            "cloud_cover_percent": props.get("eo:cloud_cover", "") if props.get("eo:cloud_cover") is not None else "",
            "gsd_m": props.get("gsd", ""),
            "orbit_state": props.get("sat:orbit_state", ""),
            "absolute_orbit": props.get("sat:absolute_orbit", ""),
            "relative_orbit": props.get("sat:relative_orbit", ""),
            "epsg_code": props.get("proj:epsg", ""),
            "sar_polarizations": format_cell_value(props.get("sar:polarizations")),
            "sar_mode": props.get("sar:instrument_mode", ""),
            "s5p_product_type": props.get("s5p:type", ""),
            "s5p_timeliness": props.get("s5p:timeliness", ""),

            # Unpacked spatial columns
            "geometry_type": geom_type,
            "bbox_west": b_west,
            "bbox_south": b_south,
            "bbox_east": b_east,
            "bbox_north": b_north,
            "center_lon": c_lon,
            "center_lat": c_lat,
        }

        # Unpack remaining properties into individual clean columns
        for k, v in props.items():
            if k in handled_prop_keys:
                continue
            col_name = k.replace(":", "_").replace("-", "_")
            extra_prop_fields.add(col_name)
            row[col_name] = format_cell_value(v)

        rows.append(row)

    all_fieldnames = primary_fields + spatial_fields + sorted(extra_prop_fields)

    with open(csv_path, "w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=all_fieldnames, extrasaction="ignore")
        writer.writeheader()
        for r in rows:
            writer.writerow(r)


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

