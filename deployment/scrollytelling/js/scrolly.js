/**
 * Scrollytelling Controller v2
 * Handles scroll observation, visual state synchronization, charts, and interactive annotations
 */

import { getVisualState, hasAnimation, getAnimation, interpolate } from './visual-states.js';
import { loadSummary, loadPopulationCsv, loadGemPlantsCsv, loadVoronoiGemCapacityCsv, loadElectricityDemandData, loadReliabilityCsv, loadSample, loadSampleColumnar, loadWeeklyFrameCache, loadPvoutPotentialCsv, loadVoronoiWaccCsv, loadVoronoiLocalCapexCsv } from './data.js';
import { initMap, updateMap, updatePopulationSimple, updateLcoeMap, updateLcoePlantOverlay, updatePotentialMap, setAccessMetric, updateMapWithSampleFrame, clearAllMapLayers, map, initSampleFrameMap, updateSampleFrameColors, isSampleFrameInitialized, resetSampleFrameState, renderDualGlobes, hideDualGlobes } from './map.js';
import { capitalRecoveryFactor as crf } from './utils.js';
import { transitionController, initTransitions, TRANSITION_DURATION, interpolateColor } from './transitions.js';
import { showPopulationCfChart, showFossilDisplacementChart, showWeeklySampleChart, showUptimeComparisonChart, showCumulativeCapacityChart, showNoAccessLcoeChart, showGlobalPopulationLcoeChart, hideChart } from './scrolly-charts.js';
import { POTENTIAL_MULTIPLE_BUCKETS, FEATURE_WORKER_LCOE, FEATURE_STAGED_PRELOAD, FEATURE_FRAMECACHE } from './constants.js';

// ========== STATE ==========
let summaryData = [];
let summaryByConfig = new Map();
let summaryStatsByConfig = new Map();
let populationData = [];
let fossilPlants = [];
let fossilCapacityData = [];
let fossilCapacityMap = null;
let reliabilityData = [];
let reliabilityMap = null;
let potentialData = [];
let potentialLatBounds = { level1: null, level2: null };
let electricityDemandMap = null;
let waccMap = new Map();
let localCapexMap = new Map();
let capexMode = 'global'; // 'global' or 'local'
let waccMode = 'global'; // 'global' or 'local'
let capexDataLoaded = false;
let waccDataLoaded = false;
let localCapexCache = new Map();
let localCapexCacheYear = null;
let lcoeOutlookYear = new Date().getFullYear();
let lcoeOutlookPlaying = false;
let lcoeOutlookInterval = null;
let lcoeOutlookMultipliers = { solar: 1, battery: 1 };
let weeklySampleData = null; // Weekly sample cache
let weeklySampleTableCache = new Map();
let weeklySeasonCache = new Map();
let weeklyCoordMap = null;
let currentWeeklyConfigId = 'overbuilt-storage';
let currentWeeklySeason = 'summer';
let populationLoading = null;
let fossilLoading = null;
let reliabilityLoading = null;
let locationIndex = new Map();
let currentSection = null;
let isAnimating = false;
let animationFrame = null;
let animationTimer = null; // Track setTimeout for looping animations
let dataLinkOverride = null; // Tracks if a data-link click has temporarily overridden the view
let weeklyAnimationInterval = null;
let currentWeekFrame = 0;
let isAnimatingWeekly = false;
let currentSolarState = 6; // Default solar capacity
let preloadPromise = null;
let stagedPreloadController = null;
let stagedPreloadSerial = 0;
let weeklySampleKey = null;
let weeklySampleLoading = null;
let weeklySampleRequestId = 0;
let lastLcoeResults = null;
let lastLcoeColorInfo = null;
let lcoeWorker = null;
let lcoeWorkerReady = false;
let lcoeWorkerRequestSeq = 0;
let lcoeWorkerReadyPromise = null;
const lcoeWorkerPending = new Map();
const lcoeWorkerCache = new Map();
const lcoeWorkerInFlight = new Set();
let scrollSections = [];
let scrollSectionIndex = new Map();
let scrollOpacityRaf = null;
let lastOverlayOpacity = null;
let lastScrollMetrics = null;
let pendingSectionId = null;
let pendingSectionVersion = 0;
let currentPotentialLevel = null;
let currentPotentialDisplayMode = 'multiple';
let sectionRenderVersion = 0;

const GAP_FADE_FRACTION = 0.2;
const MIN_BLACK_HOLD_PX = 48;
const PRELOAD_IDLE_TIMEOUT_MS = 1200;

function isSectionRenderCurrent(sectionId, renderVersion) {
    return currentSection === sectionId && renderVersion === sectionRenderVersion;
}

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

// LCOE default parameters
const lcoeParams = {
    solarCapex: 600,
    batteryCapex: 120,
    solarOpexPct: 0.015,
    batteryOpexPct: 0.02,
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07
};
const DEFAULT_LCOE_TARGET_CF = 80;
const DEFAULT_MAP_VIEW = {
    center: [20, 0],
    zoom: 2,
    offsetX: 0,
    offsetY: 0,
    offsetRatioX: 0,
    offsetRatioY: 0
};
const POTENTIAL_LEVEL_HELP = {
    level1: 'Technical: physical suitability + resource constraints only.',
    level2: 'Policy: technical potential with added land-use exclusions (e.g., protected areas).'
};
const WEEKLY_CONFIGS = [
    { id: 'simplistic', label: 'Simplistic', solar: 1, battery: 0, detail: '1 MW solar' },
    { id: 'overbuilt', label: 'Overbuilt', solar: 6, battery: 0, detail: '6 MW solar' },
    { id: 'overbuilt-storage', label: 'Overbuilt + storage', solar: 6, battery: 16, detail: '6 MW + 16 MWh' },
    { id: 'high-uptime', label: 'High uptime', solar: 10, battery: 30, detail: '10 MW + 30 MWh' }
];
const WEEKLY_SEASONS = [
    { id: 'spring', label: 'Spring' },
    { id: 'summer', label: 'Summer' },
    { id: 'fall', label: 'Fall' },
    { id: 'winter', label: 'Winter' }
];

function getConfigKey(solarGw, battGwh) {
    return `s${solarGw}_b${battGwh}`;
}

function prepareSummaryIndexes(data) {
    summaryByConfig = new Map();
    summaryStatsByConfig = new Map();
    locationIndex = new Map();

    const stats = new Map();

    data.forEach((row) => {
        const configKey = getConfigKey(row.solar_gw, row.batt_gwh);
        row._configKey = configKey;

        const configRows = summaryByConfig.get(configKey);
        if (configRows) {
            configRows.push(row);
        } else {
            summaryByConfig.set(configKey, [row]);
        }

        let locationRows = locationIndex.get(row.location_id);
        if (!locationRows) {
            locationRows = [];
            locationIndex.set(row.location_id, locationRows);
        }
        locationRows.push(row);

        let stat = stats.get(configKey);
        if (!stat) {
            stat = { sum: 0, max: -Infinity, count: 0 };
            stats.set(configKey, stat);
        }
        if (Number.isFinite(row.annual_cf)) {
            stat.sum += row.annual_cf;
            stat.max = Math.max(stat.max, row.annual_cf);
            stat.count += 1;
        }
    });

    stats.forEach((stat, key) => {
        summaryStatsByConfig.set(key, {
            count: stat.count,
            avg: stat.count ? stat.sum / stat.count : null,
            max: stat.count ? stat.max : null
        });
    });
}

function getSummaryForConfig(solarGw, battGwh) {
    return summaryByConfig.get(getConfigKey(solarGw, battGwh)) || [];
}

function getSummaryStatsForConfig(solarGw, battGwh) {
    return summaryStatsByConfig.get(getConfigKey(solarGw, battGwh)) || null;
}

// ========== DOM ELEMENTS ==========
const loadingOverlay = document.getElementById('loading');
const loadingStatus = document.getElementById('loading-status');
const visualLabel = document.getElementById('visual-label');
const visualLabelTitle = visualLabel?.querySelector('.visual-label-title');
const visualLabelSubtitle = visualLabel?.querySelector('.visual-label-subtitle');
const sectionDots = document.querySelectorAll('.section-dot');
const animationIndicator = document.getElementById('animation-indicator');
const animationValue = document.getElementById('animation-value');
const weeklyControls = document.getElementById('weekly-controls');
const batteryCapacityControls = document.getElementById('battery-capacity-controls');
const solarSlider = document.getElementById('solar-slider');
const solarValueDisplay = document.getElementById('solar-value-display');
const weeklyConfigButtons = document.querySelectorAll('#weekly-config-toggle button');
const weeklySeasonButtons = document.querySelectorAll('#weekly-season-toggle button');
const batteryLoopReadout = document.getElementById('battery-loop-readout');
const batterySlider = document.getElementById('battery-slider');
const mapElement = document.getElementById('map');

// Legend elements
const legendCapacity = document.getElementById('legend-capacity');
const legendLcoe = document.getElementById('legend-lcoe');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendPopulation = document.getElementById('legend-population');
const legendAccess = document.getElementById('legend-access');
const legendUptime = document.getElementById('legend-uptime');
const legendWeekly = document.getElementById('legend-weekly');
const legendPotential = document.getElementById('legend-potential');
const legendPotentialBuckets = document.getElementById('legend-potential-buckets');

// Potential toggle elements
const potentialToggle = document.getElementById('potential-toggle');
const potentialToggleButtons = document.querySelectorAll('#potential-toggle-buttons button');
const potentialToggleHelp = document.getElementById('potential-toggle-help');

// LCOE Outlook controls
const outlookPanel = document.getElementById('lcoe-outlook-panel');
const outlookTitle = document.getElementById('lcoe-outlook-title');
const outlookPlayBtn = document.getElementById('lcoe-outlook-play');
const outlookSlider = document.getElementById('lcoe-outlook-slider');
const outlookYearLabel = document.getElementById('lcoe-outlook-year');
const outlookTimeline = document.getElementById('lcoe-outlook-timeline');
const outlookCapexButtons = document.querySelectorAll('#lcoe-outlook-capex-toggle button');
const outlookWaccButtons = document.querySelectorAll('#lcoe-outlook-wacc-toggle button');

// Target CF Slider elements
const targetCfContainer = document.getElementById('target-cf-container');
const inlineTargetCfContainer = document.getElementById('inline-target-cf-container');
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfDisplay = document.getElementById('target-cf-display');

