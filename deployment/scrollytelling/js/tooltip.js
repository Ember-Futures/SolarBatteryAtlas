/**
 * Tooltip and popup utilities
 */

/**
 * Create a shared Leaflet popup with consistent styling
 */
export function createSharedPopup() {
    return L.popup({
        closeButton: false,
        autoPan: false,
        className: 'bg-transparent border-none shadow-none'
    });
}

/**
 * Build tooltip HTML content with consistent styling
 * @param {string} title - Main title text
 * @param {string[]} lines - Array of HTML line strings (falsy values filtered out)
 */
export function buildTooltipHtml(title, lines = []) {
    const linesHtml = lines.filter(Boolean).join('\n');
    return `<div class="bg-slate-900 text-white border border-slate-700 px-3 py-2 rounded text-xs max-w-xs">
        <div class="font-semibold">${title}</div>
        ${linesHtml}
    </div>`;
}

/**
 * Build a CF tooltip
 */
export function buildCfTooltip(cf, solarGw, battGwh) {
    const cfPct = (cf * 100).toFixed(1);
    return buildTooltipHtml(
        `Capacity factor ${cfPct}%`,
        [`<div class="text-slate-300">Share of the year a 1\u00a0MW baseload is met using ${solarGw} MW_DC solar + ${battGwh} MWh storage.</div>`]
    );
}

/**
 * Build an LCOE tooltip
 */
export function buildLcoeTooltip(data, formatCurrency, formatNumber) {
    const valueLine = data.meetsTarget
        ? `LCOE: ${data.lcoe ? formatCurrency(data.lcoe) : '--'}/MWh`
        : `LCOE: ${data.maxConfigLcoe ? `>${formatCurrency(data.maxConfigLcoe)}` : '--'}/MWh`;

    const lines = [
        `<div>CF ${(data.annual_cf * 100).toFixed(1)}% | Solar ${data.solar_gw} MW_DC | Battery ${data.batt_gwh} MWh</div>`
    ];

    if (!data.meetsTarget) {
        lines.push(`<div class="text-amber-300">Target CF for 1\u00a0MW baseload not met in this dataset.</div>`);
        lines.push(`<div>Highest config (${data.maxConfigSolar ?? '--'} MW_DC, ${data.maxConfigBatt ?? '--'} MWh)</div>`);
    }

    return buildTooltipHtml(valueLine, lines);
}

/**
 * Build a population tooltip
 */
export function buildPopulationTooltip(popVal, formatNumber, additionalLines = []) {
    return buildTooltipHtml(
        `Population: ${formatNumber(popVal, 0)}`,
        additionalLines
    );
}

/**
 * Build a plant tooltip
 */
export function buildPlantTooltip(plant, formatNumber, capitalizeWord) {
    const cap = formatNumber(plant.capacity_mw || 0, 0);
    return buildTooltipHtml(
        plant.plant_name || 'Power plant',
        [
            `<div>${(plant.fuel_group || '').toUpperCase()} • ${cap} MW</div>`,
            `<div class="text-slate-300">${capitalizeWord(plant.status || '')}</div>`,
            `<div class="text-slate-400">${plant.country || 'Unknown'}</div>`
        ]
    );
}
