// voronoi-canvas.js — render the main Voronoi map on a single <canvas> instead of
// ~5,000 SVG <path> nodes. Gated by FEATURE_VORONOI_CANVAS (default off) + the
// ?canvas=1/0 override; map.js delegates here only for the primary interactive map.
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
// redraw on the moveend that already re-invokes renderVoronoi.
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

export function createVoronoiCanvasLayer(map, d3, L, deps) {
    // deps: { getColor, fireMarkerEvent, getHandlers, perfStart, perfEnd }
    const pane = map.createPane('voronoiCanvas');
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

    // Per-render state used by hit-testing between renders.
    let delaunay = null;       // d3.Delaunay over container-space points
    let voronoi = null;
    let rows = [];             // data rows, index-aligned with the delaunay points
    let landPath = null;       // Path2D of the land clip (container space, CSS px)
    let styles = [];           // resolved {fill,fillOpacity,stroke,weight} per cell
    let hoveredIndex = -1;
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

    function draw(s) {
        bctx.clearRect(0, 0, s.x, s.y);
        bctx.save();
        if (landPath) bctx.clip(landPath); // clip cells to land, like the SVG clipPath
        bctx.lineJoin = 'round';
        for (let i = 0; i < rows.length; i++) {
            const st = styles[i];
            if (!st || st.fill == null) continue;
            bctx.beginPath();
            voronoi.renderCell(i, bctx); // identical geometry to the SVG path
            bctx.globalAlpha = st.fillOpacity;
            bctx.fillStyle = st.fill;
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

    function drawHover() {
        const s = map.getSize();
        hctx.clearRect(0, 0, s.x, s.y);
        if (hoveredIndex < 0 || hoveredIndex >= rows.length) return;
        hctx.save();
        if (landPath) hctx.clip(landPath);
        hctx.beginPath();
        voronoi.renderCell(hoveredIndex, hctx);
        // Match applyHoverRim(): white rim, 1.2px, full opacity.
        hctx.lineJoin = 'round';
        hctx.lineWidth = 1.2;
        hctx.strokeStyle = '#ffffff';
        hctx.globalAlpha = 1;
        hctx.stroke();
        hctx.restore();
    }

    function show() {
        if (!visible) { base.style.display = ''; hover.style.display = ''; visible = true; }
    }
    function hide() {
        if (visible) { base.style.display = 'none'; hover.style.display = 'none'; visible = false; }
        geomKey = null; // force a geometry rebuild on re-entry (view may have changed)
        setHover(-1);
    }

    function render(data, fillAccessor, worldGeoJSON, handlers) {
        curHandlers = handlers;
        rows = data;
        const s = size();
        // Reuse Delaunay/voronoi/land-clip across recolors: with the same view and
        // the same points (a slider tick changes only colors), the geometry is
        // identical, so we skip the rebuild and just recompute fills + redraw —
        // mirroring the SVG path's geom cache so recolors are the fast case.
        const origin = map.getPixelOrigin();
        const key = `${map.getZoom()}|${origin.x},${origin.y}|${s.x}x${s.y}|` +
            `${rows.length}|${rows[0]?.location_id ?? ''}|${rows[rows.length - 1]?.location_id ?? ''}`;
        if (key !== geomKey || !voronoi) {
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
        show();
        draw(s);
        // Keep the hover rim consistent with the (possibly new) geometry.
        if (hoveredIndex >= rows.length) hoveredIndex = -1;
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