// ========== INITIALIZATION ==========
async function init() {
    // Force scroll to top on refresh
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);

    updateLoadingStatus('Loading solar data...');

    try {
        // Load primary data
        const summaryLoadPerf = startPerf('scrolly-summary-load');
        summaryData = await loadSummary();
        endPerf(summaryLoadPerf, { rows: summaryData?.length || 0 });
        console.log(`Loaded ${summaryData.length} summary rows`);
        prepareSummaryIndexes(summaryData);
        if (FEATURE_WORKER_LCOE) {
            ensureScrollyLcoeWorkerReady();
        }

        updateLoadingStatus('Initializing map...');
        await initMap(onLocationSelect);

        // Store map reference globally for transitions
        window.scrollyMap = map;

        // Initialize transitions
        initTransitions();

        // Set up scroll observer
        setupScrollObserver();

        // Set up data-link click handlers
        setupDataLinkHandlers();

        // Set up interactions
        setupInteractions();
        updateOutlookToggleUI();

        // Scroll listener for fades
        window.addEventListener('scroll', handleScroll, { passive: true });
        window.addEventListener('resize', () => {
            scrollSections = [];
            scrollSectionIndex = new Map();
            lastScrollMetrics = null;
            updateScrollOpacity();
        }, { passive: true });

        // Hide loading overlay
        loadingOverlay.classList.add('hidden');

        // Initial render with hero state
        currentSection = 'hero';
        sectionRenderVersion += 1;
        applyVisualState('hero', sectionRenderVersion);
        updateScrollOpacity();

        // Preload scrollytelling datasets in the background for smoother scrolling
        preloadScrollyData({ sectionId: 'hero', immediate: ['potential'] });

        // Ensure map is correctly sized and centered after layout settles
        setTimeout(() => {
            if (map) {
                map.invalidateSize();
                map.setView([20, 0], 2);
            }
        }, 100);

    } catch (error) {
        console.error('Initialization failed:', error);
        updateLoadingStatus('Error loading data. Please refresh.');
    }
}

function getPreloadTaskRunner(taskId) {
    switch (taskId) {
        case 'population': return ensurePopulationData;
        case 'reliability': return ensureReliabilityData;
        case 'fossil': return ensureFossilData;
        case 'potential': return ensurePotentialData;
        case 'electricity': return ensureElectricityData;
        case 'weekly': return preloadWeeklyConfigs;
        case 'wacc': return ensureWaccData;
        case 'capex': return ensureLocalCapexData;
        default: return null;
    }
}

function buildPreloadTaskList(sectionId, immediate = []) {
    const sectionKey = sectionId || currentSection || 'hero';
    const planBySection = {
        hero: ['potential', 'weekly', 'population'],
        'potential-map': ['electricity', 'weekly', 'population'],
        'battery-shadow': ['weekly', 'population'],
        'battery-capacity': ['weekly', 'population', 'reliability'],
        widespread: ['population', 'reliability'],
        'cheap-populous': ['population', 'electricity', 'wacc'],
        'cheap-access': ['reliability', 'population'],
        'better-uptime': ['reliability', 'population'],
        'planned-capacity': ['fossil', 'population'],
        'lcoe-outlook': ['wacc', 'capex', 'population'],
        'path-forward': ['population']
    };

    const ordered = [];
    const seen = new Set();
    const pushTask = (id, priority) => {
        const runner = getPreloadTaskRunner(id);
        if (!runner || seen.has(id)) return;
        seen.add(id);
        ordered.push({ id, priority, run: runner });
    };

    immediate.forEach((taskId) => pushTask(taskId, 'immediate'));
    (planBySection[sectionKey] || []).forEach((taskId) => pushTask(taskId, 'idle'));

    // Always keep low-priority warmup for downstream sections.
    ['population', 'reliability', 'fossil', 'electricity', 'weekly', 'wacc', 'capex']
        .forEach((taskId) => pushTask(taskId, 'idle'));

    return ordered;
}

function getImmediateTasksForSection(sectionId) {
    switch (sectionId) {
        case 'potential-map': return ['potential'];
        case 'battery-shadow': return ['weekly'];
        case 'cheap-populous': return ['population'];
        case 'cheap-access': return ['reliability', 'population'];
        case 'planned-capacity': return ['fossil'];
        case 'lcoe-outlook': return ['wacc', 'capex'];
        default: return [];
    }
}

function waitForIdleWindow(signal, timeout = PRELOAD_IDLE_TIMEOUT_MS) {
    if (signal?.aborted) return Promise.resolve();

    return new Promise((resolve) => {
        const done = () => resolve();
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
            const handle = window.requestIdleCallback(() => done(), { timeout });
            if (signal) {
                signal.addEventListener('abort', () => {
                    window.cancelIdleCallback(handle);
                    done();
                }, { once: true });
            }
            return;
        }

        const timer = setTimeout(done, 32);
        if (signal) {
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                done();
            }, { once: true });
        }
    });
}

async function runStagedPreload(taskList, signal) {
    for (const task of taskList) {
        if (signal?.aborted) return;
        try {
            if (task.priority !== 'immediate') {
                await waitForIdleWindow(signal);
            }
            if (signal?.aborted) return;
            await task.run();
        } catch (err) {
            console.warn(`Preload task failed (${task.id}):`, err);
        }
    }
}

async function preloadScrollyData({ sectionId = null, immediate = [] } = {}) {
    if (!FEATURE_STAGED_PRELOAD) {
        if (preloadPromise) return preloadPromise;
        preloadPromise = Promise.allSettled([
            ensurePopulationData(),
            ensureReliabilityData(),
            ensureFossilData(),
            ensurePotentialData(),
            ensureElectricityData(),
            preloadWeeklyConfigs()
        ]).catch((err) => {
            console.warn('Preload failed:', err);
        });
        return preloadPromise;
    }

    stagedPreloadSerial += 1;
    const runSerial = stagedPreloadSerial;
    if (stagedPreloadController) {
        stagedPreloadController.abort();
    }
    stagedPreloadController = new AbortController();
    const taskList = buildPreloadTaskList(sectionId, immediate);
    const preloadPerf = startPerf('scrolly-preload', {
        sectionId: sectionId || currentSection || 'hero',
        tasks: taskList.map(task => `${task.priority}:${task.id}`)
    });

    preloadPromise = runStagedPreload(taskList, stagedPreloadController.signal)
        .catch((err) => {
            if (stagedPreloadController?.signal?.aborted) return;
            console.warn('Staged preload failed:', err);
        })
        .finally(() => {
            endPerf(preloadPerf, { aborted: stagedPreloadController?.signal?.aborted === true });
            if (runSerial === stagedPreloadSerial) {
                preloadPromise = null;
            }
        });

    return preloadPromise;
}

// ========== LAZY DATA LOADERS ==========

async function ensurePopulationData() {
    if (populationData && populationData.length > 0) return;
    if (populationLoading) return populationLoading;

    populationLoading = (async () => {
        updateLoadingStatus('Loading population data...');
        try {
            populationData = await loadPopulationCsv();
            console.log(`Loaded ${populationData.length} population rows`);

            // Add location_id to population data based on coordinates matching
            const summaryCoordIndex = new Map();
            summaryData.forEach(row => {
                const key = `${row.latitude.toFixed(4)},${row.longitude.toFixed(4)}`;
                if (!summaryCoordIndex.has(key)) {
                    summaryCoordIndex.set(key, row);
                }
            });

            populationData.forEach(pop => {
                const key = `${pop.latitude.toFixed(4)},${pop.longitude.toFixed(4)}`;
                const match = summaryCoordIndex.get(key);
                if (match) {
                    pop.location_id = match.location_id;
                }
            });
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load population data:', error);
        } finally {
            populationLoading = null;
        }
    })();

    return populationLoading;
}

async function ensureFossilData() {
    if (fossilPlants && fossilPlants.length > 0) return;
    if (fossilLoading) return fossilLoading;

    fossilLoading = (async () => {
        updateLoadingStatus('Loading fossil fuel data...');
        try {
            fossilPlants = await loadGemPlantsCsv();
            fossilCapacityData = await loadVoronoiGemCapacityCsv();
            fossilCapacityMap = new Map();
            fossilCapacityData.forEach(row => {
                fossilCapacityMap.set(row.location_id, {
                    coal_mw: row.coal_Existing || 0,
                    oil_gas_mw: row.oil_gas_Existing || 0,
                    bioenergy_mw: row.bioenergy_Existing || 0,
                    nuclear_mw: row.nuclear_Existing || 0,
                    // Add Announced fields for map overlay
                    coal_Announced: row.coal_Announced || 0,
                    oil_gas_Announced: row.oil_gas_Announced || 0,
                    bioenergy_Announced: row.bioenergy_Announced || 0,
                    nuclear_Announced: row.nuclear_Announced || 0
                });
            });
            if (fossilPlants.length && fossilCapacityData.length && window.d3?.Delaunay) {
                const sites = fossilCapacityData.map(d => [d.latitude, d.longitude]);
                const delaunay = window.d3.Delaunay.from(sites);
                fossilPlants.forEach(plant => {
                    if (!Number.isFinite(plant.latitude) || !Number.isFinite(plant.longitude)) return;
                    const idx = delaunay.find(plant.latitude, plant.longitude);
                    if (idx !== -1 && fossilCapacityData[idx]) {
                        plant.location_id = fossilCapacityData[idx].location_id;
                    }
                });
            }
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load fossil data:', error);
        } finally {
            fossilLoading = null;
        }
    })();

    return fossilLoading;
}

async function ensureReliabilityData() {
    if (reliabilityData && reliabilityData.length > 0) return;
    if (reliabilityLoading) return reliabilityLoading;

    reliabilityLoading = (async () => {
        updateLoadingStatus('Loading reliability data...');
        try {
            reliabilityData = await loadReliabilityCsv();
            reliabilityMap = new Map();
            reliabilityData.forEach(row => {
                reliabilityMap.set(row.location_id, row);
            });
            updateLoadingStatus('');
        } catch (error) {
            console.warn('Failed to load reliability data:', error);
        } finally {
            reliabilityLoading = null;
        }
    })();

    return reliabilityLoading;
}

async function ensurePotentialData() {
    if (potentialData && potentialData.length > 0) return;
    updateLoadingStatus('Loading solar potential data...');
    try {
        potentialData = await loadPvoutPotentialCsv();
        updateLoadingStatus('');
    } catch (error) {
        console.warn('Failed to load potential data:', error);
    }
}

function ensurePotentialLatBounds(level = 'level1') {
    if (potentialLatBounds[level]) return potentialLatBounds[level];
    const dataKey = level === 'level2' ? 'pvout_level2_data_area_km2' : 'pvout_level1_data_area_km2';
    let minLat = Infinity;
    let maxLat = -Infinity;
    potentialData.forEach(row => {
        const dataArea = Number(row[dataKey] || 0);
        const lat = Number(row.latitude);
        if (!Number.isFinite(lat) || dataArea <= 0) return;
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    });
    if (Number.isFinite(minLat) && Number.isFinite(maxLat)) {
        potentialLatBounds[level] = { min: minLat, max: maxLat };
    }
    return potentialLatBounds[level];
}

async function ensureElectricityData() {
    if (electricityDemandMap && electricityDemandMap.size > 0) return;
    updateLoadingStatus('Loading electricity demand data...');
    try {
        const demandRows = await loadElectricityDemandData();
        electricityDemandMap = new Map();
        demandRows.forEach(row => {
            electricityDemandMap.set(row.location_id, row);
        });
        updateLoadingStatus('');
    } catch (error) {
        console.warn('Failed to load electricity demand data:', error);
    }
}

