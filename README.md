# SolarMap2

This repo splits the experience into:

- `deployment/` — everything that gets deployed to GitHub Pages, including the interactive atlas and the scrollytelling story at `deployment/scrollytelling/`.
- `workspace/` — the pipeline scripts, source data, and caches used to regenerate `deployment/data`.

## What’s new in the Atlas

- **Capacity Factor, LCOE, and Transmission views** now pick the lowest-cost build per location, support reference comparisons, and keep legend scales locked when needed.
- **Population view** includes a “Map vs. Charts” toggle: Map mode overlays CF or LCOE on the population cells while Charts summarize the chosen metric by population percentile and latitude buckets. The charts also keep the sidebar controls and a metric selector in sync, and the helper copy clarifies how to keep tuning solar + storage.
- **Info panel** and helper text now explain the latest UX, datasets, and how to read the maps/charts.

## Typical workflow

1. Run the pipeline scripts under `workspace/scripts/pipeline` (they read from `workspace/input_data` and write generated outputs to `workspace/outputs`).
2. Inspect intermediate outputs in `workspace/output` or `workspace/data`.
3. Copy `deployment/` to the deployment repo and push to GitHub Pages.

Each pipeline module resolves file paths relative to the repo root, so `python workspace/pipeline/<script>.py` works without extra wiring.

## Data sources

- **Solar/weather inputs:** NASA/POWER Surface Meteorology and Solar Energy data (https://power.larc.nasa.gov) sampled per location, resampled to hourly baseload outputs, and stored as `workspace/data/solar_profiles.csv`.
- **Population totals:** NASA SEDAC Gridded Population of the World, Version 4 (GPWv4) 2020 raster (`workspace/data/gpw_v4_population_count_rev11_2020_2pt5_min.asc`), summed per Voronoi cell and exported alongside the front-end dataset `deployment/data/voronoi_population_2020.csv`.

## Pipeline overview

1. `pipeline/01_selectlocations.py` samples evenly spread land coordinates using Natural Earth land polygons.
2. `pipeline/voronoi_population.py` reprojects the sampled cells, intersects them with the GPWv4 raster, and exports summary CSVs.
3. `workspace/scripts/pipeline/run.py` reads `workspace/input_data/solar_profiles.csv`, simulates every solar (1–20 GW) and battery (0–36 GWh) pair against a 1 GW baseload using a 90% battery round-trip efficiency, and writes the summary Parquet plus sample shards to `workspace/outputs`.
4. `pipeline/fetch_power_plants.py` downloads the WRI Global Power Plant Database, filters it to coal/gas/oil units, and saves a Parquet snapshot to `workspace/data/global_power_plants_coal_gas_oil.parquet` for downstream analyses.
5. `pipeline/plot_power_plants.py` reads that Parquet and generates `workspace/data/global_power_plants_coal_gas_oil_map.png`, a bubble map where bubble size reflects installed MW.
6. `pipeline/voronoi_fossil_capacity.py` joins the filtered power plants with the Voronoi cells (each baseload location) and exports `workspace/data/voronoi_fossil_capacity.csv`, listing coal/gas/oil MW totals per Voronoi centroid.
7. `pipeline/voronoi_solar_potential_gee.py` computes rooftop + utility solar technical potential per Voronoi zone in Google Earth Engine and exports a CSV of TWh/year plus diagnostics (requires an EE asset for the zones).

Running `cd workspace && python3 -m scripts.pipeline.run --overwrite` rebuilds the atlas. Use `--sample N` to work with a reduced number of locations when testing.
