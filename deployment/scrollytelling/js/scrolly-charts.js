/**
 * Scrollytelling Charts Module
 * Population histograms, reliability distributions, and fossil capacity charts
 */

// ========== CHART CONFIGURATION ==========
const CHART_COLORS = {
    primary: '#f59e0b',
    secondary: '#3b82f6',
    tertiary: '#10b981',
    danger: '#ef4444',
    muted: '#6b7280',
    grid: 'rgba(255, 255, 255, 0.1)',
    text: '#e5e5e5',
    textMuted: '#9ca3af'
};

const FUEL_COLORS = {
    coal: '#f97316',
    oil_gas: '#38bdf8',
    bioenergy: '#84cc16',
    nuclear: '#a855f7'
};

// Track multiple chart instances
let chartInstances = {};
let ChartJS = null;
let chartHideTimeout = null;
let chartWanted = false;
if (typeof window !== 'undefined') {
    window.section5ChartActive = false;
}

function showChartContainer() {
    const container = document.getElementById('chart-container');
    if (!container) return null;
    chartWanted = true;
    if (chartHideTimeout) {
        clearTimeout(chartHideTimeout);
        chartHideTimeout = null;
    }
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
    return container;
}

function queueChartResize(containerId) {
    const chart = chartInstances[containerId];
    if (!chart) return;
    requestAnimationFrame(() => chart.resize());
    setTimeout(() => chart.resize(), 350);
}

// ========== INITIALIZATION ==========
async function ensureChartJsLoaded() {
    if (ChartJS) return ChartJS;
    if (window.Chart) {
        ChartJS = window.Chart;
        return ChartJS;
    }

    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
        script.onload = () => {
            ChartJS = window.Chart;
            Chart.defaults.color = CHART_COLORS.textMuted;
            Chart.defaults.borderColor = CHART_COLORS.grid;
            resolve(ChartJS);
        };
        script.onerror = reject;
        document.head.appendChild(script);
    });
}

// ========== CHART BUILDING FUNCTIONS ==========

/**
 * Build population histogram by capacity factor
 */
function buildPopulationByCfHistogram(populationData, cfData, buckets = 20) {
    const cfByCord = new Map();
    cfData.forEach(d => {
        const key = `${d.latitude.toFixed(4)},${d.longitude.toFixed(4)}`;
        cfByCord.set(key, d.annual_cf);
    });

    const histogram = new Array(buckets).fill(0);
    const labels = [];
    const bucketSize = 1.0 / buckets;

    for (let i = 0; i < buckets; i++) {
        labels.push(`${(i * bucketSize * 100).toFixed(0)}-${((i + 1) * bucketSize * 100).toFixed(0)}%`);
    }

    populationData.forEach(pop => {
        const key = `${pop.latitude.toFixed(4)},${pop.longitude.toFixed(4)}`;
        const cf = cfByCord.get(key);
        if (cf !== undefined && pop.population_2020 > 0) {
            const bucketIndex = Math.min(Math.floor(cf / bucketSize), buckets - 1);
            histogram[bucketIndex] += pop.population_2020;
        }
    });

    // Convert to billions for readability
    const data = histogram.map(v => v / 1e9);

    return {
        labels,
        datasets: [{
            label: 'Population (billions)',
            data,
            backgroundColor: data.map((_, i) => {
                const hue = 30 + (i / buckets) * 90; // Orange to green
                return `hsla(${hue}, 70%, 50%, 0.7)`;
            }),
            borderColor: data.map((_, i) => {
                const hue = 30 + (i / buckets) * 90;
                return `hsl(${hue}, 70%, 50%)`;
            }),
            borderWidth: 1
        }]
    };
}

/**
 * Build grid reliability distribution chart
 */
function buildReliabilityDistribution(reliabilityData) {
    // Aggregate population by reliability bins
    const bins = [
        { label: 'No Access', range: [0, 0], pop: 0 },
        { label: '0-50%', range: [0.1, 50], pop: 0 },
        { label: '50-80%', range: [50, 80], pop: 0 },
        { label: '80-95%', range: [80, 95], pop: 0 },
        { label: '95-99%', range: [95, 99], pop: 0 },
        { label: '100%', range: [99, 101], pop: 0 }
    ];

    reliabilityData.forEach(row => {
        const totalPop = row.total_pop_reliability || 0;
        if (totalPop <= 0) return;

        const noAccessPop = (row.pct_no_access || 0) * totalPop;
        bins[0].pop += noAccessPop;

        const connectedPop = totalPop - noAccessPop;
        const rel = row.avg_reliability_access_only || 0;

        for (let i = 1; i < bins.length; i++) {
            if (rel >= bins[i].range[0] && rel < bins[i].range[1]) {
                bins[i].pop += connectedPop;
                break;
            }
        }
    });

    const labels = bins.map(b => b.label);
    const data = bins.map(b => b.pop / 1e9); // billions

    return {
        labels,
        datasets: [{
            label: 'Population (billions)',
            data,
            backgroundColor: [
                'rgba(239, 68, 68, 0.7)',    // No Access - red
                'rgba(249, 115, 22, 0.7)',   // 0-50 - orange
                'rgba(234, 179, 8, 0.7)',    // 50-80 - yellow
                'rgba(132, 204, 22, 0.7)',   // 80-95 - lime
                'rgba(34, 197, 94, 0.7)',    // 95-99 - green
                'rgba(16, 185, 129, 0.7)'    // 100 - emerald
            ],
            borderColor: [
                '#ef4444', '#f97316', '#eab308',
                '#84cc16', '#22c55e', '#10b981'
            ],
            borderWidth: 1
        }]
    };
}