async function ensureWaccData() {
    if (waccDataLoaded) return true;
    updateLoadingStatus('Loading local WACC data...');
    try {
        const rows = await loadVoronoiWaccCsv();
        waccMap = new Map();
        rows.forEach(row => {
            const waccPercent = Number(row.wacc_percent);
            if (!Number.isFinite(row.location_id) || !Number.isFinite(waccPercent)) return;
            waccMap.set(row.location_id, waccPercent / 100);
        });
        waccDataLoaded = true;
        updateLoadingStatus('');
        return true;
    } catch (error) {
        console.warn('Failed to load WACC data:', error);
        waccDataLoaded = false;
        return false;
    }
}

async function ensureLocalCapexData() {
    if (capexDataLoaded) return true;
    updateLoadingStatus('Loading local CAPEX data...');
    try {
        const rows = await loadVoronoiLocalCapexCsv();
        localCapexMap = new Map();
        rows.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const values = [
                row.solar_2024, row.solar_2035, row.solar_2050,
                row.battery_2024, row.battery_2035, row.battery_2050
            ];
            if (!values.every(Number.isFinite)) return;
            localCapexMap.set(row.location_id, {
                solar: [row.solar_2024, row.solar_2035, row.solar_2050],
                battery: [row.battery_2024, row.battery_2035, row.battery_2050]
            });
        });
        capexDataLoaded = true;
        resetLocalCapexCache();
        updateLoadingStatus('');
        return true;
    } catch (error) {
        console.warn('Failed to load local CAPEX data:', error);
        capexDataLoaded = false;
        return false;
    }
}

function updateLoadingStatus(message) {
    if (loadingStatus) {
        loadingStatus.textContent = message;
    }
}

const LCOE_OUTLOOK_ANCHORS = (() => {
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

function getLocalCapex(locationId) {
    if (capexMode !== 'local' || !localCapexMap.size) return null;
    if (localCapexCacheYear !== lcoeOutlookYear) {
        localCapexCacheYear = lcoeOutlookYear;
        localCapexCache.clear();
    }
    if (localCapexCache.has(locationId)) {
        return localCapexCache.get(locationId);
    }
    const entry = localCapexMap.get(locationId);
    if (!entry) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const solar = interpolateLocalCapex(lcoeOutlookYear, entry.solar);
    const battery = interpolateLocalCapex(lcoeOutlookYear, entry.battery);
    if (!Number.isFinite(solar) || !Number.isFinite(battery)) {
        localCapexCache.set(locationId, null);
        return null;
    }
    const payload = { solar, battery };
    localCapexCache.set(locationId, payload);
    return payload;
}

function getLocalWacc(locationId) {
    if (waccMode !== 'local' || !waccMap.size) return null;
    const wacc = waccMap.get(locationId);
    return Number.isFinite(wacc) ? wacc : null;
}

function updateOutlookToggleUI() {
    outlookCapexButtons.forEach(btn => {
        const isActive = btn.dataset.mode === capexMode;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
    outlookWaccButtons.forEach(btn => {
        const isActive = btn.dataset.mode === waccMode;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
}

async function setCapexMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (capexMode === normalized) return;
    capexMode = normalized;
    updateOutlookToggleUI();
    resetLocalCapexCache();
    if (capexMode === 'local') {
        await ensureLocalCapexData();
    }
    await refreshLcoeViews();
}

async function setWaccMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (waccMode === normalized) return;
    waccMode = normalized;
    updateOutlookToggleUI();
    if (waccMode === 'local') {
        await ensureWaccData();
    }
    await refreshLcoeViews();
}

async function refreshLcoeViews() {
    if (!currentSection) return;
    if (currentSection === 'lcoe-outlook') {
        updateLcoeOutlookMap();
        return;
    }

    const state = getVisualState(currentSection);
    if (!state) return;

    if (currentSection === 'cheap-populous') {
        await ensurePopulationData();
        const sliderValue = targetCfSlider ? parseInt(targetCfSlider.value, 10) : null;
        const targetCfValue = Number.isFinite(sliderValue) ? sliderValue : (state.targetCf || DEFAULT_LCOE_TARGET_CF);
        const targetCf = targetCfValue / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        updateLcoeMap(lcoeResults, { colorInfo });
        updateLegend('lcoe');
        await showGlobalPopulationLcoeChart(populationData, lcoeResults);
        return;
    }

    if (state.viewMode === 'lcoe') {
        if (currentSection === 'planned-capacity') {
            await ensureFossilData();
        }

        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        const options = { colorInfo };

        if (currentSection === 'planned-capacity') {
            options.fossilPlants = fossilPlants;
            options.fossilCapacityMap = fossilCapacityMap;
        }

        updateLcoeMap(lcoeResults, options);
        updateLegend('lcoe');

        if (currentSection === 'planned-capacity' && fossilCapacityData.length > 0) {
            await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
        }
    }

    if (state.viewMode === 'no-access') {
        await ensurePopulationData();
        await ensureReliabilityData();
        if (reliabilityData.length === 0) return;
        const targetCf = state.targetCf || DEFAULT_LCOE_TARGET_CF;
        const lcoeResults = computeLcoeForAllLocations(targetCf / 100);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;

        const metric = state.accessMetric || 'no_access_pop';
        setAccessMetric(metric);
        updatePopulationSimple(populationData, {
            baseLayer: 'access',
            overlayMode: state.overlayMode || 'none',
            lcoeData: [],
            reliabilityData,
            reliabilityMap,
            accessMetric: metric
        });

        await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCf, lcoeResults);
    }
}

window.updatePlannedCapacityOverlay = (locationIds) => {
    if (currentSection !== 'planned-capacity') return;
    if (!lastLcoeResults || !lastLcoeColorInfo) return;
    let filteredPlants = fossilPlants;
    if (Array.isArray(locationIds) && locationIds.length) {
        const idSet = new Set(locationIds.map(id => Number(id)));
        filteredPlants = fossilPlants.filter(p => idSet.has(Number(p.location_id)));
    }
    updateLcoePlantOverlay(filteredPlants);
};

function applyOutlookYear(year, { triggerUpdate = true } = {}) {
    const normalizedYear = Math.max(LCOE_OUTLOOK_ANCHORS.baseYear, Math.min(2050, year));
    lcoeOutlookYear = normalizedYear;
    lcoeOutlookMultipliers.solar = interpolateFactor(normalizedYear, LCOE_OUTLOOK_ANCHORS.solar);
    lcoeOutlookMultipliers.battery = interpolateFactor(normalizedYear, LCOE_OUTLOOK_ANCHORS.battery);
    resetLocalCapexCache();
    if (outlookYearLabel) outlookYearLabel.textContent = normalizedYear;
    if (outlookSlider) outlookSlider.value = normalizedYear;
    if (triggerUpdate && currentSection === 'lcoe-outlook') {
        updateLcoeOutlookMap();
    }
}

function stopOutlookAnimation() {
    if (lcoeOutlookInterval) {
        clearInterval(lcoeOutlookInterval);
        lcoeOutlookInterval = null;
    }
    lcoeOutlookPlaying = false;
    if (outlookPlayBtn) outlookPlayBtn.textContent = 'Play';
}

function startOutlookAnimation() {
    stopOutlookAnimation();
    lcoeOutlookPlaying = true;
    if (outlookPlayBtn) outlookPlayBtn.textContent = 'Pause';
    if (lcoeOutlookYear >= 2050) {
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear);
    }
    lcoeOutlookInterval = setInterval(() => {
        if (lcoeOutlookYear >= 2050) {
            stopOutlookAnimation();
            return;
        }
        applyOutlookYear(lcoeOutlookYear + 1);
    }, 650);
}

function updateLcoeOutlookMap() {
    const targetCf = DEFAULT_LCOE_TARGET_CF / 100;
    const lcoeResults = computeLcoeForAllLocations(targetCf);
    const colorInfo = buildLcoeColorInfo(lcoeResults);
    lastLcoeResults = lcoeResults;
    lastLcoeColorInfo = colorInfo;
    updateLcoeMap(lcoeResults, { colorInfo });
    updateLegend('lcoe');
    updateVisualLabel({ title: 'LCOE Outlook', subtitle: `Target: ${DEFAULT_LCOE_TARGET_CF}% Capacity Factor • ${lcoeOutlookYear}` });
}

async function onLocationSelect(data, mode) {
    console.log('Location selected:', data, mode);
    const sectionAtStart = currentSection;

    // Section 3: Batteries Make the Sun Shine After Dark
    if (sectionAtStart === 'battery-shadow' && weeklySampleData) {
        // Find the sample data for this location
        // data.location_id comes from the click event
        const locationId = Number(data.location_id);
        const targetLoc = weeklySampleData.find(d => Number(d.location_id) === locationId);

        if (targetLoc) {
            let locationName = `Location ${locationId}`;
            const summaryRow = summaryData.find(d => Number(d.location_id) === Number(locationId));
            if (summaryRow && summaryRow.country) {
                locationName = `${summaryRow.country} (ID: ${locationId})`;
            }

            // Transform Vector data to Time-Step Array for Chart
            const toArray = (field) => {
                if (!field) return [];
                if (Array.isArray(field)) return field;
                if (typeof field.toArray === 'function') return field.toArray();
                return Array.from(field);
            };

            const solar = toArray(targetLoc.solar_gen);
            const batt = toArray(targetLoc.battery_flow);
            const unserved = toArray(targetLoc.unserved_load || targetLoc.unserved);
            const soc = toArray(targetLoc.state_of_charge || targetLoc.soc);

            const chartData = solar.map((s, i) => ({
                solar_gen: s,
                battery_flow: batt[i] || 0,
                unserved: unserved[i] || 0,
                soc: soc[i] || 0
            }));

            console.log(`Updating weekly chart for ${locationName}`);
            await showWeeklySampleChart(chartData, locationName);
            if (currentSection !== sectionAtStart) {
                hideChart();
            }
            // Re-show legend if it was hidden by chart? No, scrolly-visual keeps it.
        }
    }
}

// ========== SCROLL OBSERVER ==========
function setupScrollObserver() {
    const sections = document.querySelectorAll('.scrolly-section, .scrolly-hero');

    const observerOptions = {
        root: null,
        rootMargin: '-30% 0px -30% 0px',
        threshold: 0
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const sectionId = entry.target.dataset.section;
                if (sectionId && sectionId !== currentSection) {
                    onSectionEnter(sectionId);
                }
                entry.target.classList.add('visible', 'active');
            } else {
                entry.target.classList.remove('active');
            }
        });
    }, observerOptions);

    sections.forEach(section => {
        observer.observe(section);
    });

    // Click handlers for section dots
    sectionDots.forEach((dot, index) => {
        dot.addEventListener('click', () => {
            const targetSection = document.getElementById(`section-${index + 1}`);
            if (targetSection) {
                targetSection.scrollIntoView({ behavior: 'smooth' });
            }
        });
    });
}

