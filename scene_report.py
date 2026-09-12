"""
Plain-language scene reports for the scene CSV.

The catalog search only says *that* a satellite passed over the area. This
module asks the Sentinel Hub Statistical API what it actually saw — a single
request returns per-day statistics over the AOI for every date — and turns
them into columns a non-specialist can read, e.g. "Dense, healthy vegetation
(% of visible area)" or "Estimated open-water area (km²)", plus a one-line
summary per date.

Each product gets measurements that match what it is for: vegetation
products report vegetation cover, the water index reports water, the gas
products report concentrations in familiar units with an indicative level,
and so on. Optical measurements exclude clouds and cloud shadows (using the
Sentinel-2 scene classification) so a cloudy day doesn't read as "no
vegetation".

The level thresholds below are rough, commonly used guides meant to help
non-experts read the numbers — not regulatory or health limits.
"""

import csv
import json
import math
import re
from collections import OrderedDict
from datetime import date, timedelta

import requests

STATS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics"

# Below this share of the AOI being visible, per-date measurements are left
# blank rather than extrapolated from a handful of pixels.
MIN_VISIBLE_PCT = 5.0

# Sentinel-2 scene-classification codes that hide the ground:
# 0 no data, 1 saturated, 3 cloud shadow, 8/9 cloud, 10 thin cirrus.
S2_HIDDEN_SCL = [0, 1, 3, 8, 9, 10]

NEG_INF = float("-inf")


# ---------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------
def _num(x):
    """Stats values arrive as floats, or the string "NaN" for empty days."""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return v if math.isfinite(v) else None


def _round(v, digits):
    return "" if v is None else round(v, digits)


def _level(value, levels):
    """Pick the label of the first (threshold, label) whose threshold ≤ value."""
    if value is None:
        return ""
    for threshold, label in levels:
        if value >= threshold:
            return label
    return levels[-1][1]


def _stats(outputs, output_id, band=0):
    return outputs.get(output_id, {}).get("bands", {}).get(f"B{band}", {}).get("stats", {})


def _valid_pct(stats):
    count = stats.get("sampleCount") or 0
    if not count:
        return 0.0
    return 100.0 * (count - (stats.get("noDataCount") or 0)) / count


def aoi_area_km2(bbox):
    """Approximate area of a lon/lat bbox (equirectangular)."""
    west, south, east, north = bbox
    mid_lat = math.radians((south + north) / 2)
    return abs((east - west) * 111.32 * math.cos(mid_lat) * (north - south) * 110.57)


def short_platform(platform):
    """sentinel-2b → S2B, sentinel-5 precursor / sentinel-5p → S5P."""
    if not platform:
        return ""
    m = re.match(r"sentinel[-_\s]?(\d+)\s*(precursor|p|[a-z])?", str(platform), re.I)
    if not m:
        return str(platform).upper()
    suffix = (m.group(2) or "").lower()
    return f"S{m.group(1)}" + ("P" if suffix in ("p", "precursor") else suffix.upper())


# ---------------------------------------------------------------------
# Product specs
# ---------------------------------------------------------------------
class Spec:
    """
    How to measure one product and describe the result.

    evalscript  Statistical API script. Its "value" output carries the
                measured quantity, the optional "classes" output one 0/1 band
                per class (the band mean is then that class's share).
    columns     Measurement column headers, in CSV order.
    build       f(outputs, ctx) -> (columns dict, summary sentence).
    coverage    "clouds" (optical, clouds masked) or "data" (radar, thermal,
                gases — gaps are missing data, not cloud).
    clouds_are_content
                The measurement describes clouds themselves (true-colour
                breakdown), so a cloudy day is still reported, not blanked.
    publish_lag_days
                Dates this recent with no statistics are explained as "not
                published yet" rather than "no measurement".
    no_valid_note
                Summary for a date with data but no valid pixels over the AOI.
    """

    def __init__(self, evalscript, columns, build, coverage="data",
                 native_m=10, data_filter=None, processing=None, catalog_filter=None,
                 clouds_are_content=False, publish_lag_days=0,
                 no_valid_note="No valid measurements over your area on this date."):
        self.evalscript = evalscript
        self.columns = columns
        self.build = build
        self.coverage = coverage
        self.clouds_are_content = clouds_are_content
        self.publish_lag_days = publish_lag_days
        self.no_valid_note = no_valid_note
        self.native_m = native_m
        self.data_filter = data_filter or {}
        self.processing = processing
        self.catalog_filter = catalog_filter


