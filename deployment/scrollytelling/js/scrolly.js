/**
 * Scrollytelling Controller v2
 * Handles scroll observation, visual state synchronization, charts, and interactive annotations
 */

import { getVisualState, hasAnimation, getAnimation, interpolate } from './visual-states.js';
import { loadSummary, loadPopulationCsv, loadGemPlantsCsv, loadVoronoiGemCapacityCsv, loadElectricityDemandData, loadReliabilityCsv, loadSample, loadSampleColumnar, loadWeeklyFrameCache, loadPvoutPotentialCsv, loadVoronoiWaccCsv, loadVoronoiLocalCapexCsv, loadVoronoiGasCsv, loadVoronoiOverlappingCountriesCsv } from './data.js';
import { initMap, updateMap, updatePopulationSimple, updateLcoeMap, updateLcoePlantOverlay, updatePotentialMap, setAccessMetric, updateMapWithSampleFrame, clearAllMapLayers, map, initSampleFrameMap, updateSampleFrameColors, isSampleFrameInitialized, resetSampleFrameState, renderDualGlobes, hideDualGlobes, setCellCountries } from './map.js';
import { capitalRecoveryFactor as crf, levelizedGrowthMultiplier } from './utils.js';
import { transitionController, initTransitions, TRANSITION_DURATION, interpolateColor } from './transitions.js';
import { showPopulationCfChart, showFossilDisplacementChart, showWeeklySampleChart, showUptimeComparisonChart, showCumulativeCapacityChart, showNoAccessLcoeChart, showGlobalPopulationLcoeChart, showBackupCostChart, showLatitudeDemandSupplyChart, hideChart } from './scrolly-charts.js';
import { POTENTIAL_MULTIPLE_BUCKETS, POTENTIAL_PER_CAPITA_BUCKETS, FEATURE_WORKER_LCOE, FEATURE_STAGED_PRELOAD, FEATURE_FRAMECACHE } from './constants.js';

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
let potentialPopulationMap = null; // location_id -> population_2020 (per-capita potential)
let electricityDemandMap = null;
let waccMap = new Map();
let localCapexMap = new Map();
let gasMap = new Map(); // location_id -> { available, price } regional wholesale gas (IGU 2024)
let capexMode = 'global'; // 'global' or 'local'
let waccMode = 'global'; // 'global' or 'local'
let capexDataLoaded = false;
let waccDataLoaded = false;
let gasDataLoaded = false;
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
// Section 2 (battery-capacity) autoplay: sweeps solar (battery 0), then battery (solar max).
let batteryCapAutoplayTimer = null;
let batteryCapFrameIndex = 0;
let batteryCapPlaying = false;
let batteryCapFramesCache = null;
const BATTERY_CAP_STEP_MS = 450;
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
const lcoeWorkerRerenderCtx = new Map(); // cacheKey -> { sectionId, renderVersion } to repaint on arrival
let scrollSections = [];
let scrollOpacityRaf = null;
let scrollRafRequestedTs = 0;
let lastOverlayOpacity = null;
let lastScrollMetrics = null;
// Document-space {top, bottom} per section bucket, so per-scroll-frame metrics
// don't force layout via getBoundingClientRect. Invalidated whenever layout
// can shift section offsets: window resize, any observed element resizing
// (ResizeObserver fires per frame during the Summary fold animation), and
// font loading. Null means "rebuild from fresh rects on next use".
let scrollBucketCache = null;
let scrollBucketResizeObserver = null;

function invalidateScrollBucketCache() {
    scrollBucketCache = null;
}

function observeScrollBucketLayout() {
    if (typeof ResizeObserver === 'undefined') return;
    if (!scrollBucketResizeObserver) {
        scrollBucketResizeObserver = new ResizeObserver(invalidateScrollBucketCache);
    } else {
        scrollBucketResizeObserver.disconnect();
    }
    // Body height changes whenever any content above/below a section grows or
    // shrinks; per-bucket observation additionally catches one bucket growing
    // while another shrinks with total height unchanged.
    scrollBucketResizeObserver.observe(document.body);
    const summarySection = document.querySelector('.scrolly-summary');
    if (summarySection) scrollBucketResizeObserver.observe(summarySection);
    scrollSections.forEach(entry => {
        if (entry.element) scrollBucketResizeObserver.observe(entry.element);
    });
}
let pendingScrollSectionId = null;   // scroll-resolved section waiting for its throttled commit
let sectionCommitTimer = null;       // trailing-edge timer for the pending section switch
let lastSectionCommitTs = 0;         // when the last section switch was committed
let currentPotentialLevel = null;
let currentPotentialDisplayMode = 'multiple';
let sectionRenderVersion = 0;

// ----- Render-readiness gating (smooth, pop-in-free reveals) -----
// The black overlay is held opaque until the incoming section's map is actually
// drawn, then released with a short fade. This decouples the *reveal* from raw
// scroll position so the user never sees an old or half-drawn map.
let mapReady = true;                 // is the current/incoming section's map fully drawn?
let incomingReadySection = 'hero';   // which section mapReady refers to
let currentScrollOpacity = 0;        // last scroll-driven overlay opacity (0..1)
let holdValue = 0;                   // readiness black-hold contribution (0..1)
let holdTarget = 0;                  // where holdValue is heading (0 or 1)
let holdRaf = null;                  // rAF handle for the hold ramp
let holdLastTs = 0;
let mapLoaderTimer = null;           // delays the loader so quick swaps never flash it
let mapLoaderEl = null;
let mapReadySafetyTimer = null;      // failsafe so we never hold black forever
const HOLD_FADE_IN_MS = 220;         // fade to black when a section isn't ready yet
const HOLD_FADE_OUT_MS = 360;        // fade from black once the section is drawn
const MAP_LOADER_DELAY_MS = 300;     // show the subtle loader only past this wait
const MAP_READY_SAFETY_MS = 8000;    // hard cap on the black hold

const GAP_FADE_FRACTION = 0.2;
const MIN_BLACK_HOLD_PX = 48;
const PRELOAD_IDLE_TIMEOUT_MS = 1200;
const SECTION_COMMIT_MIN_INTERVAL_MS = 150; // throttle section switches during fast flings
const GAP_SWITCH_HYSTERESIS_PX = 24;        // keep gap-midpoint jitter from thrashing the map

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
    solarCapex: 720,                 // $/kW_AC (converted to DC via ILR; matches main dashboard)
    batteryCapex: 120,
    ilr: 1.3,                        // Inverter Loading Ratio (DC:AC); divides AC capex to $/kW_DC
    solarOpexPct: 0.015,
    batteryOpexPct: 0.02,
    solarDegradationPct: 0.005,      // 0.5%/yr PV energy degradation
    solarOpexEscalationPct: 0.02,    // 2%/yr O&M escalation
    batteryOpexEscalationPct: 0.02,  // 2%/yr O&M escalation
    solarLife: 30,
    batteryLife: 20,
    wacc: 0.07,
    // Diesel back-up defaults (matched to main dashboard defaults)
    dieselCapex: 300,            // $/kW
    dieselEfficiency: 0.35,      // fraction
    dieselLife: 20,              // years
    dieselPriceUsdPerLiter: 1.30, // flat assumption ($1.00 floor + $0.15 delivery + $0.15 fallback)
    // OCGT gas back-up — competes with diesel per region where a regional wholesale price exists (IGU 2024)
    gasCapex: 800,               // $/kW
    gasEfficiency: 0.35,         // fraction
    gasLife: 25,                 // years
    gasPriceUsdPerMmbtu: 4.88    // global fallback ($/MMBtu); per-region price used where available
};
const DIESEL_THERMAL_KWH_PER_LITER = 10.0;
const MMBTU_PER_MWH = 3.412; // 1 MWh_thermal = 3.412 MMBtu (gas fuel-cost conversion)
const DEFAULT_LCOE_TARGET_CF = 80;
let includeDieselBackup = false;
// Back-up Cost step (section-8): firm target is always 100%. The user sets the share of
// uptime covered by solar+battery via a slider; diesel back-up fills the gap to 100%.
const BACKUP_DEFAULT_SB_TARGET = 95; // default "target solar + battery uptime" (%)
let backupResultsCache = { key: null, results: null };
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
// Section 2 (battery-capacity) scrubbers + play button
const batteryScrubber = document.getElementById('battery-scrubber');
const batteryValueDisplay = document.getElementById('battery-value-display');
const batteryPlayBtn = document.getElementById('battery-play-btn');
// Section 4 (cheap-populous) Map/Chart toggle + latitude chart
const latitudeViewToggle = document.getElementById('latitude-view-toggle');
const latitudeViewButtons = document.querySelectorAll('#latitude-view-toggle button');
const latitudeChartContainer = document.getElementById('latitude-chart-container');
let cheapPopulousView = 'chart'; // 'chart' (Demand & Supply by Latitude) | 'map' (LCOE map)
const mapElement = document.getElementById('map');

