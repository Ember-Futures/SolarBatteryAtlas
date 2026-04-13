
import pandas as pd
import numpy as np
from typing import Dict, Any
from .config import (
    BASELOAD_GW,
    BATTERY_CAPACITIES_GWH,
    BATTERY_ROUND_TRIP_EFFICIENCY,
    SAMPLE_DURATION_HOURS,
    SEASONS,
    SOLAR_CAPACITIES_GW,
)

try:
    from numba import njit
except ImportError:  # pragma: no cover - fallback for environments without numba
    njit = None


if njit is not None:
    @njit(cache=True)
    def _simulate_battery_dispatch(net_load, batt_gwh, charge_efficiency, discharge_efficiency):
        length = len(net_load)
        battery_flow = np.empty(length, dtype=np.float32)
        soc_trace = np.empty(length, dtype=np.float32)
        unserved_trace = np.empty(length, dtype=np.float32)

        current_soc = 0.0
        total_unserved = 0.0

        for idx in range(length):
            nl = float(net_load[idx])
            flow = 0.0
            unserved = 0.0

            if nl > 0.0:
                max_deliverable = current_soc * discharge_efficiency
                discharge = nl if nl < max_deliverable else max_deliverable
                flow = discharge
                if discharge_efficiency > 0.0:
                    current_soc -= discharge / discharge_efficiency
                if current_soc < 0.0 and current_soc > -1e-9:
                    current_soc = 0.0
                unserved = nl - discharge
            else:
                available_storage = batt_gwh - current_soc
                if available_storage < 0.0:
                    available_storage = 0.0
                max_charge_input = available_storage / charge_efficiency if charge_efficiency > 0.0 else 0.0
                excess = -nl
                charge = excess if excess < max_charge_input else max_charge_input
                flow = -charge
                current_soc += charge * charge_efficiency
                if current_soc > batt_gwh and current_soc < batt_gwh + 1e-9:
                    current_soc = batt_gwh

            total_unserved += unserved
            battery_flow[idx] = flow
            soc_trace[idx] = current_soc
            unserved_trace[idx] = unserved

        return total_unserved, battery_flow, soc_trace, unserved_trace
else:
    def _simulate_battery_dispatch(net_load, batt_gwh, charge_efficiency, discharge_efficiency):
        length = len(net_load)
        battery_flow = np.empty(length, dtype=np.float32)
        soc_trace = np.empty(length, dtype=np.float32)
        unserved_trace = np.empty(length, dtype=np.float32)

        current_soc = 0.0
        total_unserved = 0.0

        for idx in range(length):
            nl = float(net_load[idx])
            flow = 0.0
            unserved = 0.0

            if nl > 0.0:
                max_deliverable = current_soc * discharge_efficiency
                discharge = min(nl, max_deliverable)
                flow = discharge
                current_soc -= discharge / discharge_efficiency if discharge_efficiency > 0.0 else 0.0
                if current_soc < 0.0 and current_soc > -1e-9:
                    current_soc = 0.0
                unserved = nl - discharge
            else:
                available_storage = max(0.0, batt_gwh - current_soc)
                max_charge_input = available_storage / charge_efficiency if charge_efficiency > 0.0 else 0.0
                charge = min(-nl, max_charge_input)
                flow = -charge
                current_soc += charge * charge_efficiency
                if current_soc > batt_gwh and current_soc < batt_gwh + 1e-9:
                    current_soc = batt_gwh

            total_unserved += unserved
            battery_flow[idx] = flow
            soc_trace[idx] = current_soc
            unserved_trace[idx] = unserved

        return total_unserved, battery_flow, soc_trace, unserved_trace