def _class_script(input_bands, value_expr, class_conds, mask_clouds, extra_mask="true"):
    """Evalscript emitting value, per-class 0/1 bands and a data mask."""
    bands = list(input_bands) + (["SCL"] if mask_clouds else []) + ["dataMask"]
    classes = ", ".join(f"({c}) ? 1 : 0" for c in class_conds) or "0"
    hidden = f"{json.dumps(S2_HIDDEN_SCL)}.indexOf(s.SCL) >= 0" if mask_clouds else "false"
    return f"""//VERSION=3
function setup() {{
  return {{
    input: [{{ bands: {json.dumps(bands)} }}],
    output: [
      {{ id: "value", bands: 1, sampleType: "FLOAT32" }},
      {{ id: "classes", bands: {max(len(class_conds), 1)}, sampleType: "FLOAT32" }},
      {{ id: "dataMask", bands: 1 }}
    ]
  }};
}}
function evaluatePixel(s) {{
  var v = {value_expr};
  var ok = s.dataMask === 1 && !({hidden}) && isFinite(v) && ({extra_mask});
  return {{ value: [v], classes: [{classes}], dataMask: [ok ? 1 : 0] }};
}}"""


def _index_spec(input_bands, expr, value_header, value_digits, classes, level_header,
                level_fn, describe, area=None):
    """
    Sentinel-2 index product (NDVI, NDWI, …) with clouds masked out.

    classes   [(header, js condition on v / s)], shares of the visible area.
    level_fn  f(mean, shares) -> overall label.
    describe  f(level, mean, shares) -> summary sentence.
    area      (header, class index): estimated km² for that class.
    """
    headers = [value_header, level_header] + [h for h, _ in classes]
    if area:
        headers.append(area[0])

    def build(outputs, ctx):
        mean = _num(_stats(outputs, "value").get("mean"))
        shares = [_num(_stats(outputs, "classes", i).get("mean")) for i in range(len(classes))]
        shares = [None if s is None else 100 * s for s in shares]
        level = level_fn(mean, shares)
        cols = OrderedDict([(value_header, _round(mean, value_digits)), (level_header, level)])
        for (header, _), share in zip(classes, shares):
            cols[header] = _round(share, 1)
        if area:
            share = shares[area[1]]
            cols[area[0]] = _round(None if share is None else share / 100 * ctx["aoi_km2"], 2)
        return cols, describe(level, mean, shares)

    return Spec(
        _class_script(input_bands, expr, [c for _, c in classes], mask_clouds=True),
        headers, build, coverage="clouds", native_m=10,
        data_filter={"maxCloudCoverage": 80},
    )


def _sentence(text):
    return text[:1].upper() + text[1:] if text else text


def _pct(v):
    """Share for summary sentences; tiny non-zero shares don't round up to 1%."""
    if v is None:
        return "?"
    if 0 < v < 1:
        return "under 1%"
    return f"{v:.0f}%"


# --- Vegetation (NDVI / EVI) --------------------------------------------
def _vegetation_spec(input_bands, expr, value_header, breaks):
    dense, moderate, sparse = breaks
    levels = [(dense, "Dense and healthy"), (moderate, "Moderate"),
              (sparse, "Sparse or stressed"), (NEG_INF, "Very low (bare soil, buildings or water)")]
    return _index_spec(
        input_bands, expr, value_header, 2,
        classes=[
            ("Dense, healthy vegetation (% of visible area)", f"v >= {dense}"),
            ("Moderate vegetation (% of visible area)", f"v >= {moderate} && v < {dense}"),
            ("Sparse or stressed vegetation (% of visible area)", f"v >= {sparse} && v < {moderate}"),
            ("No vegetation – bare soil, buildings or water (% of visible area)", f"v < {sparse}"),
        ],
        level_header="Overall vegetation health",
        level_fn=lambda mean, shares: _level(mean, levels),
        describe=lambda level, mean, s: (
            f"Vegetation is {level.lower()} on average: {_pct(s[0])} of the visible land is dense, "
            f"healthy vegetation, {_pct(s[1])} moderate and {_pct(s[3])} has none."),
    )


