/* ================================================================
   TerraVerify — Frontend Logic
   ================================================================ */

// ── State ────────────────────────────────────────────────────────

let map;
let drawnItems;
let currentBbox   = null;
let currentOverlay = null;
let currentOverlayUrl = null;     // object URL backing currentOverlay
let products      = {};
let compareSelectedRuns = [];

// Fetched scenes comparison state
let fetchedScenes = [];
let leftMap = null, rightMap = null, splitMap = null;
let gridMaps = [];
let leftOverlay = null, rightOverlay = null, splitOverlayLeft = null, splitOverlayRight = null;
let isSyncingMaps = false;

const TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
const DEFAULT_OPACITY = 0.85;

// Style for the drawn AOI rectangle. Its fill is dropped while a raster
// preview is shown, otherwise the translucent blue tints the raster colours.
const AOI_STYLE = {
    color: "#2563eb",
    weight: 2,
    fillOpacity: 0.08,
    fillColor: "#3b82f6",
    dashArray: "6 4",
};

// Color palette for comparison source badges
const COMPARE_COLORS = [
    "#818cf8", "#06b6d4", "#10b981", "#f59e0b",
    "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6",
];

const ICONS = {
    download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    table:    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/></svg>',
    map:      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>',
    check:    '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    alert:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    cloud:    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"/></svg>',
    compare:  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="18" rx="1"/></svg>',
};

// ── Bootstrap ────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    initMap();
    loadProducts();
    initDateDefaults();
    initEventListeners();
    refreshFetchBtn();
});

// ── Map setup ────────────────────────────────────────────────────

function initMap() {
    map = L.map("map", {
        center: [22.5, 72.9],   // Gujarat, India
        zoom: 6,
        zoomControl: true,
    });

    // OpenStreetMap tiles (free, no API key)
    L.tileLayer(TILE_URL, {
        attribution:
            '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(map);

    // Feature group that holds drawn rectangles
    drawnItems = new L.FeatureGroup();
    map.addLayer(drawnItems);

    // Leaflet.draw: only rectangle
    const drawControl = new L.Control.Draw({
        draw: {
            rectangle: { shapeOptions: AOI_STYLE },
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
        clearPreview();

        e.layer.setStyle(AOI_STYLE);
        drawnItems.addLayer(e.layer);
        setBboxFromLayer(e.layer);
    });

    map.on(L.Draw.Event.DELETED, () => {
        currentBbox = null;
        clearPreview();
        renderBbox(null);
        refreshFetchBtn();
    });

    map.on(L.Draw.Event.EDITED, () => {
        const layers = drawnItems.getLayers();
        if (layers.length) setBboxFromLayer(layers[0]);
    });
}

function setBboxFromLayer(layer) {
    const b = layer.getBounds();
    currentBbox = [
        +b.getWest().toFixed(4),
        +b.getSouth().toFixed(4),
        +b.getEast().toFixed(4),
        +b.getNorth().toFixed(4),
    ];
    renderBbox(currentBbox);
    refreshFetchBtn();
}

function bboxBounds(bbox) {
    return [
        [bbox[1], bbox[0]],  // [south, west]
        [bbox[3], bbox[2]],  // [north, east]
    ];
}

/** Approximate area of a lon/lat bbox in km² (equirectangular). */
function bboxAreaKm2(bbox) {
    const midLat = ((bbox[1] + bbox[3]) / 2) * Math.PI / 180;
    const w = (bbox[2] - bbox[0]) * 111.32 * Math.cos(midLat);
    const h = (bbox[3] - bbox[1]) * 110.57;
    return Math.abs(w * h);
}

// ── Bbox display ─────────────────────────────────────────────────

function renderBbox(bbox) {
    const el = document.getElementById("bbox-display");
    if (!bbox) {
        el.classList.remove("active");
        el.innerHTML = `
            <p class="bbox-hint">
                Use the
                <span class="inline-icon" aria-hidden="true"><svg width="14" height="14" viewBox="0 0 24 24" fill="rgba(37,99,235,0.15)" stroke="#2563eb" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="4 3"/></svg></span>
                rectangle tool on the map to draw your area
            </p>`;
        return;
    }

    const area = bboxAreaKm2(bbox);
    const areaStr = area >= 1000
        ? `${Math.round(area).toLocaleString()} km²`
        : `${area.toFixed(1)} km²`;

    el.classList.add("active");
    el.innerHTML = `
        <div class="bbox-grid">
            <div class="bbox-item"><span class="bbox-key">West</span><span class="bbox-val">${bbox[0]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">East</span><span class="bbox-val">${bbox[2]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">South</span><span class="bbox-val">${bbox[1]}°</span></div>
            <div class="bbox-item"><span class="bbox-key">North</span><span class="bbox-val">${bbox[3]}°</span></div>
        </div>
        <div class="bbox-meta">
            <span>≈ ${areaStr}</span>
            <button type="button" class="link-btn" id="bbox-zoom">Zoom to area</button>
        </div>`;

    document.getElementById("bbox-zoom").addEventListener("click", () => {
        map.fitBounds(bboxBounds(bbox), { padding: [60, 60] });
    });
}

// ── Product dropdown ─────────────────────────────────────────────

async function loadProducts() {
    const sel = document.getElementById("product-select");
    try {
        const res  = await fetch("/api/products");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        products   = await res.json();

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
        sel.innerHTML = '<option value="" disabled selected>Could not load products</option>';
        showToast("Could not load products", "Reload the page to try again.", "error");
    }
}

// ── Dates ────────────────────────────────────────────────────────

function initDateDefaults() {
    const today = fmt(new Date());
    document.getElementById("date-from").max = today;
    document.getElementById("date-to").max   = today;
    applyDatePreset(30);
}

function applyDatePreset(days) {
    const today = new Date();
    const ago   = new Date(today);
    ago.setDate(today.getDate() - days);

    document.getElementById("date-to").value   = fmt(today);
    document.getElementById("date-from").value = fmt(ago);
    syncPresetChips();
    refreshFetchBtn();
}

/** Highlight the preset chip matching the current range, if any. */
function syncPresetChips() {
    const from = document.getElementById("date-from").value;
    const to   = document.getElementById("date-to").value;
    const days = from && to ? Math.round((new Date(to) - new Date(from)) / 864e5) : null;
    const isToday = to === fmt(new Date());

    document.querySelectorAll(".date-presets .chip").forEach(chip => {
        chip.classList.toggle("active", isToday && +chip.dataset.days === days);
    });
}

/** Returns an error message for the date range, or "" when it is valid. */
function dateRangeError() {
    const from = document.getElementById("date-from").value;
    const to   = document.getElementById("date-to").value;
    const today = fmt(new Date());

    if (!from || !to) return "Choose both a start and an end date.";
    if (from > to)    return "The start date must be before the end date.";
    if (to > today)   return "The end date can't be in the future.";
    return "";
}

function fmt(d) {
    // Local calendar date (toISOString would shift it to UTC)
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
}

// ── Event wiring ─────────────────────────────────────────────────

function initEventListeners() {
    document.getElementById("product-select").addEventListener("change", refreshFetchBtn);
    document.getElementById("fetch-btn").addEventListener("click", fetchData);
    document.getElementById("sidebar-toggle").addEventListener("click", toggleSidebar);

    ["date-from", "date-to"].forEach(id => {
        document.getElementById(id).addEventListener("change", () => {
            syncPresetChips();
            refreshFetchBtn();
        });
    });

    document.querySelectorAll(".date-presets .chip").forEach(chip => {
        chip.addEventListener("click", () => applyDatePreset(+chip.dataset.days));
    });

    // Map preview legend
    document.getElementById("legend-close").addEventListener("click", clearPreview);
    document.getElementById("legend-opacity").addEventListener("input", (e) => {
        const v = +e.target.value;
        document.getElementById("legend-opacity-val").textContent = `${v}%`;
        if (currentOverlay) currentOverlay.setOpacity(v / 100);
    });

    // CSV modal close handlers
    document.getElementById("csv-modal-close").addEventListener("click", closeCsvModal);
    document.getElementById("csv-modal").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) closeCsvModal();
    });

    // Compare modal handlers (past runs)
    document.getElementById("compare-btn").addEventListener("click", openCompareModal);
    document.getElementById("compare-modal-close").addEventListener("click", closeCompareModal);
    document.getElementById("compare-modal").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) closeCompareModal();
    });
    document.getElementById("compare-execute-btn").addEventListener("click", executeComparison);

    // Fetched scenes comparison modal handlers
    document.getElementById("fetched-compare-modal-close").addEventListener("click", closeFetchedCompareModal);
    document.getElementById("fetched-compare-modal").addEventListener("click", (e) => {
        if (e.target === e.currentTarget) closeFetchedCompareModal();
    });
    document.getElementById("tab-side-by-side").addEventListener("click", () => switchFetchedCompareTab("side-by-side"));
    document.getElementById("tab-split-slider").addEventListener("click", () => switchFetchedCompareTab("split-slider"));
    document.getElementById("tab-multi-grid").addEventListener("click", () => switchFetchedCompareTab("multi-grid"));
    document.getElementById("tab-data-table").addEventListener("click", () => switchFetchedCompareTab("data-table"));

    // Dropdown select change listeners
    document.getElementById("compare-select-left").addEventListener("change", onCompareDropdownChange);
    document.getElementById("compare-select-right").addEventListener("change", onCompareDropdownChange);
    document.getElementById("split-select-left").addEventListener("change", onSplitDropdownChange);
    document.getElementById("split-select-right").addEventListener("change", onSplitDropdownChange);

    // Escape closes the top-most open modal (the CSV modal can sit above the others)
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        if (!document.getElementById("csv-modal").classList.contains("hidden")) {
            closeCsvModal();
        } else {
            closeCompareModal();
            closeFetchedCompareModal();
        }
    });
}

