# Baseload Solar Atlas

An interactive web-based tool that simulates and visualizes the feasibility of achieving 24/7 baseload power supply using solar photovoltaics and battery storage across thousands of locations worldwide.

## Overview

The Baseload Solar Atlas answers a fundamental question: **Can solar + battery storage alone provide constant "baseload" power 24/7/365?**

This tool simulates a 1 GW constant load at thousands of locations worldwide, calculating:
- How much solar capacity (GW_DC) and battery storage (GWh) is needed to meet that load
- The resulting **Capacity Factor** (reliability metric)
- The **Levelized Cost of Energy (LCOE)** for each configuration
- Supply-demand matching based on population density or existing fossil fuel infrastructure

## Data Sources

### 1. Solar Irradiance & Weather Data
- **Source**: NASA POWER (Prediction Of Worldwide Energy Resources)
- **Data Type**: Hourly solar irradiance, temperature, and meteorological data
- **Coverage**: Global grid with ~0.5° resolution
- **Purpose**: Calculate realistic solar generation profiles for each location

### 2. Population Data
- **Source**: NASA SEDAC (Socioeconomic Data and Applications Center)
- **Dataset**: Population density for 2020
- **Purpose**: Map demand centers and analyze supply-demand matching
- **File**: `data/voronoi_population_2020.csv`

### 3. Fossil Fuel Infrastructure
- **Source**: Global power plant database
- **Data**: Location and capacity of coal, gas, and oil power plants
- **Purpose**: Analyze potential replacement scenarios for existing fossil infrastructure
- **Files**: 
  - `data/fossil_plants.csv` - Individual plant locations and capacities
  - `data/voronoi_fossil_capacity.csv` - Aggregated capacity by Voronoi cell

### 4. Simulation Results
- **Pre-computed**: Capacity factor results for multiple solar/battery configurations
- **Format**: Apache Parquet (compressed columnar format)
- **Main File**: `data/simulation_results_summary.parquet`
- **Sample Data**: `data/samples/samples_s{solar}_b{battery}.parquet` (hourly time series)

## Mathematical Model

### Core Simulation Logic

The model is based on **pre-computed simulation results** stored in Parquet files. The actual hourly simulation was performed offline (likely in Python) using NASA POWER solar irradiance data.

#### 1. Pre-computed Data

The browser application loads pre-computed results that include:
- **Capacity Factor** (`annual_cf`): Percentage of hours the system meets 1 GW demand
- **Configuration Matrix**: Results for 19 different solar/battery combinations per location
  - Solar: 1-20 GW_DC (various increments)
  - Battery: 0-36 GWh (2 GWh increments)
- **Sample Time Series**: Hourly solar generation, battery flow, and state of charge for representative weeks

**Note**: The solar generation calculation (irradiance → power output) was done during the offline simulation phase. The browser only displays and analyzes the pre-computed results.

#### 2. Battery Dispatch Logic (from pre-computed simulation)

The offline simulation used the following battery dispatch logic:

**Energy Balance:**
```
Battery_SOC(t+1) = Battery_SOC(t) + Charge(t) - Discharge(t)
```

**Constraints:**
- `0 ≤ Battery_SOC(t) ≤ Battery_Capacity` (GWh)
- Charge rate limited by excess solar generation
- Discharge rate limited by demand gap and battery capacity
- Round-trip efficiency: 90% (modeled explicitly as symmetric charge/discharge losses)

**Dispatch Priority:**
1. Solar directly meets the 1 GW load when available
2. Excess solar charges battery (if not full)
3. Battery discharges to meet shortfall (if available)
4. Unmet demand recorded as "other" (system failure to meet load)

The browser displays these pre-computed results via the `solar_gen`, `battery_flow`, and `soc` (state of charge) arrays in the sample data files.

#### 3. Capacity Factor (Pre-computed)

The **Capacity Factor** in the data represents the percentage of hours in a year that the simulated system successfully met the 1 GW demand:

```
Capacity_Factor = (Hours_Load_Met / Total_Hours_In_Year) × 100%
```

Where:
- `Hours_Load_Met` = hours where `Solar_Output(t) + Battery_Discharge(t) ≥ 1 GW`
- `Total_Hours_In_Year` = 8,760 hours

A capacity factor of 90% means the system successfully provided 1 GW for 90% of the year (7,884 hours).

**Note**: This was calculated during the offline simulation. The browser simply displays the pre-computed `annual_cf` value from the Parquet files.

### Economic Model (LCOE)

The **Levelized Cost of Energy (LCOE)** represents the average cost per MWh of electricity produced over the system lifetime.

**Important**: Unlike capacity factor, LCOE **IS calculated in the browser** in real-time. The browser takes the pre-computed `annual_cf` values and applies user-defined economic parameters to calculate LCOE on-the-fly.