function onSectionEnter(sectionId) {
    console.log('Entering section:', sectionId);
    const sectionPerf = startPerf('scrolly-section-enter', { sectionId });

    // STOP ALL ANIMATIONS IMMEDIATELY
    stopAnimations();

    currentSection = sectionId;
    sectionRenderVersion += 1;
    const renderVersion = sectionRenderVersion;

    // Clear any data-link override when scrolling to a new section
    if (dataLinkOverride) {
        dataLinkOverride = null;
        document.querySelectorAll('.data-link.active').forEach(el => el.classList.remove('active'));
    }

    // Stop weekly animation if leaving Step 3
    if (sectionId !== 'battery-shadow') {
        stopWeeklyAnimation();
    }

    updateSectionDots(sectionId);

    preloadScrollyData({
        sectionId,
        immediate: FEATURE_STAGED_PRELOAD ? getImmediateTasksForSection(sectionId) : []
    });

    applyVisualState(sectionId, renderVersion);
    endPerf(sectionPerf);
}

function setupInteractions() {
    // Debounce timer for weekly data loading
    let weeklyDebounceTimer = null;
    const DEBOUNCE_DELAY = 300; // ms

    // Helper to show/hide loading state on weekly controls
    const setWeeklyLoading = (loading) => {
        const indicator = document.getElementById('animation-indicator');
        if (indicator) {
            if (loading) {
                indicator.style.opacity = '0.5';
                indicator.classList.add('loading');
            } else {
                indicator.style.opacity = '1';
                indicator.classList.remove('loading');
            }
        }
    };

    if (weeklyConfigButtons && weeklyConfigButtons.length > 0) {
        weeklyConfigButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const configId = btn.dataset.config;
                if (!configId || configId === currentWeeklyConfigId) return;
                currentWeeklyConfigId = configId;
                updateWeeklyToggleUI();

                if (currentSection !== 'battery-shadow') return;

                if (weeklyDebounceTimer) clearTimeout(weeklyDebounceTimer);
                weeklyDebounceTimer = setTimeout(async () => {
                    currentWeekFrame = 0;
                    setWeeklyLoading(true);
                    await updateWeeklyData(currentWeeklyConfigId, currentWeeklySeason, { force: false });
                    if (weeklySampleData) {
                        stopWeeklyAnimation();
                        startWeeklyAnimation();
                    }
                    setWeeklyLoading(false);
                }, DEBOUNCE_DELAY);
            });
        });
    }

    if (weeklySeasonButtons && weeklySeasonButtons.length > 0) {
        weeklySeasonButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const seasonId = btn.dataset.season;
                if (!seasonId || seasonId === currentWeeklySeason) return;
                currentWeeklySeason = seasonId;
                updateWeeklyToggleUI();

                if (currentSection !== 'battery-shadow') return;

                if (weeklyDebounceTimer) clearTimeout(weeklyDebounceTimer);
                weeklyDebounceTimer = setTimeout(async () => {
                    currentWeekFrame = 0;
                    setWeeklyLoading(true);
                    await updateWeeklyData(currentWeeklyConfigId, currentWeeklySeason, { force: false });
                    if (weeklySampleData) {
                        stopWeeklyAnimation();
                        startWeeklyAnimation();
                    }
                    setWeeklyLoading(false);
                }, DEBOUNCE_DELAY);
            });
        });
    }

    if (solarSlider) {
        solarSlider.addEventListener('input', () => {
            const val = parseInt(solarSlider.value, 10);
            if (!Number.isFinite(val)) return;
            currentSolarState = val;
            if (solarValueDisplay) solarValueDisplay.textContent = val;

            if (currentSection === 'battery-capacity') {
                const batteryVal = animationValue ? parseInt(animationValue.textContent, 10) : 0;
                if (Number.isFinite(batteryVal) && summaryData.length > 0) {
                    const cfData = getSummaryForConfig(currentSolarState, batteryVal);
                    updateMap(cfData, currentSolarState, batteryVal, {
                        ...(getVisualState('battery-capacity')?.mapOptions || {}),
                        preFiltered: true
                    });
                }
            }
        });
    }

    if (potentialToggleButtons && potentialToggleButtons.length > 0) {
        potentialToggleButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                if (currentSection !== 'potential-map') return;
                const level = btn.dataset.level;
                if (!level || level === currentPotentialLevel) return;
                await applyPotentialLevel(level, { updateLabel: true, updateMap: true });
            });
        });
    }

    if (targetCfSlider) {
        targetCfSlider.addEventListener('input', async (e) => {
            const val = parseInt(e.target.value, 10);
            if (targetCfDisplay) targetCfDisplay.textContent = val;

            if (currentSection === 'planned-capacity') {
                // Re-calculate LCOE and update map/chart in real-time
                const targetCf = val / 100.0;
                const lcoeResults = computeLcoeForAllLocations(targetCf);

                // Update Map
                const colorInfo = buildLcoeColorInfo(lcoeResults);
                lastLcoeResults = lcoeResults;
                lastLcoeColorInfo = colorInfo;
                updateLcoeMap(lcoeResults, { colorInfo, fossilCapacityMap, fossilPlants });
                updateVisualLabel({ title: 'LCOE Map', subtitle: `Target: ${val}% Capacity Factor` });

                // Update Chart
                await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
            } else if (currentSection === 'cheap-access') {
                const targetCfValue = val;
                const lcoeResults = computeLcoeForAllLocations(targetCfValue / 100);
                const colorInfo = buildLcoeColorInfo(lcoeResults);

                updatePopulationSimple(populationData, {
                    baseLayer: 'access',
                    overlayMode: 'none',
                    lcoeData: [],
                    reliabilityData,
                    reliabilityMap,
                    accessMetric: 'no_access_pop'
                });

                await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCfValue, lcoeResults);
            } else if (currentSection === 'cheap-populous') {
                await ensurePopulationData();
                const targetCf = val / 100;
                const lcoeResults = computeLcoeForAllLocations(targetCf);
                const colorInfo = buildLcoeColorInfo(lcoeResults);
                lastLcoeResults = lcoeResults;
                lastLcoeColorInfo = colorInfo;
                updateLcoeMap(lcoeResults, { colorInfo });
                await showGlobalPopulationLcoeChart(populationData, lcoeResults);
            }
        });
    }

    if (outlookSlider) {
        outlookSlider.min = LCOE_OUTLOOK_ANCHORS.baseYear;
        outlookSlider.max = 2050;
        outlookSlider.value = LCOE_OUTLOOK_ANCHORS.baseYear;
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
        outlookSlider.addEventListener('input', (e) => {
            const year = parseInt(e.target.value, 10);
            applyOutlookYear(Number.isFinite(year) ? year : LCOE_OUTLOOK_ANCHORS.baseYear);
        });
    }

    if (outlookPlayBtn) {
        outlookPlayBtn.addEventListener('click', () => {
            if (lcoeOutlookPlaying) {
                stopOutlookAnimation();
            } else {
                startOutlookAnimation();
            }
        });
    }

    if (outlookCapexButtons && outlookCapexButtons.length) {
        outlookCapexButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setCapexMode(btn.dataset.mode);
            });
        });
    }

    if (outlookWaccButtons && outlookWaccButtons.length) {
        outlookWaccButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setWaccMode(btn.dataset.mode);
            });
        });
    }
}



function updateSectionDots(sectionId) {
    const sectionIndex = getSectionIndex(sectionId);
    sectionDots.forEach((dot, index) => {
        dot.classList.toggle('active', index === sectionIndex);
    });
}

function getSectionIndex(sectionId) {
    const map = {
        'hero': -1,
        'potential-map': 0,
        'battery-shadow': 1,
        'battery-capacity': 2,
        'widespread': 3,
        'cheap-populous': 4,
        'cheap-access': 5,
        'better-uptime': 6,
        'planned-capacity': 7,
        'lcoe-outlook': 8,
        'path-forward': 9
    };
    return map[sectionId] ?? -1;
}

// ========== DATA-LINK HANDLERS ==========
function setupDataLinkHandlers() {
    const dataLinks = document.querySelectorAll('.data-link');

    dataLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            handleDataLinkClick(link);
        });
    });
}

async function handleDataLinkClick(link) {
    const chartType = link.dataset.chart;
    const view = link.dataset.view;
    const stat = link.dataset.stat;

    // Mark this link as active
    document.querySelectorAll('.data-link.active').forEach(el => el.classList.remove('active'));
    link.classList.add('active');
    dataLinkOverride = { chartType, view, stat };

    console.log('Data link clicked:', { chartType, view, stat });

    // Apply crossfade effect
    if (mapElement) {
        mapElement.style.opacity = '0.6';
    }

    // Handle different chart types
    if (chartType === 'population-cf') {
        const cfData = getSummaryForConfig(5, 8);
        await showPopulationCfChart(populationData, cfData);
        updateVisualLabel({ title: 'Population Distribution', subtitle: 'By Capacity Factor Percentile' });
    } else if (chartType === 'fossil-displacement') {
        const cfData = getSummaryForConfig(6, 20);
        await showFossilDisplacementChart(fossilCapacityData, cfData, ['coal']);
        updateVisualLabel({ title: 'Coal Displacement Potential', subtitle: 'Capacity by CF Viability' });
    } else if (view === 'lcoe') {
        hideChart();
        const targetCf = DEFAULT_LCOE_TARGET_CF / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        updateLcoeMap(lcoeResults, { colorInfo, fossilPlants });
        updateLegend('lcoe');
        updateVisualLabel({ title: 'LCOE Map', subtitle: `Target: ${DEFAULT_LCOE_TARGET_CF}% Capacity Factor` });
    } else if (link.dataset.section) {
        // Manual navigation link inside text
        const target = document.querySelector(`[data-section="${link.dataset.section}"]`);
        if (target) target.scrollIntoView({ behavior: 'smooth' });
    }

    // Fade map back in
    setTimeout(() => {
        if (mapElement) {
            mapElement.style.opacity = '1';
        }
    }, TRANSITION_DURATION);
}

// ========== VISUAL STATE APPLICATION ==========
function resolveMapView(state) {
    const config = state?.mapView || {};
    const view = {
        center: Array.isArray(config.center) && config.center.length === 2 ? config.center : DEFAULT_MAP_VIEW.center,
        zoom: Number.isFinite(config.zoom) ? config.zoom : DEFAULT_MAP_VIEW.zoom,
        offsetX: Number.isFinite(config.offsetX) ? config.offsetX : DEFAULT_MAP_VIEW.offsetX,
        offsetY: Number.isFinite(config.offsetY) ? config.offsetY : DEFAULT_MAP_VIEW.offsetY,
        offsetRatioX: Number.isFinite(config.offsetRatioX) ? config.offsetRatioX : DEFAULT_MAP_VIEW.offsetRatioX,
        offsetRatioY: Number.isFinite(config.offsetRatioY) ? config.offsetRatioY : DEFAULT_MAP_VIEW.offsetRatioY
    };

    const size = map?.getSize?.();
    if (size) {
        view.offsetX += view.offsetRatioX * size.x;
        view.offsetY += view.offsetRatioY * size.y;
    }

    return view;
}

