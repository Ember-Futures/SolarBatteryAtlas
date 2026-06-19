// voronoi-canvas.js — render a Voronoi map on a single <canvas> instead of
// ~5,000 SVG <path> nodes. Gated by FEATURE_VORONOI_CANVAS (default off) + the
// ?canvas=1/0 override. One instance per Leaflet map (primary, supply, subset).
//
// WHY: ~5,000 SVG cells force the browser to lay out/paint thousands of DOM nodes
// on every recolor/pan/zoom — measured at 50-190ms/render and the dominant cause
// of interaction lag on weak GPUs/Safari. One canvas draw collapses that.
//
// IDENTITY: we reuse d3's own geometry so the pixels match the SVG path — the land
// clip via d3.geoPath(transform, ctx) (same projection as the SVG <clipPath>) and
// each cell via voronoi.renderCell(i, ctx) (same path as the SVG). Positioning
// mirrors daynight.js: the canvas lives in a Leaflet pane, so a drag's pane
// transform carries it; we redraw on the moveend that re-invokes the render.
//
// ANIMATION: SVG cells get `.transition-color { transition: fill 0.9s ease }` for
// free; a small rAF engine replicates the 0.9s fill cross-fade on recolor (per
// fill layer — single maps have one, the dual/supply view has base+overlay). The
// loop idles (no rAF) when nothing is animating.
//
// HIT-TESTING: SVG gave per-cell DOM events for free; we hit-test with
// delaunay.find(x,y) (O(1)), gated by isPointInPath(landPath) so ocean is inert.
// A key→index map also lets another map drive a cross-map highlight (highlightKey).

function dpr() {
    const r = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(r, 2); // match the chart DPI cap
}

// cubic-bezier(0.25,0.1,0.25,1) — the CSS `ease` curve, so the canvas cross-fade
// matches `transition: …ease` exactly. Newton-Raphson solve x→t.
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

// One animatable fill layer: holds the currently-shown colour per cell and lerps
// it toward a new target over the cross-fade. Reused for single + base + overlay.
function createFillState() {
    let displayed = []; // [r,g,b,a]|null per cell — the colour actually drawn
    let from = [];      // cross-fade start per cell (a .slice() copy, stable)
    let to = [];        // cross-fade target per cell
    return {
        get displayed() { return displayed; },
        // Set targets. Returns true if a cross-fade was armed (some colour changed).
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
            from = new Array(target.length);
            to = new Array(target.length);
            return false;
        },
        advance(e) {
            for (let i = 0; i < displayed.length; i++) {
                const f = from[i], t = to[i], d = displayed[i];
                if (f && t && d) {
                    d[0] = f[0] + (t[0] - f[0]) * e;
                    d[1] = f[1] + (t[1] - f[1]) * e;
                    d[2] = f[2] + (t[2] - f[2]) * e;
                    d[3] = f[3] + (t[3] - f[3]) * e;
                }
            }
        },
        finalize() {
            for (let i = 0; i < displayed.length; i++) {
                const t = to[i], d = displayed[i];
                if (t && d) { d[0] = t[0]; d[1] = t[1]; d[2] = t[2]; d[3] = t[3]; }
            }
        },
        reset() { displayed = []; from = []; to = []; },
    };
}

