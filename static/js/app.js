/* ================================================================
   Sentinel Data Explorer — Frontend Logic
   ================================================================ */

// ── State ────────────────────────────────────────────────────────

let map;
let drawnItems;
let currentBbox   = null;
let currentOverlay = null;
let products      = {};

// ── Bootstrap ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initMap();
    loadProducts();
    initDateDefaults();
    initEventListeners();
});

// ── Map setup ────────────────────────────────────────────────────

function initMap() {
    map = L.map("map", {
        center: [22.5, 72.9],   // Gujarat, India
        zoom: 6,
        zoomControl: true,
    });

    // OpenStreetMap tiles (free, no API key)
    L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {
            attribution:
                '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
            maxZoom: 19,
        },
    ).addTo(map);

    // Feature group that holds drawn rectangles
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Leaflet.draw: only rectangle
    const drawControl = new L.Control.Draw({
        draw: {
            rectangle: {
                shapeOptions: {
                    color: "#818cf8",
                    weight: 2,
                    fillOpacity: 0.12,
                    fillColor: "#6366f1",
                    dashArray: "6 4",
                },
            },
            polygon: false,
            circle: false,
            circlemarker: false,
            marker: false,
            polyline: false,
        },
        edit: {
            featureGroup: drawnItems,
            remove: true,
        },
    });
    map.addControl(drawControl);

    // ─ Events ────────────────────────────────────

    map.on(L.Draw.Event.CREATED, (e) => {
        // Clear old rectangle & overlay
        drawnItems.clearLayers();
        if (currentOverlay) {
            map.removeLayer(currentOverlay);
            currentOverlay = null;
        }

        drawnItems.addLayer(e.layer);

        const b = e.layer.getBounds();
        currentBbox = [
            +b.getWest().toFixed(4),
            +b.getSouth().toFixed(4),
            +b.getEast().toFixed(4),
            +b.getNorth().toFixed(4),
        ];

        renderBbox(currentBbox);
        refreshFetchBtn();
    });

    map.on(L.Draw.Event.DELETED, () => {
        currentBbox = null;
        renderBbox(null);
        refreshFetchBtn();
    });

    map.on(L.Draw.Event.EDITED, () => {
        const layers = drawnItems.getLayers();
        if (layers.length) {
            const b = layers[0].getBounds();
            currentBbox = [
                +b.getWest().toFixed(4),
                +b.getSouth().toFixed(4),
                +b.getEast().toFixed(4),
                +b.getNorth().toFixed(4),
            ];
            renderBbox(currentBbox);
        }
    });
}

// ── Bbox display ─────────────────────────────────────────────────

function renderBbox(bbox) {
    const el = document.getElementById("bbox-display");
    if (!bbox) {
        el.classList.remove("active");
        el.innerHTML =
            '<p class="bbox-hint">Draw a rectangle on the map to define your Area of Interest</p>';
        return;
    }
    el.classList.add("active");
    el.innerHTML = `
        <div class="bbox-grid">
            <div class="bbox-item"><span class="bbox-key">West</span><span class="bbox-val">${bbox[0]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">East</span><span class="bbox-val">${bbox[2]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">South</span><span class="bbox-val">${bbox[1]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">North</span><span class="bbox-val">${bbox[3]}°</span></div>
        </div>`;
}

// ── Product dropdown ─────────────────────────────────────────────

async function loadProducts() {
    try {
        const res  = await fetch("/api/products");
        products   = await res.json();
        const sel  = document.getElementById("product-select");

        sel.innerHTML = '<option value="" disabled selected>Select a product…</option>';

        // Group by mission
        const missions = {};
        for (const [id, p] of Object.entries(products)) {
            (missions[p.mission] ??= []).push({ id, ...p });
        }

        for (const [mission, items] of Object.entries(missions)) {
            const grp = document.createElement("optgroup");
            grp.label = mission;
            items.forEach((it) => {
                const opt = document.createElement("option");
                opt.value       = it.id;
                opt.textContent = it.label;
                grp.appendChild(opt);
            });
            sel.appendChild(grp);
        }
    } catch (err) {
        console.error("Failed to load products:", err);
        document.getElementById("product-select").innerHTML =
            '<option value="" disabled selected>⚠ Could not load products</option>';
    }
}

// ── Date defaults (last 30 days) ─────────────────────────────────

function initDateDefaults() {
    const today = new Date();
    const ago   = new Date(today);
    ago.setDate(today.getDate() - 30);

    document.getElementById("date-to").value   = fmt(today);
    document.getElementById("date-from").value = fmt(ago);
}

function fmt(d) {
    return d.toISOString().split("T")[0];
}

// ── Event wiring ─────────────────────────────────────────────────

function initEventListeners() {
    document.getElementById("product-select").addEventListener("change", refreshFetchBtn);
    document.getElementById("fetch-btn").addEventListener("click", fetchData);
    document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);
}

