import { readParquet } from './parquet_wasm.js';

// Initialize WASM
let wasmModule = null;
const DIESEL_DATA_VERSION = '2026-04-22-retail';
const GAS_DATA_VERSION = '2026-06-09-igu2024';

async function initWasm() {
    if (wasmModule) return wasmModule;
    console.log("Initializing Parquet-Wasm...");
    const wasm = await import('./parquet_wasm.js');
    await wasm.default();
    wasmModule = wasm;
    console.log("Parquet-Wasm initialized.");
    return wasmModule;
}

export async function loadSummary() {
    // Start the parquet download immediately so it overlaps with the wasm
    // fetch + compile instead of serializing behind it. The no-op catch keeps
    // a fetch failure from surfacing as an unhandled rejection while the wasm
    // await is still in flight; the await below still rethrows it.
    const bufferPromise = fetch('data/simulation_results_summary.parquet')
        .then(response => response.arrayBuffer());
    bufferPromise.catch(() => {});
    const wasm = await initWasm();
    const buffer = await bufferPromise;
    try {
        const wasmTable = wasm.readParquet(new Uint8Array(buffer));
        const table = wasmTable.intoIPCStream();
        const { tableFromIPC } = await import('./apache-arrow.js');
        const arrowTable = tableFromIPC(table);
        const data = [];
        for (const row of arrowTable) {
            data.push(row.toJSON());
        }
        return data;
    } catch (e) {
        console.error("Error in loadSummary:", e);
        throw e;
    }
}

function parseCsv(text) {
    const rows = [];
    let row = [];
    let value = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        const next = text[i + 1];

        if (char === '"') {
            if (inQuotes && next === '"') {
                value += '"';
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }

        if (char === ',' && !inQuotes) {
            row.push(value);
            value = '';
            continue;
        }

        if ((char === '\n' || char === '\r') && !inQuotes) {
            if (char === '\r' && next === '\n') {
                i += 1;
            }
            row.push(value);
            if (row.some(cell => cell !== '')) {
                rows.push(row);
            }
            row = [];
            value = '';
            continue;
        }

        value += char;
    }

    if (value !== '' || row.length) {
        row.push(value);
        if (row.some(cell => cell !== '')) {
            rows.push(row);
        }
    }

    const [header, ...dataRows] = rows;
    if (!header) return [];

    return dataRows.map(parts => {
        const out = {};
        header.forEach((col, idx) => {
            out[col] = parts[idx] ?? '';
        });
        return out;
    });
}

function parseOptionalNumber(value) {
    if (value === '' || value === null || value === undefined) return null;
    const num = Number(value);
    return Number.isFinite(num) ? num : null;
}

export async function loadPopulationCsv() {
    const response = await fetch('data/voronoi_population_2020.csv');
    if (!response.ok) {
        throw new Error('Population CSV not found at data/voronoi_population_2020.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        population_2020: Number(row.population_2020)
    }));
}

export async function loadGemPlantsCsv() {
    const response = await fetch('data/gem_plants.csv');
    if (!response.ok) {
        throw new Error('GEM plants CSV not found at data/gem_plants.csv');
    }
    const rows = parseCsv(await response.text());
    return rows
        .map(row => ({
            plant_name: row.plant_name || '',
            country: row.country || '',
            fuel_group: (row.fuel_group || '').toLowerCase(),
            capacity_mw: Number(row.capacity_mw),
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            status: (row.status || 'existing').toLowerCase()
        }))
        .filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
}

export async function loadVoronoiGemCapacityCsv() {
    const response = await fetch('data/voronoi_gem_capacity.csv');
    if (!response.ok) {
        throw new Error('Voronoi fossil capacity CSV not found at data/voronoi_gem_capacity.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        coal_Announced: Number(row.coal_Announced) || 0,
        coal_Existing: Number(row.coal_Existing) || 0,
        oil_gas_Announced: Number(row.oil_gas_Announced) || 0,
        oil_gas_Existing: Number(row.oil_gas_Existing) || 0,
        bioenergy_Announced: Number(row.bioenergy_Announced) || 0,
        bioenergy_Existing: Number(row.bioenergy_Existing) || 0,
        nuclear_Announced: Number(row.nuclear_Announced) || 0,
        nuclear_Existing: Number(row.nuclear_Existing) || 0
    }));
}

export async function loadVoronoiWaccCsv() {
    const response = await fetch('data/voronoi_wacc.csv');
    if (!response.ok) {
        throw new Error('Voronoi WACC CSV not found at data/voronoi_wacc.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        wacc_iso3: row.wacc_iso3 || null,
        wacc_country: row.wacc_country || null,
        wacc_percent: Number(row.wacc_percent),
        wacc_year: row.wacc_year ? Number(row.wacc_year) : null,
        source: row.source || null,
        distance_km: Number(row.distance_km)
    }));
}