// Legend elements
const legendCapacity = document.getElementById('legend-capacity');
const legendLcoe = document.getElementById('legend-lcoe');
const legendLcoeMin = document.getElementById('legend-lcoe-min');
const legendLcoeMid = document.getElementById('legend-lcoe-mid');
const legendLcoeMax = document.getElementById('legend-lcoe-max');
const legendLcoeNote = document.getElementById('legend-lcoe-note');
const legendPopulation = document.getElementById('legend-population');
const legendAccess = document.getElementById('legend-access');
const legendNoAccess = document.getElementById('legend-no-access');
const legendUptime = document.getElementById('legend-uptime');
const legendWeekly = document.getElementById('legend-weekly');
const legendPotential = document.getElementById('legend-potential');
const legendPotentialBuckets = document.getElementById('legend-potential-buckets');
const legendPotentialTitle = document.getElementById('legend-potential-title');

// Potential toggle elements
const potentialToggle = document.getElementById('potential-toggle');
const potentialToggleButtons = document.querySelectorAll('#potential-toggle-buttons button');
const potentialDisplayToggleButtons = document.querySelectorAll('#potential-display-toggle-buttons button');
const potentialToggleHelp = document.getElementById('potential-toggle-help');

// LCOE Outlook controls
const outlookPanel = document.getElementById('lcoe-outlook-panel');
const outlookTitle = document.getElementById('lcoe-outlook-title');
const outlookPlayBtn = document.getElementById('lcoe-outlook-play');
const outlookSlider = document.getElementById('lcoe-outlook-slider');
const outlookYearLabel = document.getElementById('lcoe-outlook-year');
const outlookTimeline = document.getElementById('lcoe-outlook-timeline');
// Single "Cost Basis" toggle drives both CAPEX and WACC together (global vs local).
const outlookCostButtons = document.querySelectorAll('#lcoe-outlook-cost-toggle button');

// Target CF Slider elements
const targetCfContainer = document.getElementById('target-cf-container');
const inlineTargetCfContainer = document.getElementById('inline-target-cf-container');
const targetCfSlider = document.getElementById('target-cf-slider');
const targetCfDisplay = document.getElementById('target-cf-display');

// Inline uptime-slider sub-elements (shared across LCOE chart steps; repurposed for the
// back-up step as "Target Solar + Battery Uptime").
const targetCfLabel = document.getElementById('target-cf-label');

// ========== INITIALIZATION ==========
async function init() {
    // Force scroll to top on refresh
    if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual';
    }
    window.scrollTo(0, 0);

    updateLoadingStatus('Loading solar data...');

    try {
        // Start the three independent startup loads immediately so they run
        // concurrently (initMap doesn't read summary data — it just builds
        // Leaflet and fetches the world geojson; loadSummary touches no DOM).
        // The no-op catches keep an early failure from surfacing as an
        // unhandled rejection while another await is in flight; the awaits
        // below still rethrow into this try/catch in today's order.
        const summaryLoadPerf = startPerf('scrolly-summary-load');
        const summaryPromise = loadSummary();
        summaryPromise.catch(() => {});
        const overlapsPromise = loadVoronoiOverlappingCountriesCsv();
        overlapsPromise.catch(() => {});
        const mapPromise = initMap(onLocationSelect);
        mapPromise.catch(() => {});

        // Load primary data
        summaryData = await summaryPromise;
        endPerf(summaryLoadPerf, { rows: summaryData?.length || 0 });
        console.log(`Loaded ${summaryData.length} summary rows`);
        prepareSummaryIndexes(summaryData);
        if (FEATURE_WORKER_LCOE) {
            ensureScrollyLcoeWorkerReady();
        }

        // Load per-cell country overlaps (small) so every map tooltip can show the
        // country (or countries, for border-straddling cells) the hovered cell covers.
        // Best-effort: a failure just omits the country line, matching the main tool.
        try {
            const overlapRows = await overlapsPromise;
            setCellCountries(new Map(overlapRows.map(r => [r.location_id, r.country_names])));
        } catch (err) {
            console.warn('Overlapping-countries data unavailable:', err);
        }

        updateLoadingStatus('Initializing map...');
        await mapPromise;

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
            lastScrollMetrics = null;
            invalidateScrollBucketCache();
            updateScrollOpacity();
        }, { passive: true });

        // Late font metrics can shift section offsets after first measure.
        if (document.fonts && document.fonts.ready) {
            document.fonts.ready.then(invalidateScrollBucketCache).catch(() => {});
        }
        // The Summary fold toggle shifts every later section's offset. The
        // ResizeObserver tracks the 0.45s fold animation frame-by-frame, but
        // its callbacks run after rAF — this capture-phase hook closes the
        // one-frame window at the moment of the click.
        const summaryToggle = document.getElementById('summary-toggle');
        if (summaryToggle) {
            summaryToggle.addEventListener('click', invalidateScrollBucketCache, { capture: true });
        }

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
        case 'gas': return ensureGasData;
        case 'lcoe': return warmLcoeCache;
        default: return null;
    }
}

// Precompute (in the worker, during idle) the LCOE config the upcoming sections will
// request, so arriving at an LCOE section is an instant cache hit rather than a wait.
async function warmLcoeCache() {
    if (!FEATURE_WORKER_LCOE) return;
    const ready = await ensureScrollyLcoeWorkerReady();
    if (!ready) return;
    const targetCf = DEFAULT_LCOE_TARGET_CF / 100; // 0.8 covers cheap-populous / planned / outlook base
    const cacheKey = buildScrollyWorkerCacheKey(targetCf, false);
    if (!lcoeWorkerCache.has(cacheKey)) {
        scheduleScrollyLcoeWorkerCompute(cacheKey, targetCf);
    }
}

