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
            fillOpacity: 0.45
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Section 1: The world does not lack sunlight
    'potential-map': {
        viewMode: 'potential',
        level: 'level1',
        displayMode: 'multiple',
        legend: 'potential',
        label: {
            title: 'Sunlight vs. demand',
            subtitle: 'Annual solar potential as a multiple of local demand'
        }
    },

    // Section 2: Batteries Make All the Difference
    // Scrubbable solar + battery with a Play button that sweeps through both. Default on
    // entry: battery 0, solar auto-playing (sweeps solar first, then fills in battery).
    'battery-capacity': {
        viewMode: 'capacity',
        solar: 1,
        battery: 0,
        legend: 'capacity',
        animation: {
            type: 'battery-capacity-autoplay'
        },
        label: {
            title: '',
            subtitle: ''
        }
    },

    // Section 3: Most solar variability is daily (weekly hourly profile)
    'battery-shadow': {
        viewMode: 'weekly-sample',
        location: 'UAE', // Representative location
        solar: 6,
        battery: 20,
        legend: 'weekly',
        label: {
            title: 'One week, hour by hour',
            subtitle: 'Yellow: solar used live. Purple: solar served back at night.'
        }
    },

    // Section 4: Cheap exactly where most people live
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

    // Section 5: Cheap where electricity is missing
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

    // Section 6: Beating many grids on uptime
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

    // Section 7: From 90-95% to 100% with cheap back-up
    'backup-cost': {
        viewMode: 'backup',
        sbTarget: 95, // default target solar + battery uptime (%); diesel fills the rest to 100%
        legend: 'lcoe',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: 'Cost of 100% Uptime',
            subtitle: 'Solar + battery + cheap least-cost (gas/diesel) back-up for the final gap'
        }
    },

    // Section 8: Planned fossil capacity is exposed
    'planned-capacity': {
        viewMode: 'lcoe',
        targetCf: 75,
        overlayPlants: 'announced', // Announced + construction
        legend: 'lcoe',
        mapView: {
            offsetRatioY: -0.12
        },
        label: {
            title: 'Where the next fossil plants are planned',
            subtitle: 'Planned coal & gas vs. the solar alternative'
        }
    },

    // Section 9: Falling costs (LCOE outlook to 2050)
    'lcoe-outlook': {
        viewMode: 'lcoe',
        targetCf: 75,
        legend: 'lcoe',
        label: {
            title: 'The cost curve to 2050',
            subtitle: 'Costs fall every year as the slider advances'
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