function resetMapViewForSection(state) {
    if (!map) return;

    const { center, zoom } = resolveMapView(state);
    map.setView(center, zoom, { animate: false, noMoveStart: true });

    requestAnimationFrame(() => {
        if (!map) return;
        map.invalidateSize();
        const { offsetX, offsetY } = resolveMapView(state);
        if (offsetX || offsetY) {
            map.panBy([offsetX, offsetY], { animate: false, noMoveStart: true });
        }
    });
}

function updatePotentialToggleUI(level) {
    if (!potentialToggleButtons || potentialToggleButtons.length === 0) return;
    potentialToggleButtons.forEach(btn => {
        const isActive = btn.dataset.level === level;
        if (isActive) {
            btn.classList.add('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.add('text-gray-400');
        }
    });
    if (potentialToggleHelp) {
        potentialToggleHelp.textContent = POTENTIAL_LEVEL_HELP[level] || '';
    }
}

async function applyPotentialLevel(level, { updateLabel = true, updateMap = true } = {}) {
    if (!level || (level !== 'level1' && level !== 'level2')) return;
    currentPotentialLevel = level;
    updatePotentialToggleUI(level);

    if (updateLabel) {
        const label = level === 'level2' ? 'Policy constraints' : 'Technical constraints';
        updateVisualLabel({
            title: 'Solar Potential vs Demand',
            subtitle: `${label} • Multiple of today's demand`
        });
    }

    if (!updateMap) return;

    if (!potentialData || potentialData.length === 0) {
        await ensurePotentialData();
    }
    if (!electricityDemandMap || electricityDemandMap.size === 0) {
        await ensureElectricityData();
    }

    const latBounds = potentialLatBounds[level] || ensurePotentialLatBounds(level) || null;
    transitionController.crossfade(() => {
        updatePotentialMap(potentialData, {
            level,
            displayMode: currentPotentialDisplayMode,
            demandMap: electricityDemandMap,
            latBounds
        });
    });
}

async function applyVisualState(sectionId, renderVersion = sectionRenderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    const state = getVisualState(sectionId);
    if (!state) return;

    console.log('Applying visual state:', sectionId, state);

    const isLcoeView = state.viewMode === 'lcoe' || state.viewMode === 'no-access';
    const showCostPanel = sectionId === 'lcoe-outlook' || isLcoeView;
    if (!showCostPanel) {
        stopOutlookAnimation();
        capexMode = 'global';
        waccMode = 'global';
        updateOutlookToggleUI();
        applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
        if (outlookPanel) outlookPanel.classList.add('hidden');
    } else {
        if (outlookPanel) {
            outlookPanel.classList.remove('hidden');
            if (sectionId !== 'lcoe-outlook') {
                stopOutlookAnimation();
                outlookPanel.classList.add('compact');
                if (outlookTitle) outlookTitle.textContent = 'Cost Assumptions';
                applyOutlookYear(LCOE_OUTLOOK_ANCHORS.baseYear, { triggerUpdate: false });
            } else {
                outlookPanel.classList.remove('compact');
                if (outlookTitle) outlookTitle.textContent = 'LCOE Outlook';
            }
            updateOutlookToggleUI();
        }
    }

    // Ensure necessary data is loaded before rendering map
    if (sectionId === 'cheap-populous') {
        await ensurePopulationData();
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    } else if (sectionId === 'cheap-access' || sectionId === 'better-uptime') {
        await ensureReliabilityData();
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    } else if (sectionId === 'planned-capacity') {
        await ensureFossilData();
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    } else if (sectionId === 'potential-map') {
        await ensurePotentialData();
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
        await ensureElectricityData();
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
        ensurePotentialLatBounds(state.level || 'level1');
    }

    if (shouldDelaySection(sectionId)) {
        pendingSectionId = sectionId;
        pendingSectionVersion = renderVersion;
        return;
    }
    pendingSectionId = null;
    pendingSectionVersion = 0;
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;

    // Update label
    updateVisualLabel(state.label);

    // Update legend visibility
    updateLegend(state.legend);

    if (potentialToggle) {
        if (sectionId === 'potential-map') {
            currentPotentialDisplayMode = state.displayMode || 'multiple';
            await applyPotentialLevel(state.level || 'level1', { updateLabel: false, updateMap: false });
            if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
            potentialToggle.classList.remove('hidden');
        } else {
            potentialToggle.classList.add('hidden');
        }
    }

    // Handle chart visibility based on section
    await handleSectionCharts(sectionId, state, renderVersion);
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;

    // Reset map view for each section so user panning doesn't carry over
    resetMapViewForSection(state);

    // Check for animation
    if (hasAnimation(sectionId) && !isAnimating) {
        runAnimation(sectionId, state, renderVersion);
    } else if (!isAnimating) {
        // Apply crossfade transition
        transitionController.crossfade(() => {
            if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
            renderVisualState(state, sectionId, renderVersion);
        });
    }
}

async function handleSectionCharts(sectionId, state, renderVersion = sectionRenderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    const isStale = () => !isSectionRenderCurrent(sectionId, renderVersion);
    // Hide chart by default
    let showChart = false;

    if (weeklyControls) weeklyControls.classList.add('hidden');
    if (batteryCapacityControls) batteryCapacityControls.classList.add('hidden');
    if (batteryLoopReadout) batteryLoopReadout.classList.add('hidden');

    // Always ensure animation is stopped if not in the correct section
    if (sectionId !== 'battery-shadow') {
        stopWeeklyAnimation();
        const ind = document.getElementById('animation-indicator');
        if (ind) ind.classList.add('hidden');
    }

    const isLcoeView = state?.viewMode === 'lcoe' || state?.viewMode === 'no-access';
    if (sectionId !== 'lcoe-outlook' && !isLcoeView) {
        stopOutlookAnimation();
        if (outlookPanel) outlookPanel.classList.add('hidden');
    }

    // Hide Target CF slider by default
    if (sectionId !== 'planned-capacity' && targetCfContainer) {
        targetCfContainer.classList.add('hidden');
    }
    if (inlineTargetCfContainer) {
        inlineTargetCfContainer.classList.add('hidden');
    }

    // Hide dual globe container when not in Step 4
    if (sectionId !== 'cheap-populous') {
        hideDualGlobes();
    }

    // Section 3: Batteries Make the Sun Shine After Dark
    if (sectionId === 'battery-shadow') {
        // Ensure strictly clear map state before starting animation logic
        clearAllMapLayers();

        // Ensure UI indicator is visible
        const ind = document.getElementById('animation-indicator');
        if (ind) ind.classList.remove('hidden');
        if (weeklyControls) weeklyControls.classList.remove('hidden');
        if (batteryCapacityControls) batteryCapacityControls.classList.add('hidden');
        updateWeeklyToggleUI();
        if (targetCfContainer) targetCfContainer.classList.add('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.add('hidden');

        if (ind) ind.classList.remove('hidden');

        if (!weeklySampleData) {
            await updateWeeklyData(currentWeeklyConfigId, currentWeeklySeason);
            if (isStale()) return;
        }

        if (isStale()) return;

        if (weeklySampleData && weeklySampleData.length > 0) {
            // Start map animation
            startWeeklyAnimation();
        } else {
            console.error("Weekly sample data is empty or failed to load");
        }
    }
    else if (sectionId === 'battery-capacity') {
        if (batteryLoopReadout) batteryLoopReadout.classList.remove('hidden');
        if (batteryCapacityControls) batteryCapacityControls.classList.remove('hidden');
        if (solarSlider) solarSlider.value = currentSolarState;
        if (solarValueDisplay) solarValueDisplay.textContent = currentSolarState;
    }
    // Section 5: High-uptime solar is cheapest where people live
    else if (sectionId === 'cheap-populous') {
        hideDualGlobes();
        await ensurePopulationData();
        if (isStale()) return;
        const state = getVisualState('cheap-populous');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');

        const targetCfValue = state.targetCf || DEFAULT_LCOE_TARGET_CF;
        if (targetCfSlider) {
            targetCfSlider.value = targetCfValue;
            if (targetCfDisplay) targetCfDisplay.textContent = targetCfValue;
        }

        const targetCf = targetCfValue / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        showChart = true;
        await showGlobalPopulationLcoeChart(populationData, lcoeResults);
        if (isStale()) {
            hideChart();
            return;
        }
    }
    // Section 5: Cheap Where Access is Lacking
    else if (sectionId === 'cheap-access') {
        await ensureReliabilityData();
        if (isStale()) return;
        if (reliabilityData.length > 0) {
            showChart = true;
            const targetCfValue = targetCfSlider
                ? parseInt(targetCfSlider.value, 10)
                : (state.targetCf || DEFAULT_LCOE_TARGET_CF);
            const normalizedTargetCf = Number.isFinite(targetCfValue)
                ? targetCfValue
                : (state.targetCf || DEFAULT_LCOE_TARGET_CF);
            const lcoeResults = computeLcoeForAllLocations(normalizedTargetCf / 100);
            await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, normalizedTargetCf, lcoeResults);
            if (isStale()) {
                hideChart();
                return;
            }
        }
    }
    // Section 6: Better Uptime
    else if (sectionId === 'better-uptime') {
        await ensureReliabilityData();
        if (isStale()) return;
        if (reliabilityData.length > 0) {
            showChart = true;
            await showUptimeComparisonChart(reliabilityData, locationIndex, lcoeParams);
            if (isStale()) {
                hideChart();
                return;
            }
        }
    }
    // Section 7: Planned Capacity
    else if (sectionId === 'planned-capacity') {
        await ensureFossilData();
        if (isStale()) return;

        if (targetCfContainer) targetCfContainer.classList.remove('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');

        const plannedTargetCf = getVisualState('planned-capacity')?.targetCf ?? DEFAULT_LCOE_TARGET_CF;
        if (targetCfSlider) {
            targetCfSlider.value = plannedTargetCf;
            if (targetCfDisplay) targetCfDisplay.textContent = plannedTargetCf;
        }

        if (fossilCapacityData.length > 0) {
            showChart = true;

            // Get current slider value
            const sliderVal = targetCfSlider ? parseInt(targetCfSlider.value, 10) : plannedTargetCf;
            const targetCf = sliderVal / 100.0;

            // Compute LCOE
            const lcoeResults = computeLcoeForAllLocations(targetCf);

            // Update Map here explicitly or just rely on applyVisualState calling renderVisualState?
            // renderVisualState is called after this function in applyVisualState via transitionController.
            // But renderVisualState logic for 'planned-capacity' needs to be defined below.
            // Currently 'planned-capacity' viewMode is not explicitly handled in renderVisualState?
            // Check visual-states.js for 'planned-capacity' viewMode. It is likely 'lcoe' or 'population'?
            // Assuming we need to override the map update here or ensure renderVisualState handles it.
            // Let's look at applyVisualState: it calls renderVisualState(state).
            // We need to ensure state.viewMode corresponds to what we want.

            // Render Chart
            await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
            if (isStale()) {
                hideChart();
                return;
            }
        }
    }
    // Section 9: LCOE Outlook
    else if (sectionId === 'lcoe-outlook') {
        if (outlookPanel) outlookPanel.classList.remove('hidden');
        updateOutlookToggleUI();
        applyOutlookYear(lcoeOutlookYear, { triggerUpdate: false });
        updateLcoeOutlookMap();
        startOutlookAnimation();
    }

    if (isStale()) return;
    if (!showChart) {
        hideChart();
    }
}

function updateVisualLabel(label) {
    if (!label) return;
    if (visualLabelTitle) visualLabelTitle.textContent = label.title || '';
    if (visualLabelSubtitle) visualLabelSubtitle.textContent = label.subtitle || '';

    // If both are empty, hide the label container or ensure it's visually empty
    if (visualLabel && !label.title && !label.subtitle) {
        visualLabel.classList.add('hidden');
    } else if (visualLabel) {
        visualLabel.classList.remove('hidden');
    }
}

function updateLegend(legendType) {
    // Hide all legends
    [legendCapacity, legendLcoe, legendPopulation, legendAccess, legendUptime, legendWeekly, legendPotential].forEach(el => {
        if (el) el.classList.add('hidden');
    });

    const legendMap = {
        'capacity': legendCapacity,
        'lcoe': legendLcoe,
        'population': legendPopulation,
        'access': legendAccess,
        'uptime': legendUptime,
        'weekly': legendWeekly,
        'potential': legendPotential
    };

    const targetLegend = legendMap[legendType];
    if (targetLegend) {
        targetLegend.classList.remove('hidden');
    }

    if (legendType === 'potential' && legendPotentialBuckets) {
        const noData = `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:#6b7280\"></span><span>No data</span></div>`;
        const items = POTENTIAL_MULTIPLE_BUCKETS.map(bucket => (
            `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:${bucket.color}\"></span><span>${bucket.label}</span></div>`
        ));
        legendPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
    }

    if (legendType === 'lcoe') {
        if (legendLcoeMin) legendLcoeMin.textContent = '$0';
        if (legendLcoeMid) legendLcoeMid.textContent = '$100';
        if (legendLcoeMax) legendLcoeMax.textContent = '$200';
    }
}

function renderVisualState(state, sectionId = currentSection, renderVersion = sectionRenderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    const { viewMode } = state;

    if (viewMode === 'capacity') {
        const solar = state.solar || 5;
        const battery = state.battery || 8;
        const cfData = getSummaryForConfig(solar, battery);
        updateMap(cfData, solar, battery, { ...(state.mapOptions || {}), preFiltered: true });

    } else if (viewMode === 'potential') {
        const level = state.level || 'level1';
        const displayMode = state.displayMode || 'multiple';
        const latBounds = potentialLatBounds[level] || ensurePotentialLatBounds(level) || null;
        updatePotentialMap(potentialData, { level, displayMode, demandMap: electricityDemandMap, latBounds });

    } else if (viewMode === 'lcoe') {
        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        let options = { colorInfo };
        if (state.overlayPlants === 'announced') {
            options.fossilPlants = fossilPlants;
            options.fossilCapacityMap = fossilCapacityMap;
        }

        updateLcoeMap(lcoeResults, options);

    } else if (viewMode === 'population') {
        const { baseLayer, overlayMode, solar, battery, selectedFuels, selectedStatus } = state;

        let cfData = [];
        if (overlayMode === 'cf' && solar && battery) {
            cfData = getSummaryForConfig(solar, battery);
        }

        if (baseLayer === 'access') {
            setAccessMetric('reliability');
        }

        updatePopulationSimple(populationData, {
            baseLayer: baseLayer || 'population',
            overlayMode: overlayMode || 'none',
            cfData,
            lcoeData: [],
            fossilPlants,
            fossilCapacityMap,
            reliabilityData,
            reliabilityMap,
            selectedFuels: selectedFuels || [],
            selectedStatus: selectedStatus || 'existing'
        });

    } else if (viewMode === 'no-access') {
        const targetCf = state.targetCf || DEFAULT_LCOE_TARGET_CF;
        const lcoeResults = computeLcoeForAllLocations(targetCf / 100);
        const colorInfo = buildLcoeColorInfo(lcoeResults);

        if (targetCfSlider) {
            targetCfSlider.value = targetCf;
            if (targetCfDisplay) targetCfDisplay.textContent = targetCf;
        }

        // Update Slider UI Label
        const sliderLabel = document.querySelector('#target-cf-container .text-xs');
        if (sliderLabel) sliderLabel.innerHTML = 'Minimum cost to reach <span class="text-white font-medium">Uptime</span> of:';

        const metric = state.accessMetric || 'no_access_pop';
        setAccessMetric(metric);
        updatePopulationSimple(populationData, {
            baseLayer: 'access',
            overlayMode: state.overlayMode || 'none',
            lcoeData: [], // Clear LCOE data for the map dots
            reliabilityData,
            reliabilityMap,
            accessMetric: metric
        });

        if (targetCfContainer) targetCfContainer.classList.remove('hidden');
        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');

    } else if (viewMode === 'uptime-comparison') {
        const solar = state.solar || 6;
        const battery = state.battery || 20;
        const cfData = getSummaryForConfig(solar, battery);

        updatePopulationSimple(populationData, {
            baseLayer: 'uptime',
            cfData,
            reliabilityData,
            reliabilityMap
        });

    } else if (viewMode === 'dual-globe') {
        // Step 4: Dual globe visualization
        hideDualGlobes(); // Reset first

        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);

        // Render the dual globes
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        renderDualGlobes(populationData, lcoeResults, { lcoeColorInfo: colorInfo });
    }
}

