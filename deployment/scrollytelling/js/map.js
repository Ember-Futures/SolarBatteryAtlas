import { capitalizeWord, formatNumber, formatCurrency, coordKey, roundedKey, capitalRecoveryFactor as crf } from './utils.js';
import {
    CF_COLOR_SCALE,
    FUEL_COLORS,
    ALL_FUELS,
    LCOE_NO_DATA_COLOR,
    ACCESS_COLOR_SCALE,
    POPULATION_COLOR_SCALE,
    POTENTIAL_MULTIPLE_BUCKETS,
    POTENTIAL_PER_CAPITA_BUCKETS,
    POTENTIAL_TOTAL_COLORS,
    FEATURE_VORONOI_REUSE
} from './constants.js';
import { createSharedPopup, buildTooltipHtml, buildCfTooltip, buildPlantTooltip, formatFirmCfText, buildDieselBackupLines, buildCountryLine } from './tooltip.js';

// Per-cell country overlap list (location_id -> ordered string[]), populated from
// scrolly.js once the overlapping-countries CSV loads. Lets every map tooltip show
// the country (or countries, for border-straddling cells) the hovered cell covers.
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
// CF/Solar/Battery summary line; firm-CF aware (shows "X% (Y% from solar)" when backup is on).
function buildLcoeConfigLine(data) {
    return `<div>CF ${formatFirmCfText(data)} | Solar ${data.solar_gw} MW_DC | Battery ${data.batt_gwh} MWh</div>`;
}

export let map;
let markersLayer;
let overlayLayer;
let voronoiLayer;
let selectedMarker = null;
let sampleInfoById = new Map();
let currentMode = 'capacity';
let sampleLocationHandler = null;
let samplePopup = null;
let populationOverlay = false;
let populationData = null;
let populationScale = null;
let lcoePlantPopup = null;
const ALL_FOSSIL_FUELS = ALL_FUELS;
const FOSSIL_COLORS = FUEL_COLORS;

let currentAccessMetric = 'reliability'; // 'reliability' or 'no_access'
let lastReliabilityByCoord = null;

export function setAccessMetric(metric) {
    currentAccessMetric = metric;
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
    return d3.scaleLinear()
        .domain(POPULATION_COLOR_SCALE.domain)
        .range(POPULATION_COLOR_SCALE.range)
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
        return Number.isFinite(row.delta) ? colorScale(row.delta) : '#611010';
    }
    if (colorInfo.type === 'tx') {
        const val = row.txMetrics ? row.txMetrics.breakevenPerGwKm : 0;
        return val > 0 ? colorScale(val) : '#611010';
    }
    // colorInfo.metric lets a caller colour by a field other than the full LCOE
    // (e.g. the back-up-only cost on step 7) while leaving row.lcoe for tooltips.
    const value = colorInfo.metric ? row[colorInfo.metric] : row.lcoe;
    return Number.isFinite(value) ? colorScale(value) : '#611010';
}

let worldGeoJSON = null;
let voronoiClipVersion = null;

export async function initMap(onLocationSelect) {
    map = L.map('map', {
        zoomControl: false,
        attributionControl: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        touchZoom: false,
        keyboard: false
    }).setView([20, 0], 2); // World view

    // Dark Matter basemap (no labels)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png', {
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
        subdomains: 'abcd',
        maxZoom: 19
    }).addTo(map);

    // L.control.zoom({ position: 'topright' }).addTo(map);

    map.createPane('markers');
    map.getPane('markers').style.zIndex = 600;

    markersLayer = L.layerGroup().addTo(map);
    overlayLayer = L.layerGroup().addTo(map);
    voronoiLayer = L.svg().addTo(map);

    // Re-render Voronoi on move
    map.on('moveend', () => {
        if (currentMode === 'capacity' && lastData && lastSolar !== null && lastBatt !== null) {
            updateMap(lastData, lastSolar, lastBatt, lastMapOptions);
        } else if (currentMode === 'lcoe' && lastLcoeData) {
            updateLcoeMap(lastLcoeData, lastLcoeOptions || {});
        } else if (currentMode === 'potential' && lastPotentialData) {
            updatePotentialMap(lastPotentialData, lastPotentialOptions || {});
        } else if (currentMode === 'lcoe_cf' && lastCfData) {
            updateCfMap(lastCfData, lastCfOptions || {});
        } else if (currentMode === 'samples' && lastSampleFrame) {
            updateMapWithSampleFrame(lastSampleFrame);
        }
    });

    // Store callback
    map.onLocationSelect = onLocationSelect;

    const worldGeoJsonSources = [
        '../data/world.geojson',
        'https://raw.githubusercontent.com/holtzy/D3-graph-gallery/master/DATA/world.geojson'
    ];
    for (const source of worldGeoJsonSources) {
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
}

let lastData = null;
let lastSolar = null;
let lastBatt = null;
let lastMapOptions = {};
let lastLcoeData = null;
let lastLcoeOptions = null;
let lastCfData = null; // Data for Target Mode (CF Map)
let lastCfOptions = null; // Options for Target Mode (CF Map)
let lastSampleFrame = null;
let lastPopulationData = null;
let lastPotentialData = null;
let lastPotentialOptions = null;

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
        const targetText = data.targetCf ? `target ${(data.targetCf * 100).toFixed(0)}% CF for 1 MW baseload` : 'target CF for 1 MW baseload';
        const deltaText = Number.isFinite(data.delta)
            ? ` (Δ ${data.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(data.delta), 1)}/MWh vs reference)`
            : '';
        if (data.meetsTarget) {
            valueEl.textContent = data.lcoe ? `${formatCurrency(data.lcoe)}/MWh` : '--';
            labelEl.textContent = `Best LCOE meeting ${targetText}${deltaText}`;
        } else {
            valueEl.textContent = 'No data available';
            labelEl.textContent = 'No solar + battery result for this location in our dataset';
        }
        if (data.meetsTarget) {
            configEl.classList.remove('hidden');
            if (configTextEl) {
                configTextEl.textContent = `Solar ${data.solar_gw} MW_DC • Battery ${data.batt_gwh} MWh serving 1 MW baseload.`;
            }
        } else {
            configEl.classList.add('hidden');
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
    } else if (mode === 'population') {
        const popVal = data.population_2020 || 0;
        valueEl.textContent = formatNumber(popVal, 0);
        labelEl.textContent = 'Population (total in this cell)';
        configEl.classList.add('hidden');
        if (txInfoEl) txInfoEl.classList.add('hidden');
    }

    panel.classList.remove('hidden');
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

export function updateMap(data, solarGw, battGwh, options = {}) {
    currentMode = 'capacity';
    lastData = data;
    lastSolar = solarGw;
    lastBatt = battGwh;
    lastMapOptions = options;
    lastLcoeData = null;
    lastLcoeOptions = null;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    const enableTooltip = options.enableTooltip !== false;
    const overrideColor = options.colorOverride || null;
    const fillOpacity = Number.isFinite(options.fillOpacity) ? options.fillOpacity : 0.6;
    const strokeColor = options.stroke || "rgba(255,255,255,0.08)";
    const strokeWidth = Number.isFinite(options.strokeWidth) ? options.strokeWidth : 0.5;

    // Allow callers to pass a pre-filtered config slice to avoid hot-path full scans.
    const filtered = options.preFiltered === true
        ? data
        : data.filter(d => d.solar_gw === solarGw && d.batt_gwh === battGwh);

    if (filtered.length === 0) {
        const avgEl = document.getElementById('stat-avg-cf');
        const maxEl = document.getElementById('stat-max-cf');
        if (avgEl) avgEl.textContent = '--%';
        if (maxEl) maxEl.textContent = '--%';
        return;
    }
    const cfs = filtered.map(d => d.annual_cf);
    const avg = cfs.reduce((a, b) => a + b, 0) / cfs.length;
    const max = Math.max(...cfs);

    // Update stats in UI (with null checks for scrollytelling context)
    const avgCfEl = document.getElementById('stat-avg-cf');
    const maxCfEl = document.getElementById('stat-max-cf');
    if (avgCfEl) avgCfEl.textContent = (avg * 100).toFixed(1) + '%';
    if (maxCfEl) maxCfEl.textContent = (max * 100).toFixed(1) + '%';

    const sharedPopup = createSharedPopup();

    // Render Voronoi
    if (filtered.length > 0) {
        const mapPoints = filtered.map(d => {
            const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
            return [point.x, point.y];
        });
        const fillAccessor = (row) => {
            const baseColor = overrideColor || getColor(row.annual_cf);
            if (overrideColor || options.stroke || options.strokeWidth || options.fillOpacity) {
                return {
                    fillColor: baseColor,
                    fillOpacity: fillOpacity,
                    color: strokeColor,
                    weight: strokeWidth
                };
            }
            return baseColor;
        };
        const resolveColor = (row) => {
            const style = fillAccessor(row);
            return (style && typeof style === 'object')
                ? (style.fillColor || style.color || '#ffffff')
                : (style || '#ffffff');
        };
        const handleHover = (e, d) => {
            if (!enableTooltip) return;
            const content = buildCfTooltip(d.annual_cf, lastSolar, lastBatt);
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
        };
        const handleOut = () => {
            if (!enableTooltip) return;
            map.closePopup(sharedPopup);
        };
        const handleClick = (e, d) => {
            updateLocationPanel(d, resolveColor(d), 'capacity');
            if (map.onLocationSelect) {
                map.onLocationSelect(d, 'capacity');
            }
        };
        renderVoronoi(mapPoints, filtered, fillAccessor, {
            ...options,
            enableHoverSelect: true,
            onHover: handleHover,
            onOut: handleOut,
            onClick: handleClick
        });
    }
}

function getPotentialLevelLabel(level) {
    return level === 'level2' ? 'Policy constraints' : 'Technical constraints';
}

