import {
    loadSummary, loadPopulationCsv,
    loadGemPlantsCsv,
    loadVoronoiGemCapacityCsv,
    loadElectricityDemandData,
    loadReliabilityCsv,
    loadPvoutPotentialCsv,
    loadVoronoiWaccCsv,
    loadVoronoiLocalCapexCsv,
    loadVoronoiDieselCsv
} from './data.js';
import {
    initMap, updateMap, updatePopulationPolygons, updatePopulationGeo,
    updateLcoeMap, updateCfMap, updateMapWithSampleFrame,
    setSampleLocationClickHandler, capitalRecoveryFactor, updatePopulationSimple,
    initSubsetMap, renderSubsetMap, subsetMap, setAccessMetric, updatePotentialMap,
    updateSupplyMap, setDualMapMode
} from './map.js';
import { initSampleDays, loadSampleWeekData, cleanupSampleDays } from './samples.js';
import {
    capitalizeWord, formatNumber, formatCurrency, coordKey, roundedKey,
    haversineKm, updateToggleUI, capitalRecoveryFactor as crf
} from './utils.js';
import { ALL_FUELS, FUEL_COLORS, TX_WACC, TX_LIFE, BASE_LOAD_MW, DIESEL_THERMAL_KWH_PER_LITER, DIESEL_PRICE_FLOOR_USD_PER_LITER, LCOE_NO_DATA_COLOR, VIEW_MODE_EXPLANATIONS, CF_COLOR_SCALE, POTENTIAL_MULTIPLE_BUCKETS, FEATURE_WORKER_LCOE } from './constants.js';
import { createSharedPopup, buildPlantTooltip } from './tooltip.js';

const d3 = window.d3;

// State
let summaryData = [];
let currentSolar = 5;
let currentBatt = 8;
let currentLocationId = null;
let currentViewMode = 'capacity';
let locationIndex = null;
let lcoeResults = [];
let populationData = [];
let populationCoordIndex = new Map();
let summaryByConfig = new Map();
let summaryStatsByConfig = new Map();
let potentialData = [];
let potentialDataLoaded = false;
let potentialLevel = 'level1';
let potentialDisplayMode = 'total';
let potentialLatBounds = { level1: null, level2: null };
let potentialAreaById = new Map();

let fossilPlants = [];
let fossilCapacity = []; // Keep this as it's used in ensureFossilDataLoaded
let fossilCapacityMap = null; // location_id -> { coal_Announced, ... }
let electricityDemandData = [];
let electricityDemandMap = null; // location_id -> annual_demand_kwh
let reliabilityData = []; // Array of { location_id, avg_reliability, ... }
let reliabilityMap = null; // location_id -> avg_reliability
let waccDataLoaded = false;
let waccMap = new Map(); // location_id -> wacc (fraction)
let waccMode = 'global'; // 'global' or 'local'
let capexDataLoaded = false;
let localCapexMap = new Map(); // location_id -> regional capex anchors
let capexMode = 'global'; // 'global' or 'local'
let localCapexCache = new Map();
let localCapexCacheYear = null;
let dieselDataLoaded = false;
let dieselMap = new Map(); // location_id -> local diesel backup pricing
let dieselPriceMode = 'local'; // 'global' or 'local' — source of diesel assumptions

// State for population view overlay
let populationChartCumulative = true;
let lcoeTargetMode = 'utilization'; // 'utilization' or 'lcoe'
let targetLcoeValue = 90; // $/MWh

// Lazy loading state flags - these datasets are only loaded when their views are accessed
let populationDataLoaded = false;
let fossilDataLoaded = false;
let electricityDataLoaded = false;
let chartJsLoaded = false;
let reliabilityThreshold = 90;

function getHeapMb() {
    const used = performance?.memory?.usedJSHeapSize;
    return Number.isFinite(used) ? (used / 1048576) : null;
}

function startPerf(label, meta = {}) {
    return {
        label,
        meta,
        startMs: performance.now(),
        startHeapMb: getHeapMb()
    };
}

function endPerf(marker, extra = {}) {
    if (!marker) return;
    const endHeapMb = getHeapMb();
    const durationMs = performance.now() - marker.startMs;
    const heapDeltaMb = (Number.isFinite(endHeapMb) && Number.isFinite(marker.startHeapMb))
        ? (endHeapMb - marker.startHeapMb)
        : null;
    console.debug(`[perf] ${marker.label}`, {
        durationMs: Number(durationMs.toFixed(2)),
        heapDeltaMb: Number.isFinite(heapDeltaMb) ? Number(heapDeltaMb.toFixed(3)) : null,
        ...marker.meta,
        ...extra
    });
}

// Dynamic Chart.js loader
async function ensureChartJsLoaded() {
    if (chartJsLoaded || window.Chart) {
        chartJsLoaded = true;
        return;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js';
        script.onload = () => {
            chartJsLoaded = true;
            console.log('Chart.js loaded dynamically');
            resolve();
        };
        script.onerror = () => reject(new Error('Failed to load Chart.js'));
        document.head.appendChild(script);
    });
}

// Lazy data loaders - only load when needed
async function ensurePopulationDataLoaded() {
    if (populationDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading population data...';
        loading.classList.remove('hidden');

        populationData = await loadPopulationCsv();
        populationCoordIndex = buildCoordIndex(populationData);
        populationDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Population data load failed:', err);
        populationData = [];
        populationCoordIndex = new Map();
        loading.classList.add('hidden');
        return false;
    }
}

async function ensurePotentialDataLoaded() {
    if (potentialDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading PVOUT potential data...';
        loading.classList.remove('hidden');

        potentialData = await loadPvoutPotentialCsv();
        potentialAreaById = new Map();
        potentialData.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const area = Number(row.zone_area_km2);
            potentialAreaById.set(row.location_id, Number.isFinite(area) ? area : null);
        });
        potentialDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('PVOUT potential data load failed:', err);
        potentialData = [];
        potentialDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureFossilDataLoaded() {
    if (fossilDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading power plant data...';
        loading.classList.remove('hidden');

        fossilPlants = await loadGemPlantsCsv();
        fossilCapacity = await loadVoronoiGemCapacityCsv();
        fossilCapacityMap = new Map(fossilCapacity.map(row => [row.location_id, row]));

        // Enrich fossil plants with location_id if we have summary data
        if (fossilPlants.length && fossilCapacity.length) {
            const sites = fossilCapacity.map(d => [d.latitude, d.longitude]);
            const delaunay = d3.Delaunay.from(sites);
            fossilPlants.forEach(plant => {
                const idx = delaunay.find(plant.latitude, plant.longitude);
                if (idx !== -1 && fossilCapacity[idx]) {
                    plant.location_id = fossilCapacity[idx].location_id;
                }
            });
            console.log('Enriched fossilPlants with location_ids via spatial join.');
        }

        fossilDataLoaded = true;
        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Fossil data load failed:', err);
        fossilPlants = [];
        fossilCapacity = [];
        fossilCapacityMap = new Map();
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureElectricityDataLoaded() {
    if (electricityDataLoaded) return true;

    try {
        loadingStatus.textContent = 'Loading electricity demand data...';
        loading.classList.remove('hidden');

        electricityDemandData = await loadElectricityDemandData();
        electricityDemandMap = new Map(electricityDemandData.map(row => [row.location_id, row]));
        electricityDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Electricity demand data load failed:', err);
        electricityDemandData = [];
        electricityDemandMap = new Map();
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureReliabilityDataLoaded() {
    if (reliabilityData.length > 0) return true;
    try {
        loadingStatus.textContent = 'Loading reliability data...'; // Assuming showLoading is a helper for this
        loading.classList.remove('hidden'); // Assuming showLoading also handles this
        reliabilityData = await loadReliabilityCsv();
        reliabilityMap = new Map(reliabilityData.map(d => [d.location_id, d]));
        loading.classList.add('hidden'); // Assuming showLoading also handles this
        return true;
    } catch (e) {
        console.error("Failed to load reliability data", e);
        loading.classList.add('hidden'); // Assuming showLoading also handles this
        return false;
    }
}

async function ensureWaccDataLoaded() {
    if (waccDataLoaded) return true;
    try {
        loadingStatus.textContent = 'Loading local WACC data...';
        loading.classList.remove('hidden');

        const data = await loadVoronoiWaccCsv();
        waccMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const waccPercent = Number(row.wacc_percent);
            if (!Number.isFinite(waccPercent)) return;
            waccMap.set(row.location_id, waccPercent / 100);
        });
        waccDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Local WACC load failed:', err);
        waccMap = new Map();
        waccDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureLocalCapexDataLoaded() {
    if (capexDataLoaded) return true;
    try {
        loadingStatus.textContent = 'Loading local CAPEX data...';
        loading.classList.remove('hidden');

        const data = await loadVoronoiLocalCapexCsv();
        localCapexMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const solar2024 = Number(row.solar_2024);
            const solar2035 = Number(row.solar_2035);
            const solar2050 = Number(row.solar_2050);
            const battery2024 = Number(row.battery_2024);
            const battery2035 = Number(row.battery_2035);
            const battery2050 = Number(row.battery_2050);
            if (![solar2024, solar2035, solar2050, battery2024, battery2035, battery2050].every(Number.isFinite)) {
                return;
            }
            localCapexMap.set(row.location_id, {
                region: row.region || null,
                source: row.capex_source || null,
                solar: [solar2024, solar2035, solar2050],
                battery: [battery2024, battery2035, battery2050]
            });
        });
        capexDataLoaded = true;
        localCapexCache.clear();
        localCapexCacheYear = null;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Local CAPEX load failed:', err);
        localCapexMap = new Map();
        capexDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

async function ensureDieselDataLoaded() {
    if (dieselDataLoaded) return true;
    try {
        loadingStatus.textContent = 'Loading diesel backup pricing...';
        loading.classList.remove('hidden');

        const data = await loadVoronoiDieselCsv();
        dieselMap = new Map();
        data.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const diesel2025 = Number(row.diesel_2025_usd_per_liter_avg);
            const diesel2024 = Number(row.diesel_2024_usd_per_liter_avg);
            const price2025 = Number.isFinite(diesel2025) ? diesel2025 : null;
            const price2024 = Number.isFinite(diesel2024) ? diesel2024 : null;
            const price = price2025 ?? price2024;
            const use2025 = price2025 !== null;
            dieselMap.set(row.location_id, {
                price,
                rawPrice: price,
                price2024,
                price2025,
                sourceYear: use2025 ? 2025 : price2024 !== null ? 2024 : null,
                sourceType: use2025 ? row.diesel_2025_source : row.diesel_2024_source,
                sourceDistanceKm: use2025 ? row.diesel_2025_distance_km : row.diesel_2024_distance_km,
                sourceIso3: use2025 ? row.diesel_2025_iso3 : row.diesel_2024_iso3,
                sourceCountry: use2025 ? row.diesel_2025_country : row.diesel_2024_country,
                sourceSeriesName: use2025 ? row.diesel_2025_series_name : row.diesel_2024_series_name,
                selectionMethod: use2025 ? row.diesel_2025_selection_method : row.diesel_2024_selection_method,
                country_iso3: row.country_iso3 || null,
                country_name: row.country_name || null
            });
        });
        dieselDataLoaded = true;

        loading.classList.add('hidden');
        return true;
    } catch (err) {
        console.error('Diesel price load failed:', err);
        dieselMap = new Map();
        dieselDataLoaded = false;
        loading.classList.add('hidden');
        return false;
    }
}

// Load all population-mode data (called when switching to population view)
async function ensurePopulationModeDataLoaded() {
    const results = await Promise.all([
        ensurePopulationDataLoaded(),
        ensureFossilDataLoaded(),
        ensureElectricityDataLoaded(),
        ensureReliabilityDataLoaded()
    ]);
    return results.every(r => r);
}

// LCOE Display Mode Toggle (Delta vs Transmission Cost)
let lcoeDisplayMode = 'delta';
const lcoeDisplayModeButtons = document.querySelectorAll('#lcoe-display-mode button');
if (lcoeDisplayModeButtons && lcoeDisplayModeButtons.length > 0) {
    lcoeDisplayModeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            if (mode === lcoeDisplayMode) return;
            lcoeDisplayMode = mode;
            resetLcoeTimeLegendLock();

            // Update button UI
            lcoeDisplayModeButtons.forEach(b => {
                b.classList.toggle('is-active', b.dataset.mode === mode);
            });

            // Update legend title and scale
            updateLcoeLegendForMode(mode);

            // Trigger map update to re-render with new color scale
            updateUI();
        });
    });
}
const TX_CRF = crf(TX_WACC, TX_LIFE);
let lcoeParams = {
    solarCapex: 720,       // $/kW_AC (converted to DC via ILR)
    batteryCapex: 120,     // $/kWh
    solarOpexPct: 0.015,   // 1.5% of capex annually
    batteryOpexPct: 0.02,  // 2% of capex annually (as requested)
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07,
    ilr: 1.3,
    targetCf: 0.90,
    includeDieselBackup: false,
    dieselBackupMode: 'min-solar',
    dieselCapex: 300,
    dieselEfficiency: 0.35,
    dieselLife: 20,
    dieselPrice: 1.20, // $/liter (used when dieselPriceMode === 'global')
    dieselPriceMode: 'local' // 'global' or 'local' — mirrored from module-level dieselPriceMode for the worker payload
};
let lcoeCostMultipliers = { solar: 1, battery: 1 };
let lcoeTimeYear = new Date().getFullYear();
let lcoeTimePlaying = false;
let lcoeTimeInterval = null;
let lcoeTimeLockActive = false;
let lcoeTimeLockedColorInfo = null;
let lcoeUpdateTimeout = null;
let lcoeReference = null; // Stores the selected location's LCOE result
const DELTA_PERCENTILE = 0.95;
// comparisonMetric removed - now using lcoeDisplayMode ('delta' or 'transmission')
let legendLock = false;
let lockedColorInfo = null;
let lastColorInfo = null;
let lcoeWorker = null;
let lcoeWorkerReady = false;
let lcoeWorkerRequestSeq = 0;
let lcoeWorkerReadyPromise = null;
const lcoeWorkerPending = new Map();
const lcoeWorkerBestCache = new Map();
const lcoeWorkerCfCache = new Map();
const lcoeWorkerInFlight = new Set();
// Note: VIEW_MODE_EXPLANATIONS now imported from constants.js

// DOM Elements
// DOM Elements
const solarSlider = document.getElementById('solar-slider');
const battSlider = document.getElementById('batt-slider');
const solarVal = document.getElementById('solar-val');
const battVal = document.getElementById('batt-val');
const loading = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const viewTabs = document.querySelectorAll('.view-tab'); // New: View Mode Tabs
const primaryControls = document.getElementById('primary-controls'); // New: Primary Controls
const sampleControls = document.getElementById('sample-controls');
const potentialControls = document.getElementById('potential-controls');
const populationControls = document.getElementById('population-controls'); // New: Population Controls
const populationSupplyControls = document.getElementById('population-supply-controls');
const populationControlsToggle = document.getElementById('population-controls-toggle');
const populationSupplyToggle = document.getElementById('population-supply-toggle');
const populationSupplyPanel = document.getElementById('population-supply-panel');
const potentialLevelButtons = document.querySelectorAll('#potential-level-toggle button');
const potentialDisplayButtons = document.querySelectorAll('#potential-display-toggle button');
const legendCapacity = document.getElementById('legend-capacity');
const legendSamples = document.getElementById('legend-samples'); // Note: Removed in HTML, need to check if logic uses it
const legendPotential = document.getElementById('legend-potential');
const legendLcoe = document.getElementById('legend-lcoe');
const legendPopulation = document.getElementById('legend-population');
const legendElectricity = document.getElementById('legend-electricity');
const legendAccess = document.getElementById('legend-access');
const legendStack = document.getElementById('legend-stack');
const legendSupplyStack = document.getElementById('legend-supply-stack');
const legendSupplyCapacity = document.getElementById('legend-supply-capacity');
const legendSupplyLcoe = document.getElementById('legend-supply-lcoe');
const legendSupplyLcoeTitle = document.getElementById('legend-supply-lcoe-title');
const legendSupplyLcoeMin = document.getElementById('legend-supply-lcoe-min');
const legendSupplyLcoeMid = document.getElementById('legend-supply-lcoe-mid');
const legendSupplyLcoeMax = document.getElementById('legend-supply-lcoe-max');
const legendSupplyLcoeRef = document.getElementById('legend-supply-lcoe-ref');
const legendSupplyLcoeBar = document.getElementById('legend-supply-lcoe-bar');
const legendSupplyLcoeNotes = document.getElementById('legend-supply-lcoe-notes');
const legendSupplyPotential = document.getElementById('legend-supply-potential');
const legendSupplyPotentialTitle = document.getElementById('legend-supply-potential-title');
const legendSupplyPotentialBar = document.getElementById('legend-supply-potential-bar');
const legendSupplyPotentialBuckets = document.getElementById('legend-supply-potential-buckets');
const legendSupplyPotentialMin = document.getElementById('legend-supply-potential-min');
const legendSupplyPotentialMax = document.getElementById('legend-supply-potential-max');
const legendPotentialMin = document.getElementById('legend-potential-min');
const legendPotentialMax = document.getElementById('legend-potential-max');
const legendPotentialTitle = document.getElementById('legend-potential-title');
const legendPotentialBar = document.getElementById('legend-potential-bar');
const legendPotentialBuckets = document.getElementById('legend-potential-buckets');

// Stats
const statAvgCf = document.getElementById('stat-avg-cf');
const statMaxCf = document.getElementById('stat-max-cf');

// LCOE Legend Elements
const legendLcoeTitle = document.getElementById('legend-lcoe-title');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendLcoeRef = document.getElementById('legend-lcoe-ref');
const legendLcoeBar = document.getElementById('legend-lcoe-bar');
const comparisonToggle = document.getElementById('comparison-toggle');
const clearRefBtn = document.getElementById('lcoe-clear-ref');
const legendLcoeNotes = document.getElementById('legend-lcoe-notes');
const legendTxExplainer = document.getElementById('legend-tx-explainer');
// Note: LCOE_NO_DATA_COLOR imported from constants.js

// Settings Modal Elements
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfVal = document.getElementById('target-cf-val');
const solarCapexInput = document.getElementById('solar-capex');
const batteryCapexInput = document.getElementById('battery-capex');
const solarOpexInput = document.getElementById('solar-opex');
const batteryOpexInput = document.getElementById('battery-opex');
const solarLifeInput = document.getElementById('solar-life');
const batteryLifeInput = document.getElementById('battery-life');
const waccInput = document.getElementById('wacc');
const ilrInput = document.getElementById('ilr');
const dieselBackupInput = document.getElementById('diesel-backup-toggle');
const dieselBackupModeGroup = document.getElementById('diesel-backup-mode-group');
const dieselBackupModeRadios = document.querySelectorAll('input[name="diesel-backup-mode"]');
const dieselCapexInput = document.getElementById('diesel-capex');
const dieselEfficiencyInput = document.getElementById('diesel-efficiency');
const dieselLifeInput = document.getElementById('diesel-life');
const dieselPriceInput = document.getElementById('diesel-price');
const dieselSourceWrapper = document.getElementById('diesel-source-wrapper');
const dieselGlobalInputs = document.getElementById('diesel-global-inputs');
const capexGlobalInputs = document.getElementById('capex-global-inputs');
const waccGlobalInputs = document.getElementById('wacc-global-inputs');
const targetCfBackupNote = document.getElementById('target-cf-backup-note');
const lcoeTimeSlider = document.getElementById('lcoe-time-slider');
const lcoeTimeYearLabel = document.getElementById('lcoe-time-year');
const lcoeTimeSolarLabel = document.getElementById('lcoe-time-solar');
const lcoeTimeBatteryLabel = document.getElementById('lcoe-time-battery');
const lcoeTimePlayBtn = document.getElementById('lcoe-time-play');
const lcoeTargetModeButtons = document.querySelectorAll('#lcoe-target-mode-toggle button');
const waccSourceButtons = document.querySelectorAll('#wacc-source-toggle button');
const popWaccSourceButtons = document.querySelectorAll('#pop-wacc-source-toggle button');
const capexSourceButtons = document.querySelectorAll('#capex-source-toggle button');
const popCapexSourceButtons = document.querySelectorAll('#pop-capex-source-toggle button');
const targetCfContainer = document.getElementById('target-cf-container');
const targetLcoeContainer = document.getElementById('target-lcoe-container');
const popTargetCfContainer = document.getElementById('pop-target-cf-container');
const targetLcoeInput = document.getElementById('target-lcoe-input');

// Population Elements
const populationBaseButtons = document.querySelectorAll('#population-base-toggle button');
const populationOverlayButtons = document.querySelectorAll('#population-overlay-mode button');
const populationDisplayButtons = document.querySelectorAll('#population-display-toggle button');
const supplyPotentialLevelButtons = document.querySelectorAll('#supply-potential-level-toggle button');
const supplyPotentialDisplayButtons = document.querySelectorAll('#supply-potential-display-toggle button');
const populationViewToggle = document.getElementById('population-view-toggle');
const reliabilityThresholdControl = document.getElementById('reliability-threshold-control');
const reliabilityThresholdSlider = document.getElementById('reliability-threshold-slider');
const reliabilityThresholdVal = document.getElementById('reliability-threshold-val');
const legendPopMin = document.getElementById('legend-pop-min');
const legendPopMax = document.getElementById('legend-pop-max');
const populationFuelFilterWrapper = document.getElementById('plant-fuel-filter');
const plantLegend = document.getElementById('plant-legend');
const plantStatusToggle = document.getElementById('plant-status-toggle');
const plantStatusButtons = document.querySelectorAll('#plant-status-buttons button');
const populationViewHelper = document.getElementById('population-view-helper');
const populationChartsCta = document.getElementById('population-charts-cta');
const populationFuelButtons = document.querySelectorAll('[data-fuel]');
const populationChartMetricButtons = document.querySelectorAll('[data-metric]');
const populationChartLayerButtons = document.querySelectorAll('[data-layer]');
const populationChartOverlayButtons = document.querySelectorAll('[data-chart-overlay]');
const comparisonButtons = document.querySelectorAll('[data-comparison-mode]');
const legendLockBtn = document.getElementById('legend-lock-btn');
const viewModeExplainer = document.getElementById('view-mode-explainer');
const configNote = document.getElementById('config-note');
const legendPopLayerNote = document.getElementById('legend-pop-layer-note');
const populationOverlayConfig = document.getElementById('population-overlay-config');
const populationLcoeWrapper = document.getElementById('population-lcoe-wrapper');
const populationSolarSlider = document.getElementById('population-solar-slider');
const populationSolarVal = document.getElementById('population-solar-val');
const populationBattSlider = document.getElementById('population-batt-slider');
const populationBattVal = document.getElementById('population-batt-val');
const popTargetCfSlider = document.getElementById('pop-target-cf-slider');
const popTargetCfVal = document.getElementById('pop-target-cf-val');
const popSolarCapexInput = document.getElementById('pop-solar-capex');
const popBatteryCapexInput = document.getElementById('pop-battery-capex');
const popSolarOpexInput = document.getElementById('pop-solar-opex');
const popBatteryOpexInput = document.getElementById('pop-battery-opex');
const popSolarLifeInput = document.getElementById('pop-solar-life');
const popBatteryLifeInput = document.getElementById('pop-battery-life');
const popWaccInput = document.getElementById('pop-wacc');
const popIlrInput = document.getElementById('pop-ilr');
const popTargetCfBackupNote = document.getElementById('pop-target-cf-backup-note');
const popDieselBackupInput = document.getElementById('pop-diesel-backup-toggle');
const popDieselBackupModeGroup = document.getElementById('pop-diesel-backup-mode-group');
const popDieselBackupModeRadios = document.querySelectorAll('input[name="pop-diesel-backup-mode"]');
const popDieselCapexInput = document.getElementById('pop-diesel-capex');
const popDieselEfficiencyInput = document.getElementById('pop-diesel-efficiency');
const popDieselLifeInput = document.getElementById('pop-diesel-life');
const popDieselPriceInput = document.getElementById('pop-diesel-price');
const popDieselSourceWrapper = document.getElementById('pop-diesel-source-wrapper');
const popDieselGlobalInputs = document.getElementById('pop-diesel-global-inputs');
const popCapexGlobalInputs = document.getElementById('pop-capex-global-inputs');
const popWaccGlobalInputs = document.getElementById('pop-wacc-global-inputs');
const dieselSourceButtons = document.querySelectorAll('#diesel-source-toggle button');
const popDieselSourceButtons = document.querySelectorAll('#pop-diesel-source-toggle button');
const lcoeControls = document.getElementById('lcoe-controls');
const lcoeTimePanel = document.getElementById('lcoe-time-panel');
const locationPanel = document.getElementById('location-panel');
const locCoordsEl = document.getElementById('loc-coords');
const locValueEl = document.getElementById('loc-value');
const locLabelEl = document.getElementById('loc-label');
const locConfigEl = document.getElementById('loc-config');
const locConfigTextEl = document.getElementById('loc-config-text');
const locTxInfoEl = document.getElementById('loc-tx-info');

