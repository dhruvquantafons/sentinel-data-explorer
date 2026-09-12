# 🔬 TerraVerify — Satellite Verification & Temporal Analysis Platform

**TerraVerify** is an interactive satellite data verification platform built on the **Copernicus Data Space Ecosystem (CDSE)** and **Sentinel Hub APIs**. Draw an Area of Interest (AOI) on a map, search the satellite catalog, get a plain-language report of what the satellite saw on each date, fetch rasters on demand, and compare scenes side by side on synchronized maps, a swipe slider, and a metadata matrix.

---

## ✨ Key Features

- **📍 Guided search**: A three-step sidebar (product → date range → area) that marks each step as done and tells you what's still missing. Quick date presets (7 days, 30 days, 90 days, 1 year) with validation, and the AOI's approximate area in km².
- **🛰️ 15 data products across 4 missions**:
  - **Sentinel-2 (Optical)**: True Color, NDVI (vegetation health), NDWI (water content), NDBI (built-up areas), NDSI (snow cover), EVI (enhanced vegetation index).
  - **Sentinel-1 (Radar SAR)**: Dual-polarization VV/VH backscatter (sees through clouds, works day and night).
  - **Sentinel-3 (Ocean & Land)**: OLCI True Color and SLSTR thermal-infrared brightness temperature ($S8/S9$).
  - **Sentinel-5P (Air Quality)**: Nitrogen dioxide ($NO_2$), carbon monoxide ($CO$), methane ($CH_4$), ozone ($O_3$), sulfur dioxide ($SO_2$) and aerosol index, with quality filtering (`minQa: 50`). Searches return only the chosen gas.
