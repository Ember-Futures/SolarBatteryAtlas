
from pathlib import Path

WORKSPACE_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = WORKSPACE_DIR.parent
FRONTEND_DOCS_DIR = REPO_ROOT / "frontend" / "docs"

# Paths
# Paths
INPUTS_DIR = WORKSPACE_DIR / "input_data"
OUTPUTS_DIR = WORKSPACE_DIR / "outputs"

# Legacy alias (deprecated, prefer specific dir)
DATA_DIR = INPUTS_DIR

CACHE_DIR = INPUTS_DIR / "cache"
DOCS_DATA_DIR = FRONTEND_DOCS_DIR / "data"

SOLAR_PROFILES_PATH = INPUTS_DIR / "solar_profiles.csv"

# Simulation Parameters
BASELOAD_GW = 1.0
BATTERY_ROUND_TRIP_EFFICIENCY = 0.90

# Solar Capacity: 1 to 20 GW in 1 GW increments
SOLAR_CAPACITIES_GW = list(range(1, 21))

# Battery Capacity: 0 to 36 GWh in 2 GWh increments
BATTERY_CAPACITIES_GWH = list(range(0, 38, 2))

# Season Definitions (Month indices, 1-based)
SEASONS = {
    "winter": 1,  # January
    "spring": 4,  # April
    "summer": 7,  # July
    "fall": 10,   # October
}

# Sample Duration (hours)
SAMPLE_DURATION_HOURS = 72
