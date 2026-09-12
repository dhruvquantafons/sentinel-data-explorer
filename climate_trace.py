"""
Thin client for the Climate TRACE API (https://api.climatetrace.org/v6).

Climate TRACE publishes greenhouse-gas emissions per administrative area
(country / state / district, keyed by GADM ids such as "IND.11.1_1") and
per individual source (power stations, landfills, airports, …). No API key
is needed. Data is licensed under Creative Commons — credit Climate TRACE
(climatetrace.org) wherever it is shown.

Quirks worth knowing (found while probing the API):
- /admins/search?bbox= matches on bounding boxes, so it returns neighbours
  that don't really overlap (and the USA, whose bbox spans the globe).
  Callers should check real overlap with /admins/{id}/geojson.
- /admins/search?point= is broken server-side; don't use it.
- Only `adminIds` filters /assets and /assets/emissions by area; other
  spellings (adminId, gadmId, …) are silently ignored and return global data.
- Emissions come per year only — there is no monthly breakdown, so the
  current year is an unlabelled partial total.
- /assets takes `year` (singular) and defaults to an older year; /assets/
  emissions takes `years`. With the same year, an area's assets add up
  exactly to its sector totals.
"""

import threading
import time

import requests

BASE_URL = "https://api.climatetrace.org/v6"
GAS = "co2e_100yr"          # CO₂-equivalent, 100-year global warming potentials
CACHE_SECONDS = 12 * 3600   # the data changes monthly at most
TIMEOUT = 60

_cache = {}
_cache_lock = threading.Lock()


class ClimateTraceError(Exception):
    """The Climate TRACE API could not be reached or returned an error."""


class ClimateTraceNotFound(ClimateTraceError, LookupError):
    """The requested area (or other resource) doesn't exist."""


def _get(path, **params):
    """GET a JSON endpoint, cached in memory for CACHE_SECONDS."""
    key = (path, tuple(sorted(params.items())))
    now = time.time()
    with _cache_lock:
        hit = _cache.get(key)
        if hit and now - hit[0] < CACHE_SECONDS:
            return hit[1]

    try:
        response = requests.get(f"{BASE_URL}/{path}", params=params, timeout=TIMEOUT)
    except requests.RequestException as e:
        raise ClimateTraceError(f"Climate TRACE is unreachable: {e}") from e
    if response.status_code == 404:
        raise ClimateTraceNotFound(f"Not found in Climate TRACE: {path}")
    if not response.ok:
        raise ClimateTraceError(f"Climate TRACE returned {response.status_code} for {path}")
    data = response.json()

    with _cache_lock:
        _cache[key] = (now, data)
    return data


def _is_real(admin):
    # The API pads results with placeholder "Unknown" areas (ids containing UNK)
    return "UNK" not in admin.get("Id", "")


def search_admins(name=None, bbox=None, level=None, limit=50):
    """
    Find administrative areas by name or by bounding box [W, S, E, N].
    Level 0 = country, 1 = state, 2 = district.
    """
    params = {"limit": limit}
    if name:
        params["name"] = name
    if bbox:
        params["bbox"] = ",".join(f"{v:.6f}" for v in bbox)
    admins = [a for a in _get("admins/search", **params) if _is_real(a)]
    if level is not None:
        admins = [a for a in admins if a.get("Level") == level]
    return admins


def get_admin(admin_id):
    return _get(f"admins/{admin_id}")


def admin_geometries(admin_id):
    """GeoJSON geometries (Polygon / MultiPolygon) of an area's boundary."""
    data = _get(f"admins/{admin_id}/geojson")
    return [f["geometry"] for f in data.get("features", []) if f.get("geometry")]


ASSET_PAGE = 100
MAX_ASSET_PAGES = 30        # 3,000 sources — far more than a district usually has


def admin_assets(admin_id, year):
    """
    Every emission source Climate TRACE lists in an area for a year.

    Returns (assets, truncated): raw asset records, and whether paging
    stopped at MAX_ASSET_PAGES before reaching the end.
    """
    assets = []
    for page in range(MAX_ASSET_PAGES):
        batch = _get("assets", adminIds=admin_id, year=year,
                     limit=ASSET_PAGE, offset=page * ASSET_PAGE).get("assets") or []
        assets.extend(batch)
        if len(batch) < ASSET_PAGE:
            return assets, False
    return assets, True


def admin_emissions(admin_id, year):
    """
    Emissions of one area for one year, per sector:
    {sector_slug: tonnes CO₂e}. Sectors with no emissions are dropped.
    """
    data = _get("assets/emissions", adminIds=admin_id, years=year)
    totals = {}
    for rows in data.values():
        for row in rows:
            if row.get("Gas") != GAS or not row.get("Emissions"):
                continue
            totals[row["Sector"]] = totals.get(row["Sector"], 0.0) + float(row["Emissions"])
    return totals
