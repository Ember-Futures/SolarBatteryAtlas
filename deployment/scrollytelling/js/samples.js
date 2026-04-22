
import { updateMapWithSampleFrame, setSampleLocationClickHandler } from './map.js';

let sampleWeekData = null;
let currentFrameIndex = 0;
let playbackTimer = null;
let currentSolar = null;
let currentBatt = null;
let selectedSeason = 'spring';
let selectedSampleLocation = null;
let sampleChart = null;
let hasLoadedSamples = false;
let chartJsLoaded = false;

// Cache for Arrow table wrappers (stores the columnar data, not materialized rows)
// Key format: "s{solarGw}_b{battGwh}" -> Arrow table wrapper from loadSampleColumnar()
const sampleTableCache = new Map();

// Cache for materialized season data (only seasons that have been accessed)
// Key format: "s{solarGw}_b{battGwh}_{season}" -> [{location data}, ...]
const seasonDataCache = new Map();

let cachedSummaryMap = null; // Cached coordinate map for enrichment

// Dynamic Chart.js loader for samples module
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
            console.log('Chart.js loaded dynamically (samples)');
            resolve();
        };
        script.onerror = () => reject(new Error('Failed to load Chart.js'));
        document.head.appendChild(script);
    });
}

function resetSampleChartState(message = 'Pick a location to view the breakdown.', clearSelection = true) {
    if (clearSelection) {
        selectedSampleLocation = null;
    }
    if (sampleChart) {
        sampleChart.destroy();
        sampleChart = null;
    }
    if (sampleChartCanvas) {
        sampleChartCanvas.classList.add('hidden');
    }
    if (sampleChartStatus) {
        sampleChartStatus.textContent = message;
    }
    if (clearSelection && sampleChartLocation) {
        sampleChartLocation.textContent = 'Select a location on the map.';
    }
}

function hideSampleChart() {
    resetSampleChartState();
    if (sampleChartOverlay) {
        sampleChartOverlay.classList.add('hidden');
    }
}

function toArray(field) {
    if (!field) return [];
    if (Array.isArray(field)) return field;
    if (typeof field.toArray === 'function') return field.toArray();
    if (ArrayBuffer.isView(field)) return Array.from(field);
    return Array.from(field);
}

// DOM Elements
const weekSelect = document.getElementById('sample-week-select');
const playButton = document.getElementById('sample-play');
const resetButton = document.getElementById('sample-reset');
const timeScrubber = document.getElementById('time-scrubber');
const scrubberTime = document.getElementById('scrubber-time');
const scrubberProgress = document.getElementById('scrubber-progress');
const sampleChartOverlay = document.getElementById('sample-chart-overlay');
const sampleChartLocation = document.getElementById('sample-chart-location');
const sampleChartStatus = document.getElementById('sample-chart-status');
const sampleChartCanvas = document.getElementById('sample-chart-canvas');
const sampleChartClose = document.getElementById('sample-chart-close');

export function initSampleDays() {
    // Event Listeners
    playButton.addEventListener('click', togglePlayback);
    resetButton.addEventListener('click', resetToStart);
    timeScrubber.addEventListener('input', handleScrubberChange);
    weekSelect.addEventListener('change', () => handleWeekChange({ preserveFrame: false }));
    sampleChartClose?.addEventListener('click', hideSampleChart);
    setSampleLocationClickHandler(handleSampleLocationSelect);
}

