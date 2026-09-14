/* BluVerify landing page: header state, section nav, comparison tabs, mobile menu */

(function () {
    // Web fonts swap in asynchronously; if the page loaded on a link like
    // "#carbon", the reflow can leave the section scrolled out of place.
    // Re-settle once fonts are in, or after a short fallback delay.
    if (location.hash) {
        const settle = () => {
            const target = document.querySelector(location.hash);
            if (target) target.scrollIntoView({ block: "start", behavior: "auto" });
        };
        const fontsReady = (document.fonts && document.fonts.ready) || Promise.resolve();
        Promise.race([fontsReady, new Promise((r) => setTimeout(r, 400))]).then(settle);
    }

    // Header gets a soft shadow once the page scrolls
    const header = document.getElementById("site-header");
    if (header) {
        const onScroll = () => header.classList.toggle("scrolled", window.scrollY > 4);
        onScroll();
        window.addEventListener("scroll", onScroll, { passive: true });
    }

    // Underline the nav link of the section currently in view
    const navLinks = Array.from(document.querySelectorAll('.site-nav a[href^="#"]'));
    if (navLinks.length && "IntersectionObserver" in window) {
        const byId = new Map(navLinks.map((a) => [a.getAttribute("href").slice(1), a]));
        const spy = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                navLinks.forEach((a) => a.classList.remove("active"));
                byId.get(entry.target.id)?.classList.add("active");
            });
        }, { rootMargin: "-45% 0px -50% 0px" });
        byId.forEach((_, id) => {
            const section = document.getElementById(id);
            if (section) spy.observe(section);
        });
        // Back at the hero, no section is current
        const hero = document.getElementById("top");
        if (hero) spy.observe(hero);
    }

    // Comparison viewer: each tab swaps in a real capture of that view
    const tabs = Array.from(document.querySelectorAll(".tabs .tab"));
    const img = document.getElementById("cmp-img");
    const caption = document.getElementById("cmp-caption");
    if (tabs.length && img) {
        // Warm the cache so switching tabs doesn't flash
        const preload = () => tabs.forEach((t) => { new Image().src = t.dataset.src; });
        if ("requestIdleCallback" in window) requestIdleCallback(preload);
        else setTimeout(preload, 1500);

        const select = (tab) => {
            tabs.forEach((t) => {
                const on = t === tab;
                t.setAttribute("aria-selected", String(on));
                t.tabIndex = on ? 0 : -1;
            });
            if (img.getAttribute("src") === tab.dataset.src) return;
            img.classList.add("swapping");
            const next = new Image();
            next.onload = next.onerror = () => {
                img.src = tab.dataset.src;
                img.alt = tab.dataset.alt;
                caption.textContent = tab.dataset.caption;
                requestAnimationFrame(() => img.classList.remove("swapping"));
            };
            next.src = tab.dataset.src;
        };
        tabs.forEach((tab, i) => {
            tab.tabIndex = i === 0 ? 0 : -1;
            tab.addEventListener("click", () => select(tab));
            tab.addEventListener("keydown", (e) => {
                if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                next.focus();
                select(next);
            });
        });
    }

    // Mobile menu
    const toggle = document.getElementById("nav-toggle");
    const nav = document.getElementById("site-nav");
    if (toggle && nav) {
        const close = () => {
            nav.classList.remove("open");
            toggle.setAttribute("aria-expanded", "false");
        };
        toggle.addEventListener("click", () => {
            toggle.setAttribute("aria-expanded", String(nav.classList.toggle("open")));
        });
        nav.addEventListener("click", (e) => { if (e.target.closest("a")) close(); });
        document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
    }
})();