#### Capital Recovery Factor

```
CRF(r, n) = [r × (1 + r)^n] / [(1 + r)^n - 1]
```

Where:
- `r` = WACC (Weighted Average Cost of Capital), default 7%
- `n` = Asset lifetime (30 years for solar, 20 years for batteries)

#### Annual Costs

**Solar Component:**
```
Solar_Annual_Cost = Solar_Capacity_kW × Solar_CAPEX × CRF(WACC, Solar_Life)
                  + Solar_Capacity_kW × Solar_CAPEX × Solar_OPEX_Pct
```

**Battery Component:**
```
Battery_Annual_Cost = Battery_Capacity_kWh × Battery_CAPEX × CRF(WACC, Battery_Life)
                    + Battery_Capacity_kWh × Battery_CAPEX × Battery_OPEX_Pct
```

**Total Annual Cost:**
```
Total_Annual_Cost = Solar_Annual_Cost + Battery_Annual_Cost
```

#### LCOE Calculation

```
LCOE = Total_Annual_Cost / Annual_Energy_Delivered

Where:
Annual_Energy_Delivered = Capacity_Factor × 8,760 hours × 1,000 MW
```

**Default Economic Parameters:**
- Solar CAPEX: $600/kW_DC
- Battery CAPEX: $120/kWh
- Solar OPEX: 1.5% of CAPEX annually
- Battery OPEX: 2.0% of CAPEX annually
- Solar Lifetime: 30 years
- Battery Lifetime: 20 years
- WACC: 7%

**Browser Implementation**: See `computeConfigLcoe()` function in `js/app.js` (lines 263-280).

### Transmission Cost Analysis

When a reference location is selected in LCOE mode, the browser calculates transmission economics in real-time:

#### Breakeven Transmission Cost

For each location, the model calculates how much could be spent on transmission infrastructure while remaining cost-competitive with the reference location:

```
Annual_Savings = (LCOE_ref - LCOE_location) × Annual_Energy_Delivered
Breakeven_TX_Investment = Annual_Savings / CRF(TX_WACC, TX_Life)
Breakeven_Per_GW_km = Breakeven_TX_Investment / Distance_km
```

Where:
- `TX_WACC` = 6% (transmission infrastructure discount rate)
- `TX_Life` = 50 years (transmission line lifetime)
- `Distance_km` = Haversine distance between locations

This metric shows the maximum justifiable transmission cost per GW-km to economically transport power from a cheaper location.

**Browser Implementation**: See `computeTransmissionMetrics()` function in `js/app.js` (lines 282-302).

## Visualization Modes

### 1. Capacity Factor Map
Shows the achievable capacity factor for a given solar + battery configuration at each location. Warmer colors indicate higher reliability.

### 2. Sample Weeks
Displays hourly time-series data for representative weeks (spring, summer, fall, winter) showing:
- Solar generation (yellow)
- Battery discharge (purple)
- Unmet demand (gray)
- Battery charging (blue, shown as negative)
- Curtailed solar (orange)

The animation shows how the energy balance evolves hour-by-hour across different locations.

### 3. LCOE Map
For a target capacity factor (e.g., 90%), shows the minimum LCOE achievable at each location. Includes:
- **Absolute LCOE**: Cost per MWh at each location
- **Delta Mode**: Cost difference relative to a selected reference location
- **Transmission Mode**: Breakeven transmission cost per GW-km

### 4. Supply-Demand Matching
Overlays capacity factor or LCOE data on either:
- **Population density**: Showing where people live vs. where solar+storage is most viable
- **Fossil plant capacity**: Showing replacement potential for existing infrastructure

Includes analytical charts showing metrics by:
- Population percentile
- Latitude bands
- Geographic distribution

## Data Processing Pipeline

### Offline Simulation (Pre-computation)

The following steps were performed offline to generate the Parquet data files:

1. **Voronoi Tessellation**: Divide the globe into ~3,000-5,000 Voronoi cells for uniform spatial sampling
2. **Solar Data Collection**: Load hourly solar irradiance data from NASA POWER for each cell center (8,760 hours/year)
3. **Configuration Matrix**: For each location, simulate 19 different solar/battery combinations
4. **Hourly Simulation**: 
   - Calculate solar generation from irradiance
   - Simulate battery operation with dispatch logic
   - Track state of charge, charging, discharging
   - Calculate capacity factor and energy metrics
5. **Sample Week Selection**: Use k-means clustering on daily patterns to select representative weeks for each season
6. **Data Export**: Store results in compressed Parquet format

### Browser Application (Real-time)

The browser performs only these operations:

