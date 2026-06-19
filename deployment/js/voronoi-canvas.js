// voronoi-canvas.js — render a Voronoi map on a single <canvas> instead of
// ~5,000 SVG <path> nodes. Gated by FEATURE_VORONOI_CANVAS (default off) + the
// ?canvas=1/0 override. One instance per Leaflet map (primary, supply, subset).
//
// WHY: ~5,000 SVG cells force the browser to lay out/paint thousands of DOM nodes
// on every recolor/pan/zoom — measured at 50-190ms/render and the dominant cause
// of interaction lag on weak GPUs/Safari. One canvas draw collapses that.
//
// IDENTITY: we reuse d3's own geometry so the pixels match the SVG path — the land
// clip via d3.geoPath(transform, ctx) and each cell via voronoi.renderCell(i, ctx).
// Positioning mirrors daynight.js (canvas in a Leaflet pane → drag transform carries
// it). The SVG cells' time-based behaviors are replicated by a small rAF engine:
//   - 0.9s fill cross-fade on recolor (`.transition-color`)
//   - scrolly entry fade-in (200ms, staggered) + ripple hop (0.6s left→right)
//   - chart→map highlight (dim non-matching, 100ms in / 200ms out)
// The loop idles (no rAF) whenever nothing is animating.
//
// HIT-TESTING: delaunay.find(x,y) gated by isPointInPath(landPath). A key→index map
// supports cross-map highlight (highlightKey) and chart highlight (setHighlightSet).

function dpr() {
    const r = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(r, 2); // match the chart DPI cap
}
function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }
function lerp(a, b, t) { return a + (b - a) * t; }

// cubic-bezier(0.25,0.1,0.25,1) — the CSS `ease` curve (recolor cross-fade).
function cssEase(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1;
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    let t = x;
    for (let i = 0; i < 5; i++) {
        const fx = ((ax * t + bx) * t + cx) * t - x;
        if (Math.abs(fx) < 1e-4) break;
        const d = (3 * ax * t + 2 * bx) * t + cx;
        if (Math.abs(d) < 1e-6) break;
        t -= fx / d;
    }
    return ((ay * t + by) * t + cy) * t;
}
function easeOut(t) { return 1 - (1 - t) * (1 - t); }            // entry fade-in (ease-out)
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

// One animatable fill layer: holds the shown colour per cell and lerps it toward a
// new target over the cross-fade. Reused for single + base + overlay.
function createFillState() {
    let displayed = [], from = [], to = [];
    return {
        get displayed() { return displayed; },
        setTarget(target, crossfade) {
            if (crossfade && displayed.length === target.length) {
                let any = false;
                for (let i = 0; i < target.length; i++) {
                    const tf = target[i], cur = displayed[i];
                    if (tf == null) { displayed[i] = null; from[i] = null; to[i] = null; continue; }
                    if (cur == null) { displayed[i] = tf.slice(); from[i] = null; to[i] = null; continue; }
                    if (cur[0] !== tf[0] || cur[1] !== tf[1] || cur[2] !== tf[2] || cur[3] !== tf[3]) {
                        from[i] = cur.slice(); to[i] = tf; any = true;
                    } else { from[i] = null; to[i] = null; }
                }
                return any;
            }
            displayed = target.map((tf) => (tf == null ? null : tf.slice()));
            from = new Array(target.length); to = new Array(target.length);
            return false;
        },
        advance(e) {
            for (let i = 0; i < displayed.length; i++) {
                const f = from[i], t = to[i], d = displayed[i];
                if (f && t && d) { d[0] = f[0] + (t[0] - f[0]) * e; d[1] = f[1] + (t[1] - f[1]) * e; d[2] = f[2] + (t[2] - f[2]) * e; d[3] = f[3] + (t[3] - f[3]) * e; }
            }
        },
        finalize() { for (let i = 0; i < displayed.length; i++) { const t = to[i], d = displayed[i]; if (t && d) { d[0] = t[0]; d[1] = t[1]; d[2] = t[2]; d[3] = t[3]; } } },
        reset() { displayed = []; from = []; to = []; },
    };
}

