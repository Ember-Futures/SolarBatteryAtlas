const STATE = {
    rowsByLocation: new Map()
};

function capitalRecoveryFactor(rate, years) {
    if (!Number.isFinite(rate) || !Number.isFinite(years) || years <= 0) {
        return 0;
    }
    if (rate === 0) {
        return 1 / years;
    }
    const numerator = rate * Math.pow(1 + rate, years);
    const denominator = Math.pow(1 + rate, years) - 1;
    return denominator === 0 ? 0 : numerator / denominator;
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

function computeLcoe(row, params, multipliers, localCapex, localWacc) {
    const solarCapex = Number.isFinite(localCapex?.solar)
        ? localCapex.solar
        : params.solarCapex * (multipliers?.solar || 1);
    const batteryCapex = Number.isFinite(localCapex?.battery)
        ? localCapex.battery
        : params.batteryCapex * (multipliers?.battery || 1);
    const wacc = Number.isFinite(localWacc) ? localWacc : params.wacc;

    const solarKw = row.solar_gw * 1000;
    const batteryKwh = row.batt_gwh * 1000;

    const solarCapexTotal = solarKw * solarCapex;
    const batteryCapexTotal = batteryKwh * batteryCapex;

    const solarCrf = capitalRecoveryFactor(wacc, params.solarLife);
    const batteryCrf = capitalRecoveryFactor(wacc, params.batteryLife);
    const annualSolarCost = solarCapexTotal * solarCrf + solarCapexTotal * params.solarOpexPct;
    const annualBatteryCost = batteryCapexTotal * batteryCrf + batteryCapexTotal * params.batteryOpexPct;

    const annualMwh = row.annual_cf * 8760;
    if (!Number.isFinite(annualMwh) || annualMwh <= 0) {
        return Infinity;
    }

    return (annualSolarCost + annualBatteryCost) / annualMwh;
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
    const { targetCf, params, multipliers, waccByLocation, localCapexByLocation } = payload;
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        let bestConfig = null;
        let minLcoe = Infinity;

        const localCapex = getLocalCapex(localCapexByLocation, locationId);
        const localWacc = getLocalWacc(waccByLocation, locationId);

        rows.forEach((row) => {
            if (row.annual_cf >= targetCf && row.solar_gw <= 10) {
                const lcoe = computeLcoe(row, params, multipliers, localCapex, localWacc);
                if (lcoe < minLcoe) {
                    minLcoe = lcoe;
                    bestConfig = { ...row, lcoe, meetsTarget: true };
                }
            }
        });

        if (bestConfig) {
            results.push(bestConfig);
        } else {
            const maxCfRow = rows.reduce((a, b) => (a.annual_cf > b.annual_cf ? a : b));
            const lcoe = computeLcoe(maxCfRow, params, multipliers, localCapex, localWacc);
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

    return sortByLocationId(results);
}

function computeCfAtTargetLcoe(payload) {
    const { targetLcoe, params, multipliers, waccByLocation, localCapexByLocation } = payload;
    const results = [];

    STATE.rowsByLocation.forEach((rows, locationId) => {
        let bestConfig = null;
        let bestFallback = null;

        const localCapex = getLocalCapex(localCapexByLocation, locationId);
        const localWacc = getLocalWacc(waccByLocation, locationId);

        rows.forEach((row) => {
            const lcoe = computeLcoe(row, params, multipliers, localCapex, localWacc);
            const entry = { ...row, lcoe, cf: row.annual_cf, targetLcoe };

            if (lcoe <= targetLcoe) {
                if (!bestConfig || entry.cf > bestConfig.cf || (entry.cf === bestConfig.cf && entry.lcoe < bestConfig.lcoe)) {
                    bestConfig = entry;
                }
            }

            if (!bestFallback || lcoe < bestFallback.lcoe) {
                bestFallback = entry;
            }
        });

        if (bestConfig) {
            results.push({ ...bestConfig, meetsTarget: true });
        } else if (bestFallback) {
            results.push({ ...bestFallback, meetsTarget: false });
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