// Charts
const mapShell = document.getElementById('map-shell');
const populationChartsContainer = document.getElementById('population-charts');
const populationChartHistogram = document.getElementById('population-chart-histogram');
const populationChartLatMetric = document.getElementById('population-chart-lat-metric');
const populationChartLatPop = document.getElementById('population-chart-lat-pop');
const closeChartsBtn = document.getElementById('close-charts'); // New
const populationChartHistogramTitle = document.getElementById('population-chart-histogram-title');
const populationChartHistogramLabel = document.getElementById('population-chart-histogram-label');
const populationChartLatMetricTitle = document.getElementById('population-chart-lat-metric-title');
const populationChartLatMetricLabel = document.getElementById('population-chart-lat-metric-label');
const populationChartLatPopTitle = document.getElementById('population-chart-lat-pop-title');
const populationChartLatPopLabel = document.getElementById('population-chart-lat-pop-label');
const populationChartMetricLabel = document.getElementById('population-chart-metric-label');
const populationChartLatPopHelper = document.getElementById('population-chart-lat-pop-helper');
const chartTitleDemandLatitude = document.getElementById('chart-title-demand-latitude');
const chartTitleSupplyLatitude = document.getElementById('chart-title-supply-latitude');

// Sample Chart
const sampleChartOverlay = document.getElementById('sample-chart-overlay');
const sampleChartCanvas = document.getElementById('sample-chart-canvas');
const sampleChartClose = document.getElementById('sample-chart-close');
const sampleChartLocation = document.getElementById('sample-chart-location');
const sampleWeekSelect = document.getElementById('sample-week-select');
const timeScrubber = document.getElementById('time-scrubber');
const scrubberTime = document.getElementById('scrubber-time');
const scrubberProgress = document.getElementById('scrubber-progress');
const samplePlayBtn = document.getElementById('sample-play');
const sampleResetBtn = document.getElementById('sample-reset');

// Store original parent of LCOE controls for moving back and forth
let lcoeControlsOriginalParent = null;
let lcoeControlsOriginalNextSibling = null;

let populationDisplayMode = 'map';
let populationCharts = {
    histogram: null,
    latMetric: null,
    latPop: null,
    metric: null
};
let accessCharts = {
    uptime: null,
    supply: null,
    comparison: null
};
let accessMetric = 'reliability';

// Access Charts DOM Elements
const standardChartsContainer = document.getElementById('standard-charts-container');
const accessChartsContainer = document.getElementById('access-charts-container');
const accessChartUptimeCanvas = document.getElementById('access-chart-uptime');
const accessChartSupplyCanvas = document.getElementById('access-chart-supply');
const accessChartComparisonCanvas = document.getElementById('access-chart-comparison');
const accessChartSupplyTitle = document.getElementById('access-chart-supply-title');
const accessChartSupplyDesc = document.getElementById('access-chart-supply-desc');
const accessChartComparisonTitle = document.getElementById('access-chart-comparison-title');
const accessComparisonStat = document.getElementById('access-comparison-stat');
const accessComparisonLabel = document.getElementById('access-comparison-label');
let populationChartMetric = 'cf';
let populationBaseLayer = 'population';
let populationOverlayMode = 'cf';
let populationFuelFilter = new Set(['coal', 'oil_gas', 'bioenergy', 'nuclear']);
let plantStatusFilter = 'announced'; // 'announced' or 'existing'
let locationPanelShowingChartSummary = false;

// Helpers
function buildLocationIndex(data) {
    const index = new Map();
    data.forEach(row => {
        const arr = index.get(row.location_id) || [];
        arr.push(row);
        index.set(row.location_id, arr);
    });
    return index;
}

function getLocationIndex() {
    if (!locationIndex || locationIndex.size === 0) {
        locationIndex = buildLocationIndex(summaryData);
    }
    return locationIndex;
}

function buildCoordIndex(data) {
    const index = new Map();
    data.forEach(row => {
        if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return;
        const key = row._coordKey || coordKey(row.latitude, row.longitude);
        index.set(key, row);
    });
    return index;
}

function getConfigKey(solarGw, battGwh) {
    return `s${solarGw}_b${battGwh}`;
}

function enrichSummaryRows(data) {
    summaryByConfig = new Map();
    summaryStatsByConfig = new Map();

    data.forEach(row => {
        if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude)) return;

        if (!row._coordKey) {
            row._coordKey = coordKey(row.latitude, row.longitude);
        }
        if (!row._configKey) {
            row._configKey = getConfigKey(row.solar_gw, row.batt_gwh);
        }
        if (!Number.isFinite(row._solarKw)) {
            row._solarKw = row.solar_gw * 1_000_000;
        }
        if (!Number.isFinite(row._batteryKwh)) {
            row._batteryKwh = row.batt_gwh * 1_000_000;
        }
        if (!Number.isFinite(row._annualEnergyMwh)) {
            row._annualEnergyMwh = row.annual_cf * 8760 * BASE_LOAD_MW;
        }
    });
}

function buildConfigBucket(key) {
    const rows = [];
    let sum = 0;
    let max = -Infinity;
    let count = 0;
    for (const row of summaryData) {
        if (row._configKey !== key) continue;
        rows.push(row);
        if (Number.isFinite(row.annual_cf)) {
            sum += row.annual_cf;
            if (row.annual_cf > max) max = row.annual_cf;
            count += 1;
        }
    }
    summaryByConfig.set(key, rows);
    summaryStatsByConfig.set(key, {
        avg: count ? sum / count : null,
        max: count ? max : null,
        count
    });
}

function getSummaryForConfig(solarGw, battGwh) {
    const key = getConfigKey(solarGw, battGwh);
    if (!summaryByConfig.has(key)) buildConfigBucket(key);
    return summaryByConfig.get(key) || [];
}

function getSummaryStatsForConfig(solarGw, battGwh) {
    const key = getConfigKey(solarGw, battGwh);
    if (!summaryStatsByConfig.has(key)) buildConfigBucket(key);
    return summaryStatsByConfig.get(key) || null;
}

function describeFuelSelection(set) {
    if (!set || set.size === 0 || set.size === ALL_FUELS.length) return 'fossil';
    if (set.size === 1) return Array.from(set)[0];
    return 'selected fossil';
}

const ALL_LEGENDS = [
    legendCapacity,
    legendSamples,
    legendPotential,
    legendLcoe,
    legendPopulation,
    legendElectricity,
    legendAccess,
    legendSupplyCapacity,
    legendSupplyLcoe,
    legendSupplyPotential
];

function hideAllLegends() {
    ALL_LEGENDS.forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
    if (legendSupplyStack) legendSupplyStack.classList.add('hidden');
}

function hidePopulationLegends() {
    [legendPopulation, legendElectricity, legendAccess].forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
}

function hideSupplyLegends() {
    [legendSupplyCapacity, legendSupplyLcoe, legendSupplyPotential].forEach(legend => {
        if (legend) legend.classList.add('hidden');
    });
    if (legendSupplyStack) legendSupplyStack.classList.add('hidden');
}

// Note: capitalizeWord, haversineKm, coordKey, formatNumber, formatCurrency imported from utils.js
// capitalRecoveryFactor is imported from map.js

function clampCf(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function getDieselInfoForRow(row) {
    if (!dieselMap || !dieselMap.size) return null;
    return dieselMap.get(row.location_id) || null;
}

function hydrateLcoeRowContext(row, params) {
    const localWacc = getRowWacc(row);
    row._wacc = localWacc ?? params.wacc;

    const localCapex = getRowCapex(row);
    row._solarCapex = localCapex?.solar ?? null;
    row._batteryCapex = localCapex?.battery ?? null;

    const dieselInfo = getDieselInfoForRow(row);
    row._dieselRawPriceUsdPerLiter = dieselInfo?.rawPrice ?? dieselInfo?.price ?? null;
    row._dieselSourceYear = dieselInfo?.sourceYear ?? null;
    row._dieselSourceType = dieselInfo?.sourceType ?? null;
    row._dieselSourceDistanceKm = dieselInfo?.sourceDistanceKm ?? null;
    row._dieselSourceCountryIso3 = dieselInfo?.sourceIso3 ?? null;
    row._dieselSourceCountryName = dieselInfo?.sourceCountry ?? null;
    row._dieselSourceSeriesName = dieselInfo?.sourceSeriesName ?? null;

    return { localWacc: row._wacc, localCapex, dieselInfo };
}

function computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params) {
    const priceMode = params?.dieselPriceMode || dieselPriceMode;
    if (priceMode === 'global') {
        const globalPrice = Number.isFinite(params?.dieselPrice) ? params.dieselPrice : null;
        return {
            rawPrice: globalPrice,
            effectivePrice: globalPrice
        };
    }
    const rawPrice = Number.isFinite(dieselInfo?.rawPrice ?? dieselInfo?.price)
        ? (dieselInfo?.rawPrice ?? dieselInfo?.price)
        : null;
    const effectivePrice = Number.isFinite(rawPrice)
        ? Math.max(rawPrice, DIESEL_PRICE_FLOOR_USD_PER_LITER)
        : null;
    return {
        rawPrice,
        effectivePrice
    };
}

function computeDieselFuelCostPerMwh(dieselPriceUsdPerLiter, params) {
    const efficiency = Number.isFinite(params.dieselEfficiency) && params.dieselEfficiency > 0
        ? params.dieselEfficiency
        : null;
    if (!Number.isFinite(dieselPriceUsdPerLiter) || !efficiency) {
        return Infinity;
    }
    return (dieselPriceUsdPerLiter * 1000) / (efficiency * DIESEL_THERMAL_KWH_PER_LITER);
}

function computeLcoeMetrics(row, params) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;
    const solarShareCf = clampCf(row.annual_cf);
    const includeDieselBackup = Boolean(params.includeDieselBackup);
    const firmCf = includeDieselBackup ? 1 : solarShareCf;
    const dieselShareCf = includeDieselBackup ? Math.max(0, 1 - solarShareCf) : 0;

    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const hasLocalSolar = Number.isFinite(row?._solarCapex);
    const hasLocalBattery = Number.isFinite(row?._batteryCapex);
    const baseSolarCapex = hasLocalSolar ? row._solarCapex : params.solarCapex * (lcoeCostMultipliers.solar || 1);
    const baseBatteryCapex = hasLocalBattery ? row._batteryCapex : params.batteryCapex * (lcoeCostMultipliers.battery || 1);
    const solarCapexPerKw = baseSolarCapex / ilr;
    const solarCapex = solarCapexPerKw * solarKw;
    const batteryCapex = baseBatteryCapex * batteryKwh;

    const wacc = Number.isFinite(row?._wacc) ? row._wacc : params.wacc;
    const solarAnnual = solarCapex * capitalRecoveryFactor(wacc, params.solarLife);
    const batteryAnnual = batteryCapex * capitalRecoveryFactor(wacc, params.batteryLife);
    const solarOpex = solarCapex * params.solarOpexPct;
    const batteryOpex = batteryCapex * params.batteryOpexPct;

    let annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    let annualEnergyMWh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : solarShareCf * 8760 * BASE_LOAD_MW;

    let dieselPriceUsdPerLiter = null;
    let dieselSourceYear = null;
    let dieselSourceType = null;
    let dieselSourceDistanceKm = null;
    let dieselSourceCountryIso3 = null;
    let dieselSourceCountryName = null;
    let dieselSourceSeriesName = null;
    let dieselEnergyMwh = 0;
    let dieselFuelCostPerMwh = 0;
    let dieselCapexAnnual = 0;
    let dieselFuelAnnual = 0;
    let dieselLcoeAdder = 0;

    if (includeDieselBackup) {
        const dieselPricing = computeEffectiveDieselPriceUsdPerLiter({
            rawPrice: row._dieselRawPriceUsdPerLiter,
            sourceType: row._dieselSourceType
        }, params);
        dieselPriceUsdPerLiter = dieselPricing.effectivePrice;
        dieselSourceYear = row._dieselSourceYear ?? null;
        dieselSourceType = row._dieselSourceType ?? null;
        dieselSourceDistanceKm = row._dieselSourceDistanceKm ?? null;
        dieselSourceCountryIso3 = row._dieselSourceCountryIso3 ?? null;
        dieselSourceCountryName = row._dieselSourceCountryName ?? null;
        dieselSourceSeriesName = row._dieselSourceSeriesName ?? null;
        annualEnergyMWh = 8760 * BASE_LOAD_MW;
        dieselEnergyMwh = dieselShareCf * annualEnergyMWh;
        dieselFuelCostPerMwh = computeDieselFuelCostPerMwh(dieselPriceUsdPerLiter, params);
        const dieselCapex = BASE_LOAD_MW * 1000 * params.dieselCapex;
        dieselCapexAnnual = dieselCapex * capitalRecoveryFactor(wacc, params.dieselLife);

        if (!Number.isFinite(dieselFuelCostPerMwh)) {
            return {
                lcoe: Infinity,
                annual_cost_usd: Infinity,
                annual_energy_mwh: annualEnergyMWh,
                firm_cf: firmCf,
                solar_share_cf: solarShareCf,
                diesel_share_cf: dieselShareCf,
                diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
                diesel_source_year: dieselSourceYear,
                diesel_source_type: dieselSourceType,
                diesel_source_distance_km: dieselSourceDistanceKm,
                diesel_source_country_iso3: dieselSourceCountryIso3,
                diesel_source_country_name: dieselSourceCountryName,
                diesel_source_series_name: dieselSourceSeriesName,
                diesel_energy_mwh: dieselEnergyMwh,
                diesel_lcoe_adder: Infinity,
                includeDieselBackup
            };
        }

        dieselFuelAnnual = dieselEnergyMwh * dieselFuelCostPerMwh;
        annualCost += dieselCapexAnnual + dieselFuelAnnual;
        dieselLcoeAdder = annualEnergyMWh > 0 ? (dieselCapexAnnual + dieselFuelAnnual) / annualEnergyMWh : Infinity;
    }

    const lcoe = annualEnergyMWh > 0 ? annualCost / annualEnergyMWh : Infinity;
    return {
        lcoe,
        annual_cost_usd: annualCost,
        annual_energy_mwh: annualEnergyMWh,
        firm_cf: firmCf,
        solar_share_cf: solarShareCf,
        diesel_share_cf: dieselShareCf,
        diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
        diesel_source_year: dieselSourceYear,
        diesel_source_type: dieselSourceType,
        diesel_source_distance_km: dieselSourceDistanceKm,
        diesel_source_country_iso3: dieselSourceCountryIso3,
        diesel_source_country_name: dieselSourceCountryName,
        diesel_source_series_name: dieselSourceSeriesName,
        diesel_energy_mwh: dieselEnergyMwh,
        diesel_lcoe_adder: dieselLcoeAdder,
        includeDieselBackup
    };
}

function computeConfigLcoe(row, params) {
    return computeLcoeMetrics(row, params).lcoe;
}

// Per-location constants for LCOE. All rows sharing a location_id share these,
// so we compute once per location instead of once per row.
function precomputeLcoePerLocation(sampleRow, params) {
    const localWacc = getRowWacc(sampleRow);
    const localCapex = getRowCapex(sampleRow);
    const dieselInfo = getDieselInfoForRow(sampleRow);
    const resolvedWacc = Number.isFinite(localWacc) ? localWacc : params.wacc;

    const hasLocalSolar = Number.isFinite(localCapex?.solar);
    const hasLocalBattery = Number.isFinite(localCapex?.battery);
    const baseSolarCapex = hasLocalSolar
        ? localCapex.solar
        : params.solarCapex * (lcoeCostMultipliers.solar || 1);
    const baseBatteryCapex = hasLocalBattery
        ? localCapex.battery
        : params.batteryCapex * (lcoeCostMultipliers.battery || 1);
    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const solarCapexPerKw = baseSolarCapex / ilr;

    const solarCrf = capitalRecoveryFactor(resolvedWacc, params.solarLife);
    const batteryCrf = capitalRecoveryFactor(resolvedWacc, params.batteryLife);
    const solarOpexPct = params.solarOpexPct;
    const batteryOpexPct = params.batteryOpexPct;

    const includeDieselBackup = Boolean(params.includeDieselBackup);
    let dieselPricing = null;
    let dieselFuelCostPerMwh = 0;
    let dieselCapexAnnual = 0;
    let dieselContext = null;
    if (includeDieselBackup) {
        dieselPricing = computeEffectiveDieselPriceUsdPerLiter({
            rawPrice: dieselInfo?.rawPrice ?? dieselInfo?.price ?? null,
            sourceType: dieselInfo?.sourceType ?? null
        }, params);
        dieselFuelCostPerMwh = computeDieselFuelCostPerMwh(dieselPricing.effectivePrice, params);
        const dieselCapex = BASE_LOAD_MW * 1000 * params.dieselCapex;
        const dieselCrf = capitalRecoveryFactor(resolvedWacc, params.dieselLife);
        dieselCapexAnnual = dieselCapex * dieselCrf;
        dieselContext = {
            sourceYear: dieselInfo?.sourceYear ?? null,
            sourceType: dieselInfo?.sourceType ?? null,
            sourceDistanceKm: dieselInfo?.sourceDistanceKm ?? null,
            sourceIso3: dieselInfo?.sourceIso3 ?? null,
            sourceCountry: dieselInfo?.sourceCountry ?? null,
            sourceSeriesName: dieselInfo?.sourceSeriesName ?? null
        };
    }

    return {
        includeDieselBackup,
        solarCapexPerKw,
        baseBatteryCapex,
        solarCrf,
        batteryCrf,
        solarOpexPct,
        batteryOpexPct,
        dieselPricing,
        dieselFuelCostPerMwh,
        dieselCapexAnnual,
        dieselContext
    };
}

function computeLcoeMetricsFast(row, pre) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;
    const solarShareCf = clampCf(row.annual_cf);
    const includeDieselBackup = pre.includeDieselBackup;
    const firmCf = includeDieselBackup ? 1 : solarShareCf;
    const dieselShareCf = includeDieselBackup ? Math.max(0, 1 - solarShareCf) : 0;

    const solarCapex = pre.solarCapexPerKw * solarKw;
    const batteryCapex = pre.baseBatteryCapex * batteryKwh;
    const solarAnnual = solarCapex * pre.solarCrf;
    const batteryAnnual = batteryCapex * pre.batteryCrf;
    const solarOpex = solarCapex * pre.solarOpexPct;
    const batteryOpex = batteryCapex * pre.batteryOpexPct;

    let annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    let annualEnergyMWh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : solarShareCf * 8760 * BASE_LOAD_MW;

    let dieselPriceUsdPerLiter = null;
    let dieselSourceYear = null;
    let dieselSourceType = null;
    let dieselSourceDistanceKm = null;
    let dieselSourceCountryIso3 = null;
    let dieselSourceCountryName = null;
    let dieselSourceSeriesName = null;
    let dieselEnergyMwh = 0;
    let dieselLcoeAdder = 0;

    if (includeDieselBackup) {
        const dp = pre.dieselPricing;
        const dc = pre.dieselContext;
        dieselPriceUsdPerLiter = dp.effectivePrice;
        dieselSourceYear = dc.sourceYear;
        dieselSourceType = dc.sourceType;
        dieselSourceDistanceKm = dc.sourceDistanceKm;
        dieselSourceCountryIso3 = dc.sourceIso3;
        dieselSourceCountryName = dc.sourceCountry;
        dieselSourceSeriesName = dc.sourceSeriesName;
        annualEnergyMWh = 8760 * BASE_LOAD_MW;
        dieselEnergyMwh = dieselShareCf * annualEnergyMWh;

        if (!Number.isFinite(pre.dieselFuelCostPerMwh)) {
            return {
                lcoe: Infinity,
                annual_cost_usd: Infinity,
                annual_energy_mwh: annualEnergyMWh,
                firm_cf: firmCf,
                solar_share_cf: solarShareCf,
                diesel_share_cf: dieselShareCf,
                diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
                diesel_source_year: dieselSourceYear,
                diesel_source_type: dieselSourceType,
                diesel_source_distance_km: dieselSourceDistanceKm,
                diesel_source_country_iso3: dieselSourceCountryIso3,
                diesel_source_country_name: dieselSourceCountryName,
                diesel_source_series_name: dieselSourceSeriesName,
                diesel_energy_mwh: dieselEnergyMwh,
                diesel_lcoe_adder: Infinity,
                includeDieselBackup
            };
        }

        const dieselFuelAnnual = dieselEnergyMwh * pre.dieselFuelCostPerMwh;
        annualCost += pre.dieselCapexAnnual + dieselFuelAnnual;
        dieselLcoeAdder = annualEnergyMWh > 0
            ? (pre.dieselCapexAnnual + dieselFuelAnnual) / annualEnergyMWh
            : Infinity;
    }

    const lcoe = annualEnergyMWh > 0 ? annualCost / annualEnergyMWh : Infinity;
    return {
        lcoe,
        annual_cost_usd: annualCost,
        annual_energy_mwh: annualEnergyMWh,
        firm_cf: firmCf,
        solar_share_cf: solarShareCf,
        diesel_share_cf: dieselShareCf,
        diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
        diesel_source_year: dieselSourceYear,
        diesel_source_type: dieselSourceType,
        diesel_source_distance_km: dieselSourceDistanceKm,
        diesel_source_country_iso3: dieselSourceCountryIso3,
        diesel_source_country_name: dieselSourceCountryName,
        diesel_source_series_name: dieselSourceSeriesName,
        diesel_energy_mwh: dieselEnergyMwh,
        diesel_lcoe_adder: dieselLcoeAdder,
        includeDieselBackup
    };
}

function computeTransmissionMetrics(row, reference, delta) {
    if (!reference || !Number.isFinite(delta)) return null;
    const distanceKm = haversineKm(row.latitude, row.longitude, reference.latitude, reference.longitude);
    const savingsPerMwh = -delta; // positive if row cheaper
    if (!Number.isFinite(distanceKm)) {
        return null;
    }
    const firmCf = Number.isFinite(row.firm_cf) ? row.firm_cf : row.annual_cf;
    if (savingsPerMwh <= 0 || firmCf <= 0) {
        return { distanceKm, savingsPerMwh, breakevenPerGw: 0, breakevenPerGwKm: 0 };
    }
    const annualEnergyMWh = Number.isFinite(row.annual_energy_mwh)
        ? row.annual_energy_mwh
        : firmCf * 8760 * BASE_LOAD_MW;
    const annualPayment = savingsPerMwh * annualEnergyMWh;
    const breakevenPerGw = TX_CRF > 0 ? annualPayment / TX_CRF : 0;
    const breakevenPerGwKm = distanceKm > 0 ? breakevenPerGw / distanceKm : 0;
    return {
        distanceKm,
        savingsPerMwh,
        breakevenPerGw,
        breakevenPerGwKm
    };
}

function getLcoeWorker() {
    if (!FEATURE_WORKER_LCOE || typeof Worker === 'undefined') return null;
    if (lcoeWorker) return lcoeWorker;

    lcoeWorker = new Worker(new URL('./workers/lcoe-worker.js', import.meta.url), { type: 'module' });
    lcoeWorker.onmessage = (event) => {
        const { type, requestId, payload } = event.data || {};
        const pending = lcoeWorkerPending.get(requestId);
        if (!pending) return;
        lcoeWorkerPending.delete(requestId);
        if (type === 'ERROR') {
            pending.reject(new Error(payload?.message || 'LCOE worker error'));
            return;
        }
        pending.resolve(payload || null);
    };
    lcoeWorker.onerror = (event) => {
        console.warn('LCOE worker crashed, using main-thread fallback.', event?.message || event);
        lcoeWorkerReady = false;
        lcoeWorkerReadyPromise = null;
        lcoeWorkerPending.forEach((pending) => pending.reject(new Error('LCOE worker crashed')));
        lcoeWorkerPending.clear();
    };

    return lcoeWorker;
}

function serializeWaccMap() {
    if (!waccMap || !waccMap.size || waccMode !== 'local') return null;
    const out = {};
    waccMap.forEach((value, locationId) => {
        if (Number.isFinite(value)) out[locationId] = value;
    });
    return out;
}

function serializeLocalCapexMap() {
    if (!localCapexMap || !localCapexMap.size || capexMode !== 'local') return null;
    const out = {};
    localCapexMap.forEach((entry, locationId) => {
        if (!entry) return;
        const solar = interpolateLocalCapex(lcoeTimeYear, entry.solar);
        const battery = interpolateLocalCapex(lcoeTimeYear, entry.battery);
        if (!Number.isFinite(solar) || !Number.isFinite(battery)) return;
        out[locationId] = { solar, battery };
    });
    return out;
}

