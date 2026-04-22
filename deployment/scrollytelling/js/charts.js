
let charts = {};

const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const COLORS = {
    solar: 'rgba(251, 191, 36, 0.5)', // Amber 400
    solarBorder: 'rgba(251, 191, 36, 1)',
    battery: 'rgba(34, 211, 238, 0.5)', // Cyan 400
    batteryBorder: 'rgba(34, 211, 238, 1)',
    unserved: 'rgba(248, 113, 113, 0.5)', // Red 400
    unservedBorder: 'rgba(248, 113, 113, 1)',
    soc: 'rgba(16, 185, 129, 1)' // Emerald 500 (Line)
};

export function initCharts() {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.borderColor = '#1e293b';

    SEASONS.forEach(season => {
        const ctx = document.getElementById(`chart-${season}`).getContext('2d');

        charts[season] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: Array.from({ length: 72 }, (_, i) => i), // 0-71 hours
                datasets: []
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    title: {
                        display: true,
                        text: season.toUpperCase(),
                        color: '#e2e8f0',
                        font: { size: 12, weight: 'bold' }
                    },
                    legend: { display: false },
                    tooltip: {
                        mode: 'index',
                        intersect: false
                    }
                },
                scales: {
                    x: {
                        display: false // Hide x axis labels for cleanliness
                    },
                    y: {
                        stacked: true,
                        title: { display: true, text: 'MW' },
                        min: 0,
                        max: 10 // Fixed scale for consistency? Or dynamic? Let's try dynamic first.
                    },
                    y1: {
                        type: 'linear',
                        display: false, // Hide SoC axis, overlay it?
                        position: 'right',
                        min: 0,
                        max: 22 // Battery MWh
                    }
                },
                interaction: {
                    mode: 'nearest',
                    axis: 'x',
                    intersect: false
                }
            }
        });
    });
}

export function updateCharts(sampleData) {
    // sampleData is array of rows for one location
    // We need to find the row for each season

    SEASONS.forEach(season => {
        const data = sampleData.find(d => d.season === season);
        const chart = charts[season];

        if (!data) {
            // Clear chart if no data
            chart.data.datasets = [];
            chart.update();
            return;
        }

        // Data is in arrays: solar_gen, battery_flow, unserved, soc
        // We want to stack: Solar (used), Battery Discharge, Unserved
        // Wait, Solar Gen is total generation. 
        // We should show:
        // 1. Solar Generation (Line or Area)
        // 2. Battery Flow (Bar: +Discharge, -Charge)
        // 3. Unserved (Bar)

        // Better visualization for "Baseload":
        // Stacked Bar reaching 1.0 MW (Baseload):
        // - Solar Directly Used
        // - Battery Discharge
        // - Unserved Load
        // And separate line for Solar Generation (potential) and SoC.

        // Let's try:
        // Dataset 1 (Bar Stack 0): Solar Used = min(SolarGen, 1.0) - if we assume priority?
        // Actually, the simulation logic was:
        // Net Load = 1.0 - Solar.
        // If Net Load > 0 (Deficit): Discharge Battery.
        // If Net Load < 0 (Excess): Charge Battery.

        // So "Solar Used" = min(SolarGen, 1.0).
        // "Battery Discharge" = flow > 0 ? flow : 0.
        // "Unserved" = unserved.

        // These three should sum to 1.0 MW (approximately).

        const solarUsed = data.solar_gen.map(g => Math.min(g, 1.0));
        const battDischarge = data.battery_flow.map(f => f > 0 ? f : 0);
        // const battCharge = data.battery_flow.map(f => f < 0 ? -f : 0); // Show charge as negative?

        chart.data.datasets = [
            {
                type: 'bar',
                label: 'Solar Used',
                data: solarUsed,
                backgroundColor: COLORS.solar,
                borderColor: COLORS.solarBorder,
                borderWidth: 1,
                stack: 'stack0',
                order: 2
            },
            {
                type: 'bar',
                label: 'Battery Discharge',
                data: battDischarge,
                backgroundColor: COLORS.battery,
                borderColor: COLORS.batteryBorder,
                borderWidth: 1,
                stack: 'stack0',
                order: 2
            },
            {
                type: 'bar',
                label: 'Unserved',
                data: data.unserved,
                backgroundColor: COLORS.unserved,
                borderColor: COLORS.unservedBorder,
                borderWidth: 1,
                stack: 'stack0',
                order: 2
            },
            {
                type: 'line',
                label: 'Solar Potential',
                data: data.solar_gen,
                borderColor: '#fbbf24', // Amber
                borderDash: [5, 5],
                borderWidth: 1,
                pointRadius: 0,
                tension: 0.4,
                order: 1
            },
            {
                type: 'line',
                label: 'SoC (MWh)',
                data: data.soc,
                borderColor: COLORS.soc,
                borderWidth: 2,
                pointRadius: 0,
                tension: 0.4,
                yAxisID: 'y1', // Use right axis
                order: 0
            }
        ];

        // Update scales dynamically based on battery size
        // We don't know max battery size here easily without passing it, 
        // but we can infer from max SoC or just let it auto-scale.
        // Let's let y1 auto-scale.
        chart.options.scales.y1.display = true;

        chart.update();
    });

    // Show panel
    document.getElementById('charts-panel').classList.remove('translate-y-full');
}