export async function loadSampleWeekData(solarGw, battGwh, summaryData) {
    currentSolar = solarGw;
    currentBatt = battGwh;
    const previousSeason = selectedSeason;
    const previousFrame = currentFrameIndex;
    const wasPlaying = Boolean(playbackTimer);
    if (wasPlaying) {
        stopPlayback();
    }

    const cacheKey = `s${solarGw}_b${battGwh}`;
    console.log(`Loading sample week data for Solar ${solarGw} MW, Battery ${battGwh} MWh`);

    const key = `sol${solarGw}batt${battGwh}`;
    if (!['sol1batt0', 'sol5batt8', 'sol10batt18', 'sol5batt4', 'sol20batt36'].includes(key) && solarGw > 10 && battGwh < 18) {
        sampleWeekData = null;
        weekSelect.innerHTML = '<option>Not available for this config (use Batt > 16 MWh or Solar ≤ 10 MW)</option>';
        weekSelect.disabled = true;
        resetSampleChartState('Select a standard config to see sample data', true);
        return;
    } else {
        weekSelect.disabled = false; // Re-enable if a valid config is selected
    }

    try {
        let tableWrapper;
        let seasons;

        // Check cache for Arrow table wrapper first
        if (sampleTableCache.has(cacheKey)) {
            console.log(`Using cached Arrow table for ${cacheKey}`);
            tableWrapper = sampleTableCache.get(cacheKey);
            seasons = tableWrapper.getSeasons();
        } else {
            // Load sample data using columnar loader (doesn't materialize all rows)
            console.log(`Downloading sample data for ${cacheKey}...`);
            const { loadSampleColumnar } = await import('./data.js');
            tableWrapper = await loadSampleColumnar(solarGw, battGwh);

            if (!tableWrapper || tableWrapper.numRows === 0) {
                console.warn('No sample data available');
                sampleWeekData = null;
                weekSelect.innerHTML = '<option>No data available</option>';
                hideSampleChart();
                return;
            }

            // Cache the Arrow table wrapper for future season switches
            sampleTableCache.set(cacheKey, tableWrapper);
            console.log(`Arrow table cached: ${tableWrapper.numRows} total rows`);

            // Get available seasons (fast columnar access, no row materialization)
            seasons = tableWrapper.getSeasons();
            console.log('Available seasons:', seasons);
        }

        // Build summary map once and cache it (for coordinate enrichment)
        if (!cachedSummaryMap && summaryData && summaryData.length > 0) {
            cachedSummaryMap = new Map();
            summaryData.forEach(row => {
                cachedSummaryMap.set(row.location_id, {
                    latitude: row.latitude,
                    longitude: row.longitude
                });
            });
        }

        // Populate week selector
        weekSelect.innerHTML = seasons
            .map(season => `<option value="${season}">${season.charAt(0).toUpperCase() + season.slice(1)}</option>`)
            .join('');

        // Choose desired season
        let desiredSeason = previousSeason;
        if (!desiredSeason || !seasons.includes(desiredSeason)) {
            desiredSeason = seasons.includes('spring') ? 'spring' : seasons[0];
        }
        selectedSeason = desiredSeason;
        if (weekSelect.value !== desiredSeason) {
            weekSelect.value = desiredSeason;
        }

        // LAZY LOADING: Only materialize the selected season's data
        const seasonKey = `${cacheKey}_${desiredSeason}`;
        if (!seasonDataCache.has(seasonKey)) {
            console.log(`Materializing season data for ${desiredSeason}...`);
            const seasonData = tableWrapper.getRowsForSeason(desiredSeason);

            // Add coordinates to each sample row using cached summary map
            if (cachedSummaryMap) {
                seasonData.forEach(row => {
                    const coords = cachedSummaryMap.get(row.location_id);
                    if (coords) {
                        row.latitude = coords.latitude;
                        row.longitude = coords.longitude;
                    }
                });
            }

            seasonDataCache.set(seasonKey, seasonData);
            console.log(`Season ${desiredSeason} cached: ${seasonData.length} locations`);
        }

        // Set current data to the selected season only
        sampleWeekData = seasonDataCache.get(seasonKey);
        console.log('Sample week data set:', sampleWeekData.length, 'locations for', desiredSeason);

        // Load selected week, preserving frame index if the season unchanged
        if (weekSelect.options.length > 0) {
            const shouldPreserve = hasLoadedSamples && previousSeason === desiredSeason;
            handleWeekChange({ preserveFrame: shouldPreserve });
        }

        if (selectedSampleLocation && sampleChartOverlay && !sampleChartOverlay.classList.contains('hidden')) {
            renderSampleChartForSelected(false);
        }

        startPlayback();
        hasLoadedSamples = true;
    } catch (err) {
        console.error('Failed to load sample week data:', err);
        const reason = err?.message?.includes('Sample file not found')
            ? 'No sample data for this configuration.'
            : 'Error loading data';
        weekSelect.innerHTML = `<option>${reason}</option>`;
        sampleWeekData = null;
        hideSampleChart();
    }
}

