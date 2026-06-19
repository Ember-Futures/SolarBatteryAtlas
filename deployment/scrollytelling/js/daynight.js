// daynight.js — Day/night terminator shade + NASA Black Marble city lights overlay
// for the hourly "sample week" animation.
//
// Image: NASA Earth Observatory "Black Marble" 2016 (public domain).
//   https://earthobservatory.nasa.gov/features/NightLights
//
// One <canvas> in a dedicated Leaflet pane renders, per animation frame:
//   - a soft semi-transparent shade on the night side (smooth twilight ramp), and
//   - city lights that glow only on the night side, fading across the terminator.
//
// The whole thing is decoupled from the Voronoi fast-path: it draws on its own
// canvas (pointer-events:none) so tooltips/clicks on cells are untouched, and it
// only ever runs in samples mode (hidden via hideDayNight() on mode change).
//
// Singleton per app (each app imports its own copy; one map per module instance).

let map = null;
let pane = null;
let canvas = null;
let ctx = null;

// The shade (terminator darkening) is rendered on a low-res grid and smoothly
// upscaled — that soft blur is exactly what a twilight band should look like.
let gridCanvas = null;   // low-res shade (gw x gh)
let gridCtx = null;
let gridImage = null;    // reused ImageData for the shade grid
let maskCanvas = null;   // low-res night-alpha mask (gw x gh), used to gate the lights
let maskCtx = null;
let maskImage = null;

// City lights are rendered at FULL canvas resolution so they stay pin-sharp like
// a real "Earth at night" satellite image, then gated by the (soft) night mask so
// they only appear on the night side and fade across the terminator.
let lightsHiCanvas = null;   // static reprojected lights for the current view (W x H)
let lightsHiCtx = null;
let lightsHiImage = null;    // reused ImageData for the reprojected lights (W x H)
let lightsFrameCanvas = null; // per-frame working buffer (lights x mask)
let lightsFrameCtx = null;
let glowCanvas = null;       // scratch for baking the bloom halo (W x H, view-rebuilt)
let glowCtx = null;

let opts = {
    lightsUrl: null,
    zIndex: 450,
    maxShadeAlpha: 0.5,   // night darkening — kept moderate so Voronoi data stays readable
    twilightDegrees: 18,
    lightsGain: 1,
    lightsFloor: 0,   // subtract the Black Marble's dim background so only true city
                       // lights glow (keeps night-side data cells readable)
    lightsGamma: 2.5,   // tone-curve softness for the lights. 1 = linear (hard, can blow
                       // out to flat white). >1 (try 1.8–2.5) = soft rolloff: reveals the
                       // gradient from bright core → dim edge so lights aren't all-or-nothing.
                       // <1 = harsher/punchier. Colour-preserving, never hard-clips.
    lightsColorCut: 1,  // remove non-light bright areas (snow, desert, ocean) by colour.
                       // In this image real city lights are neutral/warm (R≥B) while ALL
                       // terrain is blue (B>R). 0 = off; 1 = fully cut bluish pixels.
    lightsGlow: 7,            // bloom blur radius (canvas px) baked around each light so
                              // cities read as a soft glow, not hard dots. 0 = old sharp look.
    lightsGlowStrength: 0.6,  // additive opacity of the halo (0–1).
    lightsGlowWarmth: 0.5,    // how strongly to bias the halo toward amber (0–1).
    lightsGlowColor: 'rgb(255,176,92)', // warm amber the halo is blended toward.
    resolutionDivisor: 50,
    panBuffer: 0.25,   // draw the canvas this fraction larger than the viewport on each
                       // side so it doesn't expose an edge gap while the map is dragged.
                       // Costs nothing during the drag itself (passive transform).
    smoothSweep: true,
};

let enabled = true;
let initialized = false;

// Normalized UTC milliseconds of the last requested frame and the last frame we
// actually drew (drawn lags during a smooth sweep).
let targetMs = null;
let lastDrawnMs = null;

// Per-view caches (rebuilt when the map view changes).
let viewKey = null;
let gw = 0, gh = 0;
let sinLat = null, cosLat = null;   // per grid row
let sinLon = null, cosLon = null;   // per grid column (radians)