const NA_FILL = '__na__'; // sentinel a fillAccessor returns for no-data sample cells

export function createVoronoiCanvasLayer(map, d3, L, deps) {
    // deps: { getColor, fireMarkerEvent, getRowKey }
    const paneName = 'voronoiCanvas-' + (map._leaflet_id || 'main');
    const pane = map.createPane(paneName);
    pane.style.zIndex = '405';
    pane.style.pointerEvents = 'none';

    const base = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    const hover = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    for (const c of [base, hover]) { c.style.position = 'absolute'; c.style.pointerEvents = 'none'; }
    const bctx = base.getContext('2d');
    const hctx = hover.getContext('2d');

    function parseRGBA(str) {
        if (str === NA_FILL) return null;
        const c = d3.color(str);
        if (!c) return null;
        const rgb = c.rgb();
        return [rgb.r, rgb.g, rgb.b, (c.opacity == null ? 1 : c.opacity)];
    }
    function rgbaStr(a) { return 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + a[3] + ')'; }

    // No-data diagonal hatch (matches the SVG na-hatch pattern), built once.
    let naPattern = null;
    function getNaPattern() {
        if (naPattern) return naPattern;
        const p = document.createElement('canvas'); p.width = 6; p.height = 6;
        const pc = p.getContext('2d');
        pc.fillStyle = 'rgba(100,116,139,0.18)'; pc.fillRect(0, 0, 6, 6);
        pc.strokeStyle = 'rgba(148,163,184,0.7)'; pc.lineWidth = 1.5;
        pc.beginPath(); pc.moveTo(-1, 5); pc.lineTo(5, -1); pc.moveTo(1, 7); pc.lineTo(7, 1); pc.stroke();
        naPattern = bctx.createPattern(p, 'repeat');
        return naPattern;
    }

    // ---- geometry / state ----
    let delaunay = null, voronoi = null;
    let rows = [];
    let landPath = null;
    let cellX = [];            // container-space x per cell (for ripple stagger)
    let mode = 'single';
    let indexByKey = new Map();
    const fillState = createFillState();
    let cellMeta = [];         // {fillOpacity, stroke, weight, na} per cell (single mode)
    const baseState = createFillState();
    const overlayState = createFillState();
    let baseOpacity = 0.5, overlayOpacity = 0.5, baseStroke = 'rgba(255,255,255,0.08)';
    let hasBase = false, hasOverlay = false;

    let crossfading = false, crossStart = 0;
    const crossDur = 900;
    let rafId = null;
    let hoveredIndex = -1, externIndex = -1;
    let curHandlers = null;
    let visible = false;
    let geomKey = null;
    let lastWorld = null; // cached worldGeoJSON, so a map resize can re-project

    // entry animation (scrolly fade-in / ripple-hop)
    const entry = { active: false, start: 0, hasFade: false, fadeDur: 200, fadeDelay: [], hasHop: false, hopDur: 600, hopDelay: [] };
    // chart highlight (dim non-matching)
    const hi = { set: null, factor: 0, target: 0, start: 0, dur: 100, fromFactor: 0 };

    function size() {
        const s = map.getSize();
        const ratio = dpr();
        for (const c of [base, hover]) {
            if (c.width !== s.x * ratio || c.height !== s.y * ratio) {
                c.width = s.x * ratio; c.height = s.y * ratio;
                c.style.width = s.x + 'px'; c.style.height = s.y + 'px';
            }
        }
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(base, topLeft); L.DomUtil.setPosition(hover, topLeft);
        bctx.setTransform(ratio, 0, 0, ratio, 0, 0); hctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return s;
    }

    function resolveStyle(row, fillAccessor) {
        const style = fillAccessor ? fillAccessor(row) : null; // mirror applyCellStyle()
        if (style && typeof style === 'object') {
            return { fill: style.fillColor || style.color, fillOpacity: Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6, stroke: style.color || 'rgba(255,255,255,0.08)', weight: Number.isFinite(style.weight) ? style.weight : 0.5, na: (style.fillColor || style.color) === NA_FILL };
        }
        const fill = style || deps.getColor(row.annual_cf);
        return { fill, fillOpacity: 0.6, stroke: 'rgba(255,255,255,0.08)', weight: 0.5, na: fill === NA_FILL };
    }

    function buildLandPath(worldGeoJSON) {
        if (!worldGeoJSON) { landPath = null; return; }
        const transform = d3.geoTransform({ point(x, y) { const p = map.latLngToContainerPoint(new L.LatLng(y, x)); this.stream.point(p.x, p.y); } });
        const p2d = new Path2D();
        d3.geoPath(transform, p2d)(worldGeoJSON);
        landPath = p2d;
    }

    function ensureGeometry(s, worldGeoJSON) {
        const origin = map.getPixelOrigin();
        // The pane offset (≈ -mapPanePos) MUST be part of the key. Cells are built in
        // CONTAINER coordinates (latLngToContainerPoint), which shift on every pan — but
        // zoom and pixelOrigin do NOT change during a drag (Leaflet just translates the
        // map pane). Without this, a pan leaves the cached cells at their pre-pan
        // projection while size() re-pins the canvas to the new origin, so the Voronoi
        // slides off the basemap after a drag. Including it makes a pan a cache-miss, so
        // the cells rebuild in lockstep with the reposition.
        const pane = map.containerPointToLayerPoint([0, 0]);
        const key = `${map.getZoom()}|${origin.x},${origin.y}|${Math.round(pane.x)},${Math.round(pane.y)}|${s.x}x${s.y}|${rows.length}|${rows[0]?.location_id ?? ''}|${rows[rows.length - 1]?.location_id ?? ''}`;
        const changed = (key !== geomKey) || !voronoi;
        if (changed) {
            const pts = new Array(rows.length); cellX = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const p = map.latLngToContainerPoint([rows[i].latitude, rows[i].longitude]);
                pts[i] = [p.x, p.y]; cellX[i] = p.x;
            }
            delaunay = d3.Delaunay.from(pts);
            const buf = Math.max(s.x, s.y);
            voronoi = delaunay.voronoi([-buf, -buf, s.x + buf, s.y + buf]);
            buildLandPath(worldGeoJSON);
            indexByKey = new Map();
            if (deps.getRowKey) { for (let i = 0; i < rows.length; i++) { const k = deps.getRowKey(rows[i]); if (k != null) indexByKey.set(k, i); } }
            geomKey = key;
        }
        return changed;
    }

    function fillCells(state, opacity, stroke, weight) {
        const disp = state.displayed;
        const entryOn = entry.active;
        const hiOn = hi.factor > 0 && hi.set;
        const now = entryOn ? performance.now() : 0;
        for (let i = 0; i < rows.length; i++) {
            const df = disp[i];
            const meta = cellMeta[i];
            const na = mode === 'single' && meta && meta.na;
            if (df == null && !na) continue;
            let op = opacity != null ? opacity : (meta ? meta.fillOpacity : 0.6);
            let w = weight != null ? weight : (meta ? meta.weight : 0);
            let strk = stroke != null ? stroke : (meta ? meta.stroke : 'rgba(255,255,255,0.08)');
            // chart highlight: dim non-matching
            if (hiOn) {
                const match = hi.set.has(i); const f = hi.factor;
                op = lerp(op, match ? 0.95 : 0.05, f);
                if (match) { strk = '#ffffff'; w = lerp(w, 1, f); } else { w = lerp(w, 0, f); }
            }
            // entry: per-cell alpha + y offset
            let a = 1, yOff = 0;
            if (entryOn) {
                if (entry.hasFade) a = easeOut(clamp01((now - entry.start - entry.fadeDelay[i]) / entry.fadeDur));
                if (entry.hasHop) { const ht = clamp01((now - entry.start - entry.hopDelay[i]) / entry.hopDur); yOff = -6 * Math.sin(Math.PI * easeInOut(ht)); }
            }
            const needT = yOff !== 0;
            if (needT) { bctx.save(); bctx.translate(0, yOff); }
            bctx.beginPath();
            voronoi.renderCell(i, bctx);
            bctx.globalAlpha = op * a;
            bctx.fillStyle = na ? getNaPattern() : rgbaStr(df);
            bctx.fill();
            bctx.globalAlpha = 1;
            if (w > 0 && strk !== 'none') { bctx.lineWidth = w; bctx.strokeStyle = strk; bctx.stroke(); }
            if (needT) bctx.restore();
        }
    }

    function draw() {
        const s = map.getSize();
        bctx.clearRect(0, 0, s.x, s.y);
        if (!voronoi) return;
        bctx.save();
        if (landPath) bctx.clip(landPath);
        bctx.lineJoin = 'round';
        if (mode === 'dual') {
            if (hasBase) fillCells(baseState, baseOpacity, baseStroke, 0.5);
            if (hasOverlay) fillCells(overlayState, overlayOpacity, 'none', 0);
        } else {
            fillCells(fillState, null, null, null);
        }
        bctx.restore();
    }

    function anyAnimating() { return crossfading || entry.active || hi.factor !== hi.target; }
    function activeFillStates() { return mode === 'dual' ? [hasBase && baseState, hasOverlay && overlayState].filter(Boolean) : [fillState]; }
    function tick() {
        rafId = null;
        const now = performance.now();
        // cross-fade
        if (crossfading) {
            const t = clamp01((now - crossStart) / crossDur), e = cssEase(t);
            for (const st of activeFillStates()) st.advance(e);
            if (t >= 1) { crossfading = false; for (const st of activeFillStates()) st.finalize(); }
        }
        // entry
        if (entry.active) {
            const fadeEnd = entry.hasFade ? Math.max(...entry.fadeDelay) + entry.fadeDur : 0;
            const hopEnd = entry.hasHop ? Math.max(...entry.hopDelay) + entry.hopDur : 0;
            if (now - entry.start >= Math.max(fadeEnd, hopEnd)) entry.active = false;
        }
        // highlight factor
        if (hi.factor !== hi.target) {
            const t = clamp01((now - hi.start) / hi.dur);
            hi.factor = lerp(hi.fromFactor, hi.target, t);
            if (t >= 1) { hi.factor = hi.target; if (hi.target === 0) hi.set = null; }
        }
        draw();
        if (anyAnimating()) rafId = requestAnimationFrame(tick);
    }
    function startAnim() { if (rafId == null) rafId = requestAnimationFrame(tick); }
    function stopAnim() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } crossfading = false; entry.active = false; }

    function drawHover() {
        const s = map.getSize();
        hctx.clearRect(0, 0, s.x, s.y);
        if (!voronoi) return;
        const rim = (idx) => { if (idx < 0 || idx >= rows.length) return; hctx.beginPath(); voronoi.renderCell(idx, hctx); hctx.stroke(); };
        hctx.save();
        if (landPath) hctx.clip(landPath);
        hctx.lineJoin = 'round'; hctx.lineWidth = 1.2; hctx.strokeStyle = '#ffffff'; hctx.globalAlpha = 1;
        rim(hoveredIndex);
        if (externIndex !== hoveredIndex) rim(externIndex);
        hctx.restore();
    }

    function show() { if (!visible) { base.style.display = ''; hover.style.display = ''; visible = true; } }
    function hide() {
        if (visible) { base.style.display = 'none'; hover.style.display = 'none'; visible = false; }
        stopAnim();
        hi.set = null; hi.factor = 0; hi.target = 0;
        geomKey = null; hoveredIndex = -1; externIndex = -1;
    }

    // Trigger the scrolly entry animation (fade-in and/or ripple) for the current cells.
    function setupEntry(opts) {
        const fadeIn = opts.fadeIn, ripple = opts.ripple;
        entry.hasFade = !!fadeIn; entry.hasHop = !!ripple;
        if (!entry.hasFade && !entry.hasHop) { entry.active = false; return; }
        entry.start = performance.now(); entry.active = true;
        const n = rows.length;
        if (entry.hasFade) {
            entry.fadeDur = Number.isFinite(fadeIn.durationMs) ? fadeIn.durationMs : 200;
            const totalMs = Number.isFinite(fadeIn.totalMs) ? fadeIn.totalMs : 3000;
            const maxDelay = Math.max(0, totalMs - entry.fadeDur);
            entry.fadeDelay = new Array(n);
            for (let i = 0; i < n; i++) entry.fadeDelay[i] = fadeIn.random === false ? (i / Math.max(1, n - 1)) * maxDelay : Math.random() * maxDelay;
        }
        if (entry.hasHop) {
            entry.hopDur = 600;
            let minX = Infinity, maxX = -Infinity;
            for (let i = 0; i < n; i++) { const x = cellX[i]; if (x < minX) minX = x; if (x > maxX) maxX = x; }
            const xRange = (maxX - minX) || 1;
            entry.hopDelay = new Array(n);
            for (let i = 0; i < n; i++) entry.hopDelay[i] = ((cellX[i] - minX) / xRange) * 2000; // 2s sweep
        }
        startAnim();
    }

    function render(data, fillAccessor, worldGeoJSON, handlers, opts) {
        opts = opts || {};
        curHandlers = handlers;
        mode = 'single';
        rows = data;
        lastWorld = worldGeoJSON;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        cellMeta = rows.map((r) => resolveStyle(r, fillAccessor));
        const target = cellMeta.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);
        const crossfade = !geometryChanged && !opts.instant && !opts.fadeIn && !opts.ripple;
        if (fillState.setTarget(target, crossfade)) { crossStart = performance.now(); crossfading = true; startAnim(); }
        else if (!crossfade) crossfading = false;
        if (opts.fadeIn || opts.ripple) setupEntry(opts); else entry.active = false;
        show();
        draw();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
        if (anyAnimating()) startAnim();
    }

    function renderDual(data, baseFill, overlayFill, worldGeoJSON, handlers, opts) {
        opts = opts || {};
        curHandlers = handlers;
        mode = 'dual';
        rows = data;
        lastWorld = worldGeoJSON;
        hasBase = typeof baseFill === 'function'; hasOverlay = typeof overlayFill === 'function';
        baseOpacity = hasOverlay ? 0.5 : 0.85; overlayOpacity = hasBase ? 0.5 : 0.35;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        cellMeta = []; // dual has no per-cell meta; opacities/strokes are layer-wide
        const crossfade = !geometryChanged && !opts.instant;
        let armed = false;
        if (hasBase) { const bt = rows.map((d) => { const c = baseFill(d); return c == null ? null : parseRGBA(c); }); armed = baseState.setTarget(bt, crossfade) || armed; } else baseState.reset();
        if (hasOverlay) { const ot = rows.map((d) => { const c = overlayFill(d); return c == null ? null : parseRGBA(c); }); armed = overlayState.setTarget(ot, crossfade) || armed; } else overlayState.reset();
        if (armed) { crossStart = performance.now(); crossfading = true; startAnim(); }
        else if (!crossfade) crossfading = false;
        entry.active = false;
        show();
        draw();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
        if (anyAnimating()) startAnim();
    }

    function highlightKey(key) {
        const idx = (key != null && indexByKey.has(key)) ? indexByKey.get(key) : -1;
        if (idx === externIndex) return;
        externIndex = idx; drawHover();
    }
    function clearHighlight() { if (externIndex === -1) return; externIndex = -1; drawHover(); }

    // Chart→map highlight: dim non-matching cells. Accepts an array of matching row
    // keys, a predicate fn(row)->bool, or null to clear.
    function setHighlightSet(keysOrFn) {
        let set = null;
        if (typeof keysOrFn === 'function') {
            set = new Set();
            for (let i = 0; i < rows.length; i++) { if (keysOrFn(rows[i])) set.add(i); }
        } else if (keysOrFn) {
            set = new Set();
            for (const k of keysOrFn) { if (indexByKey.has(k)) set.add(indexByKey.get(k)); }
        }
        hi.fromFactor = hi.factor; hi.start = performance.now();
        if (set) { hi.set = set; hi.target = 1; hi.dur = 100; }
        else { hi.target = 0; hi.dur = 200; }
        startAnim();
    }

    function hitTest(e) {
        if (!delaunay) return -1;
        const cp = map.mouseEventToContainerPoint(e);
        const idx = delaunay.find(cp.x, cp.y);
        if (idx == null || idx < 0) return -1;
        // Don't hover a cell that isn't drawn (e.g. non-subset cells with a null fill
        // in the subset/comparison map) — matches the SVG, which has no element there.
        if (mode === 'single' && fillState.displayed[idx] == null) return -1;
        if (landPath) {
            bctx.save(); bctx.setTransform(1, 0, 0, 1, 0, 0);
            const inLand = bctx.isPointInPath(landPath, cp.x, cp.y);
            bctx.restore();
            if (!inLand) return -1;
        }
        return idx;
    }
    function setHover(idx) { if (idx === hoveredIndex) return; hoveredIndex = idx; drawHover(); }

    function onMove(e) {
        if (!visible || !curHandlers) return;
        const h = curHandlers;
        if (!h.enableHoverSelect) return;
        const idx = hitTest(e);
        if (idx === hoveredIndex) return;
        if (hoveredIndex >= 0) { const prev = rows[hoveredIndex]; if (h.useMarkerEvents) deps.fireMarkerEvent(prev, 'mouseout'); if (h.options && h.options.onOut) h.options.onOut(e, prev); }
        setHover(idx);
        if (idx >= 0) { const row = rows[idx]; if (h.useMarkerEvents) deps.fireMarkerEvent(row, 'mouseover'); if (h.options && h.options.onHover) h.options.onHover(e, row); }
    }
    function onLeave(e) {
        if (hoveredIndex < 0) return;
        const h = curHandlers; const prev = rows[hoveredIndex];
        if (h && h.useMarkerEvents) deps.fireMarkerEvent(prev, 'mouseout');
        if (h && h.options && h.options.onOut) h.options.onOut(e, prev);
        setHover(-1);
    }
    function onClick(e) {
        if (!visible || !curHandlers) return;
        const idx = hitTest(e); if (idx < 0) return;
        const h = curHandlers; const row = rows[idx];
        if (h.useMarkerEvents) deps.fireMarkerEvent(row, 'click');
        if (h.options && h.options.onClick) h.options.onClick(row);
    }

    // Re-position + re-project + redraw on EVERY view change. Our cells are in
    // container coordinates, so a pan/zoom/resize moves the basemap out from under
    // them unless we re-project (geomKey includes zoom+pixelOrigin+size, so
    // ensureGeometry rebuilds). Leaflet's SVG renderer and daynight.js do the same;
    // relying on the app to re-render on moveend is not enough — the scrollytelling
    // sticky map changes its view/size per section without re-rendering the cells.
    function refresh() {
        if (!visible || !rows.length) return;
        const s = size();
        ensureGeometry(s, lastWorld);
        draw();
        drawHover();
    }
    map.on('moveend zoomend viewreset resize', refresh);

    // Fast per-frame recolor (sample playback): same geometry + handlers, new data
    // (same ids/order) with new colours. No geometry rebuild, no handler change.
    function recolor(newData, fillAccessor, opts) {
        opts = opts || {};
        if (mode !== 'single' || !voronoi || newData.length !== rows.length) return false;
        rows = newData;
        cellMeta = rows.map((r) => resolveStyle(r, fillAccessor));
        const target = cellMeta.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);
        const crossfade = !opts.instant;
        if (fillState.setTarget(target, crossfade)) { crossStart = performance.now(); crossfading = true; startAnim(); }
        else if (!crossfade) { crossfading = false; }
        draw();
        return true;
    }

    const container = map.getContainer();
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    map.on('click', (le) => onClick(le.originalEvent));

    return { render, renderDual, recolor, hide, show, highlightKey, clearHighlight, setHighlightSet, NA_FILL };
}

createVoronoiCanvasLayer.NA_FILL = NA_FILL;