NDVI = _vegetation_spec(["B04", "B08"], "(s.B08 - s.B04) / (s.B08 + s.B04)",
                        "Average vegetation index (NDVI, −1 to 1)", (0.6, 0.4, 0.2))

# EVI is clipped to −1…1: near-zero denominators (water, shadow edges)
# otherwise produce huge outliers that swamp the average.
EVI = _vegetation_spec(
    ["B02", "B04", "B08"],
    "Math.max(-1, Math.min(1, 2.5 * (s.B08 - s.B04) / (s.B08 + 6 * s.B04 - 7.5 * s.B02 + 1)))",
    "Average enhanced vegetation index (EVI, −1 to 1)", (0.45, 0.25, 0.1))

# --- Water (NDWI) --------------------------------------------------------
NDWI = _index_spec(
    ["B03", "B08"], "(s.B03 - s.B08) / (s.B03 + s.B08)",
    "Average water index (NDWI, −1 to 1)", 2,
    classes=[
        ("Open water (% of visible area)", "v >= 0.2"),
        ("Wet ground or shallow water (% of visible area)", "v >= 0 && v < 0.2"),
        ("Dry land (% of visible area)", "v < 0"),
    ],
    level_header="Water presence",
    level_fn=lambda mean, s: _level(s[0], [(50, "Mostly water"), (10, "Some open water"),
                                           (1, "A little open water"), (NEG_INF, "Little or no open water")]),
    describe=lambda level, mean, s: (
        f"{level}: {_pct(s[0])} of the visible area is open water and "
        f"{_pct(s[1])} is wet ground or shallow water."),
    area=("Estimated open-water area (km²)", 0),
)

# --- Built-up (NDBI) -----------------------------------------------------
NDBI = _index_spec(
    ["B08", "B11"], "(s.B11 - s.B08) / (s.B11 + s.B08)",
    "Average built-up index (NDBI, −1 to 1)", 2,
    classes=[
        ("Built-up or bare ground (% of visible area)", "v > 0.1"),
        ("Mixed – partly built-up (% of visible area)", "v >= 0 && v <= 0.1"),
        ("Vegetation or water (% of visible area)", "v < 0"),
    ],
    level_header="Built-up level",
    level_fn=lambda mean, s: _level(s[0], [(50, "Mostly built-up or bare"), (20, "Partly built-up"),
                                           (NEG_INF, "Mostly natural or vegetated")]),
    describe=lambda level, mean, s: (
        f"{level}: {_pct(s[0])} of the visible area is built-up or bare ground and "
        f"{_pct(s[2])} is vegetation or water."),
    area=("Estimated built-up or bare area (km²)", 0),
)

# --- Snow (NDSI) ---------------------------------------------------------
# High NDSI alone also flags water; requiring a bright green band keeps
# snow (bright) and drops water (dark).
NDSI = _index_spec(
    ["B03", "B11"], "(s.B03 - s.B11) / (s.B03 + s.B11)",
    "Average snow index (NDSI, −1 to 1)", 2,
    classes=[
        ("Snow or ice (% of visible area)", "v >= 0.4 && s.B03 > 0.15"),
        ("No snow (% of visible area)", "!(v >= 0.4 && s.B03 > 0.15)"),
    ],
    level_header="Snow cover",
    level_fn=lambda mean, s: _level(s[0], [(50, "Mostly snow-covered"), (10, "Partly snow-covered"),
                                           (1, "Patches of snow"), (NEG_INF, "No snow")]),
    describe=lambda level, mean, s: f"{level}: {_pct(s[0])} of the visible area is snow or ice.",
    area=("Estimated snow-covered area (km²)", 0),
)

# --- True colour photo (land-cover breakdown from scene classification) --
_TC_CLASSES = [
    ("Clouds (% of area)", "[8, 9, 10].indexOf(s.SCL) >= 0", "clouds"),
    ("Cloud shadows (% of area)", "s.SCL === 3", "cloud shadow"),
    ("Vegetation (% of area)", "s.SCL === 4", "vegetation"),
    ("Bare soil or built-up (% of area)", "s.SCL === 5", "bare soil or built-up land"),
    ("Water (% of area)", "s.SCL === 6", "water"),
    ("Snow or ice (% of area)", "s.SCL === 11", "snow or ice"),
]


