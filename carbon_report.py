"""
Carbon footprint report for a district, from Climate TRACE.

Footprints are reported per district (the level Climate TRACE publishes
area-wide sectors like homes, road transport and farming at). A drawn
rectangle is used to find which district(s) it covers, by real boundary
overlap rather than the API's loose bounding-box match.

Sectors are grouped into plain categories for non-specialists. The report
covers emissions only — carbon sinks are out of scope — so:

- The land carbon-balance sectors are excluded (see LAND_BALANCE_SECTORS).
  They're net fluxes that swing between uptake and release, "removals" is
  the sum of the other three (keeping both double-counts), and Climate
  TRACE hasn't published them for the latest year, which would distort
  year-on-year changes.
- Any other negative value is dropped rather than subtracted.

Direct land-use emissions (forest clearing and fires, wetland fires, soil
carbon loss from farmland) are kept.
"""

import csv
import os
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime

import climate_trace as ct

# How far back to look for yearly data; years the API has no data for are
# dropped automatically (Climate TRACE district data currently starts 2021).
YEARS_BACK = 6

# Ignore districts covering less than this share of a drawn rectangle
MIN_OVERLAP_PCT = 0.5

SOURCE_CREDIT = "Emissions data: Climate TRACE (climatetrace.org)"

# Climate TRACE sector slug → plain category
CATEGORIES = {
    "Power & heat": [
        "electricity-generation", "heat-plants", "other-energy-use",
    ],
    "Homes & buildings": [
        "residential-onsite-fuel-usage", "non-residential-onsite-fuel-usage",
        "other-onsite-fuel-usage",
    ],
    "Road transport": ["road-transportation"],
    "Aviation": ["domestic-aviation", "international-aviation"],
    "Rail & shipping": [
        "railways", "domestic-shipping", "international-shipping",
        "non-broadcasting-vessels", "other-transport",
    ],
    "Industry": [
        "aluminum", "cement", "chemicals", "other-chemicals", "petrochemical-steam-cracking",
        "food-beverage-tobacco", "glass", "iron-and-steel", "lime", "other-manufacturing",
        "other-metals", "pulp-and-paper", "textiles-leather-apparel",
        "wood-and-wood-products", "fluorinated-gases",
    ],
    "Fossil fuels & mining": [
        "coal-mining", "oil-and-gas-production", "oil-and-gas-refining",
        "oil-and-gas-transport", "other-fossil-fuel-operations", "other-solid-fuels",
        "bauxite-mining", "copper-mining", "iron-mining", "other-mining-quarrying",
        "rock-quarrying", "sand-quarrying",
    ],
    "Agriculture & livestock": [
        "enteric-fermentation-cattle-operation", "enteric-fermentation-cattle-pasture",
        "enteric-fermentation-other", "manure-applied-to-soils", "manure-left-on-pasture-cattle",
        "manure-management-cattle-operation", "manure-management-other",
        "rice-cultivation", "synthetic-fertilizer-application",
        "other-agricultural-soil-emissions", "crop-residues", "cropland-fires",
    ],
    "Waste": [
        "solid-waste-disposal", "domestic-wastewater-treatment-and-discharge",
        "industrial-wastewater-treatment-and-discharge",
        "incineration-and-open-burning-of-waste",
        "biological-treatment-of-solid-waste-and-biogenic",
    ],
    "Forestry & land use": [
        "forest-land-clearing", "forest-land-degradation", "forest-land-fires",
        "shrubgrass-fires", "wetland-fires", "net-soil-organic-carbon", "water-reservoirs",
    ],
}
OTHER = "Other"

# Net carbon balance of forests, grassland and wetlands, plus their total
# ("removals" = the sum of the other three). Excluded — see module docstring.
LAND_BALANCE_SECTORS = {"removals", "net-forest-land", "net-shrubgrass", "net-wetland"}
_CATEGORY_OF = {slug: cat for cat, slugs in CATEGORIES.items() for slug in slugs}

