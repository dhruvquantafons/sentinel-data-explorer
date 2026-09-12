/* ================================================================
   TerraVerify — Carbon footprint mode

   Uses app.js globals: map, drawnItems, currentBbox, escapeHtml,
   scrubSentinel, showToast, bboxAreaKm2, bboxBounds, setButtonLoading.
   ================================================================ */

(() => {

// Marker colours for the top three facility categories. A map compares
// every colour against every other, which caps it at three distinguishable
// hues; the rest share "Other" grey. Validated all-pairs (CVD ΔE ≥ 9.2).
const MARKER_COLORS = ["#2a78d6", "#eb6834", "#1baf7a"];
const OTHER_COLOR = "#898781";
const ACCENT = "#2563eb";
const PARTIAL_COLOR = "#c3c2b7";     // current, incomplete year
const LIST_COLLAPSED = 10;

let mode = "scenes";
let target = null;          // {type: "district", id, name, state} | {type: "bbox", bbox}
let report = null;
let reportSeq = 0;
let airSeq = 0;
let airTimer = null;
let carbonLayer = null;
let facilityMarkers = [];
let categoryColors = {};

document.addEventListener("DOMContentLoaded", () => {
    carbonLayer = L.layerGroup();
    initModeSwitch();
    initDistrictSearch();
    initMapHooks();
    document.getElementById("carbon-btn").addEventListener("click", () => generateReport());
    // Content moving under a resting cursor would otherwise leave a stale tooltip
    document.getElementById("carbon-panel").addEventListener("scroll", hideTip, { passive: true });
    window.addEventListener("scroll", hideTip, { passive: true });
});

// ── Mode switch ──────────────────────────────────────────────────

function initModeSwitch() {
    document.querySelectorAll(".mode-btn").forEach(btn =>
        btn.addEventListener("click", () => setMode(btn.dataset.mode)));
}

function setMode(next) {
    mode = next;
    const carbon = next === "carbon";
    document.querySelectorAll(".mode-btn").forEach(btn => {
        const active = btn.dataset.mode === next;
        btn.classList.toggle("active", active);
        btn.setAttribute("aria-selected", active);
    });
    document.getElementById("scenes-panel").classList.toggle("hidden", carbon);
    document.getElementById("scenes-footer").classList.toggle("hidden", carbon);
    document.getElementById("carbon-panel").classList.toggle("hidden", !carbon);
    document.getElementById("app").classList.toggle("carbon-mode", carbon);

    if (carbon) {
        carbonLayer.addTo(map);
        // Reuse a rectangle already drawn in scenes mode
        if (!target && currentBbox) setTarget({ type: "bbox", bbox: currentBbox });
    } else {
        map.removeLayer(carbonLayer);
        hideTip();
    }
}

// ── Choosing a place ─────────────────────────────────────────────

function setTarget(next) {
    target = next;
    renderPlace();
    document.getElementById("carbon-btn").disabled = !target;
    document.getElementById("carbon-hint").classList.toggle("hidden", !!target);
    document.querySelector('[data-step="place"]').classList.toggle("done", !!target);
}

function renderPlace() {
    const el = document.getElementById("carbon-place");
    if (!target) {
        el.classList.add("hidden");
        el.innerHTML = "";
        return;
    }
    let title, sub;
    if (target.type === "district") {
        title = target.name;
        sub = target.state || "District";
    } else {
        const km2 = bboxAreaKm2(target.bbox);
        title = "Your drawn area";
        sub = `≈ ${km2 >= 1000 ? Math.round(km2).toLocaleString() : km2.toFixed(1)} km² · report covers the district(s) under it`;
    }
    el.classList.remove("hidden");
    el.innerHTML = `
        <div class="place-icon" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
        </div>
        <div class="place-text">
            <div class="place-title">${escapeHtml(title)}</div>
            <div class="place-sub">${escapeHtml(sub)}</div>
        </div>
        <button type="button" class="icon-btn" id="carbon-place-clear" aria-label="Clear place" title="Clear">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>`;
    document.getElementById("carbon-place-clear").addEventListener("click", () => {
        document.getElementById("district-input").value = "";
        setTarget(null);
    });
}

function initMapHooks() {
    // app.js keeps currentBbox up to date; these run after its handlers
    map.on(L.Draw.Event.CREATED, () => {
        if (mode !== "carbon") return;
        document.getElementById("district-input").value = "";
        setTarget({ type: "bbox", bbox: currentBbox });
    });
    map.on(L.Draw.Event.EDITED, () => {
        if (mode === "carbon" && target?.type === "bbox" && currentBbox) {
            setTarget({ type: "bbox", bbox: currentBbox });
        }
    });
    map.on(L.Draw.Event.DELETED, () => {
        if (target?.type === "bbox") setTarget(null);
    });
}

// ── District search (combobox) ───────────────────────────────────

function initDistrictSearch() {
    const input = document.getElementById("district-input");
    const list = document.getElementById("district-suggestions");
    let timer = null;
    let seq = 0;
    let items = [];
    let active = -1;

    const close = () => {
        list.classList.add("hidden");
        input.setAttribute("aria-expanded", "false");
        active = -1;
    };

    const choose = (d) => {
        input.value = d.name;
        close();
        setTarget({ type: "district", id: d.id, name: d.name, state: d.state });
    };

    const render = (message) => {
        list.innerHTML = message
            ? `<li class="suggestion-empty">${message}</li>`
            : items.map((d, i) => `
                <li role="option" id="district-opt-${i}" data-i="${i}" class="suggestion${i === active ? " active" : ""}" aria-selected="${i === active}">
                    <span class="suggestion-name">${escapeHtml(d.name)}</span>
                    <span class="suggestion-state">${escapeHtml(d.state)}</span>
                </li>`).join("");
        list.classList.remove("hidden");
        input.setAttribute("aria-expanded", "true");
        if (active >= 0) input.setAttribute("aria-activedescendant", `district-opt-${active}`);
    };

    input.addEventListener("input", () => {
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { close(); return; }
        timer = setTimeout(async () => {
            const mine = ++seq;
            render('<span class="btn-spinner dark"></span> Searching…');
            try {
                const res = await fetch(`/api/carbon/districts?name=${encodeURIComponent(q)}`);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const found = await res.json();
                if (mine !== seq) return;
                items = found;
                active = found.length ? 0 : -1;
                render(found.length ? "" :
                    "No districts found. Names follow official spellings — try e.g. <b>Ahmadabad</b> for Ahmedabad.");
            } catch (err) {
                if (mine === seq) render("Couldn't search districts right now.");
            }
        }, 250);
    });

    input.addEventListener("keydown", (e) => {
        if (list.classList.contains("hidden") || !items.length) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            active = (active + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            render("");
        } else if (e.key === "Enter" && active >= 0) {
            e.preventDefault();
            choose(items[active]);
        } else if (e.key === "Escape") {
            close();
        }
    });

    list.addEventListener("mousedown", (e) => {
        const li = e.target.closest("[data-i]");
        if (li) { e.preventDefault(); choose(items[+li.dataset.i]); }
    });
    input.addEventListener("blur", () => setTimeout(close, 120));
}

// ── Report ───────────────────────────────────────────────────────

async function generateReport(year = null) {
    if (!target) return;
    const mine = ++reportSeq;
    const btn = document.getElementById("carbon-btn");
    const results = document.getElementById("carbon-results");
    const loading = document.getElementById("carbon-loading");
    const yearOnly = year !== null && report;

    setButtonLoading(btn, true, "Generating report…");
    if (yearOnly) {
        results.classList.add("refreshing");       // keep the old render, dimmed
    } else {
        results.classList.add("hidden");
        loading.classList.remove("hidden");
    }

    const body = target.type === "district" ? { district_id: target.id } : { bbox: target.bbox };
    if (year) body.year = year;

    try {
        const res = await fetch("/api/carbon-report", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
        if (mine !== reportSeq) return;

        const previousAir = yearOnly ? document.getElementById("air-card")?.outerHTML : null;
        report = data;
        renderReport(data, body);
        drawCarbonLayers(data, !yearOnly);
        if (previousAir) {
            document.getElementById("air-card").outerHTML = previousAir;   // air data isn't per-year
            wireTooltips(document.getElementById("air-card"));
        } else {
            loadAirIndicators(data, body);
        }
    } catch (err) {
        if (mine !== reportSeq) return;
        results.classList.remove("hidden");
        results.innerHTML = `<div class="error-msg" role="alert">${ICON_ALERT}<span>${escapeHtml(scrubSentinel(err.message))}</span></div>`;
        showToast("Couldn't generate the carbon report", err.message, "error");
    } finally {
        if (mine === reportSeq) {
            setButtonLoading(btn, false, "Generate carbon report");
            btn.disabled = !target;
            loading.classList.add("hidden");
            results.classList.remove("refreshing");
        }
    }
}

const ICON_ALERT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
const ICON_DOWNLOAD = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';

/** 8,141,516 → "8.14M t"; 664,433 → "664K t". */
function compactTonnes(t) {
    if (t >= 1e6) return `${(t / 1e6).toFixed(t >= 1e7 ? 1 : 2)}M t`;
    if (t >= 1e3) return `${Math.round(t / 1e3).toLocaleString()}K t`;
    return `${Math.round(t).toLocaleString()} t`;
}

/** Axis ticks: round numbers without padding zeros — 5M, 2.5M, 500K. */
function tickLabel(v) {
    const trim = n => String(+n.toFixed(1));
    if (v >= 1e6) return `${trim(v / 1e6)}M`;
    if (v >= 1e3) return `${trim(v / 1e3)}K`;
    return String(Math.round(v));
}

function heroTonnes(t) {
    if (t >= 1e6) return [(t / 1e6).toFixed(2), "million tonnes CO₂e"];
    if (t >= 1e3) return [Math.round(t / 1e3).toLocaleString(), "thousand tonnes CO₂e"];
    return [Math.round(t).toLocaleString(), "tonnes CO₂e"];
}

function renderReport(data) {
    const results = document.getElementById("carbon-results");
    const d = data.district;
    const [value, unit] = heroTonnes(data.tonnes);
    const fullYears = data.years.filter(y => !y.partial).map(y => y.year);

    // Change vs previous year: for emissions, down is good
    let delta = "";
    if (data.change_pct != null) {
        const c = data.change_pct;
        if (Math.abs(c) < 0.1) {
            delta = `<span class="delta flat">● No change vs ${data.year - 1}</span>`;
        } else {
            const down = c < 0;
            delta = `<span class="delta ${down ? "good" : "bad"}">${down ? "▼" : "▲"} ${Math.abs(c).toFixed(1)}% vs ${data.year - 1}</span>`;
        }
    }

    const coverage = data.area_districts?.length
        ? `<div class="ch-coverage">Your area covers ${data.area_districts.map(a =>
            a.id === d.id
                ? `<b>${escapeHtml(a.name)}</b> ${a.overlap_pct}%`
                : `<button type="button" class="link-btn" data-district="${escAttr(a.id)}">${escapeHtml(a.name)}</button> ${a.overlap_pct}%`
          ).join(" · ")}</div>`
        : "";

    results.innerHTML = `
        <div class="carbon-headline">
            <div class="ch-place">${escapeHtml(d.name)}<span>${escapeHtml(d.state)}</span></div>
            <div class="ch-hero"><span class="ch-value">${value}</span><span class="ch-unit">${unit}</span></div>
            <div class="ch-meta">
                <label class="ch-year">
                    <span class="sr-only">Year</span>
                    <select id="carbon-year" class="compare-scene-select">
                        ${fullYears.map(y => `<option value="${y}" ${y === data.year ? "selected" : ""}>${y}</option>`).join("")}
                    </select>
                </label>
                ${delta}
            </div>
            ${coverage}
        </div>

        <p class="carbon-summary">${escapeHtml(data.summary)}</p>

        <section class="carbon-card">
            <h3 class="carbon-card-title">By sector <span>${data.year}</span></h3>
            ${sectorBars(data)}
        </section>

        <section class="carbon-card">
            <h3 class="carbon-card-title">Total emissions by year</h3>
            ${trendChart(data)}
        </section>

        <section class="carbon-card">
            <h3 class="carbon-card-title">Facilities ${data.area_districts?.length ? "in your area" : "in the district"} <span>${data.facilities.year}</span></h3>
            ${facilitiesSection(data.facilities)}
        </section>

        <section class="carbon-card" id="air-card"></section>

        <div class="carbon-downloads">
            <a class="download-btn" href="/api/download/${encodeURI(data.csv_path)}" download>${ICON_DOWNLOAD}<span>Emissions CSV</span></a>
            <a class="download-btn" href="/api/download/${encodeURI(data.facilities_csv_path)}" download>${ICON_DOWNLOAD}<span>Facilities CSV</span></a>
        </div>

        <p class="carbon-source">
            Emissions: Climate TRACE (climatetrace.org). Air quality: Copernicus satellite data.
            Estimates for screening, not a certified footprint. Carbon taken up by forests,
            grassland and wetlands is not included.
        </p>`;
    results.classList.remove("hidden");

    document.getElementById("carbon-year").addEventListener("change", (e) => generateReport(+e.target.value));
    results.querySelectorAll("[data-district]").forEach(btn =>
        btn.addEventListener("click", () => switchToDistrict(btn.dataset.district)));
    wireTooltips(results);
    wireFacilityList(results, data.facilities);
}

/** Jump from "your area covers … Gandhinagar 4%" to that district's own report. */
function switchToDistrict(id) {
    const a = report.area_districts.find(x => x.id === id);
    if (!a) return;
    document.getElementById("district-input").value = a.name;
    setTarget({ type: "district", id: a.id, name: a.name, state: a.state });
    generateReport();
}

// ── Sector bars (one series → one colour) ────────────────────────

function sectorBars(data) {
    const max = Math.max(...data.categories.map(c => c.tonnes), 1);
    return `<div class="sector-bars">${data.categories.map(c => {
        const tip = `<b>${escapeHtml(c.name)}</b><br>${compactTonnes(c.tonnes)} · ${c.share_pct}% of total` +
            `<br><span class="tip-muted">Largest: ${escapeHtml(c.sectors[0].label)}</span>`;
        return `
            <details class="sector-row">
                <summary data-tip="${escAttr(tip)}">
                    <span class="sector-name">${escapeHtml(c.name)}</span>
                    <span class="sector-value">${compactTonnes(c.tonnes)} <span class="sector-share">${c.share_pct.toFixed(0)}%</span></span>
                    <span class="sector-track"><span class="sector-bar" style="width:${Math.max(1.5, 100 * c.tonnes / max)}%"></span></span>
                </summary>
                <ul class="sector-detail">
                    ${c.sectors.map(s => `<li><span>${escapeHtml(s.label)}</span><span>${compactTonnes(s.tonnes)}</span></li>`).join("")}
                </ul>
            </details>`;
    }).join("")}</div>
    <p class="card-hint">Tap a sector to see what's in it.</p>`;
}

// ── Yearly trend (columns; partial year muted) ───────────────────

function niceMax(v) {
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / exp;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * exp;
}

function trendChart(data) {
    const years = data.years;
    const W = 320, H = 150, padL = 36, padR = 8, padT = 18, padB = 22;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const top = niceMax(Math.max(...years.map(y => y.tonnes)) * 1.08);
    const band = plotW / years.length;
    const colW = Math.min(24, band * 0.55);
    const y = v => padT + plotH - (v / top) * plotH;

    const ticks = [0, top / 2, top].map(v => `
        <line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
        <text x="${padL - 6}" y="${y(v) + 3.5}" class="tick" text-anchor="end">${tickLabel(v)}</text>`).join("");

    const cols = years.map((yr, i) => {
        const x = padL + band * i + (band - colW) / 2;
        const h = Math.max(1, (yr.tonnes / top) * plotH);
        const yTop = padT + plotH - h;
        const r = Math.min(4, h);
        // Rounded data-end, square at the baseline
        const path = `M${x},${padT + plotH} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + colW - r} Q${x + colW},${yTop} ${x + colW},${yTop + r} V${padT + plotH} Z`;
        const tip = `<b>${yr.year}${yr.partial ? " (so far)" : ""}</b><br>${compactTonnes(yr.tonnes)}` +
            (yr.partial ? '<br><span class="tip-muted">Part of the year only</span>' : "");
        const label = (yr.year === data.year || yr.partial)
            ? `<text x="${x + colW / 2}" y="${yTop - 5}" class="col-label" text-anchor="middle">${compactTonnes(yr.tonnes).replace(" t", "")}${yr.partial ? " so far" : ""}</text>`
            : "";
        return `
            <g class="col${yr.partial ? " partial" : ""}${yr.year === data.year ? " current" : ""}" tabindex="0" data-tip="${escAttr(tip)}">
                <rect x="${padL + band * i}" y="${padT}" width="${band}" height="${plotH}" class="hit"/>
                <path d="${path}" fill="${yr.partial ? PARTIAL_COLOR : ACCENT}"/>
                ${label}
                <text x="${x + colW / 2}" y="${H - 6}" class="tick" text-anchor="middle">${yr.year}</text>
            </g>`;
    }).join("");

    const table = `
        <details class="table-view">
            <summary>Show as table</summary>
            <table><thead><tr><th>Year</th><th>tCO₂e</th></tr></thead><tbody>
                ${years.map(yr => `<tr><td>${yr.year}${yr.partial ? " (so far)" : ""}</td><td>${yr.tonnes.toLocaleString()}</td></tr>`).join("")}
            </tbody></table>
        </details>`;

    return `
        <svg class="trend-chart" viewBox="0 0 ${W} ${H}" role="img"
             aria-label="Total emissions by year, ${years[0].year} to ${years[years.length - 1].year}">
            ${ticks}
            <line x1="${padL}" x2="${W - padR}" y1="${padT + plotH}" y2="${padT + plotH}" class="baseline"/>
            ${cols}
        </svg>
        ${years.some(y => y.partial) ? '<p class="card-hint"><span class="key-swatch" style="background:' + PARTIAL_COLOR + '"></span>Grey = current year, only part of it so far</p>' : ""}
        ${table}`;
}

// ── Facilities ───────────────────────────────────────────────────

function assignCategoryColors(fac) {
    categoryColors = {};
    fac.by_category.slice(0, MARKER_COLORS.length).forEach((c, i) => {
        categoryColors[c.name] = MARKER_COLORS[i];
    });
}

const colorFor = (category) => categoryColors[category] || OTHER_COLOR;

/** Escape for use inside a double-quoted HTML attribute (escapeHtml leaves quotes). */
function escAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function facilitiesSection(fac) {
    if (!fac.count) return `<p class="carbon-muted">${escapeHtml(fac.summary)}</p>`;
    assignCategoryColors(fac);

    const legendItems = fac.by_category.slice(0, MARKER_COLORS.length).map(c =>
        `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(c.name)}"></span>${escapeHtml(c.name)} (${c.count})</span>`);
    const others = fac.by_category.slice(MARKER_COLORS.length);
    if (others.length) {
        const n = others.reduce((s, c) => s + c.count, 0);
        legendItems.push(`<span class="legend-item"><span class="legend-dot" style="background:${OTHER_COLOR}"></span>Other (${n})</span>`);
    }

    const rows = fac.items.map((f, i) => `
        <li class="facility-row${i >= LIST_COLLAPSED ? " extra hidden" : ""}" data-i="${i}" tabindex="0" role="button"
            aria-label="Show ${escAttr(f.name)} on the map">
            <span class="legend-dot" style="background:${colorFor(f.category)}"></span>
            <span class="facility-main">
                <span class="facility-name" title="${escAttr(f.name)}">${escapeHtml(f.name)}</span>
                <span class="facility-sub">${escapeHtml(f.sectors[0])}${f.owners.length ? " · " + escapeHtml(f.owners[0]) : ""}</span>
            </span>
            <span class="facility-value">${compactTonnes(f.tonnes)}${f.share_pct != null && f.share_pct >= 0.5 ? `<span>${f.share_pct.toFixed(0)}%</span>` : ""}</span>
        </li>`).join("");

    const more = fac.items.length > LIST_COLLAPSED
        ? `<button type="button" class="link-btn facility-more" id="facility-more">Show all ${fac.items.length}</button>` : "";
    const hidden = fac.hidden_count
        ? `<p class="card-hint">+ ${fac.hidden_count} smaller facilities (${compactTonnes(fac.hidden_tonnes)}) — see the facilities CSV.</p>` : "";

    return `
        <p class="carbon-muted">${escapeHtml(fac.summary)}</p>
        <div class="facility-legend">${legendItems.join("")}</div>
        <ol class="facility-list">${rows}</ol>
        ${more}${hidden}
        <p class="card-hint">Circle size on the map shows emissions. Click a facility to find it.</p>`;
}

function wireFacilityList(root, fac) {
    const more = root.querySelector("#facility-more");
    if (more) {
        more.addEventListener("click", () => {
            const expanded = more.dataset.expanded === "1";
            root.querySelectorAll(".facility-row.extra").forEach(r => r.classList.toggle("hidden", expanded));
            more.dataset.expanded = expanded ? "0" : "1";
            more.textContent = expanded ? `Show all ${fac.items.length}` : "Show fewer";
        });
    }
    root.querySelectorAll(".facility-row").forEach(row => {
        const go = () => {
            const m = facilityMarkers[+row.dataset.i];
            if (!m) return;
            map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 12), { duration: 0.6 });
            m.openPopup();
        };
        row.addEventListener("click", go);
        row.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
    });
}

// ── Map layers ───────────────────────────────────────────────────

function drawCarbonLayers(data, fit) {
    carbonLayer.clearLayers();
    facilityMarkers = [];

    const outline = L.geoJSON(data.boundary, {
        style: { color: ACCENT, weight: 2, fillColor: ACCENT, fillOpacity: 0.04 },
        interactive: false,
    }).addTo(carbonLayer);

    const items = data.facilities.items;
    const maxT = Math.max(...items.map(f => f.tonnes), 1);
    // Largest first, so smaller circles sit on top and stay clickable
    const order = items.map((f, i) => i).sort((a, b) => items[b].tonnes - items[a].tonnes);
    order.forEach(i => {
        const f = items[i];
        const marker = L.circleMarker([f.lat, f.lon], {
            radius: 4 + 14 * Math.sqrt(f.tonnes / maxT),       // ≥ 8px, area ∝ emissions
            color: "#fff", weight: 2,                           // surface ring
            fillColor: colorFor(f.category), fillOpacity: 0.85,
        }).bindPopup(`
            <div class="facility-popup">
                <div class="fp-name">${escapeHtml(f.name)}</div>
                <div class="fp-sub">${escapeHtml(f.sectors.join(", "))}</div>
                <div class="fp-value">${compactTonnes(f.tonnes)} CO₂e in ${data.facilities.year}${f.share_pct != null ? ` · ${f.share_pct}% of the district` : ""}</div>
                ${f.owners.length ? `<div class="fp-row">Owner: ${escapeHtml(f.owners.join(", "))}</div>` : ""}
                ${f.confidence ? `<div class="fp-row">Data confidence: ${escapeHtml(f.confidence)}</div>` : ""}
                <div class="fp-row fp-muted">${escapeHtml(f.district)}</div>
            </div>`);
        marker.addTo(carbonLayer);
        facilityMarkers[i] = marker;
    });

    if (fit) {
        const bounds = target?.type === "bbox"
            ? L.latLngBounds(bboxBounds(target.bbox))
            : outline.getBounds();
        map.fitBounds(bounds, { padding: [40, 40] });
    }
}

// ── Air indicators (loads after the report) ──────────────────────

async function loadAirIndicators(data, reportBody) {
    const mine = ++airSeq;
    const card = () => document.getElementById("air-card");
    const body = reportBody.bbox
        ? { bbox: reportBody.bbox, district_id: data.district.id }     // compare with the district
        : { district_id: data.district.id };

    const started = Date.now();
    const renderWaiting = () => {
        const el = card();
        if (!el || mine !== airSeq) return;
        const s = Math.round((Date.now() - started) / 1000);
        el.innerHTML = `
            <h3 class="carbon-card-title">Air quality <span>last 12 months</span></h3>
            <div class="air-loading">
                <span class="btn-spinner dark" aria-hidden="true"></span>
                <span>Measuring NO₂, methane and CO from satellite data… <b>${s}s</b><br>
                <span class="tip-muted">Usually 10–40 seconds; faster next time.</span></span>
            </div>`;
    };
    clearInterval(airTimer);
    renderWaiting();
    airTimer = setInterval(renderWaiting, 1000);

    try {
        const res = await fetch("/api/carbon-indicators", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        const air = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(air.detail || `HTTP ${res.status}`);
        if (mine !== airSeq) return;
        clearInterval(airTimer);
        renderAir(air);
    } catch (err) {
        if (mine !== airSeq) return;
        clearInterval(airTimer);
        const el = card();
        if (!el) return;
        el.innerHTML = `
            <h3 class="carbon-card-title">Air quality</h3>
            <p class="carbon-muted">Couldn't load air quality: ${escapeHtml(scrubSentinel(err.message))}</p>
            <button type="button" class="link-btn" id="air-retry">Try again</button>`;
        el.querySelector("#air-retry").addEventListener("click", () => loadAirIndicators(data, reportBody));
    }
}

function fmtMonth(ym) {
    const [y, m] = ym.split("-").map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

function fmtValue(v, unit, digits) {
    return `${v.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits })} ${unit}`.trim();
}

const GAS_DIGITS = { NO2: 1, CH4: 0, CO: 1 };

function renderAir(air) {
    const el = document.getElementById("air-card");
    if (!el) return;
    const p = air.period;
    const lastFrom = p.last.from.slice(0, 7), lastTo = p.last.to.slice(0, 7);

    const tiles = air.gases.map(g => {
        const digits = GAS_DIGITS[g.gas] ?? 1;
        if (g.value == null || !g.level) {
            return `<div class="air-tile"><div class="air-label">${escapeHtml(g.name)}</div>
                <p class="carbon-muted">${escapeHtml(g.summary)}</p></div>`;
        }
        // For pollutants, lower is better
        let delta = `<span class="delta flat">● About the same</span>`;
        if (g.trend === "down") delta = `<span class="delta good">▼ ${Math.abs(g.change_pct).toFixed(0)}% vs previous 12 months</span>`;
        if (g.trend === "up") delta = `<span class="delta bad">▲ ${Math.abs(g.change_pct).toFixed(0)}% vs previous 12 months</span>`;

        let compare = "";
        if (g.comparison) {
            const r = g.district_ratio;
            const tag = r >= 1.5 ? `<span class="hotspot-tag">Hotspot · ${r.toFixed(1)}×</span>` : "";
            compare = `<p class="air-compare">${tag}${escapeHtml(g.comparison)}</p>`;
        }

        return `
            <div class="air-tile">
                <div class="air-label">${escapeHtml(g.name)}</div>
                <div class="air-row">
                    <div>
                        <div class="air-value">${fmtValue(g.value, g.unit, digits)}</div>
                        <div class="air-level">${escapeHtml(g.level)} ${delta}</div>
                    </div>
                    ${sparkline(g, digits, p.last.from.slice(0, 7))}
                </div>
                ${compare}
                ${g.coverage_pct < 50 ? `<p class="card-hint">Valid readings on ${g.coverage_pct.toFixed(0)}% of sampled days (clouds).</p>` : ""}
            </div>`;
    }).join("");

    el.innerHTML = `
        <h3 class="carbon-card-title">Air quality <span>${fmtMonth(lastFrom)} – ${fmtMonth(lastTo)}</span></h3>
        <div class="air-tiles">${tiles}</div>
        <p class="card-hint"><span class="key-swatch" style="background:${PARTIAL_COLOR}"></span>previous 12 months
            <span class="key-swatch" style="background:${ACCENT}; margin-left:10px"></span>last 12 months</p>
        ${air.notes.map(n => `<p class="card-hint">${escapeHtml(scrubSentinel(n))}</p>`).join("")}`;
    wireTooltips(el);
}

/** 24-month sparkline: previous 12 months grey, last 12 in the accent. */
function sparkline(g, digits, lastFromMonth) {
    const pts = g.monthly;
    if (pts.length < 2) return "";
    const W = 116, H = 40, pad = 5;
    const vals = pts.map(p => p.value);
    const lo = Math.min(...vals), hi = Math.max(...vals);
    const span = hi - lo || 1;
    const x = i => pad + (i / (pts.length - 1)) * (W - 2 * pad);
    const y = v => pad + (1 - (v - lo) / span) * (H - 2 * pad);
    const split = pts.findIndex(p => p.month >= lastFromMonth);
    const cut = split > 0 ? split : Math.max(0, pts.length - 12);
    const line = arr => arr.map(([i, p]) => `${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
    const indexed = pts.map((p, i) => [i, p]);
    const prev = indexed.slice(0, cut + 1), last = indexed.slice(cut);
    const lastPt = indexed[indexed.length - 1];
    const hits = indexed.map(([i, p]) => {
        const w = (W - 2 * pad) / (pts.length - 1);
        return `<rect x="${(x(i) - w / 2).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" class="hit"
                  data-tip="${escAttr(`<b>${fmtMonth(p.month)}</b><br>${fmtValue(p.value, g.unit, digits)}`)}"/>`;
    }).join("");
    return `
        <svg class="sparkline" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"
             aria-label="${escAttr(g.name)} monthly averages over 24 months">
            <polyline points="${line(prev)}" fill="none" stroke="${PARTIAL_COLOR}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            <polyline points="${line(last)}" fill="none" stroke="${ACCENT}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
            <circle cx="${x(lastPt[0])}" cy="${y(lastPt[1].value)}" r="4" fill="${ACCENT}" stroke="#fff" stroke-width="2"/>
            ${hits}
        </svg>`;
}

// ── Shared tooltip ───────────────────────────────────────────────

function showTip(html, clientX, clientY) {
    const tip = document.getElementById("viz-tooltip");
    tip.innerHTML = html;
    tip.classList.remove("hidden");
    const r = tip.getBoundingClientRect();
    let left = clientX + 12, top = clientY + 12;
    if (left + r.width > window.innerWidth - 8) left = clientX - r.width - 12;
    if (top + r.height > window.innerHeight - 8) top = clientY - r.height - 12;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
}

function hideTip() {
    document.getElementById("viz-tooltip")?.classList.add("hidden");
}

function wireTooltips(root) {
    root.querySelectorAll("[data-tip]").forEach(el => {
        const html = el.getAttribute("data-tip");
        el.addEventListener("mouseenter", e => showTip(html, e.clientX, e.clientY));
        el.addEventListener("mousemove", e => showTip(html, e.clientX, e.clientY));
        el.addEventListener("mouseleave", hideTip);
        // Keyboard focus shows the same as hover
        el.addEventListener("focus", () => {
            const b = el.getBoundingClientRect();
            showTip(html, b.left + b.width / 2, b.top);
        });
        el.addEventListener("blur", hideTip);
    });
}

})();
