// perf-hud.js — debug-only on-screen performance HUD.
//
// PURPOSE: let a non-developer on a slow machine (Windows Chrome, Safari Mac)
// read and report the cost of the hot render paths without opening DevTools.
//
// INVISIBLE BY DEFAULT: this module is only ever imported when the page URL has
// the `?perf` (or `?perf=1`) query param — see the guarded dynamic import in
// app.js / scrolly.js. Normal users never fetch this file, never see the HUD,
// and the timing hooks in map.js / daynight.js are no-ops because the sink
// (window.__SBA_PERF__) is never installed. Importing this module is the single
// act that turns measurement on.
//
// Data source: the existing `[perf]` instrumentation. endMapPerf() in map.js and
// the render timers in daynight.js call window.__SBA_PERF__(label, {durationMs})
// when (and only when) it exists. We aggregate per label and show last/avg/max.

const stats = new Map(); // label -> { last, max, count, sum }
let rootEl = null;
let bodyEl = null;
let rafPending = false;

function fmt(n) {
    return Number.isFinite(n) ? n.toFixed(1) : '--';
}

// Coalesced DOM update: many render() calls can fire per second during sample
// playback, but the HUD itself must not become a source of jank. Repaint at most
// once per animation frame.
function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(paint);
}

function paint() {
    rafPending = false;
    if (!bodyEl) return;
    const rows = [];
    for (const [label, s] of stats) {
        const avg = s.count ? s.sum / s.count : 0;
        // Warn-colour the "last" cell when a single op blows past ~16ms (one
        // 60fps frame) so the dominant cost is obvious at a glance.
        const hot = s.last > 16 ? ' style="color:#fca5a5"' : '';
        rows.push(
            `<tr><td>${label}</td><td${hot}>${fmt(s.last)}</td>` +
            `<td>${fmt(avg)}</td><td>${fmt(s.max)}</td><td>${s.count}</td></tr>`
        );
    }
    bodyEl.innerHTML = rows.join('') || '<tr><td colspan="5">waiting for renders…</td></tr>';
}

// The sink. map.js / daynight.js call this; it never throws.
function record(label, data) {
    const ms = data && Number.isFinite(data.durationMs) ? data.durationMs : null;
    if (ms == null || !label) return;
    let s = stats.get(label);
    if (!s) { s = { last: 0, max: 0, count: 0, sum: 0 }; stats.set(label, s); }
    s.last = ms;
    if (ms > s.max) s.max = ms;
    s.count += 1;
    s.sum += ms;
    scheduleRender();
}

function shortBrowser() {
    const ua = navigator.userAgent || '';
    let m;
    if ((m = ua.match(/Edg\/(\d+)/))) return 'Edge ' + m[1];
    if ((m = ua.match(/Firefox\/(\d+)/))) return 'Firefox ' + m[1];
    // Chrome UA also contains "Safari", so test Chrome first.
    if ((m = ua.match(/Chrome\/(\d+)/))) return 'Chrome ' + m[1];
    if ((m = ua.match(/Version\/(\d+).*Safari/))) return 'Safari ' + m[1];
    return 'browser';
}

function summaryText() {
    const lines = [
        `SolarBatteryAtlas perf — ${shortBrowser()} · DPR ${window.devicePixelRatio || 1} · ` +
        `${window.innerWidth}x${window.innerHeight}`,
        'op\tlast\tavg\tmax\tn'
    ];
    for (const [label, s] of stats) {
        const avg = s.count ? s.sum / s.count : 0;
        lines.push(`${label}\t${fmt(s.last)}\t${fmt(avg)}\t${fmt(s.max)}\t${s.count}`);
    }
    return lines.join('\n');
}

function build() {
    if (rootEl) return;
    rootEl = document.createElement('div');
    rootEl.id = 'sba-perf-hud';
    // All styling is inline so this never touches the app's CSS files.
    Object.assign(rootEl.style, {
        position: 'fixed', left: '8px', bottom: '8px', zIndex: '100000',
        font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        color: '#e5e7eb', background: 'rgba(17,24,39,0.86)',
        border: '1px solid rgba(148,163,184,0.35)', borderRadius: '6px',
        padding: '6px 8px', maxWidth: '300px', pointerEvents: 'auto',
        boxShadow: '0 2px 10px rgba(0,0,0,0.4)', userSelect: 'none', cursor: 'move'
    });
    rootEl.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px">` +
        `<span style="font-weight:600;letter-spacing:.04em">PERF · ${shortBrowser()} · DPR ${window.devicePixelRatio || 1}</span>` +
        `<span><button type="button" data-act="copy" style="cursor:pointer;background:none;border:1px solid rgba(148,163,184,.4);color:#cbd5e1;border-radius:4px;padding:0 5px">copy</button> ` +
        `<button type="button" data-act="reset" style="cursor:pointer;background:none;border:1px solid rgba(148,163,184,.4);color:#cbd5e1;border-radius:4px;padding:0 5px">reset</button></span>` +
        `</div>` +
        `<table style="border-collapse:collapse;width:100%">` +
        `<thead><tr style="color:#94a3b8;text-align:right">` +
        `<th style="text-align:left;font-weight:500">op</th><th style="font-weight:500">last</th>` +
        `<th style="font-weight:500">avg</th><th style="font-weight:500">max</th><th style="font-weight:500">n</th></tr></thead>` +
        `<tbody></tbody></table>` +
        `<div style="margin-top:3px;color:#94a3b8">ms per op · red = &gt;16ms</div>`;
    bodyEl = rootEl.querySelector('tbody');
    rootEl.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'reset') { stats.clear(); paint(); }
        else if (act === 'copy' && navigator.clipboard) {
            navigator.clipboard.writeText(summaryText()).catch(() => {});
        }
    });
    // Numeric columns: align right via a tiny stylesheet scoped to this node.
    const style = document.createElement('style');
    style.textContent = '#sba-perf-hud td+td,#sba-perf-hud th+th{text-align:right;padding-left:8px}'
        + '#sba-perf-hud button{cursor:pointer}';
    rootEl.appendChild(style);
    document.body.appendChild(rootEl);

    // Draggable so a tester can park it off whatever control it's covering.
    let dragging = false, offX = 0, offY = 0;
    rootEl.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return; // let copy/reset work
        const r = rootEl.getBoundingClientRect();
        // Switch from bottom-anchored to top/left so dragging is absolute.
        rootEl.style.bottom = 'auto';
        rootEl.style.left = r.left + 'px';
        rootEl.style.top = r.top + 'px';
        offX = e.clientX - r.left;
        offY = e.clientY - r.top;
        dragging = true;
        try { rootEl.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
    });
    rootEl.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        rootEl.style.left = (e.clientX - offX) + 'px';
        rootEl.style.top = (e.clientY - offY) + 'px';
    });
    const endDrag = (e) => {
        dragging = false;
        try { rootEl.releasePointerCapture(e.pointerId); } catch (_) {}
    };
    rootEl.addEventListener('pointerup', endDrag);
    rootEl.addEventListener('pointercancel', endDrag);

    paint();
}

// Install on import: register the sink so the (already-loaded) timing hooks start
// reporting, and build the overlay. Guarded for the case body isn't ready yet.
window.__SBA_PERF__ = record;
if (document.body) build();
else window.addEventListener('DOMContentLoaded', build, { once: true });