# Friendlier names for the sectors people see most; others are prettified
SECTOR_NAMES = {
    "electricity-generation": "Power stations",
    "residential-onsite-fuel-usage": "Fuel burned in homes (cooking, heating)",
    "non-residential-onsite-fuel-usage": "Fuel burned in shops, offices and public buildings",
    "other-onsite-fuel-usage": "Other fuel burned in buildings",
    "road-transportation": "Cars, trucks and buses",
    "domestic-aviation": "Domestic flights",
    "international-aviation": "International flights",
    "enteric-fermentation-cattle-operation": "Cattle digestion (farms)",
    "enteric-fermentation-cattle-pasture": "Cattle digestion (pasture)",
    "enteric-fermentation-other": "Digestion of other livestock",
    "solid-waste-disposal": "Landfills",
    "domestic-wastewater-treatment-and-discharge": "Household sewage",
    "industrial-wastewater-treatment-and-discharge": "Industrial wastewater",
    "incineration-and-open-burning-of-waste": "Burning of waste",
    "rice-cultivation": "Rice paddies",
    "synthetic-fertilizer-application": "Chemical fertilisers",
    "net-soil-organic-carbon": "Soil carbon loss from farmland",
    "iron-and-steel": "Iron and steel plants",
    "cement": "Cement plants",
    "oil-and-gas-refining": "Oil refineries",
}


def sector_name(slug):
    return SECTOR_NAMES.get(slug) or slug.replace("-", " ").capitalize()


# ---------------------------------------------------------------------
# Rectangle → districts (real boundary overlap)
# ---------------------------------------------------------------------
def _clip_ring(ring, bbox):
    """Clip a polygon ring to an axis-aligned rectangle (Sutherland–Hodgman)."""
    w, s, e, n = bbox
    edges = [
        (lambda p: p[0] >= w, lambda a, b: (w, a[1] + (b[1] - a[1]) * (w - a[0]) / (b[0] - a[0]))),
        (lambda p: p[0] <= e, lambda a, b: (e, a[1] + (b[1] - a[1]) * (e - a[0]) / (b[0] - a[0]))),
        (lambda p: p[1] >= s, lambda a, b: (a[0] + (b[0] - a[0]) * (s - a[1]) / (b[1] - a[1]), s)),
        (lambda p: p[1] <= n, lambda a, b: (a[0] + (b[0] - a[0]) * (n - a[1]) / (b[1] - a[1]), n)),
    ]
    out = [tuple(p[:2]) for p in ring]
    for inside, cross in edges:
        src, out = out, []
        for i, cur in enumerate(src):
            prev = src[i - 1]
            if inside(cur):
                if not inside(prev):
                    out.append(cross(prev, cur))
                out.append(cur)
            elif inside(prev):
                out.append(cross(prev, cur))
        if not out:
            break
    return out


def _ring_area(ring):
    return abs(sum(ring[i][0] * ring[i - 1][1] - ring[i - 1][0] * ring[i][1]
                   for i in range(len(ring)))) / 2


def _overlap_area(geometries, bbox):
    """Area (in degrees², fine for shares) of the geometries inside bbox."""
    total = 0.0
    for geom in geometries:
        polygons = [geom["coordinates"]] if geom["type"] == "Polygon" else geom["coordinates"]
        for rings in polygons:
            if not rings:
                continue
            total += _ring_area(_clip_ring(rings[0], bbox))
            total -= sum(_ring_area(_clip_ring(hole, bbox)) for hole in rings[1:])
    return max(total, 0.0)


def _describe_admin(admin):
    """{"id", "name", "state", "full_name"} from an API admin record."""
    full = admin.get("FullName") or admin.get("Name", "")
    parts = [p.strip() for p in full.split(",")]
    return {
        "id": admin["Id"],
        "name": admin.get("Name") or parts[0],
        "state": parts[1] if len(parts) > 2 else "",
        "full_name": full,
    }


def districts_for_bbox(bbox):
    """Districts covering a rectangle, largest share first, with overlap %."""
    candidates = ct.search_admins(bbox=bbox, level=2)
    box_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
    if not candidates or box_area <= 0:
        return []

    def overlap(admin):
        return 100.0 * _overlap_area(ct.admin_geometries(admin["Id"]), bbox) / box_area

    with ThreadPoolExecutor(max_workers=6) as pool:
        shares = list(pool.map(overlap, candidates))

    districts = [dict(_describe_admin(a), overlap_pct=round(p, 1))
                 for a, p in zip(candidates, shares) if p >= MIN_OVERLAP_PCT]
    return sorted(districts, key=lambda d: -d["overlap_pct"])


def search_districts(name, limit=10):
    """District suggestions for a typed name (GADM spellings, e.g. "Ahmadabad")."""
    return [_describe_admin(a) for a in ct.search_admins(name=name, level=2, limit=limit)]