/**
 * Enable the search button only when every step is complete, mark finished
 * steps, and tell the user what is still missing.
 */
function refreshFetchBtn() {
    const productId = document.getElementById("product-select").value;
    const dateErr   = dateRangeError();
    const btn       = document.getElementById("fetch-btn");
    const hint      = document.getElementById("fetch-hint");
    const dateErrEl = document.getElementById("date-error");

    document.querySelector('[data-step="product"]').classList.toggle("done", !!productId);
    document.querySelector('[data-step="dates"]').classList.toggle("done", !dateErr);
    document.querySelector('[data-step="aoi"]').classList.toggle("done", !!currentBbox);
    document.querySelector(".map-wrap").classList.toggle("needs-aoi", !currentBbox);

    dateErrEl.textContent = dateErr;
    dateErrEl.classList.toggle("hidden", !dateErr);
    ["date-from", "date-to"].forEach(id =>
        document.getElementById(id).classList.toggle("invalid", !!dateErr));

    const missing = [];
    if (!productId)   missing.push("pick a product");
    if (!currentBbox) missing.push("draw an area on the map");

    if (btn.classList.contains("loading")) return;
    btn.disabled = missing.length > 0 || !!dateErr;

    if (missing.length) {
        const text = missing.join(" and ");
        hint.textContent = text.charAt(0).toUpperCase() + text.slice(1) + " to continue";
        hint.classList.remove("hidden");
    } else {
        hint.classList.add("hidden");
    }
}

function toggleSidebar() {
    document.getElementById("sidebar").classList.toggle("collapsed");
    setTimeout(() => map.invalidateSize(), 320);
}

function setButtonLoading(btn, isLoading, label) {
    btn.classList.toggle("loading", isLoading);
    btn.disabled = isLoading;
    btn.querySelector(".btn-spinner")?.classList.toggle("hidden", !isLoading);
    if (label) btn.querySelector(".btn-text").textContent = label;
}

// ── Fetch satellite data ─────────────────────────────────────────

async function fetchData() {
    const productId = document.getElementById("product-select").value;
    const dateFrom  = document.getElementById("date-from").value;
    const dateTo    = document.getElementById("date-to").value;

    if (!currentBbox || !productId || dateRangeError()) return;

    // Reset current session fetched scenes
    fetchedScenes = [];
    clearPreview();

    const btn       = document.getElementById("fetch-btn");
    const statusEl  = document.getElementById("status-area");
    const resultsEl = document.getElementById("results-area");

    setButtonLoading(btn, true, "Searching catalog…");
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
        setButtonLoading(btn, false, "Search Scenes");
        statusEl.classList.add("hidden");
        refreshFetchBtn();
    }
}

// ── Display results ──────────────────────────────────────────────

const SCENE_DATE_FMT = {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
};

function cloudPill(cover) {
    if (cover == null) return "";
    const level = cover < 20 ? "low" : cover < 60 ? "mid" : "high";
    return `<span class="cloud-pill ${level}" title="Cloud cover">${ICONS.cloud}${(+cover).toFixed(0)}% cloud</span>`;
}

