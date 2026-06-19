// voronoi-canvas.js — render a Voronoi map on a single <canvas> instead of
// ~5,000 SVG <path> nodes. Gated by FEATURE_VORONOI_CANVAS (default off) + the
// ?canvas=1/0 override. One instance per Leaflet map (the primary map, and — as
// the migration proceeds — the supply/dual and subset maps too).
//
// WHY: ~5,000 SVG cells force the browser to lay out/paint thousands of DOM nodes
// on every recolor/pan/zoom — measured at 50-190ms/render and the dominant cause
// of interaction lag on weak GPUs/Safari. One canvas draw collapses that.
//
// IDENTITY: we reuse d3's own geometry so the pixels match the SVG path —
//   - the land clip is built with d3.geoPath(transform, ctx) (same projection the
//     SVG <clipPath> used), and
//   - each cell is stroked via voronoi.renderCell(i, ctx) (same path the SVG used).
// Positioning mirrors daynight.js: the canvas lives in a Leaflet pane, so during a
// drag Leaflet's pane transform carries it (cells follow the basemap), and we
// redraw on the moveend that already re-invokes the render.
//
// ANIMATION: SVG cells get `.transition-color { transition: fill 0.9s ease }` for
// free; canvas does not, so a small rAF engine replicates the 0.9s fill cross-fade
// on recolor (and, when callers ask, entry fade-in / ripple — added later). The
// loop idles (no rAF) whenever nothing is animating.
//
// HIT-TESTING: SVG gave per-cell DOM events for free; here we hit-test with
// delaunay.find(x,y) (O(1)) and gate it by isPointInPath(landPath) so ocean areas
// don't respond — matching the SVG cells' clip to land.

// Match the chart DPI cap: backing store at up to 2x device pixels keeps cells
// crisp without ballooning canvas memory on 4K/Retina displays.
function dpr() {
    const r = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    return Math.min(r, 2);
}

// cubic-bezier(0.25,0.1,0.25,1) — the CSS `ease` timing function, so the canvas
// cross-fade matches the SVG `transition: …ease` exactly. Newton-Raphson solve x→t.
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