export function updatePotentialMap(potentialData, { level = 'level1', displayMode = 'multiple', demandMap = null, populationMap = null, latBounds = null } = {}) {
    currentMode = 'potential';
    lastPotentialData = potentialData;
    lastPotentialOptions = { level, displayMode, demandMap, populationMap, latBounds };
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    if (!potentialData || potentialData.length === 0) return;

    const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    // All modes use total potential (ground-mount + rooftop), matching the main tool
    // and the article's total-based "×demand" figures. Falls back to ground-only if a
    // total field is missing.
    const readTotal = (row) => {
        const raw = Number(row[totalKey]);
        return Number.isFinite(raw) ? raw : Number(row[groundKey] || 0);
    };
    const isMultiple = displayMode === 'multiple';
    const isPerCapita = displayMode === 'per_capita';
    const noDataColor = '#6b7280';

    const bucketColor = (buckets, val) => {
        const value = Number.isFinite(val) ? val : 0;
        for (const bucket of buckets) {
            if (bucket.max === null || value < bucket.max) return bucket.color;
        }
        return buckets[buckets.length - 1].color;
    };

    const totalInterpolator = d3.interpolateRgbBasis(POTENTIAL_TOTAL_COLORS);
    const totalValues = potentialData.map(d => readTotal(d)).filter(v => Number.isFinite(v));
    const scaleMin = totalValues.length ? Math.min(...totalValues) : 0;
    const scaleMax = totalValues.length ? Math.max(...totalValues) : 1;
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

    const sharedPopup = createSharedPopup();

    const mapPoints = potentialData.map(d => {
        const point = map.latLngToLayerPoint([d.latitude, d.longitude]);
        return [point.x, point.y];
    });

    const buildPotentialTooltip = (row) => {
        const total = readTotal(row);
        const lat = Number(row.latitude);
        const noData = latBounds
            ? (!Number.isFinite(lat) || lat < latBounds.min || lat > latBounds.max)
            : false;
        let mainLine = '';
        let extraLine = '';
        if (noData) {
            mainLine = 'No data available';
        } else if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(row.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            if (demandTwh <= 0) {
                mainLine = 'No demand data available';
            } else {
                const ratio = total / demandTwh;
                mainLine = `Solar Potential / Demand: ${formatNumber(ratio, 2)}×`;
                extraLine = `<div class="text-muted">Demand: ${formatNumber(demandTwh, 2)} TWh/yr</div>`;
            }
        } else if (isPerCapita) {
            const pc = perCapitaOf(total, row.location_id);
            if (pc.value === null) {
                mainLine = 'No population data available';
            } else {
                mainLine = `Solar Potential per Capita: ${formatNumber(pc.value, 0)} MWh/person/yr`;
                extraLine = `<div class="text-muted">Population: ${formatNumber(pc.population, 0)}</div>`;
            }
        } else {
            mainLine = `Solar Generation Potential: ${formatNumber(total, 2)} TWh/yr`;
        }
        return buildTooltipHtml(
            mainLine,
            [
                extraLine,
                `<div class="text-muted">${getPotentialLevelLabel(level)} • Assumed ${formatNumber(row.assumed_mw_per_km2, 0)} MW/km²</div>`
            ]
        );
    };

    renderVoronoi(mapPoints, potentialData, (row) => {
        const latVal = Number(row.latitude);
        if (latBounds && (!Number.isFinite(latVal) || latVal < latBounds.min || latVal > latBounds.max)) {
            return noDataColor;
        }
        if (isMultiple) {
            const demandRow = demandMap ? demandMap.get(row.location_id) : null;
            const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
            const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
            if (demandTwh <= 0) return noDataColor;
            return colorScale(readTotal(row) / demandTwh);
        }
        if (isPerCapita) {
            const pc = perCapitaOf(readTotal(row), row.location_id);
            if (pc.value === null) return noDataColor;
            return colorScale(pc.value);
        }
        return colorScale(readTotal(row) || 0);
    }, {
        enableHoverSelect: true,
        onHover: (e, row) => {
            const content = buildPotentialTooltip(row);
            sharedPopup.setLatLng([row.latitude, row.longitude]).setContent(appendCountryLine(content, row)).openOn(map);
        },
        onOut: () => {
            map.closePopup(sharedPopup);
        }
    });
}
export function updatePopulationPolygons(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

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
                 </div>`;
                const sharedPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });
                sharedPopup.setLatLng(e.latlng).setContent(appendCountryLine(content, popRow)).openOn(map);
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

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    if (!popData || popData.length === 0) return;

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
    const demandMap = electricityDemandMap instanceof Map ? electricityDemandMap : null;

    const formatCapacityLines = (cap) => {
        if (!cap || !selectedFuelSet.size) {
            return baseLayer === 'plants' ? '<div class="mt-1 text-muted">No installed capacity for the selected fuels.</div>' : '';
        }
        const lines = [];
        selectedFuelSet.forEach(fuel => {
            const value = Number(cap[`${fuel}_mw`] || 0);
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
    lastReliabilityByCoord = reliabilityByCoord;

    const sharedPopup = createSharedPopup();

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
                pane: 'markers'
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

    // Define base layer fill function (demand layer)
    const baseFill = (d) => {
        if (baseLayer === 'access') {
            // Use coordinate-based lookup with 2 decimals to match source data
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            // Determine value based on metric
            if (currentAccessMetric === 'no_access_pop') {
                // Section 5 colours by the SHARE of population without electricity (0–100%),
                // not the headcount: 0% (universal access / no data) -> dark, 100% -> bright red.
                const covered = rel && rel.hrea_covered;
                const pct = covered ? (rel.pct_no_access || 0) : 0; // fraction without access (0..1)

                // Heatmap: dark slate -> deep red -> bright red across 0..100% without access
                return d3.scaleLinear()
                    .domain([0, 0.5, 1])
                    .range(["#111827", "#991b1b", "#ff0000"])
                    .clamp(true)
                    (pct);
            }

            if (!rel || !rel.hrea_covered) return '#334155'; // Default fallback for other metrics

            let val = 0;
            if (currentAccessMetric === 'no_access') {
                const pct = rel.pct_no_access || 0;
                if (pct <= 0) return 'rgba(0,0,0,0)'; // Hide if everyone has access
                // Map: 1 - pct (0..1) -> 0..1 * 100 -> 0..100.
                val = (1 - pct) * 100;
            } else {
                // Reliability: 0->Red (Low), 100->Green (High)
                // Use access_only metric if available, else standard
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low, Yellow mid, Green high)
            return d3.scaleLinear()
                .domain(ACCESS_COLOR_SCALE.domain)
                .range(ACCESS_COLOR_SCALE.range)
                (val);
        } else if (baseLayer === 'electricity') {
            const key = roundedKey(d.latitude, d.longitude);
            const demandRow = demandByCoord.get(key);
            const val = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
            if (val > 0 && demandScale) {
                return demandScale(val);
            }
            return '#1e293b'; // slate-800 for no data
        } else if (baseLayer === 'uptime') {
            // Uptime mode: Show Grid Reliability (Red 0% -> Black 100%)
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const rel = reliabilityByCoord.get(relKey);

            if (!rel || !rel.hrea_covered) return '#1e293b'; // No data

            const gridUptime = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;

            // Gradient: Red (0%) -> Mid Grey (100%)
            // Using d3.scaleLinear to map 0-100 to Red-MidGrey
            return d3.scaleLinear()
                .domain([0, 100])
                .range(["#ef4444", "#6b7280"])
                .clamp(true)
                (gridUptime);
        } else if (baseLayer === 'population' || baseLayer === 'plants') {
            const popVal = d.population_2020 || 0;
            return popScale(popVal);
        }
        return 'rgba(0,0,0,0)';
    };

    // Define overlay fill function (supply layer)
    const overlayFill = overlayMode !== 'none' ? (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);

        if (overlayMode === 'access') {
            const rel = reliabilityByCoord.get(key);
            if (!rel) return '#334155';
            if (!rel.hrea_covered) return '#334155'; // No Data

            // Determine value based on metric
            let val = 0;
            if (currentAccessMetric === 'no_access') {
                val = (1 - (rel.pct_no_access || 0)) * 100;
            } else {
                val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
            }

            // Scale 0-100 -> color (Red low, Yellow mid, Green high)
            return d3.scaleLinear()
                .domain(ACCESS_COLOR_SCALE.domain)
                .range(ACCESS_COLOR_SCALE.range)
                (val);
        } else if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            return getColor(cfRow.annual_cf);
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            return getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
        }
        return null; // null means no overlay color for this cell
    } : null;

    const buildOverlayInfo = (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        let overlayColor = null;
        let overlayData = null;
        if (overlayMode === 'cf' && cfRow && Number.isFinite(cfRow.annual_cf)) {
            overlayColor = getColor(cfRow.annual_cf);
            overlayData = cfRow;
        } else if (overlayMode === 'lcoe' && lcoeScale && lcoeColorInfo && lcoeRow && Number.isFinite(lcoeRow.lcoe)) {
            overlayColor = getLcoeColor(lcoeRow, lcoeColorInfo, lcoeScale);
            overlayData = lcoeRow;
        }
        return { overlayColor, overlayData };
    };

    const buildPopulationLine = (d) => {
        const key = roundedKey(d.latitude, d.longitude);
        const demandRow = demandByCoord.get(key);
        const demandVal = demandRow ? (demandRow.annual_demand_kwh || 0) : 0;
        const demandTwh = demandVal / 1e9;
        if (baseLayer === 'population') {
            return `<div class="mt-1 text-muted">Population: ${formatNumber(d.population_2020 || 0, 0)}</div>`;
        }
        if (baseLayer === 'electricity') {
            return `<div class="mt-1 text-muted">Annual Demand: ${demandTwh.toFixed(2)} TWh</div>`;
        }
        return '';
    };

    const buildCapacityLines = (d) => {
        const capacity = capacityMap && d.location_id != null ? capacityMap.get(Number(d.location_id)) : null;
        return formatCapacityLines(capacity);
    };

    const handleHover = (e, d) => {
        const { overlayData } = buildOverlayInfo(d);
        const populationLine = buildPopulationLine(d);
        const capacityLines = buildCapacityLines(d);

        let content = '';
        if (overlayMode === 'lcoe' && overlayData && !overlayData.meetsTarget && !overlayData.includeDieselBackup) {
            // No qualifying solar + battery result here — report it as a data gap, not a failure.
            content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold text-muted">LCOE: No data available</div>
                ${populationLine}
                ${capacityLines}
             </div>`;
        } else if (overlayMode === 'lcoe' && overlayData) {
            const valueLine = `LCOE: ${Number.isFinite(overlayData.lcoe) ? formatCurrency(overlayData.lcoe) : '--'}/MWh`;
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
                    infoLines = `${deltaLine}\n<div>Breakeven transmission: ${breakevenGw} (${breakevenGwKm})</div>\n${distanceLine}`;
                } else if (lcoeColorInfo?.type === 'delta' && Number.isFinite(overlayData.delta)) {
                    infoLines = `<div>Cost delta vs reference: ${overlayData.delta >= 0 ? '+' : '-'}${formatCurrency(Math.abs(overlayData.delta), 2)}/MWh</div>`;
                }
            } else {
                // Non-diesel "no data" is handled by the early branch above, so a not-met
                // cell that reaches here always has firm back-up filling the gap.
                infoLines = `<div class="text-amber-300">Target solar + battery CF not met; showing the highest-solar-share firm configuration.</div>`;
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
                if (window.highlightChartsByReliability) {
                    window.highlightChartsByReliability(val);
                }
            } else {
                metricLine = `<div class="font-semibold text-muted">Grid Reliability: No data available</div>`;
            }
            content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                ${metricLine}
                ${populationLine}
             </div>`;
        } else if (overlayMode === 'access' || baseLayer === 'access') {
            const relKey = roundedKey(d.latitude, d.longitude, 2);
            const relData = reliabilityByCoord.get(relKey);
            const hasData = relData && relData.hrea_covered;
            let metricLine = '';
            if (hasData) {
                const relVal = (relData.avg_reliability_access_only || 0).toFixed(1) + '%';
                const noAccessVal = ((relData.pct_no_access || 0) * 100).toFixed(1) + '%';
                if (currentAccessMetric === 'no_access_pop') {
                    const popNoAccess = (relData.total_pop_reliability || 0) * (relData.pct_no_access || 0);
                    metricLine = `<div class="font-semibold">Without Power: ${noAccessVal}</div>
                                   <div class="text-muted text-[10px]">${(popNoAccess / 1e6).toFixed(2)} million people</div>`;
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

        if (content) {
            sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
        }
    };

    const handleOut = () => {
        map.closePopup(sharedPopup);
        if (window.clearChartsHighlight) {
            window.clearChartsHighlight();
        }
        if (window.section5ChartActive && window.clearSection5ChartHighlight) {
            window.clearSection5ChartHighlight();
        }
    };

    const handleClick = (e, d) => {
        const baseColor = baseFill(d);
        const { overlayColor, overlayData } = buildOverlayInfo(d);
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
    };

    // Use dual-layer rendering to show both demand and supply with transparency
    renderVoronoiDual(voronoiPoints, popData, baseFill, overlayFill, {
        onHover: handleHover,
        onOut: handleOut,
        onClick: handleClick
    });
}

function renderVoronoiDual(mapPoints, data, baseFill, overlayFill, options = {}) {
    const { onHover, onOut, onClick } = options;
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll("*").remove();

    if (mapPoints.length <= 1) return;

    const hasBase = typeof baseFill === 'function';
    const hasOverlay = typeof overlayFill === 'function';
    if (!hasBase && !hasOverlay) return;

    let path = null;
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
            .attr("id", "clip-land")
            .append("path")
            .datum(worldGeoJSON)
            .attr("d", path);
    }

    const clip = worldGeoJSON ? "url(#clip-land)" : null;
    const size = map.getSize();
    const buffer = Math.max(size.x, size.y);
    const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
    const delaunay = d3.Delaunay.from(mapPoints);
    const voronoi = delaunay.voronoi(bounds);

    const fireMarkerEvent = (row, eventName) => {
        const marker = row && row.__hitMarker;
        if (marker && typeof marker.fire === 'function') {
            marker.fire(eventName);
            return true;
        }
        return false;
    };

    // When both layers are present, use lower opacity so overlap is visible
    const baseOpacity = hasOverlay ? 0.5 : 0.85;
    const overlayOpacity = hasBase ? 0.5 : 0.35;

    if (hasBase) {
        const base = svg.append("g").attr("class", "voronoi-base").attr("clip-path", clip);
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
            .attr("data-loc-id", d => d.location_id)
            .style("pointer-events", "all")
            .each(function (d) {
                // Attach reliability value if available for highlighting
                if (lastReliabilityByCoord) {
                    const key = roundedKey(d.latitude, d.longitude, 2);
                    const rel = lastReliabilityByCoord.get(key);
                    if (rel && rel.hrea_covered) {
                        const val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
                        d3.select(this).attr("data-rel", val);
                    }
                }
            })
            .on("mouseover", function (e, d) {
                applyHoverRim(this);
                fireMarkerEvent(d, 'mouseover');
                if (onHover) onHover(e, d);
                // Determine reliability value for this cell
                if (lastReliabilityByCoord) {
                    const key = roundedKey(d.latitude, d.longitude, 2);
                    const rel = lastReliabilityByCoord.get(key);
                    if (rel && rel.hrea_covered && window.highlightChartsByReliability) {
                        const val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
                        window.highlightChartsByReliability(val);
                    }
                }

                // Section 5 Highlight (Access mode)
                if (window.section5ChartActive && d.location_id && window.highlightChartByLocationId) {
                    window.highlightChartByLocationId(d.location_id);
                }
            })
            .on("mouseout", function (e, d) {
                clearHoverRim(this);
                fireMarkerEvent(d, 'mouseout');
                if (onOut) onOut(e, d);
                if (window.clearChartsHighlight) {
                    window.clearChartsHighlight();
                }
                if (window.section5ChartActive && window.clearSection5ChartHighlight) {
                    window.clearSection5ChartHighlight();
                }
            })
            .on("click", function (e, d) {
                fireMarkerEvent(d, 'click');
                if (onClick) onClick(e, d);
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
            .attr("class", "transition-color leaflet-interactive")
            .attr("data-loc-id", d => d.location_id)
            .style("pointer-events", "all")
            .on("mouseover", function (e, d) {
                applyHoverRim(this);
                fireMarkerEvent(d, 'mouseover');
                if (onHover) onHover(e, d);
                // Determine reliability value for this cell
                if (lastReliabilityByCoord) {
                    const key = roundedKey(d.latitude, d.longitude, 2);
                    const rel = lastReliabilityByCoord.get(key);
                    if (rel && rel.hrea_covered && window.highlightChartsByReliability) {
                        const val = rel.avg_reliability_access_only !== undefined ? rel.avg_reliability_access_only : rel.avg_reliability;
                        window.highlightChartsByReliability(val);
                    }
                }

                // Section 5 Highlight (Access mode)
                if (window.section5ChartActive && d.location_id && window.highlightChartByLocationId) {
                    window.highlightChartByLocationId(d.location_id);
                }
            })
            .on("mouseout", function (e, d) {
                clearHoverRim(this);
                fireMarkerEvent(d, 'mouseout');
                if (onOut) onOut(e, d);
                if (window.clearChartsHighlight) {
                    window.clearChartsHighlight();
                }
                if (window.section5ChartActive && window.clearSection5ChartHighlight) {
                    window.clearSection5ChartHighlight();
                }
            })
            .on("click", function (e, d) {
                fireMarkerEvent(d, 'click');
                if (onClick) onClick(e, d);
            });
    }

    // Provide this for chart-to-map highlighting
    window.updateMapWithHighlightSection5 = (locationIds) => {
        const cells = svg.selectAll(".voronoi-cell");
        if (!locationIds) {
            // Restore base opacity
            cells.attr("fill-opacity", baseOpacity).attr("stroke", "rgba(255,255,255,0.08)");
            return;
        }

        const idSet = new Set(locationIds.map(id => Number(id)));
        cells.each(function (d) {
            const isHighlighted = idSet.has(Number(d.location_id));
            d3.select(this)
                .attr("fill-opacity", isHighlighted ? 1 : 0.05)
                .attr("stroke", isHighlighted ? "white" : "none")
                .attr("stroke-width", isHighlighted ? 1 : 0);
        });
    };
}

export function updatePopulationGeo(popData, geojson, { overlayMode = 'none', cfData = [], lcoeData = [], lcoeDomain = null } = {}) {
    currentMode = 'population';
    lastPopulationData = popData;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

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
                 </div>`;
                sharedPopup.setLatLng(e.latlng).setContent(appendCountryLine(content, props)).openOn(map);
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

