/**
 * Superset of the inline Play-CDN configs previously embedded in
 * deployment/index.html, deployment/scrollytelling/index.html and the hub
 * index.html. The union only ADDS utility definitions (e.g. `accent` from
 * the Article, `solar`/`battery`/`input` from the tool), which is inert for
 * pages that never use those classes.
 *
 * Version pinned to 3.4.17 — the exact version cdn.tailwindcss.com served
 * when the static build replaced it (see the header comment it injected).
 *
 * Rebuild with: npm run build:css
 */
module.exports = {
    content: [
        './index.html',
        './deployment/index.html',
        './deployment/scrollytelling/index.html',
        // JS is included because popup/tooltip HTML templates carry literal
        // class="..." strings; the scanner extracts string tokens from any
        // file, and false positives only add unused (inert) rules.
        './deployment/js/**/*.js',
        './deployment/scrollytelling/js/**/*.js',
    ],
    theme: {
        extend: {
            fontFamily: {
                // SF Pro (Apple system font, à la Substack). Mirrors --font-sans
                // in deployment/css/style.css and scrollytelling/css/scrolly.css.
                sans: ['-apple-system', 'BlinkMacSystemFont', '"SF Pro Display"', '"SF Pro Text"', '"SF Pro"', '"Segoe UI"', 'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
            },
            colors: {
                surface: '#15181a',
                'surface-variant': '#1f2325',
                primary: '#f59e0b',
                'ember-hover': '#fbbf24',
                'on-surface': '#ECEFF5',
                outline: '#2a2f31',
                'bg-page': '#0b0d0c',
                muted: '#9aa19f',
                input: '#0f1213',
                accent: '#f59e0b',
                solar: '#f59e0b',
                battery: '#a855f7',
            },
        },
    },
};