// Pan buffer: the canvas is drawn LARGER than the viewport so that during a drag
// (a passive CSS transform on the map pane — no redraw happens) the overlay slides
// without exposing an uncovered strip at the edges, exactly like Leaflet's own SVG
// renderer. padX/padY are the per-side buffer in CSS pixels; canvas pixel (px,py)
// maps to container point (px - padX, py - padY).
let padX = 0, padY = 0;

// Black Marble source kept at full resolution for sharp lights.
let lightsSrc = null;          // { data: Uint8ClampedArray, w, h }
let lightsLoading = false;
let lightsFailed = false;

// Smooth-sweep animation handle.
let sweepRaf = null;
let sweepFromMs = 0;
let sweepToMs = 0;
let sweepStart = 0;

// True between movestart and moveend. While the map pane is being transformed
// (drag/animated pan), painting is FORBIDDEN: a repaint would compute geography
// from the in-flight view while the canvas element sits at its pre-move layer
// position, desyncing content from position. Like Leaflet's own renderers (and
// the Voronoi layer), we let the pane transform carry the existing pixels — the
// pan buffer covers the exposed edges — and repaint once, on moveend.
let moving = false;

const DEG = Math.PI / 180;

// Users who enabled the OS "Reduce Motion" setting get snapped frames (no smooth
// terminator sweep). Default users are unaffected.
function prefersReducedMotion() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function initDayNight(mapInstance, options = {}) {
    if (initialized) return;
    map = mapInstance;
    opts = { ...opts, ...options };
    initialized = true;

    pane = map.createPane('daynight');
    pane.style.zIndex = String(opts.zIndex);
    pane.style.pointerEvents = 'none';

    canvas = L.DomUtil.create('canvas', 'leaflet-daynight-layer', pane);
    canvas.style.pointerEvents = 'none';
    canvas.style.position = 'absolute';
    canvas.style.display = 'none';
    ctx = canvas.getContext('2d');

    gridCanvas = document.createElement('canvas');
    gridCtx = gridCanvas.getContext('2d');
    maskCanvas = document.createElement('canvas');
    maskCtx = maskCanvas.getContext('2d');
    lightsHiCanvas = document.createElement('canvas');
    lightsHiCtx = lightsHiCanvas.getContext('2d');
    lightsFrameCanvas = document.createElement('canvas');
    lightsFrameCtx = lightsFrameCanvas.getContext('2d');
    glowCanvas = document.createElement('canvas');
    glowCtx = glowCanvas.getContext('2d');

    map.on('movestart zoomstart', () => {
        moving = true;
        cancelSweep();
    });

    let pending = false;
    const onViewChange = () => {
        moving = false;
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (!enabled || canvas.style.display === 'none') return;
            resize();
            viewKey = null; // force cache rebuild
            const ms = targetMs ?? lastDrawnMs;
            render(ms);
            lastDrawnMs = ms;
        });
    };
    map.on('moveend zoomend resize viewreset', onViewChange);
}

// Accept number | string | Date | bigint | undefined. undefined → keep previous.
function normalizeTs(ts) {
    if (ts == null) return targetMs;
    if (typeof ts === 'bigint') return Number(ts);
    if (ts instanceof Date) return ts.getTime();
    if (typeof ts === 'number') return ts;
    // The dataset stores UTC wall-clock strings WITHOUT a zone designator
    // ("2024-04-02 09:00:00"). new Date()/Date.parse() would read those as LOCAL
    // time, shifting the terminator by the viewer's timezone offset (e.g. 4h/60°).
    // Force UTC by normalising the separator and appending 'Z' when no zone given.
    let s = String(ts).trim();
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
        s = s.replace(' ', 'T') + 'Z';
    }
    const parsed = Date.parse(s);
    return Number.isNaN(parsed) ? targetMs : parsed;
}