def _truecolor_build(outputs, ctx):
    shares = [_num(_stats(outputs, "classes", i).get("mean")) for i in range(len(_TC_CLASSES))]
    shares = [None if s is None else 100 * s for s in shares]
    cols = OrderedDict((h, _round(s, 1)) for (h, _, _), s in zip(_TC_CLASSES, shares))
    ground = [(s or 0, name) for s, (_, _, name) in zip(shares[2:], _TC_CLASSES[2:])]
    top_share, top_name = max(ground)
    clouds = (shares[0] or 0) + (shares[1] or 0)
    ctx["visible_pct"] = max(0.0, 100.0 - clouds)       # clouds are part of the photo
    if top_share < 1:
        return cols, "The ground is not visible in this photo."
    summary = f"The photo mostly shows {top_name} ({top_share:.0f}% of your area)."
    if clouds >= 5:
        summary += f" Clouds and their shadows cover {clouds:.0f}%."
    return cols, summary


TRUE_COLOR = Spec(
    _class_script(["SCL"], "1", [c for _, c, _ in _TC_CLASSES], mask_clouds=False,
                  extra_mask="s.SCL !== 0"),
    [h for h, _, _ in _TC_CLASSES], _truecolor_build,
    coverage="clouds", native_m=10, data_filter={"maxCloudCoverage": 80},
    clouds_are_content=True,
)

# --- Radar ---------------------------------------------------------------
# Calm water reflects radar away from the satellite, so it shows up very dark
# (VV below about −18 dB); buildings and metal act as corner reflectors and
# come back very bright (above about 0 dB).
_RADAR_SCRIPT = """//VERSION=3
function setup() {
  return {
    input: [{ bands: ["VV", "VH", "dataMask"] }],
    output: [
      { id: "value", bands: 2, sampleType: "FLOAT32" },
      { id: "classes", bands: 2, sampleType: "FLOAT32" },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(s) {
  var vv = 10 * Math.log(s.VV) / Math.LN10;
  var vh = 10 * Math.log(s.VH) / Math.LN10;
  var ok = s.dataMask === 1 && isFinite(vv) && isFinite(vh);
  return { value: [vv, vh], classes: [vv < -18 ? 1 : 0, vv > 0 ? 1 : 0], dataMask: [ok ? 1 : 0] };
}"""


def _radar_build(outputs, ctx):
    vv = _num(_stats(outputs, "value", 0).get("mean"))
    vh = _num(_stats(outputs, "value", 1).get("mean"))
    water = _num(_stats(outputs, "classes", 0).get("mean"))
    strong = _num(_stats(outputs, "classes", 1).get("mean"))
    water = None if water is None else 100 * water
    strong = None if strong is None else 100 * strong
    level = _level(water, [(50, "Mostly water or flooded"), (10, "Some water or flooding"),
                           (1, "A little water"), (NEG_INF, "No water detected")])
    cols = OrderedDict([
        ("Water detected", level),
        ("Likely water or flooded land (% of area)", _round(water, 1)),
        ("Estimated water area (km²)", _round(None if water is None else water / 100 * ctx["aoi_km2"], 2)),
        ("Strong reflectors, e.g. buildings (% of area)", _round(strong, 1)),
        ("Average radar signal, VV (dB)", _round(vv, 1)),
        ("Average radar signal, VH (dB)", _round(vh, 1)),
    ])
    return cols, _sentence(f"{_pct(water)} of your area looks like open water or flooded land, and "
                           f"{_pct(strong)} returns very strong signals typical of buildings "
                           f"(radar sees through clouds).")


RADAR = Spec(_RADAR_SCRIPT, [
    "Water detected", "Likely water or flooded land (% of area)", "Estimated water area (km²)",
    "Strong reflectors, e.g. buildings (% of area)",
    "Average radar signal, VV (dB)", "Average radar signal, VH (dB)",
], _radar_build, coverage="data", native_m=10)

# --- Thermal (SLSTR brightness temperature, S8 ≈ 10.8 µm) ----------------
_THERMAL_LEVELS = [(40, "Very hot"), (30, "Hot"), (20, "Warm"), (10, "Mild"),
                   (0, "Cool"), (NEG_INF, "Freezing")]