# ---------------------------------------------------------------------
# Footprint
# ---------------------------------------------------------------------
def _yearly_emissions(admin_id):
    """{year: {sector: tonnes}} for every recent year with data."""
    this_year = date.today().year
    years = list(range(this_year - YEARS_BACK, this_year + 1))
    with ThreadPoolExecutor(max_workers=len(years)) as pool:
        results = list(pool.map(lambda y: ct.admin_emissions(admin_id, y), years))
    # Emissions only: no land carbon balance, no negative (uptake) values
    return {y: {s: v for s, v in r.items() if s not in LAND_BALANCE_SECTORS and v > 0}
            for y, r in zip(years, results) if r}


def _fmt_tonnes(t):
    if t >= 1e6:
        return f"{t / 1e6:.2f} million tonnes"
    if t >= 1e3:
        return f"{t / 1e3:,.0f} thousand tonnes"
    return f"{t:,.0f} tonnes"


def _pct_change(new, old):
    return None if not old else round(100.0 * (new - old) / old, 1)


def build_footprint(admin_id, year=None):
    """
    Footprint of one district.

    Returns a JSON-ready dict: district, yearly totals (the current year
    flagged partial), the chosen full year broken down by category and
    sector, change vs the previous year, and a plain-language summary.
    """
    admin = _describe_admin(ct.get_admin(admin_id))
    yearly = _yearly_emissions(admin_id)
    if not yearly:
        raise LookupError(f"Climate TRACE has no emissions data for {admin['full_name']}.")

    this_year = date.today().year
    full_years = sorted(y for y in yearly if y < this_year)
    partial_year = this_year if this_year in yearly else None
    if year is None or year not in yearly or year == partial_year:
        year = full_years[-1] if full_years else partial_year

    sectors = yearly[year]
    total = sum(sectors.values())
    previous = yearly.get(year - 1)
    change = _pct_change(total, sum(previous.values())) if previous else None

    categories = {}
    for slug, tonnes in sectors.items():
        categories.setdefault(_CATEGORY_OF.get(slug, OTHER), []).append((slug, tonnes))
    category_list = []
    for cat, items in categories.items():
        cat_total = sum(t for _, t in items)
        category_list.append({
            "name": cat,
            "tonnes": round(cat_total),
            "share_pct": round(100 * cat_total / total, 1),
            "sectors": [
                {"sector": slug, "label": sector_name(slug), "tonnes": round(t),
                 "share_pct": round(100 * t / total, 1)}
                for slug, t in sorted(items, key=lambda x: -x[1])
            ],
        })
    category_list.sort(key=lambda c: -c["tonnes"])

    years = [{"year": y, "tonnes": round(sum(yearly[y].values())), "partial": y == partial_year}
             for y in sorted(yearly)]

    return {
        "district": admin,
        "year": year,
        "tonnes": round(total),
        "change_pct": change,
        "years": years,
        "categories": category_list,
        "summary": _summary(admin["name"], year, total, change, category_list, yearly, partial_year),
        "source": SOURCE_CREDIT,
        "_yearly": yearly,           # for the CSV writer; stripped from the API response
    }


def _change_driver(yearly, year):
    """The sector behind most of a noticeable year-on-year change, as text."""
    now, before = yearly.get(year, {}), yearly.get(year - 1, {})
    deltas = {s: now.get(s, 0) - before.get(s, 0) for s in set(now) | set(before)}
    if not deltas:
        return ""
    sector, delta = max(deltas.items(), key=lambda kv: abs(kv[1]))
    net = sum(deltas.values())
    # Only explain changes of 3%+ that one sector clearly accounts for
    if abs(net) < 0.03 * sum(before.values()) or delta * net <= 0 or abs(delta) < 0.5 * abs(net):
        return ""
    verb = "rose" if delta > 0 else "fell"
    return f", mainly because {sector_name(sector).lower()} {verb} by {_fmt_tonnes(abs(delta))}"


def _summary(name, year, total, change, categories, yearly, partial_year):
    text = f"{name} emitted about {_fmt_tonnes(total)} of CO₂-equivalent in {year}"
    if change is not None:
        direction = "up" if change > 0 else "down"
        text += (f", {direction} {abs(change):.1f}% from {year - 1}{_change_driver(yearly, year)}"
                 if abs(change) >= 0.1 else f", about the same as {year - 1}")
    top = [f"{c['name'].lower()} ({c['share_pct']:.0f}%)" for c in categories[:3]]
    if top:
        text += ". The largest sources were " + (", ".join(top[:-1]) + " and " + top[-1] if len(top) > 1 else top[0])
    text += "."
    if partial_year and partial_year != year:
        text += (f" Data for {partial_year} so far covers only part of the year "
                 f"({_fmt_tonnes(sum(yearly[partial_year].values()))}).")
    return text


