/**
 * Visual States Configuration
 * Defines the visual state for each article section
 */

export const visualStates = {
    // Hero / Default state
    'hero': {
        viewMode: 'capacity',
        solar: 6,
        battery: 20,
        legend: 'none',
        mapOptions: {
            showDots: false,
            enableTooltip: false,
            enableHoverSelect: false
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Introduction (subtle monochrome map)
    'introduction': {
        viewMode: 'capacity',
        solar: 6,
        battery: 20,
        legend: 'none',
        mapOptions: {
            showDots: false,
            enableTooltip: false,
            enableHoverSelect: false,
            colorOverride: '#6b7280',
            stroke: '#ffffff',
            strokeWidth: 0.8,
            fillOpacity: 0.45,
            fadeIn: {
                durationMs: 200,
                totalMs: 3000
            }
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Section 1: Baseload Solar is Widespread
    'widespread': {
        viewMode: 'capacity',
        solar: 6,
        battery: 20,
        legend: 'capacity',
        label: {
            title: 'Global Viability - Masdar Configuration',
            subtitle: '6 MW solar, 20 MWh battery'
        }
    },

    // Section 2: Solar Potential Map
    'potential-map': {
        viewMode: 'potential',
        level: 'level1',
        displayMode: 'multiple',
        legend: 'potential',
        label: {
            title: 'Solar Potential vs Demand',
            subtitle: 'Technical constraints • Multiple of today\u2019s demand'
        }
    },

    // Section 4: Batteries Make All the Difference (looping animation)
    'battery-capacity': {
        viewMode: 'capacity',
        solar: 6,
        battery: 24, // Final state
        legend: 'capacity',
        animation: {
            type: 'battery-loop',
            from: 0,
            to: 24,
            steps: [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24],
            duration: 13000, // 13s total (1s per step)
            easing: 'easeInOut',
            loop: true
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Section 3: Batteries Make the Sun Shine After Dark
    'battery-shadow': {
        viewMode: 'weekly-sample',
        location: 'UAE', // Representative location
        solar: 6,
        battery: 20,
        legend: 'weekly',
        label: {
            title: 'Weekly Time Series',
            subtitle: 'Solar generation + battery discharge'
        }
    },

    // Section 5: High-uptime solar is cheapest where people live
    'cheap-populous': {
        viewMode: 'lcoe',
        targetCf: 80,
        legend: 'lcoe',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Section 6: Cheap exactly where electricity access is weakest
    'cheap-access': {
        viewMode: 'no-access',
        baseLayer: 'access',
        overlayMode: 'none',
        targetCf: 80,
        legend: 'no-access-pop',
        showTargetCfSlider: true,
        accessMetric: 'no_access_pop',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: 'Population Without Electricity Access',
            subtitle: 'Red: Higher concentration of people without electricity access • Dark Grey: Universal access'
        }
    },

    // Section 7: Better Uptime Than Many Grids
    'better-uptime': {
        viewMode: 'uptime-comparison',
        solar: 6,
        battery: 20,
        legend: 'uptime',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: 'Global Grid Reliability',
            subtitle: 'Red: High failure rate • Grey: Higher uptime • Black/Dark: No data (likely high uptime)'
        }
    },

    // Section 8: Cheap Where New Capacity is Planned
    'planned-capacity': {
        viewMode: 'lcoe',
        targetCf: 80,
        overlayPlants: 'announced', // Announced + construction
        legend: 'lcoe',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: 'LCOE \u0026 Planned Capacity',
            subtitle: 'New fossil projects in high-potential regions'
        }
    },

    // Section 9: LCOE Outlook
    'lcoe-outlook': {
        viewMode: 'lcoe',
        targetCf: 80,
        legend: 'lcoe',
        label: {
            title: 'LCOE Outlook',
            subtitle: 'Costs decline to 2050'
        }
    },

    // Conclusion: The Path Forward
    'path-forward': {
        viewMode: 'capacity',
        solar: 6,
        battery: 20,
        interactive: true,
        legend: 'capacity',
        label: {
            title: 'Explore the Data',
            subtitle: 'Interactive mode'
        }
    }
};

/**
 * Get the visual state for a given section ID
 */
export function getVisualState(sectionId) {
    return visualStates[sectionId] || visualStates['hero'];
}

/**
 * Check if a transition involves a parameter animation
 */
export function hasAnimation(sectionId) {
    const state = visualStates[sectionId];
    return state && state.animation;
}

/**
 * Get animation configuration for a section
 */
export function getAnimation(sectionId) {
    const state = visualStates[sectionId];
    if (state && state.animation) {
        return state.animation;
    }
    return null;
}

/**
 * Easing functions for animations
 */
export const easings = {
    linear: t => t,
    easeIn: t => t * t,
    easeOut: t => t * (2 - t),
    easeInOut: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t
};

/**
 * Interpolate between two values with easing
 */
export function interpolate(from, to, progress, easing = 'linear') {
    const easingFn = easings[easing] || easings.linear;
    const easedProgress = easingFn(progress);
    return from + (to - from) * easedProgress;
}
