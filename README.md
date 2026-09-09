# 🔬 TeraVerify

An interactive web application and Python API wrapper for searching, processing, verifying, visualizing, and downloading satellite imagery from the **Copernicus Data Space Ecosystem (CDSE)**.

---

## ✨ Features

- **Interactive AOI Selection**: Select your target bounding box directly on an interactive OpenStreetMap interface using Leaflet bounding-box drawing.
- **15+ Satellite Data Products**:
  - **Sentinel-2 (Optical)**: True Color, False Color (Urban & Vegetation), NDVI (Vegetation Index), NDWI (Water Index), Moisture Index, SWIR, Agriculture Index, Geology Index, Wildfire/Burn Index.
  - **Sentinel-3 (Ocean & Land Color)**: OLCI True Color imagery.
  - **Sentinel-5P (Atmospheric)**: Nitrogen Dioxide ($NO_2$) and Carbon Monoxide ($CO$) concentrations.
  - **Sentinel-1 (Radar SAR)**: Synthetic Aperture Radar (IW VV+VH backscatter in dB).
- **Smart Cloud Cover Selection**: Automatically scans the catalog for the best (lowest cloud cover %) available scene within the selected date range.
- **Map Overlay Previews**: Instant visual preview overlay of processed raster data directly on the map.
- **CSV Preview**: View scene metadata directly in the browser with a glassmorphism-styled table modal — no download needed.
- **GIS-Ready Downloads**: Generates 32-bit floating-point GeoTIFF images and CSV scene metadata for downstream GIS analysis (QGIS, ArcGIS, Python).
- **RESTful API**: Fast and clean API built with **FastAPI**.

---

## 🛠️ Tech Stack

- **Backend**: Python 3.10+, FastAPI, Uvicorn, Requests, NumPy, Pillow, Python-Dotenv
- **Frontend**: HTML5, Vanilla CSS3 (Custom Glassmorphism design), JavaScript (ES6+), Leaflet.js, Leaflet Draw
- **Data Source**: Copernicus Data Space Ecosystem / Sentinel Hub Process API & STAC Catalog

---

## 🚀 Quick Start (Local Setup)

### 1. Prerequisites
Ensure you have Python 3.9+ installed and a valid **Copernicus Data Space Ecosystem** account with OAuth credentials (`CLIENT_ID` and `CLIENT_SECRET`).

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
Copy the example environment file and add your Copernicus API credentials:
```bash
cp .env.example .env
```
Edit `.env` and fill in your keys:
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

## 🌐 Deploy to Vercel

This repository is pre-configured for one-click deployment on **Vercel** using `@vercel/python`.

1. Push your repository to GitHub.
2. Go to [Vercel](https://vercel.com/new) and import the repository.
3. Add the following **Environment Variables** in the Vercel project settings:
   - `CLIENT_ID`: Your Copernicus Client ID
   - `CLIENT_SECRET`: Your Copernicus Client Secret
4. Click **Deploy**!

---

## 📡 API Reference

| Endpoint | Method | Description |
|---|---|---|
| `/` | `GET` | Serves the interactive web interface |
| `/api/products` | `GET` | Returns list of supported satellite products & missions |
| `/api/process` | `POST` | Processes satellite data for a given bounding box & product |
| `/api/preview/{path}` | `GET` | Returns colorized PNG preview for map overlay |
| `/api/download/{path}`| `GET` | Downloads generated raster image or CSV metadata |

### Sample `POST /api/process` Payload
```json
{
  "bbox": [72.9000, 22.5000, 72.9500, 22.5500],
  "product_id": "2",
  "date_from": "2026-08-08",
  "date_to": "2026-09-08"
}
```

---

## 📂 Project Structure

```
teraverify/
├── app.py                            # FastAPI backend server
├── sentinel_data_api_example_second.py # Core Sentinel Hub API processing pipeline
├── static/
│   ├── index.html                    # Frontend HTML markup
│   ├── css/style.css                 # Custom glassmorphism UI styles
│   └── js/app.js                     # Leaflet map logic & API interaction
├── requirements.txt                  # Python dependencies
├── vercel.json                       # Vercel serverless deployment config
├── .env.example                      # Environment variables template
└── .gitignore                        # Git exclusion rules
```

---

## 📜 License & Acknowledgments

- **Data Source**: Powered by the [Copernicus Data Space Ecosystem](https://dataspace.copernicus.eu/).
- **License**: MIT License. Free for open-source and commercial use.