/**
 * Build fossil capacity by CF percentile
 */
function buildFossilByCfChart(fossilCapacityData, cfData, selectedFuels = ['coal'], buckets = 10) {
    const cfByLocation = new Map();
    cfData.forEach(d => {
        cfByLocation.set(d.location_id, d.annual_cf);
    });

    // Initialize datasets for each fuel
    const fuelHistograms = {};
    selectedFuels.forEach(fuel => {
        fuelHistograms[fuel] = new Array(buckets).fill(0);
    });

    const labels = [];
    const bucketSize = 1.0 / buckets;
    for (let i = 0; i < buckets; i++) {
        labels.push(`${(i * bucketSize * 100).toFixed(0)}-${((i + 1) * bucketSize * 100).toFixed(0)}%`);
    }

    fossilCapacityData.forEach(row => {
        const cf = cfByLocation.get(row.location_id);
        if (cf === undefined) return;

        const bucketIndex = Math.min(Math.floor(cf / bucketSize), buckets - 1);
        selectedFuels.forEach(fuel => {
            const capacity = row[`${fuel}_Existing`] || 0;
            if (capacity > 0) {
                fuelHistograms[fuel][bucketIndex] += capacity;
            }
        });
    });

    const datasets = selectedFuels.map(fuel => ({
        label: fuel.replace('_', '/').toUpperCase(),
        data: fuelHistograms[fuel].map(v => v / 1000), // Convert to GW
        backgroundColor: FUEL_COLORS[fuel] + 'b3', // with alpha
        borderColor: FUEL_COLORS[fuel],
        borderWidth: 1
    }));

    return {
        labels,
        datasets
    };
}

// ========== CHART RENDERING ==========
function ensureCorrectLayout(isDual) {
    const single = document.getElementById('chart-layout-single');
    const dual = document.getElementById('chart-layout-dual');
    if (!single || !dual) return;

    if (isDual) {
        single.classList.add('hidden');
        dual.classList.remove('hidden');
    } else {
        single.classList.remove('hidden');
        dual.classList.add('hidden');
    }
}

export async function renderChart(containerId, type, chartData, options = {}) {
    await ensureChartJsLoaded();
    if (typeof window !== 'undefined') {
        window.section5ChartActive = false;
    }
    showChartContainer();

    const container = document.getElementById(containerId);
    if (!container) return null;

    // Find or create canvas
    let canvas = container.querySelector('canvas');
    if (!canvas) {
        canvas = document.createElement('canvas');
        const wrapper = container.querySelector('.chart-canvas-wrapper');
        if (wrapper) {
            wrapper.appendChild(canvas);
        } else {
            container.appendChild(canvas);
        }
    }

    // Destroy existing chart for this container
    if (chartInstances[containerId]) {
        chartInstances[containerId].destroy();
        delete chartInstances[containerId];
    }

    const ctx = canvas.getContext('2d');

    const defaultOptions = {
        responsive: true,
        maintainAspectRatio: false,
        onHover: options.onHover || null,
        plugins: {
            legend: {
                display: chartData.datasets.length > 1,
                position: 'top',
                labels: {
                    boxWidth: 12,
                    padding: 8,
                    font: { size: 11 }
                }
            },
            tooltip: {
                backgroundColor: 'rgba(30, 30, 30, 0.95)',
                titleFont: { size: 12 },
                bodyFont: { size: 11 },
                padding: 10,
                cornerRadius: 6,
                enabled: options.tooltipEnabled !== false
            }
        },
        scales: {
            x: {
                grid: { color: CHART_COLORS.grid },
                ticks: { font: { size: 10 } }
            },
            y: {
                grid: { color: CHART_COLORS.grid },
                ticks: { font: { size: 10 } },
                title: {
                    display: !!options.yAxisLabel,
                    text: options.yAxisLabel || '',
                    font: { size: 11 }
                }
            }
        },
        animation: {
            duration: options.animationDuration !== undefined ? options.animationDuration : 600,
            easing: 'easeOutCubic'
        }
    };

    chartInstances[containerId] = new ChartJS(ctx, {
        type: type || 'bar',
        data: chartData,
        options: { ...defaultOptions, ...options }
    });

    // Add mouseout listener to ensure map and peer-chart highlights are cleared
    canvas.addEventListener('mouseout', () => {
        if (options.onHover) {
            options.onHover(null, []);
        }
    });

    queueChartResize(containerId);
    return chartInstances[containerId];
}