# ---------------------------------------------------------------------
# Facilities (named emission sources)
# ---------------------------------------------------------------------
TOP_FACILITIES = 50                      # listed in the API response; the CSV has all
_CODE_NAME = re.compile(r"^[A-Z]{3}_[A-Za-z]+_\d+$")      # e.g. IND_MatureDairyCattle_5854


def _facility_name(asset):
    name = asset.get("Name") or ""
    if "dairycattle" in (asset.get("AssetType") or "").lower() or "DairyCattle" in name:
        return "Dairy cattle farm"
    if _CODE_NAME.match(name):
        return f"{sector_name(asset.get('Sector', ''))} site"
    return name


def _asset_tonnes(asset):
    return sum(float(e.get("EmissionsQuantity") or 0)
               for e in asset.get("EmissionsSummary") or [] if e.get("Gas") == ct.GAS)


def _asset_confidence(asset, year):
    """Climate TRACE's confidence in the asset's total CO₂e for that year."""
    for entry in asset.get("Confidence") or []:
        values = entry.get(str(year))
        if values:
            return values[0].get("total_co2e_100yrgwp")
    return None


def build_facilities(districts, bbox, year, main_district_id, main_total):
    """
    Named emission sources in the area for one year: merged per site,
    ranked by emissions, limited to the rectangle when one is given.

    Sources Climate TRACE models for the whole district at once (homes,
    roads, …) are skipped — they're not facilities, and they're already in
    the district's category totals.
    """
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda d: (d, ct.admin_assets(d["id"], year)), districts))

    sites, truncated = {}, False
    for district, (assets, cut) in results:
        truncated |= cut
        for a in assets:
            if a.get("Name") == district["name"] or a.get("Sector") in LAND_BALANCE_SECTORS:
                continue
            point = (a.get("Centroid") or {}).get("Geometry") or []
            if len(point) != 2:
                continue
            lon, lat = point
            if bbox and not (bbox[0] <= lon <= bbox[2] and bbox[1] <= lat <= bbox[3]):
                continue
            tonnes = _asset_tonnes(a)
            if tonnes <= 0:
                continue

            # One site can appear once per sector (e.g. a farm's digestion
            # and manure, an airport's domestic and international flights)
            key = (a.get("Name"), round(lon, 5), round(lat, 5))
            site = sites.setdefault(key, {
                "name": _facility_name(a), "lat": lat, "lon": lon,
                "district": district["name"], "district_id": district["id"],
                "tonnes": 0.0, "sectors": {}, "owners": [],
                "confidence": None, "_largest": 0.0,
            })
            site["tonnes"] += tonnes
            site["sectors"][a["Sector"]] = site["sectors"].get(a["Sector"], 0.0) + tonnes
            for owner in a.get("Owners") or []:
                name = owner.get("CompanyName")
                if name and name not in site["owners"]:
                    site["owners"].append(name)
            if tonnes > site["_largest"]:           # confidence of the biggest part
                site["_largest"] = tonnes
                site["confidence"] = _asset_confidence(a, year)

    facilities = []
    for site in sites.values():
        main_sector = max(site["sectors"], key=site["sectors"].get)
        facilities.append({
            "name": site["name"],
            "category": _CATEGORY_OF.get(main_sector, OTHER),
            "sectors": [sector_name(s) for s in sorted(site["sectors"], key=lambda s: -site["sectors"][s])],
            "tonnes": round(site["tonnes"]),
            "share_pct": (round(100 * site["tonnes"] / main_total, 1)
                          if site["district_id"] == main_district_id and main_total else None),
            "district": site["district"],
            "lat": round(site["lat"], 6),
            "lon": round(site["lon"], 6),
            "owners": site["owners"],
            "confidence": site["confidence"],
        })
    facilities.sort(key=lambda f: -f["tonnes"])

    by_category = {}
    for f in facilities:
        c = by_category.setdefault(f["category"], {"name": f["category"], "count": 0, "tonnes": 0})
        c["count"] += 1
        c["tonnes"] += f["tonnes"]

    shown = facilities[:TOP_FACILITIES]
    return {
        "year": year,
        "count": len(facilities),
        "tonnes": sum(f["tonnes"] for f in facilities),
        "items": shown,
        "hidden_count": len(facilities) - len(shown),
        "hidden_tonnes": sum(f["tonnes"] for f in facilities[TOP_FACILITIES:]),
        "by_category": sorted(by_category.values(), key=lambda c: -c["tonnes"]),
        "truncated": truncated,
        "summary": _facilities_summary(facilities, year, bool(bbox)),
        "_all": facilities,               # for the CSV writer; stripped from the API response
    }