def _thermal_build(outputs, ctx):
    st = _stats(outputs, "value")
    mean, lo, hi = _num(st.get("mean")), _num(st.get("min")), _num(st.get("max"))
    level = _level(mean, _THERMAL_LEVELS)
    cols = OrderedDict([
        ("Average surface temperature (°C, approx.)", _round(mean, 1)),
        ("Temperature level", level),
        ("Coolest spot (°C)", _round(lo, 1)),
        ("Hottest spot (°C)", _round(hi, 1)),
    ])
    summary = f"Average surface temperature about {mean:.0f} °C ({level.lower()})." if mean is not None else ""
    if lo is not None and lo < -10:
        summary += " Very cold readings usually come from cloud tops, not the ground."
    return cols, summary


THERMAL = Spec(
    _class_script(["S8"], "s.S8 - 273.15", [], mask_clouds=False),
    ["Average surface temperature (°C, approx.)", "Temperature level",
     "Coolest spot (°C)", "Hottest spot (°C)"],
    _thermal_build, coverage="data", native_m=1000, data_filter={"maxCloudCoverage": 80},
)


# --- Air quality (Sentinel-5P) -------------------------------------------
def _gas_spec(band, s5p_type, name, unit, factor, digits, levels, about):
    unit_suffix = f" ({unit})" if unit else ""
    header = f"Average {name}{unit_suffix}"
    peak_header = f"Highest reading in your area{unit_suffix}"

    def build(outputs, ctx):
        st = _stats(outputs, "value")
        mean, hi = _num(st.get("mean")), _num(st.get("max"))
        mean = None if mean is None else mean * factor
        hi = None if hi is None else hi * factor
        level = _level(mean, levels)
        cols = OrderedDict([
            (header, _round(mean, digits)),
            ("Level (indicative)", level),
            (peak_header, _round(hi, digits)),
        ])
        summary = ""
        if mean is not None:
            reading = f"{mean:.{digits}f} {unit}".strip()
            summary = f"{_sentence(name)}: {reading} — {level.lower()}. {about}"
        return cols, summary

    return Spec(
        _class_script([band], f"s.{band}", [], mask_clouds=False),
        [header, "Level (indicative)", peak_header],
        build, coverage="data", native_m=5500,
        # Mirrors fetch_product(), so the numbers describe what "Fetch" returns
        data_filter={"mosaickingOrder": "mostRecent", "timeliness": "OFFL"},
        processing={"minQa": 50},
        catalog_filter=f"s5p:type = '{s5p_type}'",
        # Offline-quality 5P data is published a few days after each pass
        publish_lag_days=7,
        no_valid_note="No reliable reading over your area on this date (often because of heavy cloud).",
    )


DOBSON = 1 / 4.4615e-4      # mol/m² → Dobson units

# Sentinel-5P gases: band, catalog type, display name, unit, factor from the
# band's native unit, decimals, indicative levels, and where the gas comes
# from. Shared with the carbon report's air indicators.
GASES = {
    "NO2": dict(band="NO2", s5p_type="NO2", name="nitrogen dioxide (NO₂)", unit="µmol/m²",
                factor=1e6, digits=1,
                levels=[(150, "Very high"), (80, "High"), (40, "Moderate"), (NEG_INF, "Low")],
                about="NO₂ mainly comes from traffic, power plants and industry."),
    "CH4": dict(band="CH4", s5p_type="CH4", name="methane (CH₄)", unit="ppb",
                factor=1, digits=0,
                levels=[(2020, "High"), (1960, "Elevated"), (1900, "Typical"), (NEG_INF, "Below typical")],
                about="Methane comes from farming, landfills, wetlands and gas leaks."),
    "CO": dict(band="CO", s5p_type="CO", name="carbon monoxide (CO)", unit="mmol/m²",
               factor=1e3, digits=1,
               levels=[(55, "High"), (40, "Elevated"), (NEG_INF, "Normal")],
               about="CO comes from fires, traffic and burning fuel."),
    "O3": dict(band="O3", s5p_type="O3", name="total ozone (O₃)", unit="Dobson units",
               factor=DOBSON, digits=0,
               levels=[(340, "Above normal"), (260, "Normal"), (220, "Below normal"),
                       (NEG_INF, "Very low (ozone-hole level)")],
               about="Most of this ozone is in the protective ozone layer high above the ground."),
    "SO2": dict(band="SO2", s5p_type="SO2", name="sulfur dioxide (SO₂)", unit="Dobson units",
                factor=DOBSON, digits=2,
                levels=[(2, "High (industrial or volcanic)"), (0.5, "Elevated"), (NEG_INF, "Background")],
                about="SO₂ comes from burning coal and oil, smelters and volcanoes."),
    "AER_AI": dict(band="AER_AI_340_380", s5p_type="AER_AI", name="aerosol index (smoke/dust)", unit="",
                   factor=1, digits=2,
                   levels=[(3, "Heavy smoke or dust"), (1.5, "Hazy"), (0.5, "Light haze"), (NEG_INF, "Clean air")],
                   about="Higher values mean more smoke, dust or ash in the air."),
}