// ========== SCROLLYTELLING CHART API ==========
export async function showPopulationCfChart(populationData, cfData) {
    ensureCorrectLayout(false);

    // Update title
    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Population by Capacity Factor';
    if (subtitle) subtitle.textContent = 'How many people live in areas with high solar+storage potential?';

    const chartData = buildPopulationByCfHistogram(populationData, cfData);
    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: 'Population (billions)'
    });

    const container = document.getElementById('chart-container');
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showReliabilityChart(reliabilityData) {
    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Grid Reliability Distribution';
    if (subtitle) subtitle.textContent = 'Global population by electricity access and grid uptime';

    const chartData = buildReliabilityDistribution(reliabilityData);
    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: 'Population (billions)'
    });

    const container = document.getElementById('chart-container');
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showFossilDisplacementChart(fossilData, cfData, fuels = ['coal']) {
    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    const fuelLabel = fuels.map(f => f.replace('_', '/')).join('/').toUpperCase();
    if (title) title.textContent = `${fuelLabel} Capacity by CF Potential`;
    if (subtitle) subtitle.textContent = 'Fossil capacity in regions with high baseload solar viability';

    const chartData = buildFossilByCfChart(fossilData, cfData, fuels);
    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: 'Capacity (GW)',
        plugins: {
            legend: { display: true }
        },
        scales: {
            x: { stacked: true },
            y: { stacked: true }
        }
    });

    const container = document.getElementById('chart-container');
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export function hideChart() {
    const container = document.getElementById('chart-container');
    if (!container) return;

    chartWanted = false;
    if (typeof window !== 'undefined') {
        window.section5ChartActive = false;
    }
    container.classList.remove('chart-slide-in');
    container.classList.add('chart-slide-out');
    document.querySelector('.scrolly-visual')?.classList.remove('with-chart');

    if (chartHideTimeout) {
        clearTimeout(chartHideTimeout);
    }
    chartHideTimeout = setTimeout(() => {
        if (!chartWanted && container.classList.contains('chart-slide-out')) {
            container.classList.add('hidden');
        }
    }, 500);
}