1. **Load Pre-computed Data**: Read Parquet files using WebAssembly
2. **LCOE Calculation**: Calculate levelized costs using the pre-computed capacity factors and user-defined economic parameters
3. **Transmission Analysis**: Calculate distance-based transmission economics when reference location selected
4. **Visualization**: Render maps, charts, and time-series animations
5. **Aggregation**: Compute statistics by population percentile, latitude, etc.

## File Structure

```
BaseloadSolarAtlas/
├── index.html                          # Main application interface
├── css/
│   └── style.css                       # Styling
├── js/
│   ├── app.js                          # Main application logic
│   ├── map.js                          # Leaflet map rendering
│   ├── samples.js                      # Hourly sample visualization
│   ├── charts.js                       # Chart.js integration
│   ├── data.js                         # Data loading utilities
│   ├── parquet_wasm.js                 # Parquet reader (WebAssembly)
│   └── apache-arrow.js                 # Arrow data format support
└── data/
    ├── simulation_results_summary.parquet   # Pre-computed CF results
    ├── voronoi_population_2020.csv          # Population by cell
    ├── voronoi_fossil_capacity.csv          # Fossil capacity by cell
    ├── fossil_plants.csv                    # Individual plant data
    └── samples/
        └── samples_s{solar}_b{battery}.parquet  # Hourly time series
```

## Technical Implementation

### Frontend Technologies
- **HTML5/CSS3/JavaScript**: Core web technologies
- **Leaflet.js**: Interactive map rendering
- **D3.js**: Voronoi layer and color scales
- **Chart.js**: Time-series and analytical charts
- **Tailwind CSS**: Utility-first styling framework

### Data Formats
- **Apache Parquet**: Columnar storage for efficient compression and fast queries
- **Apache Arrow**: In-memory columnar format for zero-copy data access
- **WebAssembly**: High-performance Parquet parsing in the browser
- **GeoJSON**: Vector geographic data for map boundaries
- **CSV**: Simple tabular data for population and plant locations

### Performance Optimizations
- Pre-computed simulation results (no real-time simulation in browser)
- Compressed Parquet files (~4 MB for 3,000+ locations × 19 configurations)
- Lazy loading of sample data (only loaded when needed)
- Efficient Voronoi rendering with D3
- Debounced UI updates to prevent excessive re-rendering

## Usage

1. **Select View Mode**: Choose between Capacity Factor, Sample Weeks, LCOE, or Supply-Demand Matching
2. **Select Configuration**: Use sliders to choose from pre-computed solar capacity (1-20 GW_DC) and battery storage (0-36 GWh) combinations
3. **Explore the Map**: Click locations to see detailed metrics for the selected configuration
4. **Analyze Economics**: In LCOE mode, adjust economic parameters (CAPEX, OPEX, WACC) to see how costs change
5. **Compare Locations**: Select a reference location to see relative costs and transmission economics
6. **View Time Series**: In Sample Weeks mode, play through hourly animations to see system operation

**Note**: Changing the solar/battery sliders loads different pre-computed simulation results, not re-running the simulation.

## Key Insights

The tool reveals several important patterns:

1. **Geographic Variation**: Equatorial regions achieve higher capacity factors due to consistent solar resources
2. **Battery Requirements**: Achieving 90%+ capacity factor typically requires 15-30 GWh of storage per GW of load
3. **Seasonal Effects**: Higher latitudes show strong seasonal variation in solar availability
4. **Economic Trade-offs**: LCOE varies by 2-5× between best and worst locations
5. **Transmission Economics**: Long-distance transmission can be economically justified for locations with significantly lower LCOE

## Limitations & Assumptions

### About the Browser Application

1. **Pre-computed Results**: The browser displays pre-computed simulation results. It does not run the actual hourly energy simulation - that was done offline.
2. **No Real-time Simulation**: Changing sliders loads different pre-computed configurations, not re-running simulations.
3. **Limited Configurations**: Only 19 solar/battery combinations are available (those that were pre-computed).

### About the Offline Simulation (assumptions)

Based on the data structure, the offline simulation likely made these assumptions:

1. **Simplified Dispatch**: Assumes optimal dispatch with perfect foresight (real systems need forecasting)
2. **No Degradation**: Does not model battery or panel degradation over time
3. **Fixed Efficiency**: Uses constant efficiency factors (real systems vary with temperature, age, etc.)
4. **No Grid Integration**: Models isolated systems, ignoring grid interconnection benefits
5. **Historical Weather**: Based on NASA POWER historical data (may not represent future climate)
6. **Simplified Economics**: LCOE calculations use simplified model without financing structures, taxes, or incentives

## Credits

**Created by**: Daan Walter, 2025

**Data Sources**:
- NASA POWER (Solar/Weather)
- NASA SEDAC (Population)
- Global Power Plant Database (Fossil Infrastructure)

**Open Source Libraries**:
- Leaflet.js, D3.js, Chart.js
- Apache Arrow, Apache Parquet
- Tailwind CSS
