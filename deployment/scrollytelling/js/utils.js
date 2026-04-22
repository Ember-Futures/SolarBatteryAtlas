/**
 * Shared utility functions
 */

export function capitalizeWord(str = '') {
    if (!str) return '';
    return str.charAt(0).toUpperCase() + str.slice(1);
}

export function formatNumber(value, decimals = 0) {
    if (!Number.isFinite(value)) return '--';
    return value.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    });
}

export function formatCurrency(value, decimals = 0) {
    const num = formatNumber(value, decimals);
    return num === '--' ? '--' : `$${num}`;
}

export function coordKey(lat, lon) {
    return `${lat.toFixed(6)},${lon.toFixed(6)}`;
}

export function roundedKey(lat, lon, decimals = 4) {
    return `${lat.toFixed(decimals)},${lon.toFixed(decimals)}`;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
    const toRad = (deg) => deg * Math.PI / 180;
    const R = 6371; // Earth radius in km
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Capital Recovery Factor for annuity calculations
 */
export function capitalRecoveryFactor(rate, years) {
    if (years <= 0) return 0;
    if (rate === 0) return 1 / years;
    const pow = Math.pow(1 + rate, years);
    return (rate * pow) / (pow - 1);
}

/**
 * Generic toggle button UI updater
 * @param {NodeList} buttons - Button elements to update
 * @param {string} activeValue - The value to compare against
 * @param {string} dataAttr - The dataset attribute name (e.g., 'mode', 'overlay', 'base')
 */
export function updateToggleUI(buttons, activeValue, dataAttr = 'mode') {
    if (!buttons?.length) return;
    buttons.forEach(btn => {
        const isActive = btn.dataset[dataAttr] === activeValue;
        btn.classList.toggle('bg-gray-600', isActive);
        btn.classList.toggle('text-white', isActive);
        btn.classList.toggle('shadow-sm', isActive);
        btn.classList.toggle('text-gray-400', !isActive);
        btn.classList.toggle('hover:text-white', !isActive);
    });
}