export async function showWeeklySampleChart(sampleData, locationName = 'Representative Location') {
    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Weekly Energy Profile';
    if (subtitle) subtitle.textContent = `Solar + Battery performance in ${locationName}`;

    // Process data to get arrays
    const hours = Math.min(sampleData.length, 72);
    const slice = sampleData.slice(0, hours);

    const solarUsed = slice.map(d => Math.min(d.solar_gen, 1.0));
    const battDischarge = slice.map(d => d.battery_flow > 0 ? d.battery_flow : 0);
    const unserved = slice.map(d => d.unserved);
    const soc = slice.map(d => d.soc);
    const solarPotential = slice.map(d => d.solar_gen);

    const chartData = {
        labels: Array.from({ length: hours }, (_, i) => i),
        datasets: [
            {
                type: 'bar',
                label: 'Direct Solar',
                data: solarUsed,
                backgroundColor: '#facc15',
                borderColor: '#facc15',
                stack: 'stack0',
                order: 2
            },
            {
                type: 'bar',
                label: 'Battery Discharge',
                data: battDischarge,
                backgroundColor: '#a855f7',
                borderColor: '#a855f7',
                stack: 'stack0',
                order: 2
            },
            {
                type: 'bar',
                label: 'Unserved Load',
                data: unserved,
                backgroundColor: '#9ca3af',
                borderColor: '#9ca3af',
                stack: 'stack0',
                order: 2
            },
            {
                type: 'line',
                label: 'Solar Potential',
                data: solarPotential,
                borderColor: '#fbbf24',
                borderDash: [3, 3],
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.4,
                order: 1
            }
        ]
    };

    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: 'Power (MW)',
        scales: {
            x: { display: false },
            y: {
                stacked: true,
                title: { display: true, text: 'Power (MW)' }
            }
        }
    });

    const container = document.getElementById('chart-container');
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showUptimeComparisonChart(reliabilityData, locationIndex, lcoeParams) {
    const container = document.getElementById('chart-container');
    if (!container) return;

    ensureCorrectLayout(true);

    // Update titles for dual layout
    const title1 = document.getElementById('dual-title-1');
    const subtitle1 = document.getElementById('dual-subtitle-1');
    if (title1) title1.textContent = 'Global grid reliability';
    if (subtitle1) subtitle1.textContent = 'Population (millions) by grid uptime (%)';

    const title2 = document.getElementById('dual-title-2');
    const subtitle2 = document.getElementById('dual-subtitle-2');
    if (title2) title2.textContent = 'Cost of solar + battery system to match/beat grid uptime';
    if (subtitle2) subtitle2.textContent = 'Cost ($/MWh LCOE) by grid uptime (%)';

    // Helper to calculate LCOE same as scrolly.js
    const crf = (i, n) => (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
    const computeLcoe = (row, solarCapex, batteryCapex, solarCrf, batteryCrf, solarOpexPct, batteryOpexPct) => {
        const solarKw = row.solar_gw * 1000;
        const batteryKwh = row.batt_gwh * 1000;
        const solarCapexTotal = solarKw * solarCapex;
        const batteryCapexTotal = batteryKwh * batteryCapex;
        const annualSolarCost = solarCapexTotal * solarCrf + solarCapexTotal * solarOpexPct;
        const annualBatteryCost = batteryCapexTotal * batteryCrf + batteryCapexTotal * batteryOpexPct;
        const annualMwh = row.annual_cf * 8760;
        if (annualMwh <= 0) return Infinity;
        return (annualSolarCost + annualBatteryCost) / annualMwh;
    };

    const { solarCapex, batteryCapex, solarOpexPct, batteryOpexPct, solarLife, batteryLife, wacc } = lcoeParams;
    const solarCrf = crf(wacc, solarLife);
    const batteryCrf = crf(wacc, batteryLife);

    // Define color scale (Red 0% -> Mid Grey 100%)
    const colorScale = d3.scaleLinear()
        .domain([0, 100])
        .range(["#ef4444", "#6b7280"])
        .clamp(true);

    // Bins for Grid Uptime (EXCLUDING 100%)
    const bins = [];
    for (let i = 0; i < 90; i += 10) {
        bins.push({ label: `${i}-${i + 10}%`, range: [i, i + 10], color: colorScale(i + 5), pop: 0, weightedLcoe: 0 });
    }
    bins.push({ label: `90-99%`, range: [90, 99.1], color: colorScale(95), pop: 0, weightedLcoe: 0 });

    reliabilityData.forEach(row => {
        if (!row.hrea_covered) return;

        const gridRel = row.avg_reliability_access_only !== undefined ? row.avg_reliability_access_only : row.avg_reliability;
        const pop = row.total_pop_reliability || 0;
        const locId = row.location_id;

        // Skip absolute 100% or above 99.1% (per user request to exclude 100% bucket)
        if (gridRel >= 99.1) return;

        // Find min LCOE that meets or exceeds gridRel
        let minLcoe = Infinity;
        if (locationIndex && locationIndex.has(locId)) {
            const locRows = locationIndex.get(locId);
            locRows.forEach(simRow => {
                if (simRow.annual_cf * 100 >= gridRel && simRow.solar_gw <= 10) {
                    const lcoe = computeLcoe(simRow, solarCapex, batteryCapex, solarCrf, batteryCrf, solarOpexPct, batteryOpexPct);
                    if (lcoe < minLcoe) minLcoe = lcoe;
                }
            });
        }

        const binIndex = bins.findIndex(b => gridRel >= b.range[0] && gridRel < b.range[1]);
        if (binIndex !== -1) {
            bins[binIndex].pop += pop;
            if (minLcoe !== Infinity && Number.isFinite(minLcoe)) {
                bins[binIndex].weightedLcoe += pop * minLcoe;
            }
        }
    });

    const popChartData = {
        labels: bins.map(b => b.label),
        datasets: [{
            label: 'Population (millions)',
            data: bins.map(b => b.pop / 1e6),
            backgroundColor: bins.map(b => b.color),
            borderColor: bins.map(b => b.color),
            borderWidth: 1,
            hoverBackgroundColor: bins.map(b => b.color),
            hoverBorderColor: '#fff',
            hoverBorderWidth: 2
        }]
    };

    const lcoeChartData = {
        labels: bins.map(b => b.label),
        datasets: [{
            label: 'Cost ($/MWh)',
            data: bins.map(b => b.pop > 0 ? b.weightedLcoe / b.pop : 0),
            backgroundColor: bins.map(b => b.color),
            borderColor: bins.map(b => b.color),
            borderWidth: 1,
            hoverBackgroundColor: bins.map(b => b.color),
            hoverBorderColor: '#fff',
            hoverBorderWidth: 2
        }]
    };

    // Shared hover state
    const handleHover = (event, elements) => {
        if (elements.length > 0) {
            const index = elements[0].index;
            const bin = bins[index];

            // Highlight both charts
            ['chart-wrapper-dual-1', 'chart-wrapper-dual-2'].forEach(id => {
                const chart = chartInstances[id];
                if (chart) {
                    chart.setActiveElements([{ datasetIndex: 0, index }]);
                    chart.update('none');
                }
            });

            // Highlight Map via window global if set
            if (window.highlightMapByReliability) {
                window.highlightMapByReliability(bin.range[0], bin.range[1]);
            }
        } else {
            // Reset both charts
            ['chart-wrapper-dual-1', 'chart-wrapper-dual-2'].forEach(id => {
                const chart = chartInstances[id];
                if (chart) {
                    chart.setActiveElements([]);
                    chart.update('none');
                }
            });
            if (window.clearMapHighlight) {
                window.clearMapHighlight();
            }
        }
    };

    // Expose highlighting to window for map -> chart interaction
    window.highlightChartsByReliability = (gridRel) => {
        if (gridRel >= 99.1) return; // Matches exclusion logic
        const index = bins.findIndex(b => gridRel >= b.range[0] && gridRel < b.range[1]);
        if (index !== -1) {
            ['chart-wrapper-dual-1', 'chart-wrapper-dual-2'].forEach(id => {
                const chart = chartInstances[id];
                if (chart) {
                    chart.setActiveElements([{ datasetIndex: 0, index }]);
                    chart.update('none');
                    // Also show tooltip for the highlighted bar
                    const meta = chart.getDatasetMeta(0);
                    const element = meta.data[index];
                    if (element) {
                        chart.tooltip.setActiveElements([{ datasetIndex: 0, index }], { x: element.x, y: element.y });
                    }
                }
            });
        }
    };

    window.clearChartsHighlight = () => {
        ['chart-wrapper-dual-1', 'chart-wrapper-dual-2'].forEach(id => {
            const chart = chartInstances[id];
            if (chart) {
                chart.setActiveElements([]);
                chart.tooltip.setActiveElements([], { x: 0, y: 0 });
                chart.update('none');
            }
        });
    };

    await Promise.all([
        renderChart('chart-wrapper-dual-1', 'bar', popChartData, {
            plugins: { legend: { display: false } },
            onHover: handleHover,
            animationDuration: 0 // Snappy hover
        }),
        renderChart('chart-wrapper-dual-2', 'bar', lcoeChartData, {
            plugins: { legend: { display: false } },
            onHover: handleHover,
            animationDuration: 0 // Snappy hover
        })
    ]);

    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showCumulativeCapacityChart(fossilData, lcoeData) {
    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Planned Capacity vs. Solar Potential';
    if (subtitle) subtitle.textContent = 'Cumulative planned capacity versus LCOE of solar + battery alternative, GW';

    // Map LCOE by location
    const lcoeMap = new Map();
    if (Array.isArray(lcoeData)) {
        lcoeData.forEach(d => {
            if (Number.isFinite(d.lcoe)) {
                lcoeMap.set(d.location_id, d.lcoe);
            }
        });
    }

    // Join fossil capacity with LCOE
    const combined = [];
    fossilData.forEach(row => {
        const lcoe = lcoeMap.get(row.location_id);
        if (lcoe !== undefined) {
            combined.push({
                location_id: row.location_id,
                lcoe,
                coal: row.coal_Announced || 0,
                gas: row.oil_gas_Announced || 0,
                nuclear: row.nuclear_Announced || 0,
                bio: row.bioenergy_Announced || 0
            });
        }
    });

    combined.sort((a, b) => a.lcoe - b.lcoe);
    const activeData = combined.filter(d => (d.coal + d.gas + d.nuclear + d.bio) > 0);

    const maxLcoe = 200;
    const numBuckets = 20;
    const lcoeStep = maxLcoe / numBuckets;

    const bins = Array.from({ length: numBuckets }, (_, i) => ({
        limit: (i + 1) * lcoeStep,
        coal: 0,
        gas: 0,
        nuclear: 0,
        bio: 0,
        label: `$${Math.round((i + 1) * lcoeStep)}`
    }));

    const overflowBin = {
        limit: Infinity,
        coal: 0,
        gas: 0,
        nuclear: 0,
        bio: 0,
        label: '>200'
    };

    activeData.forEach(d => {
        const lcoeValue = Math.max(0, Number(d.lcoe));
        const bin = lcoeValue > maxLcoe
            ? overflowBin
            : bins[Math.min(Math.floor(lcoeValue / lcoeStep), numBuckets - 1)];
        bin.coal += d.coal / 1000;
        bin.gas += d.gas / 1000;
        bin.nuclear += d.nuclear / 1000;
        bin.bio += d.bio / 1000;
    });

    let tumCoal = 0, tumGas = 0, tumNuc = 0, tumBio = 0;
    const dataPoints = [...bins, overflowBin].map(bin => {
        tumCoal += bin.coal;
        tumGas += bin.gas;
        tumNuc += bin.nuclear;
        tumBio += bin.bio;
        return {
            lcoe: bin.limit,
            label: bin.label,
            coal: tumCoal,
            gas: tumGas,
            nuclear: tumNuc,
            bio: tumBio
        };
    });

    const sortedActive = activeData.slice().sort((a, b) => a.lcoe - b.lcoe);
    const cumulativeLocationIds = [];
    let activeIndex = 0;
    let runningIds = [];
    dataPoints.forEach((point, i) => {
        while (activeIndex < sortedActive.length && sortedActive[activeIndex].lcoe <= point.lcoe) {
            const id = sortedActive[activeIndex].location_id;
            if (id !== undefined && id !== null) {
                runningIds.push(id);
            }
            activeIndex += 1;
        }
        cumulativeLocationIds[i] = runningIds.slice();
    });

    const coalColor = FUEL_COLORS.coal;
    const gasColor = FUEL_COLORS.oil_gas;
    const nuclearColor = FUEL_COLORS.nuclear;
    const bioColor = FUEL_COLORS.bioenergy;

    const chartData = {
        labels: dataPoints.map(p => p.label || `$${Math.round(p.lcoe)}`),
        datasets: [
            { label: 'Coal', data: dataPoints.map(p => p.coal), borderColor: coalColor, backgroundColor: coalColor + 'CC', hoverBackgroundColor: coalColor + 'CC', hoverBorderColor: coalColor, borderWidth: 1 },
            { label: 'Oil/Gas', data: dataPoints.map(p => p.gas), borderColor: gasColor, backgroundColor: gasColor + 'CC', hoverBackgroundColor: gasColor + 'CC', hoverBorderColor: gasColor, borderWidth: 1 },
            { label: 'Nuclear', data: dataPoints.map(p => p.nuclear), borderColor: nuclearColor, backgroundColor: nuclearColor + 'CC', hoverBackgroundColor: nuclearColor + 'CC', hoverBorderColor: nuclearColor, borderWidth: 1 },
            { label: 'Bioenergy', data: dataPoints.map(p => p.bio), borderColor: bioColor, backgroundColor: bioColor + 'CC', hoverBackgroundColor: bioColor + 'CC', hoverBorderColor: bioColor, borderWidth: 1 }
        ]
    };

    let lastHoverIndex = null;
    let hoverRaf = null;
    await renderChart('chart-layout-single', 'bar', chartData, {
        scales: {
            x: { stacked: true, title: { display: true, text: 'Solar LCOE ($/MWh)' }, ticks: { maxTicksLimit: 12 } },
            y: { stacked: true, title: { display: false } }
        },
        interaction: { intersect: false, mode: 'index' },
        categoryPercentage: 1.0,
        barPercentage: 1.0,
        onHover: (event, elements) => {
            if (!window.updatePlannedCapacityOverlay) return;
            const nextIndex = (elements && elements.length > 0) ? elements[0].index : null;
            if (nextIndex === lastHoverIndex) return;
            lastHoverIndex = nextIndex;
            if (hoverRaf) cancelAnimationFrame(hoverRaf);
            hoverRaf = requestAnimationFrame(() => {
                window.updatePlannedCapacityOverlay(nextIndex === null ? null : (cumulativeLocationIds[nextIndex] || []));
            });
        },
        plugins: {
            tooltip: {
                callbacks: {
                    label: function (context) {
                        let label = context.dataset.label || '';
                        if (label) label += ': ';
                        if (context.parsed.y !== null) label += context.parsed.y.toFixed(1) + ' GW';
                        return label;
                    }
                }
            }
        }
    });

    if (window.updatePlannedCapacityOverlay) {
        window.updatePlannedCapacityOverlay(null);
    }

    const container = document.getElementById('chart-container');
    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showNoAccessLcoeChart(reliabilityData, locationIndex, lcoeParams, targetCfValue, lcoeResults = null) {
    const container = document.getElementById('chart-container');
    if (!container) return;

    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Cost of solar + battery system to provide power';
    if (subtitle) subtitle.textContent = `LCOE ($/MWh) to reach ${targetCfValue}% uptime, sorted by cost for 10% slices of the population without access`;

    const targetCf = targetCfValue / 100;
    const lcoeLookup = Array.isArray(lcoeResults) && lcoeResults.length
        ? new Map(lcoeResults.map(row => [Number(row.location_id), row]))
        : null;
    const { solarCapex, batteryCapex, solarOpexPct, batteryOpexPct, solarLife, batteryLife, wacc } = lcoeParams;
    const crfValue = (i, n) => (i * Math.pow(1 + i, n)) / (Math.pow(1 + i, n) - 1);
    const solarCrf = crfValue(wacc, solarLife);
    const batteryCrf = crfValue(wacc, batteryLife);

    const computeLcoe = (row) => {
        const solarKw = row.solar_gw * 1000;
        const batteryKwh = row.batt_gwh * 1000;
        const annualSolarCost = solarKw * solarCapex * (solarCrf + solarOpexPct);
        const annualBatteryCost = batteryKwh * batteryCapex * (batteryCrf + batteryOpexPct);
        const annualMwh = row.annual_cf * 8760;
        return annualMwh > 0 ? (annualSolarCost + annualBatteryCost) / annualMwh : Infinity;
    };

    // 1. Collect all locations with population lacking access and their LCOE
    const locations = [];
    reliabilityData.forEach(row => {
        if (!row.hrea_covered) return;
        const pctNoAccess = row.pct_no_access || 0;
        if (pctNoAccess <= 0) return;

        const popNoAccess = (row.total_pop_reliability || 0) * pctNoAccess;
        if (popNoAccess <= 0) return;

        const locationId = Number(row.location_id);
        let lcoeValue = null;
        if (lcoeLookup) {
            const lcoeRow = lcoeLookup.get(locationId);
            if (lcoeRow && lcoeRow.meetsTarget && Number.isFinite(lcoeRow.lcoe)) {
                lcoeValue = lcoeRow.lcoe;
            }
        } else if (locationIndex.has(row.location_id)) {
            const locRows = locationIndex.get(row.location_id);
            let minLcoe = Infinity;
            locRows.forEach(simRow => {
                if (simRow.annual_cf >= targetCf && simRow.solar_gw <= 10) {
                    const lcoe = computeLcoe(simRow);
                    if (lcoe < minLcoe) minLcoe = lcoe;
                }
            });
            if (minLcoe !== Infinity && Number.isFinite(minLcoe)) {
                lcoeValue = minLcoe;
            }
        }

        if (Number.isFinite(lcoeValue)) {
            locations.push({
                location_id: row.location_id,
                lcoe: lcoeValue,
                popNoAccess: popNoAccess
            });
        }
    });

    // 2. Sort by LCOE ascending
    locations.sort((a, b) => a.lcoe - b.lcoe);

    // 3. Create 10 buckets (deciles of the total population without access)
    window.section5LocationToBin = new Map();
    window.section5BinToLocations = Array.from({ length: 10 }, () => []);

    const totalPopNoAccess = locations.reduce((sum, d) => sum + d.popNoAccess, 0);
    const bucketSize = totalPopNoAccess / 10;
    const buckets = [];

    let currentPopSum = 0;
    let currentLcoeSum = 0;
    let currentBucketPop = 0;
    let bucketIndex = 0;

    locations.forEach(loc => {
        let remainingPop = loc.popNoAccess;

        while (remainingPop > 0 && bucketIndex < 10) {
            const spaceInBucket = bucketSize - currentBucketPop;
            const popToAdd = Math.min(remainingPop, spaceInBucket);

            currentLcoeSum += popToAdd * loc.lcoe;
            currentBucketPop += popToAdd;
            remainingPop -= popToAdd;

            // Map this location to the current bucket
            if (loc.location_id) {
                window.section5LocationToBin.set(Number(loc.location_id), bucketIndex);
                window.section5BinToLocations[bucketIndex].push(Number(loc.location_id));
            }

            if (currentBucketPop >= bucketSize - 0.001) { // Floating point tolerance
                buckets.push({
                    avgLcoe: currentLcoeSum / bucketSize,
                    label: `${bucketIndex * 10}-${(bucketIndex + 1) * 10}%`
                });

                bucketIndex++;
                currentLcoeSum = 0;
                currentBucketPop = 0;
            }
        }
    });

    // Handle any leftovers in the last bucket if precision issues occurred
    if (buckets.length < 10 && currentBucketPop > 0) {
        buckets.push({
            avgLcoe: currentLcoeSum / currentBucketPop,
            label: `${(buckets.length) * 10}-${(buckets.length + 1) * 10}%`
        });
    }

    // Helper functions for external highlighting
    window.highlightChartByLocationId = (locationId) => {
        console.log("Hovering map location:", locationId);
        if (!window.section5LocationToBin) {
            console.log("No section5LocationToBin map found");
            return;
        }
        const binIndex = window.section5LocationToBin.get(Number(locationId));
        console.log("Mapping to bin:", binIndex);
        if (binIndex !== undefined) {
            window.highlightChartByBinIndex(binIndex);
        } else {
            window.clearSection5ChartHighlight();
        }
    };

    window.highlightChartByBinIndex = (binIndex) => {
        const chart = chartInstances['chart-layout-single'];
        if (!chart) return;

        const dataset = chart.data.datasets[0];
        const newColors = buckets.map((_, i) => {
            const lightness = 80 - (i / 9) * 30;
            const isHighlighted = i === binIndex;
            return isHighlighted ? `hsla(0, 0%, ${lightness}%, 1)` : `hsla(0, 0%, ${lightness}%, 0.15)`;
        });
        dataset.backgroundColor = newColors;
        dataset.borderColor = newColors.map(c => c.replace('0.15', '0.3'));
        chart.update('none');
    };

    window.clearSection5ChartHighlight = () => {
        const chart = chartInstances['chart-layout-single'];
        if (!chart) return;

        const dataset = chart.data.datasets[0];
        const defaultColors = buckets.map((_, i) => {
            const lightness = 80 - (i / 9) * 30;
            return `hsla(0, 0%, ${lightness}%, 0.7)`;
        });
        dataset.backgroundColor = defaultColors;
        dataset.borderColor = defaultColors.map(c => c.replace('0.7', '1'));
        chart.update('none');
    };

    const chartData = {
        labels: buckets.map(b => b.label),
        datasets: [{
            label: 'Avg. LCOE ($/MWh)',
            data: buckets.map(b => b.avgLcoe),
            backgroundColor: buckets.map((_, i) => {
                const lightness = 80 - (i / 9) * 30; // 80% (light) to 50% (mid)
                return `hsla(0, 0%, ${lightness}%, 0.7)`;
            }),
            borderColor: buckets.map((_, i) => {
                const lightness = 80 - (i / 9) * 30;
                return `hsl(0, 0%, ${lightness}%)`;
            }),
            borderWidth: 1,
            hoverBackgroundColor: '#fff'
        }]
    };

    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: '',
        plugins: { legend: { display: false } },
        animationDuration: 0,
        onHover: (event, elements) => {
            if (elements && elements.length > 0) {
                const index = elements[0].index;
                const locationIds = window.section5BinToLocations[index];
                if (window.updateMapWithHighlightSection5) {
                    window.updateMapWithHighlightSection5(locationIds);
                }
                window.highlightChartByBinIndex(index);
            } else {
                if (window.updateMapWithHighlightSection5) {
                    window.updateMapWithHighlightSection5(null);
                }
                window.clearSection5ChartHighlight();
            }
        }
    });

    if (typeof window !== 'undefined') {
        window.section5ChartActive = true;
    }

    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export async function showGlobalPopulationLcoeChart(populationData, lcoeResults, { maxLcoe = 200, bins = 20 } = {}) {
    const container = document.getElementById('chart-container');
    if (!container) return;

    ensureCorrectLayout(false);

    const title = document.querySelector('#chart-layout-single .chart-title');
    const subtitle = document.querySelector('#chart-layout-single .chart-subtitle');
    if (title) title.textContent = 'Global population vs LCOE';
    if (subtitle) subtitle.textContent = 'Cumulative share of global population that can meet the uptime target, %';

    const popById = new Map();
    let totalPopulation = 0;
    populationData.forEach(row => {
        const pop = Number(row.population_2020 || 0);
        if (!Number.isFinite(pop) || pop <= 0) return;
        const id = Number(row.location_id);
        popById.set(id, pop);
        totalPopulation += pop;
    });

    const bucketCount = Math.max(3, bins);
    const bucketSize = maxLcoe / bucketCount;
    const bucketPop = new Array(bucketCount).fill(0);
    const highlightRows = [];

    lcoeResults.forEach(row => {
        if (!row || !row.meetsTarget) return;
        const lcoe = Number(row.lcoe);
        if (!Number.isFinite(lcoe)) return;
        const pop = popById.get(Number(row.location_id)) || 0;
        if (pop <= 0) return;
        const capped = Math.max(0, Math.min(maxLcoe, lcoe));
        const index = Math.min(bucketCount - 1, Math.floor(capped / bucketSize));
        bucketPop[index] += pop;
        highlightRows.push({ location_id: Number(row.location_id), lcoe });
    });

    const cumulativePercent = [];
    let running = 0;
    for (let i = 0; i < bucketCount; i++) {
        running += bucketPop[i];
        const pct = totalPopulation > 0 ? (running / totalPopulation) * 100 : 0;
        cumulativePercent.push(pct);
    }

    const labels = [];
    for (let i = 0; i < bucketCount; i++) {
        const upper = Math.round((i + 1) * bucketSize);
        labels.push(`$${upper}`);
    }

    const cumulativeLocationIds = [];
    const sortedHighlight = highlightRows.sort((a, b) => a.lcoe - b.lcoe);
    let highlightIndex = 0;
    let runningIds = [];
    for (let i = 0; i < bucketCount; i++) {
        const limit = (i + 1) * bucketSize;
        while (
            highlightIndex < sortedHighlight.length &&
            (sortedHighlight[highlightIndex].lcoe <= limit || i === bucketCount - 1)
        ) {
            runningIds.push(sortedHighlight[highlightIndex].location_id);
            highlightIndex += 1;
        }
        cumulativeLocationIds[i] = runningIds.slice();
    }

    const lcoeDomain = [0, 25, 50, 75, 100, 200];
    const lcoeRange = ["#0b1d3a", "#1d4ed8", "#16a34a", "#eab308", "#f59e0b", "#dc2626"];
    const colorScale = (window.d3 && window.d3.scaleLinear)
        ? window.d3.scaleLinear().domain(lcoeDomain).range(lcoeRange).clamp(true)
        : (value) => {
            const idx = Math.min(lcoeRange.length - 1, Math.max(0, Math.floor((value / maxLcoe) * lcoeRange.length)));
            return lcoeRange[idx] || lcoeRange[lcoeRange.length - 1];
        };
    const colors = cumulativePercent.map((_, i) => {
        const midValue = Math.min(maxLcoe, (i + 0.5) * bucketSize);
        const base = colorScale(midValue);
        let rgb = null;
        if (window.d3 && window.d3.color) {
            rgb = window.d3.color(base);
        }
        if (!rgb && typeof base === 'string' && base.startsWith('#')) {
            rgb = {
                r: parseInt(base.slice(1, 3), 16),
                g: parseInt(base.slice(3, 5), 16),
                b: parseInt(base.slice(5, 7), 16)
            };
        }
        if (rgb) {
            return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.7)`;
        }
        return base;
    });
    const borderColors = colors.map(color => {
        if (typeof color === 'string' && color.startsWith('rgba(')) {
            return color.replace(/rgba\\(([^,]+),\\s*([^,]+),\\s*([^,]+),\\s*[^\\)]+\\)/, 'rgb($1, $2, $3)');
        }
        return color;
    });

    const chartData = {
        labels,
        datasets: [{
            label: 'Cumulative population (%)',
            data: cumulativePercent,
            backgroundColor: colors,
            borderColor: borderColors,
            borderWidth: 1
        }]
    };

    await renderChart('chart-layout-single', 'bar', chartData, {
        yAxisLabel: '',
        plugins: { legend: { display: false } },
        onHover: (event, elements) => {
            if (!window.updateMapWithHighlightLcoe) return;
            const index = elements && elements.length > 0 ? elements[0].index : null;
            if (index === null || index === undefined) {
                window.updateMapWithHighlightLcoe(null);
                return;
            }
            window.updateMapWithHighlightLcoe(cumulativeLocationIds[index] || []);
        },
        scales: {
            x: { title: { display: true, text: 'LCOE ($/MWh)' }, ticks: { maxTicksLimit: 8 } },
            y: {
                title: { display: false },
                min: 0,
                max: 100,
                ticks: {
                    callback: (value) => `${value}%`
                }
            }
        }
    });

    container.classList.remove('hidden', 'chart-slide-out');
    container.classList.add('chart-slide-in');
    document.querySelector('.scrolly-visual')?.classList.add('with-chart');
}

export { ensureChartJsLoaded };
