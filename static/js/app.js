/* ================================================================
   TeraVerify — Frontend Logic
   ================================================================ */

// ── State ────────────────────────────────────────────────────────

let map;
let drawnItems;
let currentBbox   = null;
let currentOverlay = null;
let products      = {};
let compareSelectedRuns = [];

// Fetched scenes comparison state
let fetchedScenes = [];
let leftMap = null, rightMap = null, splitMap = null;
let gridMaps = [];
let leftOverlay = null, rightOverlay = null, splitOverlayLeft = null, splitOverlayRight = null;
let isSyncingMaps = false;

// Color palette for comparison source badges
const COMPARE_COLORS = [
    "#818cf8", "#06b6d4", "#10b981", "#f59e0b",
    "#ef4444", "#ec4899", "#8b5cf6", "#14b8a6",
];

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

    // Escape closes any open modal
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") {
            closeCsvModal();
            closeCompareModal();
            closeFetchedCompareModal();
        }
    });
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

    // Reset current session fetched scenes
    fetchedScenes = [];
    updateFetchedCompareBar();

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

    // Store data on the area element for later use by fetchScene
    area._data = data;
    area.classList.remove("hidden");

    let html = `
        <div class="result-stat">
            <span class="stat-icon">🛰️</span>
            <span>${data.product.mission} — ${data.product.label}</span>
        </div>
        <div class="result-stat">
            <span class="stat-icon">📊</span>
            <span><span class="stat-value">${data.scenes_count}</span> scene(s) found</span>
        </div>

        <a class="download-btn" href="/api/download/${encodeURI(data.csv_path)}" download>
            <span>📥</span><span>Download Scene CSV</span>
        </a>
        <button class="csv-preview-btn" id="csv-preview-btn"
                data-csv="${data.csv_path}">
            <span>👁️</span><span>Preview CSV</span>
        </button>
    `;

    // Scene list with Fetch buttons
    if (data.scenes?.length) {
        html += '<div class="scene-list">';
        data.scenes.forEach((s, idx) => {
            const dateStr = s.datetime
                ? new Date(s.datetime).toLocaleDateString("en-US", {
                      year: "numeric", month: "short", day: "numeric",
                      hour: "2-digit", minute: "2-digit",
                  })
                : "N/A";
            const cloud =
                s.cloud_cover != null ? `<div class="scene-cloud">☁️ ${s.cloud_cover}%</div>` : "";
            const sceneDate = s.datetime ? s.datetime.split("T")[0] : "";
            html += `
                <div class="scene-item" id="scene-item-${idx}">
                    <div class="scene-info-row">
                        <div>
                            <div class="scene-date">${dateStr}</div>
                            <div class="scene-id" title="${s.id}">${s.id}</div>
                            ${cloud}
                        </div>
                        <button class="scene-fetch-btn" id="scene-fetch-${idx}"
                                data-scene-date="${sceneDate}"
                                data-scene-idx="${idx}">
                            📥 Fetch
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

    if (!sceneDate || !data) return;

    // Show loading state
    btn.disabled = true;
    btn.textContent = "⏳ Fetching…";

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

        // Replace Fetch button with success indicator
        btn.textContent = "✅ Fetched";
        btn.classList.add("scene-fetch-done");

        // Show download + preview actions
        actionsEl.classList.remove("hidden");
        actionsEl.innerHTML = `
            <a class="download-btn" href="/api/download/${encodeURI(result.raster_path)}" download>
                <span>📥</span><span>Download ${ext}</span>
            </a>
            <button class="preview-btn scene-preview-btn"
                    data-path="${result.raster_path}"
                    data-bbox="${result.bbox.join(",")}"
                    data-pid="${result.product_id}">
                <span>🗺️</span><span>Preview on Map</span>
            </button>
        `;

        // Wire up preview button
        actionsEl.querySelector(".scene-preview-btn").addEventListener("click", function () {
            const bbox = this.dataset.bbox.split(",").map(Number);
            showPreview(this.dataset.path, bbox, this.dataset.pid);
        });

        // Highlight the fetched scene
        itemEl.classList.add("scene-fetched");

        // Save fetched scene info to state for dataset comparison
        const sceneMeta = (data.scenes && data.scenes[sceneIdx]) ? data.scenes[sceneIdx] : {};
        const fetchedItem = {
            sceneIdx,
            sceneDate,
            datetime: sceneMeta.datetime || sceneDate,
            cloudCover: sceneMeta.cloud_cover,
            sceneId: sceneMeta.id || "N/A",
            platform: sceneMeta.platform || "N/A",
            rasterPath: result.raster_path,
            bbox: result.bbox,
            productId: result.product_id,
            productLabel: data.product ? data.product.label : "Satellite Product",
            mission: data.product ? data.product.mission : "Sentinel",
        };

        const existingIdx = fetchedScenes.findIndex(s => s.sceneDate === sceneDate);
        if (existingIdx >= 0) {
            fetchedScenes[existingIdx] = fetchedItem;
        } else {
            fetchedScenes.push(fetchedItem);
        }

        updateFetchedCompareBar();

    } catch (err) {
        btn.textContent = "❌ Failed";
        btn.disabled = false;
        btn.title = err.message;
        setTimeout(() => {
            btn.textContent = "📥 Retry";
            btn.classList.remove("scene-fetch-done");
        }, 2000);
    }
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

// ── CSV Preview Modal ──────────────────────────────────────────────

async function previewCsv(csvPath) {
    const modal = document.getElementById("csv-modal");
    const body  = document.getElementById("csv-modal-body");

    // Show loading state
    body.innerHTML = '<div class="csv-empty">Loading CSV…</div>';
    modal.classList.remove("hidden");

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

        let tableHtml = '<table class="csv-table"><thead><tr>';
        headers.forEach(h => {
            tableHtml += `<th>${escapeHtml(h)}</th>`;
        });
        tableHtml += '</tr></thead><tbody>';

        dataRows.forEach(row => {
            tableHtml += '<tr>';
            headers.forEach((_, i) => {
                tableHtml += `<td>${escapeHtml(row[i] ?? "")}</td>`;
            });
            tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';

        body.innerHTML = tableHtml;
    } catch (err) {
        body.innerHTML = `<div class="csv-empty">⚠️ Failed to load CSV: ${escapeHtml(err.message)}</div>`;
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
    tableArea.innerHTML = '<div class="csv-empty">Select 2 or more runs to compare their scene metadata side by side.</div>';
    document.getElementById("compare-execute-btn").disabled = true;
    modal.classList.remove("hidden");

    try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const runs = await res.json();

        if (runs.length === 0) {
            runList.innerHTML = '<div class="csv-empty">No past runs found in the output folder.</div>';
            return;
        }

        // Group runs by "mission — product"
        const groups = {};
        runs.forEach(r => {
            const key = `${r.mission} — ${r.product}`;
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
                html += `
                    <label class="compare-run-item" data-run-id="${escapeHtml(r.id)}" data-csv="${escapeHtml(r.csv_path)}">
                        <input type="checkbox" />
                        <div class="compare-run-meta">
                            <div class="compare-run-product">${escapeHtml(r.product)}</div>
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
        runList.innerHTML = `<div class="csv-empty">⚠️ Failed to load runs: ${escapeHtml(err.message)}</div>`;
    }
}

function toggleRunSelection(item, isChecked) {
    const runId  = item.dataset.runId;
    const csvPath = item.dataset.csv;

    if (isChecked) {
        if (!compareSelectedRuns.find(r => r.id === runId)) {
            compareSelectedRuns.push({ id: runId, csv: csvPath });
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

    // Key columns to show in comparison
    const SHOW_COLS = ["scene_id", "datetime", "platform", "cloud_cover_percent", "s5p_product_type", "orbit_state"];
    const COL_LABELS = {
        scene_id: "Scene ID",
        datetime: "Date / Time",
        platform: "Platform",
        cloud_cover_percent: "Cloud %",
        s5p_product_type: "S5P Type",
        orbit_state: "Orbit",
    };

    try {
        // Fetch all CSVs in parallel
        const results = await Promise.all(
            compareSelectedRuns.map(async (run, idx) => {
                const res = await fetch(`/api/download/${encodeURI(run.csv)}`);
                if (!res.ok) throw new Error(`Failed to fetch ${run.id}`);
                const text = await res.text();
                const rows = text.trim().split("\n").map(parseCsvLine).filter(r => r.length > 0);
                return { run, idx, headers: rows[0] || [], dataRows: rows.slice(1) };
            })
        );

        // Merge all rows into a single array with source info
        const merged = [];
        results.forEach(({ run, idx, headers, dataRows }) => {
            const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
            // Build a short label for the source
            const parts = run.id.split("_");
            const label = parts.slice(0, 2).join(" ").replace(/Sentinel(\d)/, "S-$1");

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

        // Sort by datetime (ascending)
        merged.sort((a, b) => {
            const da = a.datetime || "";
            const db = b.datetime || "";
            return da.localeCompare(db);
        });

        if (merged.length === 0) {
            tableArea.innerHTML = '<div class="csv-empty">No scene data found in selected runs.</div>';
            return;
        }

        // Determine which columns to show (only those that have data)
        const activeCols = SHOW_COLS.filter(col =>
            merged.some(r => r[col] && r[col] !== "" && r[col] !== "N/A")
        );

        // Build table
        let html = '<table class="csv-table"><thead><tr>';
        html += '<th>Source</th>';
        activeCols.forEach(col => {
            html += `<th>${COL_LABELS[col] || col}</th>`;
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
                let val = row[col] ?? "";
                // Format datetime nicely
                if (col === "datetime" && val) {
                    try {
                        val = new Date(val).toLocaleString("en-US", {
                            year: "numeric", month: "short", day: "numeric",
                            hour: "2-digit", minute: "2-digit",
                        });
                    } catch (_) { /* keep raw */ }
                }
                // Truncate long scene IDs
                if (col === "scene_id" && val.length > 40) {
                    const short = val.substring(0, 38) + "…";
                    html += `<td title="${escapeHtml(val)}">${escapeHtml(short)}</td>`;
                } else {
                    html += `<td>${escapeHtml(val)}</td>`;
                }
            });
            html += '</tr>';
        });

        html += '</tbody></table>';
        tableArea.innerHTML = html;

    } catch (err) {
        tableArea.innerHTML = `<div class="csv-empty">⚠️ Comparison failed: ${escapeHtml(err.message)}</div>`;
    }
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
        content.insertBefore(bar, content.firstChild);
    }

    bar.innerHTML = `
        <span class="compare-fetched-bar-text">⚖️ ${fetchedScenes.length} fetched scenes ready to compare</span>
        <button id="trigger-fetched-compare-btn" class="compare-fetched-bar-btn">
            <span>Compare Scenes (${fetchedScenes.length})</span>
        </button>
    `;

    document.getElementById("trigger-fetched-compare-btn").onclick = openFetchedCompareModal;
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
            return `<option value="${idx}" ${sel}>${escapeHtml(dStr)} (${s.platform || 'Scene'})</option>`;
        }).join("");
    }

    selLeft.innerHTML = buildOptions(selectedLeftIdx);
    selRight.innerHTML = buildOptions(selectedRightIdx);
    splitLeft.innerHTML = buildOptions(selectedLeftIdx);
    splitRight.innerHTML = buildOptions(selectedRightIdx);
}

