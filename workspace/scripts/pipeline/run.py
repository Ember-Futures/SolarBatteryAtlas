
import argparse
import json
import pandas as pd
import multiprocessing
from pathlib import Path
from typing import List, Dict, Any
import time
import sys
import os
import re
import shutil
import pyarrow as pa
import pyarrow.parquet as pq

# Add project root to path to allow running as script
sys.path.append(str(Path(__file__).parent.parent))

try:
    from tqdm import tqdm
except ImportError:
    tqdm = None

# Use absolute imports now that root is in path
from scripts.pipeline.config import OUTPUTS_DIR
from scripts.pipeline.data_loader import load_solar_profiles
from scripts.pipeline.simulation import simulate_location

def run_pipeline(sample_n: int = None, output_name: str = "simulation_results", overwrite: bool = False):
    """
    Orchestrates the pipeline execution.
    """
    start_time = time.time()
    
    # 1. Load Data
    profiles = load_solar_profiles(sample_n=sample_n)
    
    if not profiles:
        print("No profiles loaded. Exiting.")
        return

    # 2. Prepare Output Directory
    OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)
    SAMPLES_DIR = OUTPUTS_DIR / "samples"
    SAMPLES_DIR.mkdir(parents=True, exist_ok=True)

    summary_parquet_path = OUTPUTS_DIR / f"{output_name}_summary.parquet"
    summary_csv_path = OUTPUTS_DIR / f"{output_name}_summary.csv"
    samples_json_path = OUTPUTS_DIR / f"{output_name}_samples.json"

    if overwrite:
        print("Overwrite enabled: removing existing generated summary and sample shards.")
        summary_parquet_path.unlink(missing_ok=True)
        summary_csv_path.unlink(missing_ok=True)
        samples_json_path.unlink(missing_ok=True)
        shutil.rmtree(SAMPLES_DIR, ignore_errors=True)
        SAMPLES_DIR.mkdir(parents=True, exist_ok=True)
    
    # Determine which sample shards already exist and are readable; skip corrupted shards
    existing_sample_configs = set()
    bad_shards = []
    for sample_path in SAMPLES_DIR.glob("samples_s*_b*.parquet"):
        match = re.search(r"samples_s(\d+)_b(\d+)", sample_path.stem)
        if not match:
            continue
        cfg_key = (int(match.group(1)), int(match.group(2)))
        try:
            pq.ParquetFile(sample_path)
            existing_sample_configs.add(cfg_key)
        except Exception as e:
            bad_shards.append((sample_path, str(e)))
    if existing_sample_configs:
        print(f"Skipping {len(existing_sample_configs)} sample config(s) with existing shards.")
    if bad_shards:
        print(f"Found {len(bad_shards)} unreadable shard(s); they will be regenerated.")
        for sample_path, err in bad_shards:
            try:
                sample_path.unlink(missing_ok=True)
            except Exception:
                pass
    
    # 3. Run Simulation (Parallel)
    profile_list = list(profiles.values())
    total_locs = len(profile_list)
    
    print(f"Starting simulation for {total_locs} locations...")
    available_cores = multiprocessing.cpu_count()
    # Keep a few cores free; cap to avoid thrash
    num_workers = max(1, min(8, available_cores - 1))
    if num_workers < available_cores:
        print(f"Detected {available_cores} cores, using {num_workers} workers to reduce overhead.")
    else:
        print(f"Using {num_workers} workers.")
    
    # Streaming writers
    summary_writer: pq.ParquetWriter | None = None
    summary_buffer: List[Dict[str, Any]] = []
    SUMMARY_FLUSH_ROWS = 20000

    sample_buffers: Dict[tuple, List[Dict[str, Any]]] = {}
    sample_writers: Dict[tuple, pq.ParquetWriter] = {}
    SAMPLE_FLUSH_ROWS = 400

    def flush_summary():
        nonlocal summary_writer, summary_buffer
        if not summary_buffer:
            return
        df = pd.DataFrame(summary_buffer)
        df["location_id"] = df["location_id"].astype("int32")
        df["latitude"] = df["latitude"].astype("float32")
        df["longitude"] = df["longitude"].astype("float32")
        df["solar_gw"] = df["solar_gw"].astype("int8")
        df["batt_gwh"] = df["batt_gwh"].astype("int8")
        df["annual_cf"] = df["annual_cf"].astype("float32")
        table = pa.Table.from_pandas(df, preserve_index=False)
        if summary_writer is None:
            summary_writer = pq.ParquetWriter(summary_parquet_path, table.schema, compression="snappy")
        summary_writer.write_table(table)
        summary_buffer.clear()

    def flush_sample_buffer(cfg_key):
        rows = sample_buffers.get(cfg_key)
        if not rows:
            return
        df = pd.DataFrame(rows)
        df["location_id"] = df["location_id"].astype("int32")
        df["season"] = df["season"].astype("category")
        table = pa.Table.from_pandas(df, preserve_index=False)
        writer = sample_writers.get(cfg_key)
        filename = f"samples_s{cfg_key[0]}_b{cfg_key[1]}.parquet"
        filepath = SAMPLES_DIR / filename
        if writer is None:
            sample_writers[cfg_key] = pq.ParquetWriter(filepath, table.schema, compression="snappy")
            writer = sample_writers[cfg_key]
        writer.write_table(table)
        rows.clear()
    
    # Larger chunks reduce IPC overhead; leave some tasks per child to avoid ballooning memory
    chunksize = max(4, total_locs // (num_workers * 6) or 1)
    with multiprocessing.Pool(processes=num_workers, maxtasksperchild=200) as pool:
        iterator = pool.imap_unordered(simulate_location, profile_list, chunksize=chunksize)
        
        if tqdm:
            iterator = tqdm(iterator, total=total_locs, unit="loc")
            
        for i, res in enumerate(iterator):
            loc_id = res["location_id"]
            lat = res["latitude"]
            lon = res["longitude"]
            
            for cfg in res["configs"]:
                s_gw = cfg["solar_gw"]
                b_gwh = cfg["batt_gwh"]
                cfg_key = (s_gw, b_gwh)
                
                # Add to summary
                summary_buffer.append({
                    "location_id": loc_id,
                    "latitude": lat,
                    "longitude": lon,
                    "solar_gw": s_gw,
                    "batt_gwh": b_gwh,
                    "annual_cf": round(cfg["annual_cf"], 4)
                })
                if len(summary_buffer) >= SUMMARY_FLUSH_ROWS:
                    flush_summary()
                
                # Process samples for this config
                # We want to flatten the season structure
                # samples = { "winter": { "timestamps": [...], ... }, ... }
                
                if cfg_key in existing_sample_configs:
                    continue
                if cfg_key not in sample_buffers:
                    sample_buffers[cfg_key] = []
                
                for season, data in cfg["samples"].items():
                    # data contains lists of length 72
                    # We can store this efficiently. 
                    # To make it parquet-friendly, we can either store arrays or explode it.
                    # Exploding 72 rows per season per location might be huge but is standard "tidy" data.
                    # Let's try to keep it compact. 
                    # Actually, parquet handles nested lists well, but for simple consumption (duckdb/wasm), 
                    # flat arrays or simple columns are best.
                    
                    # Let's store as flat rows for now, it's most compatible.
                    # But wait, 5000 locs * 90 configs * 4 seasons * 72 hours = 130 million rows.
                    # That is A LOT.
                    
                    # Optimization: Store as arrays in the cell?
                    # "solar_gen": [0.1, 0.2, ...]
                    # This reduces row count by 72x.
                    # Parquet supports this (List<Float>).
                    
                    # Let's do that. One row per location per season.
                    
                    # Quantize data
                    solar_gen = [round(x, 3) for x in data["solar_gen"]]
                    battery_flow = [round(x, 3) for x in data["battery_flow"]]
                    soc = [round(x, 3) for x in data["soc"]]
                    unserved = [round(x, 3) for x in data["unserved"]]
                    
                    sample_buffers[cfg_key].append({
                        "location_id": loc_id,
                        "season": season,
                        "timestamps": data["timestamps"], # Strings, so no quantization needed
                        "solar_gen": solar_gen,
                        "battery_flow": battery_flow,
                        "soc": soc,
                        "unserved": unserved
                    })
                    if len(sample_buffers[cfg_key]) >= SAMPLE_FLUSH_ROWS:
                        flush_sample_buffer(cfg_key)
            
            if not tqdm and ((i + 1) % 10 == 0 or (i + 1) == total_locs):
                percent = (i + 1) / total_locs * 100
                print(f"\rProgress: [{i + 1}/{total_locs}] {percent:.1f}%", end="")
                
    if not tqdm:
        print() 
                
    print("Finalizing summary output...")
    flush_summary()
    if summary_writer:
        summary_writer.close()
        summary_writer = None
        print(f"Saved summary to {summary_parquet_path}")
    else:
        print("No summary rows written.")

    print("Finalizing sample shards...")
    for cfg_key in list(sample_buffers.keys()):
        flush_sample_buffer(cfg_key)
    for writer in sample_writers.values():
        writer.close()
    print("Sample shards saved.")
    
    elapsed = time.time() - start_time
    print(f"Pipeline finished in {elapsed:.2f} seconds.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Baseload Solar Pipeline")
    parser.add_argument("--sample", type=int, help="Number of locations to sample (for testing)")
    parser.add_argument("--name", type=str, default="simulation_results", help="Output filename prefix")
    parser.add_argument("--overwrite", action="store_true", help="Replace existing summary and sample shard outputs")
    
    args = parser.parse_args()
    
    run_pipeline(sample_n=args.sample, output_name=args.name, overwrite=args.overwrite)