function showResults(data) {
    const area    = document.getElementById("results-area");
    const content = document.getElementById("results-content");

    // Store data on the area element for later use by fetchScene
    area._data = data;
    area.classList.remove("hidden");

    const shown = data.scenes?.length || 0;
    const countText = data.scenes_count > shown
        ? `<strong>${data.scenes_count}</strong> scenes found · showing the ${shown} most recent`
        : `<strong>${data.scenes_count}</strong> scene${data.scenes_count === 1 ? "" : "s"} found`;

    let html = `
        <div class="summary-card">
            <div class="summary-product">${escapeHtml(data.product.mission)}</div>
            <div class="summary-label">${escapeHtml(data.product.label)}</div>
            <div class="summary-count">${countText}</div>
            <div class="summary-actions">
                <a class="download-btn" href="/api/download/${encodeURI(data.csv_path)}" download>
                    ${ICONS.download}<span>Scene CSV</span>
                </a>
                <button class="csv-preview-btn" id="csv-preview-btn" data-csv="${escapeHtml(data.csv_path)}">
                    ${ICONS.table}<span>View table</span>
                </button>
            </div>
        </div>
    `;

    // Scene list with Fetch buttons
    if (shown) {
        html += `<div class="scene-list-header"><span>Scenes</span></div>`;
        html += '<div class="scene-list">';
        data.scenes.forEach((s, idx) => {
            const dateStr = s.datetime
                ? new Date(s.datetime).toLocaleDateString("en-US", SCENE_DATE_FMT)
                : "N/A";
            const sceneDate = s.datetime ? s.datetime.split("T")[0] : "";
            html += `
                <div class="scene-item" id="scene-item-${idx}">
                    <div class="scene-info-row">
                        <div>
                            <div class="scene-date">${dateStr}</div>
                            <div class="scene-meta">
                                ${cloudPill(s.cloud_cover)}
                                ${s.platform ? `<span class="scene-platform">${escapeHtml(scrubSentinel(s.platform))}</span>` : ""}
                            </div>
                            <div class="scene-id" title="${escapeHtml(scrubSentinel(s.id))}">${escapeHtml(scrubSentinel(s.id))}</div>
                        </div>
                        <button class="scene-fetch-btn" id="scene-fetch-${idx}"
                                data-scene-date="${sceneDate}"
                                data-scene-idx="${idx}">
                            <span class="btn-spinner hidden" aria-hidden="true"></span>
                            <span class="btn-text">Fetch</span>
                        </button>
                    </div>
                    <div class="scene-actions hidden" id="scene-actions-${idx}">
                        <!-- Filled after fetch -->
                    </div>
                </div>`;
        });
        html += "</div>";
    }

    content.innerHTML = html;

    // Wire up CSV preview button
    document.getElementById("csv-preview-btn").addEventListener("click", function () {
        previewCsv(this.dataset.csv);
    });

    if (data.measurements_available === false) {
        showToast("Measurements unavailable",
            "The scene CSV lists the dates found, but the per-date measurements couldn't be calculated right now.",
            "info");
    }

    // Wire up all scene Fetch buttons
    content.querySelectorAll(".scene-fetch-btn").forEach(btn => {
        btn.addEventListener("click", function () {
            fetchScene(this.dataset.sceneDate, +this.dataset.sceneIdx);
        });
    });
}

// ── Fetch a specific scene ───────────────────────────────────────

async function fetchScene(sceneDate, sceneIdx) {
    const data = document.getElementById("results-area")._data;
    const btn = document.getElementById(`scene-fetch-${sceneIdx}`);
    const actionsEl = document.getElementById(`scene-actions-${sceneIdx}`);
    const itemEl = document.getElementById(`scene-item-${sceneIdx}`);

    if (!sceneDate || !data || btn.classList.contains("scene-fetch-done")) return;

    btn.classList.remove("scene-fetch-failed");
    setButtonLoading(btn, true, "Fetching");

    try {
        const res = await fetch("/api/fetch-scene", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                bbox: data.bbox,
                product_id: data.product_id,
                scene_date: sceneDate,
            }),
        });

        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }

        const result = await res.json();
        const ext = result.raster_path.split(".").pop().toUpperCase();
        const dateLabel = itemEl.querySelector(".scene-date").textContent;

        setButtonLoading(btn, false);
        btn.disabled = true;
        btn.classList.add("scene-fetch-done");
        btn.querySelector(".btn-text").innerHTML = `${ICONS.check} Fetched`;

        // Show preview + download actions
        actionsEl.classList.remove("hidden");
        actionsEl.innerHTML = `
            <button class="preview-btn scene-preview-btn">
                ${ICONS.map}<span>Show on map</span>
            </button>
            <a class="download-btn" href="/api/download/${encodeURI(result.raster_path)}?product_id=${result.product_id}" download>
                ${ICONS.download}<span>${ext}</span>
            </a>
        `;

        const showOnMap = () => showPreview(result.raster_path, result.bbox, result.product_id, {
            title: data.product.label,
            subtitle: dateLabel,
            sceneIdx,
        });
        actionsEl.querySelector(".scene-preview-btn").addEventListener("click", showOnMap);

        itemEl.classList.add("scene-fetched");

        // Save fetched scene info to state for dataset comparison
        const sceneMeta = (data.scenes && data.scenes[sceneIdx]) ? data.scenes[sceneIdx] : {};
        const fetchedItem = {
            sceneIdx,
            sceneDate,
            datetime: sceneMeta.datetime || sceneDate,
            cloudCover: sceneMeta.cloud_cover,
            sceneId: scrubSentinel(sceneMeta.id) || "N/A",
            platform: scrubSentinel(sceneMeta.platform) || "N/A",
            rasterPath: result.raster_path,
            bbox: result.bbox,
            productId: result.product_id,
            productLabel: data.product ? data.product.label : "Satellite Product",
            mission: data.product ? data.product.mission : "Satellite Product",
            csvPath: data.csv_path,
        };

        const existingIdx = fetchedScenes.findIndex(s => s.sceneDate === sceneDate);
        if (existingIdx >= 0) {
            fetchedScenes[existingIdx] = fetchedItem;
        } else {
            fetchedScenes.push(fetchedItem);
        }

        updateFetchedCompareBar();

        // First fetched scene goes straight onto the map — that's why it was fetched
        if (!currentOverlay) showOnMap();

    } catch (err) {
        setButtonLoading(btn, false, "Retry");
        btn.classList.add("scene-fetch-failed");
        btn.title = scrubSentinel(err.message);
        showToast("Couldn't fetch this scene", err.message, "error");
    }
}

// ── Map preview overlay ──────────────────────────────────────────

