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

export function formatFirmCfText(data) {
    const firmCf = Number.isFinite(data?.firm_cf) ? data.firm_cf : data?.annual_cf;
    const solarShareCf = Number.isFinite(data?.solar_share_cf) ? data.solar_share_cf : data?.annual_cf;
    if (!Number.isFinite(firmCf)) return '--';

    const firmPct = (firmCf * 100).toFixed(1);
    if (!data?.includeDieselBackup) {
        return `${firmPct}%`;
    }

    const solarPct = Number.isFinite(solarShareCf) ? (solarShareCf * 100).toFixed(1) : '--';
    return `${firmPct}% (${solarPct}% from solar)`;
}

export function buildDieselBackupLines(data, formatCurrency) {
    if (!data?.includeDieselBackup) return [];

    const lines = [];
    if (Number.isFinite(data.diesel_share_cf)) {
        lines.push(`<div class="text-slate-300">Backup diesel covers ${(data.diesel_share_cf * 100).toFixed(1)}% of annual energy.</div>`);
    }
    if (Number.isFinite(data.diesel_price_usd_per_liter)) {
        const yearNote = Number.isFinite(data.diesel_source_year) ? ` (${data.diesel_source_year})` : '';
        const sourceCountry = data.diesel_source_country_name || 'source country';
        const sourceKind = data.diesel_source_type === 'nearest_country'
            ? `nearest-country fallback from ${sourceCountry}`
            : `local source for ${sourceCountry}`;
        const distanceNote = data.diesel_source_type === 'nearest_country' && Number.isFinite(data.diesel_source_distance_km)
            ? `, ${data.diesel_source_distance_km.toFixed(0)} km`
            : '';
        lines.push(`<div class="text-slate-400">Diesel price: ${formatCurrency(data.diesel_price_usd_per_liter, 2)}/L${yearNote} • ${sourceKind}${distanceNote}</div>`);
    }
    if (Number.isFinite(data.diesel_lcoe_adder)) {
        lines.push(`<div class="text-slate-400">Diesel adds ${formatCurrency(data.diesel_lcoe_adder, 1)}/MWh to total LCOE.</div>`);
    }
    return lines;
}

/**
 * Build an LCOE tooltip
 */
export function buildLcoeTooltip(data, formatCurrency, formatNumber) {
    const valueLine = data.meetsTarget || data.includeDieselBackup
        ? `LCOE: ${Number.isFinite(data.lcoe) ? formatCurrency(data.lcoe) : '--'}/MWh`
        : `LCOE: ${Number.isFinite(data.maxConfigLcoe) ? `>${formatCurrency(data.maxConfigLcoe)}` : '--'}/MWh`;

    const lines = [
        `<div>CF ${formatFirmCfText(data)} | Solar ${data.solar_gw} MW_DC | Battery ${data.batt_gwh} MWh</div>`
    ];
    lines.push(...buildDieselBackupLines(data, formatCurrency));

    if (!data.meetsTarget) {
        if (data.includeDieselBackup) {
            lines.push(`<div class="text-amber-300">Target solar + battery CF not met; showing the highest-solar-share firm configuration.</div>`);
        } else {
            lines.push(`<div class="text-amber-300">Target CF for 1\u00a0MW baseload not met in this dataset.</div>`);
            lines.push(`<div>Highest config (${data.maxConfigSolar ?? '--'} MW_DC, ${data.maxConfigBatt ?? '--'} MWh)</div>`);
        }
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
