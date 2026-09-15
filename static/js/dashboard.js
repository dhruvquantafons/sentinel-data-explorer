/* ================================================================
   BluVerify — Start dashboard

   Fills the space the map will take until an area is chosen: summary
   stats, example areas, recent searches and the product catalogue.
   Uses app.js globals: applyCoordinates, previewCsv, openCompareModal,
   escapeHtml, bboxAreaKm2.
   ================================================================ */

(() => {

// Real areas, each used for the landing-page captures
const EXAMPLES = [
    { title: "Farmland near Anand", place: "Gujarat", bbox: [72.80, 22.45, 73.05, 22.65],
      productId: "2", img: "/static/img/screens/use-agri.webp" },
    { title: "Central Ahmedabad", place: "Gujarat", bbox: [72.50, 22.97, 72.64, 23.07],
      productId: "1", img: "/static/img/screens/use-urban.webp" },
    { title: "Narmada estuary, Bharuch", place: "Gujarat", bbox: [72.88, 21.60, 73.10, 21.78],
      productId: "3", img: "/static/img/screens/use-water.webp" },
];

const MISSION_CLASS = {
    "Optical Imagery": "optical",
    "Radar (SAR)": "radar",
    "Ocean & Land Color": "ocean",
    "Atmospheric Air Quality": "air",
};
const RECENT_LIMIT = 6;

let catalog = {};      // product id -> {mission, label}
let runs = [];

document.addEventListener("DOMContentLoaded", async () => {
    document.getElementById("dash-all-runs").addEventListener("click", () => openCompareModal());
    // Tool cards and use-case chips: switch mode and/or pick a product
    document.getElementById("dashboard").addEventListener("click", (e) => {
        const modeBtn = e.target.closest("[data-dash-mode]");
        const productBtn = e.target.closest("[data-product]");
        if (modeBtn) switchMode(modeBtn.dataset.dashMode);
        else if (productBtn) pickProduct(productBtn.dataset.product);
    });
    try {
        const res = await fetch("/api/products");
        if (res.ok) catalog = await res.json();
    } catch { /* the catalogue card just stays empty */ }
    renderExamples();
    renderProducts();
    refreshDashboard();
});

/** Reload past runs and redraw the stats and the recent list. */
async function refreshDashboard() {
    try {
        const res = await fetch("/api/runs");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        runs = await res.json();
    } catch {
        runs = [];
    }
    renderStats();
    renderRecent();
}
window.refreshDashboard = refreshDashboard;

// ── Helpers ──────────────────────────────────────────────────────

/** Short product name, e.g. "NDVI (vegetation health)" -> "NDVI". */
function shortLabel(label) {
    return label.replace(/\s*\(.*\)\s*$/, "").replace(/_/g, " ");
}

function norm(s) {
    return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Catalogue id for a past run (runs store the product name from the folder). */
function productIdForRun(run) {
    const want = norm(run.product);
    return Object.keys(catalog).find(id =>
        catalog[id].mission === run.mission && norm(catalog[id].label).startsWith(want)) || null;
}

function selectProduct(id) {
    const sel = document.getElementById("product-select");
    if (!id || !sel.querySelector(`option[value="${id}"]`)) return;
    sel.value = id;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
}

function inCarbonMode() {
    return document.getElementById("app").classList.contains("carbon-mode");
}

/** Switch the side panel to a mode (carbon.js owns the switch) and focus its first field. */
function switchMode(mode) {
    document.getElementById(mode === "carbon" ? "mode-carbon" : "mode-scenes").click();
    document.getElementById(mode === "carbon" ? "district-input" : "product-select").focus();
}

/** Products belong to satellite scenes, so switch back to that mode first. */
function pickProduct(id) {
    if (inCarbonMode()) switchMode("scenes");
    selectProduct(id);
    document.getElementById("product-select").focus();
}

function useArea(bbox, productId) {
    // Products only apply to satellite scenes; in carbon mode the area is enough
    if (!inCarbonMode()) selectProduct(productId);
    applyCoordinates(bbox);
}

function fmtArea(bbox) {
    const km2 = bboxAreaKm2(bbox);
    return km2 >= 1000 ? `${Math.round(km2).toLocaleString()} km²` : `${km2.toFixed(1)} km²`;
}

function fmtWhen(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return "";
    const today = new Date();
    const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate());
    const diff = Math.round((day(today) - day(d)) / 86400000);
    const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    if (diff === 0) return `Today, ${time}`;
    if (diff === 1) return `Yesterday, ${time}`;
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" }) + `, ${time}`;
}

function fmtBbox(b) {
    return `${b[0].toFixed(2)}, ${b[1].toFixed(2)} → ${b[2].toFixed(2)}, ${b[3].toFixed(2)}`;
}

function setStat(key, value, sub) {
    document.querySelector(`[data-stat="${key}"]`).textContent = value;
    document.querySelector(`[data-stat="${key}-sub"]`).textContent = sub || " ";
}

// ── Stats ────────────────────────────────────────────────────────

function renderStats() {
    const weekAgo = Date.now() - 7 * 86400000;
    const thisWeek = runs.filter(r => new Date(r.fetched_at) >= weekAgo).length;
    setStat("runs", runs.length.toLocaleString(), runs.length ? `${thisWeek} in the last 7 days` : "None yet");

    const areas = new Map(runs.map(r => [r.bbox.join(","), r.bbox]));
    const totalKm2 = [...areas.values()].reduce((sum, b) => sum + bboxAreaKm2(b), 0);
    setStat("areas", areas.size.toLocaleString(),
        areas.size ? `≈ ${Math.round(totalKm2).toLocaleString()} km² covered` : "Choose one to start");

    if (runs.length) {
        setStat("last", runs[0].product.replace(/-/g, "/"), fmtWhen(runs[0].fetched_at));
    } else {
        setStat("last", "—", "No searches yet");
    }

    const ids = Object.keys(catalog);
    const missions = new Set(ids.map(id => catalog[id].mission));
    setStat("products", ids.length || "–", ids.length ? `across ${missions.size} satellite missions` : "");
}

// ── Example areas ────────────────────────────────────────────────

function renderExamples() {
    const el = document.getElementById("dash-examples");
    el.innerHTML = EXAMPLES.map((ex, i) => {
        const product = catalog[ex.productId];
        return `
            <button type="button" class="dash-example" data-i="${i}">
                <span class="dash-example-img"><img src="${ex.img}" alt="" loading="lazy"></span>
                <span class="dash-example-body">
                    <span class="dash-example-title">${escapeHtml(ex.title)}</span>
                    <span class="dash-example-sub">${escapeHtml(ex.place)} · ${fmtArea(ex.bbox)}</span>
                    ${product ? `<span class="dash-tag">${escapeHtml(shortLabel(product.label))}</span>` : ""}
                </span>
            </button>`;
    }).join("");
    el.querySelectorAll(".dash-example").forEach(btn => btn.addEventListener("click", () => {
        const ex = EXAMPLES[+btn.dataset.i];
        useArea(ex.bbox, ex.productId);
    }));
}

// ── Recent searches ──────────────────────────────────────────────

function renderRecent() {
    const el = document.getElementById("dash-recent");
    if (!runs.length) {
        el.innerHTML = `<li class="dash-empty">No searches yet. Your recent searches will appear here.</li>`;
        return;
    }
    const recent = runs.slice(0, RECENT_LIMIT);
    el.innerHTML = recent.map((r, i) => `
        <li class="dash-run">
            <span class="dash-run-badge ${MISSION_CLASS[r.mission] || ""}" title="${escapeHtml(r.mission)}">${escapeHtml(r.product.replace(/-/g, "/"))}</span>
            <span class="dash-run-text">
                <span class="dash-run-title">${fmtWhen(r.fetched_at)} · ${fmtArea(r.bbox)}</span>
                <span class="dash-run-sub">${fmtBbox(r.bbox)}</span>
            </span>
            <span class="dash-run-actions">
                <button type="button" class="link-btn" data-act="use" data-i="${i}">Use area</button>
                <button type="button" class="link-btn" data-act="report" data-i="${i}">Report</button>
            </span>
        </li>`).join("");
    el.querySelectorAll("[data-act]").forEach(btn => btn.addEventListener("click", () => {
        const run = recent[+btn.dataset.i];
        if (btn.dataset.act === "use") useArea(run.bbox, productIdForRun(run));
        else previewCsv(run.csv_path);
    }));
}

// ── Product catalogue ────────────────────────────────────────────

function renderProducts() {
    const el = document.getElementById("dash-products");
    const groups = {};
    Object.entries(catalog).forEach(([id, p]) => (groups[p.mission] ||= []).push([id, p]));
    el.innerHTML = Object.entries(groups).map(([mission, items]) => `
        <div class="dash-mission">
            <span class="dash-mission-name"><i class="dash-dot ${MISSION_CLASS[mission] || ""}"></i>${escapeHtml(mission)}</span>
            <span class="dash-chips">
                ${items.map(([id, p]) => `<button type="button" class="dash-chip" data-id="${id}" title="${escapeHtml(p.label)}">${escapeHtml(shortLabel(p.label))}</button>`).join("")}
            </span>
        </div>`).join("");
    el.querySelectorAll(".dash-chip").forEach(chip =>
        chip.addEventListener("click", () => pickProduct(chip.dataset.id)));
}

})();