/** Format a legend value with sensible precision for its magnitude. */
function fmtVal(v) {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10)   return v.toFixed(1);
    if (a >= 0.01 || a === 0) return v.toFixed(2);
    return v.toExponential(1);
}

async function showPreview(rasterPath, bbox, productId, meta = {}) {
    const loading = document.getElementById("map-loading");
    const bounds  = bboxBounds(bbox);
    const url     = `/api/preview/${encodeURI(rasterPath)}?product_id=${productId}`;

    loading.classList.remove("hidden");
    map.fitBounds(bounds, { padding: [60, 60] });

    try {
        // Fetch rather than let <img> load it, so we can read the value range
        // headers for the legend and surface errors instead of a broken image.
        const res = await fetch(url);
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const vmin = parseFloat(res.headers.get("X-Value-Min"));
        const vmax = parseFloat(res.headers.get("X-Value-Max"));
        const objectUrl = URL.createObjectURL(await res.blob());

        clearPreview();
        const opacity = +document.getElementById("legend-opacity").value / 100;
        currentOverlay = L.imageOverlay(objectUrl, bounds, { opacity, interactive: false }).addTo(map);
        currentOverlayUrl = objectUrl;

        // Outline only while previewing, so the AOI fill doesn't tint the raster
        drawnItems.eachLayer(l => l.setStyle({ fillOpacity: 0 }));

        renderLegend(productId, vmin, vmax, meta);
        markPreviewingScene(meta.sceneIdx);
    } catch (err) {
        showToast("Couldn't render the preview", err.message, "error");
    } finally {
        loading.classList.add("hidden");
    }
}

function renderLegend(productId, vmin, vmax, meta) {
    const legend = document.getElementById("map-legend");
    const stops  = products[productId]?.colormap;
    const hasScale = Array.isArray(stops) && isFinite(vmin) && isFinite(vmax);

    document.getElementById("legend-title").textContent =
        meta.title || products[productId]?.label || "Preview";
    document.getElementById("legend-subtitle").textContent = meta.subtitle || "";

    document.getElementById("legend-scale").classList.toggle("hidden", !hasScale);
    if (hasScale) {
        const gradient = stops.map(([r, g, b]) => `rgb(${r},${g},${b})`).join(", ");
        document.getElementById("legend-bar").style.background = `linear-gradient(to right, ${gradient})`;
        document.getElementById("legend-min").textContent = fmtVal(vmin);
        document.getElementById("legend-mid").textContent = fmtVal((vmin + vmax) / 2);
        document.getElementById("legend-max").textContent = fmtVal(vmax);
    }

    legend.classList.remove("hidden");
}

function markPreviewingScene(sceneIdx) {
    document.querySelectorAll(".scene-item").forEach(el => {
        const active = sceneIdx != null && el.id === `scene-item-${sceneIdx}`;
        el.classList.toggle("scene-previewing", active);
        const btn = el.querySelector(".scene-preview-btn");
        if (btn) {
            btn.classList.toggle("is-active", active);
            btn.querySelector("span").textContent = active ? "On map" : "Show on map";
        }
    });
}

function clearPreview() {
    if (currentOverlay) {
        map.removeLayer(currentOverlay);
        currentOverlay = null;
    }
    if (currentOverlayUrl) {
        URL.revokeObjectURL(currentOverlayUrl);
        currentOverlayUrl = null;
    }
    drawnItems?.eachLayer(l => l.setStyle({ fillOpacity: AOI_STYLE.fillOpacity }));
    document.getElementById("map-legend").classList.add("hidden");
    markPreviewingScene(null);
}

// ── Errors & toasts ──────────────────────────────────────────────

function showError(message) {
    const area    = document.getElementById("results-area");
    const content = document.getElementById("results-content");

    area.classList.remove("hidden");
    content.innerHTML = `<div class="error-msg" role="alert">${ICONS.alert}<span>${escapeHtml(scrubSentinel(message))}</span></div>`;
}

