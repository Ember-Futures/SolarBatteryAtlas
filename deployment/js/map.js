import { capitalizeWord, formatNumber, formatCurrency, coordKey, roundedKey, capitalRecoveryFactor as crf } from './utils.js';
import {
    CF_COLOR_SCALE,
    FUEL_COLORS,
    ALL_FUELS,
    LCOE_NO_DATA_COLOR,
    ACCESS_COLOR_SCALE,
    POTENTIAL_MULTIPLE_BUCKETS,
    POTENTIAL_PER_CAPITA_BUCKETS,
    POTENTIAL_TOTAL_COLORS,
    FEATURE_VORONOI_REUSE
} from './constants.js';
import { createSharedPopup, buildTooltipHtml, buildCfTooltip, buildLcoeTooltip, buildPlantTooltip, formatFirmCfText, buildDieselBackupLines, buildCountryLine } from './tooltip.js';

// Map a value to a bucket color (shared by the "× Demand" and "per capita"
// potential display modes, which both use discrete colour buckets).
function bucketColor(buckets, val) {
    const value = Number.isFinite(val) ? val : 0;
    for (const bucket of buckets) {
        if (bucket.max === null || value < bucket.max) return bucket.color;
    }
    return buckets[buckets.length - 1].color;
}

// Per-cell country overlap list (location_id -> ordered string[]), populated from
// app.js once the overlapping-countries CSV loads. Lets every map tooltip show the
// country (or countries, for border-straddling cells) the hovered cell covers.
let cellCountriesLookup = new Map();
export function setCellCountries(lookup) {
    cellCountriesLookup = lookup instanceof Map ? lookup : new Map();
}
function buildCountryLineFor(d) {
    if (!d) return '';
    let names = Array.isArray(d.country_names) ? d.country_names : null;
    if (!names && Number.isFinite(d.location_id)) {
        names = cellCountriesLookup.get(d.location_id);
    }
    return buildCountryLine(names);
}
// Insert the country line as the last child of an existing tooltip HTML string.
function appendCountryLine(html, d) {
    if (!html) return html;
    const line = buildCountryLineFor(d);
    if (!line) return html;
    const idx = html.lastIndexOf('</div>');
    return idx === -1 ? html + line : html.slice(0, idx) + line + html.slice(idx);
}

let map;
let markersLayer;
let overlayLayer;
let voronoiLayer;
let markerRenderer;
let selectedMarker = null;
let currentMode = 'capacity';
let activeLayerMode = null;
let lastDataIsFiltered = false;
let sampleLocationHandler = null;
let populationOverlay = false;
let populationData = null;
let populationScale = null;
const ALL_FOSSIL_FUELS = ALL_FUELS;
const FOSSIL_COLORS = FUEL_COLORS;

let supplyMap;
let supplyMarkersLayer;
let supplyOverlayLayer;
let supplyVoronoiLayer;
let supplyMarkerRenderer;
let supplyPopup = null;
let dualMapEnabled = false;
let syncingMaps = false;
let lastSupplyState = null;
let demandVoronoiIndex = new Map();
let supplyVoronoiIndex = new Map();
let demandDataByCoord = new Map();
let supplyDataByCoord = new Map();
let activeDemandHoverKey = null;
let activeSupplyHoverKey = null;

const capacityMarkers = new Map();
let capacityMarkersActive = false;
let capacityPopup = null;

let samplePopup = null;
let lastSampleVoronoiKey = null;

let currentAccessMetric = 'reliability'; // 'reliability', 'no_access', or 'no_access_pop'

export function setAccessMetric(metric) {
    currentAccessMetric = metric;
}

const POTENTIAL_LEVEL_LABELS = {
    level1: 'Technical constraints',
    level2: 'Policy constraints'
};

function getPotentialLevelLabel(level) {
    return POTENTIAL_LEVEL_LABELS[level] || POTENTIAL_LEVEL_LABELS.level1;
}

// Color scale for Capacity Factor (0.0 to 1.0)
const colorScale = d3.scaleLinear()
    .domain(CF_COLOR_SCALE.domain)
    .range(CF_COLOR_SCALE.range)
    .interpolate(d3.interpolateRgb)
    .clamp(true);

function getColor(cf) {
    return colorScale(cf);
}

function startMapPerf(label, meta = {}) {
    const startHeap = performance?.memory?.usedJSHeapSize;
    return { label, meta, startMs: performance.now(), startHeap };
}

function endMapPerf(marker, extra = {}) {
    if (!marker) return;
    const endHeap = performance?.memory?.usedJSHeapSize;
    const heapDeltaMb = Number.isFinite(marker.startHeap) && Number.isFinite(endHeap)
        ? (endHeap - marker.startHeap) / 1048576
        : null;
    console.debug(`[perf] ${marker.label}`, {
        durationMs: Number((performance.now() - marker.startMs).toFixed(2)),
        heapDeltaMb: Number.isFinite(heapDeltaMb) ? Number(heapDeltaMb.toFixed(3)) : null,
        ...marker.meta,
        ...extra
    });
}

function buildPopulationScale(values) {
    const valid = values.filter(Number.isFinite);
    const min = valid.length ? Math.min(...valid) : 0;
    const max = valid.length ? Math.max(...valid) : 1;
    return d3.scaleLinear()
        .domain([min, max])
        .range(["#111827", "#f3f4f6"])
        .clamp(true);
}

function buildLcoeScale(domain, options = {}) {
    const defaultDomain = [0, 30, 90, 130, 165, 200];
    const scaleDomain = Array.isArray(domain) && domain.length >= 3 ? domain.slice() : defaultDomain;
    const underflowMin = Number.isFinite(options.underflowMin) ? options.underflowMin : null;
    // Ensure strictly increasing values to satisfy d3
    for (let i = 1; i < scaleDomain.length; i++) {
        if (scaleDomain[i] <= scaleDomain[i - 1]) {
            scaleDomain[i] = scaleDomain[i - 1] + 1;
        }
    }
    const baseRange = ["#0b1d3a", "#1d4ed8", "#16a34a", "#eab308", "#f59e0b", "#dc2626"];
    let range = baseRange;
    if (scaleDomain.length === 4) {
        range = [baseRange[0], baseRange[2], baseRange[4], baseRange[5]];
    } else if (scaleDomain.length === 5) {
        range = [baseRange[0], baseRange[1], baseRange[2], baseRange[4], baseRange[5]];
    } else if (scaleDomain.length < 4) {
        range = [baseRange[0], baseRange[4], baseRange[5]];
    }
    if (underflowMin !== null && scaleDomain[0] > underflowMin) {
        scaleDomain.unshift(underflowMin);
        range = [baseRange[0], ...range];
    }
    return d3.scaleLinear()
        .domain(scaleDomain)
        .range(range)
        .clamp(true);
}

function buildTxScale(domain) {
    const defaultDomain = [0, 100, 500];
    const scaleDomain = Array.isArray(domain) && domain.every(v => Number.isFinite(v))
        ? domain : defaultDomain;
    return d3.scaleLinear()
        .domain(scaleDomain)
        .range(["#cbd5e1", "#86efac", "#22c55e"])
        .clamp(true);
}

function buildDeltaScale(maxAbs) {
    const span = Math.max(1, maxAbs || 1);
    return d3.scaleDiverging()
        .domain([-span, 0, span])
        .interpolator(d3.interpolateRgbBasis(["#22c55e", "#cbd5e1", "#ef4444"]))
        .clamp(true);
}

function buildLcoeColorScaleFromInfo(colorInfo) {
    if (!colorInfo) {
        return buildLcoeScale();
    }
    if (colorInfo.type === 'delta') {
        return buildDeltaScale(colorInfo.maxAbs || 1);
    }
    if (colorInfo.type === 'tx') {
        return buildTxScale(colorInfo.domain);
    }
    return buildLcoeScale(colorInfo.domain, { underflowMin: colorInfo.underflowMin });
}

function getLcoeColor(row, colorInfo, colorScale) {
    if (!row || !colorInfo || !colorScale) return '#611010';
    if (!row.meetsTarget) return '#611010';
    if (colorInfo.type === 'delta') {
        return Number.isFinite(row.lcoe) && Number.isFinite(row.delta) ? colorScale(row.delta) : '#611010';
    }
    if (colorInfo.type === 'tx') {
        const val = row.txMetrics ? row.txMetrics.breakevenPerGwKm : 0;
        return Number.isFinite(row.lcoe) && val > 0 ? colorScale(val) : '#611010';
    }
    return Number.isFinite(row.lcoe) ? colorScale(row.lcoe) : '#611010';
}

let worldGeoJSON = null;
let worldGeoJsonPromise = null;

function refreshCurrentMap() {
    if (!map) return;
    if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
        updateMap(lastData, lastSolar, lastBatt, { preFiltered: lastDataIsFiltered });
    } else if (currentMode === 'lcoe' && lastLcoeData) {
        updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
    } else if (currentMode === 'lcoe_cf' && lastCfData) {
        updateCfMap(lastCfData, lastCfOptions || {});
    } else if (currentMode === 'samples' && lastSampleFrame) {
        updateMapWithSampleFrame(lastSampleFrame);
    }
    if (lastSupplyState && supplyMap) {
        updateSupplyMap(lastSupplyState);
    }
}

export function ensureWorldGeoJsonLoaded() {
    if (worldGeoJSON) return Promise.resolve(worldGeoJSON);
    if (worldGeoJsonPromise) return worldGeoJsonPromise;
    const sources = [
        'data/world.geojson',
        'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_land.geojson'
    ];
    worldGeoJsonPromise = (async () => {
        for (const source of sources) {
            try {
                const response = await fetch(source);
                if (!response.ok) continue;
                worldGeoJSON = await response.json();
                break;
            } catch (_) {
                // Try next source.
            }
        }
        if (!worldGeoJSON) {
            console.error('Could not load world GeoJSON data from local or remote sources.');
        }
        return worldGeoJSON;
    })();
    return worldGeoJsonPromise;
}
let voronoiClipVersionByMap = new Map();
let capacityCoordMap = null;
let capacityCoordMapSource = null;
let capacityCoordMapPopSource = null;

function getCapacityCoordMap(capacityMap, popData = null) {
    if (!capacityMap) return null;
    if (capacityCoordMapSource === capacityMap && capacityCoordMapPopSource === popData && capacityCoordMap) {
        return capacityCoordMap;
    }
    const coordMap = new Map();
    const capacityPoints = [];
    const capacityRows = [];
    capacityMap.forEach(row => {
        if (!row) return;
        const lat = Number(row.latitude);
        const lon = Number(row.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        coordMap.set(roundedKey(lat, lon), row);
        capacityPoints.push([lon, lat]);
        capacityRows.push(row);
    });

    if (popData && popData.length && capacityPoints.length) {
        if (typeof d3 !== 'undefined' && d3.Delaunay) {
            const delaunay = d3.Delaunay.from(capacityPoints);
            popData.forEach(p => {
                if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
                const key = roundedKey(p.latitude, p.longitude);
                if (coordMap.has(key)) return;
                const idx = delaunay.find(p.longitude, p.latitude);
                const row = capacityRows[idx];
                if (row) coordMap.set(key, row);
            });
        } else {
            // Fallback: brute-force nearest neighbor if Delaunay isn't available
            popData.forEach(p => {
                if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
                const key = roundedKey(p.latitude, p.longitude);
                if (coordMap.has(key)) return;
                let bestIdx = -1;
                let bestDist = Infinity;
                for (let i = 0; i < capacityPoints.length; i++) {
                    const [lon, lat] = capacityPoints[i];
                    const dLat = lat - p.latitude;
                    const dLon = lon - p.longitude;
                    const dist = dLat * dLat + dLon * dLon;
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestIdx = i;
                    }
                }
                if (bestIdx >= 0) coordMap.set(key, capacityRows[bestIdx]);
            });
        }
    }
    capacityCoordMapSource = capacityMap;
    capacityCoordMapPopSource = popData;
    capacityCoordMap = coordMap;
    return coordMap;
}