function buildPreloadTaskList(sectionId, immediate = []) {
    const sectionKey = sectionId || currentSection || 'hero';
    const planBySection = {
        hero: ['potential', 'weekly', 'population'],
        'potential-map': ['electricity', 'weekly', 'population'],
        'battery-capacity': ['weekly', 'population'],
        'battery-shadow': ['weekly', 'population', 'wacc'],
        'cheap-populous': ['population', 'reliability', 'wacc'],
        'cheap-access': ['reliability', 'population'],
        'better-uptime': ['reliability', 'wacc', 'capex', 'gas', 'population'],
        'backup-cost': ['wacc', 'capex', 'gas', 'fossil', 'population'],
        'planned-capacity': ['fossil', 'wacc', 'capex', 'gas', 'population'],
        'lcoe-outlook': ['wacc', 'capex', 'gas', 'population'],
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

    // Always keep low-priority warmup for downstream sections (incl. the worker LCOE
    // cache, so the cost maps are ready before the user scrolls into them).
    ['population', 'reliability', 'fossil', 'electricity', 'weekly', 'wacc', 'capex', 'gas', 'lcoe']
        .forEach((taskId) => pushTask(taskId, 'idle'));

    return ordered;
}

function getImmediateTasksForSection(sectionId) {
    switch (sectionId) {
        case 'potential-map': return ['potential'];
        case 'battery-shadow': return ['weekly'];
        case 'cheap-populous': return ['population'];
        case 'cheap-access': return ['reliability', 'population'];
        case 'backup-cost': return ['wacc', 'capex', 'gas'];
        case 'planned-capacity': return ['fossil'];
        case 'lcoe-outlook': return ['wacc', 'capex', 'gas'];
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

// location_id -> population, for the per-capita potential view. Population is
// keyed by lat/lon; potential by location_id + 6-decimal lat/lon. Join on a
// 2-decimal coordinate key (matches 4921/4926 zones, no key collisions).
function ensurePotentialPopulationMap() {
    if (potentialPopulationMap) return potentialPopulationMap;
    if (!populationData.length || !potentialData.length) return null;
    const coord2 = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
    const popByCoord = new Map();
    populationData.forEach(p => {
        if (!Number.isFinite(p.latitude) || !Number.isFinite(p.longitude)) return;
        popByCoord.set(coord2(p.latitude, p.longitude), p.population_2020);
    });
    const map = new Map();
    potentialData.forEach(row => {
        const pop = popByCoord.get(coord2(row.latitude, row.longitude));
        if (pop !== undefined) map.set(row.location_id, pop);
    });
    potentialPopulationMap = map;
    return map;
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

async function ensureGasData() {
    if (gasDataLoaded) return true;
    updateLoadingStatus('Loading regional gas prices...');
    try {
        const rows = await loadVoronoiGasCsv();
        gasMap = new Map();
        rows.forEach(row => {
            if (!Number.isFinite(row.location_id)) return;
            const price = Number(row.gas_2024_usd_per_mmbtu);
            gasMap.set(row.location_id, {
                available: Boolean(row.gas_available) && Number.isFinite(price),
                price: Number.isFinite(price) ? price : null,
                country: row.gas_2024_country || null
            });
        });
        gasDataLoaded = true;
        updateLoadingStatus('');
        return true;
    } catch (error) {
        console.warn('Failed to load gas data:', error);
        gasDataLoaded = false;
        return false;
    }
}

// Regional wholesale gas for a location (always uses IGU data; no global/local toggle here).
function getLocalGas(locationId) {
    if (!gasMap.size) return null;
    return gasMap.get(locationId) || null;
}

// Annualised cost ($/yr per 1 MW backup) of the cheaper firm-backup fuel for a location.
// Diesel uses the Article's flat price; gas uses the regional IGU price where available.
function backupAnnualCost(locationId, backupShareCf, wacc) {
    const backupEnergyMwh = Math.max(0, backupShareCf) * 8760;
    const dieselCapexAnnual = (1000 * lcoeParams.dieselCapex) * crf(wacc, lcoeParams.dieselLife);
    const dieselFuelPerMwh = (lcoeParams.dieselPriceUsdPerLiter * 1000) / (lcoeParams.dieselEfficiency * DIESEL_THERMAL_KWH_PER_LITER);
    const dieselTotal = dieselCapexAnnual + backupEnergyMwh * dieselFuelPerMwh;

    let best = { fuel: 'diesel', capexAnnual: dieselCapexAnnual, fuelAnnual: backupEnergyMwh * dieselFuelPerMwh, totalAnnual: dieselTotal };

    const gasInfo = getLocalGas(locationId);
    if (gasInfo?.available && Number.isFinite(gasInfo.price) && lcoeParams.gasEfficiency > 0) {
        const gasCapexAnnual = (1000 * lcoeParams.gasCapex) * crf(wacc, lcoeParams.gasLife);
        const gasFuelPerMwh = (gasInfo.price * MMBTU_PER_MWH) / lcoeParams.gasEfficiency;
        const gasTotal = gasCapexAnnual + backupEnergyMwh * gasFuelPerMwh;
        if (gasTotal < dieselTotal) {
            best = { fuel: 'gas', capexAnnual: gasCapexAnnual, fuelAnnual: backupEnergyMwh * gasFuelPerMwh, totalAnnual: gasTotal };
        }
    }
    return best;
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
    // CAPEX and WACC always move together here, so the single toggle reflects their shared mode.
    const costMode = capexMode;
    outlookCostButtons.forEach(btn => {
        const isActive = btn.dataset.mode === costMode;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
}

// One toggle drives both CAPEX and WACC: "global" assumes global prices and cost of
// capital (physical comparison); "local" uses on-the-ground prices and financing.
async function setCostMode(mode) {
    const normalized = mode === 'local' ? 'local' : 'global';
    if (capexMode === normalized && waccMode === normalized) return;
    capexMode = normalized;
    waccMode = normalized;
    updateOutlookToggleUI();
    resetLocalCapexCache();
    if (normalized === 'local') {
        await Promise.all([ensureLocalCapexData(), ensureWaccData()]);
    }
    await refreshLcoeViews();
}

async function refreshLcoeViews() {
    if (!currentSection) return;
    if (currentSection === 'lcoe-outlook') {
        updateLcoeOutlookMap();
        return;
    }

    if (currentSection === 'backup-cost') {
        await Promise.all([ensurePopulationData(), ensureGasData()]);
        const sbTarget = getBackupSbTarget();
        renderBackupMap(sbTarget);
        await showBackupCostChart(getBackupResults(sbTarget), populationData, sbTarget);
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
        if (cheapPopulousView === 'chart') {
            if (legendLcoe) legendLcoe.classList.add('hidden');
            await showLatitudeDemandSupplyChart(populationData, lcoeResults);
        }
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
        // Skip ticks while the tab is hidden so the LCOE recompute for all
        // locations doesn't run in a background tab; the year freezes and the
        // sweep resumes from the same point when the tab becomes visible.
        if (document.hidden) return;
        if (lcoeOutlookYear >= 2050) {
            stopOutlookAnimation();
            return;
        }
        applyOutlookYear(lcoeOutlookYear + 1);
    }, 650);
}

function updateLcoeOutlookMap() {
    const outlookState = getVisualState('lcoe-outlook');
    const targetCfValue = outlookState.targetCf || DEFAULT_LCOE_TARGET_CF;
    const targetCf = targetCfValue / 100;
    const lcoeResults = computeLcoeForAllLocations(targetCf);
    const colorInfo = buildLcoeColorInfo(lcoeResults);
    lastLcoeResults = lcoeResults;
    lastLcoeColorInfo = colorInfo;
    updateLcoeMap(lcoeResults, { colorInfo });
    updateLegend('lcoe');
    updateVisualLabel({ title: 'LCOE Outlook', subtitle: `Target: ${targetCfValue}% Capacity Factor • ${lcoeOutlookYear}` });
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

    // The observer only handles the cosmetic text fade-in ('visible'). Section/map
    // switching is driven from scroll position in updateScrollOpacity instead:
    // IntersectionObserver callbacks arrive late and batched during fast scrolling, and
    // with 120vh sections two of them can intersect the band at once — processing the
    // batch in document order left currentSection stuck on the wrong (document-last)
    // section when scrolling up, with no further event to correct it.
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('visible');
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

    // Hold the overlay black until this section's map is actually drawn (released
    // in markIncomingReady once renderVisualState / the animation paints a frame).
    beginSectionHold(sectionId);

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
    updateActiveSectionClass(sectionId);

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
                stopBatteryCapAutoplay(); // grabbing a slider pauses the sweep
                const batteryVal = batteryScrubber ? parseInt(batteryScrubber.value, 10) : 0;
                if (Number.isFinite(batteryVal) && summaryData.length > 0) {
                    batteryCapFrameIndex = nearestBatteryCapFrame(val, batteryVal);
                    const cfData = getSummaryForConfig(val, batteryVal);
                    updateMap(cfData, val, batteryVal, {
                        ...(getVisualState('battery-capacity')?.mapOptions || {}),
                        preFiltered: true
                    });
                }
            }
        });
    }

    if (batteryScrubber) {
        batteryScrubber.addEventListener('input', () => {
            const battery = parseInt(batteryScrubber.value, 10);
            if (!Number.isFinite(battery)) return;
            if (batteryValueDisplay) batteryValueDisplay.textContent = battery;
            if (currentSection === 'battery-capacity') {
                stopBatteryCapAutoplay(); // grabbing a slider pauses the sweep
                const solar = currentSolarState;
                if (summaryData.length > 0) {
                    batteryCapFrameIndex = nearestBatteryCapFrame(solar, battery);
                    const cfData = getSummaryForConfig(solar, battery);
                    updateMap(cfData, solar, battery, {
                        ...(getVisualState('battery-capacity')?.mapOptions || {}),
                        preFiltered: true
                    });
                }
            }
        });
    }

    if (batteryPlayBtn) {
        batteryPlayBtn.addEventListener('click', () => {
            if (currentSection !== 'battery-capacity') return;
            if (batteryCapPlaying) {
                stopBatteryCapAutoplay();
            } else {
                startBatteryCapAutoplay('battery-capacity', getVisualState('battery-capacity'), sectionRenderVersion);
            }
        });
    }

    if (latitudeViewButtons && latitudeViewButtons.length) {
        latitudeViewButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                if (currentSection !== 'cheap-populous') return;
                const view = btn.dataset.latview === 'chart' ? 'chart' : 'map';
                if (view === cheapPopulousView) return;
                cheapPopulousView = view;
                await applyCheapPopulousView();
            });
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

    if (potentialDisplayToggleButtons && potentialDisplayToggleButtons.length > 0) {
        potentialDisplayToggleButtons.forEach(btn => {
            btn.addEventListener('click', async () => {
                if (currentSection !== 'potential-map') return;
                const mode = btn.dataset.display;
                if (!mode || mode === currentPotentialDisplayMode) return;
                currentPotentialDisplayMode = mode;
                updatePotentialDisplayToggleUI(mode);
                updateLegend('potential');
                await applyPotentialLevel(currentPotentialLevel || 'level1', { updateLabel: true, updateMap: true });
            });
        });
    }

    async function refreshTargetCfSection(val) {
        if (currentSection === 'planned-capacity') {
            const targetCf = val / 100.0;
            const lcoeResults = computeLcoeForAllLocations(targetCf);

            const colorInfo = buildLcoeColorInfo(lcoeResults);
            lastLcoeResults = lcoeResults;
            lastLcoeColorInfo = colorInfo;
            updateLcoeMap(lcoeResults, { colorInfo, fossilCapacityMap, fossilPlants });
            updateVisualLabel({ title: 'LCOE Map', subtitle: `Target: ${val}% Capacity Factor${includeDieselBackup ? ' + firm back-up' : ''}` });
            updateLegend('lcoe');

            await showCumulativeCapacityChart(fossilCapacityData, lcoeResults);
        } else if (currentSection === 'cheap-access') {
            const targetCfValue = val;
            const lcoeResults = computeLcoeForAllLocations(targetCfValue / 100);

            updatePopulationSimple(populationData, {
                baseLayer: 'access',
                overlayMode: 'none',
                lcoeData: [],
                reliabilityData,
                reliabilityMap,
                accessMetric: 'no_access_pop'
            });

            await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCfValue, lcoeResults, { includeDieselBackup });
        } else if (currentSection === 'cheap-populous') {
            await ensurePopulationData();
            const targetCf = val / 100;
            const lcoeResults = computeLcoeForAllLocations(targetCf);
            const colorInfo = buildLcoeColorInfo(lcoeResults);
            lastLcoeResults = lcoeResults;
            lastLcoeColorInfo = colorInfo;
            updateLcoeMap(lcoeResults, { colorInfo });
            await showGlobalPopulationLcoeChart(populationData, lcoeResults);
            if (cheapPopulousView === 'chart') {
                await showLatitudeDemandSupplyChart(populationData, lcoeResults);
            }
        } else if (currentSection === 'backup-cost') {
            await Promise.all([ensurePopulationData(), ensureGasData()]);
            const sbTarget = val / 100;
            renderBackupMap(sbTarget);
            await showBackupCostChart(getBackupResults(sbTarget), populationData, sbTarget);
        }
    }

    if (targetCfSlider) {
        targetCfSlider.addEventListener('input', async (e) => {
            const val = parseInt(e.target.value, 10);
            if (targetCfDisplay) targetCfDisplay.textContent = val;
            await refreshTargetCfSection(val);
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

    if (outlookCostButtons && outlookCostButtons.length) {
        outlookCostButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                setCostMode(btn.dataset.mode);
            });
        });
    }
}



