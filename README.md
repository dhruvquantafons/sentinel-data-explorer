# 🔬 TeraVerify — Satellite Verification & Temporal Analysis Platform

**TeraVerify** is an interactive satellite data verification platform built on the **Copernicus Data Space Ecosystem (CDSE)** and **Sentinel Hub APIs**. It enables users to draw an Area of Interest (AOI) on an interactive map, search satellite scene catalogs, fetch multi-spectral & atmospheric rasters on demand, and compare multi-temporal dataset scenes side-by-side on synchronized maps, split swipe sliders, and data matrices.

---

## ✨ Key Features

- **📍 Interactive AOI Selection**: Draw bounding boxes directly on an OpenStreetMap base layer using Leaflet Draw.
- **🛰️ 15 Satellite Data Products across 4 Missions**:
  - **Sentinel-2 (Optical)**: True Color, NDVI (Vegetation Index), NDWI (Water Index), NDBI (Built-Up Index), NDSI (Snow Index), EVI (Enhanced Vegetation Index).
  - **Sentinel-1 (Radar SAR)**: Dual-polarization VV/VH backscatter in dB (cloud-penetrating, works day & night).
  - **Sentinel-3 (Ocean & Land)**: OLCI Ocean/Land True Color & SLSTR Thermal Infrared Brightness Temperature ($S8/S9$).
  - **Sentinel-5P (Atmospheric Air Quality)**: Nitrogen Dioxide ($NO_2$), Carbon Monoxide ($CO$), Methane ($CH_4$), Ozone ($O_3$), Sulfur Dioxide ($SO_2$), and Aerosol Index ($AER\_AI$) with science-grade quality filtering (`minQa: 50`) and NaN masking.
- **📥 On-Demand Scene Fetching**: Search STAC scene catalogs for an AOI and date range, then click **Fetch** on individual scenes to generate high-resolution rasters on demand.
- **⚖️ Temporal Dataset & Raster Comparison**:
  - **🗺️ Dual Synced Side-by-Side Maps**: Compare any 2 scenes with real-time bi-directional pan and zoom synchronization and header dropdown selectors.
  - **🪟 Interactive Split / Swipe Overlay Slider**: Smooth horizontal curtain handle (`↔`) to wipe between left and right rasters for visual change detection.
  - **🔲 Synchronized Multi-Grid View**: Display 2, 3, or 4 maps simultaneously in a 1x3, 1x4, or 2x2 grid layout, moving all maps together in unison.
  - **📊 Multi-Column Data Matrix Table**: Compare metadata parameters (acquisition time, cloud cover %, platform, scene ID, bbox, download links) side-by-side across 2, 3, 4, or N fetched scenes.
  - **📁 Historical Runs Scanner**: Scan and merge past output folders to compare scene metadata across historical search runs.
- **📋 In-Browser CSV Metadata Preview**: View full STAC scene metadata tables directly in a glassmorphic modal window without downloading.
- **🗺️ GIS-Ready Exports**: Download 32-bit floating-point GeoTIFF images and CSV scene catalogs for downstream GIS software (QGIS, ArcGIS, Python GDAL/Rasterio).

---

## 🛠️ Tech Stack

- **Backend**: Python 3.10+, FastAPI, Uvicorn, Requests, NumPy, Pillow, Python-Dotenv
- **Frontend**: HTML5, Vanilla CSS3 (Dark Glassmorphism design system), JavaScript (ES6+), Leaflet.js, Leaflet Draw
- **Data APIs**: Copernicus Data Space Ecosystem (CDSE) / Sentinel Hub Process API & STAC Catalog Search API

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
- Python 3.9+ installed.
- Valid **Copernicus Data Space Ecosystem** account with OAuth credentials (`CLIENT_ID` and `CLIENT_SECRET`).

### 2. Clone the Repository
```bash
git clone https://github.com/dhruvquantafons/teraverify.git
cd teraverify
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
Edit `.env`:
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
Open your browser and navigate to **`http://localhost:8000`**.

---

## 🌐 Cloud Deployment (Vercel)

This repository is pre-configured for serverless deployment on **Vercel** via `vercel.json` and automatically routes output storage to `/tmp/output` in cloud environments.

1. Push your repository to GitHub.
2. Import the repository in [Vercel](https://vercel.com/new).
3. Set the following **Environment Variables** in Vercel project settings:
   - `CLIENT_ID`: Your Copernicus Client ID
   - `CLIENT_SECRET`: Your Copernicus Client Secret
4. Click **Deploy**!

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Serves the interactive TeraVerify web application |
| `/api/products` | `GET` | Returns product catalog (missions, labels, formats) |
| `/api/process` | `POST` | Searches STAC catalog for AOI + date range, saves scene CSV |
| `/api/fetch-scene` | `POST` | Generates & fetches raster for a specific scene date on demand |
| `/api/runs` | `GET` | Scans and lists past output runs stored in `output/` |
| `/api/preview/{path}` | `GET` | Converts GeoTIFF to colorized PNG for Leaflet map overlay |
| `/api/download/{path}` | `GET` | Downloads generated raster image or scene CSV file |

### Sample `POST /api/process` Request Payload
```json
{
  "bbox": [72.9000, 22.5000, 72.9500, 22.5500],
  "product_id": "2",
  "date_from": "2026-08-01",
  "date_to": "2026-09-08"
}
```

### Sample `POST /api/fetch-scene` Request Payload
```json
{
  "bbox": [72.9000, 22.5000, 72.9500, 22.5500],
  "product_id": "2",
  "scene_date": "2026-09-08"
}
```

---

## 📂 Project Structure

```
teraverify/
├── app.py                            # FastAPI REST API server & endpoints
├── sentinel_data_api_example_second.py # Core Sentinel Hub API & evalscript processing pipeline
├── static/
│   ├── index.html                    # Single-page app HTML markup & modal dialogs
│   ├── css/style.css                 # Dark glassmorphism styling & visual design system
│   └── js/app.js                     # Leaflet map logic, dual-map sync, split slider & API state
├── requirements.txt                  # Python dependencies
├── vercel.json                       # Vercel serverless deployment config
├── .env.example                      # Environment variables template
└── .gitignore                        # Git exclusion rules
```

---

## 📜 License & Acknowledgments

- **Data Source**: Powered by the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/).
- **License**: MIT License. Free for open-source and commercial use.
