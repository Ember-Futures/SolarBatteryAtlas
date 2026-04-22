/**
 * Shared constants
 */

export const ALL_FUELS = ['coal', 'oil_gas', 'bioenergy', 'nuclear'];

export const FUEL_COLORS = {
    coal: '#f97316',
    oil_gas: '#38bdf8',
    bioenergy: '#84cc16',
    nuclear: '#a855f7'
};

export const BASE_LOAD_MW = 1000;

export const TX_WACC = 0.06;
export const TX_LIFE = 50;

export const LCOE_NO_DATA_COLOR = '#611010';

export const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor Map shows what share of the year a given solar + storage build can sustain a 1\u00a0MW baseload.',
    samples: 'Hourly Profile Samples replay a representative 168-hour week so you can examine solar output, storage dispatch, and any unmet 1\u00a0MW demand.',
    lcoe: 'LCOE Map compares the levelized cost ($/MWh) of every location that can meet the target capacity factor.',
    population: 'Supply-Demand Matching links where people live (population density as a proxy for demand) with the CF or LCOE of each location.'
};

export const CF_COLOR_SCALE = {
    domain: [0, 0.4, 0.7, 0.9, 1.0],
    range: ["#0049ff", "#00c853", "#facc15", "#f97316", "#d32f2f"]
};

// Population color scale for map dots/voronoi
export const POPULATION_COLOR_SCALE = {
    domain: [0, 1000, 10000, 50000],
    range: ["rgba(59, 130, 246, 0.1)", "rgba(59, 130, 246, 0.4)", "#3b82f6", "#1e40af"]
};

// Color scale for Energy Access (0% to 100%)
// Red (low) -> Yellow -> Green (high)
export const ACCESS_COLOR_SCALE = {
    domain: [0, 50, 100],
    range: ["#ef4444", "#eab308", "#22c55e"]
};

export const POTENTIAL_MULTIPLE_BUCKETS = [
    { max: 1, label: '< 1×', color: '#F6C9C9' },
    { max: 3, label: '1–3×', color: '#F2A65A' },
    { max: 10, label: '3–10×', color: '#F2D96B' },
    { max: 100, label: '10–100×', color: '#CDEB6A' },
    { max: 1000, label: '100–1000×', color: '#6FC36A' },
    { max: null, label: '1000×+', color: '#1F7A4E' }
];

export const POTENTIAL_TOTAL_COLORS = [
    '#F6C9C9',
    '#F2D96B',
    '#CDEB6A',
    '#6FC36A',
    '#1F7A4E',
    '#14532d'
];

/**
 * Feature flags used for staged rollout of browser performance optimizations.
 *
 * Rollout order:
 * 1) config index (always-on helper, no flag)
 * 2) FEATURE_VORONOI_REUSE
 * 3) FEATURE_STAGED_PRELOAD (scrollytelling)
 * 4) FEATURE_WORKER_LCOE
 * 5) FEATURE_FRAMECACHE (scrollytelling)
 */
export const FEATURE_WORKER_LCOE = false;
export const FEATURE_STAGED_PRELOAD = true;
export const FEATURE_VORONOI_REUSE = true;
export const FEATURE_FRAMECACHE = false;