PRODUCT_SPECS = {
    "1": TRUE_COLOR,
    "2": NDVI,
    "3": NDWI,
    "4": NDBI,
    "5": NDSI,
    "6": EVI,
    "7": RADAR,
    # "8" OLCI true colour: a photo with no reliable per-pixel cloud mask here,
    # so it gets the plain scene columns only.
    "9": THERMAL,
    "10": _gas_spec(**GASES["NO2"]),
    "11": _gas_spec(**GASES["CH4"]),
    "12": _gas_spec(**GASES["CO"]),
    "13": _gas_spec(**GASES["O3"]),
    "14": _gas_spec(**GASES["SO2"]),
    "15": _gas_spec(**GASES["AER_AI"]),
}


def catalog_filter_for(product_id):
    """Extra catalog filter so the search only returns relevant scenes."""
    spec = PRODUCT_SPECS.get(product_id)
    return spec.catalog_filter if spec else None


def matches_product(scene, product_id):
    """Local fallback for catalog_filter_for (e.g. if the catalog rejects it)."""
    spec = PRODUCT_SPECS.get(product_id)
    m = spec and spec.catalog_filter and re.search(r"s5p:type = '(\w+)'", spec.catalog_filter)
    return not m or scene.get("properties", {}).get("s5p:type") == m.group(1)


# ---------------------------------------------------------------------
# Statistical API
# ---------------------------------------------------------------------
def fetch_daily_stats(token, collection, spec, bbox, date_from, date_to):
    """Return {"YYYY-MM-DD": outputs} for every day with data in the range."""
    west, south, east, north = bbox
    width_m = (east - west) * 111_320 * math.cos(math.radians((south + north) / 2))
    height_m = (north - south) * 110_570
    # Sample at native resolution, but between 16 and 256 pixels per side:
    # enough for stable percentages, cheap in processing units.
    nx = min(256, max(16, math.ceil(width_m / spec.native_m)))
    ny = min(256, max(16, math.ceil(height_m / spec.native_m)))

    # End at midnight after the last day: the API silently skips a final
    # interval shorter than a full day, which would drop the newest date.
    day_after = (date.fromisoformat(date_to) + timedelta(days=1)).isoformat()
    time_range = {"from": f"{date_from}T00:00:00Z", "to": f"{day_after}T00:00:00Z"}
    data = {"type": collection, "dataFilter": {"timeRange": time_range, **spec.data_filter}}
    if spec.processing:
        data["processing"] = spec.processing

    payload = {
        "input": {"bounds": {"bbox": bbox}, "data": [data]},
        "aggregation": {
            "timeRange": time_range,
            "aggregationInterval": {"of": "P1D"},
            "evalscript": spec.evalscript,
            "resx": (east - west) / nx,
            "resy": (north - south) / ny,
        },
        "calculations": {"default": {"statistics": {"default": {}}}},
    }
    response = requests.post(STATS_URL, json=payload,
                             headers={"Authorization": f"Bearer {token}"}, timeout=120)
    if not response.ok:
        print("Statistical API error:", response.status_code, response.text[:500])
    response.raise_for_status()

    by_day = {}
    for interval in response.json().get("data", []):
        if "outputs" in interval and "error" not in interval:
            by_day[interval["interval"]["from"][:10]] = interval["outputs"]
    return by_day


# ---------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------
QUALITY_LEVELS = [(80, "Good"), (40, "Fair"), (MIN_VISIBLE_PCT, "Poor"), (NEG_INF, "No usable data")]