export function updateLcoeMap(bestData, options = {}) {
    currentMode = 'lcoe';
    lastLcoeData = bestData;
    lastLcoeOptions = options;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    if (!bestData || bestData.length === 0) {
        return;
    }

    const targetCf = options.targetCf || null;
    const colorInfo = options.colorInfo || { type: 'lcoe', domain: null };
    const reference = options.reference || null;
    const metricMode = options.comparisonMetric || 'lcoe';
    const fossilCapacityMap = options.fossilCapacityMap || null; // Map<location_id, row>
    const plantData = options.fossilPlants || [];

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);
    const sharedPopup = createSharedPopup();

    renderLcoePlantOverlay(plantData);

    const getCellColor = (row) => {
        if (!row.meetsTarget) return '#611010';
        return getLcoeColor(row, colorInfo, colorScale);
    };

    const buildTooltipContent = (d) => {
        // No qualifying solar + battery result here — report it as a data gap, not a failure.
        if (!d.meetsTarget && !d.includeDieselBackup && !colorInfo.metric) {
            return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold text-muted">LCOE: No data available</div>
             </div>`;
        }
        // Back-up-only step (colours by a custom metric): every region has a back-up cost for
        // the forced final slice; show solar+battery specs only where the target is reachable.
        if (colorInfo.metric) {
            const mv = d[colorInfo.metric];
            const head = `${colorInfo.valueLabel || 'Back-up cost'}: ${Number.isFinite(mv) ? formatCurrency(mv) : '--'}/MWh`;
            const sharePct = Number.isFinite(d.backup_share_cf) ? Math.round(d.backup_share_cf * 100) : null;
            const fuelLabel = d.backup_fuel === 'gas' ? 'OCGT gas' : 'diesel';
            const shareLine = sharePct != null
                ? `<div class="text-muted">Firms the final ${sharePct}% of uptime with least-cost ${fuelLabel}.</div>`
                : '';
            const specLine = d.sbReachable
                ? `<div>Solar + battery: ${d.solar_gw} MW_DC + ${d.batt_gwh} MWh${Number.isFinite(d.reach_cf) ? ` (reaches ${(d.reach_cf * 100).toFixed(0)}%)` : ''}</div>`
                : `<div class="text-muted">Solar + battery can't reach the target here — no details available.</div>`;
            return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${head}</div>
                ${shareLine}
                ${specLine}
             </div>`;
        }
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
        // When colouring by a custom metric (e.g. back-up-only cost on step 7), the
        // headline shows that metric and the full system LCOE drops to a context line.
        let valueLine;
        let fullSystemLine = '';
        if (colorInfo.metric) {
            const mv = d[colorInfo.metric];
            valueLine = `${colorInfo.valueLabel || 'Value'}: ${Number.isFinite(mv) ? formatCurrency(mv) : '--'}/MWh`;
            if (Number.isFinite(d.lcoe)) {
                fullSystemLine = `<div class="text-muted">Full firm system: ${formatCurrency(d.lcoe)}/MWh</div>`;
            }
        } else {
            valueLine = d.meetsTarget || d.includeDieselBackup
                ? `LCOE: ${Number.isFinite(d.lcoe) ? formatCurrency(d.lcoe) : '--'}/MWh`
                : `LCOE: ${Number.isFinite(d.maxConfigLcoe) ? `>${formatCurrency(d.maxConfigLcoe)}` : '--'}/MWh`;
        }

        let capLine = '';
        if (fossilCapacityMap) {
            const capRow = fossilCapacityMap.get(d.location_id);
            if (capRow) {
                const announced = (capRow.coal_Announced || 0) + (capRow.oil_gas_Announced || 0) + (capRow.bioenergy_Announced || 0);
                if (announced > 0) {
                    capLine = `<div class="mt-1 pt-1 border-t border-outline">
                        <div class="font-semibold text-white">Planned Thermal: ${formatNumber(announced, 0)} MW</div>
                        <div class="text-[10px] text-muted">
                            ${capRow.coal_Announced ? `Coal: ${formatNumber(capRow.coal_Announced, 0)} MW<br>` : ''}
                            ${capRow.oil_gas_Announced ? `Gas/Oil: ${formatNumber(capRow.oil_gas_Announced, 0)} MW` : ''}
                        </div>
                    </div>`;
                }
            }
        }

        const dieselLines = buildDieselBackupLines(d, formatCurrency).join('');
        return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
            <div class="font-semibold">${valueLine}</div>
            <div>${buildLcoeConfigLine(d)}</div>
            ${dieselLines}
            ${fullSystemLine}
            ${infoLines}
            ${capLine}
         </div>`;
    };

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
        (row) => getCellColor(row),
        {
            enableHoverSelect: true,
            fillOpacity: 0.6,
            stroke: "rgba(255,255,255,0.08)",
            strokeWidth: 0.5,
            onHover: (e, d) => {
                const content = buildTooltipContent(d);
                sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
            },
            onOut: () => {
                map.closePopup(sharedPopup);
            },
            onClick: (e, d) => {
                updateLocationPanel({ ...d, targetCf, comparisonMetric: metricMode }, getCellColor(d), 'lcoe');
                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, targetCf }, 'lcoe');
                }
            }
        }
    );
}

