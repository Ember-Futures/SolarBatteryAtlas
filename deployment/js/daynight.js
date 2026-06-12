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
let gridCanvas = null;   // low-res offscreen canvas (grid resolution)
let gridCtx = null;
let gridImage = null;    // reused ImageData for the grid

let opts = {
    lightsUrl: null,
    zIndex: 450,
    maxShadeAlpha: 0.55,
    twilightDegrees: 12,
    lightsGain: 1.0,
    resolutionDivisor: 4,
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
let lightsR = null, lightsG = null, lightsB = null; // per grid cell, reprojected lights

// Black Marble source, downscaled to 1800x900 once.
let lightsSrc = null;          // { data: Uint8ClampedArray, w, h }
let lightsLoading = false;
let lightsFailed = false;

// Smooth-sweep animation handle.
let sweepRaf = null;
let sweepFromMs = 0;
let sweepToMs = 0;
let sweepStart = 0;

const DEG = Math.PI / 180;

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

    let pending = false;
    const onViewChange = () => {
        if (pending) return;
        pending = true;
        requestAnimationFrame(() => {
            pending = false;
            if (!enabled || canvas.style.display === 'none') return;
            resize();
            viewKey = null; // force cache rebuild
            render(lastDrawnMs ?? targetMs);
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
    if (opts.smoothSweep && delta > 0 && delta <= TWO_HOURS && !document.hidden) {
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
    if (canvas.width !== size.x || canvas.height !== size.y) {
        canvas.width = size.x;
        canvas.height = size.y;
        canvas.style.width = size.x + 'px';
        canvas.style.height = size.y + 'px';
    }
    // Pin canvas top-left to the container's top-left, so canvas pixels == container pixels.
    const topLeft = map.containerPointToLayerPoint([0, 0]);
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
            const sw = 1800, sh = 900;
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
    const size = map.getSize();
    const div = opts.resolutionDivisor;
    gw = Math.max(2, Math.ceil(size.x / div));
    gh = Math.max(2, Math.ceil(size.y / div));

    if (gridCanvas.width !== gw || gridCanvas.height !== gh) {
        gridCanvas.width = gw;
        gridCanvas.height = gh;
    }
    gridImage = gridCtx.createImageData(gw, gh);

    sinLat = new Float64Array(gh);
    cosLat = new Float64Array(gh);
    sinLon = new Float64Array(gw);
    cosLon = new Float64Array(gw);
    lightsR = new Uint8ClampedArray(gw * gh);
    lightsG = new Uint8ClampedArray(gw * gh);
    lightsB = new Uint8ClampedArray(gw * gh);

    // Web Mercator: latitude depends on container-y only, longitude on container-x only.
    for (let gy = 0; gy < gh; gy++) {
        const cy = Math.min(gy * div, size.y - 1);
        const lat = map.containerPointToLatLng([0, cy]).lat;
        const latR = lat * DEG;
        sinLat[gy] = Math.sin(latR);
        cosLat[gy] = Math.cos(latR);
    }
    const lonRadByCol = new Float64Array(gw); // wrapped lon, radians (for lights too)
    const lonDegByCol = new Float64Array(gw);
    for (let gx = 0; gx < gw; gx++) {
        const cx = Math.min(gx * div, size.x - 1);
        let lon = map.containerPointToLatLng([cx, 0]).lng;
        lon = ((lon + 180) % 360 + 360) % 360 - 180; // wrap to [-180,180)
        lonDegByCol[gx] = lon;
        const lonR = lon * DEG;
        lonRadByCol[gx] = lonR;
        sinLon[gx] = Math.sin(lonR);
        cosLon[gx] = Math.cos(lonR);
    }

    // Reproject Black Marble (equirectangular) → grid (current mercator viewport).
    if (lightsSrc) {
        const { data, w: sw, h: sh } = lightsSrc;
        const rowSrc = new Int32Array(gh);
        for (let gy = 0; gy < gh; gy++) {
            const cy = Math.min(gy * div, size.y - 1);
            const lat = map.containerPointToLatLng([0, cy]).lat;
            let r = Math.round((90 - lat) / 180 * (sh - 1));
            rowSrc[gy] = r < 0 ? 0 : (r > sh - 1 ? sh - 1 : r);
        }
        const colSrc = new Int32Array(gw);
        for (let gx = 0; gx < gw; gx++) {
            let c = Math.round((lonDegByCol[gx] + 180) / 360 * (sw - 1));
            colSrc[gx] = c < 0 ? 0 : (c > sw - 1 ? sw - 1 : c);
        }
        for (let gy = 0; gy < gh; gy++) {
            const srcRowBase = rowSrc[gy] * sw;
            const dstBase = gy * gw;
            for (let gx = 0; gx < gw; gx++) {
                const si = (srcRowBase + colSrc[gx]) * 4;
                const di = dstBase + gx;
                lightsR[di] = data[si];
                lightsG[di] = data[si + 1];
                lightsB[di] = data[si + 2];
            }
        }
    }
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

    const key = currentViewKey();
    if (key !== viewKey) {
        buildViewCache();
        viewKey = key;
    }

    const { decl, lon: lonS } = subsolarPoint(ms);
    const sinD = Math.sin(decl);
    const cosD = Math.cos(decl);
    const cosLonS = Math.cos(lonS);
    const sinLonS = Math.sin(lonS);

    const sinTwi = Math.sin(opts.twilightDegrees * DEG); // ramp denominator
    const maxA = opts.maxShadeAlpha;
    const gain = opts.lightsGain;
    const haveLights = !!lightsSrc;

    const out = gridImage.data;

    for (let gy = 0; gy < gh; gy++) {
        const A = sinLat[gy] * sinD;
        const Bc = cosLat[gy] * cosD;
        const rowBase = gy * gw;
        for (let gx = 0; gx < gw; gx++) {
            // cos(lon - lonS) = cosLon*cosLonS + sinLon*sinLonS
            const cosH = cosLon[gx] * cosLonS + sinLon[gx] * sinLonS;
            const sinElev = A + Bc * cosH;

            // Night ramp in sin-space: 0 at horizon, 1 at -twilightDegrees.
            let t = -sinElev / sinTwi;
            if (t <= 0) {
                // Full daylight — fully transparent.
                const di = (rowBase + gx) * 4;
                out[di + 3] = 0;
                continue;
            }
            if (t > 1) t = 1;
            const night = t * t * (3 - 2 * t); // smoothstep

            const di = (rowBase + gx) * 4;
            let r = 8, gch = 12, b = 25; // night shade base (cool dark blue)
            if (haveLights) {
                const li = rowBase + gx;
                const lf = night * gain;
                r += lightsR[li] * lf;
                gch += lightsG[li] * lf;
                b += lightsB[li] * lf;
            }
            out[di] = r > 255 ? 255 : r;
            out[di + 1] = gch > 255 ? 255 : gch;
            out[di + 2] = b > 255 ? 255 : b;

            // Shade alpha follows the night ramp; boost where lights are bright so
            // cities read clearly through the semi-transparent shade.
            let a = night * maxA;
            if (haveLights) {
                const li = rowBase + gx;
                const bright = Math.max(lightsR[li], lightsG[li], lightsB[li]) / 255;
                a += bright * night * (1 - maxA);
                if (a > 1) a = 1;
            }
            out[di + 3] = Math.round(a * 255);
        }
    }

    gridCtx.putImageData(gridImage, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gridCanvas, 0, 0, gw, gh, 0, 0, canvas.width, canvas.height);
}

// ---- Smooth sweep between hourly frames ------------------------------------

function startSweep(fromMs, toMs) {
    cancelSweep();
    sweepFromMs = fromMs;
    sweepToMs = toMs;
    sweepStart = performance.now();
    const DURATION = 450;
    const step = (now) => {
        let p = (now - sweepStart) / DURATION;
        if (p >= 1 || document.hidden) {
            render(toMs);
            lastDrawnMs = toMs;
            sweepRaf = null;
            return;
        }
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