function applyHoverRim(element) {
    if (!element) return;
    const sel = d3.select(element);
    if (sel.attr("data-hover-prev-stroke") === null) {
        const prevStroke = sel.attr("stroke");
        const prevStrokeWidth = sel.attr("stroke-width");
        const prevStrokeOpacity = sel.attr("stroke-opacity");
        sel.attr("data-hover-prev-stroke", prevStroke == null ? '' : prevStroke);
        sel.attr("data-hover-prev-stroke-width", prevStrokeWidth == null ? '' : prevStrokeWidth);
        sel.attr("data-hover-prev-stroke-opacity", prevStrokeOpacity == null ? '' : prevStrokeOpacity);
    }
    sel.attr("stroke", "#ffffff")
        .attr("stroke-width", 1.2)
        .attr("stroke-opacity", 1)
        .classed("voronoi-hover", true);
}

function clearHoverRim(element) {
    if (!element) return;
    const sel = d3.select(element);
    const prevStroke = sel.attr("data-hover-prev-stroke");
    if (prevStroke !== null) {
        sel.attr("stroke", prevStroke === '' ? null : prevStroke);
    }
    const prevStrokeWidth = sel.attr("data-hover-prev-stroke-width");
    if (prevStrokeWidth !== null) {
        sel.attr("stroke-width", prevStrokeWidth === '' ? null : prevStrokeWidth);
    }
    const prevStrokeOpacity = sel.attr("data-hover-prev-stroke-opacity");
    if (prevStrokeOpacity !== null) {
        sel.attr("stroke-opacity", prevStrokeOpacity === '' ? null : prevStrokeOpacity);
    }
    sel.attr("data-hover-prev-stroke", null)
        .attr("data-hover-prev-stroke-width", null)
        .attr("data-hover-prev-stroke-opacity", null)
        .classed("voronoi-hover", false);
}

function getRowKey(row) {
    if (!row || !Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return null;
    return roundedKey(row.latitude, row.longitude);
}

function ensureSupplyPopup() {
    if (supplyPopup) return supplyPopup;
    if (!supplyMap) return null;
    supplyPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });
    return supplyPopup;
}

function buildLcoeConfigLine(data) {
    return `<div>CF ${formatFirmCfText(data)} | Solar ${data.solar_gw} MW_DC | Battery ${data.batt_gwh} MWh</div>`;
}

function buildDieselLocationSummaryText(data) {
    if (!data?.includeDieselBackup) return '';
    const parts = [];
    const fuel = data.backup_fuel === 'gas' ? 'gas' : 'diesel';
    const fuelLabel = fuel === 'gas' ? 'gas (OCGT)' : 'diesel';
    const shareCf = Number.isFinite(data.backup_share_cf) ? data.backup_share_cf : data.diesel_share_cf;
    if (Number.isFinite(shareCf)) {
        parts.push(`Backup ${fuelLabel} covers ${(shareCf * 100).toFixed(1)}% of annual energy`);
    }
    if (fuel === 'gas' && Number.isFinite(data.gas_price_usd_per_mmbtu)) {
        parts.push(`Gas ${formatCurrency(data.gas_price_usd_per_mmbtu, 2)}/MMBtu from ${data.gas_source_country_name || 'regional market'}`);
    } else if (fuel === 'diesel' && Number.isFinite(data.diesel_price_usd_per_liter)) {
        const sourceKind = data.diesel_source_type === 'nearest_country'
            ? `Diesel ${formatCurrency(data.diesel_price_usd_per_liter, 2)}/L from ${data.diesel_source_country_name || 'nearest country'}`
            : `Diesel ${formatCurrency(data.diesel_price_usd_per_liter, 2)}/L local`;
        parts.push(sourceKind);
    }
    const adder = Number.isFinite(data.backup_lcoe_adder) ? data.backup_lcoe_adder : data.diesel_lcoe_adder;
    if (Number.isFinite(adder)) {
        parts.push(`${fuel === 'gas' ? 'Gas' : 'Diesel'} adds ${formatCurrency(adder, 1)}/MWh`);
    }
    return parts.join(' • ');
}

function buildSupplyTooltipHtml(d, overlayMode, potentialState = null) {
    if (!d) return '';
    if (overlayMode === 'cf') {
        return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
            <div class="font-semibold">CF: ${(d.annual_cf * 100).toFixed(1)}%</div>
            <div>Solar ${d.solar_gw} MW_DC | Battery ${d.batt_gwh} MWh</div>
        </div>`;
    }
    if (overlayMode === 'lcoe') {
        return buildLcoeTooltip(d, formatCurrency, formatNumber);
    }
    if (overlayMode === 'potential' && potentialState) {
        const level = potentialState.level || 'level1';
        const isMultiple = potentialState.displayMode === 'multiple';
        const isPerCapita = potentialState.displayMode === 'per_capita';
        const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
        const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
        const rawTotal = Number(d[totalKey]);
        const ground = Number(d[groundKey] || 0);
        const rooftop = Number(d.rooftop_twh_y || 0);
        const total = Number.isFinite(rawTotal) ? rawTotal : ground + rooftop;
        const latVal = Number(d.latitude);
        const bounds = potentialState.latBounds;
        const noData = bounds ? (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max) : false;
        let ratio = null;
        let demandTwh = null;
        let noDemand = false;
        let perCapita = null;
        let population = null;
        let noPopulation = false;
        if (isMultiple) {
            const demandRow = potentialState.demandMap ? potentialState.demandMap.get(d.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            ratio = demandTwh > 0 ? total / demandTwh : null;
            noDemand = demandTwh <= 0;
        } else if (isPerCapita) {
            population = potentialState.populationMap ? Number(potentialState.populationMap.get(d.location_id) || 0) : 0;
            perCapita = population > 0 ? (total * 1e6) / population : null;
            noPopulation = !(population > 0);
        }
        let mainLine = '';
        let demandLine = '';
        if (noData) {
            mainLine = 'No data available';
        } else if (isMultiple && noDemand) {
            mainLine = 'No demand data available';
        } else if (isPerCapita && noPopulation) {
            mainLine = 'No population data available';
        } else if (isMultiple) {
            mainLine = `Solar Potential / Demand: ${ratio !== null ? `${formatNumber(ratio, 2)}×` : '--'}`;
            demandLine = `<div class="text-muted">Demand: ${demandTwh ? `${formatNumber(demandTwh, 2)} TWh/yr` : '0 TWh/yr'}</div>`;
        } else if (isPerCapita) {
            mainLine = `Solar Potential per Capita: ${perCapita !== null ? `${formatNumber(perCapita, 0)} MWh/person/yr` : '--'}`;
            demandLine = `<div class="text-muted">Population: ${population ? formatNumber(population, 0) : '0'}</div>`;
        } else {
            mainLine = `Solar Generation Potential: ${formatNumber(total, 2)} TWh/yr`;
        }
        const showBreakdown = !noData && (rooftop > 0 || ground > 0);
        const breakdownLine = showBreakdown
            ? `<div class="text-muted">Ground-mount: ${formatNumber(ground, 2)} TWh/yr • Rooftop: ${formatNumber(rooftop, 2)} TWh/yr</div>`
            : '';
        return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
            <div class="font-semibold">${mainLine}</div>
            ${demandLine}
            ${breakdownLine}
            <div class="text-muted">${getPotentialLevelLabel(level)} • 40 MW/km² ground, 100 MW/km² rooftop</div>
        </div>`;
    }
    return '';
}

function syncHoverToSupply(row) {
    if (!dualMapEnabled || !supplyMap || !lastSupplyState || lastSupplyState.overlayMode === 'none') return;
    const key = getRowKey(row);
    if (!key) return;
    const supplyRow = supplyDataByCoord.get(key);
    if (!supplyRow) return;

    if (activeSupplyHoverKey && activeSupplyHoverKey !== key) {
        const prevEl = supplyVoronoiIndex.get(activeSupplyHoverKey);
        if (prevEl) clearHoverRim(prevEl);
    }
    activeSupplyHoverKey = key;

    const el = supplyVoronoiIndex.get(key);
    if (el) applyHoverRim(el);

    const popup = ensureSupplyPopup();
    const html = buildSupplyTooltipHtml(supplyRow, lastSupplyState.overlayMode, lastSupplyState.potentialState);
    if (popup && html) {
        popup.setLatLng([supplyRow.latitude, supplyRow.longitude]).setContent(appendCountryLine(html, supplyRow)).openOn(supplyMap);
    }
}

function syncOutToSupply(row) {
    if (!dualMapEnabled || !supplyMap) return;
    const key = getRowKey(row);
    if (key && supplyVoronoiIndex.has(key)) {
        clearHoverRim(supplyVoronoiIndex.get(key));
    }
    if (activeSupplyHoverKey === key) activeSupplyHoverKey = null;
    if (supplyPopup) {
        supplyMap.closePopup(supplyPopup);
    }
}

function syncHoverToDemand(row) {
    if (!dualMapEnabled || !map) return;
    const key = getRowKey(row);
    if (!key) return;
    const demandRow = demandDataByCoord.get(key);
    if (!demandRow) return;

    if (activeDemandHoverKey && activeDemandHoverKey !== key) {
        const prevEl = demandVoronoiIndex.get(activeDemandHoverKey);
        if (prevEl) clearHoverRim(prevEl);
    }
    activeDemandHoverKey = key;

    const el = demandVoronoiIndex.get(key);
    if (el) applyHoverRim(el);
    fireMarkerEvent(demandRow, 'mouseover');
}

function syncOutToDemand(row) {
    if (!dualMapEnabled || !map) return;
    const key = getRowKey(row);
    if (key && demandVoronoiIndex.has(key)) {
        clearHoverRim(demandVoronoiIndex.get(key));
    }
    if (activeDemandHoverKey === key) activeDemandHoverKey = null;
    const demandRow = demandDataByCoord.get(key);
    if (demandRow) {
        fireMarkerEvent(demandRow, 'mouseout');
    }
}

function fireMarkerEvent(row, eventName) {
    const marker = row && row.__hitMarker;
    if (marker && typeof marker.fire === 'function') {
        marker.fire(eventName);
        return true;
    }
    return false;
}

function clearVoronoi() {
    if (!voronoiLayer) return;
    d3.select(voronoiLayer._container).selectAll("*").remove();
}

function resetLayersForMode(mode, { preserveVoronoi = false } = {}) {
    const modeChanged = activeLayerMode !== mode;
    if (modeChanged) {
        if (markersLayer) markersLayer.clearLayers();
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) clearVoronoi();
        activeLayerMode = mode;
        capacityMarkersActive = false;
        selectedMarker = null;
    } else {
        if (overlayLayer) overlayLayer.clearLayers();
        if (!preserveVoronoi) clearVoronoi();
    }
    return modeChanged;
}

export async function initMap(onLocationSelect) {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2); // World view

    markerRenderer = L.canvas({ padding: 0.5 });

    // Dark Matter basemap
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    // Zoom disabled

    map.createPane('markers');
    map.getPane('markers').style.zIndex = 600;

    markersLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    voronoiLayer = L.svg().addTo(map);

    // Re-render Voronoi on move — RAF-coalesced, and skip redraws when the
    // viewport hasn't actually changed (tile-loaded moveend, programmatic
    // nudges, sync echoes all fire moveend without any real view change).
    let moveendPending = false;
    let lastMoveZoom = null;
    let lastMoveCenter = null;
    map.on('moveend', () => {
        if (moveendPending) return;
        moveendPending = true;
        requestAnimationFrame(() => {
            moveendPending = false;
            const zoom = map.getZoom();
            const center = map.getCenter();
            const viewportChanged = lastMoveZoom !== zoom
                || !lastMoveCenter
                || !lastMoveCenter.equals(center);
            if (!viewportChanged) return;
            lastMoveZoom = zoom;
            lastMoveCenter = center;

            if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
                updateMap(lastData, lastSolar, lastBatt, { preFiltered: lastDataIsFiltered });
            } else if (currentMode === 'lcoe' && lastLcoeData) {
                updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
            } else if (currentMode === 'lcoe_cf' && lastCfData) {
                updateCfMap(lastCfData, lastCfOptions || {});
            } else if (currentMode === 'samples' && lastSampleFrame) {
                updateMapWithSampleFrame(lastSampleFrame);
            }
            if (dualMapEnabled && supplyMap && !syncingMaps) {
                syncMapViews(map, supplyMap);
            }
        });
    });

    // Store callback
    map.onLocationSelect = onLocationSelect;

    initSupplyMap();

    ensureWorldGeoJsonLoaded().then(() => {
        refreshCurrentMap();
    });
}

