/* TerraVerify landing page: hero swipe preview + mobile menu */

(function () {
    // Google Fonts swap in asynchronously and reflow the hero's large
    // heading; if the page loaded on a link like "#products", that reflow
    // can shift everything below it after the browser already jumped to
    // the target, leaving the section scrolled a few hundred pixels off.
    // Re-settle once fonts are in — or after a short fallback delay, so a
    // slow or blocked font request can't leave the page stuck mid-scroll.
    if (location.hash) {
        const settle = () => {
            const target = document.querySelector(location.hash);
            // Explicit "auto": html{scroll-behavior:smooth} would otherwise
            // animate this, which is jarring on a page's very first paint.
            if (target) target.scrollIntoView({ block: "start", behavior: "auto" });
        };
        const fontsReady = (document.fonts && document.fonts.ready) || Promise.resolve();
        Promise.race([fontsReady, new Promise((r) => setTimeout(r, 400))]).then(settle);
    }

    const SVG_NS = "http://www.w3.org/2000/svg";

    // Land cover → [true colour, NDVI colour (app's "vegetation" colormap)]
    const COVER = {
        dense:  ["#3f6b35", "#1a9850"],
        crop:   ["#6f8f45", "#a6d96a"],
        sparse: ["#a4a066", "#fee08b"],
        bare:   ["#c2a77c", "#fdae61"],
        urban:  ["#a3a3a0", "#f46d43"],
        water:  ["#2f5870", "#a50026"],
    };

    // Field patchwork: 5 columns × 4 rows, sheared so it doesn't read as a grid
    const COLS = [0, 118, 232, 348, 458, 560];
    const ROWS = [0, 96, 188, 286, 380];
    const SHEAR = 14;
    const FIELDS = [
        ["dense",  "crop",   "crop",   "sparse", "bare"],
        ["crop",   "dense",  "urban",  "crop",   "sparse"],
        ["sparse", "crop",   "urban",  "dense",  "crop"],
        ["bare",   "sparse", "crop",   "crop",   "dense"],
    ];
    const RIVER = "M-20 62 C 80 104, 150 30, 240 116 S 380 262, 462 226 S 548 292, 590 330";

    function el(name, attrs, parent) {
        const node = document.createElementNS(SVG_NS, name);
        for (const k in attrs) node.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(node);
        return node;
    }

    function drawScene(svg, idx, id) {
        const defs = el("defs", {}, svg);
        const blur = el("filter", { id: `${id}-blur`, x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
        el("feGaussianBlur", { stdDeviation: "14" }, blur);
        const hatch = el("pattern", { id: `${id}-hatch`, width: "8", height: "8", patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, defs);
        el("rect", { width: "8", height: "8", fill: "rgba(15,23,42,.55)" }, hatch);
        el("line", { x1: "0", y1: "0", x2: "0", y2: "8", stroke: "rgba(255,255,255,.35)", "stroke-width": "3" }, hatch);

        // Fields, extended past the edges so the shear never shows a gap
        for (let r = 0; r < FIELDS.length; r++) {
            for (let c = 0; c < FIELDS[r].length; c++) {
                const x0 = COLS[c] - (c === 0 ? 40 : 0), x1 = COLS[c + 1] + (c === 4 ? 40 : 0);
                const y0 = ROWS[r], y1 = ROWS[r + 1];
                const s0 = SHEAR * r - 20, s1 = SHEAR * (r + 1) - 20;
                el("polygon", {
                    points: `${x0 + s0},${y0} ${x1 + s0},${y0} ${x1 + s1},${y1} ${x0 + s1},${y1}`,
                    fill: COVER[FIELDS[r][c]][idx],
                    stroke: "rgba(0,0,0,.14)", "stroke-width": "1.5",
                }, svg);
                // Crop rows on cultivated fields
                if (FIELDS[r][c] === "crop" && idx === 0) {
                    for (let y = y0 + 12; y < y1; y += 12) {
                        const t = (y - y0) / (y1 - y0), s = s0 + (s1 - s0) * t;
                        el("line", { x1: x0 + s + 6, y1: y, x2: x1 + s - 6, y2: y, stroke: "rgba(255,255,255,.08)", "stroke-width": "2" }, svg);
                    }
                }
            }
        }

        // Town blocks on the urban fields
        const blocks = [[250, 110, 26, 18], [282, 104, 20, 24], [258, 134, 34, 16], [300, 132, 22, 20],
                        [266, 206, 24, 22], [296, 200, 30, 16], [272, 234, 36, 18], [314, 222, 20, 24],
                        [262, 158, 18, 16], [330, 160, 16, 18]];
        const blockFill = idx === 0 ? ["#c9c9c4", "#8c8c88"] : ["#d73027", "#f46d43"];
        blocks.forEach(([x, y, w, h], i) =>
            el("rect", { x, y, width: w, height: h, rx: 1.5, fill: blockFill[i % 2] }, svg));

        // Roads (true colour only — they vanish in the index, as in real NDVI)
        if (idx === 0) {
            el("path", { d: "M-10 176 L 580 208", stroke: "#d9d4c7", "stroke-width": "4", fill: "none", opacity: ".8" }, svg);
            el("path", { d: "M292 -10 L 318 390", stroke: "#d9d4c7", "stroke-width": "3", fill: "none", opacity: ".7" }, svg);
        }

        // River with a soft bank
        el("path", { d: RIVER, stroke: idx === 0 ? "#6b7f5a" : "#d73027", "stroke-width": "26", fill: "none", "stroke-linecap": "round", opacity: ".55" }, svg);
        el("path", { d: RIVER, stroke: COVER.water[idx], "stroke-width": "15", fill: "none", "stroke-linecap": "round" }, svg);

        // A cloud: white on the photo, masked (hatched) in NDVI — the app
        // excludes cloudy pixels rather than reading them as "no vegetation"
        if (idx === 0) {
            el("ellipse", { cx: "470", cy: "72", rx: "70", ry: "38", fill: "rgba(255,255,255,.92)", filter: `url(#${id}-blur)` }, svg);
            el("ellipse", { cx: "420", cy: "92", rx: "40", ry: "24", fill: "rgba(255,255,255,.85)", filter: `url(#${id}-blur)` }, svg);
        } else {
            el("ellipse", { cx: "462", cy: "78", rx: "82", ry: "40", fill: `url(#${id}-hatch)` }, svg);
        }
    }

    const scene = document.getElementById("scene");
    const slider = document.getElementById("scene-slider");
    if (scene && slider) {
        drawScene(document.getElementById("layer-tc"), 0, "tc");
        drawScene(document.getElementById("layer-ndvi"), 1, "ndvi");
        const update = () => scene.style.setProperty("--split", `${slider.value}%`);
        slider.addEventListener("input", update);
        update();
    }

    // Mobile menu
    const toggle = document.getElementById("nav-toggle");
    const links = document.getElementById("nav-links");
    if (toggle && links) {
        const closeMenu = () => {
            links.classList.remove("open");
            toggle.setAttribute("aria-expanded", "false");
        };
        toggle.addEventListener("click", () => {
            const open = links.classList.toggle("open");
            toggle.setAttribute("aria-expanded", String(open));
        });
        links.addEventListener("click", (e) => {
            if (e.target.closest("a")) closeMenu();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && links.classList.contains("open")) closeMenu();
        });
        document.addEventListener("click", (e) => {
            if (links.classList.contains("open") && !links.contains(e.target) && e.target !== toggle && !toggle.contains(e.target)) {
                closeMenu();
            }
        });
    }

    const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Sticky nav: elevate once the page has scrolled past the hero top
    const nav = document.querySelector(".nav");
    if (nav) {
        const setScrolled = () => nav.classList.toggle("scrolled", window.scrollY > 8);
        setScrolled();
        window.addEventListener("scroll", setScrolled, { passive: true });
    }

    // Scrollspy: highlight the nav link for the section in view
    const navAnchors = Array.from(document.querySelectorAll('.nav-links a[href^="#"]'));
    const spySections = navAnchors
        .map((a) => document.getElementById(a.getAttribute("href").slice(1)))
        .filter(Boolean);
    if (navAnchors.length && spySections.length && "IntersectionObserver" in window) {
        const byId = new Map(navAnchors.map((a) => [a.getAttribute("href").slice(1), a]));
        const spy = new IntersectionObserver(
            (entries) => {
                entries.forEach((entry) => {
                    const link = byId.get(entry.target.id);
                    if (!link) return;
                    link.classList.toggle("active", entry.isIntersecting);
                });
            },
            { rootMargin: "-40% 0px -55% 0px", threshold: 0 }
        );
        spySections.forEach((s) => spy.observe(s));
    }

    // Scroll-reveal for section headers and cards, gated behind JS support
    // so nothing is ever stuck invisible if this script fails to run.
    const revealEls = Array.from(document.querySelectorAll(".reveal"));
    if (revealEls.length && "IntersectionObserver" in window && !reduceMotion) {
        document.documentElement.classList.add("js-reveal");
        const revealer = new IntersectionObserver(
            (entries, obs) => {
                entries.forEach((entry) => {
                    if (!entry.isIntersecting) return;
                    entry.target.classList.add("in");
                    obs.unobserve(entry.target);
                });
            },
            { threshold: 0.14, rootMargin: "0px 0px -8% 0px" }
        );
        revealEls.forEach((el) => revealer.observe(el));
    }

    // Count up the hero stat numbers once they scroll into view
    const statNums = Array.from(document.querySelectorAll(".stats dt"));
    if (statNums.length && !reduceMotion) {
        const animate = (el) => {
            const target = parseInt(el.textContent, 10);
            if (!Number.isFinite(target)) return;
            const duration = 900;
            const start = performance.now();
            const ease = (t) => 1 - Math.pow(1 - t, 3);
            const step = (now) => {
                const t = Math.min(1, (now - start) / duration);
                el.textContent = String(Math.round(target * ease(t)));
                if (t < 1) requestAnimationFrame(step);
                else el.textContent = String(target);
            };
            requestAnimationFrame(step);
        };
        if ("IntersectionObserver" in window) {
            const counter = new IntersectionObserver(
                (entries, obs) => {
                    entries.forEach((entry) => {
                        if (!entry.isIntersecting) return;
                        animate(entry.target);
                        obs.unobserve(entry.target);
                    });
                },
                { threshold: 0.6 }
            );
            statNums.forEach((el) => counter.observe(el));
        }
    }
})();
