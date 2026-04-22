/**
 * Transitions Module for Scrollytelling
 * Handles smooth morphing between visual states
 */

// ========== TRANSITION CONFIG ==========
const TRANSITION_DURATION = 600; // ms
const CROSSFADE_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

// State tracking
let isTransitioning = false;
let transitionQueue = [];
let activeLayer = 'A';

// Color interpolation for smooth color transitions
function interpolateColor(color1, color2, t) {
    // Parse hex colors
    const c1 = parseColor(color1);
    const c2 = parseColor(color2);
    if (!c1 || !c2) return color2;

    const r = Math.round(c1.r + (c2.r - c1.r) * t);
    const g = Math.round(c1.g + (c2.g - c1.g) * t);
    const b = Math.round(c1.b + (c2.b - c1.b) * t);

    return `rgb(${r}, ${g}, ${b})`;
}

function parseColor(color) {
    if (!color) return null;

    // Handle hex
    if (color.startsWith('#')) {
        const hex = color.slice(1);
        if (hex.length === 3) {
            return {
                r: parseInt(hex[0] + hex[0], 16),
                g: parseInt(hex[1] + hex[1], 16),
                b: parseInt(hex[2] + hex[2], 16)
            };
        }
        if (hex.length === 6) {
            return {
                r: parseInt(hex.slice(0, 2), 16),
                g: parseInt(hex.slice(2, 4), 16),
                b: parseInt(hex.slice(4, 6), 16)
            };
        }
    }

    // Handle rgb()
    const rgbMatch = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (rgbMatch) {
        return {
            r: parseInt(rgbMatch[1]),
            g: parseInt(rgbMatch[2]),
            b: parseInt(rgbMatch[3])
        };
    }

    return null;
}

// ========== CROSSFADE SYSTEM ==========
class TransitionController {
    constructor() {
        this.mapContainer = null;
        this.overlayA = null;
        this.overlayB = null;
        this.chartContainer = null;
        this.initialized = false;

        // Concurrency control
        this.isProcessing = false;
        this.pendingStateRenderer = null;
    }

    init() {
        this.mapContainer = document.getElementById('map');
        if (!this.mapContainer) return;

        // Create overlay container for fade-to-black
        this.overlayA = this.createOverlay('transition-overlay-a');

        // Start in scroll-driven mode by default (slow scroll)
        this.overlayA.classList.add('scroll-driven');

        // Ensure overlay starts transparent
        this.overlayA.classList.remove('active');

        // Chart container
        this.chartContainer = document.getElementById('chart-container');

        this.initialized = true;
        console.log('Transition controller initialized');
    }

    createOverlay(id) {
        const existing = document.getElementById(id);
        if (existing) return existing;

        const overlay = document.createElement('div');
        overlay.id = id;
        overlay.className = 'transition-overlay';
        this.mapContainer.parentElement.appendChild(overlay);
        return overlay;
    }

    // Crossfade between two states
    // This implementation handles rapid calls by updating the pending state
    // and ensuring the transition loop processes the most recent one.
    // Crossfade between two states
    async crossfade(renderNextState) {
        if (!this.initialized) return renderNextState();

        // 1. Update the pending renderer to the latest request
        this.pendingStateRenderer = renderNextState;

        // 2. If already in a transition loop, let it pick up the new pending state
        if (this.isProcessing) {
            return;
        }

        // 3. Start the transition loop
        this.isProcessing = true;

        try {
            // No explicit fade-out wait here.
            // We assume the user is scrolling and the overlay is naturally black (or becoming black).
            // We focus on swapping the underlying map as fast as possible.

            while (this.pendingStateRenderer) {
                const currentRenderer = this.pendingStateRenderer;
                this.pendingStateRenderer = null; // Clear it, so we can detect if a NEW one comes in

                try {
                    // Render the state
                    await currentRenderer();
                } catch (err) {
                    console.error('Error during transition render:', err);
                }
            }

            this.isProcessing = false;

        } catch (e) {
            console.error('Transition failed:', e);
            this.isProcessing = false;
        }
    }

    // Slide chart in/out
    async showChart(show = true) {
        if (!this.chartContainer) {
            this.chartContainer = document.getElementById('chart-container');
        }
        if (!this.chartContainer) return;

        if (show) {
            this.chartContainer.classList.remove('hidden');
            this.chartContainer.classList.add('chart-slide-in');
            this.chartContainer.classList.remove('chart-slide-out');
        } else {
            this.chartContainer.classList.add('chart-slide-out');
            this.chartContainer.classList.remove('chart-slide-in');
            setTimeout(() => {
                this.chartContainer.classList.add('hidden');
            }, TRANSITION_DURATION);
        }
    }

    // Animate map to specific view
    async flyTo(lat, lng, zoom, duration = 1000) {
        return new Promise(resolve => {
            if (window.scrollyMap) {
                window.scrollyMap.flyTo([lat, lng], zoom, { duration: duration / 1000 });
                setTimeout(resolve, duration);
            } else {
                resolve();
            }
        });
    }
}

// ========== ANIMATION HELPERS ==========
function animateValue(from, to, duration, onUpdate, onComplete, easing = 'easeOutCubic') {
    const startTime = performance.now();

    const easings = {
        linear: t => t,
        easeOutCubic: t => 1 - Math.pow(1 - t, 3),
        easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2,
        easeOutExpo: t => t === 1 ? 1 : 1 - Math.pow(2, -10 * t)
    };

    const easeFn = easings[easing] || easings.easeOutCubic;

    function tick(currentTime) {
        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);
        const easedProgress = easeFn(progress);

        const currentValue = from + (to - from) * easedProgress;
        onUpdate(currentValue, easedProgress);

        if (progress < 1) {
            requestAnimationFrame(tick);
        } else if (onComplete) {
            onComplete();
        }
    }

    requestAnimationFrame(tick);
}

// Morph colors on existing elements
function morphColors(elements, getNewColor, duration = TRANSITION_DURATION) {
    if (!elements || elements.length === 0) return Promise.resolve();

    return new Promise(resolve => {
        const startColors = new Map();

        elements.forEach((el, i) => {
            const currentColor = el.getAttribute('fill') || el.style.fill;
            startColors.set(i, currentColor);
        });

        animateValue(0, 1, duration, (t) => {
            elements.forEach((el, i) => {
                const startColor = startColors.get(i);
                const endColor = getNewColor(el, i);
                const interpolated = interpolateColor(startColor, endColor, t);
                el.setAttribute('fill', interpolated);
            });
        }, resolve);
    });
}

// ========== EXPORT ==========
export const transitionController = new TransitionController();

export function initTransitions() {
    transitionController.init();
}

export {
    animateValue,
    morphColors,
    interpolateColor,
    TRANSITION_DURATION
};