export function updateDayNight(ts) {
    if (!initialized || !enabled) return;
    const ms = normalizeTs(ts);
    if (ms == null) return;
    targetMs = ms;

    ensureLights();

    // Map pane is mid-move: defer painting to the moveend handler, which will
    // draw targetMs against a settled view.
    if (moving) return;

    showCanvas();

    if (lastDrawnMs == null) {
        // First frame — snap.
        cancelSweep();
        render(ms);
        lastDrawnMs = ms;
        return;
    }

    const delta = ms - lastDrawnMs;
    const TWO_HOURS = 2 * 3600 * 1000;
    if (opts.smoothSweep && delta > 0 && delta <= TWO_HOURS && !document.hidden && !prefersReducedMotion()) {
        startSweep(lastDrawnMs, ms);
    } else {
        cancelSweep();
        render(ms);
        lastDrawnMs = ms;
    }
}

export function hideDayNight() {
    if (!initialized) return;
    cancelSweep();
    if (canvas) canvas.style.display = 'none';
    // Release the large per-view canvas backing stores (5 canvases at ~2.25x the
    // viewport) and reusable ImageData buffers while the overlay is hidden — they're
    // only needed in samples mode. showCanvas()/buildViewCache()/buildLightsHi()
    // rebuild them on re-entry (viewKey is nulled below), so this is invisible.
    // lightsSrc (the ~26MB decoded Black Marble) is kept on purpose: freeing it would
    // force a refetch/redecode and a visible shade-only flash on re-entry. lastDrawnMs
    // is nulled so the first frame back snaps instead of sweeping from a stale time.
    for (const c of [canvas, gridCanvas, maskCanvas, lightsHiCanvas, lightsFrameCanvas, glowCanvas]) {
        if (c) { c.width = 0; c.height = 0; }
    }
    gridImage = null;
    maskImage = null;
    lightsHiImage = null;
    viewKey = null;
    lastDrawnMs = null;
}

export function setDayNightEnabled(on) {
    enabled = !!on;
    if (!initialized) return;
    if (!enabled) {
        hideDayNight();
    } else if (targetMs != null) {
        showCanvas();
        cancelSweep();
        render(targetMs);
        lastDrawnMs = targetMs;
    }
}

export function isDayNightEnabled() {
    return enabled;
}

function showCanvas() {
    if (canvas.style.display === 'none') {
        canvas.style.display = '';
        resize();
        viewKey = null;
    }
}

function resize() {
    const size = map.getSize();
    const buf = opts.panBuffer > 0 ? opts.panBuffer : 0;
    padX = Math.round(size.x * buf);
    padY = Math.round(size.y * buf);
    const fullW = size.x + 2 * padX;
    const fullH = size.y + 2 * padY;
    if (canvas.width !== fullW || canvas.height !== fullH) {
        canvas.width = fullW;
        canvas.height = fullH;
        canvas.style.width = fullW + 'px';
        canvas.style.height = fullH + 'px';
    }
    // Pin canvas top-left to container point (-padX,-padY) so the buffered canvas is
    // centred on the viewport; canvas pixel (px,py) == container point (px-padX,py-padY).
    const topLeft = map.containerPointToLayerPoint([-padX, -padY]);
    L.DomUtil.setPosition(canvas, topLeft);
}

// ---- Black Marble lights loading (lazy, once) -----------------------------

function ensureLights() {
    if (lightsSrc || lightsLoading || lightsFailed || !opts.lightsUrl) return;
    lightsLoading = true;
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
        try {
            // Keep the source at full native resolution (3600x1800) so individual
            // city lights stay crisp when reprojected at screen resolution.
            const sw = img.naturalWidth || 3600;
            const sh = img.naturalHeight || 1800;
            const off = document.createElement('canvas');
            off.width = sw; off.height = sh;
            const octx = off.getContext('2d');
            octx.drawImage(img, 0, 0, sw, sh);
            lightsSrc = { data: octx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
            lightsLoading = false;
            viewKey = null; // force reprojection now that lights exist
            if (canvas.style.display !== 'none') render(lastDrawnMs ?? targetMs);
        } catch (e) {
            lightsFailed = true;
            lightsLoading = false;
            console.warn('[daynight] Could not read Black Marble image (CORS?); shade only.', e);
        }
    };
    img.onerror = () => {
        lightsFailed = true;
        lightsLoading = false;
        console.warn('[daynight] Failed to load city-lights image; shade only.', opts.lightsUrl);
    };
    img.src = opts.lightsUrl;
}