// ========== ANIMATIONS ==========
function stopAnimations() {
    isAnimating = false;
    if (animationFrame) {
        cancelAnimationFrame(animationFrame);
        animationFrame = null;
    }
    if (animationTimer) {
        clearTimeout(animationTimer);
        animationTimer = null;
    }
    if (animationIndicator) {
        animationIndicator.classList.add('hidden');
    }
}

function runAnimation(sectionId, state, renderVersion = sectionRenderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    // Ensure clean slate
    stopAnimations();

    const animation = getAnimation(sectionId);
    if (!animation) return;

    isAnimating = true;

    if (animationIndicator) {
        animationIndicator.classList.remove('hidden');
    }

    const { type, from, to, duration, easing, loop, steps } = animation;

    if (type === 'battery-loop' && loop) {
        // Looping animation through discrete steps
        runLoopingAnimation(sectionId, state, steps || [0, 8, 16, 24], duration, renderVersion);
    } else if (type === 'battery-slider') {
        // One-shot animation from->to
        runOneShotAnimation(sectionId, state, from, to, duration, easing, renderVersion);
    }
}

function runLoopingAnimation(sectionId, state, steps, totalDuration, renderVersion = sectionRenderVersion) {
    let stepIndex = 0;
    const stepDuration = totalDuration / steps.length;

    function animateStep() {
        // Check if user has scrolled away
        if (!isSectionRenderCurrent(sectionId, renderVersion)) {
            isAnimating = false;
            if (animationIndicator) {
                animationIndicator.classList.add('hidden');
            }
            return;
        }

        const currentValue = steps[stepIndex];

        if (animationValue) {
            animationValue.textContent = currentValue;
        }
        if (batterySlider) {
            batterySlider.value = currentValue;
        }

        if (visualLabelSubtitle) {
            visualLabelSubtitle.textContent = `Cycling: ${currentValue} MWh`;
        }

        // Update map with current battery value AND current solar value from slider
        const cfData = getSummaryForConfig(currentSolarState, currentValue);
        updateMap(cfData, currentSolarState, currentValue, { ...(state.mapOptions || {}), preFiltered: true });

        // Move to next step (loop back to 0)
        stepIndex = (stepIndex + 1) % steps.length;

        // Schedule next step
        animationTimer = setTimeout(animateStep, stepDuration);
    }

    animateStep();
}

function runOneShotAnimation(sectionId, state, from, to, duration, easing, renderVersion = sectionRenderVersion) {
    const startTime = performance.now();

    function animate(currentTime) {
        if (!isSectionRenderCurrent(sectionId, renderVersion)) {
            isAnimating = false;
            if (animationIndicator) {
                animationIndicator.classList.add('hidden');
            }
            return;
        }
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        const currentValue = Math.round(interpolate(from, to, progress, easing));

        if (animationValue) {
            animationValue.textContent = currentValue;
        }
        if (batterySlider) {
            batterySlider.value = currentValue;
        }

        if (visualLabelSubtitle) {
            visualLabelSubtitle.textContent = `Battery: ${currentValue} MWh`;
        }

        const solar = state.solar || 5;
        const cfData = getSummaryForConfig(solar, currentValue);
        updateMap(cfData, solar, currentValue, { ...(state.mapOptions || {}), preFiltered: true });

        if (progress < 1) {
            animationFrame = requestAnimationFrame(animate);
        } else {
            isAnimating = false;
            if (animationIndicator) {
                animationIndicator.classList.add('hidden');
            }
            renderVisualState(state, sectionId, renderVersion);
        }
    }

    animationFrame = requestAnimationFrame(animate);
}

// ========== SCROLL FADE LOGIC ==========
function handleScroll() {
    if (scrollOpacityRaf) return;
    scrollOpacityRaf = requestAnimationFrame(() => {
        scrollOpacityRaf = null;
        updateScrollOpacity();
    });
}

function buildScrollSections() {
    const sections = Array.from(document.querySelectorAll('.scrolly-section, .scrolly-hero'));
    scrollSections = sections.map(section => {
        const bucket = section.querySelector('.scrolly-section-content')
            || section.querySelector('.scrolly-hero-content')
            || section;
        return {
            sectionId: section?.dataset?.section || null,
            element: bucket
        };
    });
    scrollSectionIndex = new Map();
    scrollSections.forEach((entry, index) => {
        if (entry?.sectionId) {
            scrollSectionIndex.set(entry.sectionId, index);
        }
    });
}