function serializeDieselMap() {
    if (!dieselMap || !dieselMap.size) return null;
    const out = {};
    dieselMap.forEach((entry, locationId) => {
        if (!entry) return;
        out[locationId] = {
            price: entry.price,
            rawPrice: Number.isFinite(entry.rawPrice ?? entry.price) ? (entry.rawPrice ?? entry.price) : null,
            sourceYear: entry.sourceYear ?? null,
            sourceType: entry.sourceType ?? null,
            sourceDistanceKm: entry.sourceDistanceKm ?? null,
            sourceIso3: entry.sourceIso3 ?? null,
            sourceCountry: entry.sourceCountry ?? null,
            sourceSeriesName: entry.sourceSeriesName ?? null
        };
    });
    return out;
}

function postLcoeWorkerMessage(type, payload, timeoutMs = 12000) {
    const worker = getLcoeWorker();
    if (!worker) {
        return Promise.reject(new Error('LCOE worker unavailable'));
    }

    const requestId = ++lcoeWorkerRequestSeq;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            lcoeWorkerPending.delete(requestId);
            reject(new Error(`LCOE worker timeout for ${type}`));
        }, timeoutMs);

        lcoeWorkerPending.set(requestId, {
            resolve: (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            reject: (err) => {
                clearTimeout(timer);
                reject(err);
            }
        });

        worker.postMessage({ type, requestId, payload });
    });
}

function cloneWorkerResults(rows) {
    if (!Array.isArray(rows)) return [];
    const index = getLocationIndex();
    return rows.map((row) => {
        const refList = index?.get(row.location_id);
        const ref = refList && refList.length > 0 ? refList[0] : null;
        return ref ? { ...ref, ...row } : { ...row };
    });
}

function buildWorkerCacheKey(kind, targetValue, params) {
    return JSON.stringify({
        kind,
        targetValue,
        mode: { waccMode, capexMode, dieselPriceMode, year: lcoeTimeYear },
        multipliers: lcoeCostMultipliers,
        params: {
            solarCapex: params.solarCapex,
            batteryCapex: params.batteryCapex,
            solarOpexPct: params.solarOpexPct,
            batteryOpexPct: params.batteryOpexPct,
            solarLife: params.solarLife,
            batteryLife: params.batteryLife,
            wacc: params.wacc,
            ilr: params.ilr,
            targetCf: params.targetCf,
            includeDieselBackup: params.includeDieselBackup,
            dieselBackupMode: params.dieselBackupMode,
            dieselCapex: params.dieselCapex,
            dieselEfficiency: params.dieselEfficiency,
            dieselLife: params.dieselLife,
            dieselPrice: params.dieselPrice,
            dieselPriceMode: params.dieselPriceMode
        }
    });
}

async function ensureLcoeWorkerReady() {
    if (!FEATURE_WORKER_LCOE) return false;
    if (lcoeWorkerReady) return true;
    if (lcoeWorkerReadyPromise) return lcoeWorkerReadyPromise;

    lcoeWorkerReadyPromise = (async () => {
        try {
            const worker = getLcoeWorker();
            if (!worker || !summaryData.length) return false;
            const slimRows = new Array(summaryData.length);
            for (let i = 0; i < summaryData.length; i++) {
                const r = summaryData[i];
                slimRows[i] = {
                    location_id: r.location_id,
                    solar_gw: r.solar_gw,
                    batt_gwh: r.batt_gwh,
                    annual_cf: r.annual_cf,
                    _solarKw: r._solarKw,
                    _batteryKwh: r._batteryKwh,
                    _annualEnergyMwh: r._annualEnergyMwh
                };
            }
            await postLcoeWorkerMessage('INIT_DATA', { rows: slimRows }, 20000);
            lcoeWorkerReady = true;
            return true;
        } catch (err) {
            console.warn('LCOE worker init failed, using main-thread fallback.', err);
            lcoeWorkerReady = false;
            return false;
        } finally {
            lcoeWorkerReadyPromise = null;
        }
    })();

    return lcoeWorkerReadyPromise;
}

function scheduleBestLcoeWorkerCompute(key, targetCf, params) {
    if (!FEATURE_WORKER_LCOE || lcoeWorkerInFlight.has(`best:${key}`)) return;
    lcoeWorkerInFlight.add(`best:${key}`);

    (async () => {
        try {
            const ready = await ensureLcoeWorkerReady();
            if (!ready) return;
            const payload = {
                targetCf,
                params,
                costMultipliers: lcoeCostMultipliers,
                waccByLocation: serializeWaccMap(),
                localCapexByLocation: serializeLocalCapexMap(),
                dieselByLocation: serializeDieselMap()
            };
            const response = await postLcoeWorkerMessage('COMPUTE_BEST_LCOE', payload);
            const results = response?.results || [];
            lcoeWorkerBestCache.set(key, results);
        } catch (err) {
            console.warn('LCOE worker best-config compute failed, using fallback.', err);
        } finally {
            lcoeWorkerInFlight.delete(`best:${key}`);
        }
    })();
}

function scheduleCfAtTargetLcoeWorkerCompute(key, targetLcoe, params) {
    if (!FEATURE_WORKER_LCOE || lcoeWorkerInFlight.has(`cf:${key}`)) return;
    lcoeWorkerInFlight.add(`cf:${key}`);

    (async () => {
        try {
            const ready = await ensureLcoeWorkerReady();
            if (!ready) return;
            const payload = {
                targetLcoe,
                params,
                costMultipliers: lcoeCostMultipliers,
                waccByLocation: serializeWaccMap(),
                localCapexByLocation: serializeLocalCapexMap(),
                dieselByLocation: serializeDieselMap()
            };
            const response = await postLcoeWorkerMessage('COMPUTE_CF_AT_TARGET_LCOE', payload);
            const results = response?.results || [];
            lcoeWorkerCfCache.set(key, results);
        } catch (err) {
            console.warn('LCOE worker CF-at-target compute failed, using fallback.', err);
        } finally {
            lcoeWorkerInFlight.delete(`cf:${key}`);
        }
    })();
}

const LCOE_TIME_ANCHORS = (() => {
    const baseYear = new Date().getFullYear();
    return {
        baseYear,
        solar: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.61 },
            { year: 2050, factor: 0.50 }
        ],
        battery: [
            { year: baseYear, factor: 1.0 },
            { year: 2035, factor: 0.66 },
            { year: 2050, factor: 0.55 }
        ]
    };
})();

function interpolateFactor(year, anchors) {
    if (!anchors?.length) return 1;
    if (year <= anchors[0].year) return anchors[0].factor;
    for (let i = 0; i < anchors.length - 1; i += 1) {
        const a = anchors[i];
        const b = anchors[i + 1];
        if (year <= b.year) {
            const t = (year - a.year) / (b.year - a.year || 1);
            return a.factor + t * (b.factor - a.factor);
        }
    }
    return anchors[anchors.length - 1].factor;
}

function resetLcoeTimeLegendLock() {
    lcoeTimeLockActive = false;
    lcoeTimeLockedColorInfo = null;
}

function applyLcoeTimeYear(year, { lockLegend = true } = {}) {
    const normalizedYear = Math.max(LCOE_TIME_ANCHORS.baseYear, Math.min(2050, year));
    lcoeTimeYear = normalizedYear;
    lcoeCostMultipliers.solar = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.solar);
    lcoeCostMultipliers.battery = interpolateFactor(normalizedYear, LCOE_TIME_ANCHORS.battery);
    resetLocalCapexCache();

    if (lcoeTimeYearLabel) lcoeTimeYearLabel.textContent = normalizedYear;
    if (lcoeTimeSolarLabel) lcoeTimeSolarLabel.textContent = `${Math.round(lcoeCostMultipliers.solar * 100)}%`;
    if (lcoeTimeBatteryLabel) lcoeTimeBatteryLabel.textContent = `${Math.round(lcoeCostMultipliers.battery * 100)}%`;
    if (lcoeTimeSlider) lcoeTimeSlider.value = normalizedYear;

    if (lockLegend) {
        lcoeTimeLockActive = true;
    }

    queueLcoeUpdate();
}

function stopLcoeTimeAnimation() {
    if (lcoeTimeInterval) {
        clearInterval(lcoeTimeInterval);
        lcoeTimeInterval = null;
    }
    lcoeTimePlaying = false;
    if (lcoeTimePlayBtn) lcoeTimePlayBtn.textContent = 'Play';
}