export async function loadVoronoiLocalCapexCsv() {
    const response = await fetch('data/voronoi_local_capex.csv');
    if (!response.ok) {
        throw new Error('Voronoi local capex CSV not found at data/voronoi_local_capex.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        region: row.region || null,
        region_method: row.region_method || null,
        capex_source: row.capex_source || null,
        solar_2024: Number(row.solar_2024),
        solar_2035: Number(row.solar_2035),
        solar_2050: Number(row.solar_2050),
        battery_2024: Number(row.battery_2024),
        battery_2035: Number(row.battery_2035),
        battery_2050: Number(row.battery_2050)
    }));
}

export async function loadVoronoiOverlappingCountriesCsv() {
    const response = await fetch('data/voronoi_overlapping_countries.csv');
    if (!response.ok) {
        throw new Error('Voronoi overlapping-countries CSV not found at data/voronoi_overlapping_countries.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        country_names: row.country_names ? row.country_names.split('|') : []
    }));
}

export async function loadVoronoiDieselCsv() {
    const response = await fetch(`data/voronoi_diesel_prices.csv?v=${DIESEL_DATA_VERSION}`);
    if (!response.ok) {
        throw new Error('Voronoi diesel CSV not found at data/voronoi_diesel_prices.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        diesel_2024_iso3: row.diesel_2024_iso3 || null,
        diesel_2024_country: row.diesel_2024_country || null,
        diesel_2024_usd_per_liter_avg: parseOptionalNumber(row.diesel_2024_usd_per_liter_avg),
        diesel_2024_months_observed: parseOptionalNumber(row.diesel_2024_months_observed),
        diesel_2024_series_name: row.diesel_2024_series_name || null,
        diesel_2024_selection_method: row.diesel_2024_selection_method || null,
        diesel_2025_usd_per_liter_avg: parseOptionalNumber(row.diesel_2025_usd_per_liter_avg),
        diesel_2025_iso3: row.diesel_2025_iso3 || null,
        diesel_2025_country: row.diesel_2025_country || null,
        diesel_2025_months_observed: parseOptionalNumber(row.diesel_2025_months_observed),
        diesel_2025_series_name: row.diesel_2025_series_name || null,
        diesel_2025_selection_method: row.diesel_2025_selection_method || null,
        diesel_2024_source: row.diesel_2024_source || null,
        diesel_2025_source: row.diesel_2025_source || null,
        diesel_2024_distance_km: parseOptionalNumber(row.diesel_2024_distance_km),
        diesel_2025_distance_km: parseOptionalNumber(row.diesel_2025_distance_km)
    }));
}

export async function loadVoronoiGasCsv() {
    const response = await fetch(`data/voronoi_gas_prices.csv?v=${GAS_DATA_VERSION}`);
    if (!response.ok) {
        throw new Error('Voronoi gas CSV not found at data/voronoi_gas_prices.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        country_iso3: row.country_iso3 || null,
        country_name: row.country_name || null,
        gas_2024_iso3: row.gas_2024_iso3 || null,
        gas_2024_country: row.gas_2024_country || null,
        gas_2024_usd_per_mmbtu: parseOptionalNumber(row.gas_2024_usd_per_mmbtu),
        gas_2024_source: row.gas_2024_source || null,
        gas_2024_distance_km: parseOptionalNumber(row.gas_2024_distance_km),
        gas_available: String(row.gas_available).trim().toLowerCase() === 'true'
    }));
}

export async function loadPvoutPotentialCsv() {
    const response = await fetch('data/voronoi_pvout_potential.csv');
    if (!response.ok) {
        throw new Error('PVOUT potential CSV not found at data/voronoi_pvout_potential.csv');
    }
    const rows = parseCsv(await response.text());
    return rows.map(row => ({
        location_id: Number(row.location_id),
        latitude: Number(row.latitude),
        longitude: Number(row.longitude),
        zone_area_km2: Number(row.zone_area_km2),
        pvout_level1_area_km2: Number(row.pvout_level1_area_km2),
        pvout_level1_data_area_km2: Number(row.pvout_level1_data_area_km2),
        pvout_level1_mean: Number(row.pvout_level1_mean),
        pvout_level1_twh_per_mw_km2: Number(row.pvout_level1_twh_per_mw_km2),
        pvout_level1_twh_y: Number(row.pvout_level1_twh_y),
        pvout_level2_area_km2: Number(row.pvout_level2_area_km2),
        pvout_level2_data_area_km2: Number(row.pvout_level2_data_area_km2),
        pvout_level2_mean: Number(row.pvout_level2_mean),
        pvout_level2_twh_per_mw_km2: Number(row.pvout_level2_twh_per_mw_km2),
        pvout_level2_twh_y: Number(row.pvout_level2_twh_y),
        assumed_mw_per_km2: Number(row.assumed_mw_per_km2),
        rooftop_area_km2: Number(row.rooftop_area_km2 || 0),
        rooftop_mw_per_km2: Number(row.rooftop_mw_per_km2 || 0),
        rooftop_twh_y: Number(row.rooftop_twh_y || 0),
        total_level1_twh_y: Number(row.total_level1_twh_y ?? row.pvout_level1_twh_y),
        total_level2_twh_y: Number(row.total_level2_twh_y ?? row.pvout_level2_twh_y)
    }));
}