function computeScrollMetrics() {
    if (!transitionController.overlayA) return null;

    if (!scrollSections.length) {
        buildScrollSections();
    }
    if (!scrollSections.length) return null;

    const scrollY = window.scrollY || window.pageYOffset || 0;
    const viewportCenter = scrollY + (window.innerHeight / 2);

    const buckets = scrollSections.map(entry => {
        const rect = entry.element.getBoundingClientRect();
        return {
            top: rect.top + scrollY,
            bottom: rect.bottom + scrollY
        };
    });

    let activeIdx = -1;
    for (let i = 0; i < buckets.length; i += 1) {
        if (viewportCenter >= buckets[i].top && viewportCenter <= buckets[i].bottom) {
            activeIdx = i;
            break;
        }
    }

    if (activeIdx !== -1) {
        return {
            prevIdx: activeIdx,
            nextIdx: activeIdx,
            segmentProgress: 0,
            opacity: 0,
            isBlackHold: false,
            activeIdx
        };
    }

    let prevIdx = -1;
    let nextIdx = -1;
    for (let i = 0; i < buckets.length; i += 1) {
        if (buckets[i].bottom < viewportCenter) {
            prevIdx = i;
        }
        if (buckets[i].top > viewportCenter) {
            nextIdx = i;
            break;
        }
    }

    if (prevIdx === -1 || nextIdx === -1) {
        return {
            prevIdx,
            nextIdx,
            segmentProgress: 0,
            opacity: 0,
            isBlackHold: false,
            activeIdx: -1
        };
    }

    const gapStart = buckets[prevIdx].bottom;
    const gapEnd = buckets[nextIdx].top;
    const gap = Math.max(0, gapEnd - gapStart);
    if (gap === 0) {
        return {
            prevIdx,
            nextIdx,
            segmentProgress: 0,
            opacity: 0,
            isBlackHold: false,
            activeIdx: -1
        };
    }

    let fadeLen = gap * GAP_FADE_FRACTION;
    let holdLen = gap - (fadeLen * 2);
    if (holdLen < MIN_BLACK_HOLD_PX) {
        holdLen = Math.min(MIN_BLACK_HOLD_PX, gap);
        fadeLen = (gap - holdLen) / 2;
    }
    if (fadeLen < 0) {
        fadeLen = gap / 2;
        holdLen = 0;
    }

    const fadeOutEnd = gapStart + fadeLen;
    const fadeInStart = gapEnd - fadeLen;
    let opacity = 0;
    let isBlackHold = false;

    if (viewportCenter <= fadeOutEnd) {
        opacity = fadeLen > 0 ? (viewportCenter - gapStart) / fadeLen : 1;
    } else if (viewportCenter >= fadeInStart) {
        opacity = fadeLen > 0 ? 1 - ((viewportCenter - fadeInStart) / fadeLen) : 1;
    } else {
        opacity = 1;
        isBlackHold = true;
    }

    const clampedOpacity = Math.max(0, Math.min(1, opacity));

    return {
        prevIdx,
        nextIdx,
        segmentProgress: 0,
        opacity: clampedOpacity,
        isBlackHold,
        activeIdx: -1
    };
}

function shouldDelaySection(sectionId, metrics = null) {
    if (!sectionId) return false;
    const info = metrics || lastScrollMetrics || computeScrollMetrics();
    if (!info) return false;

    const targetIndex = scrollSectionIndex.get(sectionId);
    if (typeof targetIndex !== 'number') return false;

    const { prevIdx, nextIdx, isBlackHold, activeIdx } = info;
    if (activeIdx !== -1) {
        return activeIdx !== targetIndex;
    }
    if (isBlackHold) return false;
    if (prevIdx === nextIdx) return false;
    if (targetIndex === nextIdx || targetIndex === prevIdx) return true;

    return false;
}

function maybeApplyPendingSection(metrics = null) {
    if (!pendingSectionId) return;
    if (shouldDelaySection(pendingSectionId, metrics)) return;
    const sectionId = pendingSectionId;
    const renderVersion = pendingSectionVersion || sectionRenderVersion;
    pendingSectionId = null;
    pendingSectionVersion = 0;
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    applyVisualState(sectionId, renderVersion);
}

function updateScrollOpacity() {
    if (!transitionController.overlayA) return;

    const metrics = computeScrollMetrics();
    if (!metrics) return;

    lastScrollMetrics = metrics;

    const rounded = Math.round(metrics.opacity * 1000) / 1000;
    if (lastOverlayOpacity !== rounded) {
        transitionController.overlayA.style.opacity = rounded.toString();
        lastOverlayOpacity = rounded;
    }

    maybeApplyPendingSection(metrics);
}

// ========== LCOE CALCULATIONS ==========
function getScrollyLcoeWorker() {
    if (!FEATURE_WORKER_LCOE || typeof Worker === 'undefined') return null;
    if (lcoeWorker) return lcoeWorker;

    lcoeWorker = new Worker(new URL('./workers/lcoe-worker.js', import.meta.url), { type: 'module' });
    lcoeWorker.onmessage = (event) => {
        const { type, requestId, payload } = event.data || {};
        const pending = lcoeWorkerPending.get(requestId);
        if (!pending) return;
        lcoeWorkerPending.delete(requestId);
        if (type === 'ERROR') {
            pending.reject(new Error(payload?.message || 'Scrollytelling LCOE worker error'));
            return;
        }
        pending.resolve(payload || null);
    };
    lcoeWorker.onerror = (event) => {
        console.warn('Scrollytelling LCOE worker failed; using main-thread fallback.', event?.message || event);
        lcoeWorkerReady = false;
        lcoeWorkerReadyPromise = null;
        lcoeWorkerPending.forEach((pending) => pending.reject(new Error('Scrollytelling LCOE worker crashed')));
        lcoeWorkerPending.clear();
    };

    return lcoeWorker;
}