function onCompareDropdownChange() {
    const sorted = [...fetchedScenes].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
    const leftIdx = +document.getElementById("compare-select-left").value;
    const rightIdx = +document.getElementById("compare-select-right").value;

    const sceneA = sorted[leftIdx] || sorted[0];
    const sceneB = sorted[rightIdx] || sorted[sorted.length - 1];

    initDualMaps(sceneA, sceneB);
}

function onSplitDropdownChange() {
    const sorted = [...fetchedScenes].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
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
    const sorted = [...fetchedScenes].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));
    const sceneA = sorted[0];
    const sceneB = sorted[sorted.length - 1];

    populateSceneDropdowns(sorted, 0, sorted.length - 1);

    document.getElementById("fetched-compare-subtitle").textContent =
        `${sceneA.mission} ${sceneA.productLabel} — ${fetchedScenes.length} fetched scenes available for comparison`;

    switchFetchedCompareTab("side-by-side", sceneA, sceneB);
}

function switchFetchedCompareTab(tabName, sceneAOverride, sceneBOverride) {
    const sorted = [...fetchedScenes].sort((a, b) => (a.datetime || "").localeCompare(b.datetime || ""));

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
        if (t === tabName) {
            btn.classList.add("active");
            view.classList.remove("hidden");
        } else {
            btn.classList.remove("active");
            view.classList.add("hidden");
        }
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

function initDualMaps(sceneA, sceneB) {
    const bbox = sceneA.bbox;
    const bounds = [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
    ];
    const center = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];

    if (leftMap) { leftMap.remove(); leftMap = null; }
    if (rightMap) { rightMap.remove(); rightMap = null; }

    leftMap = L.map("map-compare-left", { center, zoom: 10, zoomControl: true });
    rightMap = L.map("map-compare-right", { center, zoom: 10, zoomControl: true });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(leftMap);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(rightMap);

    const urlA = `/api/preview/${encodeURI(sceneA.rasterPath)}?product_id=${sceneA.productId}`;
    const urlB = `/api/preview/${encodeURI(sceneB.rasterPath)}?product_id=${sceneB.productId}`;

    leftOverlay = L.imageOverlay(urlA, bounds, { opacity: 0.9 }).addTo(leftMap);
    rightOverlay = L.imageOverlay(urlB, bounds, { opacity: 0.9 }).addTo(rightMap);

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
    const bbox = sceneA.bbox;
    const bounds = [
        [bbox[1], bbox[0]],
        [bbox[3], bbox[2]],
    ];
    const center = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];

    if (splitMap) { splitMap.remove(); splitMap = null; }

    splitMap = L.map("map-compare-split", { center, zoom: 10, zoomControl: true });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(splitMap);

    const urlA = `/api/preview/${encodeURI(sceneA.rasterPath)}?product_id=${sceneA.productId}`;
    const urlB = `/api/preview/${encodeURI(sceneB.rasterPath)}?product_id=${sceneB.productId}`;

    splitOverlayLeft = L.imageOverlay(urlA, bounds, { opacity: 0.95 }).addTo(splitMap);
    splitOverlayRight = L.imageOverlay(urlB, bounds, { opacity: 0.95 }).addTo(splitMap);

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

    const fmtOpt = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

    scenesToDisplay.forEach((s, idx) => {
        const dateStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", fmtOpt) : s.sceneDate;
        const panel = document.createElement("div");
        panel.className = "map-panel";
        panel.innerHTML = `
            <div class="map-panel-header">
                <span class="badge badge-left">Scene ${idx + 1}</span>
                <span class="panel-date">${escapeHtml(dateStr)}</span>
            </div>
            <div id="map-grid-${idx}" class="compare-map"></div>
        `;
        container.appendChild(panel);

        const bbox = s.bbox;
        const bounds = [
            [bbox[1], bbox[0]],
            [bbox[3], bbox[2]],
        ];
        const center = [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];

        const gMap = L.map(`map-grid-${idx}`, { center, zoom: 10, zoomControl: true });
        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(gMap);

        const url = `/api/preview/${encodeURI(s.rasterPath)}?product_id=${s.productId}`;
        L.imageOverlay(url, bounds, { opacity: 0.9 }).addTo(gMap);
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
    const fmtOpt = { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };

    let ths = sortedScenes.map((s, idx) => {
        const dateStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", fmtOpt) : s.sceneDate;
        return `<th>Scene ${idx + 1}<br><span style="font-weight:normal; text-transform:none">${escapeHtml(dateStr)}</span></th>`;
    }).join("");

    let rowProduct = sortedScenes.map(s => `<td class="matrix-col-val">${escapeHtml(s.mission)} — ${escapeHtml(s.productLabel)}</td>`).join("");
    let rowTime = sortedScenes.map(s => {
        const dStr = s.datetime ? new Date(s.datetime).toLocaleString("en-US", fmtOpt) : s.sceneDate;
        return `<td class="matrix-col-val">${escapeHtml(dStr)}</td>`;
    }).join("");
    let rowCloud = sortedScenes.map(s => `<td class="matrix-col-val">${s.cloudCover != null ? s.cloudCover + '%' : 'N/A'}</td>`).join("");
    let rowPlatform = sortedScenes.map(s => `<td class="matrix-col-val">${escapeHtml(s.platform)}</td>`).join("");
    let rowId = sortedScenes.map(s => `<td class="matrix-col-val" style="font-size:11px; word-break:break-all">${escapeHtml(s.sceneId)}</td>`).join("");
    let rowBbox = sortedScenes.map(s => `<td class="matrix-col-val">[${s.bbox.join(", ")}]</td>`).join("");
    let rowDownload = sortedScenes.map(s => `
        <td>
            <a class="download-btn" href="/api/download/${encodeURI(s.rasterPath)}" download>
                📥 Download
            </a>
        </td>
    `).join("");

    area.innerHTML = `
        <div class="matrix-table-wrapper" style="max-width: none">
            <table class="matrix-table">
                <thead>
                    <tr>
                        <th>Metadata Parameter</th>
                        ${ths}
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td>Mission &amp; Product</td>
                        ${rowProduct}
                    </tr>
                    <tr>
                        <td>Acquisition Time</td>
                        ${rowTime}
                    </tr>
                    <tr>
                        <td>Cloud Cover</td>
                        ${rowCloud}
                    </tr>
                    <tr>
                        <td>Platform / Satellite</td>
                        ${rowPlatform}
                    </tr>
                    <tr>
                        <td>Scene ID</td>
                        ${rowId}
                    </tr>
                    <tr>
                        <td>Bounding Box</td>
                        ${rowBbox}
                    </tr>
                    <tr>
                        <td>Download Raster</td>
                        ${rowDownload}
                    </tr>
                </tbody>
            </table>
        </div>
    `;
}

function closeFetchedCompareModal() {
    document.getElementById("fetched-compare-modal").classList.add("hidden");
    if (leftMap) { leftMap.remove(); leftMap = null; }
    if (rightMap) { rightMap.remove(); rightMap = null; }
    if (splitMap) { splitMap.remove(); splitMap = null; }
    gridMaps.forEach(m => { try { m.remove(); } catch (_) {} });
    gridMaps = [];
}