export function createVoronoiCanvasLayer(map, d3, L, deps) {
    // deps: { getColor, fireMarkerEvent, getRowKey }
    const paneName = 'voronoiCanvas-' + (map._leaflet_id || 'main');
    const pane = map.createPane(paneName);
    pane.style.zIndex = '405';           // above tiles/overlay (400), below daynight (450)
    pane.style.pointerEvents = 'none';   // cells aren't DOM; events come via map handlers

    const base = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    const hover = L.DomUtil.create('canvas', 'leaflet-voronoi-canvas', pane);
    for (const c of [base, hover]) {
        c.style.position = 'absolute';
        c.style.pointerEvents = 'none';
    }
    const bctx = base.getContext('2d');
    const hctx = hover.getContext('2d');

    function parseRGBA(str) {
        const c = d3.color(str);
        if (!c) return null;
        const rgb = c.rgb();
        return [rgb.r, rgb.g, rgb.b, (c.opacity == null ? 1 : c.opacity)];
    }
    function rgbaStr(a) {
        return 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + a[3] + ')';
    }

    // ---- geometry / state ----
    let delaunay = null, voronoi = null;
    let rows = [];
    let landPath = null;
    let mode = 'single';        // 'single' | 'dual'
    let indexByKey = new Map();  // getRowKey(row) -> cell index (cross-map highlight)
    // single-fill: one state + per-cell {fillOpacity, stroke, weight}
    const fillState = createFillState();
    let cellMeta = [];          // {fillOpacity, stroke, weight} per cell (single mode)
    // dual-fill: base + overlay states with their (constant) opacities/strokes
    const baseState = createFillState();
    const overlayState = createFillState();
    let baseOpacity = 0.5, overlayOpacity = 0.5, baseStroke = 'rgba(255,255,255,0.08)';
    let hasBase = false, hasOverlay = false;

    let animating = false, animStart = 0, rafId = null;
    const animDur = 900;
    let hoveredIndex = -1;      // local mouse hover
    let externIndex = -1;      // cross-map highlight from another map
    let curHandlers = null;
    let visible = false;
    let geomKey = null;

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
        L.DomUtil.setPosition(base, topLeft);
        L.DomUtil.setPosition(hover, topLeft);
        bctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        hctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return s;
    }

    function resolveStyle(row, fillAccessor) {
        const style = fillAccessor ? fillAccessor(row) : null; // mirror applyCellStyle()
        if (style && typeof style === 'object') {
            return {
                fill: style.fillColor || style.color,
                fillOpacity: Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6,
                stroke: style.color || 'rgba(255,255,255,0.08)',
                weight: Number.isFinite(style.weight) ? style.weight : 0.5,
            };
        }
        return { fill: style || deps.getColor(row.annual_cf), fillOpacity: 0.6, stroke: 'rgba(255,255,255,0.08)', weight: 0.5 };
    }

    function buildLandPath(worldGeoJSON) {
        if (!worldGeoJSON) { landPath = null; return; }
        const transform = d3.geoTransform({
            point(x, y) { const p = map.latLngToContainerPoint(new L.LatLng(y, x)); this.stream.point(p.x, p.y); },
        });
        const p2d = new Path2D();
        d3.geoPath(transform, p2d)(worldGeoJSON);
        landPath = p2d;
    }

    function ensureGeometry(s, worldGeoJSON) {
        const origin = map.getPixelOrigin();
        const key = `${map.getZoom()}|${origin.x},${origin.y}|${s.x}x${s.y}|` +
            `${rows.length}|${rows[0]?.location_id ?? ''}|${rows[rows.length - 1]?.location_id ?? ''}`;
        const changed = (key !== geomKey) || !voronoi;
        if (changed) {
            const pts = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const p = map.latLngToContainerPoint([rows[i].latitude, rows[i].longitude]);
                pts[i] = [p.x, p.y];
            }
            delaunay = d3.Delaunay.from(pts);
            const buf = Math.max(s.x, s.y);
            voronoi = delaunay.voronoi([-buf, -buf, s.x + buf, s.y + buf]);
            buildLandPath(worldGeoJSON);
            indexByKey = new Map();
            if (deps.getRowKey) {
                for (let i = 0; i < rows.length; i++) {
                    const k = deps.getRowKey(rows[i]);
                    if (k) indexByKey.set(k, i);
                }
            }
            geomKey = key;
        }
        return changed;
    }

    function fillCells(state, opacity, stroke, weight) {
        const disp = state.displayed;
        for (let i = 0; i < rows.length; i++) {
            const df = disp[i];
            if (df == null) continue;
            bctx.beginPath();
            voronoi.renderCell(i, bctx);
            bctx.globalAlpha = opacity != null ? opacity : (cellMeta[i] ? cellMeta[i].fillOpacity : 0.6);
            bctx.fillStyle = rgbaStr(df);
            bctx.fill();
            bctx.globalAlpha = 1;
            const w = weight != null ? weight : (cellMeta[i] ? cellMeta[i].weight : 0);
            if (w > 0) {
                bctx.lineWidth = w;
                bctx.strokeStyle = stroke != null ? stroke : (cellMeta[i] ? cellMeta[i].stroke : 'rgba(255,255,255,0.08)');
                bctx.stroke();
            }
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
            fillCells(fillState, null, null, null); // per-cell opacity/stroke from cellMeta
        }
        bctx.restore();
    }

    // ---- cross-fade loop ----
    function activeStates() {
        return mode === 'dual' ? [hasBase && baseState, hasOverlay && overlayState].filter(Boolean) : [fillState];
    }
    function tick() {
        rafId = null;
        if (!animating) { draw(); return; }
        const t = Math.min(1, (performance.now() - animStart) / animDur);
        const e = cssEase(t);
        for (const st of activeStates()) st.advance(e);
        draw();
        if (t >= 1) { animating = false; for (const st of activeStates()) st.finalize(); draw(); return; }
        rafId = requestAnimationFrame(tick);
    }
    function startAnim() { if (rafId == null) rafId = requestAnimationFrame(tick); }
    function stopAnim() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } animating = false; }

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
        geomKey = null; hoveredIndex = -1; externIndex = -1;
    }

    // ---- single-fill render ----
    function render(data, fillAccessor, worldGeoJSON, handlers, opts) {
        opts = opts || {};
        curHandlers = handlers;
        mode = 'single';
        rows = data;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        const resolved = rows.map((r) => resolveStyle(r, fillAccessor));
        cellMeta = resolved;
        const target = resolved.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);
        const crossfade = !geometryChanged && !opts.instant;
        if (fillState.setTarget(target, crossfade)) { animStart = performance.now(); animating = true; startAnim(); }
        else if (!crossfade) stopAnim();
        show();
        draw();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
    }

    // ---- dual-fill render (population/supply-demand view) ----
    function renderDual(data, baseFill, overlayFill, worldGeoJSON, handlers, opts) {
        opts = opts || {};
        curHandlers = handlers;
        mode = 'dual';
        rows = data;
        hasBase = typeof baseFill === 'function';
        hasOverlay = typeof overlayFill === 'function';
        baseOpacity = hasOverlay ? 0.5 : 0.85;   // match renderVoronoiDual
        overlayOpacity = hasBase ? 0.5 : 0.35;
        const s = size();
        const geometryChanged = ensureGeometry(s, worldGeoJSON);
        const crossfade = !geometryChanged && !opts.instant;
        let armed = false;
        if (hasBase) {
            const bt = rows.map((d) => { const c = baseFill(d); return c == null ? null : parseRGBA(c); });
            armed = baseState.setTarget(bt, crossfade) || armed;
        } else { baseState.reset(); }
        if (hasOverlay) {
            const ot = rows.map((d) => { const c = overlayFill(d); return c == null ? null : parseRGBA(c); });
            armed = overlayState.setTarget(ot, crossfade) || armed;
        } else { overlayState.reset(); }
        if (armed) { animStart = performance.now(); animating = true; startAnim(); }
        else if (!crossfade) stopAnim();
        show();
        draw();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
    }

    // ---- cross-map highlight (driven by the other map's hover sync) ----
    function highlightKey(key) {
        const idx = (key != null && indexByKey.has(key)) ? indexByKey.get(key) : -1;
        if (idx === externIndex) return;
        externIndex = idx;
        drawHover();
    }
    function clearHighlight() {
        if (externIndex === -1) return;
        externIndex = -1;
        drawHover();
    }

    // ---- hit-testing ----
    function hitTest(e) {
        if (!delaunay) return -1;
        const cp = map.mouseEventToContainerPoint(e);
        const idx = delaunay.find(cp.x, cp.y);
        if (idx == null || idx < 0) return -1;
        if (landPath) {
            bctx.save();
            bctx.setTransform(1, 0, 0, 1, 0, 0);
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
        if (hoveredIndex >= 0) {
            const prev = rows[hoveredIndex];
            if (h.useMarkerEvents) deps.fireMarkerEvent(prev, 'mouseout');
            if (h.options && h.options.onOut) h.options.onOut(e, prev);
        }
        setHover(idx);
        if (idx >= 0) {
            const row = rows[idx];
            if (h.useMarkerEvents) deps.fireMarkerEvent(row, 'mouseover');
            if (h.options && h.options.onHover) h.options.onHover(e, row);
        }
    }
    function onLeave(e) {
        if (hoveredIndex < 0) return;
        const h = curHandlers;
        const prev = rows[hoveredIndex];
        if (h && h.useMarkerEvents) deps.fireMarkerEvent(prev, 'mouseout');
        if (h && h.options && h.options.onOut) h.options.onOut(e, prev);
        setHover(-1);
    }
    function onClick(e) {
        if (!visible || !curHandlers) return;
        const idx = hitTest(e);
        if (idx < 0) return;
        const h = curHandlers;
        const row = rows[idx];
        if (h.useMarkerEvents) deps.fireMarkerEvent(row, 'click');
        if (h.options && h.options.onClick) h.options.onClick(row);
    }

    const container = map.getContainer();
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    map.on('click', (le) => onClick(le.originalEvent));

    return { render, renderDual, hide, show, highlightKey, clearHighlight };
}