// ========== SECTION 4: MAP / CHART TOGGLE (Demand & Supply by Latitude) ==========
function updateLatitudeToggleUI() {
    latitudeViewButtons.forEach(btn => {
        const active = btn.dataset.latview === cheapPopulousView;
        btn.classList.toggle('bg-white/10', active);
        btn.classList.toggle('text-white', active);
        btn.classList.toggle('text-gray-400', !active);
    });
}

// Swap the top visual between the LCOE map and the latitude chart. The bottom cumulative
// chart + uptime slider stay put in both views, so the toggle only affects the map area.
async function applyCheapPopulousView() {
    updateLatitudeToggleUI();
    const chartMode = cheapPopulousView === 'chart';
    if (latitudeChartContainer) {
        latitudeChartContainer.classList.toggle('hidden', !chartMode);
        // Reserve a top control bar (clears the Map/Chart toggle + cost-basis pill).
        latitudeChartContainer.classList.toggle('cp-chart-mode', chartMode);
    }
    // In chart mode the chart carries its own axes, so hide the LCOE colour legend.
    if (legendLcoe) legendLcoe.classList.toggle('hidden', chartMode);
    // In chart mode, collapse the "Cost Assumptions" panel into a slim top-bar pill so
    // it no longer overlaps the chart; restore the normal card for the LCOE map view.
    if (outlookPanel) outlookPanel.classList.toggle('cp-chart-cost', chartMode);
    if (chartMode) {
        await ensurePopulationData();
        const val = targetCfSlider ? parseInt(targetCfSlider.value, 10) : DEFAULT_LCOE_TARGET_CF;
        const targetCf = (Number.isFinite(val) ? val : DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = computeLcoeForAllLocations(targetCf);
        await showLatitudeDemandSupplyChart(populationData, lcoeResults);
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
        'battery-capacity': 1,
        'battery-shadow': 2,
        'cheap-populous': 3,
        'cheap-access': 4,
        'better-uptime': 5,
        'backup-cost': 6,
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

    const mode = currentPotentialDisplayMode;
    if (updateLabel) {
        const constraint = level === 'level2' ? 'Policy constraints' : 'Technical constraints';
        const modeSub = mode === 'per_capita'
            ? 'Annual potential per person (MWh/yr)'
            : "Multiple of today's demand";
        updateVisualLabel({
            title: 'Solar Potential',
            subtitle: `${constraint} • ${modeSub}`
        });
    }

    if (!updateMap) return;

    if (!potentialData || potentialData.length === 0) {
        await ensurePotentialData();
    }
    // "× Demand" needs electricity demand; "Per capita" needs population.
    let populationMap = null;
    if (mode === 'per_capita') {
        await ensurePopulationData();
        populationMap = ensurePotentialPopulationMap();
    } else if (!electricityDemandMap || electricityDemandMap.size === 0) {
        await ensureElectricityData();
    }

    const latBounds = potentialLatBounds[level] || ensurePotentialLatBounds(level) || null;
    transitionController.crossfade(() => {
        updatePotentialMap(potentialData, {
            level,
            displayMode: mode,
            demandMap: electricityDemandMap,
            populationMap,
            latBounds
        });
    });
}

function updatePotentialDisplayToggleUI(mode) {
    if (!potentialDisplayToggleButtons || potentialDisplayToggleButtons.length === 0) return;
    potentialDisplayToggleButtons.forEach(btn => {
        const isActive = btn.dataset.display === mode;
        if (isActive) {
            btn.classList.add('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.remove('text-gray-400');
        } else {
            btn.classList.remove('bg-gray-600', 'text-white', 'shadow-sm');
            btn.classList.add('text-gray-400');
        }
    });
}

async function applyVisualState(sectionId, renderVersion = sectionRenderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    const state = getVisualState(sectionId);
    if (!state) return;

    console.log('Applying visual state:', sectionId, state);

    // The back-up step (viewMode 'backup') also reads the global/local cost basis, so it
    // shows the same compact "Cost Assumptions" toggle as the LCOE steps.
    const isLcoeView = state.viewMode === 'lcoe' || state.viewMode === 'no-access' || state.viewMode === 'backup';
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

    // Configure the shared inline uptime slider: on the back-up step it reads as
    // "Target Solar + Battery Uptime" (diesel always fills the rest); elsewhere it is the
    // standard "Target Uptime" with the diesel-back-up checkbox visible.
    configureInlineSliderForSection(sectionId);

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

    // Render immediately and let the readiness black-hold cover the swap.
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;

    // Update label
    updateVisualLabel(state.label);

    // Update legend visibility
    updateLegend(state.legend);

    if (potentialToggle) {
        if (sectionId === 'potential-map') {
            currentPotentialDisplayMode = state.displayMode || 'multiple';
            updatePotentialDisplayToggleUI(currentPotentialDisplayMode);
            updateLegend('potential'); // re-render now that the display mode is known
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

    const keepCostPanel = state?.viewMode === 'lcoe' || state?.viewMode === 'no-access' || state?.viewMode === 'backup';
    if (sectionId !== 'lcoe-outlook' && !keepCostPanel) {
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

    // Hide dual globe container + latitude toggle when not in Step 4
    if (sectionId !== 'cheap-populous') {
        hideDualGlobes();
        if (latitudeViewToggle) latitudeViewToggle.classList.add('hidden');
        if (latitudeChartContainer) {
            latitudeChartContainer.classList.add('hidden');
            latitudeChartContainer.classList.remove('cp-chart-mode');
        }
        // Restore the full "Cost Assumptions" card for other LCOE sections (over the map).
        if (outlookPanel) outlookPanel.classList.remove('cp-chart-cost');
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
        if (batteryCapacityControls) batteryCapacityControls.classList.remove('hidden');
        // Default state: battery at 0, solar starting low (autoplay sweeps it up).
        batteryCapFrameIndex = 0;
        currentSolarState = 1;
        if (solarSlider) solarSlider.value = 1;
        if (solarValueDisplay) solarValueDisplay.textContent = 1;
        if (batteryScrubber) batteryScrubber.value = 0;
        if (batteryValueDisplay) batteryValueDisplay.textContent = 0;
        // The autoplay loop itself is started by runAnimation (battery-capacity-autoplay).
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

        // Default to the chart (Demand & Supply by Latitude) each time the section is
        // entered; expose the toggle so the LCOE map is still one click away.
        cheapPopulousView = 'chart';
        if (latitudeViewToggle) latitudeViewToggle.classList.remove('hidden');
        await applyCheapPopulousView();
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
            await showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, normalizedTargetCf, lcoeResults, { includeDieselBackup });
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
    // Section 8: Cheap least-cost (diesel/gas) back-up to 100% uptime
    else if (sectionId === 'backup-cost') {
        await Promise.all([ensurePopulationData(), ensureGasData()]);
        // If the cost basis was left on "local" by an earlier step, make sure the local
        // CAPEX/WACC tables are present before the back-up LCOE is computed below.
        if (capexMode === 'local' || waccMode === 'local') {
            await Promise.all([ensureLocalCapexData(), ensureWaccData()]);
        }
        if (isStale()) return;

        if (inlineTargetCfContainer) inlineTargetCfContainer.classList.remove('hidden');
        const sbDefault = getVisualState('backup-cost')?.sbTarget ?? BACKUP_DEFAULT_SB_TARGET;
        if (targetCfSlider) {
            targetCfSlider.value = sbDefault;
            if (targetCfDisplay) targetCfDisplay.textContent = sbDefault;
        }

        showChart = true;
        const sbTarget = (targetCfSlider ? parseInt(targetCfSlider.value, 10) : sbDefault) / 100;
        await showBackupCostChart(getBackupResults(sbTarget), populationData, sbTarget);
        if (isStale()) {
            hideChart();
            return;
        }
    }
    // Section 9: Planned Capacity
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
    [legendCapacity, legendLcoe, legendPopulation, legendAccess, legendNoAccess, legendUptime, legendWeekly, legendPotential].forEach(el => {
        if (el) el.classList.add('hidden');
    });

    const legendMap = {
        'capacity': legendCapacity,
        'lcoe': legendLcoe,
        'population': legendPopulation,
        'access': legendAccess,
        'no-access-pop': legendNoAccess,
        'uptime': legendUptime,
        'weekly': legendWeekly,
        'potential': legendPotential
    };

    const targetLegend = legendMap[legendType];
    if (targetLegend) {
        targetLegend.classList.remove('hidden');
    }

    if (legendType === 'potential' && legendPotentialBuckets) {
        // Section 1 offers "× Demand" and "Per capita" — both use discrete colour buckets.
        const isPerCapita = currentPotentialDisplayMode === 'per_capita';
        if (legendPotentialTitle) {
            legendPotentialTitle.textContent = isPerCapita
                ? 'Solar Potential per Capita (MWh/person/yr)'
                : 'Solar Potential / Demand (×)';
        }
        const buckets = isPerCapita ? POTENTIAL_PER_CAPITA_BUCKETS : POTENTIAL_MULTIPLE_BUCKETS;
        const noData = `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:#6b7280\"></span><span>No data</span></div>`;
        const items = buckets.map(bucket => (
            `<div class=\"flex items-center gap-2\"><span class=\"w-3 h-3 rounded-sm\" style=\"background:${bucket.color}\"></span><span>${bucket.label}</span></div>`
        ));
        legendPotentialBuckets.innerHTML = `${items.join('')}${noData}`;
    }

    if (legendType === 'lcoe') {
        if (legendLcoeMin) legendLcoeMin.textContent = '$0';
        if (legendLcoeMid) legendLcoeMid.textContent = '$100';
        if (legendLcoeMax) legendLcoeMax.textContent = '$200';
        // Reset the title in case the back-up step left it as "Back-up cost ($/MWh)".
        const lcoeTitle = legendLcoe ? legendLcoe.querySelector('div') : null;
        if (lcoeTitle) lcoeTitle.textContent = 'LCOE ($/MWh)';

        // Note the target capacity factor the solar+battery LCOE is sized for.
        // Only the planned-capacity step exposes a CF target slider here, so scope
        // the note to it and track the live slider value when it's visible.
        if (legendLcoeNote) {
            const state = getVisualState(currentSection);
            if (currentSection === 'planned-capacity' && state && Number.isFinite(state.targetCf)) {
                const liveCf = (targetCfSlider && targetCfContainer && !targetCfContainer.classList.contains('hidden'))
                    ? parseInt(targetCfSlider.value, 10)
                    : NaN;
                const cf = Number.isFinite(liveCf) ? liveCf : state.targetCf;
                legendLcoeNote.textContent = `Target: ${cf}% capacity factor`;
                legendLcoeNote.classList.remove('hidden');
            } else {
                legendLcoeNote.classList.add('hidden');
            }
        }
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
        const populationMap = displayMode === 'per_capita' ? ensurePotentialPopulationMap() : null;
        updatePotentialMap(potentialData, { level, displayMode, demandMap: electricityDemandMap, populationMap, latBounds });

    } else if (viewMode === 'lcoe') {
        const targetCf = (state.targetCf || DEFAULT_LCOE_TARGET_CF) / 100;
        const lcoeResults = getRenderLcoeResults(targetCf, {}, sectionId, renderVersion);
        // Null means the worker is still computing: keep the overlay black (and show
        // the loader) and let the worker's onmessage re-render once results land.
        if (!lcoeResults) return;
        const colorInfo = buildLcoeColorInfo(lcoeResults);
        lastLcoeResults = lcoeResults;
        lastLcoeColorInfo = colorInfo;
        let options = { colorInfo };
        if (state.overlayPlants === 'announced') {
            options.fossilPlants = fossilPlants;
            options.fossilCapacityMap = fossilCapacityMap;
        }

        updateLcoeMap(lcoeResults, options);

    } else if (viewMode === 'backup') {
        renderBackupMap(getBackupSbTarget());

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

    // The incoming section's map is now fully drawn — release the black hold so it
    // fades in cleanly. (Animated/weekly sections mark readiness from their own
    // draw loops; the LCOE-waiting case returns above without reaching here.)
    markIncomingReady(sectionId, renderVersion);
}

// ========== BACK-UP COST STEP (section-8) ==========
// The map always shows the FULL LCOE of a 100%-uptime system: solar+battery sized to a
// user-chosen "target solar + battery uptime" (sbTarget), with a diesel genset filling the
// remaining hours up to 100%. The slider drives sbTarget; the chart below shows how the
// diesel back-up cost ($/MWh) is distributed across the world population (capex vs fuel).

// Read the current target solar+battery uptime (fraction) from the inline slider.
function getBackupSbTarget() {
    const v = targetCfSlider ? parseInt(targetCfSlider.value, 10) : BACKUP_DEFAULT_SB_TARGET;
    return (Number.isFinite(v) ? v : BACKUP_DEFAULT_SB_TARGET) / 100;
}

// Memoised per-location compute for the back-up step (keyed by sbTarget + cost outlook).
function getBackupResults(sbTarget) {
    // capex/wacc mode are part of the key: the global/local cost basis changes the result.
    const key = `${sbTarget}|${lcoeOutlookMultipliers.solar}|${lcoeOutlookMultipliers.battery}|${capexMode}|${waccMode}`;
    if (backupResultsCache.key === key && backupResultsCache.results) {
        return backupResultsCache.results;
    }
    const results = computeBackupLcoeForAllLocations(sbTarget);
    backupResultsCache = { key, results };
    return results;
}

// Per location, ASSUME solar+battery delivers exactly the slider's uptime (sbTarget) in
// every region, then price the least-cost gas/diesel back-up that covers the remaining
// (1 - sbTarget) up to 100%. The back-up share is therefore the same everywhere; the cost
// varies only by local fuel price, gas availability and cost of capital — so every region
// gets a back-up cost (no NA on the map). We still check whether solar+battery could really
// hit the target: if so we attach the cheapest such config's specs for the hover, otherwise
// the hover just says no details are available.
// NOTE: reuses the diesel/gas back-up cost formula in backupAnnualCost() (see
// [[lcoe-formula-duplicated]]); keep the constants in sync.
function computeBackupLcoeForAllLocations(sbTarget) {
    const results = [];
    const { solarCapex, batteryCapex, solarOpexPct, batteryOpexPct, solarLife, batteryLife, wacc } = lcoeParams;
    const globalSolarCapex = solarCapex * (lcoeOutlookMultipliers.solar || 1);
    const globalBatteryCapex = batteryCapex * (lcoeOutlookMultipliers.battery || 1);
    const HOURS = 8760;
    const firmMwh = HOURS; // 1 MW firm load at 100% uptime
    const backupShareCf = Math.max(0, 1 - sbTarget); // forced: the final slice every region must firm

    locationIndex.forEach((rows, locationId) => {
        if (!rows.length) return;
        const base = rows[0]; // location metadata (id, lat, lon) — shared across its configs
        const localCapex = getLocalCapex(locationId);
        const localWacc = getLocalWacc(locationId);
        const effSolarCapex = localCapex?.solar ?? globalSolarCapex;
        const effBatteryCapex = localCapex?.battery ?? globalBatteryCapex;
        const effWacc = localWacc ?? wacc;
        const ilr = Number.isFinite(lcoeParams.ilr) && lcoeParams.ilr > 0 ? lcoeParams.ilr : 1;
        const solarCrf = crf(effWacc, solarLife);
        const batteryCrf = crf(effWacc, batteryLife);
        const solarOpexEscalMult = levelizedGrowthMultiplier(lcoeParams.solarOpexEscalationPct || 0, effWacc, solarLife);
        const batteryOpexEscalMult = levelizedGrowthMultiplier(lcoeParams.batteryOpexEscalationPct || 0, effWacc, batteryLife);

        // Back-up cost for the forced (1 - sbTarget) slice — identical share in every region.
        const backup = backupAnnualCost(base.location_id, backupShareCf, effWacc);
        const backupCapexPerMwh = backup.capexAnnual / firmMwh;
        const backupOpexPerMwh = backup.fuelAnnual / firmMwh;
        const backupTotalPerMwh = backupCapexPerMwh + backupOpexPerMwh;

        // Feasibility (hover specs only): cheapest real solar+battery config that actually
        // reaches >= sbTarget. If none does, the region has no specs to show.
        let reachConfig = null;
        let minSbCost = Infinity;
        rows.forEach(row => {
            if (row.solar_gw > 10 || row.annual_cf < sbTarget) return;
            const solarCapexTotal = row.solar_gw * 1000 * effSolarCapex / ilr;
            const batteryCapexTotal = row.batt_gwh * 1000 * effBatteryCapex;
            const sbAnnualCost = solarCapexTotal * solarCrf + solarCapexTotal * solarOpexPct * solarOpexEscalMult
                + batteryCapexTotal * batteryCrf + batteryCapexTotal * batteryOpexPct * batteryOpexEscalMult;
            if (sbAnnualCost < minSbCost) { minSbCost = sbAnnualCost; reachConfig = row; }
        });

        const result = {
            location_id: base.location_id,
            latitude: base.latitude,
            longitude: base.longitude,
            meetsTarget: true,            // back-up cost is defined everywhere — colour all cells
            sbReachable: !!reachConfig,   // could solar+battery really hit the target here?
            firm_cf: 1,
            solar_share_cf: sbTarget,     // assumed, not derived from a config
            backup_share_cf: backupShareCf,
            diesel_share_cf: backupShareCf,
            backup_fuel: backup.fuel,
            includeDieselBackup: true,
            backup_capex_per_mwh: backupCapexPerMwh,
            backup_opex_per_mwh: backupOpexPerMwh,
            backup_total_per_mwh: backupTotalPerMwh,
            backup_lcoe_adder: backupTotalPerMwh,
            diesel_lcoe_adder: backupTotalPerMwh
        };
        if (reachConfig) {
            result.solar_gw = reachConfig.solar_gw;
            result.batt_gwh = reachConfig.batt_gwh;
            result.reach_cf = reachConfig.annual_cf;
        }
        results.push(result);
    });
    return results;
}

// Build the colour scale for the back-up-only heatmap. Colours by backup_total_per_mwh
// (the gas/diesel back-up cost spread over all firm energy), with an adaptive max so the
// scale keeps good contrast as the slider moves the back-up share up and down. The domain
// stop proportions mirror the LCOE legend gradient (0/15/45/65/82.5/100%) so the legend
// bar stays accurate.
function buildBackupColorInfo(results) {
    const valid = results.filter(r => r.meetsTarget && Number.isFinite(r.backup_total_per_mwh));
    // Population-weight the scale so it tracks what most people experience (matching the
    // chart and the legend framing) rather than being dragged high by sparse, weak-solar
    // regions where back-up carries a large share. Falls back to an unweighted percentile
    // when population data isn't loaded yet.
    const popById = new Map();
    (populationData || []).forEach(row => {
        const pop = Number(row.population_2020 || 0);
        if (pop > 0) popById.set(Number(row.location_id), pop);
    });
    let max = 40;
    if (valid.length) {
        const sorted = valid
            .map(r => ({ cost: r.backup_total_per_mwh, pop: popById.get(Number(r.location_id)) || 0 }))
            .sort((a, b) => a.cost - b.cost);
        // Population-weighted percentile across all covered regions, so the scale tracks the
        // back-up cost most people would actually pay.
        const reachPop = sorted.reduce((s, x) => s + x.pop, 0);
        if (reachPop > 0) {
            const cutoff = reachPop * 0.9; // 90% of people at or below this cost
            let acc = 0, p90 = sorted[sorted.length - 1].cost;
            for (const s of sorted) { acc += s.pop; if (acc >= cutoff) { p90 = s.cost; break; } }
            max = Math.max(20, Math.ceil(p90 / 10) * 10);
        } else {
            const p85 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.85))].cost;
            max = Math.max(20, Math.ceil(p85 / 10) * 10);
        }
    }
    const domain = [0, 0.15 * max, 0.45 * max, 0.65 * max, 0.825 * max, max];
    return { type: 'lcoe', metric: 'backup_total_per_mwh', valueLabel: 'Back-up cost', domain, max };
}

// Colour the map by the cost of the firming back-up only (not the solar + battery), i.e.
// what it costs to lift a sbTarget% solar+battery system to 100% uptime.
function renderBackupMap(sbTarget) {
    const results = getBackupResults(sbTarget);
    const colorInfo = buildBackupColorInfo(results);
    lastLcoeResults = results;
    lastLcoeColorInfo = colorInfo;
    updateLcoeMap(results, { colorInfo });
    updateBackupLegend(sbTarget, colorInfo);
    updateVisualLabel({
        title: 'Cost of the back-up only',
        subtitle: `Gas/diesel back-up to lift a solar + battery system from ${Math.round(sbTarget * 100)}% to 100% uptime`
    });
}

// The back-up step reuses the cost legend element but relabels it for back-up-only cost
// and explains, in the note, that the cost buys 100% uptime from a sbTarget% S+B system.
function updateBackupLegend(sbTarget, colorInfo) {
    updateLegend('lcoe'); // show the cost gradient, hide the others
    const pct = Math.round(sbTarget * 100);
    const restPct = Math.max(0, 100 - pct);
    const max = colorInfo?.max || 40;
    const lcoeTitle = legendLcoe ? legendLcoe.querySelector('div') : null;
    if (lcoeTitle) lcoeTitle.textContent = 'Back-up cost ($/MWh)';
    if (legendLcoeMin) legendLcoeMin.textContent = '$0';
    if (legendLcoeMid) legendLcoeMid.textContent = `$${Math.round(max / 2)}`;
    if (legendLcoeMax) legendLcoeMax.textContent = `$${Math.round(max)}+`;
    if (legendLcoeNote) {
        legendLcoeNote.innerHTML = `Gas/diesel back-up for the final ${restPct}%`
            + ` <span class="text-gray-500">&mdash; assumes solar + battery reaches ${pct}% everywhere.</span>`;
        legendLcoeNote.classList.remove('hidden');
    }
}

// Re-label the shared inline uptime slider depending on the active section.
function configureInlineSliderForSection(sectionId) {
    const isBackup = sectionId === 'backup-cost';
    if (targetCfLabel) targetCfLabel.textContent = isBackup ? 'Target Solar + Battery Uptime' : 'Target Uptime';
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
    if (batteryCapAutoplayTimer) {
        clearTimeout(batteryCapAutoplayTimer);
        batteryCapAutoplayTimer = null;
    }
    batteryCapPlaying = false;
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

    if (type === 'battery-capacity-autoplay') {
        // Section 2: sweep solar then battery; scrubbable + Play/Pause.
        batteryCapFrameIndex = 0;
        startBatteryCapAutoplay(sectionId, state, renderVersion);
    } else if (type === 'battery-loop' && loop) {
        // Looping animation through discrete steps
        runLoopingAnimation(sectionId, state, steps || [0, 8, 16, 24], duration, renderVersion);
    } else if (type === 'battery-slider') {
        // One-shot animation from->to
        runOneShotAnimation(sectionId, state, from, to, duration, easing, renderVersion);
    }
}

// ========== SECTION 2: BATTERY-CAPACITY AUTOPLAY ==========
// Frames sweep solar 1->10 at battery 0 (the solar-only ceiling), then battery 0->36 at
// max solar (storage filling in). Either slider can be grabbed to scrub (pauses autoplay).
function getBatteryCapFrames() {
    if (batteryCapFramesCache) return batteryCapFramesCache;
    const frames = [];
    for (let s = 1; s <= 10; s += 1) frames.push([s, 0]);
    for (let b = 2; b <= 36; b += 2) frames.push([10, b]);
    batteryCapFramesCache = frames;
    return frames;
}

function nearestBatteryCapFrame(solar, battery) {
    const frames = getBatteryCapFrames();
    let best = 0;
    let bestDist = Infinity;
    frames.forEach(([s, b], i) => {
        const dist = Math.abs(s - solar) + Math.abs(b - battery);
        if (dist < bestDist) { bestDist = dist; best = i; }
    });
    return best;
}

function updateBatteryPlayBtn() {
    if (!batteryPlayBtn) return;
    const label = batteryPlayBtn.querySelector('#battery-play-label');
    const icon = batteryPlayBtn.querySelector('.material-symbols-outlined');
    if (label) label.textContent = batteryCapPlaying ? 'Pause' : 'Play';
    if (icon) icon.textContent = batteryCapPlaying ? 'pause' : 'play_arrow';
}

function applyBatteryCapFrame(solar, battery, state, sectionId, renderVersion) {
    currentSolarState = solar;
    if (solarSlider) solarSlider.value = solar;
    if (solarValueDisplay) solarValueDisplay.textContent = solar;
    if (batteryScrubber) batteryScrubber.value = battery;
    if (batteryValueDisplay) batteryValueDisplay.textContent = battery;
    const cfData = getSummaryForConfig(solar, battery);
    updateMap(cfData, solar, battery, { ...(state?.mapOptions || {}), preFiltered: true });
    markIncomingReady(sectionId, renderVersion);
}

function startBatteryCapAutoplay(sectionId = 'battery-capacity', state = getVisualState('battery-capacity'), renderVersion = sectionRenderVersion) {
    stopBatteryCapAutoplay();
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    batteryCapPlaying = true;
    updateBatteryPlayBtn();
    const frames = getBatteryCapFrames();

    const tick = () => {
        if (!isSectionRenderCurrent(sectionId, renderVersion)) {
            stopBatteryCapAutoplay();
            return;
        }
        const [s, b] = frames[batteryCapFrameIndex % frames.length];
        applyBatteryCapFrame(s, b, state, sectionId, renderVersion);
        batteryCapFrameIndex = (batteryCapFrameIndex + 1) % frames.length;
        batteryCapAutoplayTimer = setTimeout(tick, BATTERY_CAP_STEP_MS);
    };
    tick();
}

function stopBatteryCapAutoplay() {
    if (batteryCapAutoplayTimer) {
        clearTimeout(batteryCapAutoplayTimer);
        batteryCapAutoplayTimer = null;
    }
    batteryCapPlaying = false;
    updateBatteryPlayBtn();
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
        markIncomingReady(sectionId, renderVersion);

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
        markIncomingReady(sectionId, renderVersion);

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
    // rAF-throttle, but never trust a pending frame older than ~200ms: if the browser
    // dropped it (tab restore, throttling), re-arm instead of wedging the pipeline.
    const now = performance.now();
    if (scrollOpacityRaf !== null && now - scrollRafRequestedTs < 200) return;
    scrollRafRequestedTs = now;
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
            element: bucket,
            sectionEl: section
        };
    });
    invalidateScrollBucketCache();
    observeScrollBucketLayout();
}

function computeScrollMetrics() {
    if (!transitionController.overlayA) return null;

    if (!scrollSections.length) {
        buildScrollSections();
    }
    if (!scrollSections.length) return null;

    const scrollY = window.scrollY || window.pageYOffset || 0;
    const viewportCenter = scrollY + (window.innerHeight / 2);

    // Document-space tops/bottoms are scroll-invariant (rect.top ≡ docTop −
    // scrollY), so with layout unchanged the cached values are identical to
    // fresh getBoundingClientRect reads — without forcing layout every frame.
    if (!scrollBucketCache || scrollBucketCache.length !== scrollSections.length) {
        scrollBucketCache = scrollSections.map(entry => {
            const rect = entry.element.getBoundingClientRect();
            return {
                top: rect.top + scrollY,
                bottom: rect.bottom + scrollY
            };
        });
    }
    const buckets = scrollBucketCache;

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
            activeIdx,
            viewportCenter,
            gapStart: null,
            gapEnd: null
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
            activeIdx: -1,
            viewportCenter,
            gapStart: null,
            gapEnd: null
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
            activeIdx: -1,
            viewportCenter,
            gapStart,
            gapEnd
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
        activeIdx: -1,
        viewportCenter,
        gapStart,
        gapEnd
    };
}