function formatCurrencyLabel(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num} `;
}

function getRowWacc(row) {
    if (waccMode !== 'local' || !waccMap.size) return null;
    const wacc = waccMap.get(row.location_id);
    return Number.isFinite(wacc) ? wacc : null;
}

function resetLocalCapexCache() {
    localCapexCache.clear();
    localCapexCacheYear = null;
}

function interpolateLocalCapex(year, values) {
    if (!Array.isArray(values) || values.length < 3) return null;
    const [v2024, v2035, v2050] = values;
    if (![v2024, v2035, v2050].every(Number.isFinite)) return null;
    if (year <= 2024) return v2024;
    if (year >= 2050) return v2050;
    if (year <= 2035) {
        return v2024 + ((v2035 - v2024) * (year - 2024)) / (2035 - 2024);
    }
    return v2035 + ((v2050 - v2035) * (year - 2035)) / (2050 - 2035);
}

function getRowCapex(row) {
    if (capexMode !== 'local' || !localCapexMap.size) return null;
    if (localCapexCacheYear !== lcoeTimeYear) {
        localCapexCacheYear = lcoeTimeYear;
        localCapexCache.clear();
    }
    const locationId = row.location_id;
    if (localCapexCache.has(locationId)) {
        return localCapexCache.get(locationId);
    }
    const entry = localCapexMap.get(locationId);
    if (!entry) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const solar = interpolateLocalCapex(lcoeTimeYear, entry.solar);
    const battery = interpolateLocalCapex(lcoeTimeYear, entry.battery);
    if (!Number.isFinite(solar) || !Number.isFinite(battery)) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const payload = { solar, battery, region: entry.region, source: entry.source };
    localCapexCache.set(locationId, payload);
    return payload;
}



function computeBestLcoeByLocationLegacy(targetCf, params) {
    const results = [];
    const cheapestFirm = Boolean(params.includeDieselBackup) && params.dieselBackupMode === 'cheapest-firm';
    getLocationIndex().forEach(rows => {
        if (!rows.length) return;
        const pre = precomputeLcoePerLocation(rows[0], params);
        const payloads = [];
        let bestMeeting = null;
        let bestFallback = null;
        let maxSolar = -Infinity;
        let maxBatt = -Infinity;

        rows.forEach(r => {
            const metrics = computeLcoeMetricsFast(r, pre);
            const payload = { ...r, ...metrics, targetCf };
            payloads.push(payload);

            const meetsFirmTarget = cheapestFirm ? true : (r.annual_cf >= targetCf);
            if (meetsFirmTarget) {
                if (!bestMeeting || metrics.lcoe < bestMeeting.lcoe) {
                    bestMeeting = payload;
                }
            }

            if (
                !bestFallback
                || r.annual_cf > bestFallback.annual_cf
                || (r.annual_cf === bestFallback.annual_cf && metrics.lcoe < bestFallback.lcoe)
            ) {
                bestFallback = payload;
            }

            if (r.solar_gw > maxSolar || (r.solar_gw === maxSolar && r.batt_gwh > maxBatt)) {
                maxSolar = r.solar_gw;
                maxBatt = r.batt_gwh;
            }
        });

        const highConfig = payloads.find(p => p.solar_gw === maxSolar && p.batt_gwh === maxBatt) ||
            payloads.reduce((best, p) => {
                if (!best) return p;
                if (p.solar_gw > best.solar_gw) return p;
                if (p.solar_gw === best.solar_gw && p.batt_gwh > best.batt_gwh) return p;
                return best;
            }, null);

        const chosen = bestMeeting ? { ...bestMeeting, meetsTarget: true } :
            bestFallback ? { ...bestFallback, meetsTarget: false } : null;

        if (chosen) {
            chosen.maxConfigSolar = highConfig?.solar_gw ?? null;
            chosen.maxConfigBatt = highConfig?.batt_gwh ?? null;
            chosen.maxConfigLcoe = highConfig?.lcoe ?? null;
            results.push(chosen);
        }
    });
    return results;
}

// Similar to above, but for target LCOE mode: find config with CF closest to achieving target LCOE
function computeCfAtTargetLcoeLegacy(targetLcoe, params) {
    const results = [];
    getLocationIndex().forEach(rows => {
        if (!rows.length) return;
        const pre = precomputeLcoePerLocation(rows[0], params);
        let bestConfig = null;
        let bestFallback = null;

        rows.forEach(r => {
            const metrics = computeLcoeMetricsFast(r, pre);
            const payloadCf = Number.isFinite(metrics.firm_cf) ? metrics.firm_cf : r.annual_cf;
            const payload = { ...r, ...metrics, cf: payloadCf, targetLcoe };

            // Logic: Find Max CF where LCOE <= Target
            if (metrics.lcoe <= targetLcoe) {
                if (!bestConfig) {
                    bestConfig = payload;
                } else if (payload.cf > bestConfig.cf) {
                    bestConfig = payload;
                } else if (payload.cf === bestConfig.cf && payload.lcoe < bestConfig.lcoe) {
                    // Tie-breaker: same max CF, choose lower LCOE
                    bestConfig = payload;
                }
            }

            // Fallback: Track lowest LCOE config if we can't meet target
            if (!bestFallback || metrics.lcoe < bestFallback.lcoe) {
                bestFallback = payload;
            }
        });

        if (bestConfig) {
            results.push({ ...bestConfig, meetsTarget: true, targetLcoeMet: true });
        } else if (bestFallback) {
            results.push({
                ...bestFallback,
                meetsTarget: params.includeDieselBackup ? true : false,
                targetLcoeMet: false
            });
        }
    });

    return results;
}

function computeBestLcoeByLocation(targetCf, params) {
    if (!FEATURE_WORKER_LCOE) {
        return computeBestLcoeByLocationLegacy(targetCf, params);
    }

    const key = buildWorkerCacheKey('best', targetCf, params);
    const cached = lcoeWorkerBestCache.get(key);
    scheduleBestLcoeWorkerCompute(key, targetCf, params);
    if (cached?.length) {
        return cloneWorkerResults(cached);
    }
    return computeBestLcoeByLocationLegacy(targetCf, params);
}

function computeCfAtTargetLcoe(targetLcoe, params) {
    if (!FEATURE_WORKER_LCOE) {
        return computeCfAtTargetLcoeLegacy(targetLcoe, params);
    }

    const key = buildWorkerCacheKey('cf_at_target_lcoe', targetLcoe, params);
    const cached = lcoeWorkerCfCache.get(key);
    scheduleCfAtTargetLcoeWorkerCompute(key, targetLcoe, params);
    if (cached?.length) {
        return cloneWorkerResults(cached);
    }
    return computeCfAtTargetLcoeLegacy(targetLcoe, params);
}

function setLegendGradient(mode) {
    legendLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx');
    if (mode === 'delta') {
        legendLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendLcoeBar.classList.add('legend-gradient-cost');
    }
}

function setSupplyLegendGradient(mode) {
    if (!legendSupplyLcoeBar) return;
    legendSupplyLcoeBar.classList.remove('legend-gradient-cost', 'legend-gradient-delta', 'legend-gradient-tx');
    if (mode === 'delta') {
        legendSupplyLcoeBar.classList.add('legend-gradient-delta');
    } else if (mode === 'tx') {
        legendSupplyLcoeBar.classList.add('legend-gradient-tx');
    } else {
        legendSupplyLcoeBar.classList.add('legend-gradient-cost');
    }
}

function renderSupplyLegendFromInfo(info) {
    if (!legendSupplyLcoeMin || !legendSupplyLcoeMid || !legendSupplyLcoeMax || !legendSupplyLcoeRef) return;
    if (!info) {
        legendSupplyLcoeMin.textContent = '--';
        legendSupplyLcoeMid.textContent = '--';
        legendSupplyLcoeMax.textContent = '--';
        legendSupplyLcoeRef.textContent = 'Reference: --';
        if (legendSupplyLcoeNotes) {
            legendSupplyLcoeNotes.textContent = '';
            legendSupplyLcoeNotes.classList.add('hidden');
        }
        if (legendSupplyLcoeTitle) legendSupplyLcoeTitle.textContent = 'LCOE ($/MWh)';
        setSupplyLegendGradient('cost');
        return;
    }

    if (legendSupplyLcoeTitle) {
        legendSupplyLcoeTitle.textContent = info.title || 'LCOE ($/MWh)';
    }
    legendSupplyLcoeMin.textContent = info.minLabel || '--';
    legendSupplyLcoeMid.textContent = info.midLabel || '--';
    legendSupplyLcoeMax.textContent = info.maxLabel || '--';
    legendSupplyLcoeRef.textContent = info.refLabel || 'Reference: --';
    if (legendSupplyLcoeNotes) {
        legendSupplyLcoeNotes.innerHTML = '';
        const rows = [];
        if (info.underflowLabel) {
            rows.push({
                color: info.underflowColor || '#0b5ea8',
                text: info.underflowLabel
            });
        }
        if (info.noDataLabel) {
            rows.push({
                color: LCOE_NO_DATA_COLOR,
                text: info.noDataSuffix === false
                    ? info.noDataLabel
                    : `${info.noDataLabel} (no data / target not met)`
            });
        }
        if (rows.length) {
            rows.forEach(row => {
                const wrapper = document.createElement('div');
                wrapper.className = 'flex items-center gap-2';
                const swatch = document.createElement('span');
                swatch.style.backgroundColor = row.color;
                swatch.style.display = 'inline-block';
                swatch.style.width = '12px';
                swatch.style.height = '12px';
                swatch.style.borderRadius = '3px';
                const label = document.createElement('span');
                label.textContent = row.text;
                wrapper.appendChild(swatch);
                wrapper.appendChild(label);
                legendSupplyLcoeNotes.appendChild(wrapper);
            });
            legendSupplyLcoeNotes.classList.remove('hidden');
        } else {
            legendSupplyLcoeNotes.classList.add('hidden');
        }
    }
    setSupplyLegendGradient(info.gradient || 'cost');
}

function setViewModeExplanation(mode) {
    if (!viewModeExplainer) return;
    const message = VIEW_MODE_EXPLANATIONS[mode] || VIEW_MODE_EXPLANATIONS.capacity;
    viewModeExplainer.textContent = message;
}

function setInputValue(input, value) {
    if (!input) return;
    input.value = value;
}

function setCheckboxValue(input, checked) {
    if (!input) return;
    input.checked = Boolean(checked);
}

function syncLcoeControlValues() {
    const targetCfPct = Math.round((lcoeParams.targetCf || 0) * 100);

    setInputValue(targetCfSlider, targetCfPct);
    if (targetCfVal) targetCfVal.textContent = targetCfPct;
    setInputValue(popTargetCfSlider, targetCfPct);
    if (popTargetCfVal) popTargetCfVal.textContent = targetCfPct;

    setInputValue(solarCapexInput, lcoeParams.solarCapex);
    setInputValue(popSolarCapexInput, lcoeParams.solarCapex);
    setInputValue(batteryCapexInput, lcoeParams.batteryCapex);
    setInputValue(popBatteryCapexInput, lcoeParams.batteryCapex);
    setInputValue(solarOpexInput, (lcoeParams.solarOpexPct || 0) * 100);
    setInputValue(popSolarOpexInput, (lcoeParams.solarOpexPct || 0) * 100);
    setInputValue(batteryOpexInput, (lcoeParams.batteryOpexPct || 0) * 100);
    setInputValue(popBatteryOpexInput, (lcoeParams.batteryOpexPct || 0) * 100);
    setInputValue(solarLifeInput, lcoeParams.solarLife);
    setInputValue(popSolarLifeInput, lcoeParams.solarLife);
    setInputValue(batteryLifeInput, lcoeParams.batteryLife);
    setInputValue(popBatteryLifeInput, lcoeParams.batteryLife);
    setInputValue(waccInput, (lcoeParams.wacc || 0) * 100);
    setInputValue(popWaccInput, (lcoeParams.wacc || 0) * 100);
    setInputValue(ilrInput, lcoeParams.ilr);
    setInputValue(popIlrInput, lcoeParams.ilr);

    setCheckboxValue(dieselBackupInput, lcoeParams.includeDieselBackup);
    setCheckboxValue(popDieselBackupInput, lcoeParams.includeDieselBackup);
    setInputValue(dieselCapexInput, lcoeParams.dieselCapex);
    setInputValue(popDieselCapexInput, lcoeParams.dieselCapex);
    setInputValue(dieselEfficiencyInput, (lcoeParams.dieselEfficiency || 0) * 100);
    setInputValue(popDieselEfficiencyInput, (lcoeParams.dieselEfficiency || 0) * 100);
    setInputValue(dieselLifeInput, lcoeParams.dieselLife);
    setInputValue(popDieselLifeInput, lcoeParams.dieselLife);
    setInputValue(dieselPriceInput, lcoeParams.dieselPrice);
    setInputValue(popDieselPriceInput, lcoeParams.dieselPrice);

    const backupOn = Boolean(lcoeParams.includeDieselBackup);
    const mode = lcoeParams.dieselBackupMode || 'min-solar';
    dieselBackupModeRadios.forEach(r => { r.checked = r.value === mode; });
    popDieselBackupModeRadios.forEach(r => { r.checked = r.value === mode; });
    if (dieselBackupModeGroup) dieselBackupModeGroup.classList.toggle('hidden', !backupOn);
    if (popDieselBackupModeGroup) popDieselBackupModeGroup.classList.toggle('hidden', !backupOn);
    if (dieselSourceWrapper) dieselSourceWrapper.classList.toggle('hidden', !backupOn);
    if (popDieselSourceWrapper) popDieselSourceWrapper.classList.toggle('hidden', !backupOn);

    const showMainBackupNote = backupOn && mode === 'min-solar' && lcoeTargetMode === 'utilization';
    if (targetCfContainer) targetCfContainer.classList.toggle('hidden', lcoeTargetMode !== 'utilization' || (backupOn && mode === 'cheapest-firm'));
    if (targetCfBackupNote) targetCfBackupNote.classList.toggle('hidden', !showMainBackupNote);
    if (targetCfSlider) targetCfSlider.disabled = false;

    const showPopBackupNote = backupOn && mode === 'min-solar';
    if (popTargetCfContainer) popTargetCfContainer.classList.toggle('hidden', backupOn && mode === 'cheapest-firm');
    if (popTargetCfBackupNote) popTargetCfBackupNote.classList.toggle('hidden', !showPopBackupNote);
    if (popTargetCfSlider) popTargetCfSlider.disabled = false;
}

async function setDieselBackupEnabled(enabled) {
    lcoeParams.includeDieselBackup = Boolean(enabled);
    if (lcoeParams.includeDieselBackup && dieselPriceMode === 'local') {
        await ensureDieselDataLoaded();
    }
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();

    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

function setDieselBackupMode(mode) {
    const normalized = mode === 'cheapest-firm' ? 'cheapest-firm' : 'min-solar';
    if (lcoeParams.dieselBackupMode === normalized) return;
    lcoeParams.dieselBackupMode = normalized;
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();

    if (!lcoeParams.includeDieselBackup) return;

    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

function updatePopulationOverlayControls(mode) {
    const popCfControls = document.getElementById('population-cf-controls');
    const popLcoeControls = document.getElementById('population-lcoe-controls');
    const popPotentialControls = document.getElementById('population-potential-controls');

    // Show CF controls when CF overlay selected
    if (mode === 'cf') {
        if (popCfControls) popCfControls.classList.remove('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }
    // Show LCOE controls when LCOE overlay selected
    else if (mode === 'lcoe') {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.remove('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }
    // Show Potential controls when Potential overlay selected
    else if (mode === 'potential') {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.remove('hidden');
    }
    // Hide all when no overlay
    else {
        if (popCfControls) popCfControls.classList.add('hidden');
        if (popLcoeControls) popLcoeControls.classList.add('hidden');
        if (popPotentialControls) popPotentialControls.classList.add('hidden');
    }

    // Legacy: Handle old overlay config if it exists
    if (populationOverlayConfig) {
        const showCfControls = mode === 'cf';
        populationOverlayConfig.classList.toggle('hidden', !showCfControls);
        if (showCfControls) {
            if (populationSolarSlider) populationSolarSlider.value = currentSolar;
            if (populationSolarVal) populationSolarVal.textContent = currentSolar;
            if (populationBattSlider) populationBattSlider.value = currentBatt;
            if (populationBattVal) populationBattVal.textContent = currentBatt;
        }
    }

    // Show LCOE controls when LCOE overlay selected in population mode
    const showLcoeControls = mode === 'lcoe';
    if (showLcoeControls && populationLcoeWrapper && lcoeControls) {
        // Store original location if not already stored
        if (!lcoeControlsOriginalParent && lcoeControls.parentElement) {
            lcoeControlsOriginalParent = lcoeControls.parentElement;
            lcoeControlsOriginalNextSibling = lcoeControls.nextSibling;
        }

        // Move LCOE controls to population wrapper
        populationLcoeWrapper.classList.remove('hidden');
        if (lcoeControls.parentElement !== populationLcoeWrapper) {
            populationLcoeWrapper.appendChild(lcoeControls);
        }
        lcoeControls.classList.remove('hidden');
    } else if (populationLcoeWrapper) {
        // Hide the wrapper when not in LCOE overlay mode
        populationLcoeWrapper.classList.add('hidden');
    }

    syncLcoeControlValues();
}

function updatePopulationViewHelperCopy() {
    if (!populationViewHelper || !populationChartsCta) return;
    if (populationDisplayMode === 'charts') {
        populationViewHelper.textContent = 'Charts show demand by latitude, supply by latitude, and demand-weighted supply distributions for the selected layers.';
        populationChartsCta.textContent = 'Show map view';
    } else {
        populationViewHelper.textContent = 'Map mode shows the chosen base layer directly; Charts summarize demand and supply by latitude and distribution.';
        populationChartsCta.textContent = 'Show charts';
    }
}

function showMapContainerOnly() {
    const wasHidden = mapShell?.classList.contains('hidden');
    if (mapShell) mapShell.classList.remove('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.add('hidden');
    if (wasHidden) {
        // Give Leaflet a nudge to recalc sizes after being unhidden
        setTimeout(() => window.dispatchEvent(new Event('resize')), 50);
    }
}

function showPopulationChartsOnly() {
    if (mapShell) mapShell.classList.add('hidden');
    if (populationChartsContainer) populationChartsContainer.classList.remove('hidden');
    // Hide all legends when showing charts
    hideAllLegends();
    requestAnimationFrame(updatePopulationChartsBounds);
}

function togglePanelCollapse(panelEl, btnEl) {
    if (!panelEl || !btnEl) return;
    const isCollapsed = panelEl.classList.toggle('is-collapsed');
    btnEl.setAttribute('aria-expanded', String(!isCollapsed));
    btnEl.setAttribute('title', isCollapsed ? 'Expand panel' : 'Collapse panel');
    if (currentViewMode === 'population' && populationDisplayMode === 'charts') {
        requestAnimationFrame(updatePopulationChartsBounds);
    }
}

function updatePopulationChartsBounds() {
    if (!populationChartsContainer) return;
    const gap = 16;
    let leftPad = 16;
    let rightPad = 16;

    if (populationControls && !populationControls.classList.contains('hidden')) {
        const leftRect = populationControls.getBoundingClientRect();
        leftPad = Math.max(leftPad, leftRect.right + gap);
    }

    if (populationSupplyPanel && !populationSupplyPanel.classList.contains('hidden')) {
        const rightRect = populationSupplyPanel.getBoundingClientRect();
        rightPad = Math.max(rightPad, window.innerWidth - rightRect.left + gap);
    }

    populationChartsContainer.style.setProperty('--charts-left-pad', `${leftPad}px`);
    populationChartsContainer.style.setProperty('--charts-right-pad', `${rightPad}px`);
}

function setLocationPanelChartSummary() {
    if (!locationPanel || !locValueEl || !locLabelEl) return;
    locationPanel.classList.remove('hidden');
    if (locCoordsEl) locCoordsEl.textContent = '--';
    locValueEl.textContent = 'All cells';
    locLabelEl.textContent = 'Charts summarize the entire population grid.';
    if (locConfigEl) locConfigEl.classList.add('hidden');
    if (locConfigTextEl) {
        locConfigTextEl.textContent = 'Switch back to Map view to explore individual cells.';
    }
    if (locTxInfoEl) locTxInfoEl.classList.add('hidden');
    locationPanelShowingChartSummary = true;
}

function resetLocationPanelAfterChartSummary() {
    if (!locationPanelShowingChartSummary) return;
    if (locCoordsEl) locCoordsEl.textContent = '--';
    if (locValueEl) locValueEl.textContent = '--';
    if (locLabelEl) locLabelEl.textContent = 'Select a location on the map to inspect it.';
    if (locConfigEl) locConfigEl.classList.add('hidden');
    locationPanelShowingChartSummary = false;
}

function updatePopulationDisplayToggleUI() {
    updateToggleUI(populationDisplayButtons, populationDisplayMode, 'mode');
}

function updatePopulationOverlayToggleUI() {
    updateToggleUI(populationOverlayButtons, populationOverlayMode, 'overlay');
}

function updatePopulationBaseToggleUI() {
    if (!populationBaseButtons || populationBaseButtons.length === 0) return;
    populationBaseButtons.forEach(btn => {
        btn.classList.toggle('is-active', btn.dataset.base === populationBaseLayer);
    });
    // Show/hide plant-specific controls based on base layer
    const showPlantControls = populationBaseLayer === 'plants';
    if (populationFuelFilterWrapper) {
        populationFuelFilterWrapper.classList.toggle('hidden', !showPlantControls);
    }
    if (plantStatusToggle) {
        plantStatusToggle.classList.toggle('hidden', !showPlantControls);
    }
    if (plantLegend) {
        plantLegend.classList.toggle('hidden', !showPlantControls);
    }
    const demandDescription = document.getElementById('population-demand-description');
    if (demandDescription) {
        // Show demand description only when 'Power Demand' (plants) is selected
        demandDescription.classList.toggle('hidden', populationBaseLayer !== 'plants');
    }

    if (reliabilityThresholdControl) {
        const showReliability = populationBaseLayer === 'uptime';
        reliabilityThresholdControl.classList.toggle('hidden', !showReliability);
        if (showReliability) {
            if (reliabilityThresholdSlider) reliabilityThresholdSlider.value = reliabilityThreshold;
            if (reliabilityThresholdVal) reliabilityThresholdVal.textContent = reliabilityThreshold;
        }
    }

    // Update chart titles based on base layer
    const titlePercentile = document.getElementById('chart-title-percentile');
    const titleDemandLatitude = document.getElementById('chart-title-demand-latitude');

    if (populationBaseLayer === 'plants') {
        if (titlePercentile) titlePercentile.textContent = 'Metric by Displaceable Plant Capacity Percentile';
        if (titleDemandLatitude) titleDemandLatitude.textContent = 'Displaceable Capacity by Latitude';
    } else if (populationBaseLayer === 'access') {
        if (titlePercentile) titlePercentile.textContent = 'People Without Access by Supply Metric';
        if (titleDemandLatitude) titleDemandLatitude.textContent = 'People Without Access by Latitude';
    } else if (populationBaseLayer === 'uptime') {
        if (titlePercentile) titlePercentile.textContent = `People Below ${reliabilityThreshold}% Uptime by Supply Metric`;
        if (titleDemandLatitude) titleDemandLatitude.textContent = `People Below ${reliabilityThreshold}% Uptime by Latitude`;
    } else {
        if (titlePercentile) titlePercentile.textContent = 'Metric by Population Percentile';
        if (titleDemandLatitude) titleDemandLatitude.textContent = populationBaseLayer === 'electricity'
            ? 'Electricity Demand by Latitude'
            : 'Population by Latitude';
    }
}

function updateWaccSourceToggleUI() {
    updateToggleUI(waccSourceButtons, waccMode, 'mode');
    updateToggleUI(popWaccSourceButtons, waccMode, 'mode');
    if (waccGlobalInputs) waccGlobalInputs.classList.toggle('hidden', waccMode === 'local');
    if (popWaccGlobalInputs) popWaccGlobalInputs.classList.toggle('hidden', waccMode === 'local');
}

function updateCapexSourceToggleUI() {
    updateToggleUI(capexSourceButtons, capexMode, 'mode');
    updateToggleUI(popCapexSourceButtons, capexMode, 'mode');
    if (capexGlobalInputs) capexGlobalInputs.classList.toggle('hidden', capexMode === 'local');
    if (popCapexGlobalInputs) popCapexGlobalInputs.classList.toggle('hidden', capexMode === 'local');
}

function updateDieselSourceToggleUI() {
    updateToggleUI(dieselSourceButtons, dieselPriceMode, 'mode');
    updateToggleUI(popDieselSourceButtons, dieselPriceMode, 'mode');
    if (dieselGlobalInputs) dieselGlobalInputs.classList.toggle('hidden', dieselPriceMode === 'local');
    if (popDieselGlobalInputs) popDieselGlobalInputs.classList.toggle('hidden', dieselPriceMode === 'local');
}

async function setWaccMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (waccMode === normalized) return;
    waccMode = normalized;
    updateWaccSourceToggleUI();
    resetLcoeTimeLegendLock();
    if (waccMode === 'local') {
        await ensureWaccDataLoaded();
    }
    queueLcoeUpdate();
}

async function setCapexMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (capexMode === normalized) return;
    capexMode = normalized;
    updateCapexSourceToggleUI();
    resetLocalCapexCache();
    resetLcoeTimeLegendLock();
    if (capexMode === 'local') {
        await ensureLocalCapexDataLoaded();
    }
    queueLcoeUpdate();
}

async function setDieselPriceMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (dieselPriceMode === normalized) return;
    dieselPriceMode = normalized;
    lcoeParams.dieselPriceMode = normalized;
    updateDieselSourceToggleUI();
    resetLcoeTimeLegendLock();
    if (dieselPriceMode === 'local' && lcoeParams.includeDieselBackup) {
        await ensureDieselDataLoaded();
    }
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        queueLcoeUpdate();
    }
}

function updatePopulationFuelToggleUI() {
    if (!populationFuelButtons || populationFuelButtons.length === 0) return;
    populationFuelButtons.forEach(btn => {
        const fuel = btn.dataset.fuel;
        const isActive = populationFuelFilter.has(fuel);
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });

    // Update legend items opacity
    const allFuels = ['coal', 'oil_gas', 'bioenergy', 'nuclear'];
    allFuels.forEach(fuel => {
        const item = document.getElementById(`legend - item - ${fuel} `);
        if (item) {
            item.style.opacity = populationFuelFilter.has(fuel) ? '1' : '0.4';
        }
    });
}

function updatePlantStatusToggleUI() {
    updateToggleUI(plantStatusButtons, plantStatusFilter, 'status');
}

// Note: Chart toggle functions use different styling (slate colors) - keeping inline for now
// to preserve visual distinction from main toggle buttons
function updateChartMetricToggleUI() {
    if (!populationChartMetricButtons?.length) return;
    populationChartMetricButtons.forEach(btn => {
        const isActive = btn.dataset.metric === populationChartMetric;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updateChartLayerToggleUI() {
    if (!populationChartLayerButtons?.length) return;
    populationChartLayerButtons.forEach(btn => {
        const isActive = btn.dataset.layer === populationBaseLayer;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function updateChartOverlayToggleUI() {
    if (!populationChartOverlayButtons?.length) return;
    populationChartOverlayButtons.forEach(btn => {
        const isActive = btn.dataset.overlay === populationOverlayMode;
        btn.classList.toggle('bg-slate-700', isActive);
        btn.classList.toggle('text-slate-100', isActive);
        btn.classList.toggle('text-slate-300', !isActive);
    });
}

function syncPotentialToggleUI() {
    if (potentialLevelButtons?.length) {
        updateToggleUI(potentialLevelButtons, potentialLevel, 'level');
    }
    if (potentialDisplayButtons?.length) {
        updateToggleUI(potentialDisplayButtons, potentialDisplayMode, 'display');
    }
    if (supplyPotentialLevelButtons?.length) {
        updateToggleUI(supplyPotentialLevelButtons, potentialLevel, 'level');
    }
    if (supplyPotentialDisplayButtons?.length) {
        updateToggleUI(supplyPotentialDisplayButtons, potentialDisplayMode, 'display');
    }
}

function setPopulationChartMetric(mode) {
    const normalized = mode === 'lcoe' ? 'lcoe' : 'cf';
    populationChartMetric = normalized;
    updateChartMetricToggleUI();
    if (populationOverlayMode !== normalized) {
        populationOverlayMode = normalized;
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls(normalized);
    }
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function setPopulationBaseLayer(mode) {
    const validModes = new Set(['population', 'plants', 'electricity', 'access', 'uptime']);
    const normalized = validModes.has(mode) ? mode : 'population';
    populationBaseLayer = normalized;
    if (normalized === 'access') {
        applyAccessMetric('no_access_pop');
    } else if (normalized === 'uptime') {
        applyAccessMetric('reliability');
    }
    updatePopulationBaseToggleUI();
    updateChartLayerToggleUI();
    updatePopulationFuelToggleUI();
    updatePopulationViewHelperCopy();
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function togglePopulationFuel(fuel) {
    if (!fuel) return;
    const normalized = fuel.toLowerCase();
    if (populationFuelFilter.has(normalized)) {
        if (populationFuelFilter.size === 1) return;
        populationFuelFilter.delete(normalized);
    } else {
        populationFuelFilter.add(normalized);
    }
    updatePopulationFuelToggleUI();
    if (populationBaseLayer === 'plants' && currentViewMode === 'population') {
        updatePopulationView();
    }
}

function setPopulationDisplayMode(mode) {
    const normalized = mode === 'charts' ? 'charts' : 'map';
    populationDisplayMode = normalized;
    updatePopulationDisplayToggleUI();
    updatePopulationViewHelperCopy();
    setDualMapMode(currentViewMode === 'population' && populationDisplayMode === 'map');
    if (currentViewMode === 'population') {
        updatePopulationView();
    }
}

function moveLcoeControlsToOriginalPosition() {
    // Move LCOE controls back to their original position for LCOE view mode
    if (lcoeControls && lcoeControlsOriginalParent && lcoeControls.parentElement !== lcoeControlsOriginalParent) {
        if (lcoeControlsOriginalNextSibling) {
            lcoeControlsOriginalParent.insertBefore(lcoeControls, lcoeControlsOriginalNextSibling);
        } else {
            lcoeControlsOriginalParent.appendChild(lcoeControls);
        }
    }
}

function updatePopulationLegend(popData, overlayMode = 'none', baseLayer = 'population') {
    if (currentViewMode !== 'population') return;
    const legendElecMin = document.getElementById('legend-elec-min');
    const legendElecMax = document.getElementById('legend-elec-max');
    const legendAccessBar = document.getElementById('legend-access-bar');
    const legendAccessTitle = document.getElementById('legend-access-title');
    const legendAccessMin = document.getElementById('legend-access-min');
    const legendAccessMid = document.getElementById('legend-access-mid');
    const legendAccessMax = document.getElementById('legend-access-max');
    const legendAccessNote = document.getElementById('legend-access-note');

    // Hide all by default
    hidePopulationLegends();

    // Show Energy Access legend if access overlay is active OR if access/uptime is the base layer
    if ((overlayMode === 'access' || baseLayer === 'access' || baseLayer === 'uptime') && legendAccess) {
        legendAccess.classList.remove('hidden');
    }

    if (baseLayer === 'electricity') {
        // Show electricity legend
        if (!legendElectricity) return;
        if (electricityDemandData && electricityDemandData.length > 0) {
            const vals = electricityDemandData.map(d => d.annual_demand_kwh || 0).filter(v => v > 0);
            const maxKwh = Math.max(...vals, 0);
            const maxTwh = maxKwh / 1e9; // Convert to TWh
            if (legendElecMin) legendElecMin.textContent = '0';
            if (legendElecMax) legendElecMax.textContent = maxTwh > 0 ? maxTwh.toFixed(1) + ' TWh' : '--';
        }
        legendElectricity.classList.remove('hidden');
    } else if (baseLayer === 'plants') {
        // No population/electricity legend for plant bubbles view
        return;
    } else if (baseLayer === 'access' || baseLayer === 'uptime') {
        // Energy Access legend is already shown above, don't show population
        // Just update note if present
        const legendAccessToggle = document.getElementById('legend-access-toggle');
        if (legendAccessToggle) {
            // Hide toggle when access/reliability are separate tabs
            legendAccessToggle.classList.add('hidden');
        }
        if (legendAccessBar) {
            if (accessMetric === 'no_access_pop') {
                legendAccessBar.style.background = 'linear-gradient(to right, #1e293b, #991b1b, #ff0000)';
            } else if (accessMetric === 'no_access') {
                legendAccessBar.style.background = 'linear-gradient(to right, #ef4444, #eab308, #22c55e)';
            } else {
                legendAccessBar.style.background = 'linear-gradient(to right, #ef4444, #6b7280)';
            }
        }
        if (legendAccessTitle) {
            legendAccessTitle.textContent = accessMetric === 'no_access_pop'
                ? 'Population Without Access'
                : 'Grid Reliability';
        }
        if (legendAccessMin && legendAccessMid && legendAccessMax) {
            if (accessMetric === 'no_access_pop') {
                legendAccessMin.textContent = 'Low';
                legendAccessMid.textContent = '';
                legendAccessMax.textContent = 'High';
            } else {
                legendAccessMin.textContent = '0%';
                legendAccessMid.textContent = '';
                legendAccessMax.textContent = '100%';
            }
        }
        if (legendAccessNote) {
            legendAccessNote.textContent = accessMetric === 'no_access_pop'
                ? 'Dark grey: universal access'
                : 'No Data (HREA not covered)';
        }
        if (legendPopLayerNote) {
            if (accessMetric === 'no_access_pop') {
                legendPopLayerNote.textContent = 'Color: population without electricity access (log scale).';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (accessMetric === 'no_access') {
                legendPopLayerNote.textContent = 'Color: share of population without access (percent).';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else {
                legendPopLayerNote.textContent = 'Color: average grid uptime (reliability) for each cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            }
        }
    } else {
        const legendAccessToggle = document.getElementById('legend-access-toggle');
        if (legendAccessToggle) {
            legendAccessToggle.classList.remove('hidden');
        }
        // Show population legend
        if (!legendPopulation || !legendPopMin || !legendPopMax) return;
        if (!popData || popData.length === 0) {
            return;
        }
        const vals = popData.map(p => p.population_2020 || 0).filter(Number.isFinite);
        const max = Math.max(...vals, 0);
        legendPopMin.textContent = '0';
        legendPopMax.textContent = max ? formatNumber(max, 0) : '--';
        legendPopulation.classList.remove('hidden');
        if (legendPopLayerNote) {
            if (overlayMode === 'cf') {
                legendPopLayerNote.textContent = 'Color: capacity factor map for the current solar + storage build.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (overlayMode === 'lcoe') {
                legendPopLayerNote.textContent = 'Color: LCOE for each viable cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else if (overlayMode === 'access') {
                legendPopLayerNote.textContent = 'Color: average grid uptime (reliability) for each cell.';
                legendPopLayerNote.classList.remove('text-slate-500');
                legendPopLayerNote.classList.add('text-slate-300');
            } else {
                legendPopLayerNote.textContent = 'Color: population shading only (no additional metric selected).';
                legendPopLayerNote.classList.remove('text-slate-300');
                legendPopLayerNote.classList.add('text-slate-500');
            }
        }
    }
}

function updateSupplyLegend(overlayMode = 'none', lcoeColorInfo = null, potentialState = null) {
    if (currentViewMode !== 'population' || populationDisplayMode !== 'map') {
        hideSupplyLegends();
        return;
    }
    if (!legendSupplyStack) return;
    if (!overlayMode || overlayMode === 'none') {
        hideSupplyLegends();
        return;
    }

    legendSupplyStack.classList.remove('hidden');
    if (legendSupplyCapacity) legendSupplyCapacity.classList.add('hidden');
    if (legendSupplyLcoe) legendSupplyLcoe.classList.add('hidden');
    if (legendSupplyPotential) legendSupplyPotential.classList.add('hidden');

    if (overlayMode === 'cf') {
        if (legendSupplyCapacity) legendSupplyCapacity.classList.remove('hidden');
    } else if (overlayMode === 'lcoe') {
        if (legendSupplyLcoe) legendSupplyLcoe.classList.remove('hidden');
        renderSupplyLegendFromInfo(lcoeColorInfo);
    } else if (overlayMode === 'potential') {
        if (legendSupplyPotential) legendSupplyPotential.classList.remove('hidden');
        const hasData = potentialState && potentialState.valueCount;
        const isMultiple = potentialState?.isMultiple;
        if (legendSupplyPotentialTitle) {
            legendSupplyPotentialTitle.textContent = isMultiple
                ? 'Solar Generation Potential / Electricity Demand Today (x multiple)'
                : 'Solar Generation Potential (TWh/yr)';
        }
        if (legendSupplyPotentialBar) {
            legendSupplyPotentialBar.classList.toggle('legend-gradient-potential-multiple', Boolean(isMultiple));
            legendSupplyPotentialBar.classList.toggle('legend-gradient-potential', !isMultiple);
            legendSupplyPotentialBar.classList.toggle('hidden', Boolean(isMultiple));
        }
        if (legendSupplyPotentialBuckets) {
            legendSupplyPotentialBuckets.classList.toggle('hidden', !isMultiple);
            if (isMultiple) {
                const noData = `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-sm" style="background:#6b7280"></span><span>No data</span></div>`;
                const items = POTENTIAL_MULTIPLE_BUCKETS.map(bucket => (
                    `<div class="flex items-center gap-2"><span class="w-3 h-3 rounded-sm" style="background:${bucket.color}"></span><span>${bucket.label}</span></div>`
                ));
                legendSupplyPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
            }
        }
        if (legendSupplyPotentialMin) {
            legendSupplyPotentialMin.textContent = hasData && !isMultiple
                ? formatNumber(potentialState.min, 2)
                : '';
            legendSupplyPotentialMin.classList.toggle('hidden', Boolean(isMultiple));
        }
        if (legendSupplyPotentialMax) {
            legendSupplyPotentialMax.textContent = hasData && !isMultiple
                ? formatNumber(potentialState.max, 2)
                : '';
            legendSupplyPotentialMax.classList.toggle('hidden', Boolean(isMultiple));
        }
    } else {
        hideSupplyLegends();
    }
}

function setConfigNoteVisibility(show) {
    if (!configNote) return;
    configNote.classList.toggle('hidden', !show);
}

function updateComparisonToggleUI() {
    if (!comparisonButtons || comparisonButtons.length === 0) return;
    comparisonButtons.forEach(btn => {
        const isActive = btn.dataset.mode === comparisonMetric;
        btn.classList.toggle('bg-slate-800', isActive);
        btn.classList.toggle('text-slate-200', isActive);
        btn.classList.toggle('bg-slate-900', !isActive);
        btn.classList.toggle('text-slate-400', !isActive);
    });
}

function updateLegendLockButton() {
    if (!legendLockBtn) return;
    if (!lcoeReference) {
        legendLockBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        legendLockBtn.textContent = 'Fix legend scales';
    } else {
        legendLockBtn.classList.remove('hidden');
        legendLockBtn.textContent = legendLock ? 'Release legend scales' : 'Fix legend scales';
    }
}

function renderLegendFromInfo(info) {
    if (!info) {
        legendLcoeMin.textContent = '--';
        legendLcoeMid.textContent = '--';
        legendLcoeMax.textContent = '--';
        legendLcoeRef.textContent = 'Reference: --';
        if (legendLcoeNotes) {
            legendLcoeNotes.textContent = '';
            legendLcoeNotes.classList.add('hidden');
        }
        if (legendLcoeTitle) legendLcoeTitle.textContent = 'LCOE ($/MWh)';
        setLegendGradient('cost');
        legendTxExplainer?.classList.add('hidden');
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        updateLegendLockButton();
        return;
    }

    if (legendLcoeTitle) {
        legendLcoeTitle.textContent = info.title || 'LCOE ($/MWh)';
    }
    legendLcoeMin.textContent = info.minLabel || '--';
    legendLcoeMid.textContent = info.midLabel || '--';
    legendLcoeMax.textContent = info.maxLabel || '--';
    legendLcoeRef.textContent = info.refLabel || 'Reference: --';
    if (legendLcoeNotes) {
        legendLcoeNotes.innerHTML = '';
        const rows = [];
        if (info.underflowLabel) {
            rows.push({
                color: info.underflowColor || '#0b5ea8',
                text: info.underflowLabel
            });
        }
        if (info.noDataLabel) {
            rows.push({
                color: LCOE_NO_DATA_COLOR,
                text: info.noDataSuffix === false
                    ? info.noDataLabel
                    : `${info.noDataLabel} (no data / target not met)`
            });
        }
        if (rows.length) {
            rows.forEach(row => {
                const wrapper = document.createElement('div');
                wrapper.className = 'flex items-center gap-2';
                const swatch = document.createElement('span');
                swatch.style.backgroundColor = row.color;
                swatch.style.display = 'inline-block';
                swatch.style.width = '12px';
                swatch.style.height = '12px';
                swatch.style.borderRadius = '3px';
                const label = document.createElement('span');
                label.textContent = row.text;
                wrapper.appendChild(swatch);
                wrapper.appendChild(label);
                legendLcoeNotes.appendChild(wrapper);
            });
            legendLcoeNotes.classList.remove('hidden');
        } else {
            legendLcoeNotes.classList.add('hidden');
        }
    }
    setLegendGradient(info.gradient || 'cost');
    if (legendTxExplainer) {
        if (info.type === 'tx') {
            legendTxExplainer.classList.remove('hidden');
        } else {
            legendTxExplainer.classList.add('hidden');
        }
    }

    if (info.showComparison) {
        comparisonToggle.classList.remove('hidden');
        clearRefBtn.classList.remove('hidden');
        updateComparisonToggleUI();
        updateLegendLockButton();
    } else {
        comparisonToggle.classList.add('hidden');
        clearRefBtn.classList.add('hidden');
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }
}