def build_report(token, product_id, product, bbox, scenes):
    """
    Turn catalog scenes into readable CSV rows, one per acquisition date.

    Returns (fieldnames, rows, measured) — measured is False when the
    Statistical API call failed and only the scene details could be listed.
    """
    spec = PRODUCT_SPECS.get(product_id)
    optical = spec is not None and spec.coverage == "clouds"
    coverage_header = ("Cloud-free part of your area (%)" if optical
                       else "Part of your area with valid data (%)")

    # Group the catalog's per-tile entries into one row per UTC date
    dates = OrderedDict()
    for scene in sorted(scenes, key=lambda s: s.get("properties", {}).get("datetime", ""), reverse=True):
        props = scene.get("properties", {})
        day = (props.get("datetime") or "")[:10]
        if day:
            dates.setdefault(day, []).append(scene)

    stats, stats_error = {}, None
    if spec and dates:
        try:
            stats = fetch_daily_stats(token, product["collection"], spec, bbox,
                                      min(dates), max(dates))
        except Exception as e:           # never fail the search over the report
            stats_error = str(e)

    ctx_base = {"aoi_km2": aoi_area_km2(bbox)}
    measure_cols = spec.columns if spec else []

    rows = []
    for day, day_scenes in dates.items():
        props = [s.get("properties", {}) for s in day_scenes]
        times = sorted(p.get("datetime", "")[11:16] for p in props if p.get("datetime"))
        tile_clouds = [p["eo:cloud_cover"] for p in props if p.get("eo:cloud_cover") is not None]
        gsd = next((p.get("gsd") for p in props if p.get("gsd") is not None), "")

        row = OrderedDict([
            ("Date", day),
            ("Time (UTC)", times[0] if times else ""),
            ("Satellite", " + ".join(sorted({short_platform(p.get("platform")) for p in props} - {""}))),
            (coverage_header, ""),
            ("Data quality", ""),
        ])
        for col in measure_cols:
            row[col] = ""

        summary = ""
        outputs = stats.get(day)
        if not spec:
            summary = "Photo product — open the image to see the area."
        elif stats_error:
            summary = "Measurements could not be calculated right now; scene details are listed."
        elif outputs is None:
            recent = (date.today() - date.fromisoformat(day)).days <= spec.publish_lag_days
            row["Data quality"] = "Not published yet" if recent else "No data"
            summary = ("Measurements for this date aren't published yet — they usually "
                       "appear a few days after the satellite pass."
                       if recent else "No measurement available for this date.")
        else:
            ctx = dict(ctx_base)
            ctx["visible_pct"] = _valid_pct(_stats(outputs, "value"))
            values, summary = spec.build(outputs, ctx)
            visible = ctx["visible_pct"]         # build() may refine it (true colour)

            row[coverage_header] = round(visible, 1)
            row["Data quality"] = _level(visible, QUALITY_LEVELS)
            if visible >= MIN_VISIBLE_PCT or spec.clouds_are_content:
                row.update(values)
                if optical and not spec.clouds_are_content and visible < 95:
                    summary += f" Clouds hid {100 - visible:.0f}% of your area."
                elif not optical and visible < 95:
                    summary += f" Valid readings cover only {visible:.0f}% of your area."
            elif optical:
                summary = ("Too cloudy to measure — your area was completely hidden."
                           if visible < 0.5 else
                           f"Too cloudy to measure — only {visible:.0f}% of your area was visible.")
            else:
                summary = spec.no_valid_note

        row["Summary"] = summary
        if tile_clouds:
            row["Cloud cover of the full satellite image (%)"] = round(sum(tile_clouds) / len(tile_clouds), 1)
        row["Pixel size (m)"] = gsd
        row["Scene ID(s)"] = "; ".join(s.get("id", "") for s in day_scenes)
        rows.append(row)

    fieldnames = (["Date", "Time (UTC)", "Satellite", coverage_header, "Data quality"]
                  + list(measure_cols) + ["Summary"])
    if any("Cloud cover of the full satellite image (%)" in r for r in rows):
        fieldnames.append("Cloud cover of the full satellite image (%)")
    fieldnames += ["Pixel size (m)", "Scene ID(s)"]

    return fieldnames, rows, stats_error is None


def write_report_csv(fieldnames, rows, csv_path):
    # utf-8-sig: the BOM makes Excel show °C, km², µ and subscripts correctly
    with open(csv_path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