// ---- Per-view geometry + lights reprojection cache ------------------------

function buildViewCache() {
    const W = canvas.width, H = canvas.height;   // padded canvas dimensions
    const div = opts.resolutionDivisor;
    gw = Math.max(2, Math.ceil(W / div));
    gh = Math.max(2, Math.ceil(H / div));

    if (gridCanvas.width !== gw || gridCanvas.height !== gh) {
        gridCanvas.width = gw;
        gridCanvas.height = gh;
        maskCanvas.width = gw;
        maskCanvas.height = gh;
    }
    gridImage = gridCtx.createImageData(gw, gh);
    maskImage = maskCtx.createImageData(gw, gh);

    sinLat = new Float64Array(gh);
    cosLat = new Float64Array(gh);
    sinLon = new Float64Array(gw);
    cosLon = new Float64Array(gw);

    // Canvas pixel (cx,cy) maps to container point (cx-padX, cy-padY). Web Mercator:
    // latitude depends on container-y only, longitude on container-x only.
    for (let gy = 0; gy < gh; gy++) {
        const cy = Math.min(gy * div, H - 1) - padY;
        const lat = map.containerPointToLatLng([0, cy]).lat;
        const latR = lat * DEG;
        sinLat[gy] = Math.sin(latR);
        cosLat[gy] = Math.cos(latR);
    }
    for (let gx = 0; gx < gw; gx++) {
        const cx = Math.min(gx * div, W - 1) - padX;
        let lon = map.containerPointToLatLng([cx, 0]).lng;
        lon = ((lon + 180) % 360 + 360) % 360 - 180; // wrap to [-180,180)
        const lonR = lon * DEG;
        sinLon[gx] = Math.sin(lonR);
        cosLon[gx] = Math.cos(lonR);
    }

    buildLightsHi();
}