function updateLcoeLegendForMode(mode) {
    // Update legend when display mode changes
    // This will be handled by the next updateModel() call
    // which will call prepareLcoeDisplayData() -> updateLcoeLegend()
}

function updateLcoeLegend(points, overrideInfo = null) {
    if (overrideInfo) {
        renderLegendFromInfo(overrideInfo);
        return overrideInfo;
    }

    const valid = points.filter(p => p.meetsTarget && Number.isFinite(p.lcoe));
    if (!valid.length) {
        const info = {
            type: 'lcoe',
            title: 'LCOE ($/MWh)',
            minLabel: '--',
            midLabel: '--',
            maxLabel: '--',
            refLabel: 'Reference: --',
            gradient: 'cost',
            showComparison: false,
            domain: null
        };
        renderLegendFromInfo(info);
        return info;
    }

    if (lcoeReference) {
        if (lcoeDisplayMode === 'transmission') {
            const txValues = points
                .filter(p => p.meetsTarget && p.txMetrics && p.txMetrics.breakevenPerGwKm > 0)
                .map(p => p.txMetrics.breakevenPerGwKm)
                .sort((a, b) => a - b);
            let domain;
            let minLabel = '$0/MW/km';
            let midLabel = '--';
            let maxLabel = '--';
            if (txValues.length) {
                const pick = (q) => txValues[Math.min(txValues.length - 1, Math.max(0, Math.floor(q * txValues.length)))];
                const rawMax = pick(0.95) || txValues[txValues.length - 1];
                const max = Math.max(rawMax, 1);
                const mid = Math.max(pick(0.5), max * 0.5);
                domain = [0, mid, max];
                midLabel = `${formatCurrencyLabel(mid / 1000)} /MW/km`;
                maxLabel = `${formatCurrencyLabel(max / 1000)} /MW/km`;
            } else {
                domain = [0, 1, 1];
            }
            const info = {
                type: 'tx',
                domain,
                title: 'Breakeven Transmission ($/MW/km)',
                minLabel,
                midLabel,
                maxLabel,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'tx',
                showComparison: true,
                noDataLabel: `> ${maxLabel}`
            };
            renderLegendFromInfo(info);
            return info;
        }

        const withDelta = points.filter(p => p.meetsTarget && Number.isFinite(p.delta));
        let info;
        if (!withDelta.length) {
            info = {
                type: 'delta',
                maxAbs: 1,
                title: 'LCOE Δ ($/MWh)',
                minLabel: '--',
                midLabel: '$0',
                maxLabel: '--',
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: ''
            };
        } else {
            const absVals = withDelta.map(p => Math.abs(p.delta)).sort((a, b) => a - b);
            const pick = (q) => absVals[Math.min(absVals.length - 1, Math.max(0, Math.floor(q * absVals.length)))];
            const maxAbs = Math.max(1, pick(DELTA_PERCENTILE) || absVals[absVals.length - 1] || 1);
            const labelVal = Math.max(1, Math.round(maxAbs));
            info = {
                type: 'delta',
                maxAbs: labelVal,
                title: 'LCOE Δ ($/MWh)',
                minLabel: `-${formatCurrencyLabel(labelVal)}`,
                midLabel: '$0',
                maxLabel: `+${formatCurrencyLabel(labelVal)}`,
                refLabel: `Reference: ${formatCurrencyLabel(lcoeReference.lcoe)}/MWh`,
                gradient: 'delta',
                showComparison: true,
                noDataLabel: `Outside target CF`
            };
        }
        renderLegendFromInfo(info);
        return info;
    }

    const min = 0;
    const median = 100;
    const max = 200;

    const domain = [0, 30, 90, 130, 165, 200];
    const info = {
        type: 'lcoe',
        domain,
        title: 'LCOE ($/MWh)',
        minLabel: formatCurrencyLabel(min),
        midLabel: formatCurrencyLabel(median),
        maxLabel: formatCurrencyLabel(max),
        refLabel: 'Reference: --',
        gradient: 'cost',
        showComparison: false,
        noDataLabel: `≥ ${formatCurrencyLabel(max)} or no data`,
        noDataSuffix: false
    };
    renderLegendFromInfo(info);
    return info;
}

// Legend for CF mode (Target LCOE)
function updateCfLegend(points) {
    // User requested fixed 0-100% scale
    const info = {
        type: 'cf',
        domain: [0, 0.33, 0.66, 1.0],
        title: 'Capacity Factor (%)',
        minLabel: '0%',
        midLabel: '50%',
        maxLabel: '100%',
        refLabel: lcoeReference ? `Reference: ${(lcoeReference.cf * 100).toFixed(0)}%` : '',
        gradient: 'cost',
        showComparison: Boolean(lcoeReference)
    };

    renderLegendFromInfo(info);
    return info;
}

function queueLcoeUpdate() {
    // Check if we need to update LCOE view
    const isLcoeMode = currentViewMode === 'lcoe';
    const isPopulationWithLcoeOverlay = currentViewMode === 'population' && populationOverlayMode === 'lcoe';

    if (!isLcoeMode && !isPopulationWithLcoeOverlay) return;

    if (lcoeUpdateTimeout) {
        clearTimeout(lcoeUpdateTimeout);
    }
    lcoeUpdateTimeout = setTimeout(() => {
        lcoeUpdateTimeout = null;
        if (currentViewMode === 'lcoe') {
            updateLcoeView();
        } else if (currentViewMode === 'population') {
            updatePopulationView();
        }
    }, 150);
}

function getPotentialMetricFromRow(row, potentialState) {
    if (!row || !potentialState) return null;
    const level = potentialState.level || 'level1';
    const totalKey = level === 'level2' ? 'total_level2_twh_y' : 'total_level1_twh_y';
    const groundKey = level === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const rawTotal = Number(row[totalKey]);
    const total = Number.isFinite(rawTotal) ? rawTotal : Number(row[groundKey] || 0);
    const latVal = Number(row.latitude);
    const bounds = potentialState.latBounds;
    if (bounds && (!Number.isFinite(latVal) || latVal < bounds.min || latVal > bounds.max)) {
        return null;
    }
    if (!Number.isFinite(total)) return null;
    if (potentialState.displayMode === 'multiple') {
        const demandRow = potentialState.demandMap ? potentialState.demandMap.get(row.location_id) : null;
        const demandKwh = demandRow ? Number(demandRow.annual_demand_kwh || 0) : 0;
        const demandTwh = demandKwh > 0 ? demandKwh / 1e9 : 0;
        if (demandTwh <= 0) return null;
        return total / demandTwh;
    }
    return total;
}

function buildPopulationMetrics(enrichedPop, overlayMode, cfData, lcoeData, potentialState = null) {
    const cfByCoord = new Map(cfData.map(d => [coordKey(d.latitude, d.longitude), d]));
    const lcoeByCoord = new Map(lcoeData.map(d => [coordKey(d.latitude, d.longitude), d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    const potentialByCoord = potentialState?.data ? new Map(potentialState.data.map(d => [coordKey(d.latitude, d.longitude), d])) : null;
    return enrichedPop.map((p, idx) => {
        const key = coordKey(p.latitude, p.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const potentialRow = potentialById?.get(p.location_id) || potentialByCoord?.get(key);
        const weight = Math.max(0, p.population_2020 || 0);
        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfRow?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeRow?.lcoe;
        } else if (overlayMode === 'potential') {
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
        } else {
            metricVal = weight;
        }
        if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
            return null;
        }
        // Get location_id from cfRow or lcoeRow (they should have it)
        const location_id = cfRow?.location_id ?? lcoeRow?.location_id ?? potentialRow?.location_id ?? p.location_id ?? idx;
        return {
            location_id,
            latitude: p.latitude,
            longitude: p.longitude,
            metric: metricVal,
            weight
        };
    }).filter(m => {
        if (!m) return false;
        if (overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') {
            return Number.isFinite(m.metric);
        }
        return m.weight > 0;
    });
}

// Note: FUEL_COLORS now imported from constants.js

function buildPlantMetrics(capacityRows, overlayMode, cfData, lcoeData, selectedFuels, statusFilter, potentialState = null) {
    const cfById = new Map(cfData.map(d => [d.location_id, d]));
    const lcoeById = new Map(lcoeData.map(d => [d.location_id, d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    const fuelSet = selectedFuels && selectedFuels.size ? selectedFuels : new Set(ALL_FUELS);
    const suffix = statusFilter ? capitalizeWord(statusFilter) : 'Announced';

    return capacityRows.flatMap(row => {
        return Array.from(fuelSet).map(fuel => {
            const col = `${fuel}_${suffix}`;
            const weight = Math.max(0, Number(row[col]) || 0);
            if (!weight) return null;

            let metricVal;
            if (overlayMode === 'cf') {
                metricVal = cfById.get(row.location_id)?.annual_cf;
            } else if (overlayMode === 'lcoe') {
                metricVal = lcoeById.get(row.location_id)?.lcoe;
            } else if (overlayMode === 'potential') {
                const potentialRow = potentialById?.get(row.location_id);
                metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
            } else {
                // If no overlay, metric is just capacity? Or just weight?
                // For Percentile chart with no overlay, usually we sort by capacity?
                // But previous logic set metricVal = weight.
                metricVal = weight;
            }

            if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
                return null;
            }

            return {
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                location_id: row.location_id,
                metric: metricVal,
                weight: weight,
                fuel: fuel
            };
        }).filter(Boolean);
    });
}

function getPeopleWithoutAccess(row) {
    if (!row?.pop_bins) return 0;
    const val = row.pop_bins[0];
    return Number.isFinite(val) ? val : 0;
}

function getPeopleBelowUptime(row, threshold) {
    if (!row?.pop_bins) return 0;
    const limit = Number.isFinite(threshold) ? threshold : 90;
    let sum = 0;
    Object.entries(row.pop_bins).forEach(([midpoint, pop]) => {
        const mid = Number(midpoint);
        const val = Number(pop) || 0;
        if (Number.isFinite(mid) && mid < limit) {
            sum += val;
        }
    });
    return sum;
}

function buildReliabilityMetrics(reliabilityRows, overlayMode, cfData, lcoeData, potentialState = null, mode = 'access') {
    const cfById = new Map(cfData.map(d => [d.location_id, d]));
    const lcoeById = new Map(lcoeData.map(d => [d.location_id, d]));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;

    return reliabilityRows.map((row, idx) => {
        const weight = mode === 'uptime'
            ? getPeopleBelowUptime(row, reliabilityThreshold)
            : getPeopleWithoutAccess(row);
        if (!weight || weight <= 0) return null;

        let metricVal;
        if (overlayMode === 'cf') {
            metricVal = cfById.get(row.location_id)?.annual_cf;
        } else if (overlayMode === 'lcoe') {
            metricVal = lcoeById.get(row.location_id)?.lcoe;
        } else if (overlayMode === 'potential') {
            const potentialRow = potentialById?.get(row.location_id);
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
        } else {
            metricVal = weight;
        }

        if ((overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') && !Number.isFinite(metricVal)) {
            return null;
        }

        return {
            location_id: row.location_id ?? idx,
            latitude: row.latitude,
            longitude: row.longitude,
            metric: metricVal,
            weight
        };
    }).filter(Boolean);
}
function buildStackedHistogram(metrics, overlayMode, selectedFuels, bucketCount = 50, options = {}) {
    if (!metrics.length) return { labels: [], datasets: [] };

    // Valid metrics
    const validMetrics = metrics.filter(m => Number.isFinite(m.metric));
    if (!validMetrics.length) return { labels: [], datasets: [] };

    // Determine min/max
    const metricValues = validMetrics.map(m => m.metric);
    const minMetric = Math.min(...metricValues);
    const maxMetric = Math.max(...metricValues);

    const bucketSize = (maxMetric - minMetric) / bucketCount;
    // Create buckets
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: minMetric + i * bucketSize,
        max: minMetric + (i + 1) * bucketSize,
        stacks: {}
    }));

    // Initialize stacks
    const fuelList = Array.from(selectedFuels || ALL_FUELS);
    buckets.forEach(b => {
        fuelList.forEach(f => b.stacks[f] = 0);
    });

    if (bucketSize === 0) {
        // Single bucket
        validMetrics.forEach(m => {
            buckets[0].stacks[m.fuel] = (buckets[0].stacks[m.fuel] || 0) + (m.weight || 0);
        });
    } else {
        validMetrics.forEach(m => {
            const bucketIdx = Math.min(bucketCount - 1, Math.floor((m.metric - minMetric) / bucketSize));
            buckets[bucketIdx].stacks[m.fuel] = (buckets[bucketIdx].stacks[m.fuel] || 0) + (m.weight || 0);
        });
    }

    // Cumulative logic if needed (checked externally? No, handled here?)
    // The main app usually handles cumulative by changing chart type or pre-processing.
    // Previous `buildWeightedHistogram` had custom cumulative logic for "no overlay".
    // For overlay mode, standard histogram.

    // Labels
    const labels = buckets.map(b => {
        const midpoint = (b.min + b.max) / 2;
        if (overlayMode === 'cf') return `${(midpoint * 100).toFixed(1)}%`;
        if (overlayMode === 'lcoe') return `$${midpoint.toFixed(0)}`;
        if (overlayMode === 'potential') {
            const isMultiple = options.potentialDisplayMode === 'multiple';
            return isMultiple ? `${midpoint.toFixed(2)}×` : `${midpoint.toFixed(1)}`;
        }
        return midpoint.toFixed(1);
    });

    // Datasets
    const datasets = fuelList.map(fuel => ({
        label: capitalizeWord(fuel),
        data: buckets.map(b => b.stacks[fuel] || 0),
        backgroundColor: FUEL_COLORS[fuel] || '#ccc',
        stack: 'stack0'
    }));

    return { labels, datasets, buckets };
}

function buildWeightedHistogram(metrics, overlayMode, bucketCount = 50, options = {}) {
    // Build histogram with CF or LCOE on x-axis and population/capacity on y-axis
    if (!metrics.length) return { labels: [], data: [] };

    // For overlays (CF or LCOE), bucket by the metric value
    if (overlayMode === 'cf' || overlayMode === 'lcoe' || overlayMode === 'potential') {
        // Filter metrics with valid metric values
        const validMetrics = metrics.filter(m => Number.isFinite(m.metric));
        if (!validMetrics.length) return { labels: [], data: [] };

        // Determine min and max for the metric
        const metricValues = validMetrics.map(m => m.metric);
        const minMetric = Math.min(...metricValues);
        const maxMetric = Math.max(...metricValues);

        // Create buckets
        const bucketSize = (maxMetric - minMetric) / bucketCount;
        if (bucketSize === 0) {
            // All values are the same
            return {
                labels: [overlayMode === 'cf' ? `${(minMetric * 100).toFixed(1)}%` : `$${minMetric.toFixed(0)}`],
                data: [validMetrics.reduce((sum, m) => sum + (m.weight || 0), 0)]
            };
        }

        const buckets = Array.from({ length: bucketCount }, (_, i) => ({
            min: minMetric + i * bucketSize,
            max: minMetric + (i + 1) * bucketSize,
            weight: 0
        }));

        // Distribute metrics into buckets
        validMetrics.forEach(m => {
            const bucketIdx = Math.min(bucketCount - 1, Math.floor((m.metric - minMetric) / bucketSize));
            buckets[bucketIdx].weight += m.weight || 0;
        });

        // Create labels and data
        const labels = buckets.map(b => {
            const midpoint = (b.min + b.max) / 2;
            if (overlayMode === 'cf') {
                return `${(midpoint * 100).toFixed(1)}%`;
            } else if (overlayMode === 'lcoe') {
                return `$${midpoint.toFixed(0)}`;
            } else if (overlayMode === 'potential') {
                const isMultiple = options.potentialDisplayMode === 'multiple';
                return isMultiple ? `${midpoint.toFixed(2)}×` : `${midpoint.toFixed(1)}`;
            } else {
                return midpoint.toFixed(1);
            }
        });
        const data = buckets.map(b => b.weight);

        return { labels, data, buckets };
    } else {
        // For no overlay, show percentile-based distribution
        // Sort by metric descending and calculate cumulative weight percentiles
        const sorted = [...metrics].filter(m => Number.isFinite(m.metric) && m.weight > 0).sort((a, b) => b.metric - a.metric);
        if (!sorted.length) return { labels: [], data: [] };

        const totalWeight = sorted.reduce((sum, m) => sum + m.weight, 0);
        const percentileCount = 100;
        const labels = [];
        const data = [];

        for (let i = 0; i < percentileCount; i++) {
            labels.push(`${i}%`);
            const targetPercentile = i / 100;
            let cumWeight = 0;
            let metricAtPercentile = sorted[0].metric;

            for (const m of sorted) {
                cumWeight += m.weight;
                if (cumWeight / totalWeight >= targetPercentile) {
                    metricAtPercentile = m.metric;
                    break;
                }
            }
            data.push(metricAtPercentile);
        }

        return { labels, data };
    }
}

function buildWeightedLatitudeHistogram(metrics, bucketCount = 100) {
    const totalWeight = metrics.reduce((sum, m) => sum + (m.weight || 0), 0);
    if (!totalWeight) return { labels: [], data: [] };

    const bucketSize = 180 / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: -90 + i * bucketSize,
        max: -90 + (i + 1) * bucketSize,
        weight: 0
    }));

    metrics.forEach(m => {
        if (!Number.isFinite(m.latitude)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((m.latitude + 90) / bucketSize)));
        buckets[idx].weight += m.weight || 0;
    });

    const labels = buckets.map(b => `${((b.min + b.max) / 2).toFixed(1)}°`);
    const data = buckets.map(b => (b.weight / totalWeight) * 100);
    return {
        labels: labels.reverse(),
        data: data.reverse()
    };
}

function buildSupplyMetricRows(overlayMode, cfData, lcoeData, potentialState = null) {
    if (overlayMode === 'cf') {
        return cfData
            .map(row => ({
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: row.annual_cf,
                availabilityWeight: Number.isFinite(potentialAreaById.get(row.location_id))
                    ? potentialAreaById.get(row.location_id)
                    : 1
            }))
            .filter(r => Number.isFinite(r.metric));
    }
    if (overlayMode === 'lcoe') {
        return lcoeData
            .map(row => ({
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: row.lcoe,
                availabilityWeight: Number.isFinite(potentialAreaById.get(row.location_id))
                    ? potentialAreaById.get(row.location_id)
                    : 1
            }))
            .filter(r => Number.isFinite(r.metric));
    }
    if (overlayMode === 'potential') {
        const rows = potentialState?.data || [];
        return rows.map(row => {
            const metricVal = getPotentialMetricFromRow(row, potentialState);
            if (!Number.isFinite(metricVal)) return null;
            const area = Number(row.zone_area_km2);
            const availabilityWeight = Number.isFinite(area) && area > 0 ? area : 1;
            return {
                location_id: row.location_id,
                latitude: row.latitude,
                longitude: row.longitude,
                metric: metricVal,
                availabilityWeight
            };
        }).filter(Boolean);
    }
    return [];
}

function buildHistogramWithAvailability(demandMetrics, supplyMetrics, overlayMode, bucketCount = 50, options = {}) {
    const validDemand = (demandMetrics || []).filter(m => Number.isFinite(m.metric) && (m.weight || 0) > 0);
    const validSupply = (supplyMetrics || []).filter(m => Number.isFinite(m.metric));

    const allValues = [
        ...validDemand.map(m => m.metric),
        ...validSupply.map(m => m.metric)
    ];
    if (!allValues.length) {
        return { labels: [], demandShare: [], supplyShare: [], buckets: [] };
    }

    let minMetric = Math.min(...allValues);
    let maxMetric = Math.max(...allValues);
    if (!Number.isFinite(minMetric) || !Number.isFinite(maxMetric)) {
        return { labels: [], demandShare: [], supplyShare: [], buckets: [] };
    }
    if (minMetric === maxMetric) {
        maxMetric = minMetric + 1;
    }

    const bucketSize = (maxMetric - minMetric) / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: minMetric + i * bucketSize,
        max: minMetric + (i + 1) * bucketSize,
        demandWeight: 0,
        supplyWeight: 0
    }));

    validDemand.forEach(m => {
        const idx = Math.min(bucketCount - 1, Math.floor((m.metric - minMetric) / bucketSize));
        buckets[idx].demandWeight += m.weight || 0;
    });
    validSupply.forEach(m => {
        const weight = Number.isFinite(m.availabilityWeight) ? m.availabilityWeight : 1;
        const idx = Math.min(bucketCount - 1, Math.floor((m.metric - minMetric) / bucketSize));
        buckets[idx].supplyWeight += weight;
    });

    const demandTotal = buckets.reduce((sum, b) => sum + b.demandWeight, 0);
    const supplyTotal = buckets.reduce((sum, b) => sum + b.supplyWeight, 0);

    const labels = buckets.map(b => {
        const midpoint = (b.min + b.max) / 2;
        if (overlayMode === 'cf') return `${(midpoint * 100).toFixed(1)}%`;
        if (overlayMode === 'lcoe') return `$${midpoint.toFixed(0)}`;
        if (overlayMode === 'potential') {
            const isMultiple = options.potentialDisplayMode === 'multiple';
            return isMultiple ? `${midpoint.toFixed(2)}×` : `${midpoint.toFixed(1)}`;
        }
        return midpoint.toFixed(1);
    });

    const demandShare = buckets.map(b => (demandTotal > 0 ? (b.demandWeight / demandTotal) * 100 : 0));
    const supplyShare = buckets.map(b => (supplyTotal > 0 ? (b.supplyWeight / supplyTotal) * 100 : 0));

    return { labels, demandShare, supplyShare, buckets };
}

function buildLatitudeSupplyHistogram(supplyRows, bucketCount = 100) {
    const totalWeight = supplyRows.reduce((sum, m) => sum + (m.metric || 0), 0);
    if (!totalWeight) return { labels: [], data: [] };

    const bucketSize = 180 / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: -90 + i * bucketSize,
        max: -90 + (i + 1) * bucketSize,
        weight: 0
    }));

    supplyRows.forEach(m => {
        if (!Number.isFinite(m.latitude)) return;
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((m.latitude + 90) / bucketSize)));
        buckets[idx].weight += m.metric || 0;
    });

    const labels = buckets.map(b => `${((b.min + b.max) / 2).toFixed(1)}°`);
    const data = buckets.map(b => (b.weight / totalWeight) * 100);
    return {
        labels: labels.reverse(),
        data: data.reverse()
    };
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sorted[base + 1] !== undefined) {
        return sorted[base] + rest * (sorted[base + 1] - sorted[base]);
    }
    return sorted[base];
}

function computeLatBandStats(rows, bandSize = 5) {
    const bands = new Map();
    rows.forEach(r => {
        if (!Number.isFinite(r.latitude) || !Number.isFinite(r.metric)) return;
        const idx = Math.floor((r.latitude + 90) / bandSize);
        const bandKey = Math.max(0, Math.min(Math.floor(180 / bandSize) - 1, idx));
        if (!bands.has(bandKey)) bands.set(bandKey, []);
        bands.get(bandKey).push(r.metric);
    });

    const stats = [];
    bands.forEach((values, bandKey) => {
        const sorted = values.slice().sort((a, b) => a - b);
        const min = -90 + bandKey * bandSize;
        const max = min + bandSize;
        const lat = (min + max) / 2;
        stats.push({
            lat,
            p25: quantile(sorted, 0.25),
            p50: quantile(sorted, 0.5),
            p75: quantile(sorted, 0.75)
        });
    });

    return stats.sort((a, b) => a.lat - b.lat);
}

// ==================== ACCESS CHARTS ====================

/**
 * Build histogram of grid uptime weighted by population
 * Uses bin-level population data from reliability CSV
 * X-axis: Grid Uptime (%), Y-axis: Population share
 */