def _facilities_summary(facilities, year, in_rectangle):
    where = "inside your area" if in_rectangle else "in the district"
    if not facilities:
        return f"Climate TRACE lists no individual facilities {where} for {year}."
    top = facilities[0]
    text = (f"Climate TRACE lists {len(facilities)} facilities {where}, together emitting "
            f"{_fmt_tonnes(sum(f['tonnes'] for f in facilities))} in {year}. The biggest is "
            f"{top['name']} ({_fmt_tonnes(top['tonnes'])}")
    if top["share_pct"] is not None:
        text += f", {top['share_pct']:.0f}% of the district total"
    return text + ")."


# ---------------------------------------------------------------------
# CSV
# ---------------------------------------------------------------------
def write_footprint_csv(report, output_dir):
    """One row per sector with a column per year, plus a total row."""
    district = report["district"]
    yearly = report["_yearly"]
    years = sorted(yearly)
    year_cols = [f"{y} so far (tCO₂e)" if any(r["year"] == y and r["partial"] for r in report["years"])
                 else f"{y} (tCO₂e)" for y in years]
    share_col = f"Share of {report['year']} total (%)"

    safe = re.sub(r"[^A-Za-z0-9]+", "_", district["name"]).strip("_")
    run = f"Carbon_Footprint_{safe}_{datetime.now():%Y%m%d_%H%M%S}"
    os.makedirs(os.path.join(output_dir, run), exist_ok=True)
    path = os.path.join(output_dir, run, f"{run}_carbon.csv")

    all_sectors = {s for y in years for s in yearly[y]}
    order = {cat: i for i, cat in enumerate(list(CATEGORIES) + [OTHER])}
    rows = sorted(all_sectors, key=lambda s: (order[_CATEGORY_OF.get(s, OTHER)],
                                              -yearly[report["year"]].get(s, 0)))
    total = report["tonnes"] or 1

    # Kept strictly tabular (no footnote rows) so spreadsheets and the app's
    # table preview read it cleanly; the caveats ride along on the total row.
    notes = ("Estimates for screening, not a certified footprint. Emissions only: the "
             "carbon balance of forests, grassland and wetlands is not included.")

    # utf-8-sig so Excel shows CO₂ correctly
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["District", "Category", "Sector"] + year_cols + [share_col, "Source", "Notes"])
        for s in rows:
            w.writerow([district["full_name"], _CATEGORY_OF.get(s, OTHER), sector_name(s)]
                       + [round(yearly[y].get(s, 0)) for y in years]
                       + [round(100 * yearly[report["year"]].get(s, 0) / total, 1),
                          "Climate TRACE", ""])
        w.writerow([district["full_name"], "All categories", "TOTAL"]
                   + [round(sum(yearly[y].values())) for y in years]
                   + [100.0, "Climate TRACE (climatetrace.org)", notes])
    return path


def write_facilities_csv(facilities, footprint_csv_path):
    """Every facility in the area, next to the footprint CSV."""
    path = footprint_csv_path.replace("_carbon.csv", "_facilities.csv")
    year = facilities["year"]
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        w = csv.writer(f)
        w.writerow(["Rank", "Facility", "Category", "Sector(s)", "District",
                    f"Emissions {year} (tCO₂e)", "Share of district total (%)",
                    "Owner(s)", "Confidence", "Latitude", "Longitude", "Source"])
        for i, fac in enumerate(facilities["_all"], 1):
            w.writerow([i, fac["name"], fac["category"], "; ".join(fac["sectors"]), fac["district"],
                        fac["tonnes"], "" if fac["share_pct"] is None else fac["share_pct"],
                        "; ".join(fac["owners"]), fac["confidence"] or "",
                        fac["lat"], fac["lon"], "Climate TRACE"])
    return path