def simulate_location(location_df: pd.DataFrame) -> Dict[str, Any]:
    """
    Runs the simulation for all configurations for a single location.
    """
    # Extract common data
    location_id = location_df["location_id"].iloc[0]
    latitude = location_df["latitude"].iloc[0]
    longitude = location_df["longitude"].iloc[0]
    
    # Solar profile (kWh per kW)
    # Convert to numpy array for speed
    solar_profile = location_df["kwh_per_kw"].to_numpy(dtype=np.float32, copy=False)
    timestamps = location_df["timestamp_utc"].values
    
    results = {
        "location_id": int(location_id),
        "latitude": float(latitude),
        "longitude": float(longitude),
        "configs": []
    }
    
    # Pre-calculate seasonal indices for sampling
    # We want 3 days (72 hours) starting from the 1st of the season months
    # Assuming the data is a full year and sorted.
    # We'll find the indices corresponding to the start dates.
    season_indices = {}
    # Convert timestamps to datetime objects if they are numpy datetime64
    ts_dt = pd.to_datetime(timestamps)
    
    for season_name, month in SEASONS.items():
        # Find the first index where month matches
        # This assumes the year is consistent. We take the first occurrence.
        # A more robust way is to look for specific dates, but let's assume standard year data.
        # We'll look for the first hour of the 1st day of the month.
        mask = (ts_dt.month == month) & (ts_dt.day == 1)
        indices = np.where(mask)[0]
        if len(indices) > 0:
            start_idx = indices[0]
            # Ensure we have enough data for the sample
            if start_idx + SAMPLE_DURATION_HOURS <= len(solar_profile):
                season_indices[season_name] = start_idx
            else:
                season_indices[season_name] = None
        else:
            season_indices[season_name] = None

    charge_efficiency = np.sqrt(BATTERY_ROUND_TRIP_EFFICIENCY)
    discharge_efficiency = np.sqrt(BATTERY_ROUND_TRIP_EFFICIENCY)

    sample_windows = {}
    timestamp_strings = np.array(pd.to_datetime(timestamps).strftime("%Y-%m-%d %H:%M:%S"))
    for season_name, start_idx in season_indices.items():
        if start_idx is None:
            continue
        end_idx = start_idx + SAMPLE_DURATION_HOURS
        sample_windows[season_name] = {
            "start": start_idx,
            "end": end_idx,
            "timestamps": timestamp_strings[start_idx:end_idx].tolist(),
        }

    # Iterate over all configurations
    for solar_gw in SOLAR_CAPACITIES_GW:
        # Calculate solar generation for this capacity
        solar_gen_gw = solar_profile * np.float32(solar_gw) # GW (since profile is kWh/kW = MWh/MW = GWh/GW per hour)
        
        # Net load before battery (positive = deficit, negative = excess)
        # Baseload is constant 1.0 GW
        net_load = BASELOAD_GW - solar_gen_gw
        
        for batt_gwh in BATTERY_CAPACITIES_GWH:
            # For large solar (>10 GW), only run batteries >16 GWh
            if solar_gw > 10 and batt_gwh <= 16:
                continue
            total_unserved, battery_flow, soc_trace, unserved_trace = _simulate_battery_dispatch(
                net_load,
                float(batt_gwh),
                float(charge_efficiency),
                float(discharge_efficiency),
            )

            samples = {}
            for season_name, window in sample_windows.items():
                start_idx = window["start"]
                end_idx = window["end"]
                samples[season_name] = {
                    "timestamps": window["timestamps"],
                    "solar_gen": solar_gen_gw[start_idx:end_idx].astype(float).tolist(),
                    "battery_flow": battery_flow[start_idx:end_idx].astype(float).tolist(),
                    "soc": soc_trace[start_idx:end_idx].astype(float).tolist(),
                    "unserved": unserved_trace[start_idx:end_idx].astype(float).tolist(),
                }
            
            # Calculate Annual CF
            # CF = Served Energy / Total Demand
            # Total Demand = 1 GW * 8760 h = 8760 GWh
            # Served = Total Demand - Total Unserved
            total_demand = len(net_load) * BASELOAD_GW
            served = total_demand - total_unserved
            cf = served / total_demand if total_demand > 0 else 0.0
            
            results["configs"].append({
                "solar_gw": solar_gw,
                "batt_gwh": batt_gwh,
                "annual_cf": float(cf),
                "samples": samples
            })
            
    return results