// Mark the section element (amber side bar) that matches the committed section.
function updateActiveSectionClass(sectionId) {
    if (!scrollSections.length) buildScrollSections();
    scrollSections.forEach(entry => {
        entry.sectionEl?.classList.toggle('active', entry.sectionId === sectionId);
    });
}

// Resolve which section the scroll position points at: the section whose text bucket
// contains the viewport centre, or — in the gap between two buckets — the previous
// section until the gap midpoint and the next one after it. The midpoint sits inside
// the fully-black hold zone of the overlay fade, so the map swap it triggers is hidden.
function resolveScrollSectionId(metrics) {
    if (!metrics) return null;
    const { activeIdx, prevIdx, nextIdx, viewportCenter, gapStart, gapEnd } = metrics;
    if (activeIdx !== -1) return scrollSections[activeIdx]?.sectionId || null;
    if (prevIdx === -1 && nextIdx === -1) return null;
    if (prevIdx === -1) return scrollSections[nextIdx]?.sectionId || null;
    if (nextIdx === -1) return scrollSections[prevIdx]?.sectionId || null;

    const prevId = scrollSections[prevIdx]?.sectionId || null;
    const nextId = scrollSections[nextIdx]?.sectionId || null;
    const mid = ((gapStart ?? viewportCenter) + (gapEnd ?? viewportCenter)) / 2;
    // Hysteresis: once a side is current, only flip after clearly crossing the midpoint,
    // so trackpad jitter right at the boundary can't thrash the map back and forth.
    if (currentSection === prevId) {
        return viewportCenter > mid + GAP_SWITCH_HYSTERESIS_PX ? nextId : prevId;
    }
    if (currentSection === nextId) {
        return viewportCenter < mid - GAP_SWITCH_HYSTERESIS_PX ? prevId : nextId;
    }
    return viewportCenter < mid ? prevId : nextId;
}

