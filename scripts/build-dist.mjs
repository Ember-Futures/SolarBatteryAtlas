// build-dist.mjs — produce a minified, deploy-ready copy of deployment/ in dist/.
//
// WHY: the app ships its JS/CSS unminified today (~700 KB of readable source).
// This script minifies every JS and CSS file PER FILE — preserving each file's
// name, ES-module format, and import specifiers — so the existing
// <link rel="modulepreload"> graph and dynamic import() calls keep working
// byte-for-byte. We deliberately do NOT bundle: bundling would collapse the
// module graph and change load/caching behavior. Source in deployment/ stays the
// readable source of truth; dist/ is a throwaway build artifact (gitignored).
//
// DATA: the 2.3 GB data/ tree is NOT copied (far too large to duplicate per
// build). For a real deploy the bulk samples belong on a CDN / object store; for
// local verification, run with --link-data to symlink dist/data -> deployment/data.
//
// USAGE:
//   node scripts/build-dist.mjs            # build dist/ (no data)
//   node scripts/build-dist.mjs --link-data  # also symlink data for local serving

import { transform } from 'esbuild';
import {
    rm, mkdir, readdir, readFile, writeFile, copyFile, stat, symlink, lstat
} from 'node:fs/promises';
import { dirname, join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, 'deployment');
const OUT = join(ROOT, 'dist');
const LINK_DATA = process.argv.includes('--link-data');

// Optional samples-CDN config injected into <head> of each HTML file. Set these
// env vars on the deploy host to serve the bulk samples off a CDN origin without
// editing any source. Unset → nothing injected, default co-located paths used.
const INJECT = [];
if (process.env.SAMPLES_BASE_URL) {
    INJECT.push(`window.__SAMPLES_BASE_URL__=${JSON.stringify(process.env.SAMPLES_BASE_URL)};`);
}
if (process.env.SAMPLES_LIGHT_BASE_URL) {
    INJECT.push(`window.__SAMPLES_LIGHT_BASE_URL__=${JSON.stringify(process.env.SAMPLES_LIGHT_BASE_URL)};`);
}

// Already-minified or generated vendor files: copy as-is (re-minifying wastes time
// and risks touching wasm-bindgen glue). Everything else .js gets minified.
const SKIP_MINIFY = new Set(['apache-arrow.js', 'parquet_wasm.js']);

let jsCount = 0, cssCount = 0, copyCount = 0;
let srcBytes = 0, outBytes = 0;

async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
        // Skip dotfiles/dot-dirs (.DS_Store, .claude, etc.) — never deployable.
        if (e.name.startsWith('.')) continue;
        const abs = join(dir, e.name);
        const rel = relative(SRC, abs);
        // Skip ONLY the 2.3 GB hourly samples (data/samples) — the CDN-offload
        // candidate. The rest of data/ (~30 MB: the critical-path summary parquet,
        // voronoi CSVs, world.geojson, city-lights, samples_light) is small and
        // ships with the app so it works out of the box on the new host.
        if (rel === 'data/samples' || rel.startsWith('data/samples/') || rel.startsWith('data/samples\\')) continue;
        if (e.isDirectory()) {
            await walk(abs);
            continue;
        }
        const destPath = join(OUT, rel);
        await mkdir(dirname(destPath), { recursive: true });
        const ext = extname(e.name).toLowerCase();
        if (ext === '.js' && !SKIP_MINIFY.has(e.name)) {
            const code = await readFile(abs, 'utf8');
            const res = await transform(code, {
                minify: true,
                // Per-file transform (NOT bundle): import/export statements and their
                // specifiers are preserved verbatim, so cross-file imports by name and
                // the modulepreload graph keep resolving exactly as before.
                loader: 'js',
                format: 'esm',
                legalComments: 'none',
            });
            await writeFile(destPath, res.code);
            jsCount++;
            srcBytes += Buffer.byteLength(code);
            outBytes += Buffer.byteLength(res.code);
        } else if (ext === '.css') {
            const code = await readFile(abs, 'utf8');
            const res = await transform(code, { minify: true, loader: 'css', legalComments: 'none' });
            await writeFile(destPath, res.code);
            cssCount++;
            srcBytes += Buffer.byteLength(code);
            outBytes += Buffer.byteLength(res.code);
        } else if (ext === '.html' && INJECT.length) {
            // Make the samples-CDN migration a one-env-var change: inject the runtime
            // override globals into <head> so the committed HTML stays clean. With no
            // env set, INJECT is empty and HTML is copied untouched (invisible default).
            let html = await readFile(abs, 'utf8');
            const tag = `<script>${INJECT.join('')}</script>`;
            html = html.includes('</head>') ? html.replace('</head>', tag + '</head>') : tag + html;
            await writeFile(destPath, html);
            copyCount++;
        } else {
            await copyFile(abs, destPath);
            copyCount++;
        }
    }
}

async function linkData() {
    // Only data/samples is excluded from the build; symlink just that subtree so
    // the local server can load samples without copying 2.3 GB.
    const dest = join(OUT, 'data', 'samples');
    try {
        const s = await lstat(dest).catch(() => null);
        if (s) return; // already present
        await mkdir(dirname(dest), { recursive: true });
        // Relative symlink: dist/data/samples -> ../../deployment/data/samples.
        await symlink(join('..', '..', 'deployment', 'data', 'samples'), dest, 'dir');
        console.log('· symlinked dist/data/samples -> ../../deployment/data/samples (local verification)');
    } catch (err) {
        console.warn('· could not symlink samples:', err.message);
    }
}

async function main() {
    const t0 = Date.now();
    await rm(OUT, { recursive: true, force: true });
    await mkdir(OUT, { recursive: true });
    await walk(SRC);
    if (LINK_DATA) await linkData();
    const pct = srcBytes ? Math.round((1 - outBytes / srcBytes) * 100) : 0;
    console.log(
        `\nbuilt dist/ in ${Date.now() - t0}ms — ` +
        `minified ${jsCount} JS + ${cssCount} CSS, copied ${copyCount} files\n` +
        `minified bytes: ${(srcBytes / 1024).toFixed(0)} KB -> ${(outBytes / 1024).toFixed(0)} KB ` +
        `(${pct}% smaller, before gzip/brotli)`
    );
    if (!LINK_DATA) console.log('· data/samples excluded — deploy the 2.3 GB samples via CDN (set window.__SAMPLES_BASE_URL__), or rerun with --link-data to serve them locally');
}

main().catch((err) => { console.error(err); process.exit(1); });