function handleWeekChange({ preserveFrame = false } = {}) {
    const season = weekSelect.value;
    if (!season) return;
    selectedSeason = season;

    const cacheKey = `s${currentSolar}_b${currentBatt}`;
    const seasonKey = `${cacheKey}_${season}`;

    // LAZY LOADING: Check if this season's data is already materialized
    if (!seasonDataCache.has(seasonKey)) {
        // Need to materialize this season from the Arrow table
        const tableWrapper = sampleTableCache.get(cacheKey);
        if (!tableWrapper) {
            console.warn('No Arrow table cached for', cacheKey);
            return;
        }

        console.log(`Lazy loading season data for ${season}...`);
        const seasonData = tableWrapper.getRowsForSeason(season);

        // Add coordinates to each sample row using cached summary map
        if (cachedSummaryMap) {
            seasonData.forEach(row => {
                const coords = cachedSummaryMap.get(row.location_id);
                if (coords) {
                    row.latitude = coords.latitude;
                    row.longitude = coords.longitude;
                }
            });
        }

        seasonDataCache.set(seasonKey, seasonData);
        console.log(`Season ${season} lazy loaded: ${seasonData.length} locations`);
    }

    // Update current data to the new season
    sampleWeekData = seasonDataCache.get(seasonKey);

    if (!sampleWeekData || sampleWeekData.length === 0) {
        console.warn('No data for season:', season);
        return;
    }

    // Find first location's data to get timestamps
    const seasonData = sampleWeekData[0];
    if (!seasonData || !seasonData.timestamps) {
        console.warn('No timestamps for season:', season);
        return;
    }

    console.log(`Selected season: ${season}, timestamps:`, seasonData.timestamps.length);

    // Update scrubber max based on actual data length
    const numFrames = Array.isArray(seasonData.timestamps)
        ? seasonData.timestamps.length
        : seasonData.timestamps.toArray?.().length || 168;
    timeScrubber.max = numFrames - 1;

    const defaultStart = Math.floor(numFrames / 3);
    const targetFrame = preserveFrame ? currentFrameIndex : defaultStart;
    currentFrameIndex = Math.max(0, Math.min(targetFrame, numFrames - 1));
    timeScrubber.value = currentFrameIndex;

    // Render first frame
    renderFrame(season, currentFrameIndex);

    if (sampleChartOverlay && !sampleChartOverlay.classList.contains('hidden') && selectedSampleLocation) {
        renderSampleChartForSelected(false);
    }
}

function handleScrubberChange() {
    if (!sampleWeekData || sampleWeekData.length === 0) return;

    const season = weekSelect.value;
    currentFrameIndex = parseInt(timeScrubber.value);
    renderFrame(season, currentFrameIndex);
}

function togglePlayback() {
    if (playbackTimer) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (playbackTimer) return;
    if (!sampleWeekData || sampleWeekData.length === 0) return;

    const season = weekSelect.value;
    const firstLoc = sampleWeekData[0];
    if (!firstLoc || !firstLoc.timestamps) return;

    playButton.textContent = 'Pause';

    // Get timestamp count once (all locations have same length)
    const timestamps = Array.isArray(firstLoc.timestamps)
        ? firstLoc.timestamps
        : firstLoc.timestamps.toArray?.() || [];
    const numFrames = timestamps.length;

    playbackTimer = setInterval(() => {
        const season = weekSelect.value;
        currentFrameIndex = (currentFrameIndex + 1) % numFrames;
        timeScrubber.value = currentFrameIndex;
        renderFrame(season, currentFrameIndex);
    }, 500); // 500ms per frame
}

function stopPlayback() {
    if (playbackTimer) {
        clearInterval(playbackTimer);
        playbackTimer = null;
    }
    playButton.textContent = 'Play';
}