// Commit scroll-resolved section changes, throttled so a fast fling through several
// sections doesn't queue a heavy render for each one it passes: the first switch is
// immediate, follow-ups within the window collapse into one trailing commit that always
// lands on the latest resolved section — never a stale intermediate.
function syncSectionToScroll(metrics) {
    const targetId = resolveScrollSectionId(metrics);
    if (!targetId || targetId === currentSection) {
        // Settled back on the current section: drop any queued switch.
        pendingScrollSectionId = null;
        if (sectionCommitTimer) {
            clearTimeout(sectionCommitTimer);
            sectionCommitTimer = null;
        }
        return;
    }
    if (targetId !== pendingScrollSectionId) {
        pendingScrollSectionId = targetId;
        if (sectionCommitTimer) {
            clearTimeout(sectionCommitTimer);
            sectionCommitTimer = null;
        }
    }
    // Re-check on every scroll frame rather than trusting the timer alone, so the
    // pending switch can never wedge if a queued callback gets dropped.
    const waitMs = SECTION_COMMIT_MIN_INTERVAL_MS - (performance.now() - lastSectionCommitTs);
    if (waitMs <= 0) {
        if (sectionCommitTimer) {
            clearTimeout(sectionCommitTimer);
            sectionCommitTimer = null;
        }
        commitPendingScrollSection();
    } else if (!sectionCommitTimer) {
        sectionCommitTimer = setTimeout(commitPendingScrollSection, waitMs);
    }
}