function showToast(title, body = "", type = "info", timeout = 6000) {
    const region = document.getElementById("toast-region");
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div>
            <div class="toast-title">${escapeHtml(scrubSentinel(title))}</div>
            ${body ? `<div class="toast-body">${escapeHtml(scrubSentinel(body))}</div>` : ""}
        </div>`;
    region.appendChild(toast);

    const dismiss = () => {
        toast.classList.add("leaving");
        toast.addEventListener("animationend", () => toast.remove(), { once: true });
    };
    toast.addEventListener("click", dismiss);
    setTimeout(dismiss, timeout);
}

// ── CSV Preview Modal ──────────────────────────────────────────────

async function previewCsv(csvPath) {
    const modal = document.getElementById("csv-modal");
    const body  = document.getElementById("csv-modal-body");
    const count = document.getElementById("csv-modal-count");

    // Show loading state
    body.innerHTML = '<div class="csv-empty">Loading…</div>';
    count.classList.add("hidden");
    modal.classList.remove("hidden");
    document.getElementById("csv-modal-close").focus();

    try {
        const res = await fetch(`/api/download/${encodeURI(csvPath)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();

        const rows = text.trim().split("\n").map(parseCsvLine).filter(r => r.length > 0);
        if (rows.length === 0) {
            body.innerHTML = '<div class="csv-empty">CSV file is empty.</div>';
            return;
        }

        const headers = rows[0];
        const dataRows = rows.slice(1);

        count.textContent = `${dataRows.length} row${dataRows.length === 1 ? "" : "s"}`;
        count.classList.remove("hidden");

        let tableHtml = '<table class="csv-table"><thead><tr>';
        headers.forEach(h => {
            tableHtml += `<th>${escapeHtml(scrubSentinel(h.replace(/_/g, " ")))}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        const wrapCol = headers.indexOf("Summary");
        dataRows.forEach(row => {
            tableHtml += '<tr>';
            headers.forEach((_, i) => {
                const cls = i === wrapCol ? ' class="cell-wrap"' : "";
                tableHtml += `<td${cls}>${escapeHtml(scrubSentinel(row[i] ?? ""))}</td>`;
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';

        body.innerHTML = tableHtml;
    } catch (err) {
        body.innerHTML = `<div class="csv-empty">Failed to load CSV: ${escapeHtml(scrubSentinel(err.message))}</div>`;
    }
}

function parseCsvLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"') {
                if (i + 1 < line.length && line[i + 1] === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = false;
                }
            } else {
                current += ch;
            }
        } else {
            if (ch === '"') {
                inQuotes = true;
            } else if (ch === ',') {
                result.push(current.trim());
                current = "";
            } else {
                current += ch;
            }
        }
    }
    result.push(current.trim());
    return result;
}

/**
 * Strip "Sentinel" branding from backend-supplied text before it is shown.
 * Mission names become their short codes (sentinel-2b → S2B, Sentinel5P → S5P,
 * sentinel-2-l2a → S2-L2A) — the same codes the scene IDs already use.
 */
function scrubSentinel(str) {
    if (str == null) return str;
    return String(str)
        .replace(/sentinel[\s-]*hub/gi, "imagery service")
        .replace(/sentinel[-_ ]?(\d+[a-z]?)([-_][a-z0-9]+)*/gi, (m) =>
            "S" + m.replace(/^sentinel[-_ ]?/i, "").toUpperCase())
        .replace(/sentinel/gi, "satellite");
}

function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

function closeCsvModal() {
    document.getElementById("csv-modal").classList.add("hidden");
}

// ── Comparison Modal ──────────────────────────────────────────────

async function openCompareModal() {
    const modal    = document.getElementById("compare-modal");
    const runList  = document.getElementById("compare-run-list");
    const tableArea = document.getElementById("compare-table-area");

    compareSelectedRuns = [];
    runList.innerHTML = '<div class="csv-empty">Loading runs…</div>';
    tableArea.innerHTML = '<div class="csv-empty">Select two or more runs on the left<br>to compare their scene metadata side by side.</div>';
    const execBtn = document.getElementById("compare-execute-btn");
    execBtn.disabled = true;
    execBtn.querySelector(".btn-text").textContent = "Compare Selected";
    modal.classList.remove("hidden");
    document.getElementById("compare-modal-close").focus();

    try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const runs = await res.json();

        if (runs.length === 0) {
            runList.innerHTML = '<div class="csv-empty">No past runs yet. Search for scenes and they will appear here.</div>';
            return;
        }

        // Group runs by "mission — product"
        const groups = {};
        runs.forEach(r => {
            const key = scrubSentinel(`${r.mission} — ${r.product}`);
            (groups[key] ??= []).push(r);
        });

        let html = '';
        for (const [groupLabel, items] of Object.entries(groups)) {
            html += `<div class="compare-group-label">${escapeHtml(groupLabel)} (${items.length})</div>`;
            items.forEach(r => {
                const dateStr = r.fetched_at
                    ? new Date(r.fetched_at).toLocaleString("en-US", {
                          month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                      })
                    : "";
                const bboxStr = r.bbox.map(v => v.toFixed(2)).join(", ");
                const product = scrubSentinel(r.product);
                const sourceLabel = dateStr ? `${product} · ${dateStr}` : product;
                html += `
                    <label class="compare-run-item" data-run-id="${escapeHtml(r.id)}" data-csv="${escapeHtml(r.csv_path)}"
                           data-label="${escapeHtml(sourceLabel)}">
                        <input type="checkbox" />
                        <div class="compare-run-meta">
                            <div class="compare-run-product">${escapeHtml(product)}</div>
                            <div class="compare-run-details">${dateStr} · [${bboxStr}]</div>
                        </div>
                        <span class="compare-run-badge"></span>
                    </label>`;
            });
        }
        runList.innerHTML = html;

        // Wire up checkboxes
        runList.querySelectorAll(".compare-run-item").forEach(item => {
            const cb = item.querySelector("input[type=checkbox]");
            cb.addEventListener("change", () => toggleRunSelection(item, cb.checked));
        });

    } catch (err) {
        runList.innerHTML = `<div class="csv-empty">Failed to load runs: ${escapeHtml(scrubSentinel(err.message))}</div>`;
    }
}

function toggleRunSelection(item, isChecked) {
    const runId  = item.dataset.runId;
    const csvPath = item.dataset.csv;

    if (isChecked) {
        if (!compareSelectedRuns.find(r => r.id === runId)) {
            compareSelectedRuns.push({ id: runId, csv: csvPath, label: item.dataset.label });
        }
        item.classList.add("selected");
    } else {
        compareSelectedRuns = compareSelectedRuns.filter(r => r.id !== runId);
        item.classList.remove("selected");
    }

    // Assign colors to selected runs and update badges
    const allItems = document.querySelectorAll(".compare-run-item");
    allItems.forEach(el => {
        const badge = el.querySelector(".compare-run-badge");
        const idx = compareSelectedRuns.findIndex(r => r.id === el.dataset.runId);
        if (idx >= 0) {
            badge.style.backgroundColor = COMPARE_COLORS[idx % COMPARE_COLORS.length];
        }
    });

    // Update execute button
    const btn = document.getElementById("compare-execute-btn");
    const count = compareSelectedRuns.length;
    btn.disabled = count < 2;
    btn.querySelector(".btn-text").textContent = count >= 2
        ? `Compare Selected (${count})`
        : "Compare Selected";
}

async function executeComparison() {
    const tableArea = document.getElementById("compare-table-area");
    tableArea.innerHTML = '<div class="csv-empty">Loading and merging data…</div>';

    // Columns to show. Each lists its header in the plain-language report
    // CSV first, then the technical name used by CSVs from older runs.
    const COMPARE_COLS = [
        { label: "Date / Time", get: rowDateTime },
        { label: "Satellite", keys: ["Satellite", "platform"] },
        { label: "Area visible (%)", keys: ["Cloud-free part of your area (%)", "Part of your area with valid data (%)"] },
        { label: "Data quality", keys: ["Data quality"] },
        { label: "Summary", keys: ["Summary"], wrap: true },
        { label: "Image cloud %", keys: ["Cloud cover of the full satellite image (%)", "cloud_cover_percent"] },
        { label: "Scene ID", keys: ["Scene ID(s)", "scene_id"], truncate: 40 },
    ];
    const cellValue = (row, col) => {
        if (col.get) return col.get(row);
        const key = col.keys.find(k => row[k] != null && row[k] !== "");
        return key ? row[key] : "";
    };

    try {
        // Fetch all CSVs in parallel
        const results = await Promise.all(
            compareSelectedRuns.map(async (run, idx) => {
                const res = await fetch(`/api/download/${encodeURI(run.csv)}`);
                if (!res.ok) throw new Error(`Failed to load run "${run.label}"`);
                const text = await res.text();
                const rows = text.trim().split("\n").map(parseCsvLine).filter(r => r.length > 0);
                return { run, idx, headers: rows[0] || [], dataRows: rows.slice(1) };
            })
        );

        // Merge all rows into a single array with source info
        const merged = [];
        results.forEach(({ run, idx, headers, dataRows }) => {
            const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
            const label = run.label;

            dataRows.forEach(row => {
                const rowObj = {};
                headers.forEach((h, i) => {
                    rowObj[h] = row[i] ?? "";
                });
                rowObj.__source_label = label;
                rowObj.__source_color = color;
                rowObj.__source_idx = idx;
                merged.push(rowObj);
            });
        });

        // Sort chronologically (ascending)
        merged.sort((a, b) => rowSortKey(a).localeCompare(rowSortKey(b)));

        if (merged.length === 0) {
            tableArea.innerHTML = '<div class="csv-empty">No scene data found in selected runs.</div>';
            return;
        }

        // Determine which columns to show (only those that have data)
        const activeCols = COMPARE_COLS.filter(col =>
            merged.some(r => { const v = cellValue(r, col); return v && v !== "N/A"; })
        );

        // Build table
        let html = '<table class="csv-table"><thead><tr>';
        html += '<th>Source</th>';
        activeCols.forEach(col => {
            html += `<th>${col.label}</th>`;
        });
        html += '</tr></thead><tbody>';

        merged.forEach(row => {
            html += '<tr>';
            // Source badge
            html += `<td>
                <span class="source-badge">
                    <span class="source-dot" style="background:${row.__source_color}"></span>
                    ${escapeHtml(row.__source_label)}
                </span>
            </td>`;

            activeCols.forEach(col => {
                const val = scrubSentinel(cellValue(row, col));
                if (col.truncate && val.length > col.truncate) {
                    const short = val.substring(0, col.truncate - 2) + "…";
                    html += `<td title="${escapeHtml(val)}">${escapeHtml(short)}</td>`;
                } else {
                    html += `<td${col.wrap ? ' class="cell-wrap"' : ""}>${escapeHtml(val)}</td>`;
                }
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        tableArea.innerHTML = html;

    } catch (err) {
        tableArea.innerHTML = `<div class="csv-empty">Comparison failed: ${escapeHtml(scrubSentinel(err.message))}</div>`;
    }
}

/** Readable date/time for a CSV row, from either CSV format. */
function rowDateTime(row) {
    if (row["Date"]) return `${row["Date"]} ${row["Time (UTC)"] || ""} UTC`.replace("  ", " ");
    if (row.datetime) {
        const d = new Date(row.datetime);
        return isNaN(d) ? row.datetime : d.toLocaleString("en-US", SCENE_DATE_FMT);
    }
    return "";
}

function rowSortKey(row) {
    return row["Date"] ? `${row["Date"]}T${row["Time (UTC)"] || ""}` : (row.datetime || "");
}

function closeCompareModal() {
    document.getElementById("compare-modal").classList.add("hidden");
}

// ── Fetched Scenes Comparison ──────────────────────────────────────

function updateFetchedCompareBar() {
    let bar = document.getElementById("compare-fetched-bar");
    const content = document.getElementById("results-content");
    if (!content) return;

    if (fetchedScenes.length < 2) {
        if (bar) bar.remove();
        return;
    }

    if (!bar) {
        bar = document.createElement("div");
        bar.id = "compare-fetched-bar";
        bar.className = "compare-fetched-bar";
        content.appendChild(bar);
    }

    bar.innerHTML = `
        <span class="compare-fetched-bar-text">${fetchedScenes.length} scenes fetched</span>
        <button id="trigger-fetched-compare-btn" class="compare-fetched-bar-btn">
            ${ICONS.compare}<span>Compare scenes</span>
        </button>
    `;

    document.getElementById("trigger-fetched-compare-btn").onclick = openFetchedCompareModal;
}

function sortedFetchedScenes() {
    return [...fetchedScenes].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
}

function populateSceneDropdowns(sortedScenes, selectedLeftIdx, selectedRightIdx) {
    const selLeft = document.getElementById("compare-select-left");
    const selRight = document.getElementById("compare-select-right");
    const splitLeft = document.getElementById("split-select-left");
    const splitRight = document.getElementById("split-select-right");

    const fmtOpt = { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

    function buildOptions(currentIdx) {
        return sortedScenes.map((s, idx) => {
            const dStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", fmtOpt) : s.sceneDate;
            const sel = idx === currentIdx ? "selected" : "";
            return `<option value="${idx}" ${sel}>${escapeHtml(dStr)} (${escapeHtml(s.platform || 'Scene')})</option>`;
        }).join("");
    }

    selLeft.innerHTML = buildOptions(selectedLeftIdx);
    selRight.innerHTML = buildOptions(selectedRightIdx);
    splitLeft.innerHTML = buildOptions(selectedLeftIdx);
    splitRight.innerHTML = buildOptions(selectedRightIdx);
}

function onCompareDropdownChange() {
    const sorted = sortedFetchedScenes();
    const leftIdx = +document.getElementById("compare-select-left").value;
    const rightIdx = +document.getElementById("compare-select-right").value;

    const sceneA = sorted[leftIdx] || sorted[0];
    const sceneB = sorted[rightIdx] || sorted[sorted.length - 1];

    initDualMaps(sceneA, sceneB);
}

function onSplitDropdownChange() {
    const sorted = sortedFetchedScenes();
    const leftIdx = +document.getElementById("split-select-left").value;
    const rightIdx = +document.getElementById("split-select-right").value;

    const sceneA = sorted[leftIdx] || sorted[0];
    const sceneB = sorted[rightIdx] || sorted[sorted.length - 1];

    initSplitSlider(sceneA, sceneB);
}

function openFetchedCompareModal() {
    if (fetchedScenes.length < 2) return;

    const modal = document.getElementById("fetched-compare-modal");
    modal.classList.remove("hidden");

    // Sort fetched scenes chronologically by acquisition timestamp
    const sorted = sortedFetchedScenes();
    const sceneA = sorted[0];
    const sceneB = sorted[sorted.length - 1];

    populateSceneDropdowns(sorted, 0, sorted.length - 1);

    document.getElementById("fetched-compare-subtitle").textContent =
        `${sceneA.mission} · ${sceneA.productLabel} · ${fetchedScenes.length} scenes`;

    switchFetchedCompareTab("side-by-side", sceneA, sceneB);
}

function switchFetchedCompareTab(tabName, sceneAOverride, sceneBOverride) {
    const sorted = sortedFetchedScenes();

    const selLeft = document.getElementById("compare-select-left");
    const selRight = document.getElementById("compare-select-right");

    const leftIdx = (selLeft && selLeft.value !== "") ? +selLeft.value : 0;
    const rightIdx = (selRight && selRight.value !== "") ? +selRight.value : sorted.length - 1;

    const sceneA = sceneAOverride || sorted[leftIdx] || sorted[0];
    const sceneB = sceneBOverride || sorted[rightIdx] || sorted[sorted.length - 1];

    ["side-by-side", "split-slider", "multi-grid", "data-table"].forEach((t) => {
        const btn = document.getElementById(`tab-${t}`);
        const view = document.getElementById(`view-${t}`);
        if (!btn || !view) return;
        const active = t === tabName;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active);
        view.classList.toggle("hidden", !active);
    });

    if (tabName === "side-by-side") {
        setTimeout(() => initDualMaps(sceneA, sceneB), 100);
    } else if (tabName === "split-slider") {
        setTimeout(() => initSplitSlider(sceneA, sceneB), 100);
    } else if (tabName === "multi-grid") {
        setTimeout(() => initMultiGridMaps(sorted), 100);
    } else if (tabName === "data-table") {
        renderFetchedDataTable(sorted);
    }
}

/**
 * Create a comparison map. Zoom sits bottom-right so it doesn't collide with
 * the scene label pinned to the top-left of each panel.
 */
function makeCompareMap(elementId, center) {
    const m = L.map(elementId, { center, zoom: 10, zoomControl: false });
    L.control.zoom({ position: "bottomright" }).addTo(m);
    L.tileLayer(TILE_URL, { maxZoom: 19 }).addTo(m);
    return m;
}

function previewUrl(scene) {
    return `/api/preview/${encodeURI(scene.rasterPath)}?product_id=${scene.productId}`;
}

function initDualMaps(sceneA, sceneB) {
    const bounds = bboxBounds(sceneA.bbox);
    const center = [(sceneA.bbox[1] + sceneA.bbox[3]) / 2, (sceneA.bbox[0] + sceneA.bbox[2]) / 2];

    if (leftMap) { leftMap.remove(); leftMap = null; }
    if (rightMap) { rightMap.remove(); rightMap = null; }

    leftMap = makeCompareMap("map-compare-left", center);
    rightMap = makeCompareMap("map-compare-right", center);

    leftOverlay = L.imageOverlay(previewUrl(sceneA), bounds, { opacity: 0.9 }).addTo(leftMap);
    rightOverlay = L.imageOverlay(previewUrl(sceneB), bounds, { opacity: 0.9 }).addTo(rightMap);

    leftMap.fitBounds(bounds, { padding: [30, 30] });
    rightMap.fitBounds(bounds, { padding: [30, 30] });

    function sync(sourceMap, targetMap) {
        sourceMap.on("move", () => {
            if (isSyncingMaps) return;
            isSyncingMaps = true;
            targetMap.setView(sourceMap.getCenter(), sourceMap.getZoom(), { animate: false });
            isSyncingMaps = false;
        });
    }
    sync(leftMap, rightMap);
    sync(rightMap, leftMap);

    setTimeout(() => {
        if (leftMap) leftMap.invalidateSize();
        if (rightMap) rightMap.invalidateSize();
    }, 150);
}

function initSplitSlider(sceneA, sceneB) {
    const bounds = bboxBounds(sceneA.bbox);
    const center = [(sceneA.bbox[1] + sceneA.bbox[3]) / 2, (sceneA.bbox[0] + sceneA.bbox[2]) / 2];

    if (splitMap) { splitMap.remove(); splitMap = null; }

    splitMap = makeCompareMap("map-compare-split", center);

    splitOverlayLeft = L.imageOverlay(previewUrl(sceneA), bounds, { opacity: 0.95 }).addTo(splitMap);
    splitOverlayRight = L.imageOverlay(previewUrl(sceneB), bounds, { opacity: 0.95 }).addTo(splitMap);

    splitMap.fitBounds(bounds, { padding: [30, 30] });

    const slider = document.getElementById("split-slider");
    const line = document.getElementById("split-slider-line");

    function updateClip() {
        const val = slider.value;
        line.style.left = `${val}%`;

        const elRight = splitOverlayRight.getElement();
        if (elRight) {
            elRight.style.clipPath = `polygon(${val}% 0, 100% 0, 100% 100%, ${val}% 100%)`;
        }
    }

    slider.oninput = updateClip;

    setTimeout(() => {
        if (splitMap) splitMap.invalidateSize();
        updateClip();
    }, 150);
}

function initMultiGridMaps(sortedScenes) {
    const container = document.getElementById("multi-grid-container");
    container.innerHTML = "";

    gridMaps.forEach(m => { try { m.remove(); } catch (_) {} });
    gridMaps = [];

    const scenesToDisplay = sortedScenes.slice(0, 4);
    const count = scenesToDisplay.length;
    container.className = `multi-grid-container grid-${count}`;

    scenesToDisplay.forEach((s, idx) => {
        const dateStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", SCENE_DATE_FMT) : s.sceneDate;
        const panel = document.createElement("div");
        panel.className = "map-panel";
        panel.innerHTML = `
            <div class="map-panel-header">
                <span class="badge badge-left">${idx + 1}</span>
                <span class="panel-date">${escapeHtml(dateStr)}</span>
            </div>
            <div id="map-grid-${idx}" class="compare-map"></div>
        `;
        container.appendChild(panel);

        const bounds = bboxBounds(s.bbox);
        const center = [(s.bbox[1] + s.bbox[3]) / 2, (s.bbox[0] + s.bbox[2]) / 2];

        const gMap = makeCompareMap(`map-grid-${idx}`, center);
        L.imageOverlay(previewUrl(s), bounds, { opacity: 0.9 }).addTo(gMap);
        gMap.fitBounds(bounds, { padding: [20, 20] });

        gridMaps.push(gMap);
    });

    gridMaps.forEach((sourceMap) => {
        sourceMap.on("move", () => {
            if (isSyncingMaps) return;
            isSyncingMaps = true;
            gridMaps.forEach((targetMap) => {
                if (targetMap !== sourceMap) {
                    targetMap.setView(sourceMap.getCenter(), sourceMap.getZoom(), { animate: false });
                }
            });
            isSyncingMaps = false;
        });
    });

    setTimeout(() => {
        gridMaps.forEach(m => m.invalidateSize());
    }, 150);
}

function renderFetchedDataTable(sortedScenes) {
    const area = document.getElementById("fetched-table-area");

    const ths = sortedScenes.map((s, idx) => {
        const dateStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", SCENE_DATE_FMT) : s.sceneDate;
        return `<th>Scene ${idx + 1}<span class="th-sub">${escapeHtml(dateStr)}</span></th>`;
    }).join("");

    const row = (label, cells) => `<tr><td>${label}</td>${cells}</tr>`;
    const cells = (fn) => sortedScenes.map(fn).join("");

    area.innerHTML = `
        <div class="matrix-table-wrapper">
            <table class="matrix-table">
                <thead>
                    <tr>
                        <th>Parameter</th>
                        ${ths}
                    </tr>
                </thead>
                <tbody>
                    ${row("Mission &amp; Product", cells(s => `<td class="matrix-col-val">${escapeHtml(s.mission)} — ${escapeHtml(s.productLabel)}</td>`))}
                    ${row("Acquisition Time", cells(s => {
                        const d = s.datetime ? new Date(s.datetime).toLocaleString("en-US", SCENE_DATE_FMT) : s.sceneDate;
                        return `<td class="matrix-col-val">${escapeHtml(d)}</td>`;
                    }))}
                    ${row("Cloud Cover", cells(s => `<td>${s.cloudCover != null ? cloudPill(s.cloudCover) : '<span class="matrix-col-val">N/A</span>'}</td>`))}
                    ${row("Platform", cells(s => `<td class="matrix-col-val">${escapeHtml(s.platform)}</td>`))}
                    ${row("Scene ID", cells(s => `<td class="matrix-col-val" style="font-size:11px; word-break:break-all">${escapeHtml(s.sceneId)}</td>`))}
                    ${row("Bounding Box", cells(s => `<td class="matrix-col-val">[${s.bbox.join(", ")}]</td>`))}
                    ${row("Raster", cells(s => `
                        <td>
                            <a class="download-btn" href="/api/download/${encodeURI(s.rasterPath)}?product_id=${s.productId}" download>
                                ${ICONS.download}<span>Download</span>
                            </a>
                        </td>`))}
                </tbody>
                <tbody id="matrix-report-body">
                    <tr class="matrix-section"><td colspan="${sortedScenes.length + 1}">Measurements <span class="matrix-section-note">Loading…</span></td></tr>
                </tbody>
            </table>
        </div>
    `;

    renderFetchedReportRows(sortedScenes);
}

// Report CSV columns already shown in the rows above, or not useful per scene
const MATRIX_SKIP_COLS = new Set([
    "Date", "Time (UTC)", "Satellite", "Scene ID(s)",
    "Cloud cover of the full satellite image (%)",
]);

const reportCsvCache = {};

/** Load a scene report CSV once, indexed by its "Date" column. */
async function loadReportCsv(csvPath) {
    if (!reportCsvCache[csvPath]) {
        reportCsvCache[csvPath] = (async () => {
            const res = await fetch(`/api/download/${encodeURI(csvPath)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const rows = (await res.text()).trim().split("\n").map(parseCsvLine).filter(r => r.length > 1);
            const headers = rows[0] || [];
            const dateIdx = headers.indexOf("Date");
            const byDate = {};
            if (dateIdx >= 0) {
                rows.slice(1).forEach(r => {
                    byDate[r[dateIdx]] = Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]));
                });
            }
            return { headers, byDate };
        })();
        // Don't cache a failure — let the next open retry
        reportCsvCache[csvPath].catch(() => delete reportCsvCache[csvPath]);
    }
    return reportCsvCache[csvPath];
}