function renderLcoePlantOverlay(plantData) {
    if (!plantData || plantData.length === 0) return;
    if (!lcoePlantPopup) {
        lcoePlantPopup = L.popup({
            closeButton: false,
            autoPan: false,
            className: 'bg-transparent border-none shadow-none'
        });
    }

    const activePlants = plantData.filter(p =>
        p.fuel_group !== 'nuclear' &&
        (p.status === 'announced' || p.status === 'pre-construction' || p.status === 'construction') &&
        p.latitude && p.longitude
    ).sort((a, b) => (b.capacity_mw || 0) - (a.capacity_mw || 0));

    activePlants.forEach(p => {
        const fuel = p.fuel_group;
        const color = FUEL_COLORS[fuel] || '#e2e8f0';
        const capacity = p.capacity_mw || 0;
        const radius = Math.max(2, Math.min(12, Math.sqrt(capacity) * 0.15));

        const marker = L.circleMarker([p.latitude, p.longitude], {
            radius: radius,
            fillColor: color,
            color: color,
            weight: 0,
            opacity: 0,
            fillOpacity: 0.3,
            pane: 'markers'
        });

        marker.on('mouseover', () => {
            const cap = Math.round(capacity);
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                <div class="font-semibold">${p.plant_name || 'Power plant'}</div>
                <div class="text-[11px] text-muted">Fuel: ${p.fuel_group.toUpperCase()}</div>
                <div class="text-[11px] text-muted">Capacity: ${cap} MW</div>
                <div class="text-[11px] text-muted capitalize">${p.status}</div>
             </div>`;
            lcoePlantPopup.setLatLng([p.latitude, p.longitude]).setContent(content).openOn(map);
        });

        marker.on('mouseout', () => map.closePopup(lcoePlantPopup));
        marker.addTo(overlayLayer);
    });
}

export function updateLcoePlantOverlay(plantData) {
    if (currentMode !== 'lcoe') return;
    overlayLayer.clearLayers();
    renderLcoePlantOverlay(plantData);
}

// Similar to updateLcoeMap but for CF display (Target LCOE mode)
export function updateCfMap(cfData, options = {}) {
    currentMode = 'lcoe_cf'; // Use distinct mode for Target Mode (CF Map)
    lastCfData = cfData;
    lastCfOptions = options;
    selectedMarker = null;

    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    d3.select(voronoiLayer._container).selectAll("*").remove();

    if (!cfData || cfData.length === 0) {
        return;
    }

    const targetLcoe = options.targetLcoe || null;
    const colorInfo = options.colorInfo || { type: 'cf', domain: [0, 0.5, 1] };
    const reference = options.reference || null;

    const colorScale = buildLcoeColorScaleFromInfo(colorInfo);
    const sharedPopup = createSharedPopup();

    const getCellColor = (row) => {
        const meetsTarget = row.meetsTarget !== false;
        return getLcoeColor({ ...row, lcoe: row.cf, meetsTarget }, colorInfo, colorScale);
    };

    const buildTooltipContent = (d) => {
        const meetsTarget = d.meetsTarget !== false;
        let infoLines = '';
        if (meetsTarget) {
            if (reference && Number.isFinite(d.delta)) {
                const deltaSign = d.delta >= 0 ? '+' : '';
                infoLines = `<div>CF delta vs reference: ${deltaSign}${(d.delta * 100).toFixed(1)}%</div>`;
            }
        } else {
            infoLines = `<div class="text-amber-300">Target LCOE not met.</div>
                <div>Lowest LCOE config:</div>`;
        }

        const cfPercent = (d.cf * 100).toFixed(1);
        return `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
            <div class="font-semibold">CF: ${meetsTarget ? cfPercent + '%' : '--'}</div>
            <div>Solar ${d.solar_gw} MW_DC | Battery ${d.batt_gwh} MWh</div>
            <div>LCOE: ${formatCurrency(d.lcoe)}/MWh</div>
            ${infoLines}
         </div>`;
    };

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
        (row) => getCellColor(row),
        {
            enableHoverSelect: true,
            onHover: (e, d) => {
                const content = buildTooltipContent(d);
                sharedPopup.setLatLng([d.latitude, d.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
            },
            onOut: () => {
                map.closePopup(sharedPopup);
            },
            onClick: (e, d) => {
                const meetsTarget = d.meetsTarget !== false;
                updateLocationPanel({ ...d, targetLcoe, meetsTarget }, getCellColor(d), 'lcoe');
                if (map.onLocationSelect) {
                    map.onLocationSelect({ ...d, targetLcoe, meetsTarget }, 'lcoe');
                }
            }
        }
    );
}

function renderVoronoi(mapPoints, data, fillAccessor, options = {}) {
    const { enableHoverSelect = true, ripple = false } = options;
    const perf = startMapPerf('scrolly-render-voronoi', {
        mode: currentMode,
        points: mapPoints?.length || 0,
        reuse: FEATURE_VORONOI_REUSE
    });
    const svg = d3.select(voronoiLayer._container);
    if (!FEATURE_VORONOI_REUSE) {
        svg.selectAll("*").remove();
    }

    // If only one point, just a circle
    if (mapPoints.length === 1) {
        // ... (simplified for now, or just skip)
        endMapPerf(perf, { rendered: 0, skipped: true });
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
        const size = map.getSize();
        const center = map.getCenter();
        const nextClipVersion = `${size.x}x${size.y}|${map.getZoom()}|${center.lat.toFixed(3)},${center.lng.toFixed(3)}`;
        const shouldRefreshClip = !FEATURE_VORONOI_REUSE || voronoiClipVersion !== nextClipVersion || svg.select('#clip-land').empty();

        if (shouldRefreshClip) {
            let defs = svg.select('defs');
            if (defs.empty()) {
                defs = svg.append('defs');
            }
            let clipPath = defs.select('#clip-land');
            if (clipPath.empty()) {
                clipPath = defs.append('clipPath').attr('id', 'clip-land');
                clipPath.append('path');
            }
            clipPath.select('path')
                .datum(worldGeoJSON)
                .attr('d', path);
            voronoiClipVersion = nextClipVersion;
        }
    }

    let g = FEATURE_VORONOI_REUSE ? svg.select('g.voronoi-group') : d3.select(null);
    if (g.empty()) {
        g = svg.append('g');
    }
    g.attr('class', `voronoi-group${options.groupPulse ? ' intro-breathe' : ''}`)
        .attr('clip-path', worldGeoJSON ? 'url(#clip-land)' : null);

    if (options.groupFade) {
        const durationMs = Number.isFinite(options.groupFade.durationMs) ? options.groupFade.durationMs : 1200;
        g.classed("intro-group-fade", true)
            .style("animation-duration", `${durationMs}ms`);
        setTimeout(() => {
            g.classed("intro-group-fade", false);
        }, durationMs + 50);
    }
    if (enableHoverSelect || options.onHover || options.onOut || options.onClick) {
        g.style("pointer-events", "all");
    } else {
        g.style("pointer-events", "none");
    }

    const delaunay = d3.Delaunay.from(mapPoints);
    const size = map.getSize();
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
            i,
            path: voronoi.renderCell(i)
        };
    });

    const fireMarkerEvent = (row, eventName) => {
        const marker = row && row.__hitMarker;
        if (marker && typeof marker.fire === 'function') {
            marker.fire(eventName);
            return true;
        }
        // Fallback for any legacy markers
        let fired = false;
        markersLayer.eachLayer(layer => {
            if (fired || !layer.getLatLng) return;
            const latLng = layer.getLatLng();
            if (Math.abs(latLng.lat - row.latitude) < 0.0001 && Math.abs(latLng.lng - row.longitude) < 0.0001) {
                if (typeof layer.fire === 'function') {
                    layer.fire(eventName);
                }
                fired = true;
            }
        });
        return fired;
    };

    // For ripple: compute x-range for delay calculation
    let minX = Infinity, maxX = -Infinity;
    if (ripple) {
        mapPoints.forEach(p => {
            if (p[0] < minX) minX = p[0];
            if (p[0] > maxX) maxX = p[0];
        });
    }
    const xRange = maxX - minX || 1;

    let paths = g.selectAll('path.voronoi-cell');
    paths = FEATURE_VORONOI_REUSE
        ? paths.data(cellsData, d => d.key)
        : paths.data(cellsData);

    paths.exit().remove();

    const enterPaths = paths.enter()
        .append('path')
        .attr('class', 'transition-color voronoi-cell leaflet-interactive');

    const mergedPaths = enterPaths.merge(paths)
        .attr('d', d => d.path)
        .attr('data-loc-id', d => d.row.location_id)
        .style('pointer-events', 'all')
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

            const isFreshPath = this.__voronoiInit !== true;
            this.__voronoiInit = true;

            if (options.fadeIn && isFreshPath) {
                const durationMs = Number.isFinite(options.fadeIn.durationMs) ? options.fadeIn.durationMs : 200;
                const totalMs = Number.isFinite(options.fadeIn.totalMs) ? options.fadeIn.totalMs : 3000;
                const maxDelay = Math.max(0, totalMs - durationMs);
                const delay = options.fadeIn.random === false
                    ? (cell.i / Math.max(1, mapPoints.length - 1)) * maxDelay
                    : Math.random() * maxDelay;
                el.classed("voronoi-fade-in", true)
                    .style("opacity", 0)
                    .style("animation-duration", `${durationMs}ms`)
                    .style("animation-delay", `${delay}ms`);
            } else {
                el.classed("voronoi-fade-in", false).style("opacity", null).style("animation-delay", null);
            }

            // Apply ripple animation with staggered delay
            if (ripple && mapPoints[cell.i]) {
                const xPos = mapPoints[cell.i][0];
                const delay = ((xPos - minX) / xRange) * 2000; // 2s total wave sweep
                el.classed("voronoi-hop", true)
                    .style("animation-delay", delay + "ms");
            } else {
                el.classed("voronoi-hop", false).style("animation-delay", null);
            }
        })
        .on("click", (e, cell) => {
            const d = cell.row || cell;
            if (options.onClick) {
                options.onClick(d);
                return;
            }
            fireMarkerEvent(d, 'click');
        })
        .on("mouseover", (e, cell) => {
            const d = cell.row || cell;
            applyHoverRim(e.currentTarget);
            if (!enableHoverSelect) return;
            if (!fireMarkerEvent(d, 'mouseover') && options.onHover) {
                options.onHover(e, d);
            }
        })
        .on("mouseout", (e, cell) => {
            const d = cell.row || cell;
            clearHoverRim(e.currentTarget);
            if (!enableHoverSelect) return;
            if (!fireMarkerEvent(d, 'mouseout') && options.onOut) {
                options.onOut(e, d);
            }
        });

    // Chart-to-map highlighting for LCOE views
    window.updateMapWithHighlightLcoe = (locationIds) => {
        if (currentMode !== 'lcoe' && currentMode !== 'lcoe_cf') return;
        const cells = svg.selectAll(".voronoi-cell");
        if (!locationIds) {
            cells
                .attr("fill-opacity", 0.6)
                .attr("stroke", "rgba(255,255,255,0.08)")
                .attr("stroke-width", 0.5);
            return;
        }

        const idSet = new Set(locationIds.map(id => Number(id)));
        cells.each(function (d) {
            const row = d?.row || d;
            const isHighlighted = idSet.has(Number(row?.location_id));
            d3.select(this)
                .attr("fill-opacity", isHighlighted ? 0.9 : 0.05)
                .attr("stroke", isHighlighted ? "white" : "none")
                .attr("stroke-width", isHighlighted ? 1 : 0);
        });
    };

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

export function clearAllMapLayers() {
    if (markersLayer) markersLayer.clearLayers();
    if (overlayLayer) overlayLayer.clearLayers();
    if (sampleInfoById) sampleInfoById.clear();
    if (voronoiLayer) {
        d3.select(voronoiLayer._container).selectAll("*").remove();
    }

    // Reset state
    lastData = null;
    lastLcoeData = null;
    lastCfData = null;
    lastPopulationData = null;
    lastPotentialData = null;
    lastPotentialOptions = null;
    lastSampleFrame = null;
    lastVoronoi = null;
    lastVoronoiPoints = null;
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

    // Clear existing visual layers
    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    sampleInfoById.clear();

    if (!samplePopup) {
        samplePopup = createSharedPopup();
    }

    locations.forEach(loc => {
        const id = Number(loc.location_id);
        sampleInfoById.set(id, {
            location_id: id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            solarShare: loc.solarShare ?? 0,
            batteryShare: loc.batteryShare ?? 0,
            otherShare: loc.otherShare ?? 0
        });
    });

    // Render Voronoi background
    if (locations.length > 0) {
        const mapPoints = locations.map(loc => {
            const point = map.latLngToLayerPoint([loc.latitude, loc.longitude]);
            return [point.x, point.y];
        });

        renderSampleVoronoi(mapPoints, locations);
    }
}

let lastVoronoi = null;
let lastVoronoiPoints = null;

function renderSampleVoronoi(mapPoints, locations) {
    const svg = d3.select(voronoiLayer._container);

    // Check if we can reuse the Voronoi diagram
    // We assume if the number of points is the same, it's likely the same points (optimization for animation)
    // For robust check, we'd compare coords, but length check is fast for this animation use case
    let voronoi = lastVoronoi;
    let needsGeometryUpdate = true;

    if (lastVoronoi && lastVoronoiPoints && lastVoronoiPoints.length === mapPoints.length) {
        // Simple check: check first and last point
        const p1 = mapPoints[0];
        const p2 = lastVoronoiPoints[0];
        if (p1[0] === p2[0] && p1[1] === p2[1]) {
            needsGeometryUpdate = false;
        }
    }

    if (needsGeometryUpdate) {
        // Cleanup old contents if geometry changes completely
        // But for D3 data binding we might want to keep elements. 
        // For now, if geometry changes, let's reset to be safe or just recompute voronoi.
        // We won't clear SVG here effectively to allow data join.

        const delaunay = d3.Delaunay.from(mapPoints);
        const size = map.getSize();
        const buffer = Math.max(size.x, size.y);
        const bounds = [-buffer, -buffer, size.x + buffer, size.y + buffer];
        voronoi = delaunay.voronoi(bounds);

        lastVoronoi = voronoi;
        lastVoronoiPoints = mapPoints;

        // Ensure clip path exists
        if (worldGeoJSON && svg.select("#clip-land").empty()) {
            const transform = d3.geoTransform({
                point: function (x, y) {
                    const point = map.latLngToLayerPoint(new L.LatLng(y, x));
                    this.stream.point(point.x, point.y);
                },
            });
            const path = d3.geoPath().projection(transform);

            svg.append("defs")
                .append("clipPath")
                .attr("id", "clip-land")
                .append("path")
                .datum(worldGeoJSON)
                .attr("d", path);
        }

        // Ensure group exists
        if (svg.select(".voronoi-group").empty()) {
            svg.append("g")
                .attr("class", "voronoi-group")
                .attr("clip-path", worldGeoJSON ? "url(#clip-land)" : null);
        }
    }

    const g = svg.select(".voronoi-group");

    // DATA JOIN
    const paths = g.selectAll("path")
        .data(locations, d => Number(d.location_id));

    // EXIT
    paths.exit().remove();

    // ENTER
    const enterPaths = paths.enter()
        .append("path")
        .attr("class", "leaflet-interactive")
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .style("pointer-events", "all")
        .style("cursor", "pointer")
        .on("mouseover", (e, d) => {
            applyHoverRim(e.currentTarget);
            if (!samplePopup) {
                samplePopup = createSharedPopup();
            }
            const info = sampleInfoById.get(Number(d.location_id)) || d;
            const solar = Number.isFinite(info.solarShare) ? (info.solarShare * 100).toFixed(1) : '--';
            const battery = Number.isFinite(info.batteryShare) ? (info.batteryShare * 100).toFixed(1) : '--';
            const other = Number.isFinite(info.otherShare) ? (info.otherShare * 100).toFixed(1) : '--';
            const content = `<div class="bg-surface text-on-surface border border-outline px-3 py-2 rounded text-xs max-w-xs">
                    <div class="font-semibold">Generation mix</div>
                    <div class="text-[11px] text-muted">Solar: ${solar}%</div>
                    <div class="text-[11px] text-muted">Battery: ${battery}%</div>
                    <div class="text-[11px] text-muted">Other: ${other}%</div>
                </div>`;
            samplePopup.setLatLng([info.latitude, info.longitude]).setContent(appendCountryLine(content, d)).openOn(map);
        })
        .on("mouseout", (e, d) => {
            clearHoverRim(e.currentTarget);
            if (samplePopup) {
                map.closePopup(samplePopup);
            }
        })
        .on("click", (e, d) => {
            if (map && map.onLocationSelect) {
                map.onLocationSelect(d, 'sample');
            }
            if (sampleLocationHandler) {
                const info = sampleInfoById.get(Number(d.location_id)) || d;
                sampleLocationHandler({ ...info });
            }
        });

    if (needsGeometryUpdate) {
        enterPaths.attr("d", (_, i) => voronoi.renderCell(i));
        // Also update existing paths geometry if needed (e.g. slight map move? actually map move triggers re-render)
        paths.attr("d", (_, i) => voronoi.renderCell(i));
    }

    // UPDATE (Color)
    // We merge enter and update selections for color assignment
    // No CSS transition - instant color updates for smooth 500ms animation loop
    enterPaths.merge(paths)
        .attr("fill", d => d.color)
        .attr("fill-opacity", 0.6);
}

// ========== OPTIMIZED SAMPLE FRAME FUNCTIONS ==========
// These functions separate initialization from animation updates for performance

let sampleFrameInitialized = false;

/**
 * Initialize the sample frame map ONCE when entering Step 3.
 * Creates all markers and Voronoi structure upfront.
 * @param {Object} frameData - Initial frame data with locations array
 */
export function initSampleFrameMap(frameData) {
    currentMode = 'samples';
    lastSampleFrame = frameData;

    if (!frameData || !frameData.locations) {
        console.warn('No frame data provided for initialization');
        return;
    }

    const { locations } = frameData;
    if (locations.length === 0) {
        return;
    }

    // Clear ALL existing layers
    markersLayer.clearLayers();
    overlayLayer.clearLayers();
    sampleInfoById.clear();

    if (!samplePopup) {
        samplePopup = createSharedPopup();
    }

    locations.forEach(loc => {
        const id = Number(loc.location_id);
        sampleInfoById.set(id, {
            location_id: id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            solarShare: loc.solarShare ?? 0,
            batteryShare: loc.batteryShare ?? 0,
            otherShare: loc.otherShare ?? 0
        });
    });

    // Initialize Voronoi structure
    if (locations.length > 0) {
        const mapPoints = locations.map(loc => {
            const point = map.latLngToLayerPoint([loc.latitude, loc.longitude]);
            return [point.x, point.y];
        });
        renderSampleVoronoi(mapPoints, locations);
    }

    sampleFrameInitialized = true;
    console.log(`Initialized ${locations.length} sample markers`);
}

/**
 * Lightweight color-only update for animation frames.
 * ONLY updates colors of existing markers and Voronoi cells - no DOM recreation.
 * @param {Array} locations - Array of location objects with location_id and color
 */
export function updateSampleFrameColors(locations) {
    if (!locations || locations.length === 0) return;

    locations.forEach(loc => {
        const id = Number(loc.location_id);
        const existing = sampleInfoById.get(id);
        if (existing) {
            existing.solarShare = loc.solarShare ?? 0;
            existing.batteryShare = loc.batteryShare ?? 0;
            existing.otherShare = loc.otherShare ?? 0;
        } else {
            sampleInfoById.set(id, {
                location_id: id,
                latitude: loc.latitude,
                longitude: loc.longitude,
                solarShare: loc.solarShare ?? 0,
                batteryShare: loc.batteryShare ?? 0,
                otherShare: loc.otherShare ?? 0
            });
        }
    });

    // Update Voronoi colors using D3 data join (already optimized in renderSampleVoronoi)
    const svg = d3.select(voronoiLayer._container);
    const g = svg.select(".voronoi-group");

    if (!g.empty()) {
        // Create a lookup map for fast color access
        const colorMap = new Map();
        locations.forEach(loc => colorMap.set(Number(loc.location_id), loc.color));

        g.selectAll("path")
            .attr("fill", d => colorMap.get(Number(d.location_id)) || d.color || '#9ca3af');
    }

    // Store for moveend handler
    lastSampleFrame = { locations };
}

/**
 * Check if sample frame map is initialized
 */
export function isSampleFrameInitialized() {
    return sampleFrameInitialized;
}

/**
 * Reset sample frame state (call when leaving Step 3)
 */
export function resetSampleFrameState() {
    sampleFrameInitialized = false;
    sampleInfoById.clear();
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
        zoomControl: true,
        attributionControl: false,
        zoomAnimation: false,  // Disable zoom animation to prevent SVG scale mismatch
        fadeAnimation: false
    }).setView([20, 0], 2);

    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
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

            // Map points to pixel coords

            if (layerType === 'plants') {
                // Render Points (Circles)
                const subsetData = allData.filter(d => subsetSet.has(d.location_id));

                const circles = svg.selectAll("circle")
                    .data(subsetData)
                    .enter()
                    .append("circle")
                    .attr("cx", d => subsetMap.latLngToLayerPoint([d.latitude, d.longitude]).x)
                    .attr("cy", d => subsetMap.latLngToLayerPoint([d.latitude, d.longitude]).y)
                    .attr("r", d => getRadius ? getRadius(d) : 4)
                    .attr("fill", d => getColor(getValue(d)))
                    .attr("fill-opacity", 0.3)
                    .attr("stroke", "none")
                    .attr("stroke-width", 0)
                    .style("pointer-events", "auto");

                if (onPointHover || onPointOut) {
                    circles
                        .on("mouseover", (e, d) => onPointHover && onPointHover(e, d))
                        .on("mouseout", (e, d) => onPointOut && onPointOut(e, d));
                } else {
                    circles.append("title")
                        .text(d => getTooltip ? getTooltip(d) : `Value: ${formatNumber(getValue(d), 2)}`);
                }

            } else {
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
                svg.append("g")
                    .attr("clip-path", worldGeoJSON ? "url(#clip-land-subset)" : null)
                    .selectAll("path")
                    .data(pathsData)
                    .enter()
                    .append("path")
                    .attr("d", p => voronoi.renderCell(p.i))
                    .attr("fill", p => getColor(getValue(p.d)))
                    .attr("fill-opacity", 0.9)
                    .attr("stroke", "none")
                    .attr("class", "leaflet-interactive")
                    .style("pointer-events", "auto")
                    .on("mouseover", (e, p) => {
                        applyHoverRim(e.currentTarget);
                        if (onPointHover) onPointHover(e, p.d);
                    })
                    .on("mouseout", (e, p) => {
                        clearHoverRim(e.currentTarget);
                        if (onPointOut) onPointOut(e, p.d);
                    })
                    .each(function (p) {
                        if (onPointHover || onPointOut) return;
                        const val = getValue(p.d);
                        d3.select(this)
                            .append("title")
                            .text(getTooltip ? getTooltip(p.d) : `Value: ${formatNumber(val, 2)}`);
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

// ========== HIGHLIGHTING HELPERS ==========
window.highlightMapByReliability = function (min, max) {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll(".voronoi-cell")
        .transition().duration(100)
        .attr("fill-opacity", function () {
            const rel = d3.select(this).attr("data-rel");
            if (rel === null) return 0.05;
            const val = parseFloat(rel);
            return (val >= min && val < max) ? 0.95 : 0.05;
        })
        .attr("stroke", function () {
            const rel = d3.select(this).attr("data-rel");
            if (rel === null) return "none";
            const val = parseFloat(rel);
            return (val >= min && val < max) ? "white" : "none";
        })
        .attr("stroke-width", function () {
            const rel = d3.select(this).attr("data-rel");
            if (rel === null) return 0;
            const val = parseFloat(rel);
            return (val >= min && val < max) ? 1 : 0;
        })
        .attr("stroke-opacity", function () {
            const rel = d3.select(this).attr("data-rel");
            if (rel === null) return 0.1;
            const val = parseFloat(rel);
            return (val >= min && val < max) ? 1 : 0.1;
        });
};

window.clearMapHighlight = function () {
    const svg = d3.select(voronoiLayer._container);
    svg.selectAll(".voronoi-cell")
        .transition().duration(200)
        .attr("fill-opacity", 0.6)
        .attr("stroke", "rgba(255,255,255,0.08)")
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 1);
};

// ========== DUAL GLOBE VISUALIZATION (Step 4) ==========

const STEP4_SPLIT_MS = 1000;
const STEP4_HOLD_MS = 2000;
const STEP4_MERGE_MS = 1000;
const STEP4_CELL_FADE_MS = 200;
const STEP4_MAX_POINTS = Number.POSITIVE_INFINITY;

let step4State = {
    mode: 'map', // 'map' | 'chart'
    phase: 'map', // 'map' | 'chart-split' | 'chart-dual'
    previousPhase: null,
    populationData: null,
    lcoeData: null,
    lcoeColorInfo: null,
    listenersAttached: false,
    popByLoc: new Map(), // location_id -> population
    transitionTimer: null,
    sampledData: null,
    sampleKey: null,
    phaseDuration: STEP4_SPLIT_MS,
    dotDuration: STEP4_SPLIT_MS,
    canvas: {
        lcoe: { points: null, animFrame: null },
        pop: { points: null, animFrame: null }
    }
};

function clearStep4Timers() {
    if (step4State.transitionTimer) {
        clearTimeout(step4State.transitionTimer);
        step4State.transitionTimer = null;
    }
    if (step4State.canvas) {
        Object.values(step4State.canvas).forEach(state => {
            if (state?.animFrame) cancelAnimationFrame(state.animFrame);
            if (state) state.animFrame = null;
        });
    }
}

/**
 * Initialize and render Step 4 visualization
 */
export function renderDualGlobes(populationData, lcoeData, options = {}) {
    const container = document.getElementById('dual-globe-container');
    if (!container) return;

    // Show container, hide map
    container.classList.remove('hidden');
    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.opacity = '0';

    // Store data
    step4State.populationData = populationData;
    step4State.lcoeData = lcoeData;
    step4State.lcoeColorInfo = options.lcoeColorInfo || null;
    step4State.sampledData = null;
    step4State.sampleKey = null;
    if (step4State.canvas) {
        step4State.canvas.lcoe.points = null;
        step4State.canvas.pop.points = null;
    }

    // Build Index for Data Join
    step4State.popByLoc = new Map();
    if (populationData) {
        populationData.forEach(d => {
            if (d.location_id != null) step4State.popByLoc.set(Number(d.location_id), d.population_2020 || 0);
        });
    }

    // Attach Listeners Once
    if (!step4State.listenersAttached) {
        const btnMap = document.getElementById('step4-btn-map');
        const btnChart = document.getElementById('step4-btn-chart');

        if (btnMap && btnChart) {
            btnMap.addEventListener('click', () => updateStep4View('map'));
            btnChart.addEventListener('click', () => updateStep4View('chart'));
        }
        step4State.listenersAttached = true;
    }

    // Initial Render
    updateStep4View(step4State.mode);
}

/**
 * Handle view transitions
 */
function updateStep4View(mode) {
    step4State.mode = mode;
    clearStep4Timers();

    // Update UI Buttons
    const btnMap = document.getElementById('step4-btn-map');
    const btnChart = document.getElementById('step4-btn-chart');
    if (btnMap && btnChart) {
        if (mode === 'map') {
            btnMap.classList.replace('text-gray-400', 'text-white');
            btnMap.classList.add('bg-white/10');
            btnChart.classList.replace('text-white', 'text-gray-400');
            btnChart.classList.remove('bg-white/10');
        } else {
            btnChart.classList.replace('text-gray-400', 'text-white');
            btnChart.classList.add('bg-white/10');
            btnMap.classList.replace('text-white', 'text-gray-400');
            btnMap.classList.remove('bg-white/10');
        }
    }

    if (mode === 'chart') {
        setStep4Phase('chart-split', { duration: STEP4_SPLIT_MS, dotDuration: STEP4_SPLIT_MS });
        step4State.transitionTimer = setTimeout(() => {
            if (step4State.mode === 'chart') {
                setStep4Phase('chart-dual', { duration: STEP4_MERGE_MS, dotDuration: 0 });
            }
        }, STEP4_SPLIT_MS + STEP4_HOLD_MS);
    } else {
        if (step4State.phase !== 'map') {
            const fromDual = step4State.phase === 'chart-dual';
            const splitDuration = fromDual ? STEP4_MERGE_MS : 0;
            const holdDelay = STEP4_HOLD_MS + (fromDual ? STEP4_MERGE_MS : 0);

            setStep4Phase('chart-split', { duration: splitDuration, dotDuration: 0 });
            step4State.transitionTimer = setTimeout(() => {
                if (step4State.mode === 'map') {
                    setStep4Phase('map', { duration: STEP4_SPLIT_MS, dotDuration: STEP4_SPLIT_MS });
                }
            }, holdDelay);
        } else {
            setStep4Phase('map', { duration: STEP4_SPLIT_MS, dotDuration: 0 });
        }
    }
}

function setStep4Phase(phase, options = {}) {
    const prevPhase = step4State.phase;
    step4State.previousPhase = prevPhase;
    step4State.phase = phase;
    step4State.phaseDuration = Number.isFinite(options.duration) ? options.duration : STEP4_SPLIT_MS;
    step4State.dotDuration = Number.isFinite(options.dotDuration) ? options.dotDuration : step4State.phaseDuration;
    applyStep4Layout(phase, step4State.phaseDuration);
    const skipDotAnimation = phase === 'chart-dual' || step4State.dotDuration === 0;
    requestAnimationFrame(() => renderStep4Visuals({
        skipDotAnimation,
        prevPhase,
        dotDuration: step4State.dotDuration,
        phaseDuration: step4State.phaseDuration
    }));
}

function applyStep4Layout(phase, durationMs = STEP4_SPLIT_MS) {
    const globePopContainer = document.getElementById('globe-pop-container');
    const globeLcoeContainer = document.getElementById('globe-lcoe-container');
    const divider = document.getElementById('step4-divider');
    const popLabel = document.getElementById('globe-pop-label');
    const lcoeLabel = document.getElementById('globe-lcoe-label');
    const chartAxes = document.getElementById('step4-chart-axes');

    const applyBase = (el, zIndex) => {
        if (!el) return;
        el.style.position = 'relative';
        el.style.inset = '';
        el.style.width = '';
        el.style.height = '';
        el.style.flex = '1';
        el.style.transitionDuration = `${durationMs}ms`;
        el.style.transitionTimingFunction = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
        el.style.transitionProperty = 'transform, opacity';
        el.style.transformOrigin = 'center';
        el.style.willChange = 'transform, opacity';
        el.style.zIndex = zIndex;
    };

    applyBase(globeLcoeContainer, '10');
    applyBase(globePopContainer, '5');

    if (divider) {
        divider.style.position = 'relative';
        divider.style.left = '';
        divider.style.right = '';
        divider.style.top = '';
        divider.style.transform = '';
        divider.style.zIndex = '15';
    }

    if (chartAxes) chartAxes.style.opacity = '0';

    if (phase === 'map' || phase === 'chart-split') {
        if (globeLcoeContainer) {
            globeLcoeContainer.style.opacity = '1';
            globeLcoeContainer.style.transform = 'translateY(0)';
            globeLcoeContainer.style.pointerEvents = phase === 'map' ? 'auto' : 'none';
        }
        if (globePopContainer) {
            globePopContainer.style.opacity = '1';
            globePopContainer.style.transform = 'translateY(0)';
            globePopContainer.style.pointerEvents = phase === 'map' ? 'auto' : 'none';
        }
        if (divider) divider.style.opacity = phase === 'map' ? '1' : '0.2';
        if (popLabel) popLabel.style.opacity = phase === 'map' ? '1' : '0';
        if (lcoeLabel) lcoeLabel.style.opacity = phase === 'map' ? '1' : '0';
        return;
    }

    if (phase === 'chart-dual') {
        if (globeLcoeContainer) {
            globeLcoeContainer.style.opacity = '1';
            globeLcoeContainer.style.transform = 'translateY(50%)';
            globeLcoeContainer.style.pointerEvents = 'none';
        }
        if (globePopContainer) {
            globePopContainer.style.opacity = '0.75';
            globePopContainer.style.transform = 'translateY(-50%)';
            globePopContainer.style.pointerEvents = 'none';
        }
        if (divider) divider.style.opacity = '0';
        if (popLabel) popLabel.style.opacity = '0';
        if (lcoeLabel) lcoeLabel.style.opacity = '0';
    }
}

function renderStep4Visuals(options = {}) {
    const { skipDotAnimation, prevPhase, dotDuration, phaseDuration } = options;
    const { phase, lcoeData, populationData, popByLoc, lcoeColorInfo } = step4State;
    if (!lcoeData || !populationData) return;

    const svgLcoe = d3.select('#globe-lcoe');
    const svgPop = d3.select('#globe-population');
    const svgLcoeAxes = d3.select('#globe-lcoe-axes');
    const svgPopAxes = d3.select('#globe-pop-axes');
    const lcoeCanvas = document.getElementById('globe-lcoe-dots');
    const popCanvas = document.getElementById('globe-pop-dots');
    if (svgLcoe.empty() || svgPop.empty() || svgLcoeAxes.empty() || svgPopAxes.empty()) return;

    const lcoeContainer = document.getElementById('globe-lcoe-container');
    const popContainer = document.getElementById('globe-pop-container');
    const lcoeFrame = document.getElementById('globe-lcoe-frame');
    const popFrame = document.getElementById('globe-pop-frame');

    const lcoeBox = lcoeFrame || lcoeContainer;
    const popBox = popFrame || popContainer;

    const lcoeWidth = lcoeBox?.clientWidth || lcoeBox?.getBoundingClientRect().width || window.innerWidth;
    const lcoeHeight = lcoeBox?.clientHeight || lcoeBox?.getBoundingClientRect().height || window.innerHeight / 2;
    const popWidth = popBox?.clientWidth || popBox?.getBoundingClientRect().width || window.innerWidth;
    const popHeight = popBox?.clientHeight || popBox?.getBoundingClientRect().height || window.innerHeight / 2;

    const widthLcoe = Math.max(1, lcoeWidth);
    const heightLcoe = Math.max(1, lcoeHeight);
    const widthPop = Math.max(1, popWidth || widthLcoe);
    const heightPop = Math.max(1, popHeight || heightLcoe);

    svgLcoe.attr("viewBox", `0 0 ${widthLcoe} ${heightLcoe}`);
    svgPop.attr("viewBox", `0 0 ${widthPop} ${heightPop}`);
    svgLcoeAxes.attr("viewBox", `0 0 ${widthLcoe} ${heightLcoe}`);
    svgPopAxes.attr("viewBox", `0 0 ${widthPop} ${heightPop}`);

    const fullData = lcoeData.map((d, i) => ({
        ...d,
        _index: i,
        _pop: popByLoc.get(Number(d.location_id)) || 0
    })).filter(d => Number.isFinite(d.longitude) && Number.isFinite(d.latitude));
    if (fullData.length === 0) return;

    const sampleKey = `${fullData.length}-${STEP4_MAX_POINTS}`;
    if (!step4State.sampledData || step4State.sampleKey !== sampleKey) {
        step4State.sampledData = downsampleStep4Data(fullData, STEP4_MAX_POINTS);
        step4State.sampleKey = sampleKey;
    }
    const data = step4State.sampledData;

    const colorInfo = lcoeColorInfo || { type: 'lcoe', domain: [50, 120, 220, 320] };
    const lcoeScale = buildLcoeColorScaleFromInfo(colorInfo);

    const chartMargin = { top: 60, right: 40, bottom: 50, left: 70 };
    const latExtent = d3.extent(fullData, d => d.latitude);
    const latMin = (latExtent[0] ?? -60) - 5;
    const latMax = (latExtent[1] ?? 80) + 5;

    const yLatLcoe = d3.scaleLinear()
        .domain([latMin, latMax])
        .range([heightLcoe - chartMargin.bottom, chartMargin.top]);

    const yLatPop = d3.scaleLinear()
        .domain([latMin, latMax])
        .range([heightPop - chartMargin.bottom, chartMargin.top]);

    const lcoeValues = fullData
        .map(d => Number.isFinite(d.lcoe) ? d.lcoe : (Number.isFinite(d.maxConfigLcoe) ? d.maxConfigLcoe : null))
        .filter(v => v != null);
    const lcoeMax = d3.max(lcoeValues) || 200;
    const xLcoe = d3.scaleLinear()
        .domain([0, lcoeMax])
        .nice()
        .range([chartMargin.left, widthLcoe - chartMargin.right]);

    const bins = buildLatitudeBins(fullData, [latMin, latMax], 5);
    const maxBinPop = d3.max(bins, d => d.totalPop) || 1;
    const xPop = d3.scaleLinear()
        .domain([0, maxBinPop])
        .nice()
        .range([chartMargin.left, widthPop - chartMargin.right]);

    const popSegments = buildPopulationSegments(bins, xPop, yLatPop, d => d.location_id ?? d._index);

    const popScale = d3.scaleLog()
        .domain([1, 10, 100, 1000, 10000, 100000, 1000000])
        .range(["#0b1220", "#0b1f3a", "#1e3a8a", "#1d4ed8", "#3b82f6", "#60a5fa", "#bfdbfe"])
        .clamp(true);

    const t = d3.transition().duration(Number.isFinite(phaseDuration) ? phaseDuration : STEP4_SPLIT_MS);
    const useClip = phase === 'map';

    const projectionLcoe = buildProjection(widthLcoe, heightLcoe);
    const projectionPop = buildProjection(widthPop, heightPop);

    renderStep4Lcoe(svgLcoe, data, {
        width: widthLcoe,
        height: heightLcoe,
        projection: projectionLcoe,
        clipId: 'clip-step4-lcoe',
        useClip,
        lcoeScale,
        colorInfo,
        xScale: xLcoe,
        yScale: yLatLcoe,
        phase,
        prevPhase,
        dotDuration,
        transition: t
    });

    renderStep4Population(svgPop, data, {
        width: widthPop,
        height: heightPop,
        projection: projectionPop,
        clipId: 'clip-step4-pop',
        useClip,
        popScale,
        segments: popSegments.segmentMap,
        xScale: xPop,
        yScale: yLatPop,
        phase,
        prevPhase,
        dotDuration,
        transition: t
    });

    const lcoeCanvasInfo = prepareStep4Canvas(lcoeCanvas, widthLcoe, heightLcoe);
    const popCanvasInfo = prepareStep4Canvas(popCanvas, widthPop, heightPop);

    const needsFadeDelay = (prevPhase === 'map' && phase === 'chart-split');
    const dotDelay = needsFadeDelay ? STEP4_CELL_FADE_MS : 0;

    const dotAnimDuration = Number.isFinite(dotDuration) ? dotDuration : STEP4_SPLIT_MS;

    if (lcoeCanvasInfo) {
        const lcoeDots = buildLcoeCanvasDots(data, {
            phase,
            projection: projectionLcoe,
            xScale: xLcoe,
            yScale: yLatLcoe,
            lcoeScale,
            colorInfo
        });
        renderStep4CanvasDots(lcoeCanvasInfo, step4State.canvas.lcoe, lcoeDots, dotAnimDuration, skipDotAnimation, dotDelay);
    }

    if (popCanvasInfo) {
        const popDots = buildPopCanvasDots(data, {
            phase,
            projection: projectionPop,
            segments: popSegments.segmentMap,
            popScale
        });
        renderStep4CanvasDots(popCanvasInfo, step4State.canvas.pop, popDots, dotAnimDuration, skipDotAnimation, dotDelay);
    }

    renderStep4Axes(svgLcoeAxes, svgPopAxes, {
        phase,
        widthLcoe,
        heightLcoe,
        widthPop,
        heightPop,
        xLcoe,
        xPop,
        yLatLcoe,
        yLatPop,
        margin: chartMargin,
        transition: t
    });
}

function renderStep4Lcoe(svg, data, {
    width,
    height,
    projection,
    clipId,
    useClip,
    lcoeScale,
    colorInfo,
    xScale,
    yScale,
    phase,
    prevPhase,
    dotDuration,
    transition
}) {
    const points = [];
    const pointData = [];

    data.forEach(d => {
        const p = projection([d.longitude, d.latitude]);
        if (!p) return;
        points.push(p);
        pointData.push({ ...d, _mx: p[0], _my: p[1] });
    });

    const showCells = phase === 'map';
    const clipPath = showCells ? applyClip(svg, projection, clipId, useClip) : null;
    const cellsG = ensureGroup(svg, 'step4-lcoe-cells');
    const dotsG = ensureGroup(svg, 'step4-lcoe-dots');
    if (showCells) {
        cellsG.attr('clip-path', clipPath || null);
        dotsG.attr('clip-path', clipPath || null);
    }
    const wasMap = prevPhase === 'map';
    if (!showCells) {
        const shouldFade = wasMap;
        cellsG.interrupt();
        if (shouldFade) {
            cellsG.transition()
                .duration(STEP4_CELL_FADE_MS)
                .ease(d3.easeCubicOut)
                .style('opacity', 0)
                .on('end', () => cellsG.style('pointer-events', 'none'));
        } else {
            cellsG.style('opacity', 0).style('pointer-events', 'none');
        }
    } else {
        cellsG.interrupt();
        if (!wasMap && prevPhase) {
            const delay = prevPhase === 'chart-split' ? (Number.isFinite(dotDuration) ? dotDuration : STEP4_SPLIT_MS) : 0;
            cellsG.style('opacity', 0).style('pointer-events', 'auto')
                .transition()
                .delay(delay)
                .duration(STEP4_CELL_FADE_MS)
                .ease(d3.easeCubicOut)
                .style('opacity', 1);
        } else {
            cellsG.style('opacity', 1).style('pointer-events', 'auto');
        }

        let voronoiCells = [];
        if (points.length > 2) {
            const delaunay = d3.Delaunay.from(points);
            const voronoi = delaunay.voronoi([0, 0, width, height]);
            voronoiCells = points.map((_, i) => voronoi.cellPolygon(i));
        }

        const cells = cellsG.selectAll('path.step4-cell')
            .data(pointData, d => d.location_id ?? d._index);

        const cellsEnter = cells.enter()
            .append('path')
            .attr('class', 'step4-cell')
            .attr('stroke-width', 0.5);

        cells.merge(cellsEnter)
            .attr('d', (d, i) => {
                const cell = voronoiCells[i];
                return cell ? `M${cell.join('L')}Z` : null;
            })
            .attr('fill', d => getLcoeColor(d, colorInfo, lcoeScale))
            .attr('stroke', d => getLcoeColor(d, colorInfo, lcoeScale))
            .attr('fill-opacity', 0.9)
            .attr('stroke-opacity', 0.6);

        cells.exit().remove();
    }

    // Dots are rendered on canvas for performance.
    dotsG.selectAll('*').remove();
}

function renderStep4Population(svg, data, {
    width,
    height,
    projection,
    clipId,
    useClip,
    popScale,
    segments,
    xScale,
    yScale,
    phase,
    prevPhase,
    dotDuration,
    transition
}) {
    const points = [];
    const pointData = [];

    data.forEach(d => {
        const p = projection([d.longitude, d.latitude]);
        if (!p) return;
        points.push(p);
        pointData.push({ ...d, _mx: p[0], _my: p[1] });
    });

    const showCells = phase === 'map';
    const clipPath = showCells ? applyClip(svg, projection, clipId, useClip) : null;
    const cellsG = ensureGroup(svg, 'step4-pop-cells');
    const dotsG = ensureGroup(svg, 'step4-pop-dots');
    if (showCells) {
        cellsG.attr('clip-path', clipPath || null);
        dotsG.attr('clip-path', clipPath || null);
    }
    const wasMap = prevPhase === 'map';
    if (!showCells) {
        const shouldFade = wasMap;
        cellsG.interrupt();
        if (shouldFade) {
            cellsG.transition()
                .duration(STEP4_CELL_FADE_MS)
                .ease(d3.easeCubicOut)
                .style('opacity', 0)
                .on('end', () => cellsG.style('pointer-events', 'none'));
        } else {
            cellsG.style('opacity', 0).style('pointer-events', 'none');
        }
    } else {
        cellsG.interrupt();
        if (!wasMap && prevPhase) {
            const delay = prevPhase === 'chart-split' ? (Number.isFinite(dotDuration) ? dotDuration : STEP4_SPLIT_MS) : 0;
            cellsG.style('opacity', 0).style('pointer-events', 'auto')
                .transition()
                .delay(delay)
                .duration(STEP4_CELL_FADE_MS)
                .ease(d3.easeCubicOut)
                .style('opacity', 1);
        } else {
            cellsG.style('opacity', 1).style('pointer-events', 'auto');
        }

        let voronoiCells = [];
        if (points.length > 2) {
            const delaunay = d3.Delaunay.from(points);
            const voronoi = delaunay.voronoi([0, 0, width, height]);
            voronoiCells = points.map((_, i) => voronoi.cellPolygon(i));
        }

        const cells = cellsG.selectAll('path.step4-cell')
            .data(pointData, d => d.location_id ?? d._index);

        const cellsEnter = cells.enter()
            .append('path')
            .attr('class', 'step4-cell')
            .attr('stroke-width', 0.5);

        cells.merge(cellsEnter)
            .attr('d', (d, i) => {
                const cell = voronoiCells[i];
                return cell ? `M${cell.join('L')}Z` : null;
            })
            .attr('fill', d => (d._pop > 0 ? popScale(d._pop) : '#0b1220'))
            .attr('stroke', d => (d._pop > 0 ? popScale(d._pop) : '#0b1220'))
            .attr('fill-opacity', 0.95)
            .attr('stroke-opacity', 0.6);

        cells.exit().remove();
    }

    // Dots are rendered on canvas for performance.
    dotsG.selectAll('*').remove();
}

function renderStep4Axes(svgLcoe, svgPop, {
    phase,
    widthLcoe,
    heightLcoe,
    widthPop,
    heightPop,
    xLcoe,
    xPop,
    yLatLcoe,
    yLatPop,
    margin,
    transition
}) {
    const showLcoeAxes = phase !== 'map';
    const showPopAxes = phase !== 'map';

    // LCOE axes (always in top svg)
    let axesLcoe = svgLcoe.select('g.step4-axes');
    if (axesLcoe.empty()) {
        axesLcoe = svgLcoe.append('g').attr('class', 'step4-axes').style('pointer-events', 'none');
    }
    axesLcoe.transition(transition).style('opacity', showLcoeAxes ? 1 : 0);
    if (showLcoeAxes) {
        const yAxis = axesLcoe.selectAll('g.y-axis').data([null]);
        yAxis.enter().append('g').attr('class', 'y-axis');
        axesLcoe.select('g.y-axis')
            .attr('transform', `translate(${margin.left}, 0)`)
            .call(d3.axisLeft(yLatLcoe).ticks(7).tickFormat(d => `${d}°`));
        axesLcoe.select('g.y-axis').selectAll('text').attr('fill', '#bdbdbd');
        axesLcoe.select('g.y-axis').selectAll('line').attr('stroke', '#333');
        axesLcoe.select('g.y-axis').select('.domain').attr('stroke', '#555');

        const xAxis = axesLcoe.selectAll('g.x-axis-lcoe').data([null]);
        xAxis.enter().append('g').attr('class', 'x-axis-lcoe');
        const lcoeXAxisY = phase === 'chart-dual' ? margin.top : (heightLcoe - margin.bottom);
        const lcoeAxis = phase === 'chart-dual' ? d3.axisTop(xLcoe) : d3.axisBottom(xLcoe);
        const xAxisSelection = axesLcoe.select('g.x-axis-lcoe');
        xAxisSelection.transition(transition).attr('transform', `translate(0, ${lcoeXAxisY})`);
        xAxisSelection.call(lcoeAxis.ticks(5).tickFormat(d => `$${d}`));
        xAxisSelection.selectAll('text').attr('fill', '#cbd5f5');
        xAxisSelection.selectAll('line').attr('stroke', '#334155');
        xAxisSelection.select('.domain').attr('stroke', '#475569');

        const xLabel = axesLcoe.selectAll('text.x-label-lcoe').data([null]);
        xLabel.enter().append('text').attr('class', 'x-label-lcoe');
        axesLcoe.select('text.x-label-lcoe')
            .attr('x', widthLcoe / 2)
            .attr('text-anchor', 'middle')
            .attr('fill', '#e2e8f0')
            .text('LCOE ($/MWh)')
            .transition(transition)
            .attr('y', phase === 'chart-dual' ? margin.top - 10 : heightLcoe - 10);

        const yLabel = axesLcoe.selectAll('text.y-label').data([null]);
        yLabel.enter().append('text').attr('class', 'y-label');
        axesLcoe.select('text.y-label')
            .attr('transform', 'rotate(-90)')
            .attr('x', -heightLcoe / 2)
            .attr('y', 18)
            .attr('text-anchor', 'middle')
            .attr('fill', '#e2e8f0')
            .text('Latitude');

        axesLcoe.selectAll('g.x-axis-pop').remove();
        axesLcoe.selectAll('text.x-label-pop').remove();
    }

    // Population axes (only in split mode)
    let axesPop = svgPop.select('g.step4-axes');
    if (axesPop.empty()) {
        axesPop = svgPop.append('g').attr('class', 'step4-axes').style('pointer-events', 'none');
    }
    axesPop.transition(transition).style('opacity', showPopAxes ? 1 : 0);
    if (showPopAxes) {
        const yAxis = axesPop.selectAll('g.y-axis').data([null]);
        yAxis.enter().append('g').attr('class', 'y-axis');
        axesPop.select('g.y-axis')
            .attr('transform', `translate(${margin.left}, 0)`)
            .call(d3.axisLeft(yLatPop).ticks(7).tickFormat(d => `${d}°`));
        axesPop.select('g.y-axis').selectAll('text').attr('fill', '#bdbdbd');
        axesPop.select('g.y-axis').selectAll('line').attr('stroke', '#333');
        axesPop.select('g.y-axis').select('.domain').attr('stroke', '#555');

        const xAxis = axesPop.selectAll('g.x-axis-pop').data([null]);
        xAxis.enter().append('g').attr('class', 'x-axis-pop');
        const xAxisSelection = axesPop.select('g.x-axis-pop');
        xAxisSelection.transition(transition).attr('transform', `translate(0, ${heightPop - margin.bottom})`);
        xAxisSelection.call(d3.axisBottom(xPop).ticks(4).tickFormat(d3.format('~s')));
        xAxisSelection.selectAll('text').attr('fill', '#7dd3fc');
        xAxisSelection.selectAll('line').attr('stroke', '#1d4ed8');
        xAxisSelection.select('.domain').attr('stroke', '#2563eb');

        const xLabel = axesPop.selectAll('text.x-label-pop').data([null]);
        xLabel.enter().append('text').attr('class', 'x-label-pop');
        axesPop.select('text.x-label-pop')
            .attr('x', widthPop / 2)
            .attr('text-anchor', 'middle')
            .attr('fill', '#7dd3fc')
            .text('Population')
            .transition(transition)
            .attr('y', heightPop - 10);

        const yLabel = axesPop.selectAll('text.y-label').data([null]);
        yLabel.enter().append('text').attr('class', 'y-label');
        axesPop.select('text.y-label')
            .attr('transform', 'rotate(-90)')
            .attr('x', -heightPop / 2)
            .attr('y', 18)
            .attr('text-anchor', 'middle')
            .attr('fill', '#e2e8f0')
            .text('Latitude');
    }
}

function buildProjection(width, height) {
    const projection = d3.geoNaturalEarth1().translate([width / 2, height / 2]);
    if (worldGeoJSON) {
        projection.fitSize([width, height], worldGeoJSON);
    } else {
        projection.scale(Math.min(width, height) / 5);
    }
    return projection;
}

function applyClip(svg, projection, clipId, enabled) {
    if (!enabled || !worldGeoJSON) return null;
    let defs = svg.select('defs');
    if (defs.empty()) defs = svg.append('defs');
    let clip = defs.select(`#${clipId}`);
    if (clip.empty()) clip = defs.append('clipPath').attr('id', clipId);
    let path = clip.select('path');
    if (path.empty()) path = clip.append('path');
    path.datum(worldGeoJSON).attr('d', d3.geoPath().projection(projection));
    return `url(#${clipId})`;
}

function ensureGroup(svg, className) {
    let g = svg.select(`g.${className}`);
    if (g.empty()) {
        g = svg.append('g').attr('class', className);
    }
    return g;
}

function buildLatitudeBins(data, domain, binSize) {
    const [minLat, maxLat] = domain;
    const start = Math.floor(minLat / binSize) * binSize;
    const end = Math.ceil(maxLat / binSize) * binSize;
    const bins = d3.range(start, end, binSize).map(binStart => ({
        start: binStart,
        end: binStart + binSize,
        items: [],
        totalPop: 0
    }));

    data.forEach(d => {
        if (!Number.isFinite(d.latitude)) return;
        const index = Math.max(0, Math.min(bins.length - 1, Math.floor((d.latitude - start) / binSize)));
        bins[index].items.push(d);
    });

    bins.forEach(bin => {
        bin.totalPop = d3.sum(bin.items, d => Math.max(0, d._pop || 0));
    });

    return bins;
}

function buildPopulationSegments(bins, xScale, yScale, keyFn) {
    const segmentMap = new Map();
    bins.forEach(bin => {
        if (!bin.items.length) return;
        const center = (bin.start + bin.end) / 2;
        const y = yScale(center);
        const height = Math.max(3, Math.abs(yScale(bin.start) - yScale(bin.end)) * 0.7);
        const sorted = bin.items.slice().sort((a, b) => (b._pop || 0) - (a._pop || 0));
        let cumulative = 0;
        sorted.forEach(item => {
            const popVal = Math.max(0, item._pop || 0);
            const x0 = xScale(cumulative);
            cumulative += popVal;
            const x1 = xScale(cumulative);
            segmentMap.set(keyFn(item), { x0, x1, y, height });
        });
    });
    return { segmentMap };
}

function prepareStep4Canvas(canvas, width, height) {
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const displayWidth = Math.max(1, Math.floor(width));
    const displayHeight = Math.max(1, Math.floor(height));
    const targetWidth = Math.round(displayWidth * dpr);
    const targetHeight = Math.round(displayHeight * dpr);
    if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
        canvas.width = targetWidth;
        canvas.height = targetHeight;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    return { ctx, width: displayWidth, height: displayHeight };
}

function buildLcoeCanvasDots(data, { phase, projection, xScale, yScale, lcoeScale, colorInfo }) {
    const dots = [];
    data.forEach(d => {
        const proj = projection([d.longitude, d.latitude]);
        if (!proj) return;
        const [mx, my] = proj;
        const lcoeValue = Number.isFinite(d.lcoe)
            ? d.lcoe
            : (Number.isFinite(d.maxConfigLcoe) ? d.maxConfigLcoe : 0);
        dots.push({
            key: d.location_id ?? d._index,
            x: phase === 'map' ? mx : xScale(lcoeValue),
            y: phase === 'map' ? my : yScale(d.latitude),
            r: phase === 'map' ? 1.7 : 2.1,
            alpha: phase === 'map' ? 1 : 0.85,
            color: getLcoeColor(d, colorInfo, lcoeScale),
            stroke: 'rgba(255,255,255,0.7)',
            strokeWidth: 0.5
        });
    });
    return dots;
}

function buildPopCanvasDots(data, { phase, projection, segments, popScale }) {
    const dots = [];
    data.forEach(d => {
        const proj = projection([d.longitude, d.latitude]);
        if (!proj) return;
        const [mx, my] = proj;
        const key = d.location_id ?? d._index;
        const segment = segments.get(key);
        const cx = phase === 'map' || !segment ? mx : (segment.x0 + segment.x1) / 2;
        const cy = phase === 'map' || !segment ? my : segment.y;
        dots.push({
            key,
            x: cx,
            y: cy,
            r: phase === 'map' ? 1.5 : 1.2,
            alpha: phase === 'map' ? 1 : 0.85,
            color: d._pop > 0 ? popScale(d._pop) : '#0b1220',
            stroke: phase === 'map' ? 'rgba(255,255,255,0.6)' : null,
            strokeWidth: phase === 'map' ? 0.4 : 0
        });
    });
    return dots;
}

function animateStep4CanvasDots(canvasInfo, state, targetPoints, duration, delay = 0) {
    if (!canvasInfo || !state) return;
    const { ctx, width, height } = canvasInfo;
    let prevPoints = state.points || [];
    if (prevPoints.length === 0) {
        prevPoints = targetPoints;
        state.points = targetPoints;
    }
    const prevByKey = new Map(prevPoints.map(p => [p.key, p]));
    const frames = targetPoints.map(p => {
        const prev = prevByKey.get(p.key) || p;
        return {
            ...p,
            sx: prev.x,
            sy: prev.y,
            sr: prev.r,
            sa: prev.alpha
        };
    });

    if (state.animFrame) cancelAnimationFrame(state.animFrame);
    const start = performance.now() + Math.max(0, delay);

    const tick = now => {
        if (now < start) {
            if (prevPoints.length > 0) {
                drawStep4CanvasPoints(ctx, width, height, prevPoints);
            } else {
                drawStep4CanvasPoints(ctx, width, height, targetPoints);
            }
            state.animFrame = requestAnimationFrame(tick);
            return;
        }
        const t = duration <= 0 ? 1 : Math.min(1, (now - start) / duration);
        drawStep4CanvasDots(ctx, width, height, frames, t);
        if (t < 1) {
            state.animFrame = requestAnimationFrame(tick);
        } else {
            state.points = targetPoints;
            state.animFrame = null;
        }
    };

    state.animFrame = requestAnimationFrame(tick);
}

function drawStep4CanvasDots(ctx, width, height, points, t) {
    const tau = Math.PI * 2;
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        const x = lerp(p.sx, p.x, t);
        const y = lerp(p.sy, p.y, t);
        const r = lerp(p.sr, p.r, t);
        const alpha = lerp(p.sa, p.alpha, t);
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.fillStyle = p.color;
        ctx.arc(x, y, r, 0, tau);
        ctx.fill();
        if (p.stroke && p.strokeWidth > 0) {
            ctx.strokeStyle = p.stroke;
            ctx.lineWidth = p.strokeWidth;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;
}

function drawStep4CanvasPoints(ctx, width, height, points) {
    const tau = Math.PI * 2;
    ctx.clearRect(0, 0, width, height);
    for (let i = 0; i < points.length; i += 1) {
        const p = points[i];
        ctx.globalAlpha = p.alpha;
        ctx.beginPath();
        ctx.fillStyle = p.color;
        ctx.arc(p.x, p.y, p.r, 0, tau);
        ctx.fill();
        if (p.stroke && p.strokeWidth > 0) {
            ctx.strokeStyle = p.stroke;
            ctx.lineWidth = p.strokeWidth;
            ctx.stroke();
        }
    }
    ctx.globalAlpha = 1;
}

function renderStep4CanvasDots(canvasInfo, state, targetPoints, duration, skipAnimation, delay = 0) {
    if (!canvasInfo || !state) return;
    if (skipAnimation) {
        if (!state.animFrame) {
            if (state.points) {
                drawStep4CanvasPoints(canvasInfo.ctx, canvasInfo.width, canvasInfo.height, state.points);
            } else {
                animateStep4CanvasDots(canvasInfo, state, targetPoints, duration, delay);
            }
        }
        return;
    }
    animateStep4CanvasDots(canvasInfo, state, targetPoints, duration, delay);
}

function lerp(a, b, t) {
    return a + (b - a) * t;
}

function downsampleStep4Data(data, maxPoints) {
    if (!Array.isArray(data) || data.length <= maxPoints) return data;
    const scored = data.map((d, i) => ({
        d,
        score: hashToUnit(d.location_id ?? d._index ?? i)
    }));
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, maxPoints).map(item => item.d);
}

function hashToUnit(value) {
    const str = String(value);
    let hash = 2166136261;
    for (let i = 0; i < str.length; i += 1) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0) / 4294967295;
}

/**
 * Hide dual globe container and show map
 */
export function hideDualGlobes() {
    clearStep4Timers();
    const container = document.getElementById('dual-globe-container');
    if (container) {
        container.classList.add('hidden');
    }

    const mapEl = document.getElementById('map');
    if (mapEl) mapEl.style.opacity = '1';
}