// Reproject the Black Marble image (equirectangular) into the current mercator
// viewport at FULL canvas resolution, once per view. Per-pixel nearest-neighbour
// keeps individual city lights crisp. Runs only on view changes (rare — the map
// is essentially static during playback), so the ~1M-pixel pass is not on the
// per-frame path.
function buildLightsHi() {
    if (!lightsSrc) return;
    // Debug-only timing for the perf HUD (?perf). Zero overhead otherwise: when the
    // HUD isn't loaded the sink is undefined and performance.now() is never called.
    const _sink = (typeof window !== 'undefined') ? window.__SBA_PERF__ : null;
    const _t0 = _sink ? performance.now() : 0;
    const W = canvas.width, H = canvas.height;   // padded canvas dimensions
    if (lightsHiCanvas.width !== W || lightsHiCanvas.height !== H) {
        lightsHiCanvas.width = W; lightsHiCanvas.height = H;
        lightsFrameCanvas.width = W; lightsFrameCanvas.height = H;
        glowCanvas.width = W; glowCanvas.height = H;
    }
    const { data, w: sw, h: sh } = lightsSrc;

    // Canvas pixel (x,y) maps to container point (x-padX, y-padY).
    const rowSrc = new Int32Array(H);
    for (let y = 0; y < H; y++) {
        const lat = map.containerPointToLatLng([0, y - padY]).lat;
        let r = Math.round((90 - lat) / 180 * (sh - 1));
        rowSrc[y] = r < 0 ? 0 : (r > sh - 1 ? sh - 1 : r);
    }
    const colSrc = new Int32Array(W);
    for (let x = 0; x < W; x++) {
        let lon = map.containerPointToLatLng([x - padX, 0]).lng;
        lon = ((lon + 180) % 360 + 360) % 360 - 180;
        let c = Math.round((lon + 180) / 360 * (sw - 1));
        colSrc[x] = c < 0 ? 0 : (c > sw - 1 ? sw - 1 : c);
    }

    const gain = opts.lightsGain;
    const floor = opts.lightsFloor;
    const invGamma = 1 / (opts.lightsGamma || 1);
    const colorCut = opts.lightsColorCut || 0;
    // Reuse one ImageData across view changes instead of allocating ~W*H*4 bytes every
    // time. The reprojection loop below writes all four channels of every pixel (the
    // else-branch zeroes them), so reusing a dirty buffer is safe. Cuts GC churn and
    // peak memory on repeated view changes (a known Safari pressure point).
    if (!lightsHiImage || lightsHiImage.width !== W || lightsHiImage.height !== H) {
        lightsHiImage = lightsHiCtx.createImageData(W, H);
    }
    const hi = lightsHiImage;
    const out = hi.data;
    for (let y = 0; y < H; y++) {
        const srcRowBase = rowSrc[y] * sw;
        const dstRow = y * W;
        for (let x = 0; x < W; x++) {
            const si = (srcRowBase + colSrc[x]) * 4;
            const di = (dstRow + x) * 4;
            const R0 = data[si], G0 = data[si + 1], B0 = data[si + 2];

            // Colour gate: real city lights are neutral/warm (R≥B); ALL the terrain in
            // this image (snow, desert, ocean, land) is blue (B>R). Suppress bluish
            // pixels so snow/desert don't read as lights. neutrality: warm≥0 → keep,
            // warm≤-8 → cut. lightsColorCut scales how strongly the gate is applied.
            let colorGate = 1;
            if (colorCut > 0) {
                let neutrality = (R0 - B0 + 8) / 8;
                if (neutrality < 0) neutrality = 0; else if (neutrality > 1) neutrality = 1;
                colorGate = 1 - colorCut * (1 - neutrality);
            }

            // Subtract the dim background, then gain — isolates bright city lights.
            let r = (R0 - floor) * gain;
            let g = (G0 - floor) * gain;
            let b = (B0 - floor) * gain;
            if (r < 0) r = 0;
            if (g < 0) g = 0;
            if (b < 0) b = 0;
            // Tone curve on the pixel's brightness (peak channel), scaling all three
            // channels by the same factor so the light's colour is preserved and it
            // never hard-clips to flat white. gamma>1 → gentle highlight rolloff.
            let peak = r > g ? (r > b ? r : b) : (g > b ? g : b);
            if (peak > 0 && colorGate > 0) {
                const n = peak > 255 ? 1 : peak / 255;
                const tonedPeak = 255 * Math.pow(n, invGamma) * colorGate;
                const f = tonedPeak / peak;
                out[di] = r * f;
                out[di + 1] = g * f;
                out[di + 2] = b * f;
                // Alpha = light brightness, so UNLIT night areas contribute nothing
                // under additive compositing (else they'd add opacity across the whole
                // night side and black out the Voronoi data).
                out[di + 3] = tonedPeak;
            } else {
                out[di] = 0; out[di + 1] = 0; out[di + 2] = 0; out[di + 3] = 0;
            }
        }
    }
    lightsHiCtx.putImageData(hi, 0, 0);

    // Bloom: add a soft (slightly warm) halo around each light so cities read as a
    // glow rather than hard dots. Baked once per view — the per-frame path is untouched.
    const glowPx = opts.lightsGlow;
    if (glowPx > 0 && opts.lightsGlowStrength > 0) {
        const g = glowCtx;
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalCompositeOperation = 'source-over';
        g.globalAlpha = 1;
        g.clearRect(0, 0, W, H);
        g.filter = `blur(${glowPx}px)`;
        g.drawImage(lightsHiCanvas, 0, 0);          // blurred copy of the sharp lights
        g.filter = 'none';
        if (opts.lightsGlowWarmth > 0) {            // warm only where the halo has alpha
            g.globalCompositeOperation = 'source-atop';
            g.globalAlpha = opts.lightsGlowWarmth;
            g.fillStyle = opts.lightsGlowColor;
            g.fillRect(0, 0, W, H);
            g.globalAlpha = 1;
            g.globalCompositeOperation = 'source-over';
        }
        lightsHiCtx.save();
        lightsHiCtx.globalCompositeOperation = 'lighter'; // add halo onto the sharp cores
        lightsHiCtx.globalAlpha = opts.lightsGlowStrength;
        lightsHiCtx.drawImage(glowCanvas, 0, 0);
        lightsHiCtx.restore();
    }

    // Debug-only: report this per-view reprojection's cost to the perf HUD (?perf).
    if (_sink) _sink('daynight-reproject', { durationMs: performance.now() - _t0 });
}

