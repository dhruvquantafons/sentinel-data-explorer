"""
Air indicators for the carbon report: Sentinel-5P NO₂, CH₄ and CO over an
area, averaged over the last 12 full months and compared with the 12 months
before, plus a monthly series for charts.

These are concentrations in the air, not emissions: they show where burning
(NO₂, CO) and methane sources leave a mark, but wind carries gases across
boundaries, so they complement — never replace — the Climate TRACE figures.

Speed: reading every Sentinel-5P pass for 24 months takes minutes per gas,
so the Statistical API samples one pass every SAMPLE_EVERY_DAYS days (the
satellite covers a place about once a day). Tested against full daily data
for Ahmadabad: 12-month levels within ~2% and year-on-year change within
~0.5 points, in ~14 s for all three gases instead of ~35 s. Changes smaller
than a gas's noise threshold are reported as "about the same".
"""

import json
import math
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta

import requests

from scene_report import GASES, STATS_URL, _level

INDICATOR_GASES = ["NO2", "CH4", "CO"]
SAMPLE_EVERY_DAYS = 3
MAX_RES_DEG = 0.05            # ≈ Sentinel-5P pixel (~5.5 km); finer adds nothing
SMALL_AREA_DEG = 0.1          # areas narrower than ~2 pixels: readings are regional
CACHE_SECONDS = 12 * 3600

# Year-on-year changes within sampling noise read as "about the same".
# Methane varies little (a real yearly rise is ~0.5%), so its bar is lower.
NOISE_PCT = {"NO2": 3.0, "CO": 3.0, "CH4": 0.5}

# Too few valid readings (clouds, low quality) to trust a 12-month average
MIN_COVERAGE_PCT = 10.0

_cache = {}
_cache_lock = threading.Lock()


# ---------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------
def _add_months(d, n):
    years, month0 = divmod(d.month - 1 + n, 12)
    return date(d.year + years, month0 + 1, 1)


def periods(today=None):
    """(start, middle, end): the previous and the last 12 full months; end exclusive."""
    end = (today or date.today()).replace(day=1)
    return _add_months(end, -24), _add_months(end, -12), end


# ---------------------------------------------------------------------
# Bounds
# ---------------------------------------------------------------------
def _simplify_ring(ring, digits=2):
    """Round to ~1 km (well under a 5.5 km pixel) and drop repeated points."""
    out = []
    for x, y in ring:
        p = (round(x, digits), round(y, digits))
        if not out or out[-1] != p:
            out.append(p)
    if out and out[0] != out[-1]:
        out.append(out[0])
    return out if len(out) >= 4 else None


def simplify_geometries(geometries, digits=2):
    """Boundary as one MultiPolygon, rounded to `digits` decimals (2 ≈ 1 km, 3 ≈ 100 m)."""
    polygons = []
    for geom in geometries:
        for rings in ([geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]):
            simplified = [r for r in (_simplify_ring(r, digits) for r in rings) if r]
            if simplified:
                polygons.append(simplified)
    return {"type": "MultiPolygon", "coordinates": polygons}


def bounds_for_geometries(geometries):
    """Statistical API bounds for a district boundary."""
    return {"geometry": simplify_geometries(geometries)}


def _extent(bounds):
    if "bbox" in bounds:
        return bounds["bbox"]
    pts = [p for poly in bounds["geometry"]["coordinates"] for ring in poly for p in ring]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(ys), max(xs), max(ys)]


# ---------------------------------------------------------------------
# Statistical API
# ---------------------------------------------------------------------
def _evalscript(band):
    return f"""//VERSION=3
function setup() {{
  return {{
    input: [{{ bands: ["{band}", "dataMask"] }}],
    output: [
      {{ id: "value", bands: 1, sampleType: "FLOAT32" }},
      {{ id: "dataMask", bands: 1 }}
    ]
  }};
}}
function evaluatePixel(s) {{
  var ok = s.dataMask === 1 && isFinite(s.{band});
  return {{ value: [ok ? s.{band} : NaN], dataMask: [ok ? 1 : 0] }};
}}"""