function buildGridUptimeHistogram(reliabilityData) {
    if (!reliabilityData || !reliabilityData.length) return { labels: [], data: [], buckets: [] };

    // Aggregate population across all locations by uptime bin
    // pop_bins has keys: 0, 2.5, 7.5, 12.5, ..., 97.5
    const globalBins = {};
    let totalPop = 0;

    reliabilityData.forEach(r => {
        if (!r.pop_bins) return;
        Object.entries(r.pop_bins).forEach(([midpoint, pop]) => {
            const key = parseFloat(midpoint);
            if (!globalBins[key]) globalBins[key] = 0;
            globalBins[key] += pop;
            totalPop += pop;
        });
    });

    if (totalPop === 0) return { labels: [], data: [], buckets: [] };

    // Sort bins by midpoint
    const sortedKeys = Object.keys(globalBins).map(Number).sort((a, b) => a - b);

    // Create labels and data arrays
    const labels = sortedKeys.map(k => {
        if (k === 0) return 'No Access';
        if (k === 100) return '100%';
        if (Math.abs(k - 97.5) < 0.001) return '95-99.9%';

        const low = k - 2.5;
        const high = k + 2.5;
        return `${low.toFixed(0)}-${high.toFixed(0)}%`;
    });

    const data = sortedKeys.map(k => globalBins[k] / 1e6);

    const buckets = sortedKeys.map(k => ({
        midpoint: k,
        pop: globalBins[k],
        pct: (globalBins[k] / totalPop) * 100
    }));

    return { labels, data, buckets, totalPop };
}

/**
 * Build comparison data: Solar CF vs Grid Reliability
 * Uses bin-level population data to properly include people without access
 * Returns { popBetterWithSolar, popTotal, distributionData }
 */
function buildSolarVsGridComparison(reliabilityData, cfData) {
    if (!reliabilityData.length || !cfData.length) {
        return { popBetterWithSolar: 0, popTotal: 0, pctBetter: 0, distributionData: { labels: [], data: [] } };
    }

    // Create coordinate-based lookup for CF data
    const coordKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cfByCoord = new Map();
    cfData.forEach(d => {
        if (Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
            cfByCoord.set(coordKey(d.latitude, d.longitude), d);
        }
    });

    let popBetterWithSolar = 0;
    let popTotal = 0;
    const comparisonPoints = [];

    // For each location with reliability data
    reliabilityData.forEach(r => {
        if (!r.pop_bins) return;

        const key = coordKey(r.latitude, r.longitude);
        const cfRow = cfByCoord.get(key);
        if (!cfRow) return;

        const solarCf = cfRow.annual_cf || 0;
        const solarCfPct = solarCf * 100; // Convert to percentage (0-100)

        // For each reliability bin in this location
        Object.entries(r.pop_bins).forEach(([midpoint, pop]) => {
            if (pop <= 0) return;

            const gridUptimePct = parseFloat(midpoint); // Already 0-100 scale (includes 100 for exact 100%)

            popTotal += pop;

            // Comparison: Is solar CF >= grid uptime? (same or better)
            // With proper 100% bin, solar can only match if it's also 100%
            if (solarCfPct >= gridUptimePct) {
                popBetterWithSolar += pop;
            }

            const deltaPct = solarCfPct - gridUptimePct;
            comparisonPoints.push({ pop, delta: deltaPct });
        });
    });

    const pctBetter = popTotal > 0 ? (popBetterWithSolar / popTotal) * 100 : 0;

    // Build distribution: delta (solar - grid) in buckets
    const bucketCount = 20;
    const buckets = Array.from({ length: bucketCount }, (_, i) => ({
        min: -100 + i * 10,
        max: -100 + (i + 1) * 10,
        pop: 0
    }));

    comparisonPoints.forEach(d => {
        const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((d.delta + 100) / 10)));
        buckets[idx].pop += d.pop;
    });

    const distributionData = {
        labels: buckets.map(b => `${b.min > 0 ? '+' : ''}${b.min}%`),
        data: buckets.map(b => b.pop / 1e6)
    };

    return { popBetterWithSolar, popTotal, pctBetter, distributionData };
}

/**
 * Render Access-specific charts
 */
async function renderAccessCharts(populationData, reliabilityData, cfData, lcoeData, overlayMode) {
    await ensureChartJsLoaded();
    const ChartJS = window.Chart;
    if (!ChartJS) return;

    // --- Chart 1: Grid Uptime Distribution ---
    const uptimeHist = buildGridUptimeHistogram(reliabilityData);

    if (accessCharts.uptime) {
        accessCharts.uptime.data.labels = uptimeHist.labels;
        accessCharts.uptime.data.datasets[0].data = uptimeHist.data;
        accessCharts.uptime.update();
    } else if (accessChartUptimeCanvas) {
        accessCharts.uptime = new ChartJS(accessChartUptimeCanvas.getContext('2d'), {
            type: 'bar',
            data: {
                labels: uptimeHist.labels,
                datasets: [{
                    label: 'Population (millions)',
                    data: uptimeHist.data,
                    backgroundColor: '#22c55e',
                    borderColor: '#16a34a',
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (ctx) => `${ctx.parsed.y.toFixed(2)}M people`
                        }
                    }
                },
                scales: {
                    x: { title: { display: true, text: 'Grid Uptime (%)' } },
                    y: { title: { display: true, text: 'Population (millions)' } }
                }
            }
        });
    }

    // --- Chart 2: Supply Layer with Grid Context ---
    const isCf = overlayMode === 'cf';
    const isLcoe = overlayMode === 'lcoe';

    if (accessChartSupplyTitle) {
        accessChartSupplyTitle.textContent = isCf ? 'Solar CF vs Population' : isLcoe ? 'Solar LCOE vs Population' : 'Select a Supply Layer';
    }
    if (accessChartSupplyDesc) {
        accessChartSupplyDesc.textContent = isCf
            ? 'Distribution of solar capacity factor weighted by population (millions)'
            : isLcoe
                ? 'Distribution of solar LCOE weighted by population (millions)'
                : 'Enable CF or LCOE overlay to see supply layer distribution';
    }

    if (isCf || isLcoe) {
        const supplyData = isCf ? cfData : lcoeData;

        // Create coordinate-based lookup
        const coordKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
        const supplyByCoord = new Map();
        supplyData.forEach(d => {
            if (Number.isFinite(d.latitude) && Number.isFinite(d.longitude)) {
                supplyByCoord.set(coordKey(d.latitude, d.longitude), d);
            }
        });

        const joined = populationData.map(p => {
            const key = coordKey(p.latitude, p.longitude);
            const supply = supplyByCoord.get(key);
            const metric = isCf ? supply?.annual_cf : supply?.lcoe;
            const pop = p.pop || p.population_2020 || 0;
            return { pop, metric };
        }).filter(d => d.pop > 0 && Number.isFinite(d.metric));

        const totalPop = joined.reduce((sum, d) => sum + d.pop, 0);
        const bucketCount = 20;
        const metrics = joined.map(d => d.metric);
        const minMetric = Math.min(...metrics);
        const maxMetric = Math.max(...metrics);
        const bucketSize = (maxMetric - minMetric) / bucketCount || 1;

        const buckets = Array.from({ length: bucketCount }, (_, i) => ({
            min: minMetric + i * bucketSize,
            max: minMetric + (i + 1) * bucketSize,
            pop: 0
        }));

        joined.forEach(d => {
            const idx = Math.min(bucketCount - 1, Math.max(0, Math.floor((d.metric - minMetric) / bucketSize)));
            buckets[idx].pop += d.pop;
        });

        const labels = buckets.map(b => isCf ? `${((b.min + b.max) / 2 * 100).toFixed(0)}%` : `$${((b.min + b.max) / 2).toFixed(0)}`);
        const data = buckets.map(b => b.pop / 1e6);

        if (accessCharts.supply) {
            accessCharts.supply.data.labels = labels;
            accessCharts.supply.data.datasets[0].data = data;
            accessCharts.supply.options.scales.x.title.text = isCf ? 'Capacity Factor (%)' : 'LCOE ($/MWh)';
            accessCharts.supply.update();
        } else if (accessChartSupplyCanvas) {
            accessCharts.supply = new ChartJS(accessChartSupplyCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels,
                    datasets: [{
                        label: 'Population (millions)',
                        data,
                        backgroundColor: isCf ? '#fbbf24' : '#10b981',
                        borderColor: isCf ? '#f59e0b' : '#059669',
                        borderWidth: 1
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: isCf ? 'Capacity Factor (%)' : 'LCOE ($/MWh)' } },
                        y: { title: { display: true, text: 'Population (millions)' } }
                    }
                }
            });
        }
    }

    // --- Chart 3: Solar vs Grid Comparison ---
    if (isCf && cfData.length) {
        const comparison = buildSolarVsGridComparison(reliabilityData, cfData);

        if (accessComparisonStat) {
            accessComparisonStat.textContent = `${(comparison.popBetterWithSolar / 1e6).toFixed(1)}M`;
        }
        if (accessComparisonLabel) {
            accessComparisonLabel.textContent = 'people could achieve the same or better reliability with solar';
        }
        if (accessChartComparisonTitle) {
            accessChartComparisonTitle.textContent = 'Solar vs Grid Reliability';
        }

        if (accessCharts.comparison) {
            accessCharts.comparison.data.labels = comparison.distributionData.labels;
            accessCharts.comparison.data.datasets[0].data = comparison.distributionData.data;
            accessCharts.comparison.update();
        } else if (accessChartComparisonCanvas) {
            accessCharts.comparison = new ChartJS(accessChartComparisonCanvas.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: comparison.distributionData.labels,
                    datasets: [{
                        label: 'Population (millions)',
                        data: comparison.distributionData.data,
                        backgroundColor: comparison.distributionData.data.map((_, i) => {
                            const bucketMin = -100 + i * 10;
                            return bucketMin >= 0 ? '#22c55e' : '#ef4444';
                        }),
                        borderWidth: 0
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => `${ctx.parsed.y.toFixed(2)}M people`
                            }
                        }
                    },
                    scales: {
                        x: { title: { display: true, text: 'Solar CF - Grid Reliability (%)' } },
                        y: { title: { display: true, text: 'Population (millions)' } }
                    }
                }
            });
        }
    } else if (isLcoe && lcoeData.length) {
        // LCOE mode: Show distribution of LCOE needed to match grid
        if (accessComparisonStat) {
            accessComparisonStat.textContent = '--';
        }
        if (accessComparisonLabel) {
            accessComparisonLabel.textContent = 'LCOE comparison requires further data mapping';
        }
        if (accessChartComparisonTitle) {
            accessChartComparisonTitle.textContent = 'LCOE to Match Grid Reliability';
        }
    } else {
        // No overlay
        if (accessComparisonStat) {
            accessComparisonStat.textContent = '--';
        }
        if (accessComparisonLabel) {
            accessComparisonLabel.textContent = 'Select CF or LCOE supply layer to see comparison';
        }
    }
}

function destroyChart(chart) {
    if (chart) {
        chart.destroy();
    }
}

const formatMetricValue = (val, mode) => {
    if (mode === 'cf') return `${(val * 100).toFixed(1)}%`;
    if (mode === 'lcoe') return `$${val.toFixed(0)}`;
    return val.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

function handleHistogramClick(bucket, metrics, overlayMode, baseLayer) {
    if (!bucket) return;
    const { min, max } = bucket;

    // Filter data
    const subset = metrics.filter(m => m.metric >= min && m.metric < max);
    console.warn(`[HistogramClick] Bucket: ${min.toFixed(2)}-${max.toFixed(2)}, Metrics: ${metrics.length}, Subset: ${subset.length}`);

    if (subset.length === 0) return;

    // Show modal
    // Show modal
    const modal = document.getElementById('subset-map-modal');
    const titleEl = document.getElementById('subset-map-title');
    const closeBtn = document.getElementById('close-subset-map');
    const legendRange = document.getElementById('subset-map-legend-range');

    if (modal) modal.classList.remove('hidden');

    if (titleEl) {
        if (baseLayer === 'plants') {
            titleEl.textContent = 'Capacity Subset';
        } else {
            titleEl.textContent = overlayMode === 'cf' ? 'Capacity Factor Subset' : 'LCOE Subset';
        }
    }

    if (legendRange) {
        if (overlayMode === 'cf') legendRange.textContent = `${(min * 100).toFixed(1)}% – ${(max * 100).toFixed(1)}%`;
        else if (overlayMode === 'lcoe') legendRange.textContent = `$${min.toFixed(0)} – $${max.toFixed(0)}`;
        else legendRange.textContent = `${min.toLocaleString()} – ${max.toLocaleString()}`;
    }

    // Accessors for Plants
    let getRadius = null;
    let getTooltip = null;

    if (baseLayer === 'plants') {
        getRadius = (d) => {
            // Replicate main map logic:
            // const radius = Math.max(2, Math.min(12, Math.sqrt(baseCapacity) * 0.15));
            const cap = Number.isFinite(d.weight) ? Math.max(d.weight, 0) : 0;
            return Math.max(2, Math.min(12, Math.sqrt(cap) * 0.15));
        };
        getTooltip = (d) => {
            // Rich Tooltip
            return `${d.plant_name || 'Plant'} (${d.fuel || 'Unknown'})\nCapacity: ${(d.weight || 0).toLocaleString()} MW\nStatus: ${d.status || 'Unknown'}`;
        };
    }

    // Init map
    // Use requestAnimationFrame to ensure the modal is visible and layout is updated
    requestAnimationFrame(() => {
        initSubsetMap();

        // Render after slight delay for map invalidation
        setTimeout(() => {
            let dataToRender = metrics;
            let subsetIds = subset.map(d => d.location_id);
            let getValue = d => d.metric;
            let finalGetColor = getColor;

            let onPointHover = null;
            let onPointOut = null;

            if (baseLayer === 'plants') {
                // If plants layer, we want to show INDIVIDUAL plants
                const validLocationIds = new Set(subsetIds);
                dataToRender = fossilPlants.filter(p => validLocationIds.has(p.location_id));
                subsetIds = dataToRender.map(d => d.location_id);

                // --- COLORS ---
                // User wants fuel colors (from FUEL_COLORS)
                // getValue must return the entire object so getColor can access fuel_group
                getValue = d => d;
                finalGetColor = d => FUEL_COLORS[d.fuel_group || d.fuel] || '#ccc';

                // --- POPUP / TOOLTIPS ---
                const plantPopup = L.popup({
                    closeButton: false,
                    autoPan: false,
                    className: 'bg-transparent border-none shadow-none'
                });

                onPointHover = (e, d) => {
                    const latlng = subsetMap.layerPointToLatLng([e.target.getAttribute('cx'), e.target.getAttribute('cy')]);
                    // Assuming e.target is circle, cx/cy are attributes. Or use e.layerPoint? 
                    // d3 e is MouseEvent. 
                    // But easier: d.latitude, d.longitude
                    const ll = [d.latitude, d.longitude];

                    const baseCapacity = Number.isFinite(d.capacity_mw) ? d.capacity_mw : (d.weight || 0);
                    const cap = Math.round(baseCapacity).toLocaleString();
                    const fuel = (d.fuel_group || d.fuel || 'Unknown').toUpperCase();
                    const status = capitalizeWord(d.status || 'Unknown');
                    const name = d.plant_name || 'Power plant';
                    const country = d.country || 'Unknown';

                    const content = `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs pointer-events-none">
                        <div class="font-semibold">${name}</div>
                        <div>${fuel} • ${cap} MW</div>
                        <div class="text-slate-300">${status}</div>
                        <div class="text-slate-400">${country}</div>
                     </div>`;

                    plantPopup.setLatLng(ll).setContent(content).openOn(subsetMap);
                };

                onPointOut = () => {
                    subsetMap.closePopup(plantPopup);
                };

                // --- LEGEND ---
                // Hide range legend, Show Fuel Legend
                if (legendRange) {
                    legendRange.innerHTML = ''; // Clear text
                    // Append fuel swatches
                    const fuels = ['Coal', 'Oil_Gas', 'Bioenergy', 'Nuclear'];
                    fuels.forEach(fuelKey => {
                        const key = fuelKey.toLowerCase();
                        const color = FUEL_COLORS[key];
                        const item = document.createElement('span');
                        item.className = 'inline-flex items-center mr-3';
                        item.innerHTML = `<span style="background-color:${color};width:10px;height:10px;border-radius:50%;display:inline-block;margin-right:4px;"></span> ${capitalizeWord(key.replace('_', ' / '))}`;
                        legendRange.appendChild(item);
                    });
                }

            } else {
                // Reset legend if mistakenly set to fuels?
                // The earlier code sets textContent if not plants.
                // So we are safe, provided we didn't clear it above inside the block.
            }

            renderSubsetMap(
                dataToRender,
                subsetIds,
                getValue,
                finalGetColor,
                baseLayer,
                getRadius,
                getTooltip,
                onPointHover,
                onPointOut
            );
        }, 50);
    });

    // Scales
    let getColor;
    if (overlayMode === 'cf') {
        const scale = d3.scaleLinear()
            .domain([0, 0.05, 0.4, 0.7, 1.0])
            .range(["#0049ff", "#0049ff", "#00c853", "#ff9800", "#d32f2f"])
            .interpolate(d3.interpolateRgb)
            .clamp(true);
        getColor = (v) => scale(v);
    } else if (overlayMode === 'lcoe') {
        const vals = metrics.map(m => m.metric).filter(Number.isFinite);
        const minV = Math.min(...vals);
        const maxV = Math.max(...vals);
        const scale = d3.scaleSequential(d3.interpolateTurbo).domain([minV, maxV]);
        getColor = (v) => scale(v);
    } else if (baseLayer === 'electricity') {
        const vals = metrics.map(m => m.metric).filter(v => v > 0);
        const maxV = Math.max(...vals);
        const s = d3.scaleSequentialLog(t => d3.interpolateGreys(1 - t)).domain([Math.max(0.1, maxV / 1000), maxV]);
        getColor = (v) => s(Math.max(0.1, v));
    } else {
        const scale = d3.scaleLinear().domain([min, max]).range(["#e5e7eb", "#1f2937"]);
        getColor = (v) => scale(v);
    }

    if (closeBtn) {
        closeBtn.onclick = () => {
            modal.classList.add('hidden');
        };
    }
}

async function renderPopulationCharts(metrics, { overlayMode, baseLayer, selectedFuels, potentialState = null, supplyRows = [] }) {
    if (!populationChartHistogram || !populationChartLatMetric || !populationChartLatPop) return;

    // Dynamically load Chart.js if not already loaded
    await ensureChartJsLoaded();

    const ChartJS = window.Chart;
    if (!ChartJS) return;

    const isCf = overlayMode === 'cf';
    const isLcoe = overlayMode === 'lcoe';
    const isPotential = overlayMode === 'potential';
    const potentialIsMultiple = potentialState?.displayMode === 'multiple';
    const potentialIsTotal = isPotential && potentialState?.displayMode === 'total';
    const isStacked = baseLayer === 'plants';
    const fuelSet = isStacked
        ? (selectedFuels instanceof Set ? selectedFuels : (selectedFuels ? new Set(selectedFuels) : new Set(ALL_FUELS)))
        : null;
    // Determine weight descriptor based on baseLayer
    let weightDescriptor;
    if (baseLayer === 'plants') {
        weightDescriptor = 'Displaceable Plant capacity';
    } else if (baseLayer === 'electricity') {
        weightDescriptor = 'electricity demand';
    } else if (baseLayer === 'access') {
        weightDescriptor = 'people without access';
    } else if (baseLayer === 'uptime') {
        weightDescriptor = `people below ${reliabilityThreshold}% uptime`;
    } else {
        weightDescriptor = 'population';
    }

    // Prepare Histogram Data
    let histogramData;
    let histogramMainTitle, histogramHelperText;
    let xAxisLabel, yAxisLabel, scatterXAxisLabel;

    if (isCf) {
        xAxisLabel = 'Capacity Factor (%)';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = 'Capacity Factor (%)';
        histogramMainTitle = 'Demand Distribution by Capacity Factor';
        histogramHelperText = `Shows share of ${weightDescriptor} across capacity factor bins`;
    } else if (isLcoe) {
        xAxisLabel = 'LCOE solar + battery ($/MWh)';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = 'LCOE solar + battery ($/MWh)';
        histogramMainTitle = 'Demand Distribution by LCOE';
        histogramHelperText = `Shows share of ${weightDescriptor} across LCOE bins`;
    } else if (isPotential) {
        xAxisLabel = potentialIsMultiple ? 'Solar Potential / Demand (×)' : 'Solar Potential (TWh/yr)';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = xAxisLabel;
        histogramMainTitle = 'Demand Distribution by Solar Potential';
        histogramHelperText = `Shows share of ${weightDescriptor} across solar potential bins`;
    } else {
        xAxisLabel = 'Supply Metric';
        yAxisLabel = 'Share (%)';
        scatterXAxisLabel = 'Supply Metric';
        histogramMainTitle = 'Demand Distribution';
        histogramHelperText = `Shows share of ${weightDescriptor} across supply metric bins`;
    }
    if (isStacked) {
        histogramHelperText = `${histogramHelperText} (stacked by fuel)`;
    }

    // Update main page heading based on baseLayer
    const chartsMainHeading = document.getElementById('charts-main-heading');
    if (chartsMainHeading) {
        if (baseLayer === 'electricity') {
            chartsMainHeading.textContent = 'Electricity Demand Analysis';
        } else if (baseLayer === 'access') {
            chartsMainHeading.textContent = 'Electricity Access Analysis';
        } else if (baseLayer === 'uptime') {
            chartsMainHeading.textContent = 'Grid Reliability Analysis';
        } else if (baseLayer === 'plants') {
            chartsMainHeading.textContent = 'Capacity to Displace Analysis';
        } else {
            chartsMainHeading.textContent = 'Population Analysis';
        }
    }

    // Update chart title elements
    const chartTitlePercentile = document.getElementById('chart-title-percentile');
    if (chartTitlePercentile) {
        const metricLabel = isCf
            ? 'Capacity Factor'
            : isLcoe
                ? 'LCOE'
                : isPotential
                    ? (potentialIsMultiple ? 'Solar Potential / Demand' : 'Solar Potential')
                    : 'Supply Metric';
        chartTitlePercentile.textContent = `Demand Distribution by ${metricLabel}`;
    }

    if (chartTitleDemandLatitude) {
        if (baseLayer === 'electricity') {
            chartTitleDemandLatitude.textContent = 'Electricity Demand by Latitude';
        } else if (baseLayer === 'access') {
            chartTitleDemandLatitude.textContent = 'People Without Access by Latitude';
        } else if (baseLayer === 'uptime') {
            chartTitleDemandLatitude.textContent = `People Below ${reliabilityThreshold}% Uptime by Latitude`;
        } else if (baseLayer === 'plants') {
            chartTitleDemandLatitude.textContent = 'Displaceable Capacity by Latitude';
        } else {
            chartTitleDemandLatitude.textContent = 'Population by Latitude';
        }
    }
    if (chartTitleSupplyLatitude) {
        chartTitleSupplyLatitude.textContent = isCf
            ? 'Capacity Factor by Latitude'
            : isLcoe
                ? 'LCOE by Latitude'
                : isPotential
                    ? (potentialIsMultiple ? 'Solar Potential / Demand by Latitude' : 'Solar Potential by Latitude')
                    : 'Supply Metric by Latitude';
    }

    let histogramTooltip;

    let hist;
    if (isStacked) {
        hist = buildStackedHistogram(metrics, overlayMode, fuelSet, 50, { potentialDisplayMode: potentialState?.displayMode });
        const totalWeight = hist.datasets.reduce((sum, ds) => {
            return sum + ds.data.reduce((acc, v) => acc + (Number.isFinite(v) ? v : 0), 0);
        }, 0);

        if (totalWeight > 0) {
            hist.datasets.forEach(ds => {
                ds.data = ds.data.map(v => (Number.isFinite(v) ? (v / totalWeight) * 100 : 0));
            });
        }

        if (typeof populationChartCumulative !== 'undefined' && populationChartCumulative) {
            hist.datasets.forEach(ds => {
                let sum = 0;
                ds.data = ds.data.map(v => {
                    sum += v;
                    return sum;
                });
            });
        }

        histogramData = {
            labels: hist.labels,
            datasets: hist.datasets
        };
        histogramTooltip = (ctx) => {
            const val = ctx.parsed.y;
            const label = ctx.dataset.label || 'Value';
            return `${label}: ${val.toFixed(1)}%`;
        };
    } else {
        hist = buildHistogramWithAvailability(metrics, supplyRows, overlayMode, 50, { potentialDisplayMode: potentialState?.displayMode });
        let demandSeries = hist.demandShare.slice();
        if (typeof populationChartCumulative !== 'undefined' && populationChartCumulative) {
            let sum = 0;
            demandSeries = demandSeries.map(v => {
                sum += v;
                return sum;
            });
        }

        let demandLabel;
        if (baseLayer === 'electricity') {
            demandLabel = 'Electricity demand share';
        } else if (baseLayer === 'access') {
            demandLabel = 'No-access share';
        } else if (baseLayer === 'uptime') {
            demandLabel = `Below ${reliabilityThreshold}% uptime share`;
        } else {
            demandLabel = 'Population share';
        }

        histogramData = {
            labels: hist.labels,
            datasets: [
                {
                    type: 'bar',
                    label: demandLabel,
                    data: demandSeries,
                    backgroundColor: '#fbbf24',
                    borderColor: '#f59e0b',
                    borderWidth: 1
                }
            ]
        };
        histogramTooltip = (ctx) => {
            const val = ctx.parsed.y;
            const label = ctx.dataset.label || 'Value';
            return `${label}: ${val.toFixed(1)}%`;
        };
    }

    // Update Titles
    if (populationChartHistogramTitle) populationChartHistogramTitle.textContent = histogramMainTitle;
    if (populationChartHistogramLabel) populationChartHistogramLabel.textContent = histogramHelperText;

    // Destroy/Create Main Histogram
    // We recreate if type changes or if stacked/unstacked changes structure significantly?
    // ChartJS can update data structure.
    // However, if we switch from 1 dataset to N datasets, update() handles it.

    if (!populationCharts.histogram) {
        populationCharts.histogram = new ChartJS(populationChartHistogram.getContext('2d'), {
            type: 'bar',
            data: histogramData,
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: true },
                    tooltip: { callbacks: { label: histogramTooltip } }
                },
                onClick: (e, elements) => {
                    if (elements && elements.length > 0 && hist.buckets) {
                        const index = elements[0].index;
                        const bucket = hist.buckets[index];
                        handleHistogramClick(bucket, metrics, overlayMode, baseLayer);
                    }
                },
                onHover: (event, chartElement) => {
                    event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
                },
                scales: {
                    x: {
                        title: { display: true, text: xAxisLabel },
                        stacked: isStacked
                    },
                    y: {
                        title: { display: true, text: yAxisLabel },
                        min: 0,
                        stacked: isStacked,
                        ticks: {
                            callback: (value) => `${value}%`
                        }
                    }
                }
            }
        });
    } else {
        populationCharts.histogram.data = histogramData;
        populationCharts.histogram.options.plugins.legend.display = true;
        populationCharts.histogram.options.plugins.tooltip.callbacks.label = histogramTooltip;
        populationCharts.histogram.options.onClick = (e, elements) => {
            if (elements && elements.length > 0 && hist.buckets) {
                const index = elements[0].index;
                const bucket = hist.buckets[index];
                handleHistogramClick(bucket, metrics, overlayMode, baseLayer);
            }
        };
        populationCharts.histogram.options.scales.x.title.text = xAxisLabel;
        populationCharts.histogram.options.scales.x.stacked = isStacked;
        populationCharts.histogram.options.scales.y.title.text = yAxisLabel;
        populationCharts.histogram.options.scales.y.ticks.callback = (value) => `${value}%`;
        populationCharts.histogram.options.scales.y.stacked = isStacked;
        populationCharts.histogram.update();
    }

    // Supply by Latitude (Bottom-Left)
    const normalizeMetric = (val) => {
        if (!Number.isFinite(val)) return val;
        if (isCf) return val * 100;
        return val;
    };
    const supplyScatterRows = supplyRows
        .map(m => ({
            latitude: m.latitude,
            metric: normalizeMetric(m.metric)
        }))
        .filter(m => Number.isFinite(m.latitude) && Number.isFinite(m.metric));
    const metricScatterData = supplyScatterRows.map(m => ({ x: m.metric, y: m.latitude }));

    // Update labels for bottom-left
    if (populationChartLatMetricTitle) {
        populationChartLatMetricTitle.textContent = isCf
            ? 'CF by latitude'
            : isLcoe
                ? 'LCOE by latitude'
                : isPotential
                    ? (potentialIsMultiple ? 'Solar potential / demand by latitude' : 'Solar potential by latitude')
                    : 'Supply metric by latitude';
    }

    const supplyChartIsBinned = potentialIsTotal;
    if (supplyChartIsBinned) {
        const supplyLatHistogram = buildLatitudeSupplyHistogram(supplyRows);
        if (!populationCharts.latMetric || populationCharts.latMetric.config.type !== 'bar') {
            destroyChart(populationCharts.latMetric);
            populationCharts.latMetric = new ChartJS(populationChartLatMetric.getContext('2d'), {
                type: 'bar',
                data: {
                    labels: supplyLatHistogram.labels,
                    datasets: [{
                        label: 'Supply share (%)',
                        data: supplyLatHistogram.data,
                        backgroundColor: '#38bdf8',
                        borderColor: '#0ea5e9',
                        borderWidth: 1
                    }]
                },
                options: {
                    indexAxis: 'y',
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: 'Supply share (%)' } },
                        y: { title: { display: true, text: 'Latitude band' } }
                    }
                }
            });
        } else {
            populationCharts.latMetric.data.labels = supplyLatHistogram.labels;
            populationCharts.latMetric.data.datasets[0].data = supplyLatHistogram.data;
            populationCharts.latMetric.update();
        }
    } else {
        const stats = computeLatBandStats(supplyScatterRows);
        const medianData = stats.map(s => ({ x: s.p50, y: s.lat }));

        const datasets = [
            {
                type: 'line',
                label: 'Median',
                data: medianData,
                borderColor: '#38bdf8',
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.3,
                spanGaps: true
            },
            {
                type: 'scatter',
                label: scatterXAxisLabel,
                data: metricScatterData,
                backgroundColor: 'rgba(52, 211, 153, 0.4)',
                pointRadius: 2
            }
        ];

        if (!populationCharts.latMetric || populationCharts.latMetric.config.type !== 'scatter') {
            destroyChart(populationCharts.latMetric);
            populationCharts.latMetric = new ChartJS(populationChartLatMetric.getContext('2d'), {
                type: 'scatter',
                data: { datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: { legend: { display: false } },
                    scales: {
                        x: { title: { display: true, text: scatterXAxisLabel } },
                        y: { title: { display: true, text: 'Latitude' }, min: -90, max: 90 }
                    }
                }
            });
        } else {
            populationCharts.latMetric.data.datasets = datasets;
            populationCharts.latMetric.options.scales.x.title.text = scatterXAxisLabel;
            populationCharts.latMetric.update();
        }
    }

    // Latitude Population/Capacity Histogram (Bottom-Right)
    const popHistogram = buildWeightedLatitudeHistogram(metrics);
    const latPopLabel = baseLayer === 'electricity'
        ? 'Electricity demand share (%)'
        : baseLayer === 'plants'
            ? 'Capacity share (%)'
            : baseLayer === 'access'
                ? 'No-access share (%)'
                : baseLayer === 'uptime'
                    ? `Below ${reliabilityThreshold}% uptime share (%)`
                    : 'Population share (%)';
    const latPopAxisLabel = latPopLabel;

    if (populationChartLatPopLabel) populationChartLatPopLabel.textContent = `${weightDescriptor} by latitude`;

    if (!populationCharts.latPop) {
        populationCharts.latPop = new ChartJS(populationChartLatPop.getContext('2d'), {
            type: 'bar',
            data: {
                labels: popHistogram.labels,
                datasets: [{
                    label: latPopLabel,
                    data: popHistogram.data,
                    backgroundColor: '#fbbf24',
                    borderColor: '#f59e0b',
                    borderWidth: 1
                }]
            },
            options: {
                indexAxis: 'y',
                responsive: true,
                maintainAspectRatio: false,
                plugins: { legend: { display: false } },
                scales: {
                    x: { title: { display: true, text: latPopAxisLabel } },
                    y: { title: { display: true, text: 'Latitude band' } }
                }
            }
        });
    } else {
        populationCharts.latPop.data.labels = popHistogram.labels;
        populationCharts.latPop.data.datasets[0].label = latPopLabel;
        populationCharts.latPop.data.datasets[0].data = popHistogram.data;
        populationCharts.latPop.options.scales.x.title.text = latPopAxisLabel;
        populationCharts.latPop.update();
    }
}