export function createVoronoiCanvasLayer(map, d3, L, deps) {
    // deps: { getColor, fireMarkerEvent }
    // Pane name is per-map so multiple maps (primary, supply, subset) don't collide.
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

    // ---- color helpers (parse once, lerp numerically) ----
    function parseRGBA(str) {
        const c = d3.color(str);
        if (!c) return null;
        const rgb = c.rgb();
        return [rgb.r, rgb.g, rgb.b, (c.opacity == null ? 1 : c.opacity)];
    }
    function rgbaStr(a) {
        return 'rgba(' + (a[0] | 0) + ',' + (a[1] | 0) + ',' + (a[2] | 0) + ',' + a[3] + ')';
    }

    // Per-render geometry/state used by hit-testing and the animation loop.
    let delaunay = null;       // d3.Delaunay over container-space points
    let voronoi = null;
    let rows = [];             // data rows, index-aligned with the delaunay points
    let landPath = null;       // Path2D of the land clip (container space, CSS px)
    let styles = [];           // resolved {fill,fillOpacity,stroke,weight} per cell
    let displayedFill = [];    // [r,g,b,a] currently SHOWN per cell (lerped during cross-fade)
    let fromFill = [];         // cross-fade start per cell
    let toFill = [];           // cross-fade target per cell
    let animating = false;
    let animStart = 0;
    const animDur = 900;       // 0.9s, matches .transition-color
    let rafId = null;
    let hoveredIndex = -1;     // local mouse hover
    let externIndex = -1;      // cross-map highlight (driven by the other map's hover)
    let curHandlers = null;    // { options, enableHoverSelect, useMarkerEvents }
    let visible = false;
    let geomKey = null;        // cache key: rebuild Delaunay/clip only on view/point change

    function size() {
        const s = map.getSize();
        const ratio = dpr();
        for (const c of [base, hover]) {
            if (c.width !== s.x * ratio || c.height !== s.y * ratio) {
                c.width = s.x * ratio;
                c.height = s.y * ratio;
                c.style.width = s.x + 'px';
                c.style.height = s.y + 'px';
            }
        }
        // Pin the canvases to the layer point of container (0,0) so Leaflet's pane
        // transform slides them with the map during a drag.
        const topLeft = map.containerPointToLayerPoint([0, 0]);
        L.DomUtil.setPosition(base, topLeft);
        L.DomUtil.setPosition(hover, topLeft);
        // Draw in CSS pixels; the backing store is scaled by the device ratio.
        bctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        hctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        return s;
    }

    function resolveStyle(row, fillAccessor) {
        // Mirror applyCellStyle() in map.js exactly.
        const style = fillAccessor ? fillAccessor(row) : null;
        if (style && typeof style === 'object') {
            return {
                fill: style.fillColor || style.color,
                fillOpacity: Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6,
                stroke: style.color || 'rgba(255,255,255,0.08)',
                weight: Number.isFinite(style.weight) ? style.weight : 0.5,
            };
        }
        return {
            fill: style || deps.getColor(row.annual_cf),
            fillOpacity: 0.6,
            stroke: 'rgba(255,255,255,0.08)',
            weight: 0.5,
        };
    }

    function buildLandPath(worldGeoJSON) {
        if (!worldGeoJSON) { landPath = null; return; }
        const transform = d3.geoTransform({
            point(x, y) {
                const p = map.latLngToContainerPoint(new L.LatLng(y, x));
                this.stream.point(p.x, p.y);
            },
        });
        const p2d = new Path2D();
        const gen = d3.geoPath(transform, p2d);
        gen(worldGeoJSON);
        landPath = p2d;
    }

    function draw() {
        const s = map.getSize();
        bctx.clearRect(0, 0, s.x, s.y);
        if (!voronoi) return;
        bctx.save();
        if (landPath) bctx.clip(landPath); // clip cells to land, like the SVG clipPath
        bctx.lineJoin = 'round';
        for (let i = 0; i < rows.length; i++) {
            const st = styles[i];
            const df = displayedFill[i];
            if (!st || df == null) continue;
            bctx.beginPath();
            voronoi.renderCell(i, bctx); // identical geometry to the SVG path
            bctx.globalAlpha = st.fillOpacity;
            bctx.fillStyle = rgbaStr(df); // lerped fill during cross-fade, target otherwise
            bctx.fill();
            bctx.globalAlpha = 1;
            if (st.weight > 0) {
                bctx.lineWidth = st.weight;
                bctx.strokeStyle = st.stroke;
                bctx.stroke();
            }
        }
        bctx.restore();
    }

    // ---- cross-fade animation loop ----
    function tick() {
        rafId = null;
        if (!animating) { draw(); return; }
        const t = Math.min(1, (performance.now() - animStart) / animDur);
        const e = cssEase(t);
        for (let i = 0; i < rows.length; i++) {
            const f = fromFill[i], to = toFill[i], d = displayedFill[i];
            if (f && to && d) {
                d[0] = f[0] + (to[0] - f[0]) * e;
                d[1] = f[1] + (to[1] - f[1]) * e;
                d[2] = f[2] + (to[2] - f[2]) * e;
                d[3] = f[3] + (to[3] - f[3]) * e;
            }
        }
        draw();
        if (t >= 1) {
            animating = false;
            for (let i = 0; i < rows.length; i++) {
                if (toFill[i] && displayedFill[i]) {
                    const to = toFill[i], d = displayedFill[i];
                    d[0] = to[0]; d[1] = to[1]; d[2] = to[2]; d[3] = to[3];
                }
            }
            draw();
            return;
        }
        rafId = requestAnimationFrame(tick);
    }
    function startAnim() { if (rafId == null) rafId = requestAnimationFrame(tick); }
    function stopAnim() { if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; } animating = false; }

    function drawHover() {
        const s = map.getSize();
        hctx.clearRect(0, 0, s.x, s.y);
        if (!voronoi) return;
        const drawRim = (idx) => {
            if (idx < 0 || idx >= rows.length) return;
            hctx.beginPath();
            voronoi.renderCell(idx, hctx);
            hctx.stroke();
        };
        hctx.save();
        if (landPath) hctx.clip(landPath);
        // Match applyHoverRim(): white rim, 1.2px, full opacity.
        hctx.lineJoin = 'round';
        hctx.lineWidth = 1.2;
        hctx.strokeStyle = '#ffffff';
        hctx.globalAlpha = 1;
        drawRim(hoveredIndex);
        if (externIndex !== hoveredIndex) drawRim(externIndex); // cross-map highlight
        hctx.restore();
    }

    function show() {
        if (!visible) { base.style.display = ''; hover.style.display = ''; visible = true; }
    }
    function hide() {
        if (visible) { base.style.display = 'none'; hover.style.display = 'none'; visible = false; }
        stopAnim();
        geomKey = null; // force a geometry rebuild on re-entry (view may have changed)
        hoveredIndex = -1;
        externIndex = -1;
    }

    // render(data, fillAccessor, worldGeoJSON, handlers, opts)
    //   opts.instant — skip the cross-fade (e.g. sample playback): snap colours.
    function render(data, fillAccessor, worldGeoJSON, handlers, opts) {
        opts = opts || {};
        curHandlers = handlers;
        rows = data;
        const s = size();
        const origin = map.getPixelOrigin();
        const key = `${map.getZoom()}|${origin.x},${origin.y}|${s.x}x${s.y}|` +
            `${rows.length}|${rows[0]?.location_id ?? ''}|${rows[rows.length - 1]?.location_id ?? ''}`;
        const geometryChanged = (key !== geomKey) || !voronoi;
        if (geometryChanged) {
            const pts = new Array(rows.length);
            for (let i = 0; i < rows.length; i++) {
                const p = map.latLngToContainerPoint([rows[i].latitude, rows[i].longitude]);
                pts[i] = [p.x, p.y];
            }
            delaunay = d3.Delaunay.from(pts);
            const buf = Math.max(s.x, s.y);
            voronoi = delaunay.voronoi([-buf, -buf, s.x + buf, s.y + buf]);
            buildLandPath(worldGeoJSON);
            geomKey = key;
        }
        styles = rows.map((r) => resolveStyle(r, fillAccessor));
        const targetFill = styles.map((st) => (st && st.fill != null) ? parseRGBA(st.fill) : null);

        // Cross-fade only on a same-geometry recolour with a prior displayed set (the
        // SVG `.transition-color` likewise transitions fill on existing cells; fresh
        // geometry / first paint snaps). Skipped when the caller asks for instant.
        const canCrossfade = !geometryChanged && !opts.instant
            && displayedFill.length === rows.length;
        if (canCrossfade) {
            let any = false;
            for (let i = 0; i < rows.length; i++) {
                const tf = targetFill[i];
                const cur = displayedFill[i];
                if (tf == null) { displayedFill[i] = null; fromFill[i] = null; toFill[i] = null; continue; }
                if (cur == null) { displayedFill[i] = tf.slice(); fromFill[i] = null; toFill[i] = null; continue; }
                if (cur[0] !== tf[0] || cur[1] !== tf[1] || cur[2] !== tf[2] || cur[3] !== tf[3]) {
                    fromFill[i] = cur.slice();  // start from current shown colour (handles mid-fade restart)
                    toFill[i] = tf;
                    any = true;
                } else {
                    fromFill[i] = null; toFill[i] = null;
                }
            }
            if (any) { animStart = performance.now(); animating = true; startAnim(); }
        } else {
            // Instant: show targets now.
            stopAnim();
            displayedFill = targetFill.map((tf) => (tf == null ? null : tf.slice()));
            fromFill = new Array(rows.length);
            toFill = new Array(rows.length);
        }

        show();
        draw();
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
        if (externIndex >= rows.length) externIndex = -1;
        drawHover();
    }

    // ---- hover / click hit-testing ----
    function hitTest(e) {
        if (!delaunay) return -1;
        const cp = map.mouseEventToContainerPoint(e);
        const idx = delaunay.find(cp.x, cp.y);
        if (idx == null || idx < 0) return -1;
        // Gate by the land clip so ocean (where SVG cells were clipped away) is inert.
        // The draw context is scaled by the device ratio, so reset to identity for the
        // point test — otherwise the CSS-px point is scaled off the CSS-px path and
        // everything reads as ocean.
        if (landPath) {
            bctx.save();
            bctx.setTransform(1, 0, 0, 1, 0, 0);
            const inLand = bctx.isPointInPath(landPath, cp.x, cp.y);
            bctx.restore();
            if (!inLand) return -1;
        }
        return idx;
    }

    function setHover(idx) {
        if (idx === hoveredIndex) return;
        hoveredIndex = idx;
        drawHover();
    }

    function onMove(e) {
        if (!visible || !curHandlers) return;
        const h = curHandlers;
        if (!h.enableHoverSelect) return;
        const idx = hitTest(e);
        if (idx === hoveredIndex) return;
        // Leave the previous cell.
        if (hoveredIndex >= 0) {
            const prev = rows[hoveredIndex];
            if (h.useMarkerEvents) deps.fireMarkerEvent(prev, 'mouseout');
            if (h.options && h.options.onOut) h.options.onOut(e, prev);
        }
        setHover(idx);
        // Enter the new cell.
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

    // The canvas pane has pointer-events:none, so listen on the map container.
    const container = map.getContainer();
    container.addEventListener('mousemove', onMove);
    container.addEventListener('mouseleave', onLeave);
    map.on('click', (le) => onClick(le.originalEvent));

    return { render, hide, show };
}