function initSupplyMap() {
    const container = document.getElementById('map-supply');
    if (!container) return;

    supplyMap = L.map('map-supply', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2);

    supplyMarkerRenderer = L.canvas({ padding: 0.5 });

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(supplyMap);

    supplyMarkersLayer = L.layerGroup().addTo(supplyMap);
    supplyOverlayLayer = L.layerGroup().addTo(supplyMap);
    supplyVoronoiLayer = L.svg().addTo(supplyMap);

    supplyMap.on('moveend', () => {
        if (dualMapEnabled && map && !syncingMaps) {
            syncMapViews(supplyMap, map);
        }
        if (dualMapEnabled && lastSupplyState) {
            updateSupplyMap(lastSupplyState);
        }
    });
}

function syncMapViews(sourceMap, targetMap) {
    if (!sourceMap || !targetMap) return;
    syncingMaps = true;
    targetMap.setView(sourceMap.getCenter(), sourceMap.getZoom(), { animate: false });
    setTimeout(() => {
        syncingMaps = false;
    }, 0);
}

export function setDualMapMode(enabled) {
    dualMapEnabled = !!enabled;
    if (document.body) {
        document.body.classList.toggle('split-maps', dualMapEnabled);
    }
    if (!supplyMap || !map) return;
    const syncView = () => {
        if (dualMapEnabled) {
            supplyMap.setView(map.getCenter(), map.getZoom(), { animate: false });
        }
    };

    const invalidate = () => {
        map.invalidateSize();
        supplyMap.invalidateSize();
        if (dualMapEnabled && lastSupplyState) {
            updateSupplyMap(lastSupplyState);
        }
    };

    syncView();
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            invalidate();
            syncView();
        });
    });
}

let lastData = null;
let lastSolar = null;
let lastBatt = null;
let lastLcoeData = null;
let lastLcoeOptions = null;
let lastCfData = null; // Data for Target Mode (CF Map)
let lastCfOptions = null; // Options for Target Mode (CF Map)
let lastSampleFrame = null;
let lastPopulationData = null;

function updateLocationPanel(data, color, mode) {
    const panel = document.getElementById('location-panel');
    if (!panel) return;

    const coordsEl = document.getElementById('loc-coords');
    const valueEl = document.getElementById('loc-value');
    const labelEl = document.getElementById('loc-label');
    const configEl = document.getElementById('loc-config');
    const configTextEl = document.getElementById('loc-config-text');
    const txInfoEl = document.getElementById('loc-tx-info');
    const txMwhEl = document.getElementById('loc-tx-mwh');
    const txGwKmEl = document.getElementById('loc-tx-gwkm');

    coordsEl.textContent = `${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)}`;
    valueEl.style.color = color || '#fff';

    if (mode === 'capacity') {
        valueEl.textContent = (data.annual_cf * 100).toFixed(1) + '%';
        labelEl.textContent = 'Annual Capacity Factor (share of the year 1 MW baseload is met)';
        configEl.classList.remove('hidden');
        if (configTextEl) {
            configTextEl.textContent = `Solar ${lastSolar} MW_DC (per MW load) • Battery ${lastBatt} MWh (per MW load) powering a steady 1 MW baseload.`;
        }
        if (txInfoEl) {
            txInfoEl.classList.add('hidden');
        }
    } else if (mode === 'lcoe') {
        const hasTargetLcoe = Number.isFinite(data.targetLcoe);
        const targetText = data.targetCf ? `target ${(data.targetCf * 100).toFixed(0)}% solar + battery CF for 1 MW baseload` : 'target solar + battery CF for 1 MW baseload';
        const deltaText = Number.isFinite(data.delta)
            ? ` (Δ ${data.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(data.delta), 1)}/MWh vs reference)`
            : '';
        if (hasTargetLcoe) {
            valueEl.textContent = formatFirmCfText(data);
            if (data.targetLcoeMet !== false) {
                labelEl.textContent = `Firm CF at ${formatCurrency(data.targetLcoe)}/MWh target`;
            } else {
                labelEl.textContent = `Target ${formatCurrency(data.targetLcoe)}/MWh not met; showing lowest-LCOE firm config`;
            }
            configEl.classList.remove('hidden');
            if (configTextEl) {
                const dieselSummary = buildDieselLocationSummaryText(data);
                const baseText = `Solar ${data.solar_gw} MW_DC • Battery ${data.batt_gwh} MWh • LCOE ${formatCurrency(data.lcoe)}/MWh`;
                configTextEl.textContent = dieselSummary ? `${baseText} • ${dieselSummary}` : baseText;
            }
            if (txInfoEl) {
                txInfoEl.classList.add('hidden');
            }
        } else if (data.meetsTarget) {
            valueEl.textContent = Number.isFinite(data.lcoe) ? `${formatCurrency(data.lcoe)}/MWh` : '--';
            labelEl.textContent = data.includeDieselBackup
                ? `Best firm-supply LCOE meeting ${targetText}${deltaText}`
                : `Best LCOE meeting ${targetText}${deltaText}`;
        } else {
            if (data.includeDieselBackup) {
                valueEl.textContent = Number.isFinite(data.lcoe) ? `${formatCurrency(data.lcoe)}/MWh` : '--';
                labelEl.textContent = 'Target solar + battery CF not met; showing highest-solar-share firm config';
            } else {
                const maxText = Number.isFinite(data.maxConfigLcoe) ? `>${formatCurrency(data.maxConfigLcoe)}/MWh` : '--';
                valueEl.textContent = maxText;
                labelEl.textContent = 'Target CF not met for 1 MW requirement in this region';
            }
        }
        if (!hasTargetLcoe) {
            configEl.classList.remove('hidden');
            if (configTextEl) {
                if (data.meetsTarget) {
                    const dieselSummary = buildDieselLocationSummaryText(data);
                    const firmCfText = data.includeDieselBackup ? `Firm supply ${formatFirmCfText(data)}.` : '';
                    const baseText = `Solar ${data.solar_gw} MW_DC • Battery ${data.batt_gwh} MWh serving 1 MW baseload.`;
                    configTextEl.textContent = [firmCfText, baseText, dieselSummary].filter(Boolean).join(' ');
                } else {
                    if (data.includeDieselBackup) {
                        const dieselSummary = buildDieselLocationSummaryText(data);
                        const firmCfText = `Firm supply ${formatFirmCfText(data)}.`;
                        const baseText = `Selected fallback: Solar ${data.solar_gw} MW_DC • Battery ${data.batt_gwh} MWh.`;
                        configTextEl.textContent = [firmCfText, baseText, dieselSummary].filter(Boolean).join(' ');
                    } else {
                        const solar = data.maxConfigSolar ?? data.solar_gw;
                        const batt = data.maxConfigBatt ?? data.batt_gwh;
                        configTextEl.textContent = `Highest config: Solar ${solar ?? '--'} MW_DC • Battery ${batt ?? '--'} MWh`;
                    }
                }
            }
            if (txInfoEl) {
                if (data.meetsTarget && data.txMetrics && data.txMetrics.breakevenPerGw > 0) {
                    txInfoEl.classList.remove('hidden');
                    if (txMwhEl) {
                        txMwhEl.textContent = `${formatCurrency(data.txMetrics.savingsPerMwh, 2)}/MWh`;
                    }
                    if (txGwKmEl) {
                        txGwKmEl.textContent = `${formatCurrency(data.txMetrics.breakevenPerGwKm / 1000)}/MW/km`;
                    }
                } else {
                    txInfoEl.classList.add('hidden');
                }
            }
        }
    } else if (mode === 'population') {
        const popVal = data.population_2020 || 0;
        valueEl.textContent = formatNumber(popVal, 0);
        labelEl.textContent = 'Population (total in this cell)';
        configEl.classList.add('hidden');
        if (txInfoEl) txInfoEl.classList.add('hidden');
    } else if (mode === 'potential') {
        if (data.potential_no_data) {
            valueEl.textContent = 'No data';
            labelEl.textContent = 'No data available';
        } else if (data.potential_display === 'multiple' && data.potential_no_demand) {
            valueEl.textContent = 'No demand data';
            labelEl.textContent = `Solar Potential / Demand (${getPotentialLevelLabel(data.potential_level)})`;
        } else if (data.potential_display === 'multiple') {
            const ratio = Number.isFinite(data.potential_ratio) ? data.potential_ratio : null;
            valueEl.textContent = ratio === null ? '--' : `${formatNumber(ratio, 2)}×`;
            labelEl.textContent = `Solar Potential / Demand (${getPotentialLevelLabel(data.potential_level)})`;
        } else if (data.potential_display === 'per_capita' && data.potential_no_population) {
            valueEl.textContent = 'No population';
            labelEl.textContent = `Solar Potential per Capita (${getPotentialLevelLabel(data.potential_level)})`;
        } else if (data.potential_display === 'per_capita') {
            const pc = Number.isFinite(data.potential_per_capita) ? data.potential_per_capita : null;
            valueEl.textContent = pc === null ? '--' : `${formatNumber(pc, 0)} MWh/person/yr`;
            labelEl.textContent = `Solar Potential per Capita (${getPotentialLevelLabel(data.potential_level)})`;
        } else {
            const val = Number.isFinite(data.potential_twh) ? data.potential_twh : 0;
            valueEl.textContent = `${formatNumber(val, 2)} TWh/yr`;
            labelEl.textContent = `Solar Generation Potential (${getPotentialLevelLabel(data.potential_level)})`;
        }
        configEl.classList.add('hidden');
        if (txInfoEl) txInfoEl.classList.add('hidden');
    }

    panel.classList.remove('hidden');
}