- **📋 Plain-language scene report (CSV)**: One row per acquisition date with readable column names, units, product-specific measurements (vegetation cover, water area, gas levels, …) and a one-sentence summary. See [Scene report CSV](#-scene-report-csv).
- **📥 On-demand scene fetching**: Click **Fetch** on any scene to generate its raster. Cloud cover is colour-coded (green < 20%, amber < 60%, red above) so usable scenes stand out.
- **🗺️ Map preview with legend**: Fetched rasters are overlaid on the map with a colour legend showing the real data values, an opacity slider, and a remove button.
- **⚖️ Scene comparison**:
  - **Side-by-Side**: Two synced maps with scene dropdowns.
  - **Swipe**: A draggable curtain between two scenes for visual change detection.
  - **Grid**: Up to 4 synced maps at once.
  - **Metadata**: A matrix of scene details *plus* each scene's measurements from the scene CSV (summary, visible area, data quality, product values).
- **📁 Compare past runs**: Merge the CSVs of earlier searches into one chronological table. Works with both the current report format and CSVs from older versions.
- **🖼️ GIS-ready exports**:
  - **Coloured GeoTIFF** (default): the same colours as the map preview, georeferenced so it lines up in QGIS/ArcGIS.
  - **Raw GeoTIFF**: the original 32-bit float measurement values, via `?raw=1` (see [API Reference](#-api-reference)).
  - **Scene report CSV**.
- **📱 Responsive**: On small screens the map sits on top and the controls below.

---

## 📊 Scene Report CSV

The CSV saved with every search is written for non-specialists. At search time TerraVerify makes one call to the **Sentinel Hub Statistical API**, which returns per-day statistics over your AOI, and turns them into readable columns. The logic lives in [`scene_report.py`](scene_report.py).

**Every report has:**

| Column | Meaning |
|---|---|
| Date, Time (UTC), Satellite | When the area was captured and by which satellite (e.g. `S2B`) |
| Cloud-free part of your area (%) | Share of *your AOI* the satellite could actually see (optical products). Radar, thermal and gas products show *Part of your area with valid data (%)* instead |
| Data quality | Good (≥ 80% visible), Fair (≥ 40%), Poor (≥ 5%), or No usable data |
| *Product measurements* | See below |
| Summary | One plain-English sentence, e.g. *"Vegetation is moderate on average: 16% of the visible land is dense, healthy vegetation… Clouds hid 83% of your area."* |
| Cloud cover of the full satellite image (%), Pixel size (m), Scene ID(s) | Technical details, kept at the end |

**Measurements per product:**

| Product | Columns |
|---|---|
| NDVI, EVI (vegetation) | Average index, overall vegetation health, % dense / moderate / sparse / no vegetation |
| NDWI (water) | Water presence, % open water / wet ground / dry land, estimated open-water area (km²) |
| NDBI (built-up) | Built-up level, % built-up / mixed / vegetation, estimated built-up area (km²) |
| NDSI (snow) | Snow cover, % snow or ice, estimated snow area (km²) |
| True Color | What the photo shows: % clouds, cloud shadows, vegetation, bare/built-up, water, snow |
| Radar | Water detected, % likely water or flooded, estimated water area (km²), % strong reflectors (e.g. buildings), average VV/VH signal (dB) |
| Thermal (SLSTR) | Approx. surface temperature (°C), temperature level, coolest and hottest spot |
| NO₂, CO, CH₄, O₃, SO₂, aerosol | Average in familiar units (µmol/m², mmol/m², ppb, Dobson units), indicative level, highest reading, and where the gas comes from |
| OLCI True Color | Dates only (no measurements) |

**Notes:**
- Optical measurements exclude clouds and cloud shadows (using the Sentinel-2 scene classification), so a cloudy day doesn't read as "no vegetation". Dates where less than 5% of the area is visible are marked *too cloudy to measure*.
- Air-quality data is published a few days after each pass. Recent dates without data say *"not published yet"* rather than looking empty.
- Level labels such as *"Sparse or stressed"* or NO₂ *"High"* are rough, commonly used guides to help non-experts, **not** regulatory or health limits. Thresholds are defined in `scene_report.py`.
- The Statistical API call adds roughly 1–3 seconds to a search and uses a small amount of your Copernicus processing units. If it fails, the CSV is still written with the dates and the app shows a notice.
- The file is UTF-8 with a BOM, so Excel shows °C, km² and µ correctly.

---

## 🛠️ Tech Stack

- **Backend**: Python 3.10+, FastAPI, Uvicorn, Requests, NumPy, Pillow, tifffile, python-dotenv
- **Frontend**: HTML5, vanilla CSS (light theme), JavaScript (ES6+), Leaflet.js, Leaflet Draw
- **Data APIs**: Copernicus Data Space Ecosystem / Sentinel Hub — Catalog (STAC) API, Process API, Statistical API

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- Python 3.10+.
- A **Copernicus Data Space Ecosystem** account with OAuth credentials (`CLIENT_ID` and `CLIENT_SECRET`), created from the Sentinel Hub dashboard at [dataspace.copernicus.eu](https://dataspace.copernicus.eu/).

### 2. Clone the Repository
```bash
git clone https://github.com/dhruvquantafons/sentinel-data-explorer.git
cd sentinel-data-explorer
```

### 3. Install Dependencies
```bash
pip install -r requirements.txt
```

### 4. Configure Environment Variables
Copy `.env.example` to `.env` and fill in your Copernicus API credentials:
```bash
cp .env.example .env
```
```env
CLIENT_ID=your_copernicus_client_id
CLIENT_SECRET=your_copernicus_client_secret
```

### 5. Run the Application
```bash
python app.py
```
Or with Uvicorn directly:
```bash
uvicorn app:app --reload --port 8000
```
Open **`http://localhost:8000`**. The app opens directly; there is no login.

> **Note:** The app and its API have no authentication. Add some before exposing it publicly.

### 6. Using the App
1. Pick a **product**, choose a **date range**, and draw a **rectangle** on the map.
2. Click **Search Scenes**. You'll get the scene list plus the scene report CSV (**View table** / **Scene CSV**).
3. Click **Fetch** on a scene. The first one is shown on the map automatically, with a legend.
4. Fetch two or more scenes and click **Compare scenes** for side-by-side, swipe, grid and metadata views.
5. Use **Compare Past Runs** in the sidebar footer to compare CSVs from earlier searches.

---

## 🌐 Cloud Deployment (Vercel)

The repository is pre-configured for serverless deployment on **Vercel** via `vercel.json`. Output storage automatically moves to `/tmp/output` in cloud environments (note that `/tmp` is not persistent between invocations).

1. Push your repository to GitHub.
2. Import the repository in [Vercel](https://vercel.com/new).
3. Set these **Environment Variables** in the Vercel project settings:
   - `CLIENT_ID`: your Copernicus Client ID
   - `CLIENT_SECRET`: your Copernicus Client Secret
4. Click **Deploy**.

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | The TerraVerify web application |
| `/app` | `GET` | Redirects to `/` (old address) |
| `/api/products` | `GET` | Product catalog: mission, label, format, and the legend colour stops for each product |
| `/api/process` | `POST` | Searches the catalog for AOI + date range and writes the scene report CSV. The response includes `measurements_available` (false if the Statistical API call failed) |
| `/api/fetch-scene` | `POST` | Generates and saves the raster for one scene date |
| `/api/runs` | `GET` | Lists past runs stored in `output/`, newest first |
| `/api/preview/{path}` | `GET` | Renders a GeoTIFF as a coloured PNG for the map overlay. `?product_id=` selects the colormap; the `X-Value-Min` / `X-Value-Max` headers give the data values the legend ends map to |
| `/api/download/{path}` | `GET` | Downloads a generated file. With `?product_id=`, TIFFs are returned as a **coloured GeoTIFF**; add `?raw=1` for the original float GeoTIFF. CSVs and PNGs are returned as-is |

### Sample `POST /api/process` Request
```json
{
  "bbox": [72.9000, 22.5000, 72.9500, 22.5500],
  "product_id": "2",
  "date_from": "2026-08-01",
  "date_to": "2026-09-08"
}
```

### Sample `POST /api/fetch-scene` Request
```json
{
  "bbox": [72.9000, 22.5000, 72.9500, 22.5500],
  "product_id": "2",
  "scene_date": "2026-09-08"
}
```

### Product IDs

| ID | Product | ID | Product |
|---|---|---|---|
| 1 | True Color | 9 | SLSTR Brightness Temperature |
| 2 | NDVI (vegetation health) | 10 | NO₂ (nitrogen dioxide) |
| 3 | NDWI (water content) | 11 | CH₄ (methane) |
| 4 | NDBI (built-up areas) | 12 | CO (carbon monoxide) |
| 5 | NDSI (snow cover) | 13 | O₃ (ozone) |
| 6 | EVI (enhanced vegetation index) | 14 | SO₂ (sulfur dioxide) |
| 7 | Radar Backscatter VV/VH | 15 | Aerosol index |
| 8 | OLCI True Color | | |

---

## 📂 Project Structure

```
sentinel-data-explorer/
├── app.py                               # FastAPI server: endpoints, TIFF preview/colouring, downloads
├── scene_report.py                      # Plain-language scene report CSV (Statistical API measurements)
├── sentinel_data_api_example_second.py  # Core pipeline: auth, catalog search, evalscripts, Process API
├── static/
│   ├── index.html                       # Main app markup and modal dialogs
│   ├── css/style.css                    # App styles (light theme, responsive)
│   └── js/app.js                        # Map, search flow, legend, comparison views, CSV views
├── requirements.txt                     # Python dependencies
├── vercel.json                          # Vercel serverless deployment config
├── .env.example                         # Environment variables template
└── .gitignore                           # Git exclusion rules (output/, .env, …)
```

Generated files go into `output/`, one timestamped folder per action, named `<Mission>_<Product>_<west>_<south>_<east>_<north>_<YYYYMMDD>_<HHMMSS>`: each search writes a folder with its scene report CSV, and each fetched scene writes a folder with its raster. **Compare Past Runs** lists the search folders (the ones containing a CSV).

---

## 📜 License & Acknowledgments

- **Data Source**: Powered by the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/). Contains modified Copernicus Sentinel data.
- **Map tiles**: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors.
- **License**: MIT License. Free for open-source and commercial use.