function currentViewKey() {
    const z = map.getZoom();
    const c = map.getCenter();
    const s = map.getSize();
    const haveLights = lightsSrc ? 1 : 0;
    return `${z}|${c.lat.toFixed(4)},${c.lng.toFixed(4)}|${s.x}x${s.y}|${haveLights}`;
}

// ---- Sun position -----------------------------------------------------------
//
// IMPORTANT: the terminator is aligned to the SAMPLE DATA's clock, not true
// astronomy. The hourly sample data indexes solar generation by local time =
// UTC + longitude/15 (see samples.js renderFrame / scrolly.js
// computeWeeklyFrameColors), with each hourly bin labelled at its start. Using a
// true GMST + equation-of-time subsolar point drifts the shade ~1h (~15°) away
// from the yellow solar cells. So:
//   - declination comes from the real date (realistic seasonal day-length and
//     polar day/night), but
//   - the subsolar LONGITUDE comes from the data clock: solar noon at local
//     time SOLAR_NOON_REF. Empirically 11.5 minimises day/night disagreement
//     with the data to ~1% (vs ~4% at 12.0), because the hourly bins are
//     start-labelled, putting the lit window's centre at ~11.5 local.
const SOLAR_NOON_REF = 11.5; // local hour of modelled solar noon in the dataset

function subsolarPoint(ms) {
    // Declination from real date (J2000-based NOAA low-precision series).
    const d = (ms - 946728000000) / 86400000;
    const g = (357.529 + 0.98560028 * d) * DEG;          // mean anomaly
    const q = 280.459 + 0.98564736 * d;                  // mean longitude (deg)
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG; // ecliptic lon
    const e = (23.439 - 0.00000036 * d) * DEG;           // obliquity
    const decl = Math.asin(Math.sin(e) * Math.sin(L));   // subsolar latitude

    // Subsolar longitude from the dataset clock: lonS = 15*(SOLAR_NOON_REF - UTChours).
    const utcHours = (((ms % 86400000) + 86400000) % 86400000) / 3600000;
    let lonDeg = 15 * (SOLAR_NOON_REF - utcHours);
    lonDeg = ((lonDeg + 180) % 360 + 360) % 360 - 180;
    return { decl, lon: lonDeg * DEG };
}

// ---- Render ---------------------------------------------------------------