def _num(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _fetch_samples(token, band, bounds, start, end):
    """[(date, mean, valid_pixels)] for one pass every SAMPLE_EVERY_DAYS days."""
    key = (band, json.dumps(bounds, sort_keys=True), start.isoformat(), end.isoformat())
    with _cache_lock:
        hit = _cache.get(key)
        if hit and time.time() - hit[0] < CACHE_SECONDS:
            return hit[1]

    west, south, east, north = _extent(bounds)
    res = min(MAX_RES_DEG, (east - west) / 4, (north - south) / 4)
    time_range = {"from": f"{start}T00:00:00Z", "to": f"{end}T00:00:00Z"}
    payload = {
        "input": {
            "bounds": bounds,
            "data": [{
                "type": "sentinel-5p-l2",
                # Same data the app's Sentinel-5P products use (fetch_product)
                "dataFilter": {"timeRange": time_range, "timeliness": "OFFL",
                               "mosaickingOrder": "mostRecent"},
                "processing": {"minQa": 50},
            }],
        },
        "aggregation": {
            "timeRange": time_range,
            "aggregationInterval": {"of": f"P{SAMPLE_EVERY_DAYS}D"},
            "evalscript": _evalscript(band),
            "resx": res,
            "resy": res,
        },
        "calculations": {"default": {"statistics": {"default": {}}}},
    }
    response = requests.post(STATS_URL, json=payload,
                             headers={"Authorization": f"Bearer {token}"}, timeout=180)
    if not response.ok:
        print("Statistical API error:", response.status_code, response.text[:500])
    response.raise_for_status()

    samples = []
    for interval in response.json().get("data", []):
        if "error" in interval:
            continue
        st = interval["outputs"]["value"]["bands"]["B0"]["stats"]
        valid = (st.get("sampleCount") or 0) - (st.get("noDataCount") or 0)
        mean = _num(st.get("mean"))
        samples.append((interval["interval"]["from"][:10], mean if valid else None, valid))

    with _cache_lock:
        _cache[key] = (time.time(), samples)
    return samples


# ---------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------
def _weighted_mean(samples):
    total = sum(m * n for _, m, n in samples if m is not None)
    count = sum(n for _, m, n in samples if m is not None)
    return total / count if count else None


def _fmt(value, gas):
    digits = gas["digits"]
    return f"{value:,.{digits}f} {gas['unit']}".strip()


def _gas_indicator(key, samples, start, middle, end):
    gas = GASES[key]
    factor = gas["factor"]
    expected = max(1, ((end - middle).days + SAMPLE_EVERY_DAYS - 1) // SAMPLE_EVERY_DAYS)

    last = [s for s in samples if s[0] >= middle.isoformat()]
    prev = [s for s in samples if s[0] < middle.isoformat()]
    coverage = 100.0 * sum(1 for s in last if s[1] is not None) / expected

    last_mean = _weighted_mean(last)
    prev_mean = _weighted_mean(prev)
    last_v = None if last_mean is None else last_mean * factor
    prev_v = None if prev_mean is None else prev_mean * factor

    months = {}
    for day, mean, n in samples:
        if mean is not None:
            months.setdefault(day[:7], []).append((day, mean, n))
    monthly = [{"month": m, "value": round(_weighted_mean(v) * factor, gas["digits"] + 1)}
               for m, v in sorted(months.items())]

    name = gas["name"][:1].upper() + gas["name"][1:]
    result = {
        "gas": key, "name": name, "unit": gas["unit"], "about": gas["about"],
        "value": None if last_v is None else round(last_v, gas["digits"] + 1),
        "previous_value": None if prev_v is None else round(prev_v, gas["digits"] + 1),
        "change_pct": None, "trend": None, "level": "",
        "coverage_pct": round(coverage, 1),
        "monthly": monthly,
    }

    if last_v is None or coverage < MIN_COVERAGE_PCT:
        result["summary"] = (f"Not enough valid {name} readings over this area in the last 12 months "
                             f"(often because of cloud or low data quality).")
        return result

    result["level"] = _level(last_v, gas["levels"])
    text = f"{name} averaged {_fmt(last_v, gas)} over the last 12 months ({result['level'].lower()})"
    if prev_v:
        change = 100.0 * (last_v - prev_v) / prev_v
        result["change_pct"] = round(change, 1)
        if abs(change) < NOISE_PCT.get(key, 3.0):
            result["trend"] = "same"
            text += ", about the same as the 12 months before"
        else:
            result["trend"] = "up" if change > 0 else "down"
            diff = _fmt(abs(last_v - prev_v), gas)
            text += f", {abs(change):.0f}% {'higher' if change > 0 else 'lower'} ({diff}) than the 12 months before"
    result["summary"] = text + ". " + gas["about"]
    return result


# "Hotspot-lite": how a drawn rectangle compares with its whole district.
# Differences below these read as "similar" (methane varies far less).
COMPARE_SIMILAR_PCT = {"NO2": 10.0, "CO": 10.0, "CH4": 0.5}


def _compare(indicator, district_indicator, district_name):
    """Add the rectangle-vs-district comparison to one gas indicator."""
    area_v, dist_v = indicator["value"], district_indicator["value"]
    indicator["district_value"] = dist_v
    indicator["district_ratio"] = None
    indicator["comparison"] = None
    if (area_v is None or not dist_v or indicator["level"] == ""
            or district_indicator["level"] == ""):     # too few valid readings in either
        return
    ratio = area_v / dist_v
    diff_pct = 100.0 * (ratio - 1)
    indicator["district_ratio"] = round(ratio, 2)
    gas = GASES[indicator["gas"]]
    if abs(diff_pct) < COMPARE_SIMILAR_PCT.get(indicator["gas"], 10.0):
        text = f"similar to the {district_name} average"
    elif ratio >= 1.5:
        text = f"{ratio:.1f}× the {district_name} average"
    else:
        text = f"{abs(diff_pct):.0f}% {'higher' if diff_pct > 0 else 'lower'} than the {district_name} average"
    indicator["comparison"] = (f"{indicator['name']} in your area is {text} "
                               f"({_fmt(area_v, gas)} vs {_fmt(dist_v, gas)}).")


def build_indicators(token, bounds, area_name, compare_bounds=None, compare_name=None):
    """
    NO₂ / CH₄ / CO indicators for an area (bbox or district boundary).

    With compare_bounds (the district a rectangle sits in), each gas also
    gets district_value, district_ratio and a comparison sentence.
    """
    start, middle, end = periods()
    areas = [bounds] + ([compare_bounds] if compare_bounds else [])
    jobs = [(g, b) for b in areas for g in INDICATOR_GASES]
    with ThreadPoolExecutor(max_workers=len(jobs)) as pool:
        fetched = list(pool.map(
            lambda job: _fetch_samples(token, GASES[job[0]]["band"], job[1], start, end), jobs))
    all_samples = fetched[:len(INDICATOR_GASES)]

    notes = ["Concentrations in the air, not emissions — wind carries gases across boundaries.",
             f"Based on one satellite pass every {SAMPLE_EVERY_DAYS} days."]
    west, south, east, north = _extent(bounds)
    if min(east - west, north - south) < SMALL_AREA_DEG:
        notes.append("Your area is smaller than a couple of satellite pixels (~5 km each), "
                     "so readings reflect the surrounding region.")

    gases = [_gas_indicator(g, s, start, middle, end) for g, s in zip(INDICATOR_GASES, all_samples)]
    if compare_bounds:
        district = [_gas_indicator(g, s, start, middle, end)
                    for g, s in zip(INDICATOR_GASES, fetched[len(INDICATOR_GASES):])]
        for ind, dist_ind in zip(gases, district):
            _compare(ind, dist_ind, compare_name)

    return {
        "area": area_name,
        "compared_with": compare_name,
        "period": {
            "last": {"from": middle.isoformat(), "to": (end - timedelta(days=1)).isoformat()},
            "previous": {"from": start.isoformat(), "to": (middle - timedelta(days=1)).isoformat()},
        },
        "gases": gases,
        "notes": notes,
        "source": "Sentinel-5P (Copernicus), via the Sentinel Hub Statistical API",
    }