function commitPendingScrollSection() {
    sectionCommitTimer = null;
    const sectionId = pendingScrollSectionId;
    pendingScrollSectionId = null;
    if (!sectionId || sectionId === currentSection) return;
    lastSectionCommitTs = performance.now();
    onSectionEnter(sectionId);
}

function updateScrollOpacity() {
    if (!transitionController.overlayA) return;

    const metrics = computeScrollMetrics();
    if (!metrics) return;

    lastScrollMetrics = metrics;
    currentScrollOpacity = metrics.opacity;
    applyOverlay();
    syncSectionToScroll(metrics);
}

// ----- Overlay opacity: max of the scroll-driven fade and the readiness hold -----
function applyOverlay() {
    if (!transitionController.overlayA) return;
    const eff = Math.max(currentScrollOpacity, holdValue);
    const rounded = Math.round(eff * 1000) / 1000;
    if (lastOverlayOpacity !== rounded) {
        transitionController.overlayA.style.opacity = rounded.toString();
        lastOverlayOpacity = rounded;
    }
    if (rounded < 0.5) hideMapLoader();
}

// Ramp holdValue toward holdTarget (0 or 1) on its own rAF, independent of scroll,
// so a reveal happens even when the user has stopped scrolling.
function stepHold(ts) {
    holdRaf = null;
    const dt = holdLastTs ? Math.min(48, ts - holdLastTs) : 16;
    holdLastTs = ts;
    const goingUp = holdTarget > holdValue;
    const dur = goingUp ? HOLD_FADE_IN_MS : HOLD_FADE_OUT_MS;
    const delta = dt / dur;
    holdValue = goingUp
        ? Math.min(holdTarget, holdValue + delta)
        : Math.max(holdTarget, holdValue - delta);
    applyOverlay();
    if (holdValue !== holdTarget) {
        holdRaf = requestAnimationFrame(stepHold);
    } else {
        holdLastTs = 0;
    }
}

function setHoldTarget(target) {
    const clamped = target ? 1 : 0;
    if (clamped === holdTarget && holdValue === holdTarget) return;
    holdTarget = clamped;
    if (!holdRaf) {
        holdLastTs = 0;
        holdRaf = requestAnimationFrame(stepHold);
    }
}

// Begin holding the overlay black for a freshly-entered section.
function beginSectionHold(sectionId) {
    mapReady = false;
    incomingReadySection = sectionId;
    setHoldTarget(1);
    armMapLoader();
    if (mapReadySafetyTimer) clearTimeout(mapReadySafetyTimer);
    mapReadySafetyTimer = setTimeout(() => {
        mapReadySafetyTimer = null;
        // Failsafe: never strand the user on a black screen.
        mapReady = true;
        hideMapLoader();
        setHoldTarget(0);
    }, MAP_READY_SAFETY_MS);
}

// Release the black hold once the incoming section's map is fully drawn.
function markIncomingReady(sectionId, renderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    if (mapReady && incomingReadySection === sectionId) return;
    mapReady = true;
    incomingReadySection = sectionId;
    if (mapReadySafetyTimer) {
        clearTimeout(mapReadySafetyTimer);
        mapReadySafetyTimer = null;
    }
    hideMapLoader();
    setHoldTarget(0);
}

function getMapLoaderEl() {
    if (!mapLoaderEl) mapLoaderEl = document.getElementById('map-loader');
    return mapLoaderEl;
}

// Arm the loader to appear only if the black hold outlasts MAP_LOADER_DELAY_MS.
function armMapLoader() {
    if (mapLoaderTimer) clearTimeout(mapLoaderTimer);
    mapLoaderTimer = setTimeout(() => {
        mapLoaderTimer = null;
        if (!mapReady && holdValue > 0.5) {
            const el = getMapLoaderEl();
            if (el) el.classList.add('visible');
        }
    }, MAP_LOADER_DELAY_MS);
}