function render(ms) {
    if (ms == null || !canvas || canvas.style.display === 'none') return;
    if (moving) return; // never paint against an in-flight view (see `moving`)

    const key = currentViewKey();
    if (key !== viewKey) {
        buildViewCache();
        viewKey = key;
    }

    // Debug-only timing for the perf HUD (?perf), measuring just the per-frame grid
    // + compositing work (the per-view reprojection in buildViewCache is timed
    // separately as 'daynight-reproject'). Zero overhead when the HUD isn't loaded.
    const _sink = (typeof window !== 'undefined') ? window.__SBA_PERF__ : null;
    const _t0 = _sink ? performance.now() : 0;

    const { decl, lon: lonS } = subsolarPoint(ms);
    const sinD = Math.sin(decl);
    const cosD = Math.cos(decl);
    const cosLonS = Math.cos(lonS);
    const sinLonS = Math.sin(lonS);

    const sinTwi = Math.sin(opts.twilightDegrees * DEG); // ramp denominator
    const maxA = opts.maxShadeAlpha;
    const haveLights = !!lightsSrc && lightsHiCanvas.width === canvas.width
        && lightsHiCanvas.height === canvas.height;

    const shade = gridImage.data;   // low-res shade: dark blue, alpha = night*maxShade
    const mask = maskImage.data;    // low-res gate: alpha = night (gates the lights)

    for (let gy = 0; gy < gh; gy++) {
        const A = sinLat[gy] * sinD;
        const Bc = cosLat[gy] * cosD;
        const rowBase = gy * gw;
        for (let gx = 0; gx < gw; gx++) {
            const di = (rowBase + gx) * 4;
            // cos(lon - lonS) = cosLon*cosLonS + sinLon*sinLonS
            const cosH = cosLon[gx] * cosLonS + sinLon[gx] * sinLonS;
            const sinElev = A + Bc * cosH;

            // Night ramp in sin-space: 0 at horizon, 1 at -twilightDegrees.
            let t = -sinElev / sinTwi;
            if (t <= 0) {
                shade[di + 3] = 0;  // full daylight → transparent
                mask[di + 3] = 0;   // no lights on the day side
                continue;
            }
            if (t > 1) t = 1;
            const night = t * t * (3 - 2 * t); // smoothstep

            shade[di] = 8; shade[di + 1] = 12; shade[di + 2] = 25; // cool dark blue
            shade[di + 3] = Math.round(night * maxA * 255);

            mask[di] = 255; mask[di + 1] = 255; mask[di + 2] = 255;
            mask[di + 3] = Math.round(night * 255);
        }
    }

    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Layer 1 — soft shade (low-res, smoothly upscaled → gives the soft twilight band).
    gridCtx.putImageData(gridImage, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gridCanvas, 0, 0, gw, gh, 0, 0, W, H);

    // Layer 2 — crisp city lights (full-res), gated by the soft night mask, added
    // as a glow on top of the shade.
    if (haveLights) {
        maskCtx.putImageData(maskImage, 0, 0); // push the night gate to its canvas
        const lf = lightsFrameCtx;
        lf.globalCompositeOperation = 'copy';
        lf.drawImage(lightsHiCanvas, 0, 0);                 // sharp lights, full alpha
        lf.globalCompositeOperation = 'destination-in';
        lf.imageSmoothingEnabled = true;
        lf.drawImage(maskCanvas, 0, 0, gw, gh, 0, 0, W, H); // alpha *= soft night mask
        lf.globalCompositeOperation = 'source-over';

        ctx.globalCompositeOperation = 'lighter';           // additive glow
        ctx.drawImage(lightsFrameCanvas, 0, 0);
        ctx.globalCompositeOperation = 'source-over';
    }

    // Debug-only: report this frame's grid+composite cost to the perf HUD (?perf).
    if (_sink) _sink('daynight-frame', { durationMs: performance.now() - _t0 });
}

// ---- Smooth sweep between hourly frames ------------------------------------

function startSweep(fromMs, toMs) {
    cancelSweep();
    sweepFromMs = fromMs;
    sweepToMs = toMs;
    sweepStart = performance.now();
    const DURATION = 450;
    // Cap intermediate sweep renders to ~30fps. Each render() fully clears and
    // recomposites a ~2.25x-viewport canvas; at 60fps that doubles the per-frame
    // compositing bill for sub-pixel terminator motion. The terminal frame below
    // is never throttled, so the sweep still lands exactly on toMs.
    const FRAME_MS = 32;
    let sweepLastFrame = sweepStart;
    const step = (now) => {
        let p = (now - sweepStart) / DURATION;
        if (p >= 1 || document.hidden) {
            render(toMs);
            lastDrawnMs = toMs;
            sweepRaf = null;
            return;
        }
        // Throttled (skipped) frame: re-arm the rAF without rendering, so the
        // animation keeps advancing and cancelSweep() can still cancel cleanly.
        if (now - sweepLastFrame < FRAME_MS) {
            sweepRaf = requestAnimationFrame(step);
            return;
        }
        sweepLastFrame = now;
        const eased = p; // linear sweep of the sun position reads naturally
        const ms = sweepFromMs + (sweepToMs - sweepFromMs) * eased;
        render(ms);
        lastDrawnMs = ms;
        sweepRaf = requestAnimationFrame(step);
    };
    sweepRaf = requestAnimationFrame(step);
}

function cancelSweep() {
    if (sweepRaf != null) {
        cancelAnimationFrame(sweepRaf);
        sweepRaf = null;
    }
}
