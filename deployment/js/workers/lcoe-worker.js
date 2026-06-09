const STATE = {
    rowsByLocation: new Map()
};

const BASE_LOAD_MW = 1000;
const DIESEL_THERMAL_KWH_PER_LITER = 10.0;
// Global unsubsidized diesel floor (crude + refining + delivery, pre-tax). Must match constants.js.
const DIESEL_PRICE_FLOOR_USD_PER_LITER = 0.80;
// 1 MWh_thermal = 3.412 MMBtu — used to convert wholesale gas ($/MMBtu) to OCGT fuel cost. Must match constants.js.
const MMBTU_PER_MWH = 3.412;

function capitalRecoveryFactor(rate, years) {
    if (!Number.isFinite(rate) || !Number.isFinite(years) || years <= 0) {
        return 0;
    }
    if (rate === 0) {
        return 1 / years;
    }
    const pow = Math.pow(1 + rate, years);
    const denominator = pow - 1;
    return denominator === 0 ? 0 : (rate * pow) / denominator;
}

// Level-equivalent annual multiplier for a stream growing at `growth`/yr over
// `years`, discounted at `rate`. Returns 1 when growth === 0. growth = +escalation
// for OPEX, growth = -degradation for an energy denominator. Mirrors utils.js.
function levelizedGrowthMultiplier(growth, rate, years) {
    if (!(years > 0)) return 0;
    const crf = capitalRecoveryFactor(rate, years);
    const ratio = (1 + growth) / (1 + rate);
    let pv;
    if (Math.abs(ratio - 1) < 1e-12) {
        pv = years / (1 + rate);
    } else {
        pv = (1 / (1 + growth)) * ratio * (1 - Math.pow(ratio, years)) / (1 - ratio);
    }
    return pv * crf;
}

function getLocalCapex(localCapexByLocation, locationId) {
    if (!localCapexByLocation) return null;
    return localCapexByLocation[String(locationId)] || localCapexByLocation[locationId] || null;
}

function getLocalWacc(waccByLocation, locationId) {
    if (!waccByLocation) return null;
    const value = waccByLocation[String(locationId)] ?? waccByLocation[locationId];
    return Number.isFinite(value) ? value : null;
}

function getDieselInfo(dieselByLocation, locationId) {
    if (!dieselByLocation) return null;
    return dieselByLocation[String(locationId)] || dieselByLocation[locationId] || null;
}

function getGasInfo(gasByLocation, locationId) {
    if (!gasByLocation) return null;
    return gasByLocation[String(locationId)] || gasByLocation[locationId] || null;
}