export function updateMap(data, solarGw, battGwh, options = {}) {
    currentMode = 'capacity';
    lastData = data;
    lastDataIsFiltered = options.preFiltered === true;
    lastSolar = solarGw;
    lastBatt = battGwh;
    lastLcoeData = null;
    lastLcoeOptions = null;

    selectedMarker = null;

    resetLayersForMode('capacity');

    const filtered = lastDataIsFiltered ? data : data.filter(d => d.solar_gw === solarGw && d.batt_gwh === battGwh);

    if (!filtered || filtered.length === 0) {
        return;
    }

    if (!capacityPopup) {
        capacityPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    if (!capacityMarkersActive && capacityMarkers.size) {
        capacityMarkers.forEach(({ hit }) => {
            hit.addTo(markersLayer);
        });
        capacityMarkersActive = true;
    }

    const activeIds = new Set();
    filtered.forEach(d => {
        const id = d.location_id ?? d._coordKey ?? coordKey(d.latitude, d.longitude);
        activeIds.add(id);

        const color = getColor(d.annual_cf);
        let entry = capacityMarkers.get(id);

        if (!entry) {
            const hit = L.circleMarker([d.latitude, d.longitude], {
                radius: 4.5,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers',
                renderer: markerRenderer
            });

            hit.__data = d;
            d.__hitMarker = hit;

            hit.on('mouseover', () => {
                const row = hit.__data;
                if (!row) return;
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">Capacity factor ${(row.annual_cf * 100).toFixed(1)}%</div>
                <div class="text-muted">Share of the year a 1&nbsp;MW baseload is met using ${lastSolar} MW_DC solar + ${lastBatt} MWh storage.</div>
                ${buildCountryLineFor(row)}
             </div>`;
                capacityPopup.setLatLng([row.latitude, row.longitude]).setContent(content).openOn(map);
            });

            hit.on('mouseout', () => {
                map.closePopup(capacityPopup);
            });

            hit.on('click', () => {
                const row = hit.__data;
                if (!row) return;
                const rowColor = getColor(row.annual_cf);
                updateLocationPanel(row, rowColor, 'capacity');

                if (map.onLocationSelect) {
                    map.onLocationSelect(row, 'capacity');
                }
            });

            entry = { hit };
            capacityMarkers.set(id, entry);
            if (activeLayerMode === 'capacity') {
                hit.addTo(markersLayer);
            }
        } else {
            entry.hit.__data = d;
            d.__hitMarker = entry.hit;
        }
    });

    capacityMarkersActive = true;

    if (capacityMarkers.size !== activeIds.size) {
        capacityMarkers.forEach((entry, id) => {
            const isActive = activeIds.has(id);
            if (!isActive) {
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
            } else {
                entry.hit.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 });
            }
        });
    }

    const mapPoints = filtered.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });
    renderVoronoi(mapPoints, filtered, (row) => getColor(row.annual_cf));
}

export function updatePopulationPolygons(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) {
        return;
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;
    const popIndexByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p]));
    populationScale = buildPopulationScale(popData.map(p => p.population_2020 || 0));

    // Base layer: population grayscale
    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const color = populationScale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const propLat = Number(props.latitude);
            const propLon = Number(props.longitude);
            const centroid = feature.geometry ? L.geoJSON(feature.geometry).getBounds().getCenter() : null;
            const lat = Number.isFinite(propLat) ? propLat : (centroid ? centroid.lat : null);
            const lon = Number.isFinite(propLon) ? propLon : (centroid ? centroid.lng : null);
            const key = (lat !== null && lon !== null) ? roundedKey(lat, lon) : null;
            const popRow = key ? popIndexByCoord.get(key) : null;
            const popVal = popRow?.population_2020 || 0;
            const cf = key ? cfByCoord.get(key) : null;
            const cfVal = cf ? cf.annual_cf : null;
            lyr.on('mouseover', (e) => {
                const lcoeLine = overlayMode === 'lcoe' && popRow && Number.isFinite(popRow.lcoe)
                    ? `<div>LCOE: ${formatCurrency(popRow.lcoe, 0)}/MWh</div>` : '';
                const cfLine = cfVal != null ? `<div>Capacity factor: ${(cfVal * 100).toFixed(1)}%</div>` : '';
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                    ${lcoeLine}
                    ${cfLine}
                    ${buildCountryLineFor(popRow)}
                 </div>`;
                const sharedPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                if (popRow) {
                    const clickLat = Number.isFinite(lyr.getBounds()?.getCenter()?.lat) ? lyr.getBounds().getCenter().lat : (lat ?? popRow.latitude);
                    const clickLon = Number.isFinite(lyr.getBounds()?.getCenter()?.lng) ? lyr.getBounds().getCenter().lng : (lon ?? popRow.longitude);
                    updateLocationPanel({
                        ...popRow,
                        latitude: clickLat,
                        longitude: clickLon,
                        annual_cf: cfVal || 0,
                        population_2020: popVal
                    }, lyr.options.fillColor, 'population');
                    if (map.onLocationSelect) {
                        map.onLocationSelect({ ...popRow, latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                    }
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer for CF or LCOE with transparency
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlayGeo = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = 'rgba(255,255,255,0)';
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                }
                return {
                    color: color,
                    weight: 0.5,
                    fillColor: color,
                    fillOpacity: 0.35
                };
            },
            interactive: false
        });
        overlayGeo.addTo(overlayLayer);
    }
}

// Re-export capitalRecoveryFactor from utils for backward compatibility
export { crf as capitalRecoveryFactor };

export function updatePopulationSimple(popData, { baseLayer = 'population', overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, targetCf = null, comparisonMetric = 'lcoe', fossilPlants = [], fossilCapacityMap = null, electricityDemandData = [], electricityDemandMap = null, reliabilityData = [], reliabilityMap = null, selectedFuels = [], selectedStatus = 'announced' } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0) return;

    demandDataByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p]));

    // Build LCOE Map if needed for overlay
    let lcoeMap = null;
    if (overlayMode === 'lcoe' && lcoeData) {
        lcoeMap = new Map(lcoeData.map(d => [d.location_id, d]));
    }

    // Build CF Map if needed
    let cfMap = null;
    if (overlayMode === 'cf' && cfData) {
        cfMap = new Map(cfData.map(d => [d.location_id, d]));
    }

    // Create maps from function parameters for lookup
    const capacityMap = fossilCapacityMap instanceof Map ? fossilCapacityMap : null;
    const capacityCoordMap = capacityMap ? getCapacityCoordMap(capacityMap, popData) : null;
    const demandMap = electricityDemandMap instanceof Map ? electricityDemandMap : null;
    const statusSuffix = selectedStatus === 'existing' ? 'Existing' : 'Announced';

    const formatCapacityLines = (cap) => {
        if (!cap || !selectedFuelSet.size) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-muted">No installed capacity for the selected fuels.</div>' : '';
        }
        const lines = [];
        selectedFuelSet.forEach(fuel => {
            const value = Number(cap[`${fuel}_${statusSuffix}`] || 0);
            if (value > 0) {
                lines.push(`<div>${capitalizeWord(fuel)}: ${formatNumber(value, 0)} MW</div>`);
            }
        });
        if (!lines.length) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-muted">No installed capacity for the selected fuels.</div>' : '';
        }
        return `<div class="mt-1 text-muted">Installed capacity<br>${lines.join('')}</div>`;
    };

    const selectedFuelSet = new Set((selectedFuels && selectedFuels.length ? selectedFuels : []).map(f => f.toLowerCase()));
    const popValues = popData.map(p => p.population_2020 || 0);
    const popScale = buildPopulationScale(popValues);

    // Electricity scale (linear scale, black to white like population)
    let demandScale = null;
    if (baseLayer === 'electricity' && electricityDemandData && electricityDemandData.length > 0) {
        const demands = electricityDemandData.map(d => d.annual_demand_kwh || 0).filter(v => v > 0);
        if (demands.length > 0) {
            const minD = d3.min(demands);
            const maxD = d3.max(demands);
            // Use same scale as population: interpolateGreys inverted (black = low, white = high)
            demandScale = d3.scaleSequential(t => d3.interpolateGreys(1 - t)).domain([minD, maxD]);
        }
    }

    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeColorInfo ? buildLcoeColorScaleFromInfo(lcoeColorInfo) : null;

    // Build coordinate-based lookup for electricity demand (since popData doesn't have location_id)
    const demandByCoord = new Map();
    if (electricityDemandData && electricityDemandData.length > 0) {
        electricityDemandData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude);
            demandByCoord.set(key, d);
        });
    }

    // Build coordinate-based lookup for reliability data
    // NOTE: Using 2 decimals because the source voronoi_grid_reliability.csv has 2-decimal precision
    const reliabilityByCoord = new Map();
    if (reliabilityData && reliabilityData.length > 0) {
        reliabilityData.forEach(d => {
            const key = roundedKey(d.latitude, d.longitude, 2);
            reliabilityByCoord.set(key, d);
        });
    }

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    popData.forEach(d => {
        let baseColor = 'rgba(0,0,0,0)';
        let displayPop = true; // default true for population dots

        // Handle Base Layer Color
        if (baseLayer === 'electricity') {
            const demandRow = demandMap && d.location_id != null ? demandMap.get(Number(d.location_id)) : null;
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                baseColor = demandScale(val);
                displayPop = false; // We use voronoi fill for electricity, not dots (or maybe dots?)
            } else {
                baseColor = '#1e293b'; // slate-800 for no data
                displayPop = false;
            }
        } else if (baseLayer === 'plants') {
            // ... existing plant logic handled via dots but we might change visual strategy ...
            // Actually, plant view currently just hides population dots and shows plant voronoi?
            // Let's stick to existing logic:
            // popColor is used for dots.
            displayPop = true;
            // But existing code uses `scale(d.population)`
            baseColor = popScale(d.population_2020 || 0);
        } else {
            // population
            baseColor = popScale(d.population_2020 || 0);
        }

        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const capacity = capacityCoordMap ? capacityCoordMap.get(key) : null;
        const capacityLines = formatCapacityLines(capacity);

        // Determine overlay color and data
        let overlayColor = null;
        let overlayData = null;
        if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            overlayColor = getColor(cfRow.annual_cf);
            overlayData = cfRow;
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeColorInfo && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            overlayColor = getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
            overlayData = lcoeRow;
        }

        // Dots logic replaced by Voronoi fill for cleaner look in population/electricity mode
        // Only render dots if specifically needed (e.g. maybe for plant mode?)
        // For now, removing dot rendering for base layers to rely on Voronoi.
        /*
        const showDots = (baseLayer === 'population' || baseLayer === 'plants') && overlayMode === 'none';
        if (showDots) {
             L.circleMarker([d.latitude, d.longitude], {
                radius: 0.8,
                fillColor: baseColor,
                color: baseColor,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.9,
                pane: 'markers',
                interactive: false
            }).addTo(markersLayer);
        }
        */

        // key is already defined above at line 598
        const demandRow = demandByCoord.get(key);
        const demandVal = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
        const demandTwh = demandVal / 1e9; // Convert kWh to TWh

        const populationLine = baseLayer === 'population'
            ? `<div class="mt-1 text-muted">Population: ${formatNumber(d.population_2020 || 0, 0)}</div>`
            : baseLayer === 'electricity'
                ? `<div class="mt-1 text-muted">Annual Demand: ${demandTwh.toFixed(2)} TWh</div>`
                : '';

        const shouldShowHitMarker = true; // Always allow hover for tooltip
        if (shouldShowHitMarker) {
            const marker = L.circleMarker([d.latitude, d.longitude], {
                radius: 4.5,
                fillColor: '#fff',
                color: '#fff',
                weight: 0,
                opacity: 0,
                fillOpacity: 0,
                pane: 'markers',
                renderer: markerRenderer
            });

            marker.on('mouseover', () => {
                let content;
                if (overlayMode === 'lcoe' && overlayData) {
                    const valueLine = overlayData.meetsTarget || overlayData.includeDieselBackup
                        ? `LCOE: ${Number.isFinite(overlayData.lcoe) ? formatCurrency(overlayData.lcoe) : '--'}/MWh`
                        : `LCOE: ${Number.isFinite(overlayData.maxConfigLcoe) ? `>${formatCurrency(overlayData.maxConfigLcoe)}` : '--'}/MWh`;
                    let infoLines = '';
                    if (overlayData.meetsTarget) {
                        if (lcoeColorInfo?.type === 'tx' && overlayData.txMetrics) {
                            const deltaLine = Number.isFinite(overlayData.delta)
                                ? `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`
                                : '';
                            const breakevenGw = `${formatCurrency(overlayData.txMetrics.breakevenPerGw / 1000)}/MW`;
                            const breakevenGwKm = `${formatCurrency(overlayData.txMetrics.breakevenPerGwKm / 1000)}/MW/km`;

                            const distanceLine = Number.isFinite(overlayData.txMetrics.distanceKm)
                                ? `<div>Approx. straight-line distance: ${formatNumber(overlayData.txMetrics.distanceKm, 0)} km</div>`
                                : `<div>Approx. straight-line distance: --</div>`;

                            // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                            infoLines = `${deltaLine}\n<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>\n${distanceLine}`;
                        } else if (lcoeColorInfo?.type === 'delta' && Number.isFinite(overlayData.delta)) {
                            infoLines = `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`;
                        }
                    } else {
                        infoLines = overlayData.includeDieselBackup
                            ? `<div class="text-amber-300">Target solar + battery CF not met; showing the highest-solar-share firm configuration.</div>`
                            : `<div class="text-amber-300">Target CF for 1&nbsp;MW baseload not met in this dataset.</div>`;
                        if (!overlayData.includeDieselBackup) {
                            infoLines += `<div>Highest config (${overlayData.maxConfigSolar ?? '--'} MW_DC, ${overlayData.maxConfigBatt ?? '--'} MWh)</div>`;
                        }
                    }
                    const dieselLines = buildDieselBackupLines(overlayData, formatCurrency).join('');
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${valueLine}</div>
                    <div>${buildLcoeConfigLine(overlayData)}</div>
                    ${dieselLines}
                    ${infoLines}
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else if (overlayMode === 'cf' && overlayData) {
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">CF: ${(overlayData.annual_cf * 100).toFixed(1)}%</div>
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else if (baseLayer === 'uptime') {
                    const relKey = roundedKey(d.latitude, d.longitude, 2);
                    const relData = reliabilityByCoord.get(relKey);
                    const hasData = relData && relData.hrea_covered;
                    let metricLine = '';
                    if (hasData) {
                        const val = relData.avg_reliability_access_only !== undefined ? relData.avg_reliability_access_only : relData.avg_reliability;
                        metricLine = `<div class="font-semibold text-white">Grid Reliability: ${val.toFixed(1)}%</div>
                                      <div class="text-[10px] text-muted">Share of time the local grid is operational</div>`;
                    } else {
                        metricLine = `<div class="font-semibold text-muted">Grid Reliability: No data available</div>`;
                    }
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${metricLine}
                    ${populationLine}
                 </div>`;
                } else if (overlayMode === 'access' || baseLayer === 'access') {
                    // Access mode - show reliability (use 2 decimals for lookup)
                    const relKey = roundedKey(d.latitude, d.longitude, 2);
                    const relData = reliabilityByCoord.get(relKey);

            const hasData = relData && relData.hrea_covered;
            const hreaCovered = relData ? (relData.hrea_covered ? 'Yes' : 'No') : '--';

            let metricLine = '';
            if (hasData) {
                const relVal = (relData.avg_reliability_access_only || 0).toFixed(1) + '%';
                const noAccessVal = ((relData.pct_no_access || 0) * 100).toFixed(1) + '%';

                // Highlight the active metric
                if (currentAccessMetric === 'no_access_pop') {
                    const popNoAccess = (relData.total_pop_reliability || 0) * (relData.pct_no_access || 0);
                    metricLine = `<div class="font-semibold">Without Access: ${(popNoAccess / 1e6).toFixed(2)} million</div>
                                   <div class="text-muted text-[10px]">Percentage: ${noAccessVal}</div>`;
                } else if (currentAccessMetric === 'no_access') {
                    metricLine = `<div class="font-semibold">No Access: ${noAccessVal}</div>
                                           <div class="text-muted text-[10px]">Grid Reliability (connected): ${relVal}</div>`;
                } else {
                    metricLine = `<div class="font-semibold">Grid Reliability: ${relVal}</div>
                                           <div class="text-muted text-[10px]">No Access: ${noAccessVal}</div>`;
                        }
                    } else {
                        metricLine = `<div class="font-semibold">Average Grid Uptime: No Data</div>`;
                    }

                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${metricLine}
                    <div class="text-muted">HREA Data Available: ${hreaCovered}</div>
                    ${populationLine}
                    ${capacityLines}
                 </div>`;
                } else {
                    const baseInfo = populationLine || '<div class="mt-1 text-muted">Installed capacity summary:</div>';
                    content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    ${baseInfo}
                    ${capacityLines}
                 </div>`;
                }
                sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
            });

            marker.on('mouseout', () => {
                map.closePopup(sharedPopup);
            });

            marker.on('click', () => {
                updateLocationPanel({
                    ...d,
                    ...(overlayData || {}),
                    population_2020: d.population_2020,
                    targetCf,
                    comparisonMetric
                }, overlayColor || baseColor, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');

                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, ...overlayData, population_2020: d.population_2020 }, overlayMode === 'lcoe' ? 'lcoe' : overlayMode === 'cf' ? 'capacity' : 'population');
                }
            });

            d.__hitMarker = marker;
            marker.addTo(markersLayer);
        }
    });

    const filteredPlants = baseLayer === 'plants' && Array.isArray(fossilPlants)
        ? fossilPlants.filter(plant => selectedFuelSet.has(plant.fuel_group) && plant.status === selectedStatus)
        : [];

    if (filteredPlants.length) {
        const plantPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
        filteredPlants.forEach(plant => {
            if (!Number.isFinite(plant.latitude) || !Number.isFinite(plant.longitude)) return;
            const color = FOSSIL_COLORS[plant.fuel_group] || '#e2e8f0';
            const baseCapacity = Number.isFinite(plant.capacity_mw) ? Math.max(plant.capacity_mw, 0) : 0;
            const radius = Math.max(2, Math.min(12, Math.sqrt(baseCapacity) * 0.15));
            const marker = L.circleMarker([plant.latitude, plant.longitude], {
                radius,
                fillColor: color,
                color,
                weight: 0,
                opacity: 1,
                fillOpacity: 0.3,
                pane: 'markers',
                renderer: markerRenderer
            });
            marker.on('mouseover', () => {
                const cap = formatNumber(baseCapacity, 0);
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">${plant.plant_name || 'Power plant'}</div>
                    <div>${plant.fuel_group.toUpperCase()} • ${cap} MW</div>
                    <div class="text-muted">${capitalizeWord(plant.status)}</div>
                    <div class="text-muted">${plant.country || 'Unknown'}</div>
                 </div>`;
                plantPopup.setLatLng([plant.latitude, plant.longitude]).setContent(content).openOn(map);
            });
            marker.on('mouseout', () => map.closePopup(plantPopup));
            marker.addTo(overlayLayer);
        });
    }

    const voronoiPoints = popData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    // Hoist per-cell scales out of the fill closures — one allocation per render
    // instead of one per Voronoi cell.
    const reliabilityColorScale = d3.scaleLinear()
        .domain([0, 100])
        .range(["#ef4444", "#6b7280"])
        .clamp(true);
    const noAccessPopScale = d3.scaleLog()
        .domain([100, 10000, 1000000])
        .range(["#1e293b", "#991b1b", "#ff0000"])
        .clamp(true);

    // Define base layer fill function (demand layer)
    const baseFill = (d) => {
        if (baseLayer === 'uptime') {
            // Grid Reliability (Red -> Grey)
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (!rel || !rel.hrea_covered) return '#1e293b'; // No data

            const gridUptime = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            return reliabilityColorScale(gridUptime);
        }
        if (baseLayer === 'access') {
            // Use coordinate-based lookup with 2 decimals to match source data
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (currentAccessMetric === 'no_access_pop') {
                const popNoAccess = (rel && rel.hrea_covered) ? (rel.total_pop_reliability || 0) * (rel.pct_no_access || 0) : 0;
                if (popNoAccess <= 0) return '#111827'; // Darkest grey for universal access
                return noAccessPopScale(Math.max(1, popNoAccess));
            }

            if (!rel) return '#1e293b'; // No data
            if (!rel.hrea_covered) return '#1e293b';

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access') {
                // High no access (1.0) -> Bad (Red). Low no access (0.0) -> Good (Green).
                // Scale expects 0->Red, 100->Green.
                // Map: 1 - pct (0..1) -> 0..1 * 100 -> 0..100.
                const pct = rel.pct_no_access || 0;
                if (pct <= 0) return 'rgba(0,0,0,0)'; // Hide if everyone has access
                val = (1 - pct) * 100;
            } else {
                // Reliability: 0->Red (Low), 100->Green (High)
                // Use access_only metric if available, else standard
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low -> Grey high) to match scrollytelling uptime map
            return reliabilityColorScale(val);
        } else if (baseLayer === 'electricity') {
            const key = roundedKey(d.latitude, d.longitude);
            const demandRow = demandByCoord.get(key);
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                return demandScale(val);
            }
            return '#1e293b'; // slate-800 for no data
        } else if (baseLayer === 'population') {
            const popVal = d.population_2020 || 0;
            return popScale(popVal);
        } else if (baseLayer === 'plants') {
            return 'rgba(0,0,0,0)';
        }
        return 'rgba(0,0,0,0)';
    };

    // Define overlay fill function (supply layer)
    const overlayFill = overlayMode !== 'none' ? (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);

        if (overlayMode === 'access') {
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);
            if (!rel) return '#1e293b';
            if (!rel.hrea_covered) return '#1e293b'; // No Data

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access_pop') {
                const popNoAccess = (rel.total_pop_reliability || 0) * (rel.pct_no_access || 0);
                if (popNoAccess <= 0) return '#111827';
                return noAccessPopScale(Math.max(1, popNoAccess));
            } else if (currentAccessMetric === 'no_access') {
                const pct = rel.pct_no_access || 0;
                if (pct <= 0) return 'rgba(0,0,0,0)'; // Hide if everyone has access
                val = (1 - pct) * 100;
            } else {
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low -> Grey high) to match scrollytelling uptime map
            return reliabilityColorScale(val);
        } else if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            return getColor(cfRow.annual_cf);
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            return getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
        }
        return null; // null means no overlay color for this cell
    } : null;

    // Use dual-layer rendering to show both demand and supply with transparency
    renderVoronoiDual(voronoiPoints, popData, baseFill, overlayFill);
}

