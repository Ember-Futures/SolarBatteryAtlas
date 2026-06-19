# Deployment & performance notes

This app is a fully static site (no backend). It runs slowly on weak machines
because of **client-side rendering**, not the server — so the performance work is
client-side optimization plus cheaper asset delivery. None of the changes below
alter the UI/UX.

## TL;DR

```bash
npm install          # one-time (adds esbuild, already used via vite)
npm run build        # minify CSS + JS into dist/  (deployment/ stays the source)
```

`dist/` is the deploy artifact: minified JS/CSS, all small data, everything except
the 2.3 GB `data/samples/` tree. Serve it from a Brotli + CDN host.

---

## Why move off GitHub Pages

| | GitHub Pages | Cloudflare Pages / Netlify |
|---|---|---|
| Brotli compression | ❌ gzip only | ✅ automatic |
| Global CDN edge cache | partial | ✅ |
| HTTP/2/3 | limited | ✅ |
| Published-site size limit | ~1 GB (the 2.3 GB samples don't fit) | app fits; samples go to object storage |
| Build step (minify) | none | ✅ runs `npm run build` |

The app ships ~700 KB of **unminified** JS today; `npm run build` cuts the JS+CSS
~57% before compression, and Brotli compounds that. Combined with a CDN, this is
the load-time win. (It does **not** fix interaction lag — that's the Voronoi
rendering, tracked separately as the Canvas migration.)

## The data split (important)

`data/samples/` is **2.3 GB across ~290 Parquet files** — too large for a Pages
deploy. `npm run build` deliberately **excludes** it from `dist/`. Everything else
in `data/` (~30 MB: `simulation_results_summary.parquet`, the voronoi CSVs,
`world.geojson`, `BlackMarble_2016_01deg.jpg`, `samples_light/`) ships with the
app, so the tool works as soon as you point the samples at a CDN.

1. Upload `deployment/data/samples/` to object storage with a public CDN origin:
   - **Cloudflare R2** (pairs with Pages, no egress fees) or **AWS S3 + CloudFront**.
   - Set long-cache headers there: `Cache-Control: public, max-age=31536000, immutable`
     (samples are immutable — keyed by solar/battery config).
   - Enable CORS for your app's origin (the app `fetch()`es them cross-origin).
2. Point the app at that origin via the `SAMPLES_BASE_URL` env var (below). The
   build injects `window.__SAMPLES_BASE_URL__` into the HTML — **no source edit**.
   Unset, the app uses the co-located `data/samples/` path (unchanged behavior).

There's also `SAMPLES_LIGHT_BASE_URL` for the scrollytelling `samples_light/`
framecache, but that's only 15 MB and fine to leave co-located.

---

## Option A — Cloudflare Pages (recommended; R2 keeps it one vendor)

1. Connect the repo in the Cloudflare dashboard → **Pages** → Create.
2. Build settings:
   - **Build command:** `npm run build`
   - **Output directory:** `dist`
3. Environment variables (Settings → Environment): set `SAMPLES_BASE_URL` to your
   R2 public origin, e.g. `https://samples.example.com/samples/` (trailing slash).
4. Deploy. `deployment/_headers` is copied into `dist/` and applied automatically.

## Option B — Netlify

`netlify.toml` (repo root) is already configured: `command = "npm run build"`,
`publish = "dist"`. Set `SAMPLES_BASE_URL` under **Site settings → Environment
variables** (or uncomment it in `netlify.toml`), then deploy.

## Staying on GitHub Pages (interim)

You can keep GitHub Pages short-term — you just won't get Brotli or the minified
build, and the full 2.3 GB samples must be served elsewhere (they exceed the
1 GB site limit). The runtime fixes (perf HUD, future Canvas work) are independent
of hosting and work either way.

---

## What's in the build

`scripts/build-dist.mjs`:
- Minifies every app `.js` and `.css` **per file** (esbuild `transform`, not a
  bundle), preserving filenames, ESM format, and `import` specifiers — so the
  `<link rel="modulepreload">` graph and dynamic `import()`s keep working
  byte-for-byte. Already-minified vendor libs (`apache-arrow.js`,
  `parquet_wasm.js`) are copied as-is.
- Copies all data except `data/samples/`.
- Injects `SAMPLES_BASE_URL` / `SAMPLES_LIGHT_BASE_URL` into HTML when those env
  vars are set.
- `--link-data` symlinks `dist/data/samples` → the source tree for local testing:
  `node scripts/build-dist.mjs --link-data`.

## Measuring performance (perf HUD)

Append `?perf=1` to any URL to show an on-screen HUD with per-operation render
costs (`render-voronoi`, `daynight-frame`, `daynight-reproject`). It's loaded only
on the `?perf` path — normal visitors never fetch it or see it. Use it on the slow
machines (Windows Chrome, Safari Mac) and hit **copy** to grab the numbers. Early
data shows `render-voronoi` (50–190 ms/render) dominates while day/night is
~0.1 ms/frame — i.e. the SVG map is the interaction-lag bottleneck.
