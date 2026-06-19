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
        // Skip the giant data tree entirely (handled via --link-data).
        if (rel === 'data' || rel.startsWith('data/') || rel.startsWith('data' + '\\')) continue;
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
        } else {
            await copyFile(abs, destPath);
            copyCount++;
        }
    }
}

async function linkData() {
    const dest = join(OUT, 'data');
    try {
        const s = await lstat(dest).catch(() => null);
        if (s) return; // already present
        // Relative symlink so dist/data -> ../deployment/data resolves from dist/.
        await symlink(join('..', 'deployment', 'data'), dest, 'dir');
        console.log('· symlinked dist/data -> ../deployment/data (local verification)');
    } catch (err) {
        console.warn('· could not symlink data:', err.message);
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
    if (!LINK_DATA) console.log('· data/ excluded — deploy bulk samples via CDN, or rerun with --link-data to serve locally');
}

main().catch((err) => { console.error(err); process.exit(1); });