function refreshFetchBtn() {
    const selected = document.getElementById("product-select").value;
    document.getElementById("fetch-btn").disabled = !(currentBbox && selected);
}

function toggleSidebar() {
    document.getElementById("sidebar").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 350);
}

// ── Fetch satellite data ─────────────────────────────────────────

async function fetchData() {
    const productId = document.getElementById("product-select").value;
    const dateFrom  = document.getElementById("date-from").value;
    const dateTo    = document.getElementById("date-to").value;

    if (!currentBbox || !productId || !dateFrom || !dateTo) return;

    const btn       = document.getElementById("fetch-btn");
    const statusEl  = document.getElementById("status-area");
    const resultsEl = document.getElementById("results-area");

    btn.disabled = true;
    btn.querySelector(".btn-text").textContent = "Processing…";
    statusEl.classList.remove("hidden");
    resultsEl.classList.add("hidden");

    try {
        const res = await fetch("/api/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                bbox: currentBbox,
                product_id: productId,
                date_from: dateFrom,
                date_to: dateTo,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }

        showResults(await res.json());
    } catch (err) {
        showError(err.message);
    } finally {
        btn.disabled = false;
        btn.querySelector(".btn-text").textContent = "Fetch Satellite Data";
        statusEl.classList.add("hidden");
    }
}

// ── Display results ──────────────────────────────────────────────

function showResults(data) {
    const area    = document.getElementById("results-area");
    const content = document.getElementById("results-content");

    area.classList.remove("hidden");

    const ext = data.raster_path.split(".").pop().toUpperCase();

    // Best scene info
    const bestDate = data.best_scene?.datetime
        ? new Date(data.best_scene.datetime).toLocaleDateString("en-US", {
              year: "numeric", month: "short", day: "numeric",
          })
        : "";
    const bestCloud = data.best_scene?.cloud_cover != null
        ? ` · ☁️ ${data.best_scene.cloud_cover}%`
        : "";

    let html = `
        <div class="result-stat">
            <span class="stat-icon">🛰️</span>
            <span>${data.product.mission} — ${data.product.label}</span>
        </div>
        <div class="result-stat">
            <span class="stat-icon">📊</span>
            <span><span class="stat-value">${data.scenes_count}</span> scene(s) found</span>
        </div>
        <div class="result-stat">
            <span class="stat-icon">✅</span>
            <span>Best scene: <span class="stat-value">${bestDate}</span>${bestCloud}</span>
        </div>

        <a class="download-btn" href="/api/download/${encodeURI(data.raster_path)}" download>
            <span>📥</span><span>Download ${ext}</span>
        </a>
        <a class="download-btn" href="/api/download/${encodeURI(data.csv_path)}" download>
            <span>📥</span><span>Download Scene CSV</span>
        </a>

        <button class="preview-btn" id="preview-btn"
                data-path="${data.raster_path}"
                data-bbox="${data.bbox.join(",")}"
                data-pid="${data.product_id}">
            <span>🗺️</span><span>Preview on Map</span>
        </button>
    `;

    // Scene list
    if (data.scenes?.length) {
        html += '<div class="scene-list">';
        data.scenes.forEach((s) => {
            const dateStr = s.datetime
                ? new Date(s.datetime).toLocaleDateString("en-US", {
                      year: "numeric", month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                  })
                : "N/A";
            const cloud =
                s.cloud_cover != null ? `<div class="scene-cloud">☁️ ${s.cloud_cover}%</div>` : "";
            html += `
                <div class="scene-item">
                    <div class="scene-date">${dateStr}</div>
                    <div class="scene-id" title="${s.id}">${s.id}</div>
                    ${cloud}
                </div>`;
        });
        html += "</div>";
    }

    content.innerHTML = html;

    // Wire up preview button
    document.getElementById("preview-btn").addEventListener("click", function () {
        const bbox = this.dataset.bbox.split(",").map(Number);
        showPreview(this.dataset.path, bbox, this.dataset.pid);
    });
}

// ── Map preview overlay ──────────────────────────────────────────

function showPreview(rasterPath, bbox, productId) {
    if (currentOverlay) {
        map.removeLayer(currentOverlay);
        currentOverlay = null;
    }

    const bounds = [
        [bbox[1], bbox[0]],  // [south, west]
        [bbox[3], bbox[2]],  // [north, east]
    ];

    const url = `/api/preview/${encodeURI(rasterPath)}?product_id=${productId}`;

    currentOverlay = L.imageOverlay(url, bounds, {
        opacity: 0.85,
        interactive: true,
    }).addTo(map);

    map.fitBounds(bounds, { padding: [60, 60] });
}

// ── Error display ────────────────────────────────────────────────

function showError(message) {
    const area    = document.getElementById("results-area");
    const content = document.getElementById("results-content");

    area.classList.remove("hidden");
    content.innerHTML = `<div class="error-msg">⚠️ ${message}</div>`;
}