function resetToStart() {
    stopPlayback();

    const season = weekSelect.value;
    if (!sampleWeekData) return;

    // sampleWeekData now only contains current season
    if (sampleWeekData.length === 0) return;

    currentFrameIndex = 0;
    timeScrubber.value = 0;
    renderFrame(season, 0);
}

function renderFrame(season, frameIndex) {
    console.log(`=== renderFrame(${season}, ${frameIndex}) ===`);

    if (!sampleWeekData) {
        console.warn('Early exit: no sampleWeekData');
        return;
    }
    if (!season) {
        console.warn('Early exit: no season');
        return;
    }

    // sampleWeekData now only contains current season, use first location for timestamps
    const seasonData = sampleWeekData[0];
    if (!seasonData || !seasonData.timestamps) {
        console.warn('Early exit: no seasonData or timestamps');
        return;
    }

    // Convert Arrow Vector to array if needed
    const timestamps = Array.isArray(seasonData.timestamps) ?
        seasonData.timestamps :
        Array.from(seasonData.timestamps);

    console.log('timestamps.length:', timestamps.length, 'frameIndex:', frameIndex);

    if (frameIndex >= timestamps.length) {
        console.warn('Early exit: frameIndex out of bounds');
        return;
    }

    const timestamp = timestamps[frameIndex];

    // Update UI
    const date = new Date(timestamp);
    scrubberTime.textContent = date.toUTCString().replace('GMT', 'UTC');
    scrubberProgress.textContent = `Hour ${frameIndex + 1} / ${timestamps.length}`;

    // sampleWeekData now only contains current season, use all locations
    const locationsForSeason = sampleWeekData;

    console.log(`Rendering frame ${frameIndex} for ${season}: ${locationsForSeason.length} locations`);

    const mappedLocations = locationsForSeason.map((loc, index) => {
        // Each location row has data for one season
        // Convert Arrow Vectors to arrays if needed
        const solarGenArray = loc.solar_gen && loc.solar_gen.toArray ? loc.solar_gen.toArray() : (loc.solar_gen || []);
        const battFlowArray = loc.battery_flow && loc.battery_flow.toArray ? loc.battery_flow.toArray() : (loc.battery_flow || []);

        // Get values for this frame
        // Note: battery_flow in parquet is likely net flow (positive = charge, negative = discharge)
        // or we might need to check if there are separate columns. 
        // Based on previous code, it seems we expect a single battery flow column.
        // Let's assume positive is charge, negative is discharge for now, or check data structure.
        // Actually, previous code used batt_charge and batt_discharge. Let's check the log again.
        // The log showed "battery_flow: r". So there is only one column "battery_flow".

        // Calculate local time index based on longitude
        // frameIndex is treated as UTC time
        // Data is assumed to be in Local Time (Index 0 = 00:00 Local)
        // Offset = Longitude / 15 (approx 1 hour per 15 degrees)
        const offset = Math.round(loc.longitude / 15);
        const localIndex = frameIndex + offset;

        // Handle out of bounds
        // If local time is outside our data range, we assume 0 (or could wrap if we had circular data)
        let solarGen = 0;
        let battFlow = 0;

        if (localIndex >= 0 && localIndex < solarGenArray.length) {
            solarGen = solarGenArray[localIndex] || 0;
            battFlow = battFlowArray[localIndex] || 0;
        }

        // Derive charge/discharge from net flow
        // Try inverting assumption: battFlow > 0 might be Discharge?
        // Or let's just take absolute value if we want to see ANY battery activity for now to debug.
        // But strictly:
        // If previous assumption (neg = discharge) yielded 0, maybe pos = discharge.

        const discharge = battFlow > 0 ? battFlow : 0;
        // const discharge = Math.abs(battFlow); // Fallback if unsure

        // Calculate shares of a 1.0 MW load
        // If charging, we assume load is fully met by solar (1.0)
        // If discharging, we use solarGen + discharge

        let solarShare = Math.min(solarGen, 1.0);
        let batteryShare = Math.min(discharge, 1.0 - solarShare);
        let otherShare = Math.max(0, 1.0 - solarShare - batteryShare);

        // Debug first location occasionally
        if (index === 0 && frameIndex % 12 === 0) {
            console.log(`Frame ${frameIndex} (Local ${localIndex}): Solar ${solarGen.toFixed(3)}, BattFlow ${battFlow.toFixed(3)} -> Discharge ${discharge.toFixed(3)}`);
            console.log(`Shares: Solar ${solarShare.toFixed(2)}, Batt ${batteryShare.toFixed(2)}, Other ${otherShare.toFixed(2)}`);
        }

        // Colors
        // Yellow (Solar): #facc15 -> [250, 204, 21]
        // Purple (Battery): #a855f7 -> [168, 85, 247]
        // Grey (Other): #9ca3af -> [156, 163, 175]

        const r = Math.round(solarShare * 250 + batteryShare * 168 + otherShare * 156);
        const g = Math.round(solarShare * 204 + batteryShare * 85 + otherShare * 163);
        const b = Math.round(solarShare * 21 + batteryShare * 247 + otherShare * 175);

        const color = `rgb(${r}, ${g}, ${b})`;

        return {
            location_id: loc.location_id,
            latitude: loc.latitude || 0,
            longitude: loc.longitude || 0,
            color: color,
            solarShare,
            batteryShare,
            otherShare
        };
    });

    console.log('Sample locations before filter:', mappedLocations.slice(0, 3));
    const filteredLocations = mappedLocations.filter(loc => loc && loc.latitude && loc.longitude);

    console.log(`After filter: ${filteredLocations.length} locations`);

    const frameData = {
        timestamp,
        locations: filteredLocations
    };

    // Update map
    updateMapWithSampleFrame(frameData);
}