class SampleTableWrapper {
    constructor(rows) {
        this.numRows = rows.length;
        this._seasonIndex = new Map();
        rows.forEach(row => {
            const key = typeof row.season === 'string' ? row.season.toLowerCase() : String(row.season || '');
            if (!this._seasonIndex.has(key)) {
                this._seasonIndex.set(key, []);
            }
            this._seasonIndex.get(key).push(row);
        });
        this._seasons = Array.from(this._seasonIndex.keys());
    }

    getSeasons() {
        return this._seasons;
    }

    getRowsForSeason(season) {
        if (!season) return [];
        const key = season.toString().toLowerCase();
        return this._seasonIndex.get(key) || [];
    }
}

async function readSampleArrowTable(solarGw, battGwh) {
    const wasm = await initWasm();

    const filename = `samples_s${solarGw}_b${battGwh}.parquet`;
    const response = await fetch(`data/samples/${filename}`);

    if (!response.ok) {
        throw new Error(`Sample file not found: ${filename}`);
    }

    const buffer = await response.arrayBuffer();
    const { tableFromIPC } = await import('./apache-arrow.js');

    const wasmTable = (wasm.readParquet || readParquet)(new Uint8Array(buffer));
    const table = wasmTable.intoIPCStream();
    return tableFromIPC(table);
}

function materializeSampleRows(arrowTable) {
    const rows = [];
    for (const row of arrowTable) {
        const json = row.toJSON();
        const season = typeof json.season === 'string' ? json.season.toLowerCase() : '';
        rows.push({ ...json, season });
    }
    return rows;
}

export async function loadSampleColumnar(solarGw, battGwh) {
    const arrowTable = await readSampleArrowTable(solarGw, battGwh);
    const rows = materializeSampleRows(arrowTable);
    return new SampleTableWrapper(rows);
}

export async function loadSample(solarGw, battGwh) {
    const wrapper = await loadSampleColumnar(solarGw, battGwh);
    const rows = [];
    wrapper.getSeasons().forEach(season => {
        rows.push(...wrapper.getRowsForSeason(season));
    });

    return rows;
}

export async function loadElectricityDemandData() {
    try {
        const response = await fetch('data/voronoi_electricity_demand.csv');
        const text = await response.text();
        return d3.csvParse(text, (d) => ({
            location_id: +d.location_id,
            latitude: +d.latitude,
            longitude: +d.longitude,
            annual_demand_kwh: +d.annual_demand_kwh
        }));
    } catch (e) {
        console.error("Error loading electricity demand data:", e);
        return [];
    }
}

export async function loadReliabilityCsv() {
    try {
        const response = await fetch('data/voronoi_grid_reliability.csv');
        const text = await response.text();
        return d3.csvParse(text, (d) => {
            // Columns: location_id,latitude,longitude,hrea_covered,pop_rel_0...pop_rel_95_100,pop_rel_100
            const row = {
                location_id: +d.location_id,
                latitude: +d.latitude,
                longitude: +d.longitude,
                hrea_covered: d.hrea_covered === 'True'
            };

            // Helper to sum population for weighted average calculation later
            let totalPop = 0;
            let weightedSum = 0;

            // Bin 0 (no access)
            const pop0 = +d.pop_rel_0 || 0;
            totalPop += pop0;
            // contributes 0 to weighted sum

            // Preserve bin-level data for detailed charts
            row.pop_bins = { 0: pop0 };

            // Bins 0-5 through 90-95 (i = 0, 5, 10, ..., 90)
            let connectedPop = 0;
            for (let i = 0; i < 95; i += 5) {
                const col = `pop_rel_${i}_${i + 5}`;
                const val = +d[col] || 0;
                const midpoint = (i + i + 5) / 2; // midpoint of the bin
                totalPop += val;
                connectedPop += val;
                weightedSum += val * midpoint;
                row.pop_bins[midpoint] = val;
            }

            // Bin 95-<100 (midpoint 97.5)
            const pop95_100 = +d.pop_rel_95_100 || 0;
            totalPop += pop95_100;
            connectedPop += pop95_100;
            weightedSum += pop95_100 * 97.5;
            row.pop_bins[97.5] = pop95_100;

            // Bin 100 (exactly 100% reliable)
            const pop100 = +d.pop_rel_100 || 0;
            totalPop += pop100;
            connectedPop += pop100;
            weightedSum += pop100 * 100;
            row.pop_bins[100] = pop100;

            // Original metric: includes pop0 as 0 reliability
            row.avg_reliability = totalPop > 0 ? weightedSum / totalPop : 0;

            // New metrics:
            // 1. Reliability for those with access
            row.avg_reliability_access_only = connectedPop > 0 ? weightedSum / connectedPop : 0;

            // 2. Percentage of population with NO access
            row.pct_no_access = totalPop > 0 ? pop0 / totalPop : 0;

            row.total_pop_reliability = totalPop;

            return row;
        });
    } catch (e) {
        console.error("Error loading reliability data:", e);
        return [];
    }
}
