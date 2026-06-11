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
export const DIESEL_THERMAL_KWH_PER_LITER = 10.0;
// Global unsubsidized diesel floor (~crude + refining + delivery, pre-tax).
// Clamps heavily-subsidized pump prices (Venezuela, Iran, Algeria) up to the
// true economic cost a genset operator would face.
export const DIESEL_PRICE_FLOOR_USD_PER_LITER = 0.80;
// 1 MWh_thermal = 3.412 MMBtu. Converts a wholesale gas price ($/MMBtu) into an
// OCGT fuel cost: $/MWh_elec = price_per_MMBtu * MMBTU_PER_MWH / efficiency.
export const MMBTU_PER_MWH = 3.412;

export const TX_WACC = 0.06;
export const TX_LIFE = 50;

export const LCOE_NO_DATA_COLOR = '#611010';

export const VIEW_MODE_EXPLANATIONS = {
    capacity: 'Capacity Factor Map shows what share of the year a given solar + storage build can sustain a 1\u00a0MW baseload.',
    samples: 'Hourly Profile Samples replay a representative 168-hour week so you can examine solar output, storage dispatch, and any unmet 1\u00a0MW demand.',
    potential: 'Potential Map shows the annual PVOUT potential (TWh/yr) per Voronoi zone. “Technical” excludes rugged terrain, urban/industrial areas, forests, and remote zones; “Policy” adds regulatory limits such as cropland protection and conservation.',
    lcoe: 'LCOE Map compares the levelized cost ($/MWh) of every location that can meet the target capacity factor.',
    population: 'Supply-Demand Matching links where people live (population density as a proxy for demand) with the CF or LCOE of each location.'
};

export const CF_COLOR_SCALE = {
    domain: [0, 0.05, 0.4, 0.7, 1.0],
    range: ["#0049ff", "#0049ff", "#00c853", "#ff9800", "#d32f2f"]
};

// Color scale for Energy Access (0% to 100%)
// Red (low) -> Yellow -> Green (high)
export const ACCESS_COLOR_SCALE = {
    domain: [0, 50, 100],
    range: ["#ef4444", "#eab308", "#22c55e"]
};

export const POTENTIAL_MULTIPLE_BUCKETS = [
    { max: 1,    label: '< 1×',        color: "#F6C9C9" }, // light red
    { max: 3,    label: '1–3×',        color: "#F2A65A" }, // orange
    { max: 10,   label: '3–10×',       color: "#F2D96B" }, // yellow
    { max: 100,  label: '10–100×',     color: "#CDEB6A" }, // yellow-green
    { max: 1000, label: '100–1000×',   color: "#6FC36A" }, // distinct green
    { max: null, label: '1000×+',      color: "#1F7A4E" }  // deep green
];


// Annual solar generation potential per person (ground + rooftop), MWh/person/yr.
// Log-decade buckets: the metric spans < 1 to ~11 million MWh/cap across zones
// (median ~1,260), so a linear scale is useless. Same red→green ramp as the
// multiple buckets: red = little potential per person, green = abundant.
export const POTENTIAL_PER_CAPITA_BUCKETS = [
    { max: 10,     label: '< 10',           color: "#F6C9C9" }, // light red
    { max: 100,    label: '10–100',         color: "#F2A65A" }, // orange
    { max: 1000,   label: '100–1,000',      color: "#F2D96B" }, // yellow
    { max: 10000,  label: '1,000–10,000',   color: "#CDEB6A" }, // yellow-green
    { max: 100000, label: '10,000–100,000', color: "#6FC36A" }, // distinct green
    { max: null,   label: '100,000+',       color: "#1F7A4E" }  // deep green
];

export const POTENTIAL_TOTAL_COLORS = [
    '#f0fdf4',
    '#bbf7d0',
    '#4ade80',
    '#22c55e',
    '#15803d',
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
 * 6) FEATURE_VORONOI_GEOM_CACHE (skip Delaunay/path rebuilds when the
 *    viewport and point set are unchanged; recolor-only fast path)
 */
export const FEATURE_WORKER_LCOE = true;
export const FEATURE_STAGED_PRELOAD = true;
export const FEATURE_VORONOI_REUSE = true;
export const FEATURE_FRAMECACHE = false;
export const FEATURE_VORONOI_GEOM_CACHE = true;