function handleSampleLocationSelect(location) {
    if (!sampleWeekData || !location) return;
    selectedSampleLocation = location;
    renderSampleChartForSelected(true);
}

async function renderSampleChartForSelected(forceShow = true) {
    if (!sampleWeekData || !selectedSampleLocation) return;
    const season = selectedSeason || weekSelect.value;
    if (!season) return;

    // sampleWeekData now only contains current season, just find by location_id
    const dataset = sampleWeekData.find(
        d => d.location_id === selectedSampleLocation.location_id
    );

    if (!dataset) {
        if ((forceShow || (sampleChartOverlay && !sampleChartOverlay.classList.contains('hidden'))) && sampleChartOverlay) {
            sampleChartOverlay.classList.remove('hidden');
            resetSampleChartState('No sample data available for this location and season.', false);
        }
        return;
    }

    const timestamps = toArray(dataset.timestamps);
    const solarGen = toArray(dataset.solar_gen);
    const batteryFlow = toArray(dataset.battery_flow);
    const length = Math.min(timestamps.length, solarGen.length, batteryFlow.length);
    if (!length) {
        if ((forceShow || (sampleChartOverlay && !sampleChartOverlay.classList.contains('hidden'))) && sampleChartOverlay) {
            sampleChartOverlay.classList.remove('hidden');
            resetSampleChartState('No sample data available for this location and season.', false);
        }
        return;
    }

    const labels = [];
    const solarData = [];
    const dischargeData = [];
    const otherData = [];
    const chargeData = [];
    const curtailedData = [];
    const demandData = [];
    let maxPositive = 0;

    for (let i = 0; i < length; i++) {
        const solarVal = Math.max(0, solarGen[i] || 0);
        const solarUsed = Math.min(1, solarVal);
        const remaining = Math.max(0, 1 - solarUsed);
        const dischargeRaw = Math.max(0, batteryFlow[i] || 0);
        const dischargeUsed = Math.min(dischargeRaw, remaining);
        const otherSupply = Math.max(0, 1 - solarUsed - dischargeUsed);
        const charge = Math.max(0, - (batteryFlow[i] || 0));
        const curtailed = Math.max(0, solarVal - solarUsed - charge);
        maxPositive = Math.max(maxPositive, solarUsed + dischargeUsed + otherSupply + curtailed + charge);

        const day = Math.floor(i / 24) + 1;
        const hour = i % 24;
        labels.push(`Day ${day} • ${hour.toString().padStart(2, '0')}:00`);

        solarData.push(Number(solarUsed.toFixed(4)));
        dischargeData.push(Number(dischargeUsed.toFixed(4)));
        otherData.push(Number(otherSupply.toFixed(4)));
        chargeData.push(Number(charge.toFixed(4))); // positive, stacks on top
        curtailedData.push(Number(curtailed.toFixed(4)));
        demandData.push(1);
    }

    if (sampleChartOverlay && forceShow) {
        sampleChartOverlay.classList.remove('hidden');
    }
    if (sampleChartStatus) {
        sampleChartStatus.textContent = '';
    }
    if (sampleChartLocation) {
        const seasonLabel = season.charAt(0).toUpperCase() + season.slice(1);
        const lat = typeof selectedSampleLocation.latitude === 'number'
            ? selectedSampleLocation.latitude.toFixed(2)
            : '--';
        const lon = typeof selectedSampleLocation.longitude === 'number'
            ? selectedSampleLocation.longitude.toFixed(2)
            : '--';
        sampleChartLocation.textContent = `ID ${selectedSampleLocation.location_id} (${lat}, ${lon}) • ${seasonLabel}`;
    }
    // Dynamically load Chart.js if not already loaded
    await ensureChartJsLoaded();

    const ChartJS = window.Chart;
    if (!sampleChartCanvas || !ChartJS) {
        if (sampleChartStatus) {
            sampleChartStatus.textContent = 'Chart.js not available.';
        }
        return;
    }
    const ctx = sampleChartCanvas.getContext('2d');
    sampleChartCanvas.classList.remove('hidden');
    if (sampleChart) {
        sampleChart.destroy();
    }
    const yMax = Math.max(1.5, maxPositive + 0.2);
    sampleChart = new ChartJS(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label: 'Solar',
                    data: solarData,
                    backgroundColor: '#facc15',
                    borderWidth: 0,
                    stack: 'supply'
                },
                {
                    label: 'Battery (discharge)',
                    data: dischargeData,
                    backgroundColor: '#a855f7',
                    borderWidth: 0,
                    stack: 'supply'
                },
                {
                    label: 'Other',
                    data: otherData,
                    backgroundColor: '#94a3b8',
                    borderWidth: 0,
                    stack: 'supply'
                },
                {
                    label: 'Battery (charge)',
                    data: chargeData,
                    backgroundColor: '#0ea5e9',
                    borderWidth: 0,
                    stack: 'supply'
                },
                {
                    label: 'Curtailed Solar',
                    data: curtailedData,
                    backgroundColor: '#fb923c',
                    borderWidth: 0,
                    stack: 'supply'
                },
                {
                    label: 'Demand (1 MW)',
                    data: demandData,
                    type: 'line',
                    borderColor: '#f87171',
                    borderWidth: 1.5,
                    fill: false,
                    pointRadius: 0,
                    tension: 0,
                    yAxisID: 'y'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    labels: {
                        color: '#cbd5f5',
                        font: { size: 11 }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: ctx => {
                            const label = ctx.dataset.label || '';
                            const value = ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.parsed;
                            return `${label}: ${value.toFixed(2)} MW`;
                        }
                    }
                }
            },
            scales: {
                x: {
                    stacked: true,
                    ticks: { color: '#94a3b8', maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }
                },
                y: {
                    stacked: true,
                    suggestedMin: 0,
                    suggestedMax: yMax,
                    ticks: {
                        color: '#94a3b8',
                        callback: val => `${val} MW`
                    },
                    title: {
                        display: true,
                        text: 'Output / Load (MW)',
                        color: '#cbd5f5',
                        font: { size: 11 }
                    }
                }
            }
        }
    });
}

// Cleanup on tab switch
export function cleanupSampleDays() {
    stopPlayback();
    hideSampleChart();
}