function prepareLcoeDisplayData() {
    if (!summaryData.length) return;
    const perf = startPerf('lcoe-prepare', { mode: lcoeDisplayMode, targetCf: lcoeParams.targetCf });
    lcoeResults = computeBestLcoeByLocation(lcoeParams.targetCf, lcoeParams);

    // Sync reference to freshest data
    let ref = null;
    if (lcoeReference) {
        ref = lcoeResults.find(r => r.location_id === lcoeReference.location_id) || null;
        lcoeReference = ref;
    }

    const wantsComparison = Boolean(ref);
    const desiredType = wantsComparison ? (lcoeDisplayMode === 'transmission' ? 'tx' : 'delta') : 'lcoe';
    if (!wantsComparison) {
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    } else if (legendLock && lockedColorInfo && lockedColorInfo.type !== desiredType) {
        // Display mode changed (delta <-> transmission), force recalculation
        legendLock = false;
        lockedColorInfo = null;
        updateLegendLockButton();
    }

    const resultsWithDelta = lcoeResults.map(r => {
        const delta = ref ? r.lcoe - ref.lcoe : null;
        const txMetrics = ref ? computeTransmissionMetrics(r, ref, delta) : null;
        return { ...r, delta, txMetrics };
    });

    const validCosts = resultsWithDelta.filter(p => p.meetsTarget && Number.isFinite(p.lcoe)).map(p => p.lcoe).sort((a, b) => a - b);
    const costPick = (q) => validCosts[Math.min(validCosts.length - 1, Math.max(0, Math.floor(q * validCosts.length)))];

    let colorInfo;
    if (lcoeTimeLockActive && lcoeTimeLockedColorInfo) {
        const lockedBase = {
            ...lcoeTimeLockedColorInfo,
            domain: lcoeTimeLockedColorInfo.domain ? [...lcoeTimeLockedColorInfo.domain] : null
        };
        if (lockedBase.type === 'lcoe' && lockedBase.domain?.length && validCosts.length) {
            const lockedMin = lockedBase.domain[0];
            const p10 = costPick(0.1);
            if (Number.isFinite(p10) && p10 < lockedMin) {
                lockedBase.underflowMin = p10;
                lockedBase.underflowLabel = `< ${formatCurrencyLabel(lockedMin)}`;
                lockedBase.underflowColor = '#0b5ea8';
            } else {
                lockedBase.underflowMin = null;
                lockedBase.underflowLabel = '';
                lockedBase.underflowColor = '';
            }
        }
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedBase);
    } else if (legendLock && lockedColorInfo) {
        colorInfo = updateLcoeLegend(resultsWithDelta, lockedColorInfo);
    } else {
        colorInfo = updateLcoeLegend(resultsWithDelta);
        if (legendLock) {
            lockedColorInfo = colorInfo;
        }
        if (lcoeTimeLockActive) {
            lcoeTimeLockedColorInfo = colorInfo;
        }
    }
    lastColorInfo = colorInfo;
    endPerf(perf, { resultRows: resultsWithDelta.length });

    return { resultsWithDelta, ref, colorInfo };
}

function updateLcoeView() {
    if (currentViewMode !== 'lcoe') return;
    if (lcoeTargetMode === 'utilization') {
        // Existing mode: Show LCOE to achieve target CF
        const prepared = prepareLcoeDisplayData();
        if (!prepared) return;
        const { resultsWithDelta, ref, colorInfo } = prepared;

        updateLcoeMap(resultsWithDelta, {
            targetCf: lcoeParams.targetCf,
            colorInfo,
            reference: ref
        });
    } else {
        // New mode: Show CF heatmap at target LCOE
        if (!summaryData.length) return;
        const perf = startPerf('lcoe-cf-at-target', { targetLcoe: targetLcoeValue });

        // Calculate which config achieves closest to target LCOE for each location
        const cfResults = computeCfAtTargetLcoe(targetLcoeValue, lcoeParams);

        // Prepare with delta (no transmission logic in this mode)
        const ref = lcoeReference ? cfResults.find(r => r.location_id === lcoeReference.location_id) || null : null;
        const resultsWithDelta = cfResults.map(r => {
            const delta = ref ? r.cf - ref.cf : null;
            return { ...r, delta };
        });

        // Update legend for CF display
        const colorInfo = updateCfLegend(resultsWithDelta);

        updateCfMap(resultsWithDelta, {
            targetLcoe: targetLcoeValue,
            colorInfo,
            reference: ref
        });
        endPerf(perf, { resultRows: resultsWithDelta.length });
    }
}

async function updatePopulationView() {
    if (currentViewMode !== 'population') return;
    let overlayMode = populationOverlayMode || 'cf';
    if (overlayMode === 'none') {
        overlayMode = 'cf';
        populationOverlayMode = 'cf';
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls('cf');
    }

    // Prepare data for overlay
    let cfData = [];
    let lcoeData = [];
    let lcoeColorInfo = null;
    let potentialState = null;

    if (overlayMode === 'cf') {
        cfData = getSummaryForConfig(currentSolar, currentBatt);
    } else if (overlayMode === 'lcoe') {
        await ensureDieselDataLoaded();
        syncLcoeControlValues();
        const prepared = prepareLcoeDisplayData();
        if (prepared) {
            lcoeData = prepared.resultsWithDelta;
            lcoeColorInfo = prepared.colorInfo;
        }
    } else if (overlayMode === 'potential') {
        potentialState = await getPotentialOverlayState();
        if (!potentialState) return;
        syncPotentialToggleUI();
    }

    // Display mode: map or charts
    if (populationDisplayMode === 'charts') {
        // Show charts
        showPopulationChartsOnly();
        setLocationPanelChartSummary();

        // Show standard charts, hide access charts
        if (standardChartsContainer) standardChartsContainer.classList.remove('hidden');
        if (accessChartsContainer) accessChartsContainer.classList.add('hidden');

        // Build metrics for charts
        let metrics = [];
        if (populationBaseLayer === 'population') {
            metrics = buildPopulationMetrics(populationData, overlayMode, cfData, lcoeData, potentialState);
        } else if (populationBaseLayer === 'plants') {
            metrics = buildPlantMetrics(fossilCapacity, overlayMode, cfData, lcoeData, populationFuelFilter, plantStatusFilter, potentialState);
        } else if (populationBaseLayer === 'electricity') {
            metrics = buildElectricityMetrics(electricityDemandData, overlayMode, cfData, lcoeData, potentialState);
        } else if (populationBaseLayer === 'access') {
            metrics = buildReliabilityMetrics(reliabilityData, overlayMode, cfData, lcoeData, potentialState, 'access');
        } else if (populationBaseLayer === 'uptime') {
            metrics = buildReliabilityMetrics(reliabilityData, overlayMode, cfData, lcoeData, potentialState, 'uptime');
        }

        const supplyRows = buildSupplyMetricRows(overlayMode, cfData, lcoeData, potentialState);

        renderPopulationCharts(metrics, {
            overlayMode,
            baseLayer: populationBaseLayer,
            selectedFuels: populationFuelFilter,
            potentialState,
            supplyRows
        });
    } else {
        // Show map
        showMapContainerOnly();

        updatePopulationSimple(populationData, {
            baseLayer: populationBaseLayer,
            overlayMode: 'none',
            cfData: cfData,
            lcoeData: lcoeData,
            lcoeColorInfo: lcoeColorInfo,
            targetCf: lcoeParams.targetCf,
            fossilPlants: fossilPlants,
            fossilCapacityMap: fossilCapacityMap,
            electricityDemandData: electricityDemandData,
            electricityDemandMap: electricityDemandMap,
            reliabilityData: reliabilityData,
            reliabilityMap: reliabilityMap,
            selectedFuels: Array.from(populationFuelFilter),
            selectedStatus: plantStatusFilter
        });

        updatePopulationLegend(populationData, 'none', populationBaseLayer);
        updateSupplyMap({
            overlayMode: populationOverlayMode,
            cfData,
            lcoeData,
            lcoeColorInfo,
            potentialState
        });
        updateSupplyLegend(populationOverlayMode, lcoeColorInfo, potentialState);
    }
}

function handleSolarInput(value, source) {
    const val = parseInt(value, 10);
    if (!Number.isFinite(val)) return;
    currentSolar = val;
    solarVal.textContent = val;
    if (solarSlider) solarSlider.value = val;

    // Auto-adjust battery: if solar > 10 MW and battery < 18 MWh, set battery to 18 MWh
    if (val > 10 && currentBatt < 18) {
        currentBatt = 18;
        battVal.textContent = 18;
        if (battSlider) battSlider.value = 18;
        // Also update population panel battery slider if it exists
        const popBattSlider = document.getElementById('pop-batt-slider');
        const popBattVal = document.getElementById('pop-batt-val');
        if (popBattSlider) popBattSlider.value = 18;
        if (popBattVal) popBattVal.textContent = 18;
    }

    debouncedUpdateModel();
}

function handleBattInput(value, source) {
    const val = parseInt(value, 10);
    if (!Number.isFinite(val)) return;
    currentBatt = val;
    battVal.textContent = val;
    if (battSlider) battSlider.value = val;
    debouncedUpdateModel();
}

function refreshActiveLcoeView() {
    if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
        updatePopulationView();
    } else {
        updateLcoeView();
    }
}

async function handleLocationSelect(locationData) {
    currentLocationId = locationData?.location_id ?? null;
    const isPopulationLcoe = currentViewMode === 'population' && populationOverlayMode === 'lcoe';
    if ((currentViewMode === 'lcoe' || isPopulationLcoe) && locationData) {
        lcoeReference = locationData;
        resetLcoeTimeLegendLock();
        refreshActiveLcoeView();
    }
}

async function init() {
    // Initialize UI state
    updatePlantStatusToggleUI();
    updatePopulationFuelToggleUI();
    try {
        // Initialize Map
        await initMap(handleLocationSelect);

        // Initialize Hourly Profile Samples
        initSampleDays(sampleWeekSelect);

        // Load ONLY essential data upfront - summary data is required for the initial view
        // Population, fossil plants, and electricity data are lazy-loaded when their views are accessed
        loadingStatus.textContent = "Downloading summary data...";
        const summaryLoadPerf = startPerf('summary-load');
        summaryData = await loadSummary();
        endPerf(summaryLoadPerf, { rows: summaryData?.length || 0 });
        console.log("summaryData loaded:", typeof summaryData, Array.isArray(summaryData), summaryData ? summaryData.length : 'null');
        if (!Array.isArray(summaryData)) {
            throw new Error("summaryData is not an array! It is: " + typeof summaryData);
        }
        enrichSummaryRows(summaryData);

        if (FEATURE_WORKER_LCOE) {
            const warm = () => ensureLcoeWorkerReady().catch(() => {});
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(warm, { timeout: 2000 });
            } else {
                setTimeout(warm, 0);
            }
        }

        // NOTE: Population, fossil plants, and electricity data are now LAZY LOADED
        // They will be fetched when the user switches to the Supply-Demand Matching view
        // See: ensurePopulationModeDataLoaded(), ensureFossilDataLoaded(), ensureElectricityDataLoaded()

        loadingStatus.textContent = "Processing...";
        console.log("Loaded summary data. Rows:", summaryData.length);

        // Initialize UI Events
        initUIEvents();
        updateWaccSourceToggleUI();
        updateCapexSourceToggleUI();
        updateDieselSourceToggleUI();

        // Initial View
        updateViewMode('capacity');
        updateModel();

        // Hide Loading
        loading.classList.add('hidden');

    } catch (err) {
        console.error(err);
        loadingStatus.textContent = "Error loading data: " + err.message;
        loadingStatus.classList.add('text-red-500');
    }
}