function postScrollyLcoeWorkerMessage(type, payload, timeoutMs = 12000) {
    const worker = getScrollyLcoeWorker();
    if (!worker) {
        return Promise.reject(new Error('Scrollytelling LCOE worker unavailable'));
    }

    const requestId = ++lcoeWorkerRequestSeq;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            lcoeWorkerPending.delete(requestId);
            reject(new Error(`Scrollytelling worker timeout for ${type}`));
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

function serializeScrollyWaccMap() {
    if (waccMode !== 'local' || !waccMap.size) return null;
    const out = {};
    waccMap.forEach((value, locationId) => {
        if (Number.isFinite(value)) out[locationId] = value;
    });
    return out;
}

function serializeScrollyLocalCapexMap() {
    if (capexMode !== 'local' || !localCapexMap.size) return null;
    const out = {};
    localCapexMap.forEach((entry, locationId) => {
        if (!entry) return;
        const solar = interpolateLocalCapex(lcoeOutlookYear, entry.solar);
        const battery = interpolateLocalCapex(lcoeOutlookYear, entry.battery);
        if (!Number.isFinite(solar) || !Number.isFinite(battery)) return;
        out[locationId] = { solar, battery };
    });
    return out;
}

function buildScrollyWorkerCacheKey(targetCf) {
    return JSON.stringify({
        targetCf,
        mode: { capexMode, waccMode, year: lcoeOutlookYear },
        multipliers: lcoeOutlookMultipliers,
        params: {
            solarCapex: lcoeParams.solarCapex,
            batteryCapex: lcoeParams.batteryCapex,
            solarOpexPct: lcoeParams.solarOpexPct,
            batteryOpexPct: lcoeParams.batteryOpexPct,
            solarLife: lcoeParams.solarLife,
            batteryLife: lcoeParams.batteryLife,
            wacc: lcoeParams.wacc
        }
    });
}

async function ensureScrollyLcoeWorkerReady() {
    if (!FEATURE_WORKER_LCOE) return false;
    if (lcoeWorkerReady) return true;
    if (lcoeWorkerReadyPromise) return lcoeWorkerReadyPromise;

    lcoeWorkerReadyPromise = (async () => {
        try {
            const worker = getScrollyLcoeWorker();
            if (!worker || !summaryData.length) return false;
            await postScrollyLcoeWorkerMessage('INIT_DATA', { rows: summaryData }, 20000);
            lcoeWorkerReady = true;
            return true;
        } catch (err) {
            console.warn('Scrollytelling LCOE worker init failed; using fallback.', err);
            lcoeWorkerReady = false;
            return false;
        } finally {
            lcoeWorkerReadyPromise = null;
        }
    })();

    return lcoeWorkerReadyPromise;
}

function scheduleScrollyLcoeWorkerCompute(cacheKey, targetCf) {
    if (!FEATURE_WORKER_LCOE || lcoeWorkerInFlight.has(cacheKey)) return;
    lcoeWorkerInFlight.add(cacheKey);

    (async () => {
        try {
            const ready = await ensureScrollyLcoeWorkerReady();
            if (!ready) return;
            const response = await postScrollyLcoeWorkerMessage('COMPUTE_BEST_LCOE', {
                targetCf,
                params: lcoeParams,
                multipliers: lcoeOutlookMultipliers,
                waccByLocation: serializeScrollyWaccMap(),
                localCapexByLocation: serializeScrollyLocalCapexMap()
            });
            const results = response?.results || [];
            lcoeWorkerCache.set(cacheKey, results);
        } catch (err) {
            console.warn('Scrollytelling LCOE worker compute failed; using fallback.', err);
        } finally {
            lcoeWorkerInFlight.delete(cacheKey);
        }
    })();
}

function computeLcoeForAllLocations(targetCf) {
    const perf = startPerf('scrolly-lcoe-compute', { targetCf, workerEnabled: FEATURE_WORKER_LCOE });
    if (FEATURE_WORKER_LCOE) {
        const cacheKey = buildScrollyWorkerCacheKey(targetCf);
        const cached = lcoeWorkerCache.get(cacheKey);
        scheduleScrollyLcoeWorkerCompute(cacheKey, targetCf);
        if (cached?.length) {
            const cloned = cached.map((row) => ({ ...row }));
            endPerf(perf, { rows: cloned.length, source: 'worker-cache' });
            return cloned;
        }
    }

    const results = [];
    const { solarCapex, batteryCapex, solarOpexPct, batteryOpexPct, solarLife, batteryLife, wacc } = lcoeParams;
    const globalSolarCapex = solarCapex * (lcoeOutlookMultipliers.solar || 1);
    const globalBatteryCapex = batteryCapex * (lcoeOutlookMultipliers.battery || 1);

    locationIndex.forEach((rows, locationId) => {
        let bestConfig = null;
        let minLcoe = Infinity;
        const localCapex = getLocalCapex(locationId);
        const localWacc = getLocalWacc(locationId);
        const effectiveSolarCapex = localCapex?.solar ?? globalSolarCapex;
        const effectiveBatteryCapex = localCapex?.battery ?? globalBatteryCapex;
        const effectiveWacc = localWacc ?? wacc;

        rows.forEach(row => {
            if (row.annual_cf >= targetCf && row.solar_gw <= 10) {
                const lcoe = computeLcoe(row, effectiveSolarCapex, effectiveBatteryCapex, effectiveWacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct);
                if (lcoe < minLcoe) {
                    minLcoe = lcoe;
                    bestConfig = { ...row, lcoe, meetsTarget: true };
                }
            }
        });

        if (bestConfig) {
            results.push(bestConfig);
        } else {
            const maxCfRow = rows.reduce((a, b) => a.annual_cf > b.annual_cf ? a : b);
            const lcoe = computeLcoe(maxCfRow, effectiveSolarCapex, effectiveBatteryCapex, effectiveWacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct);
            results.push({
                ...maxCfRow,
                lcoe,
                meetsTarget: false,
                maxConfigLcoe: lcoe,
                maxConfigSolar: maxCfRow.solar_gw,
                maxConfigBatt: maxCfRow.batt_gwh
            });
        }
    });

    endPerf(perf, { rows: results.length, source: 'main-thread' });
    return results;
}

function computeLcoe(row, solarCapex, batteryCapex, wacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct) {
    const solarKw = row.solar_gw * 1000;
    const batteryKwh = row.batt_gwh * 1000;

    const solarCapexTotal = solarKw * solarCapex;
    const batteryCapexTotal = batteryKwh * batteryCapex;

    const solarCrf = crf(wacc, solarLife);
    const batteryCrf = crf(wacc, batteryLife);
    const annualSolarCost = solarCapexTotal * solarCrf + solarCapexTotal * solarOpexPct;
    const annualBatteryCost = batteryCapexTotal * batteryCrf + batteryCapexTotal * batteryOpexPct;

    const annualMwh = row.annual_cf * 8760;

    if (annualMwh <= 0) return Infinity;

    return (annualSolarCost + annualBatteryCost) / annualMwh;
}

function buildLcoeColorInfo(lcoeResults) {
    const validLcoe = lcoeResults.filter(r => r.meetsTarget && Number.isFinite(r.lcoe)).map(r => r.lcoe);
    if (validLcoe.length === 0) {
        return { type: 'lcoe', domain: [0, 25, 50, 75, 100, 200] };
    }

    return {
        type: 'lcoe',
        domain: [0, 25, 50, 75, 100, 200]
    };
}

// ========== START ==========
document.addEventListener('DOMContentLoaded', init);


// ========== WEEKLY MAP ANIMATION ==========
function getWeeklyConfig(configId) {
    return WEEKLY_CONFIGS.find(config => config.id === configId) || WEEKLY_CONFIGS[0];
}

function ensureWeeklyCoordMap() {
    if (weeklyCoordMap || !summaryData || summaryData.length === 0) return;
    weeklyCoordMap = new Map();
    summaryData.forEach(row => {
        weeklyCoordMap.set(Number(row.location_id), { lat: row.latitude, lon: row.longitude });
    });
}

function resolveSeasonKey(desired, available = []) {
    if (!desired) return available[0] || 'summer';
    const key = desired.toString().toLowerCase();
    if (available.includes(key)) return key;
    if (key === 'fall' && available.includes('autumn')) return 'autumn';
    if (key === 'autumn' && available.includes('fall')) return 'fall';
    if (available.includes('summer')) return 'summer';
    return available[0] || key;
}

function updateWeeklyToggleUI() {
    const configIds = new Set(WEEKLY_CONFIGS.map(config => config.id));
    if (!configIds.has(currentWeeklyConfigId)) {
        currentWeeklyConfigId = WEEKLY_CONFIGS[0]?.id || currentWeeklyConfigId;
    }
    const seasonIds = new Set(WEEKLY_SEASONS.map(season => season.id));
    if (!seasonIds.has(currentWeeklySeason)) {
        currentWeeklySeason = WEEKLY_SEASONS[0]?.id || currentWeeklySeason;
    }

    weeklyConfigButtons.forEach(btn => {
        const isActive = btn.dataset.config === currentWeeklyConfigId;
        if (isActive) {
            btn.classList.add('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.add('text-gray-400');
        }
    });

    weeklySeasonButtons.forEach(btn => {
        const isActive = btn.dataset.season === currentWeeklySeason;
        if (isActive) {
            btn.classList.add('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.add('text-gray-400');
        }
    });
}

async function preloadWeeklyConfigs() {
    await Promise.allSettled(WEEKLY_CONFIGS.map(async (config) => {
        if (weeklySampleTableCache.has(config.id)) return;
        try {
            if (FEATURE_FRAMECACHE) {
                const cacheRows = await loadWeeklyFrameCache(config.id, currentWeeklySeason).catch(() => null);
                if (cacheRows && cacheRows.length) {
                    weeklySeasonCache.set(`${config.id}_${currentWeeklySeason}`, cacheRows);
                    return;
                }
            }
            const wrapper = await loadSampleColumnar(config.solar, config.battery);
            weeklySampleTableCache.set(config.id, wrapper);
        } catch (e) {
            console.warn(`Failed to preload sample data for ${config.id}`, e);
        }
    }));
}

// ========== DATA UPDATES ==========
async function updateWeeklyData(configId, seasonId, { silent = false, force = false } = {}) {
    const config = getWeeklyConfig(configId);
    const desiredSeason = seasonId || currentWeeklySeason;
    const cacheKey = `${config.id}_${desiredSeason}`;
    if (!force && weeklySampleKey === cacheKey && weeklySampleData && weeklySampleData.length > 0) {
        return weeklySampleData;
    }
    if (!force && weeklySampleLoading && weeklySampleKey === cacheKey) {
        return weeklySampleLoading;
    }

    weeklySampleKey = cacheKey;
    const requestId = ++weeklySampleRequestId;

    const run = async () => {
        if (!silent) updateLoadingStatus('Loading sample data...');
        try {
            let seasonData = null;
            let resolvedSeason = desiredSeason;

            if (FEATURE_FRAMECACHE) {
                try {
                    seasonData = await loadWeeklyFrameCache(config.id, desiredSeason);
                    if (seasonData && seasonData.length) {
                        resolvedSeason = resolveSeasonKey(desiredSeason, [desiredSeason]);
                    }
                } catch (frameErr) {
                    console.warn(`Frame cache unavailable for ${config.id}/${desiredSeason}, falling back to legacy samples.`, frameErr);
                    seasonData = null;
                }
            }

            if (!seasonData || !seasonData.length) {
                let wrapper = weeklySampleTableCache.get(config.id);
                if (!wrapper) {
                    wrapper = await loadSampleColumnar(config.solar, config.battery);
                    weeklySampleTableCache.set(config.id, wrapper);
                }
                if (!wrapper || wrapper.numRows === 0) {
                    throw new Error(`No sample data available for ${config.id}`);
                }

                resolvedSeason = resolveSeasonKey(desiredSeason, wrapper.getSeasons());
                const seasonCacheKey = `${config.id}_${resolvedSeason}`;
                seasonData = weeklySeasonCache.get(seasonCacheKey);

                if (!seasonData || force) {
                    seasonData = wrapper.getRowsForSeason(resolvedSeason);
                    ensureWeeklyCoordMap();
                    if (weeklyCoordMap) {
                        seasonData.forEach(row => {
                            const id = Number(row.location_id);
                            if (Number.isFinite(id)) {
                                row.location_id = id;
                            }
                            const c = weeklyCoordMap.get(id);
                            if (c) {
                                row.latitude = c.lat;
                                row.longitude = c.lon;
                            }
                        });
                    }
                    weeklySeasonCache.set(seasonCacheKey, seasonData);
                }
            }

            const resolvedCacheKey = `${config.id}_${resolvedSeason}`;
            if (seasonData?.length) {
                weeklySeasonCache.set(resolvedCacheKey, seasonData);
            }

            if (requestId === weeklySampleRequestId) {
                weeklySampleData = seasonData;
            }
        } catch (e) {
            console.error("Failed to load sample data", e);
            if (requestId === weeklySampleRequestId) {
                weeklySampleData = null; // Reset on failure
            }
        } finally {
            if (!silent) updateLoadingStatus('');
            if (requestId === weeklySampleRequestId) {
                weeklySampleLoading = null;
            }
        }
    };

    weeklySampleLoading = run();
    return weeklySampleLoading;
}

// ========== ANIMATIONS ==========
function startWeeklyAnimation() {
    if (isAnimatingWeekly || weeklyAnimationInterval) return;
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    isAnimatingWeekly = true;
    currentWeekFrame = 0;

    console.log("Starting weekly animation (500ms interval) with optimized rendering...");

    // OPTIMIZED: Initialize markers ONCE if not already done
    if (!isSampleFrameInitialized()) {
        // Force clear map layers first
        clearAllMapLayers();

        // Compute initial colors and initialize all markers
        const initialLocations = computeWeeklyFrameColors(0);
        initSampleFrameMap({
            timestamp: new Date().toISOString(),
            locations: initialLocations
        });
    }

    // Use a timer to update map every 500ms (matching main tool)
    // OPTIMIZED: Only updates colors, not DOM structure
    weeklyAnimationInterval = setInterval(() => {
        renderWeeklyFrameFast();
        // Assuming 168 hours in a week
        const len = weeklySampleData[0]?.timestamps?.length || 168;
        currentWeekFrame = (currentWeekFrame + 1) % len;
    }, 500);
}

function stopWeeklyAnimation() {
    if (weeklyAnimationInterval) {
        clearInterval(weeklyAnimationInterval);
        weeklyAnimationInterval = null;
    }
    isAnimatingWeekly = false;
    // Reset sample frame state when stopping animation (e.g., leaving Step 3)
    resetSampleFrameState();
}

/**
 * Compute colors for all locations at a given frame index.
 * Pure computation - no DOM manipulation.
 */
function computeWeeklyFrameColors(frameIndex) {
    if (!weeklySampleData || weeklySampleData.length === 0) return [];

    return weeklySampleData.map(loc => {
        const locationId = Number(loc.location_id);
        const solarGenVector = loc.solar_gen;
        const battFlowVector = loc.battery_flow;

        // Helper to get value
        const getVal = (vector, idx) => {
            if (!vector) return 0;
            if (vector.get) return vector.get(idx); // Arrow Vector
            return vector[idx]; // Array
        };

        // Calculate local time index based on longitude
        const offset = Math.round(loc.longitude / 15);

        // Data length check
        const dataLen = solarGenVector.length || solarGenVector.toArray?.().length || 168;

        // Use modulo wrapping for localIndex to ensure continuous loop
        let localIndex = ((frameIndex + offset) % dataLen + dataLen) % dataLen;

        let solarGen = 0;
        let battFlow = 0;

        if (localIndex >= 0 && localIndex < dataLen) {
            solarGen = getVal(solarGenVector, localIndex) || 0;
            battFlow = getVal(battFlowVector, localIndex) || 0;
        }

        const discharge = battFlow > 0 ? battFlow : 0;

        // Calculate shares of 1.0 MW load
        let solarShare = Math.min(solarGen, 1.0);
        let batteryShare = Math.min(discharge, 1.0 - solarShare);
        let otherShare = Math.max(0, 1.0 - solarShare - batteryShare);

        // Colors
        // Yellow (Solar): #facc15 -> [250, 204, 21]
        // Purple (Battery): #a855f7 -> [168, 85, 247]
        // Gray (Other): #9ca3af -> [156, 163, 175]
        const r = Math.round(solarShare * 250 + batteryShare * 168 + otherShare * 156);
        const g = Math.round(solarShare * 204 + batteryShare * 85 + otherShare * 163);
        const b = Math.round(solarShare * 21 + batteryShare * 247 + otherShare * 175);

        return {
            location_id: Number.isFinite(locationId) ? locationId : loc.location_id,
            latitude: loc.latitude,
            longitude: loc.longitude,
            color: `rgb(${r}, ${g}, ${b})`,
            solarShare,
            batteryShare,
            otherShare
        };
    });
}

/**
 * OPTIMIZED: Fast render that only updates colors of existing markers.
 * No DOM element creation - just style updates.
 */
function renderWeeklyFrameFast() {
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    const locations = computeWeeklyFrameColors(currentWeekFrame);

    // Use optimized color-only update
    updateSampleFrameColors(locations);
}

/**
 * LEGACY: Full render that recreates all DOM elements.
 * Kept for fallback or moveend handler.
 */
function renderWeeklyFrame() {
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    const locations = computeWeeklyFrameColors(currentWeekFrame);

    updateMapWithSampleFrame({
        timestamp: new Date().toISOString(),
        locations: locations
    });
}