function clampCf(value) {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params) {
    if (params?.dieselPriceMode === 'global') {
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

// Resolve the wholesale gas price ($/MMBtu). Local mode uses the per-region IGU
// price; global mode applies a single user value. Availability is always gated by
// the per-region data (gasInfo.available) — regions with no gas market fall back to
// diesel even in global mode.
function computeEffectiveGasPriceUsdPerMmbtu(gasInfo, params) {
    if (params?.gasPriceMode === 'global') {
        const globalPrice = Number.isFinite(params?.gasPrice) ? params.gasPrice : null;
        return { rawPrice: globalPrice, effectivePrice: globalPrice };
    }
    const rawPrice = Number.isFinite(gasInfo?.rawPrice ?? gasInfo?.price)
        ? (gasInfo?.rawPrice ?? gasInfo?.price)
        : null;
    return { rawPrice, effectivePrice: rawPrice };
}

function computeGasFuelCostPerMwh(gasPriceUsdPerMmbtu, params) {
    const efficiency = Number.isFinite(params.gasEfficiency) && params.gasEfficiency > 0
        ? params.gasEfficiency
        : null;
    if (!Number.isFinite(gasPriceUsdPerMmbtu) || !efficiency) {
        return Infinity;
    }
    return (gasPriceUsdPerMmbtu * MMBTU_PER_MWH) / efficiency;
}

// Per-location constants. All rows in a location share these.
function precomputeLcoePerLocation(params, costMultipliers, localWacc, localCapex, dieselInfo, gasInfo) {
    const resolvedWacc = Number.isFinite(localWacc) ? localWacc : params.wacc;

    const ilr = Number.isFinite(params.ilr) && params.ilr > 0 ? params.ilr : 1;
    const solarCapexBase = Number.isFinite(localCapex?.solar)
        ? localCapex.solar
        : params.solarCapex * (costMultipliers?.solar || 1);
    const batteryCapexBase = Number.isFinite(localCapex?.battery)
        ? localCapex.battery
        : params.batteryCapex * (costMultipliers?.battery || 1);
    const solarCapexPerKw = solarCapexBase / ilr;

    const solarCrf = capitalRecoveryFactor(resolvedWacc, params.solarLife);
    const batteryCrf = capitalRecoveryFactor(resolvedWacc, params.batteryLife);

    // Escalating OPEX (level-equivalent) and PV degradation (applied to the energy denominator).
    const solarOpexEscalMult = levelizedGrowthMultiplier(params.solarOpexEscalationPct || 0, resolvedWacc, params.solarLife);
    const batteryOpexEscalMult = levelizedGrowthMultiplier(params.batteryOpexEscalationPct || 0, resolvedWacc, params.batteryLife);
    const energyDegradationMult = levelizedGrowthMultiplier(-(params.solarDegradationPct || 0), resolvedWacc, params.solarLife);

    // "Backup" is on/off; when on, each row picks the cheaper of diesel vs gas (OCGT).
    const includeDieselBackup = Boolean(params.includeDieselBackup);
    let dieselPricing = null;
    let dieselFuelCostPerMwh = 0;
    let dieselCapexAnnual = 0;
    let dieselContext = null;
    let gasAvailable = false;
    let gasPricing = null;
    let gasFuelCostPerMwh = Infinity;
    let gasCapexAnnual = 0;
    let gasContext = null;
    if (includeDieselBackup) {
        dieselPricing = computeEffectiveDieselPriceUsdPerLiter(dieselInfo, params);
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

        // Gas (OCGT) is only a candidate where a wholesale price exists for the region.
        gasAvailable = Boolean(gasInfo?.available);
        if (gasAvailable) {
            gasPricing = computeEffectiveGasPriceUsdPerMmbtu(gasInfo, params);
            gasFuelCostPerMwh = computeGasFuelCostPerMwh(gasPricing.effectivePrice, params);
            const gasCapex = BASE_LOAD_MW * 1000 * params.gasCapex;
            const gasCrf = capitalRecoveryFactor(resolvedWacc, params.gasLife);
            gasCapexAnnual = gasCapex * gasCrf;
            gasContext = {
                priceUsdPerMmbtu: gasPricing.effectivePrice,
                sourceIso3: gasInfo?.sourceIso3 ?? null,
                sourceCountry: gasInfo?.sourceCountry ?? null,
                sourceDistanceKm: gasInfo?.sourceDistanceKm ?? null
            };
        }
    }

    return {
        includeDieselBackup,
        solarCapexPerKw,
        batteryCapexBase,
        solarCrf,
        batteryCrf,
        solarOpexPct: params.solarOpexPct,
        batteryOpexPct: params.batteryOpexPct,
        solarOpexEscalMult,
        batteryOpexEscalMult,
        energyDegradationMult,
        dieselPricing,
        dieselFuelCostPerMwh,
        dieselCapexAnnual,
        dieselContext,
        gasAvailable,
        gasPricing,
        gasFuelCostPerMwh,
        gasCapexAnnual,
        gasContext
    };
}

function computeLcoeMetrics(row, pre) {
    const solarKw = Number.isFinite(row._solarKw) ? row._solarKw : row.solar_gw * 1_000_000;
    const batteryKwh = Number.isFinite(row._batteryKwh) ? row._batteryKwh : row.batt_gwh * 1_000_000;
    const solarShareCf = clampCf(row.annual_cf);
    const includeDieselBackup = pre.includeDieselBackup;
    const firmCf = includeDieselBackup ? 1 : solarShareCf;
    const backupShareCf = includeDieselBackup ? Math.max(0, 1 - solarShareCf) : 0;

    const solarCapex = pre.solarCapexPerKw * solarKw;
    const batteryCapex = pre.batteryCapexBase * batteryKwh;
    const solarAnnual = solarCapex * pre.solarCrf;
    const batteryAnnual = batteryCapex * pre.batteryCrf;
    const solarOpex = solarCapex * pre.solarOpexPct * pre.solarOpexEscalMult;
    const batteryOpex = batteryCapex * pre.batteryOpexPct * pre.batteryOpexEscalMult;

    let annualCost = solarAnnual + batteryAnnual + solarOpex + batteryOpex;
    let annualEnergyMwh = Number.isFinite(row._annualEnergyMwh)
        ? row._annualEnergyMwh
        : solarShareCf * 8760 * BASE_LOAD_MW;
    // PV degradation reduces the renewable energy denominator (backup-firmed case below overrides).
    annualEnergyMwh *= pre.energyDegradationMult;

    // Backup display/output fields. When backup is on we price BOTH diesel and gas
    // (where available) and keep the cheaper. diesel_* fields stay populated for the
    // tooltip; gas_* fields populate where a wholesale gas price exists.
    let backupFuel = null;
    let backupLcoeAdder = 0;
    let backupEnergyMwh = 0;
    let dieselPriceUsdPerLiter = null;
    let dieselSourceYear = null;
    let dieselSourceType = null;
    let dieselSourceDistanceKm = null;
    let dieselSourceCountryIso3 = null;
    let dieselSourceCountryName = null;
    let dieselSourceSeriesName = null;
    let gasAvailable = false;
    let gasPriceUsdPerMmbtu = null;
    let gasSourceCountryIso3 = null;
    let gasSourceCountryName = null;
    let gasSourceDistanceKm = null;

    const makeResult = (lcoe) => ({
        lcoe,
        annual_energy_mwh: annualEnergyMwh,
        firm_cf: firmCf,
        solar_share_cf: solarShareCf,
        diesel_share_cf: backupShareCf,
        backup_share_cf: backupShareCf,
        backup_fuel: backupFuel,
        backup_lcoe_adder: backupLcoeAdder,
        backup_energy_mwh: backupEnergyMwh,
        // diesel_lcoe_adder/diesel_energy_mwh mirror the chosen backup so existing
        // consumers (charts that read diesel_lcoe_adder) reflect the cheaper fuel.
        diesel_lcoe_adder: backupLcoeAdder,
        diesel_energy_mwh: backupEnergyMwh,
        diesel_price_usd_per_liter: dieselPriceUsdPerLiter,
        diesel_source_year: dieselSourceYear,
        diesel_source_type: dieselSourceType,
        diesel_source_distance_km: dieselSourceDistanceKm,
        diesel_source_country_iso3: dieselSourceCountryIso3,
        diesel_source_country_name: dieselSourceCountryName,
        diesel_source_series_name: dieselSourceSeriesName,
        gas_available: gasAvailable,
        gas_price_usd_per_mmbtu: gasPriceUsdPerMmbtu,
        gas_source_country_iso3: gasSourceCountryIso3,
        gas_source_country_name: gasSourceCountryName,
        gas_source_distance_km: gasSourceDistanceKm,
        includeDieselBackup
    });

    if (includeDieselBackup) {
        annualEnergyMwh = 8760 * BASE_LOAD_MW;
        backupEnergyMwh = backupShareCf * annualEnergyMwh;

        // Diesel candidate (available wherever a diesel price resolves).
        const dc = pre.dieselContext;
        dieselPriceUsdPerLiter = pre.dieselPricing ? pre.dieselPricing.effectivePrice : null;
        if (dc) {
            dieselSourceYear = dc.sourceYear;
            dieselSourceType = dc.sourceType;
            dieselSourceDistanceKm = dc.sourceDistanceKm;
            dieselSourceCountryIso3 = dc.sourceIso3;
            dieselSourceCountryName = dc.sourceCountry;
            dieselSourceSeriesName = dc.sourceSeriesName;
        }
        const dieselTotalAnnual = Number.isFinite(pre.dieselFuelCostPerMwh)
            ? pre.dieselCapexAnnual + backupEnergyMwh * pre.dieselFuelCostPerMwh
            : Infinity;

        // Gas (OCGT) candidate — only where a wholesale price exists for the region.
        gasAvailable = Boolean(pre.gasAvailable);
        let gasTotalAnnual = Infinity;
        if (gasAvailable && Number.isFinite(pre.gasFuelCostPerMwh)) {
            gasTotalAnnual = pre.gasCapexAnnual + backupEnergyMwh * pre.gasFuelCostPerMwh;
            const gc = pre.gasContext;
            if (gc) {
                gasPriceUsdPerMmbtu = gc.priceUsdPerMmbtu;
                gasSourceCountryIso3 = gc.sourceIso3;
                gasSourceCountryName = gc.sourceCountry;
                gasSourceDistanceKm = gc.sourceDistanceKm;
            }
        }

        // Pick the cheaper backup fuel for this configuration.
        let backupTotalAnnual;
        if (gasTotalAnnual < dieselTotalAnnual) {
            backupFuel = 'gas';
            backupTotalAnnual = gasTotalAnnual;
        } else {
            backupFuel = 'diesel';
            backupTotalAnnual = dieselTotalAnnual;
        }

        if (!Number.isFinite(backupTotalAnnual)) {
            backupLcoeAdder = Infinity;
            return makeResult(Infinity);
        }

        annualCost += backupTotalAnnual;
        backupLcoeAdder = annualEnergyMwh > 0 ? backupTotalAnnual / annualEnergyMwh : Infinity;
    }

    if (!Number.isFinite(annualEnergyMwh) || annualEnergyMwh <= 0) {
        return makeResult(Infinity);
    }

    return makeResult(annualCost / annualEnergyMwh);
}

function sortByLocationId(results) {
    results.sort((a, b) => {
        const aId = Number(a.location_id);
        const bId = Number(b.location_id);
        if (Number.isFinite(aId) && Number.isFinite(bId)) {
            return aId - bId;
        }
        return String(a.location_id).localeCompare(String(b.location_id));
    });
    return results;
}

function computeBestLcoe(payload) {
    const { targetCf, params, costMultipliers, waccByLocation, localCapexByLocation, dieselByLocation, gasByLocation } = payload;
    const cheapestFirm = Boolean(params.includeDieselBackup) && params.dieselBackupMode === 'cheapest-firm';
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        if (!rows.length) return;
        const configPayloads = [];
        let bestMeeting = null;
        let bestFallback = null;
        let maxSolar = -Infinity;
        let maxBatt = -Infinity;

        const localWacc = getLocalWacc(waccByLocation, locationId);
        const localCapex = getLocalCapex(localCapexByLocation, locationId);
        const dieselInfo = getDieselInfo(dieselByLocation, locationId);
        const gasInfo = getGasInfo(gasByLocation, locationId);
        const pre = precomputeLcoePerLocation(params, costMultipliers, localWacc, localCapex, dieselInfo, gasInfo);

        rows.forEach((row) => {
            const metrics = computeLcoeMetrics(row, pre);
            const entry = { ...row, ...metrics, targetCf };
            configPayloads.push(entry);

            const meetsFirmTarget = cheapestFirm ? true : (row.annual_cf >= targetCf);
            if (meetsFirmTarget) {
                if (!bestMeeting || metrics.lcoe < bestMeeting.lcoe) {
                    bestMeeting = entry;
                }
            }

            if (
                !bestFallback
                || row.annual_cf > bestFallback.annual_cf
                || (row.annual_cf === bestFallback.annual_cf && metrics.lcoe < bestFallback.lcoe)
            ) {
                bestFallback = entry;
            }

            if (row.solar_gw > maxSolar || (row.solar_gw === maxSolar && row.batt_gwh > maxBatt)) {
                maxSolar = row.solar_gw;
                maxBatt = row.batt_gwh;
            }
        });

        const highConfig = configPayloads.find((p) => p.solar_gw === maxSolar && p.batt_gwh === maxBatt)
            || configPayloads.reduce((best, p) => {
                if (!best) return p;
                if (p.solar_gw > best.solar_gw) return p;
                if (p.solar_gw === best.solar_gw && p.batt_gwh > best.batt_gwh) return p;
                return best;
            }, null);

        const chosen = bestMeeting
            ? { ...bestMeeting, meetsTarget: true }
            : bestFallback
                ? { ...bestFallback, meetsTarget: false }
                : null;

        if (chosen) {
            chosen.maxConfigSolar = highConfig?.solar_gw ?? null;
            chosen.maxConfigBatt = highConfig?.batt_gwh ?? null;
            chosen.maxConfigLcoe = highConfig?.lcoe ?? null;
            results.push(chosen);
        }
    });

    return sortByLocationId(results);
}