export function updateSupplyMap({ overlayMode = 'none', cfData = [], lcoeData = [], lcoeColorInfo = null, potentialState = null } = {}) {
    if (!supplyMap || !supplyVoronoiLayer) return;
    lastSupplyState = { overlayMode, cfData, lcoeData, lcoeColorInfo, potentialState };

    if (supplyMarkersLayer) supplyMarkersLayer.clearLayers();
    if (supplyOverlayLayer) supplyOverlayLayer.clearLayers();
    d3.select(supplyVoronoiLayer._container).selectAll("*").remove();

    if (overlayMode === 'none') {
        supplyDataByCoord = new Map();
        supplyVoronoiIndex = new Map();
        activeSupplyHoverKey = null;
        if (supplyPopup) {
            supplyMap.closePopup(supplyPopup);
        }
        return;
    }

    const data = overlayMode === 'cf'
        ? cfData
        : overlayMode === 'lcoe'
            ? lcoeData
            : overlayMode === 'potential'
                ? (potentialState?.data || [])
                : [];
    if (!data || data.length === 0) return;

    supplyDataByCoord = new Map(data.map(d => [roundedKey(d.latitude, d.longitude), d]));

    const potentialKey = potentialState?.level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    const potentialFallbackKey = potentialState?.level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const potentialIsMultiple = potentialState?.displayMode === 'multiple';
    const potentialIsPerCapita = potentialState?.displayMode === 'per_capita';
    const potentialNoDataColor = '#6b7280';
    const potentialScale = overlayMode === 'potential' && potentialState && potentialState.valueCount
        ? (potentialIsMultiple
            ? (val) => bucketColor(POTENTIAL_MULTIPLE_BUCKETS, val)
            : potentialIsPerCapita
                ? (val) => bucketColor(POTENTIAL_PER_CAPITA_BUCKETS, val)
                : d3.scaleSequential(d3.interpolateRgbBasis(POTENTIAL_TOTAL_COLORS))
                    .domain([potentialState.min, potentialState.max])
                    .clamp(true))
        : null;

    const colorScale = overlayMode === 'lcoe' && lcoeColorInfo
        ? buildLcoeColorScaleFromInfo(lcoeColorInfo)
        : null;

    const getFill = (row) => {
        if (overlayMode === 'cf') {
            return getColor(row.annual_cf);
        }
        if (overlayMode === 'lcoe' && lcoeColorInfo && colorScale) {
            return getLcoeColor(row, lcoeColorInfo, colorScale);
        }
        if (overlayMode === 'potential' && potentialState && potentialScale) {
            const rawTotal = Number(row[potentialKey]);
            const totalVal = Number.isFinite(rawTotal) ? rawTotal : Number(row[potentialFallbackKey] || 0);
            const latVal = Number(row.latitude);
            const bounds = potentialState.latBounds;
            if (bounds && (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max)) {
                return potentialNoDataColor;
            }
            let value = totalVal;
            if (potentialIsMultiple) {
                const demandRow = potentialState.demandMap ? potentialState.demandMap.get(row.location_id) : null;
                const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
                const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
                if (demandTwh <= 0) return potentialNoDataColor;
                value = totalVal / demandTwh;
            } else if (potentialIsPerCapita) {
                const pop = potentialState.populationMap ? Number(potentialState.populationMap.get(row.location_id) || 0) : 0;
                if (!(pop > 0)) return potentialNoDataColor;
                value = (totalVal * 1e6) / pop;
            }
            return potentialScale(value || 0);
        }
        return 'rgba(0,0,0,0)';
    };

    ensureSupplyPopup();

    let lastSupplyHoverRow = null;

    const onHover = (e, d) => {
        const content = buildSupplyTooltipHtml(d, overlayMode, potentialState);
        if (content && supplyPopup) {
            supplyPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(supplyMap);
        }
        lastSupplyHoverRow = d;
        syncHoverToDemand(d);
    };

    const onOut = () => {
        if (supplyPopup) {
            supplyMap.closePopup(supplyPopup);
        }
        if (lastSupplyHoverRow) {
            syncOutToDemand(lastSupplyHoverRow);
            lastSupplyHoverRow = null;
        }
    };

    const mapPoints = data.map(d => {
        const point = supplyMap.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    renderVoronoi(
        mapPoints,
        data,
        (row) => getFill(row),
        {
            enableHoverSelect: true,
            useMarkerEvents: false,
            onHover,
            onOut,
            context: { map: supplyMap, voronoiLayer: supplyVoronoiLayer }
        }
    );
}

function renderVoronoiDual(mapPoints, data, baseFill, overlayFill, options = {}) {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (mapPoints.length <= 1) return;

    demandVoronoiIndex = new Map();

    const hasBase = typeof baseFill === 'function';
    const hasOverlay = typeof overlayFill === 'function';
    if (!hasBase && !hasOverlay) return;

    let path = null;
    const clipId = map._leaflet_id ? `clip-land-${map._leaflet_id}` : 'clip-land-main';
    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        path = d3.geoPath().projection(transform);

        svg.select("defs").remove();
        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", clipId)
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const clip = worldGeoJSON ? `url(#${clipId})` : null;
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const delaunay = d3.Delaunay.from(mapPoints);
    const voronoi = delaunay.voronoi(bounds);

    // When both layers are present, use lower opacity so overlap is visible
    const baseOpacity = hasOverlay ? 0.5 : 0.85;
    const overlayOpacity = hasBase ? 0.5 : 0.35;

    const handleOver = function (e, d) {
        applyHoverRim(this);
        fireMarkerEvent(d, 'mouseover');
        syncHoverToSupply(d);
        if (options.onHover) options.onHover(e, d);
    };

    const handleOut = function (e, d) {
        clearHoverRim(this);
        fireMarkerEvent(d, 'mouseout');
        syncOutToSupply(d);
        if (options.onOut) options.onOut(e, d);
    };

    const handleClick = function (e, d) {
        fireMarkerEvent(d, 'click');
        if (options.onClick) options.onClick(e, d);
    };

    if (hasBase) {
        const base = svg.append("g").attr("clip-path", clip);
        base
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => baseFill ? baseFill(d) : "#111827")
            .attr("fill-opacity", baseOpacity)
            .attr("stroke", "rgba(255,255,255,0.08)")
            .attr("stroke-width", 0.5)
            .attr("class", "transition-color voronoi-cell leaflet-interactive")
            .style("pointer-events", hasOverlay ? "none" : "all")
            .each(function (d) {
                if (hasOverlay) return;
                const key = getRowKey(d);
                if (key) demandVoronoiIndex.set(key, this);
            })
            .on("mouseover", function (e, d) {
                if (hasOverlay) return;
                handleOver.call(this, e, d);
            })
            .on("mouseout", function (e, d) {
                if (hasOverlay) return;
                handleOut.call(this, e, d);
            })
            .on("click", function (e, d) {
                if (hasOverlay) return;
                handleClick.call(this, e, d);
            });
    }

    if (hasOverlay) {
        svg
            .append("g")
            .attr("clip-path", clip)
            .selectAll("path")
            .data(data)
            .enter()
            .append("path")
            .attr("d", (_, i) => voronoi.renderCell(i))
            .attr("fill", d => overlayFill(d) || "rgba(0,0,0,0)")
            .attr("fill-opacity", overlayOpacity)
            .attr("stroke", "none")
            .attr("class", "transition-color voronoi-cell leaflet-interactive")
            .style("pointer-events", "all")
            .each(function (d) {
                const key = getRowKey(d);
                if (key) demandVoronoiIndex.set(key, this);
            })
            .on("mouseover", function (e, d) {
                handleOver.call(this, e, d);
            })
            .on("mouseout", function (e, d) {
                handleOut.call(this, e, d);
            })
            .on("click", function (e, d) {
                handleClick.call(this, e, d);
            });
    }
}

export function updatePopulationGeo(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;
    resetLayersForMode('population');
    markersLayer.clearLayers();

    if (!popData || popData.length === 0 || !geojson) return;

    const popByCoord = new Map(popData.map(p => [roundedKey(p.latitude, p.longitude), p.population_2020 || 0]));
    const scale = buildPopulationScale(popData.map(p => p.population_2020 || 0));
    const cfByCoord = new Map(cfData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [roundedKey(d.latitude, d.longitude), d]));
    const lcoeScale = overlayMode === 'lcoe' && lcoeDomain ? buildLcoeScale(lcoeDomain) : null;

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    const layer = L.geoJSON(geojson, {
        style: (feature) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            const color = scale(popVal);
            return {
                color: color,
                weight: 0.3,
                fillColor: color,
                fillOpacity: 0.85
            };
        },
        onEachFeature: (feature, lyr) => {
            const props = feature.properties || {};
            const lat = Number(props.latitude);
            const lon = Number(props.longitude);
            const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
            const popVal = key ? popByCoord.get(key) || 0 : 0;
            lyr.on('mouseover', (e) => {
                const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Population: ${formatNumber(popVal, 0)}</div>
                    ${buildCountryLineFor(props)}
                 </div>`;
                sharedPopup.setLatLng(e.latlng).setContent(content).openOn(map);
            });
            lyr.on('mouseout', () => map.closePopup());
            lyr.on('click', () => {
                const center = lyr.getBounds().getCenter();
                const clickLat = Number.isFinite(center?.lat) ? center.lat : lat;
                const clickLon = Number.isFinite(center?.lng) ? center.lng : lon;
                updateLocationPanel({
                    latitude: clickLat,
                    longitude: clickLon,
                    population_2020: popVal,
                    annual_cf: 0
                }, lyr.options.fillColor, 'population');
                if (map.onLocationSelect) {
                    map.onLocationSelect({ latitude: clickLat, longitude: clickLon, population_2020: popVal }, 'population');
                }
            });
        }
    });

    layer.addTo(markersLayer);

    // Overlay layer on top of population
    if (overlayMode === 'cf' || overlayMode === 'lcoe') {
        const overlay = L.geoJSON(geojson, {
            style: (feature) => {
                const props = feature.properties || {};
                const lat = Number(props.latitude);
                const lon = Number(props.longitude);
                const key = Number.isFinite(lat) && Number.isFinite(lon) ? roundedKey(lat, lon) : null;
                const cfRow = key ? cfByCoord.get(key) : null;
                const lcoeRow = key ? lcoeByCoord.get(key) : null;
                let color = 'rgba(0,0,0,0)';
                let hasData = false;
                if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
                    color = getColor(cfRow.annual_cf);
                    hasData = true;
                } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
                    color = lcoeScale(lcoeRow.lcoe);
                    hasData = true;
                }
                return {
                    color: hasData ? color : 'rgba(0,0,0,0)',
                    weight: 0,
                    fillColor: hasData ? color : 'rgba(0,0,0,0)',
                    fillOpacity: hasData ? 0.35 : 0
                };
            },
            interactive: false
        });
        overlay.addTo(overlayLayer);
    }
}

export function updatePotentialMap(potentialData, { level = 'level1', min = null, max = null, displayMode = 'total', demandMap = null, populationMap = null, latBounds = null } = {}) {
    currentMode = 'potential';
    selectedMarker = null;

    resetLayersForMode('potential');
    markersLayer.clearLayers();

    if (!potentialData || potentialData.length === 0) return;

    const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const readTotal = (row) => {
        const raw = Number(row[totalKey]);
        return Number.isFinite(raw) ? raw : Number(row[groundKey] || 0);
    };
    const isMultiple = displayMode === 'multiple';
    const isPerCapita = displayMode === 'per_capita';
    const values = potentialData.map(d => readTotal(d)).filter(v => Number.isFinite(v));
    const scaleMin = Number.isFinite(min) ? min : (values.length ? Math.min(...values) : 0);
    const scaleMax = Number.isFinite(max) ? max : (values.length ? Math.max(...values) : 1);
    const noDataColor = '#6b7280';

    const totalInterpolator = d3.interpolateRgbBasis(POTENTIAL_TOTAL_COLORS);
    const colorScale = isMultiple
        ? (val) => bucketColor(POTENTIAL_MULTIPLE_BUCKETS, val)
        : isPerCapita
            ? (val) => bucketColor(POTENTIAL_PER_CAPITA_BUCKETS, val)
            : d3.scaleSequential(totalInterpolator)
                .domain([scaleMin, scaleMax])
                .clamp(true);

    // Per-capita = annual solar generation potential (MWh) ÷ zone population.
    const perCapitaOf = (totalTwh, locationId) => {
        const pop = populationMap ? Number(populationMap.get(locationId) || 0) : 0;
        return pop > 0 ? { value: (totalTwh * 1e6) / pop, population: pop } : { value: null, population: pop };
    };

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    potentialData.forEach(d => {
        const total = readTotal(d);
        const ground = Number(d[groundKey] || 0);
        const rooftop = Number(d.rooftop_twh_y || 0);
        const lat = Number(d.latitude);
        let ratio = null;
        let demandTwh = null;
        let perCapita = null;
        let population = null;
        const noData = latBounds
            ? (!Number.isFinite(lat) || lat < latBounds.min || lat > latBounds.max)
            : false;
        let noDemand = false;
        let noPopulation = false;
        if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(d.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            ratio = demandTwh > 0 ? total / demandTwh : null;
            noDemand = demandTwh <= 0;
        } else if (isPerCapita) {
            const pc = perCapitaOf(total, d.location_id);
            perCapita = pc.value;
            population = pc.population;
            noPopulation = pc.value === null;
        }
        const displayValue = isMultiple ? (ratio ?? 0) : isPerCapita ? (perCapita ?? 0) : total;
        const color = noData || (isMultiple && noDemand) || (isPerCapita && noPopulation)
            ? noDataColor
            : colorScale(displayValue || 0);

        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 6,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let mainLine = '';
            let demandLine = '';
            if (noData) {
                mainLine = 'No data available';
            } else if (isMultiple && noDemand) {
                mainLine = 'No demand data available';
            } else if (isPerCapita && noPopulation) {
                mainLine = 'No population data available';
            } else if (isMultiple) {
                mainLine = `Solar Potential / Demand: ${ratio !== null ? `${formatNumber(ratio, 2)}×` : '--'}`;
                demandLine = `<div class="text-muted">Demand: ${demandTwh ? `${formatNumber(demandTwh, 2)} TWh/yr` : '0 TWh/yr'}</div>`;
            } else if (isPerCapita) {
                mainLine = `Solar Potential per Capita: ${perCapita !== null ? `${formatNumber(perCapita, 0)} MWh/person/yr` : '--'}`;
                demandLine = `<div class="text-muted">Population: ${population ? formatNumber(population, 0) : '0'}</div>`;
            } else {
                mainLine = `Solar Generation Potential: ${formatNumber(total, 2)} TWh/yr`;
            }
            const showBreakdown = !noData && (rooftop > 0 || ground > 0);
            const breakdownLine = showBreakdown
                ? `<div class="text-muted">Ground-mount: ${formatNumber(ground, 2)} TWh/yr • Rooftop: ${formatNumber(rooftop, 2)} TWh/yr</div>`
                : '';
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${mainLine}</div>
                ${demandLine}
                ${breakdownLine}
                <div class="text-muted">${getPotentialLevelLabel(level)} • 40 MW/km² ground, 100 MW/km² rooftop</div>
                ${buildCountryLineFor(d)}
            </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            updateLocationPanel({
                ...d,
                potential_twh: total,
                potential_ratio: ratio,
                demand_twh: demandTwh,
                potential_level: level,
                potential_display: displayMode,
                potential_per_capita: perCapita,
                population,
                potential_no_data: noData,
                potential_no_demand: noDemand,
                potential_no_population: noPopulation
            }, color, 'potential');

            if (map.onLocationSelect) {
                map.onLocationSelect({
                    ...d,
                    potential_twh: total,
                    potential_ratio: ratio,
                    demand_twh: demandTwh,
                    potential_level: level,
                    potential_display: displayMode,
                    potential_per_capita: perCapita,
                    population,
                    potential_no_data: noData,
                    potential_no_demand: noDemand,
                    potential_no_population: noPopulation
                }, 'potential');
            }
        });

        d.__hitMarker = marker;
        marker.addTo(markersLayer);
    });

    const mapPoints = potentialData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    renderVoronoi(mapPoints, potentialData, (row) => {
        const totalVal = readTotal(row);
        const latVal = Number(row.latitude);
        if (latBounds && (!Number.isFinite(latVal) || latVal < latBounds.min || latVal > latBounds.max)) {
            return noDataColor;
        }
        let value = totalVal;
        if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(row.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            if (demandTwh <= 0) return noDataColor;
            value = totalVal / demandTwh;
        } else if (isPerCapita) {
            const pc = perCapitaOf(totalVal, row.location_id);
            if (pc.value === null) return noDataColor;
            value = pc.value;
        }
        return colorScale(value || 0);
    });
}

export function updateLcoeMap(bestData, options = {}) {
    currentMode = 'lcoe';
    lastLcoeData = bestData;
    lastLcoeOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe');
    markersLayer.clearLayers();

    if (!bestData || bestData.length === 0) {
        return;
    }

    const targetCf = options.targetCf || null;
    const colorInfo = options.colorInfo || { type: 'lcoe', domain: null };
    const reference = options.reference || null;
    const metricMode = options.comparisonMetric || 'lcoe';

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    bestData.forEach(d => {
        let color = '#611010'; // default for missing/non-target cells (deep red)
        if (d.meetsTarget) {
            color = getLcoeColor(d, colorInfo, colorScale);
        }

        // Hit marker
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let infoLines = '';
            if (d.meetsTarget) {
                if (reference) {
                    const deltaLine = Number.isFinite(d.delta)
                        ? `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`
                        : '';
                    const txMetrics = d.txMetrics;
                    const breakevenGw = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGw / 1000)}/MW` : '--';
                    const breakevenGwKm = txMetrics ? `${formatCurrency(txMetrics.breakevenPerGwKm / 1000)}/MW/km` : '--';

                    const distanceLine = txMetrics && Number.isFinite(txMetrics.distanceKm)
                        ? `<div>Approx. straight-line distance: ${formatNumber(txMetrics.distanceKm, 0)} km</div>`
                        : `<div>Approx. straight-line distance: --</div>`;

                    // Cleaned up info lines: Removed redundant savings line, ensures prompt TX cost display
                    infoLines = `${deltaLine}
<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>
${distanceLine}`;
                } else if (Number.isFinite(d.delta)) {
                    infoLines = `<div>Cost delta vs reference: ${d.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(d.delta), 2)}/MWh</div>`;
                }
            } else {
                if (d.includeDieselBackup) {
                    infoLines = `<div class="text-amber-300">Target solar + battery CF not met; showing the highest-solar-share firm configuration.</div>`;
                } else {
                    const maxText = Number.isFinite(d.maxConfigLcoe) ? `>${formatCurrency(d.maxConfigLcoe)}/MWh` : '--';
                    infoLines = `<div class="text-amber-300">Target CF for 1&nbsp;MW baseload not met in this dataset.</div>
                        <div>Highest config (${d.maxConfigSolar ?? '--'} MW_DC, ${d.maxConfigBatt ?? '--'} MWh): ${maxText}</div>`;
                }
            }
            const valueLine = d.meetsTarget || d.includeDieselBackup
                ? `LCOE: ${Number.isFinite(d.lcoe) ? formatCurrency(d.lcoe) : '--'}/MWh`
                : `LCOE: ${Number.isFinite(d.maxConfigLcoe) ? `>${formatCurrency(d.maxConfigLcoe)}` : '--'}/MWh`;
            const dieselLines = buildDieselBackupLines(d, formatCurrency).join('');
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${valueLine}</div>
                <div>${buildLcoeConfigLine(d)}</div>
                ${dieselLines}
                ${infoLines}
                ${buildCountryLineFor(d)}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            updateLocationPanel({ ...d, targetCf, comparisonMetric: metricMode }, color, 'lcoe');

            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetCf }, 'lcoe');
            }
        });

        d.__hitMarker = marker;
        marker.addTo(markersLayer);
    });

    // Refresh location panel for reference so deltas stay current
    if (reference) {
        const refRow = bestData.find(r => r.location_id === reference.location_id);
        if (refRow) {
            const color = getLcoeColor(refRow, colorInfo, colorScale);
            updateLocationPanel({ ...refRow, targetCf, comparisonMetric: metricMode }, color, 'lcoe');
        }
    }

    const mapPoints = bestData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });
    renderVoronoi(
        mapPoints,
        bestData,
        (row) => getLcoeColor(row, colorInfo, colorScale)
    );
}