function initUIEvents() {
    // View Mode Tabs
    viewTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const mode = tab.dataset.mode;
            updateViewMode(mode);
        });
    });

    if (potentialLevelButtons && potentialLevelButtons.length) {
        potentialLevelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const level = btn.dataset.level;
                if (!level || level === potentialLevel) return;
                potentialLevel = level;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }
    if (potentialDisplayButtons && potentialDisplayButtons.length) {
        potentialDisplayButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.display;
                if (!mode || mode === potentialDisplayMode) return;
                potentialDisplayMode = mode;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    if (supplyPotentialLevelButtons && supplyPotentialLevelButtons.length) {
        supplyPotentialLevelButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const level = btn.dataset.level;
                if (!level || level === potentialLevel) return;
                potentialLevel = level;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    if (supplyPotentialDisplayButtons && supplyPotentialDisplayButtons.length) {
        supplyPotentialDisplayButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.display;
                if (!mode || mode === potentialDisplayMode) return;
                potentialDisplayMode = mode;
                syncPotentialToggleUI();
                if (currentViewMode === 'potential') {
                    updatePotentialView();
                } else if (currentViewMode === 'population' && populationOverlayMode === 'potential') {
                    updatePopulationView();
                }
            });
        });
    }

    // Sliders
    solarSlider.addEventListener('input', (e) => handleSolarInput(e.target.value, 'main'));
    battSlider.addEventListener('input', (e) => handleBattInput(e.target.value, 'main'));

    // Sample Controls
    sampleWeekSelect.addEventListener('change', (e) => {
        const weekId = parseInt(e.target.value, 10);
        loadSampleWeekData(weekId).then(() => {
            updateSampleView();
        });
    });

    timeScrubber.addEventListener('input', (e) => {
        const hour = parseInt(e.target.value, 10);
        updateSampleTime(hour);
    });

    samplePlayBtn.addEventListener('click', toggleSamplePlay);
    sampleResetBtn.addEventListener('click', resetSamplePlay);
    sampleChartClose.addEventListener('click', () => {
        sampleChartOverlay.classList.add('hidden');
    });

    // Population Controls
    populationBaseButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setPopulationBaseLayer(btn.dataset.base);
        });
    });

    if (populationControlsToggle && populationControls) {
        populationControlsToggle.addEventListener('click', () => {
            togglePanelCollapse(populationControls, populationControlsToggle);
        });
    }

    if (populationSupplyToggle && populationSupplyPanel) {
        populationSupplyToggle.addEventListener('click', () => {
            togglePanelCollapse(populationSupplyPanel, populationSupplyToggle);
        });
    }

    // Plant Status Toggle (Announced/Existing)
    plantStatusButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const status = btn.dataset.status;
            if (status === plantStatusFilter) return;
            plantStatusFilter = status;
            updatePlantStatusToggleUI();
            if (populationBaseLayer === 'plants' && currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    });

    populationOverlayButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.overlay || 'cf';
            if (mode === populationOverlayMode) return;
            populationOverlayMode = mode;
            updatePopulationOverlayToggleUI();
            updatePopulationOverlayControls(mode);
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    });

    window.addEventListener('resize', () => {
        if (currentViewMode === 'population' && populationDisplayMode === 'charts') {
            updatePopulationChartsBounds();
        }
    });


    // Fuel Buttons and Legend Items Toggle Logic
    const togglePopulationFuel = (fuel) => {
        if (populationFuelFilter.has(fuel)) {
            populationFuelFilter.delete(fuel);
        } else {
            populationFuelFilter.add(fuel);
        }
        updatePopulationFuelToggleUI();
        if (populationBaseLayer === 'plants') {
            updatePopulationView();
        }
    };

    if (populationFuelButtons) {
        populationFuelButtons.forEach(btn => {
            btn.addEventListener('click', () => togglePopulationFuel(btn.dataset.fuel));
        });
    }

    // Attach to legend items
    const fuelTypesKey = ['coal', 'oil_gas', 'bioenergy', 'nuclear'];
    fuelTypesKey.forEach(fuel => {
        const item = document.getElementById(`legend-item-${fuel}`);
        if (item) {
            item.addEventListener('click', () => togglePopulationFuel(fuel));
        }
    });

    // Cumulative Toggle
    const cumulativeToggle = document.getElementById('chart-cumulative-toggle');
    if (cumulativeToggle) {
        cumulativeToggle.textContent = `Cumulative: ${populationChartCumulative ? 'ON' : 'OFF'}`;
        cumulativeToggle.classList.toggle('text-emerald-400', populationChartCumulative);
        cumulativeToggle.classList.toggle('bg-emerald-400/10', populationChartCumulative);
        cumulativeToggle.classList.toggle('border-emerald-400/20', populationChartCumulative);
        cumulativeToggle.addEventListener('click', () => {
            populationChartCumulative = !populationChartCumulative;
            cumulativeToggle.textContent = `Cumulative: ${populationChartCumulative ? 'ON' : 'OFF'}`;
            cumulativeToggle.classList.toggle('text-emerald-400', populationChartCumulative);
            cumulativeToggle.classList.toggle('bg-emerald-400/10', populationChartCumulative);
            cumulativeToggle.classList.toggle('border-emerald-400/20', populationChartCumulative);

            // Re-render chart
            updatePopulationView();
        });
    }

    if (reliabilityThresholdSlider) {
        reliabilityThresholdSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (!Number.isFinite(val)) return;
            reliabilityThreshold = Math.max(0, Math.min(100, val));
            if (reliabilityThresholdVal) reliabilityThresholdVal.textContent = reliabilityThreshold;
            if (currentViewMode === 'population' && populationBaseLayer === 'uptime') {
                updatePopulationView();
            }
        });
    }

    // Population CF overlay sliders (sync with main values)
    const popSolarSlider = document.getElementById('pop-solar-slider');
    const popSolarVal = document.getElementById('pop-solar-val');
    const popBattSlider = document.getElementById('pop-batt-slider');
    const popBattVal = document.getElementById('pop-batt-val');

    if (popSolarSlider) {
        popSolarSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (popSolarVal) popSolarVal.textContent = val;
            handleSolarInput(val);
        });
    }

    if (popBattSlider) {
        popBattSlider.addEventListener('input', (e) => {
            const val = parseInt(e.target.value, 10);
            if (popBattVal) popBattVal.textContent = val;
            handleBattInput(val);
        });
    }

    if (popTargetCfSlider) {
        popTargetCfSlider.addEventListener('input', (e) => {
            const val = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
            lcoeParams.targetCf = val / 100;
            syncLcoeControlValues();
            resetLcoeTimeLegendLock();
            queueLcoeUpdate();
        });
    }

    // Population LCOE parameter inputs
    const updatePopLcoeParams = () => {
        lcoeParams.solarCapex = parseFloat(popSolarCapexInput?.value) || 720;
        lcoeParams.batteryCapex = parseFloat(popBatteryCapexInput?.value) || 120;
        lcoeParams.solarOpexPct = parseFloat(popSolarOpexInput?.value) / 100 || 0.015;
        lcoeParams.batteryOpexPct = parseFloat(popBatteryOpexInput?.value) / 100 || 0.02;
        lcoeParams.solarLife = parseInt(popSolarLifeInput?.value, 10) || 30;
        lcoeParams.batteryLife = parseInt(popBatteryLifeInput?.value, 10) || 20;
        lcoeParams.wacc = parseFloat(popWaccInput?.value) / 100 || 0.07;
        lcoeParams.ilr = parseFloat(popIlrInput?.value) || 1.3;
        lcoeParams.dieselCapex = parseFloat(popDieselCapexInput?.value) || 300;
        lcoeParams.dieselEfficiency = (parseFloat(popDieselEfficiencyInput?.value) || 35) / 100;
        lcoeParams.dieselLife = parseInt(popDieselLifeInput?.value, 10) || 20;
        syncLcoeControlValues();
        resetLcoeTimeLegendLock();

        // Recalculate if we're in population view with LCOE overlay
        if (currentViewMode === 'population' && populationOverlayMode === 'lcoe') {
            updatePopulationView();
        }
    };

    [popSolarCapexInput, popBatteryCapexInput, popSolarOpexInput, popBatteryOpexInput,
        popSolarLifeInput, popBatteryLifeInput, popWaccInput, popIlrInput,
        popDieselCapexInput, popDieselEfficiencyInput, popDieselLifeInput].forEach(input => {
            if (input) {
                input.addEventListener('change', updatePopLcoeParams);
            }
        });

    if (popDieselBackupInput) {
        popDieselBackupInput.addEventListener('change', (e) => {
            setDieselBackupEnabled(e.target.checked);
        });
    }

    popDieselBackupModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) setDieselBackupMode(e.target.value);
        });
    });

    populationDisplayButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            setPopulationDisplayMode(btn.dataset.mode);
        });
    });

    if (closeChartsBtn) {
        closeChartsBtn.addEventListener('click', () => {
            setPopulationDisplayMode('map');
        });
    }

    // Settings Modal Inputs
    targetCfSlider.addEventListener('input', (e) => {
        const pct = Math.max(0, Math.min(100, parseInt(e.target.value, 10) || 0));
        lcoeParams.targetCf = pct / 100;
        syncLcoeControlValues();
        resetLcoeTimeLegendLock();
        queueLcoeUpdate();
    });

    // Target Mode Toggle
    lcoeTargetModeButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.targetMode;
            if (mode === lcoeTargetMode) return;

            lcoeTargetMode = mode;
            resetLcoeTimeLegendLock();

            // Update button styles
            lcoeTargetModeButtons.forEach(b => {
                b.classList.toggle('is-active', b.dataset.targetMode === mode);
            });

            syncLcoeControlValues();
            if (targetLcoeContainer) {
                targetLcoeContainer.classList.toggle('hidden', mode !== 'lcoe');
            }

            // Update view
            if (currentViewMode === 'lcoe') {
                updateLcoeView();
            }
        });
    });

    // Target LCOE Input
    if (targetLcoeInput) {
        targetLcoeInput.addEventListener('input', (e) => {
            const value = parseFloat(e.target.value) || 50;
            targetLcoeValue = Math.max(0, value);
            resetLcoeTimeLegendLock();
            if (currentViewMode === 'lcoe' && lcoeTargetMode === 'lcoe') {
                queueLcoeUpdate();
            }
        });
    }

    if (lcoeTimeSlider) {
        lcoeTimeSlider.min = LCOE_TIME_ANCHORS.baseYear;
        lcoeTimeSlider.max = 2050;
        lcoeTimeSlider.value = LCOE_TIME_ANCHORS.baseYear;
        applyLcoeTimeYear(LCOE_TIME_ANCHORS.baseYear, { lockLegend: false });
        lcoeTimeSlider.addEventListener('input', (e) => {
            const year = parseInt(e.target.value, 10);
            applyLcoeTimeYear(Number.isFinite(year) ? year : LCOE_TIME_ANCHORS.baseYear);
        });
    }

    if (lcoeTimePlayBtn) {
        lcoeTimePlayBtn.addEventListener('click', () => {
            if (lcoeTimePlaying) {
                stopLcoeTimeAnimation();
                return;
            }
            lcoeTimePlaying = true;
            lcoeTimePlayBtn.textContent = 'Pause';
            if (lcoeTimeYear >= 2050) {
                applyLcoeTimeYear(LCOE_TIME_ANCHORS.baseYear);
            }
            lcoeTimeInterval = setInterval(() => {
                if (lcoeTimeYear >= 2050) {
                    stopLcoeTimeAnimation();
                    return;
                }
                applyLcoeTimeYear(lcoeTimeYear + 1);
            }, 650);
        });
    }

    if (waccSourceButtons && waccSourceButtons.length) {
        waccSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setWaccMode(mode);
            });
        });
    }
    if (popWaccSourceButtons && popWaccSourceButtons.length) {
        popWaccSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setWaccMode(mode);
            });
        });
    }
    if (capexSourceButtons && capexSourceButtons.length) {
        capexSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setCapexMode(mode);
            });
        });
    }
    if (popCapexSourceButtons && popCapexSourceButtons.length) {
        popCapexSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const mode = btn.dataset.mode;
                setCapexMode(mode);
            });
        });
    }
    if (dieselSourceButtons && dieselSourceButtons.length) {
        dieselSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setDieselPriceMode(btn.dataset.mode);
            });
        });
    }
    if (popDieselSourceButtons && popDieselSourceButtons.length) {
        popDieselSourceButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setDieselPriceMode(btn.dataset.mode);
            });
        });
    }

    [solarCapexInput, batteryCapexInput, solarOpexInput, batteryOpexInput, solarLifeInput, batteryLifeInput, waccInput, ilrInput,
        dieselCapexInput, dieselEfficiencyInput, dieselLifeInput, dieselPriceInput].forEach(input => {
        if (input) input.addEventListener('change', updateLcoeParams);
    });

    if (dieselBackupInput) {
        dieselBackupInput.addEventListener('change', (e) => {
            setDieselBackupEnabled(e.target.checked);
        });
    }

    dieselBackupModeRadios.forEach(radio => {
        radio.addEventListener('change', (e) => {
            if (e.target.checked) setDieselBackupMode(e.target.value);
        });
    });

    syncLcoeControlValues();

    // LCOE Legend Actions
    if (clearRefBtn) {
        clearRefBtn.addEventListener('click', () => {
            lcoeReference = null;
            lcoeDisplayMode = 'delta'; // Reset to delta mode when clearing reference
            resetLcoeTimeLegendLock();
            updateModel();
        });
    }
}

async function updateViewMode(mode) {
    currentViewMode = mode;
    if (mode !== 'lcoe') {
        stopLcoeTimeAnimation();
        resetLcoeTimeLegendLock();
    }

    setDualMapMode(mode === 'population' && populationDisplayMode === 'map');
    if (mode !== 'population') {
        updateSupplyMap({ overlayMode: 'none' });
    }

    // Update Tabs UI
    viewTabs.forEach(tab => {
        const isActive = tab.dataset.mode === mode;
        if (isActive) {
            tab.classList.remove('text-muted', 'hover:text-white', 'hover:bg-white/5');
            tab.classList.add('bg-primary', 'text-black');
        } else {
            tab.classList.add('text-muted', 'hover:text-white', 'hover:bg-white/5');
            tab.classList.remove('bg-primary', 'text-black');
        }
    });

    // Reset state
    cleanupSampleDays();
    if (mode !== 'population') {
        populationChartsContainer.classList.add('hidden');
        if (mapShell) mapShell.classList.remove('hidden');
    }

    // Toggle Panels
    const systemConfig = document.getElementById('primary-controls');
    const lcoeControls = document.getElementById('lcoe-controls');
    const populationSupplyPanel = populationSupplyControls;

    if (mode === 'lcoe') {
        // LCOE mode: Hide system config, show LCOE controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.remove('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.remove('hidden');
        sampleControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'samples') {
        // Samples mode: Show system config + sample controls
        if (systemConfig) systemConfig.classList.remove('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        sampleControls.classList.remove('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'potential') {
        // Potential mode: Hide system config, show potential controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        sampleControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.remove('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    } else if (mode === 'population') {
        // Population mode: Hide system config, show population controls
        if (systemConfig) systemConfig.classList.add('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        sampleControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.remove('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.remove('hidden');
        updatePopulationOverlayToggleUI();
        updatePopulationOverlayControls(populationOverlayMode);
        syncPotentialToggleUI();
        if (populationViewToggle) populationViewToggle.classList.remove('hidden');
    } else {
        // Capacity mode: Show system config only
        if (systemConfig) systemConfig.classList.remove('hidden');
        if (lcoeControls) lcoeControls.classList.add('hidden');
        if (lcoeTimePanel) lcoeTimePanel.classList.add('hidden');
        sampleControls.classList.add('hidden');
        if (potentialControls) potentialControls.classList.add('hidden');
        populationControls.classList.add('hidden');
        if (populationSupplyPanel) populationSupplyPanel.classList.add('hidden');
        if (populationViewToggle) populationViewToggle.classList.add('hidden');
    }

    // Toggle Legends & Map Content
    hideAllLegends();

    if (mode === 'capacity') {
        legendCapacity.classList.remove('hidden');
        updateMap(getSummaryForConfig(currentSolar, currentBatt), currentSolar, currentBatt, { preFiltered: true });
    } else if (mode === 'samples') {
        legendSamples.classList.remove('hidden');
        // Map update handled by sample playback
        updateMap(getSummaryForConfig(currentSolar, currentBatt), currentSolar, currentBatt, { preFiltered: true }); // Ensure map is visible
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    } else if (mode === 'potential') {
        legendPotential.classList.remove('hidden');
        updateToggleUI(potentialLevelButtons, potentialLevel, 'level');
        updateToggleUI(potentialDisplayButtons, potentialDisplayMode, 'display');
        await updatePotentialView();
    } else if (mode === 'lcoe') {
        legendLcoe.classList.remove('hidden');
        await ensureDieselDataLoaded();
        syncLcoeControlValues();
        updateLcoeView();
    } else if (mode === 'population') {
        // LAZY LOAD: Ensure population data is loaded before updating view
        await ensurePopulationModeDataLoaded();
        if (currentViewMode !== mode) return;
        updatePopulationView();
    }
}

function updateUI() {
    // Update stats (use cached aggregates)
    const stats = getSummaryStatsForConfig(currentSolar, currentBatt);
    if (stats && stats.count) {
        if (statAvgCf) statAvgCf.textContent = `${(stats.avg * 100).toFixed(1)}%`;
        if (statMaxCf) statMaxCf.textContent = `${(stats.max * 100).toFixed(1)}%`;
    } else {
        if (statAvgCf) statAvgCf.textContent = '--%';
        if (statMaxCf) statMaxCf.textContent = '--%';
    }

    // Update map
    if (currentViewMode === 'capacity') {
        const filtered = getSummaryForConfig(currentSolar, currentBatt);
        updateMap(filtered, currentSolar, currentBatt, { preFiltered: true });
    } else if (currentViewMode === 'lcoe') {
        queueLcoeUpdate();
    } else if (currentViewMode === 'population') {
        updatePopulationView();
    } else if (currentViewMode === 'potential') {
        updatePotentialView();
    }
}

function updateLcoeParams() {
    lcoeParams.solarCapex = parseFloat(solarCapexInput.value) || 0;
    lcoeParams.batteryCapex = parseFloat(batteryCapexInput.value) || 0;
    lcoeParams.solarOpexPct = (parseFloat(solarOpexInput.value) || 0) / 100;
    lcoeParams.batteryOpexPct = (parseFloat(batteryOpexInput.value) || 0) / 100;
    lcoeParams.solarLife = parseInt(solarLifeInput.value, 10) || 1;
    lcoeParams.batteryLife = parseInt(batteryLifeInput.value, 10) || 1;
    lcoeParams.wacc = (parseFloat(waccInput.value) || 0) / 100;
    lcoeParams.ilr = parseFloat(ilrInput?.value) || 1.3;
    lcoeParams.dieselCapex = parseFloat(dieselCapexInput?.value) || 300;
    lcoeParams.dieselEfficiency = (parseFloat(dieselEfficiencyInput?.value) || 35) / 100;
    lcoeParams.dieselLife = parseInt(dieselLifeInput?.value, 10) || 20;
    lcoeParams.dieselPrice = parseFloat(dieselPriceInput?.value) || 0;
    lcoeParams.dieselPriceMode = dieselPriceMode;
    syncLcoeControlValues();
    resetLcoeTimeLegendLock();
    queueLcoeUpdate();
}

function updateSampleView() {
    // Re-render sample chart if visible
    if (currentViewMode === 'samples') {
        loadSampleWeekData(currentSolar, currentBatt, summaryData);
    }
}

async function getPotentialOverlayState() {
    const loaded = await ensurePotentialDataLoaded();
    if (!loaded) return null;

    const key = potentialLevel === 'level2' ? 'pvout_level2_twh_y' : 'pvout_level1_twh_y';
    const dataAreaKey = potentialLevel === 'level2'
        ? 'pvout_level2_data_area_km2'
        : 'pvout_level1_data_area_km2';
    const isMultiple = potentialDisplayMode === 'multiple';
    let demandMap = null;
    let latBounds = potentialLatBounds[potentialLevel];

    if (isMultiple) {
        const demandLoaded = await ensureElectricityDataLoaded();
        if (!demandLoaded) return null;
        demandMap = electricityDemandMap;
    }

    if (!latBounds) {
        let minLat = Infinity;
        let maxLat = -Infinity;
        potentialData.forEach(row => {
            const dataArea = Number(row[dataAreaKey] || 0);
            const lat = Number(row.latitude);
            if (!Number.isFinite(lat) || dataArea <= 0) return;
            minLat = Math.min(minLat, lat);
            maxLat = Math.max(maxLat, lat);
        });
        if (Number.isFinite(minLat) && Number.isFinite(maxLat)) {
            latBounds = { min: minLat, max: maxLat };
            potentialLatBounds[potentialLevel] = latBounds;
        }
    }

    const values = [];
    potentialData.forEach(row => {
        const lat = Number(row.latitude);
        if (latBounds && (lat < latBounds.min || lat > latBounds.max)) return;
        const total = Number(row[key] || 0);
        if (!Number.isFinite(total)) return;
        values.push(total);
    });

    if (!values.length) {
        return {
            data: [],
            level: potentialLevel,
            displayMode: potentialDisplayMode,
            isMultiple,
            min: null,
            max: null,
            demandMap,
            latBounds,
            key,
            valueCount: 0
        };
    }

    let minVal = Math.min(...values);
    let maxVal = Math.max(...values);
    if (!isMultiple && minVal === maxVal) {
        maxVal = minVal + 1;
    }

    return {
        data: potentialData,
        level: potentialLevel,
        displayMode: potentialDisplayMode,
        isMultiple,
        min: minVal,
        max: maxVal,
        demandMap,
        latBounds,
        key,
        valueCount: values.length
    };
}

async function updatePotentialView() {
    if (currentViewMode !== 'potential') return;
    const state = await getPotentialOverlayState();
    if (!state) return;
    if (currentViewMode !== 'potential') return;

    const { data, isMultiple, min, max, demandMap, latBounds, level, displayMode, valueCount } = state;
    syncPotentialToggleUI();

    if (!valueCount) {
        if (legendPotentialMin) legendPotentialMin.textContent = '--';
        if (legendPotentialMax) legendPotentialMax.textContent = '--';
        updatePotentialMap([], { level: potentialLevel });
        return;
    }

    if (legendPotentialTitle) {
        legendPotentialTitle.textContent = isMultiple ? 'Solar Generation Potential / Electricity Demand Today (x multiple)' : 'Solar Generation Potential (TWh/yr)';
    }
    if (legendPotentialBar) {
        legendPotentialBar.classList.toggle('legend-gradient-potential-multiple', isMultiple);
        legendPotentialBar.classList.toggle('legend-gradient-potential', !isMultiple);
        legendPotentialBar.classList.toggle('hidden', isMultiple);
    }
    if (legendPotentialBuckets) {
        legendPotentialBuckets.classList.toggle('hidden', !isMultiple);
        if (isMultiple) {
            const noData = `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:#6b7280\"></span><span>No data</span></div>`;
            const items = POTENTIAL_MULTIPLE_BUCKETS.map(bucket => (
                `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:${bucket.color}\"></span><span>${bucket.label}</span></div>`
            ));
            legendPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
        }
    }

    if (legendPotentialMin) {
        legendPotentialMin.textContent = isMultiple ? '' : formatNumber(min, 2);
        legendPotentialMin.classList.toggle('hidden', isMultiple);
    }
    if (legendPotentialMax) {
        legendPotentialMax.textContent = isMultiple ? '' : formatNumber(max, 2);
        legendPotentialMax.classList.toggle('hidden', isMultiple);
    }

    updatePotentialMap(data, {
        level,
        min,
        max,
        displayMode,
        demandMap,
        latBounds
    });
}

function updateSampleTime(hour) {
    if (scrubberTime) scrubberTime.textContent = `Hour ${hour}`;
    if (scrubberProgress) scrubberProgress.textContent = `Hour ${hour} / 168`;
    // Update map/chart for specific hour if needed
    // For now, just update the scrubber UI
}

let samplePlayInterval = null;
function toggleSamplePlay() {
    if (samplePlayInterval) {
        clearInterval(samplePlayInterval);
        samplePlayInterval = null;
        samplePlayBtn.textContent = 'Play';
    } else {
        samplePlayBtn.textContent = 'Pause';
        samplePlayInterval = setInterval(() => {
            let val = parseInt(timeScrubber.value, 10);
            val = (val + 1) % 168;
            timeScrubber.value = val;
            updateSampleTime(val);
        }, 100);
    }
}

function resetSamplePlay() {
    if (samplePlayInterval) {
        clearInterval(samplePlayInterval);
        samplePlayInterval = null;
        samplePlayBtn.textContent = 'Play';
    }
    timeScrubber.value = 0;
    updateSampleTime(0);
}

function updateModel() {
    if (updateModel._queued) return;
    updateModel._queued = true;
    requestAnimationFrame(() => {
        updateModel._queued = false;
        updateUI();
    });
}

// Trailing-debounced updateModel for slider 'input' spam. The cheap DOM echo
// (number next to the slider) still runs immediately in handleSolarInput /
// handleBattInput; this only delays the heavy updateUI pass.
let _debouncedUpdateModelTimer = null;
function debouncedUpdateModel() {
    if (_debouncedUpdateModelTimer) clearTimeout(_debouncedUpdateModelTimer);
    _debouncedUpdateModelTimer = setTimeout(() => {
        _debouncedUpdateModelTimer = null;
        updateModel();
    }, 175);
}

// Start
init();

function buildElectricityMetrics(demandData, overlayMode, cfData, lcoeData, potentialState = null) {
    // Similar to population metrics but uses demandData (annual_demand_kwh) as weight
    const metrics = [];

    // Coordinate-based lookups (like map.js uses)
    const roundedKey = (lat, lon) => `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const cfByCoord = new Map();
    if (cfData) cfData.forEach(d => cfByCoord.set(roundedKey(d.latitude, d.longitude), d));
    const lcoeByCoord = new Map();
    if (lcoeData) lcoeData.forEach(d => lcoeByCoord.set(roundedKey(d.latitude, d.longitude), d));
    const potentialById = potentialState?.data ? new Map(potentialState.data.map(d => [d.location_id, d])) : null;
    const potentialByCoord = potentialState?.data ? new Map(potentialState.data.map(d => [roundedKey(d.latitude, d.longitude), d])) : null;

    demandData.forEach(d => {
        if (!d.annual_demand_kwh || d.annual_demand_kwh <= 0) return;

        const key = roundedKey(d.latitude, d.longitude);
        const cfRow = cfByCoord.get(key);
        const lcoeRow = lcoeByCoord.get(key);
        const potentialRow = potentialById?.get(d.location_id) || potentialByCoord?.get(key);

        let metricVal = null;
        let meetsTarget = false;

        if (overlayMode === 'cf' && cfRow) {
            metricVal = cfRow.annual_cf;
            meetsTarget = true;
        } else if (overlayMode === 'lcoe' && lcoeRow) {
            metricVal = lcoeRow.lcoe;
            meetsTarget = true;
        } else if (overlayMode === 'potential') {
            metricVal = getPotentialMetricFromRow(potentialRow, potentialState);
            meetsTarget = Number.isFinite(metricVal);
        } else if (overlayMode === 'none') {
            // When no overlay, use demand itself as the "metric" for charting distribution
            // Convert to TWh for display consistency
            metricVal = d.annual_demand_kwh / 1e9; // TWh
            meetsTarget = true;
        }

        if (metricVal !== null) {
            metrics.push({
                location_id: d.location_id,
                latitude: d.latitude,
                longitude: d.longitude,
                pop: d.annual_demand_kwh, // Original kWh for weighting
                weight: d.annual_demand_kwh / 1e9, // TWh for histogram weighting
                metric: metricVal,
                meetsTarget
            });
        }
    });

    return metrics;
}

function applyAccessMetric(metric) {
    accessMetric = metric;
    setAccessMetric(metric);
}

// Access Toggle Logic
document.addEventListener('DOMContentLoaded', () => {
    const btnRel = document.getElementById('btn-access-rel');
    const btnNone = document.getElementById('btn-access-none');
    const legendBar = document.getElementById('legend-access-bar');
    const legendTitle = document.getElementById('legend-access-title');
    const legendMin = document.getElementById('legend-access-min');
    const legendMid = document.getElementById('legend-access-mid');
    const legendMax = document.getElementById('legend-access-max');
    const legendNote = document.getElementById('legend-access-note');

    if (btnRel && btnNone) {
        btnRel.addEventListener('click', () => {
            applyAccessMetric('reliability');

            // Update UI
            btnRel.classList.add('is-active');
            btnNone.classList.remove('is-active');

            // Update Gradient (Red -> Grey)
            if (legendBar) {
                legendBar.style.background = 'linear-gradient(to right, #ef4444, #6b7280)';
            }
            if (legendTitle) legendTitle.textContent = 'Grid Reliability';
            if (legendMin) legendMin.textContent = '0%';
            if (legendMid) legendMid.textContent = '';
            if (legendMax) legendMax.textContent = '100%';
            if (legendNote) legendNote.textContent = 'No Data (HREA not covered)';

            // Force update
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });

        btnNone.addEventListener('click', () => {
            applyAccessMetric('no_access_pop');

            // Update UI
            btnNone.classList.add('is-active');
            btnRel.classList.remove('is-active');

            // Update Gradient (Dark Grey -> Red)
            if (legendBar) {
                legendBar.style.background = 'linear-gradient(to right, #1e293b, #991b1b, #ff0000)';
            }
            if (legendTitle) legendTitle.textContent = 'Population Without Access';
            if (legendMin) legendMin.textContent = 'Low';
            if (legendMid) legendMid.textContent = '';
            if (legendMax) legendMax.textContent = 'High';
            if (legendNote) legendNote.textContent = 'Dark grey: universal access';

            // Force update
            if (currentViewMode === 'population') {
                updatePopulationView();
            }
        });
    }
});