function hideMapLoader() {
    if (mapLoaderTimer) {
        clearTimeout(mapLoaderTimer);
        mapLoaderTimer = null;
    }
    const el = getMapLoaderEl();
    if (el) el.classList.remove('visible');
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

function buildScrollyWorkerCacheKey(targetCf, useDiesel = false) {
    return JSON.stringify({
        targetCf,
        useDiesel,
        mode: { capexMode, waccMode, year: lcoeOutlookYear },
        multipliers: lcoeOutlookMultipliers,
        params: {
            solarCapex: lcoeParams.solarCapex,
            batteryCapex: lcoeParams.batteryCapex,
            ilr: lcoeParams.ilr,
            solarOpexPct: lcoeParams.solarOpexPct,
            batteryOpexPct: lcoeParams.batteryOpexPct,
            solarDegradationPct: lcoeParams.solarDegradationPct,
            solarOpexEscalationPct: lcoeParams.solarOpexEscalationPct,
            batteryOpexEscalationPct: lcoeParams.batteryOpexEscalationPct,
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

function scheduleScrollyLcoeWorkerCompute(cacheKey, targetCf, rerenderCtx = null) {
    if (!FEATURE_WORKER_LCOE) return;
    // Always track the latest re-render context so a still-in-flight compute repaints
    // whichever section is now waiting on it.
    if (rerenderCtx) lcoeWorkerRerenderCtx.set(cacheKey, rerenderCtx);
    if (lcoeWorkerInFlight.has(cacheKey)) return;
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
            setLcoeCache(cacheKey, results);
            const ctx = lcoeWorkerRerenderCtx.get(cacheKey);
            if (ctx && isSectionRenderCurrent(ctx.sectionId, ctx.renderVersion)) {
                rerenderCurrentSection(ctx.sectionId, ctx.renderVersion);
            }
        } catch (err) {
            console.warn('Scrollytelling LCOE worker compute failed; using fallback.', err);
        } finally {
            lcoeWorkerInFlight.delete(cacheKey);
            lcoeWorkerRerenderCtx.delete(cacheKey);
        }
    })();
}

// Re-run a section's render (used when a worker LCOE result lands for the section the
// user is currently viewing). The cache is now warm, so renderVisualState draws and
// marks the section ready, releasing the black hold.
function rerenderCurrentSection(sectionId, renderVersion) {
    if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
    const state = getVisualState(sectionId);
    if (!state) return;
    transitionController.crossfade(() => {
        if (!isSectionRenderCurrent(sectionId, renderVersion)) return;
        renderVisualState(state, sectionId, renderVersion);
    });
}

// Bounded insertion-order cache for computed LCOE result sets (the outlook
// year-animation can otherwise mint dozens of large per-year entries).
const LCOE_CACHE_MAX = 40;
function setLcoeCache(cacheKey, results) {
    if (!lcoeWorkerCache.has(cacheKey) && lcoeWorkerCache.size >= LCOE_CACHE_MAX) {
        const oldest = lcoeWorkerCache.keys().next().value;
        if (oldest !== undefined) lcoeWorkerCache.delete(oldest);
    }
    lcoeWorkerCache.set(cacheKey, results);
}

// LCOE results the section renderer should draw. Returns cached results instantly,
// otherwise asks the worker and returns null (the caller keeps the overlay black and
// the worker re-renders on arrival). Falls back to a synchronous compute only when no
// worker is available, so the main thread never freezes on a cold LCOE section.
function getRenderLcoeResults(targetCf, options = {}, sectionId = currentSection, renderVersion = sectionRenderVersion) {
    const useDiesel = options.includeDieselBackup ?? includeDieselBackup;
    const cacheKey = buildScrollyWorkerCacheKey(targetCf, useDiesel);
    const cached = lcoeWorkerCache.get(cacheKey);
    if (cached?.length) return cached.map((row) => ({ ...row }));

    if (FEATURE_WORKER_LCOE && !useDiesel && getScrollyLcoeWorker()) {
        scheduleScrollyLcoeWorkerCompute(cacheKey, targetCf, { sectionId, renderVersion });
        return null; // wait for the worker; the black hold + loader cover the wait
    }
    return computeLcoeForAllLocations(targetCf, options);
}

// Synchronous main-thread LCOE engine, now memoised by config so every caller
// (section renders, charts, data-link handlers) gets instant results on repeat.
// The worker path (getRenderLcoeResults / idle warm) populates the same cache.
function computeLcoeForAllLocations(targetCf, options = {}) {
    const useDiesel = options.includeDieselBackup ?? includeDieselBackup;
    const cacheKey = buildScrollyWorkerCacheKey(targetCf, useDiesel);
    const cached = lcoeWorkerCache.get(cacheKey);
    if (cached?.length) {
        console.debug('[perf] scrolly-lcoe-compute', { targetCf, useDiesel, source: 'cache-hit', rows: cached.length });
        return cached.map((row) => ({ ...row }));
    }

    const perf = startPerf('scrolly-lcoe-compute', { targetCf, useDiesel });
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
            if (row.solar_gw > 10) return;
            if (useDiesel) {
                const lcoe = computeLcoe(row, effectiveSolarCapex, effectiveBatteryCapex, effectiveWacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct, { targetCf, includeDieselBackup: true });
                if (lcoe < minLcoe) {
                    minLcoe = lcoe;
                    const solarCf = row.annual_cf;
                    const backupShareCf = Math.max(0, targetCf - solarCf);
                    const firmCf = Math.max(solarCf, targetCf);
                    // Isolate the back-up's own contribution to LCOE ($/MWh) so the "back-up cost
                    // only" map can colour by it. Uses the least-cost fuel (diesel flat vs regional gas).
                    const annualMwh = firmCf * 8760;
                    const backup = backupAnnualCost(row.location_id, backupShareCf, effectiveWacc);
                    const backupLcoeAdder = annualMwh > 0 ? backup.totalAnnual / annualMwh : Infinity;
                    bestConfig = {
                        ...row,
                        lcoe,
                        meetsTarget: true,
                        firm_cf: firmCf,
                        solar_share_cf: solarCf,
                        diesel_share_cf: backupShareCf,
                        backup_share_cf: backupShareCf,
                        backup_fuel: backup.fuel,
                        backup_lcoe_adder: backupLcoeAdder,
                        diesel_lcoe_adder: backupLcoeAdder,
                        includeDieselBackup: true
                    };
                }
            } else if (row.annual_cf >= targetCf) {
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
    setLcoeCache(cacheKey, results.map((row) => ({ ...row })));
    return results;
}

function computeLcoe(row, solarCapex, batteryCapex, wacc, solarLife, batteryLife, solarOpexPct, batteryOpexPct, dieselOptions = null) {
    const solarKw = row.solar_gw * 1000;
    const batteryKwh = row.batt_gwh * 1000;

    const ilr = Number.isFinite(lcoeParams.ilr) && lcoeParams.ilr > 0 ? lcoeParams.ilr : 1;
    const solarCapexTotal = solarKw * solarCapex / ilr;
    const batteryCapexTotal = batteryKwh * batteryCapex;

    const solarCrf = crf(wacc, solarLife);
    const batteryCrf = crf(wacc, batteryLife);
    const solarOpexEscalMult = levelizedGrowthMultiplier(lcoeParams.solarOpexEscalationPct || 0, wacc, solarLife);
    const batteryOpexEscalMult = levelizedGrowthMultiplier(lcoeParams.batteryOpexEscalationPct || 0, wacc, batteryLife);
    const annualSolarCost = solarCapexTotal * solarCrf + solarCapexTotal * solarOpexPct * solarOpexEscalMult;
    const annualBatteryCost = batteryCapexTotal * batteryCrf + batteryCapexTotal * batteryOpexPct * batteryOpexEscalMult;

    if (dieselOptions?.includeDieselBackup) {
        const targetCf = dieselOptions.targetCf;
        const solarCf = row.annual_cf;
        const backupShareCf = Math.max(0, targetCf - solarCf);
        const servedCf = Math.max(solarCf, targetCf);
        const annualMwh = servedCf * 8760;
        if (annualMwh <= 0) return Infinity;
        // Least-cost firm backup (diesel flat vs regional gas) for this location, per 1 MW.
        const backup = backupAnnualCost(row.location_id, backupShareCf, wacc);
        return (annualSolarCost + annualBatteryCost + backup.totalAnnual) / annualMwh;
    }

    const energyDegMult = levelizedGrowthMultiplier(-(lcoeParams.solarDegradationPct || 0), wacc, solarLife);
    const annualMwh = row.annual_cf * 8760 * energyDegMult;

    if (annualMwh <= 0) return Infinity;

    return (annualSolarCost + annualBatteryCost) / annualMwh;
}

function buildLcoeColorInfo(lcoeResults) {
    const validLcoe = lcoeResults.filter(r => r.meetsTarget && Number.isFinite(r.lcoe)).map(r => r.lcoe);
    if (validLcoe.length === 0) {
        return { type: 'lcoe', domain: [0, 30, 90, 130, 165, 200] };
    }

    return {
        type: 'lcoe',
        domain: [0, 30, 90, 130, 165, 200]
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
            timestamp: getWeeklyFrameTimestamp(0),
            locations: initialLocations
        });
    }

    // Use a timer to update map every 500ms (matching main tool)
    // OPTIMIZED: Only updates colors, not DOM structure
    weeklyAnimationInterval = setInterval(() => {
        // Skip ticks while the tab is hidden: the loop is modulo-cyclic, so
        // freezing the frame index is unobservable on return, and we avoid
        // recomputing every location's colors in a background tab.
        if (document.hidden) return;
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
 * Real UTC timestamp for a weekly frame (drives the day/night overlay).
 * Reads the shared sample data's timestamps (Arrow Vector or plain array).
 */
function getWeeklyFrameTimestamp(frameIndex) {
    const ts = weeklySampleData?.[0]?.timestamps;
    if (!ts) return undefined;
    const v = ts.get ? ts.get(frameIndex) : ts[frameIndex];
    return typeof v === 'bigint' ? Number(v) : v;
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
    updateSampleFrameColors(locations, getWeeklyFrameTimestamp(currentWeekFrame));
}

/**
 * LEGACY: Full render that recreates all DOM elements.
 * Kept for fallback or moveend handler.
 */
function renderWeeklyFrame() {
    if (!weeklySampleData || weeklySampleData.length === 0) return;

    const locations = computeWeeklyFrameColors(currentWeekFrame);

    updateMapWithSampleFrame({
        timestamp: getWeeklyFrameTimestamp(currentWeekFrame),
        locations: locations
    });
}