function computeCfAtTargetLcoe(payload) {
    const { targetLcoe, params, costMultipliers, waccByLocation, localCapexByLocation, dieselByLocation, gasByLocation } = payload;
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        if (!rows.length) return;
        let bestConfig = null;
        let bestFallback = null;

        const localWacc = getLocalWacc(waccByLocation, locationId);
        const localCapex = getLocalCapex(localCapexByLocation, locationId);
        const dieselInfo = getDieselInfo(dieselByLocation, locationId);
        const gasInfo = getGasInfo(gasByLocation, locationId);
        const pre = precomputeLcoePerLocation(params, costMultipliers, localWacc, localCapex, dieselInfo, gasInfo);

        rows.forEach((row) => {
            const metrics = computeLcoeMetrics(row, pre);
            const cf = Number.isFinite(metrics.firm_cf) ? metrics.firm_cf : row.annual_cf;
            const entry = { ...row, ...metrics, cf, targetLcoe };

            if (metrics.lcoe <= targetLcoe) {
                if (!bestConfig) {
                    bestConfig = entry;
                } else if (entry.cf > bestConfig.cf) {
                    bestConfig = entry;
                } else if (entry.cf === bestConfig.cf && entry.lcoe < bestConfig.lcoe) {
                    bestConfig = entry;
                }
            }

            if (!bestFallback || metrics.lcoe < bestFallback.lcoe) {
                bestFallback = entry;
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

    return sortByLocationId(results);
}

function initData(rows) {
    const next = new Map();
    for (const row of rows || []) {
        const locationId = row.location_id;
        if (!next.has(locationId)) {
            next.set(locationId, []);
        }
        next.get(locationId).push(row);
    }
    STATE.rowsByLocation = next;
}

self.onmessage = (event) => {
    const { type, requestId, payload } = event.data || {};
    try {
        if (type === 'INIT_DATA') {
            initData(payload?.rows || []);
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'INIT_DATA', ready: true } });
            return;
        }

        if (type === 'COMPUTE_BEST_LCOE') {
            const results = computeBestLcoe(payload || {});
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'COMPUTE_BEST_LCOE', results } });
            return;
        }

        if (type === 'COMPUTE_CF_AT_TARGET_LCOE') {
            const results = computeCfAtTargetLcoe(payload || {});
            self.postMessage({ type: 'RESULT', requestId, payload: { kind: 'COMPUTE_CF_AT_TARGET_LCOE', results } });
            return;
        }

        self.postMessage({
            type: 'ERROR',
            requestId,
            payload: { message: `Unknown message type: ${type}` }
        });
    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            requestId,
            payload: {
                message: error?.message || String(error),
                stack: error?.stack || null,
                kind: type || null
            }
        });
    }
};