// Similar to updateLcoeMap but for CF display (Target LCOE mode)
export function updateCfMap(cfData, options = {}) {
    currentMode = 'lcoe_cf'; // Use distinct mode for Target Mode (CF Map)
    lastCfData = cfData;
    lastCfOptions = options;
    selectedMarker = null;
    resetLayersForMode('lcoe_cf');
    markersLayer.clearLayers();

    if (!cfData || cfData.length === 0) {
        return;
    }

    const targetLcoe = options.targetLcoe || null;
    const colorInfo = options.colorInfo || { type: 'cf', domain: [0, 0.5, 1] };
    const reference = options.reference || null;

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);

    const sharedPopup = L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });

    cfData.forEach(d => {
        // Use d.meetsTarget if present, otherwise default to true (legacy safe)
        const meetsTarget = d.meetsTarget !== false;
        const color = getLcoeColor({ ...d, lcoe: d.cf, meetsTarget }, colorInfo, colorScale);

        // Hit marker
        const marker = L.circleMarker([d.latitude, d.longitude], {
            radius: 4.5,
            fillColor: '#fff',
            color: '#fff',
            weight: 0,
            opacity: 0,
            fillOpacity: 0,
            pane: 'markers',
            renderer: markerRenderer
        });

        marker.on('mouseover', () => {
            let infoLines = '';
            const targetLcoeMet = d.targetLcoeMet !== false;
            if (targetLcoeMet) {
                if (reference && Number.isFinite(d.delta)) {
                    const deltaSign = d.delta >= 0 ? '+' : '';
                    infoLines = `<div>CF delta vs reference: ${deltaSign}${(d.delta * 100).toFixed(1)}%</div>`;
                }
            } else {
                infoLines = `<div class="text-amber-300">Target LCOE not met.</div>
                    <div>Lowest LCOE config:</div>`;
            }

            const dieselLines = buildDieselBackupLines(d, formatCurrency).join('');
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">CF: ${meetsTarget ? formatFirmCfText(d) : '--'}</div>
                <div>Solar ${d.solar_gw} MW_DC | Battery ${d.batt_gwh} MWh</div>
                <div>LCOE: ${formatCurrency(d.lcoe)}/MWh</div>
                ${dieselLines}
                ${infoLines}
                ${buildCountryLineFor(d)}
             </div>`;
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => {
            map.closePopup(sharedPopup);
        });

        marker.on('click', () => {
            updateLocationPanel({ ...d, targetLcoe, meetsTarget }, color, 'lcoe');

            if (map.onLocationSelect) {
                map.onLocationSelect({ ...d, targetLcoe, meetsTarget }, 'lcoe');
            }
        });

        d.__hitMarker = marker;
        marker.addTo(markersLayer);
    });

    // Refresh location panel for reference
    if (reference) {
        const refRow = cfData.find(r => r.location_id === reference.location_id);
        if (refRow) {
            const meetsTarget = refRow.meetsTarget !== false;
            const color = getLcoeColor({ ...refRow, lcoe: refRow.cf, meetsTarget }, colorInfo, colorScale);
            updateLocationPanel({ ...refRow, targetLcoe, meetsTarget }, color, 'lcoe');
        }
    }

    const mapPoints = cfData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    renderVoronoi(
        mapPoints,
        cfData,
        (row) => {
            const meetsTarget = row.meetsTarget !== false;
            return getLcoeColor({ ...row, lcoe: row.cf, meetsTarget }, colorInfo, colorScale);
        }
    );
}

function renderVoronoi(mapPoints, data, fillAccessor, options = {}) {
    const { enableHoverSelect = true, useMarkerEvents = true, context = null } = options;
    const perf = startMapPerf('render-voronoi', {
        mode: currentMode,
        points: mapPoints?.length || 0,
        reuse: FEATURE_VORONOI_REUSE
    });
    const hasClickHandler = typeof options.onClick === 'function';
    const allowPointerEvents = enableHoverSelect || hasClickHandler;
    const mapRef = context?.map || map;
    const voronoiLayerRef = context?.voronoiLayer || voronoiLayer;
    const svg = d3.select(voronoiLayerRef._container);
    if (!FEATURE_VORONOI_REUSE) {
        svg.selectAll('*').remove();
    }

    if (mapRef === supplyMap) {
        supplyVoronoiIndex = new Map();
    }

    // If only one point, just a circle
    if (mapPoints.length === 1) {
        // ... (simplified for now, or just skip)
        endMapPerf(perf, { rendered: 0, skipped: true });
        return;
    }

    const clipId = mapRef?._leaflet_id ? `clip-land-${mapRef._leaflet_id}` : 'clip-land-main';
    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = mapRef.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);
        const size = mapRef.getSize();
        const center = mapRef.getCenter();
        const clipVersion = `${size.x}x${size.y}|${mapRef.getZoom()}|${center.lat.toFixed(3)},${center.lng.toFixed(3)}`;
        const versionKey = mapRef?._leaflet_id || 'main';
        const shouldRefreshClip = !FEATURE_VORONOI_REUSE
            || voronoiClipVersionByMap.get(versionKey) !== clipVersion
            || svg.select(`#${clipId}`).empty();
        if (shouldRefreshClip) {
            let defs = svg.select('defs');
            if (defs.empty()) {
                defs = svg.append('defs');
            }
            let clipPath = defs.select(`#${clipId}`);
            if (clipPath.empty()) {
                clipPath = defs.append('clipPath').attr('id', clipId);
                clipPath.append('path');
            }
            clipPath.select('path')
                .datum(worldGeoJSON)
                .attr('d', path);
            voronoiClipVersionByMap.set(versionKey, clipVersion);
        }
    }

    let g = FEATURE_VORONOI_REUSE ? svg.select('g.voronoi-group') : d3.select(null);
    if (g.empty()) {
        g = svg.append('g');
    }
    g.attr('class', 'voronoi-group')
        .attr('clip-path', worldGeoJSON ? `url(#${clipId})` : null);
    g.style("pointer-events", allowPointerEvents ? "all" : "none");

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = mapRef.getSize();
    // Add buffer to cover the whole map view
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);
    const cellsData = data.map((row, i) => {
        const key = Number.isFinite(row.location_id)
            ? `id:${row.location_id}`
            : `coord:${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`;
        return {
            key,
            row,
            path: voronoi.renderCell(i)
        };
    });

    let paths = g.selectAll('path.voronoi-cell');
    paths = FEATURE_VORONOI_REUSE
        ? paths.data(cellsData, d => d.key)
        : paths.data(cellsData);
    paths.exit().remove();

    const enterPaths = paths.enter()
        .append('path')
        .attr('class', 'transition-color voronoi-cell leaflet-interactive');

    enterPaths.merge(paths)
        .attr('d', d => d.path)
        .attr('data-loc-id', d => d.row.location_id)
        .each(function (cell) {
            const d = cell.row;
            const el = d3.select(this);
            const style = fillAccessor ? fillAccessor(d) : null;
            if (style && typeof style === 'object') {
                el.attr("fill", style.fillColor || style.color)
                    .attr("fill-opacity", Number.isFinite(style.fillOpacity) ? style.fillOpacity : 0.6)
                    .attr("stroke", style.color || "rgba(255,255,255,0.08)")
                    .attr("stroke-width", Number.isFinite(style.weight) ? style.weight : 0.5);
            } else {
                el.attr("fill", style || getColor(d.annual_cf))
                    .attr("fill-opacity", 0.6)
                    .attr("stroke", "rgba(255,255,255,0.08)")
                    .attr("stroke-width", 0.5);
            }
            if (mapRef === supplyMap) {
                const key = getRowKey(d);
                if (key) supplyVoronoiIndex.set(key, this);
            }
        })
        .style("pointer-events", allowPointerEvents ? "all" : "none")
        .on("click", (e, cell) => {
            const d = cell.row || cell;
            if (useMarkerEvents) {
                fireMarkerEvent(d, 'click');
            }
            if (options.onClick) {
                options.onClick(d);
            }
        })
        .on("mouseover", function (e, cell) {
            const d = cell.row || cell;
            if (!enableHoverSelect) return;
            applyHoverRim(this);
            if (useMarkerEvents) {
                fireMarkerEvent(d, 'mouseover');
            }
            if (options.onHover) {
                options.onHover(e, d);
            }
        })
        .on("mouseout", function (e, cell) {
            const d = cell.row || cell;
            if (!enableHoverSelect) return;
            clearHoverRim(this);
            if (useMarkerEvents) {
                fireMarkerEvent(d, 'mouseout');
            }
            if (options.onOut) {
                options.onOut(e, d);
            }
        });

    endMapPerf(perf, { rendered: cellsData.length });
}

// ========== SAMPLE DAYS FUNCTIONS ==========

function getDominanceColor(source) {
    switch (source) {
        case 's': return '#facc15'; // yellow - solar
        case 'b': return '#a855f7'; // purple - battery
        default: return '#9ca3af';  // gray - other
    }
}

export function updateMapWithSampleFrame(frameData) {
    currentMode = 'samples';
    lastSampleFrame = frameData;
    if (!frameData || !frameData.locations) {
        console.warn('No frame data provided');
        return;
    }

    const { locations } = frameData;
    if (locations.length === 0) {
        return;
    }
    const modeChanged = resetLayersForMode('samples', { preserveVoronoi: true });
    if (modeChanged) {
        lastSampleVoronoiKey = null;
    }

    if (!samplePopup) {
        samplePopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    // Render Voronoi background
    if (locations.length > 0) {
        const viewKey = `${map.getZoom()}|${map.getCenter().lat.toFixed(4)},${map.getCenter().lng.toFixed(4)}|${map.getSize().x}x${map.getSize().y}`;
        const locationsKey = `${locations.length}|${locations[0]?.location_id ?? ''}|${locations[locations.length - 1]?.location_id ?? ''}`;
        const voronoiKey = `${viewKey}|${locationsKey}`;

        if (lastSampleVoronoiKey === voronoiKey && updateSampleVoronoiColors(locations)) {
            // Colors updated without rebuilding geometry.
        } else {
            const mapPoints = locations.map(loc => {
                const point = map.latLngToLayerPoint([loc.latitude, loc.longitude]);
                return [point.x, point.y];
            });
            renderSampleVoronoi(mapPoints, locations);
            lastSampleVoronoiKey = voronoiKey;
        }
    }
}

function renderSampleVoronoi(mapPoints, locations) {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (mapPoints.length === 1) {
        return;
    }

    if (worldGeoJSON) {
        const transform = d3.geoTransform({
            point: function (x, y) {
                const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                this.stream.point(point.x, point.y);
            },
        });
        const path = d3.geoPath().projection(transform);

        const defs = svg.append("defs");
        defs
            .append("clipPath")
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    // Pattern for "no data" (NA) cells — a faint diagonal hatch, visually distinct from the
    // solid grey "Backup" fill. Recreated on every full render (svg was cleared above) and
    // referenced via fill="url(#na-hatch)" so it survives fast colour-only updates too.
    const naDefs = svg.append("defs");
    const naPattern = naDefs.append("pattern")
        .attr("id", "na-hatch")
        .attr("patternUnits", "userSpaceOnUse")
        .attr("width", 6)
        .attr("height", 6)
        .attr("patternTransform", "rotate(45)");
    naPattern.append("rect")
        .attr("width", 6)
        .attr("height", 6)
        .attr("fill", "rgba(100,116,139,0.18)");
    naPattern.append("line")
        .attr("x1", 0).attr("y1", 0)
        .attr("x2", 0).attr("y2", 6)
        .attr("stroke", "rgba(148,163,184,0.7)")
        .attr("stroke-width", 1.5);

    const g = svg.append("g")
        .attr("class", "sample-voronoi")
        .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null);

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const voronoi = delaunay.voronoi(bounds);

    g.selectAll("path")
        .data(locations, d => d.location_id)
        .enter()
        .append("path")
        .attr("d", (_, i) => voronoi.renderCell(i))
        .attr("fill", d => d.color)
        .attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .attr("class", "transition-color voronoi-cell leaflet-interactive")
        .style("transition", "fill 0.9s ease")
        .style("pointer-events", "all")
        .on("mouseover", function (e, d) {
            applyHoverRim(this);
            if (!samplePopup) return;
            let content;
            if (d.isNA || !Number.isFinite(d.solarShare)) {
                content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">No data</div>
                    <div class="text-[11px] text-muted">No dispatch data for this point at this hour.</div>
                </div>`;
            } else {
                const solar = Number.isFinite(d.solarShare) ? (d.solarShare * 100).toFixed(1) : '--';
                const battery = Number.isFinite(d.batteryShare) ? (d.batteryShare * 100).toFixed(1) : '--';
                const other = Number.isFinite(d.otherShare) ? (d.otherShare * 100).toFixed(1) : '--';
                content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Generation mix</div>
                    <div class="text-[11px] text-muted">Solar: ${solar}%</div>
                    <div class="text-[11px] text-muted">Battery: ${battery}%</div>
                    <div class="text-[11px] text-muted">Other: ${other}%</div>
                </div>`;
            }
            samplePopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
        })
        .on("mouseout", function () {
            clearHoverRim(this);
            if (samplePopup) {
                map.closePopup(samplePopup);
            }
        })
        .on("click", function (e, d) {
            if (sampleLocationHandler) {
                sampleLocationHandler({
                    location_id: d.location_id,
                    latitude: d.latitude,
                    longitude: d.longitude,
                    solarShare: d.solarShare ?? 0,
                    batteryShare: d.batteryShare ?? 0,
                    otherShare: d.otherShare ?? 0
                });
            }
        });
}

function updateSampleVoronoiColors(locations) {
    const svg = d3.select(voronoiLayer._container);
    const group = svg.select(".sample-voronoi");
    if (group.empty()) return false;
    group.selectAll("path")
        .data(locations, d => d.location_id)
        .attr("fill", d => d.color);
    return true;
}

export function setSampleLocationClickHandler(handler) {
    sampleLocationHandler = handler;
}
// ========== SUBSET MAP FUNCTIONS ==========

export let subsetMap;
let subsetVoronoiLayer;

export async function initSubsetMap() {
    if (subsetMap) {
        setTimeout(() => subsetMap.invalidateSize(), 100);
        return;
    }

    const container = document.getElementById('subset-map');
    if (!container) return;

    subsetMap = L.map('subset-map', {
        zoomControl: false,
        attributionControl: false,
        zoomAnimation: false,  // Disable zoom animation to prevent SVG scale mismatch
        fadeAnimation: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        boxZoom: false,
        keyboard: false
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(subsetMap);

    subsetMap.createPane('voronoi');
    subsetMap.getPane('voronoi').style.zIndex = 400;

    subsetVoronoiLayer = L.svg({ pane: 'voronoi' }).addTo(subsetMap);
}

export function renderSubsetMap(allData, subsetIds, getValue, getColor, layerType = 'population', getRadius = null, getTooltip = null, onPointHover = null, onPointOut = null) {
    if (!subsetMap || !subsetVoronoiLayer) return;

    // Clear existing
    const svg = d3.select(subsetVoronoiLayer._container);
    svg.selectAll("*").remove();

    if (!allData || allData.length === 0) return;

    // Common setup
    const size = subsetMap.getSize();
    const subsetSet = new Set(subsetIds);

    const draw = () => {
        try {
            // Clear ALL SVG contents to prevent stale elements on zoom/pan
            svg.selectAll("*").remove();

            const size = subsetMap.getSize(); // update size in draw
            if (size.x === 0 || size.y === 0) {
                console.warn('[SubsetMap] Skipping draw - size is zero');
                return;
            }

            // Check if we have data to render
            if (!allData || allData.length === 0) {
                console.warn('[SubsetMap] Skipping draw - no data');
                return;
            }

            // Render Voronoi (Clipped)

            // 1. Setup Clip Path
            const transform = d3.geoTransform({
                point: function (x, y) {
                    const point = subsetMap.latLngToLayerPoint(new L.LatLng(y, x));
                    this.stream.point(point.x, point.y);
                },
            });
            const path = d3.geoPath().projection(transform);

            if (worldGeoJSON) {
                const defs = svg.append("defs");
                defs.append("clipPath")
                    .attr("id", "clip-land-subset")
                    .append("path")
                    .datum(worldGeoJSON)
                    .attr("d", path);
            }

            const buffer = Math.max(size.x, size.y);
            const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];

            const points = allData.map(d => {
                const p = subsetMap.latLngToLayerPoint([d.latitude, d.longitude]);
                return [p.x, p.y];
            });

            const delaunay = d3.Delaunay.from(points);
            const voronoi = delaunay.voronoi(bounds);

            // Pre-filter data indices for the subset
            const pathsData = [];
            allData.forEach((d, i) => {
                if (subsetSet.has(d.location_id)) {
                    pathsData.push({ d, i });
                }
            });

            // 2. Render paths with clip-path
            const paths = svg.append("g")
                .attr("clip-path", worldGeoJSON ? "url(#clip-land-subset)" : null)
                .selectAll("path")
                .data(pathsData)
                .enter()
                .append("path")
                .attr("d", p => voronoi.renderCell(p.i))
                .attr("fill", p => getColor(getValue(p.d)))
                .attr("fill-opacity", 0.9)
                .attr("stroke", "rgba(255,255,255,0.08)")
                .attr("stroke-width", 0.5)
                .attr("class", "transition-color voronoi-cell leaflet-interactive")
                .style("pointer-events", "all");

            if (onPointHover || onPointOut) {
                paths
                    .on("mouseover", function (e, p) {
                        applyHoverRim(this);
                        if (onPointHover) onPointHover(e, p.d);
                    })
                    .on("mouseout", function (e, p) {
                        clearHoverRim(this);
                        if (onPointOut) onPointOut(e, p.d);
                    });
            } else {
                paths.append("title")
                    .text(p => {
                        const val = getValue(p.d);
                        return getTooltip ? getTooltip(p.d) : `Value: ${formatNumber(val, 2)}`;
                    });
            }
        } catch (e) {
            console.error('[SubsetMap] Error in draw:', e);
        }
    };

    draw();

    // update on move/resize/zoom - need all these for proper SVG sync
    subsetMap.off('moveend');
    subsetMap.off('resize');
    subsetMap.off('zoomend');
    subsetMap.off('viewreset');
    subsetMap.off('zoom');

    subsetMap.on('moveend', draw);
    subsetMap.on('resize', draw);
    subsetMap.on('zoomend', draw);
    subsetMap.on('viewreset', draw);
    subsetMap.on('zoom', draw);
}