function qualityPill(value) {
    const level = { "Good": "low", "Fair": "mid", "Poor": "high", "No usable data": "high" }[value];
    return level ? `<span class="cloud-pill ${level}">${escapeHtml(value)}</span>`
                 : `<span class="matrix-muted">${escapeHtml(value || "—")}</span>`;
}

/**
 * Append the per-date measurements from the search's scene CSV (vegetation
 * cover, water area, gas levels, …) under the metadata rows.
 */
async function renderFetchedReportRows(sortedScenes) {
    const body = document.getElementById("matrix-report-body");
    const span = sortedScenes.length + 1;
    const section = (note) =>
        `<tr class="matrix-section"><td colspan="${span}">Measurements${note ? ` <span class="matrix-section-note">${note}</span>` : ""}</td></tr>`;

    try {
        // Scenes from one search share a CSV; load each distinct one
        const paths = [...new Set(sortedScenes.map(s => s.csvPath).filter(Boolean))];
        const reports = Object.fromEntries(await Promise.all(
            paths.map(async p => [p, await loadReportCsv(p)])));
        if (!document.body.contains(body)) return;      // tab re-rendered meanwhile

        const sceneRows = sortedScenes.map(s => reports[s.csvPath]?.byDate[s.sceneDate] || null);
        const headers = [...new Set(paths.flatMap(p => reports[p].headers))]
            .filter(h => !MATRIX_SKIP_COLS.has(h) && sceneRows.some(r => r && r[h] !== ""));

        if (!headers.length) {
            body.innerHTML = section("No per-date measurements in this search's CSV.");
            return;
        }

        const cell = (h, r) => {
            const v = r ? scrubSentinel(r[h] ?? "") : "";
            if (h === "Data quality") return `<td>${qualityPill(v)}</td>`;
            if (h === "Summary") return `<td class="matrix-summary">${escapeHtml(v || "—")}</td>`;
            if (v === "") return `<td class="matrix-muted">—</td>`;
            return `<td class="matrix-col-val">${escapeHtml(v)}</td>`;
        };

        // Put the plain-language summary first, before the numbers
        headers.sort((a, b) => (b === "Summary") - (a === "Summary"));

        const csvLinks = paths.map(p =>
            `<a class="link-btn" href="/api/download/${encodeURI(p)}" download>Download CSV</a>`).join(" ");
        body.innerHTML = section(`From the scene CSV · ${csvLinks}`) + headers.map(h => `
            <tr>
                <td>${escapeHtml(scrubSentinel(h))}</td>
                ${sceneRows.map(r => cell(h, r)).join("")}
            </tr>`).join("");
    } catch (err) {
        if (document.body.contains(body)) {
            body.innerHTML = section(`Couldn't load the scene CSV: ${escapeHtml(scrubSentinel(err.message))}`);
        }
    }
}

function closeFetchedCompareModal() {
    document.getElementById("fetched-compare-modal").classList.add("hidden");
    if (leftMap) { leftMap.remove(); leftMap = null; }
    if (rightMap) { rightMap.remove(); rightMap = null; }
    if (splitMap) { splitMap.remove(); splitMap = null; }
    gridMaps.forEach(m => { try { m.remove(); } catch (_) {} });
    gridMaps = [];
}
