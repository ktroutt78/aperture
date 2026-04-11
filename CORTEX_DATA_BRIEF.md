# Aperture — Data Foundation Brief
**For:** Cortex Code  
**Project:** Aperture / TC2026 Hackathon  
**Deadline:** April 16, 2026

---

## Objective

Build a multi-source energy intelligence dataset in Snowflake, loaded from four free
public APIs, kept current with automated tasks, and optimized for Tableau Cloud live
connection via VizQL Data Service.

---

## Context

Aperture is a Tableau Cloud Extension that embeds an AI co-pilot inside a dashboard.
The extension fuses three Tableau APIs simultaneously:

- **Metadata API** — schema and field lineage
- **VizQL Data Service** — live data queries against the Snowflake datasource
- **Pulse REST API** — pre-computed Tableau AI insights and user feedback signals

All three are merged and streamed to Claude to generate real-time narrative intelligence.
This dataset is the foundation everything runs on. The richer the schema, the richer
Claude's narrative.

---

## The Four Data Sources

### 1. EIA API
- **Auth:** Free API key — register at `https://www.eia.gov/opendata/`
- **What to pull:** Daily petroleum spot prices and weekly inventory levels by US energy
  region (PADD districts)
- **Update cadence:** Daily for prices, weekly (Wednesdays) for inventory

### 2. NOAA CDO API
- **Auth:** Free token — register at `https://www.ncei.noaa.gov/cdo-web/webservices/v2`
- **What to pull:** Daily temperature and heating/cooling degree days mapped to the same
  PADD regions as the EIA data
- **Update cadence:** Daily

### 3. GDELT Project
- **Auth:** None required — completely free and open
- **URL:** `https://api.gdeltproject.org/api/v2/`
- **What to pull:** Daily geopolitical event scores filtered to energy-relevant countries
  and event types (conflict, sanctions, supply disruptions)
- **Update cadence:** Daily summary, aggregated weekly into Snowflake

### 4. EIA Short Term Energy Outlook (STEO)
- **Auth:** Same EIA API key as Source 1
- **What to pull:** Monthly EIA price and production forecasts so we can show forecast
  vs actual divergence in the dashboard
- **Update cadence:** Monthly

---

## Design Requirements

### Database and Schema
- All four sources land in `APERTURE_DB.ENERGY`
- Schema must be analytics-ready for Tableau — clean field names, no cryptic column
  names, no raw API response garbage

### Geography
- **PADD region is the primary geographic dimension across all four sources**
- Map NOAA weather stations to PADD regions in a reference table
- Map GDELT countries to PADD regions in a reference table
- Include a `DIM_PADD_REGIONS` reference table with: region name, description,
  and lat/long centroid so Tableau can plot them on a map

### History
- **Backfill 3 years of history on first load for all four sources**
- This gives Tableau Pulse enough history for meaningful trend detection and
  year-over-year comparisons

### Automation
Snowflake tasks keep each source current on its natural update cadence:
- Daily: EIA prices, NOAA temperature/degree days
- Weekly: EIA inventory, GDELT geopolitical summary
- Monthly: EIA STEO forecasts

### Access Control
- Create a dedicated `TABLEAU_READER` role with appropriate grants
- Tableau Cloud connects using this role — never the account admin

### Mart Layer
Build a single denormalized `MART_ENERGY_DAILY` view that joins all four sources
by date and PADD region. This is the primary datasource Tableau connects to.

The mart must support:
- Tableau Pulse metric definitions on at minimum: WTI Price, Total Inventory Change,
  Heating Degree Days
- VizQL Data Service queries returning up to 500 rows filtered by region and date range
- Enough dimensional richness for Claude to reason across all four sources in a single
  narrative response

---

## What This Dataset Needs to Support

### Dashboard sheets (4 total)
1. Energy price trends over time (line chart)
2. Inventory by PADD region (map view)
3. Forecast vs actual price divergence (bar/line combo)
4. Cross-source anomaly view — price, inventory, temperature, and geopolitical score
   on the same time axis

### Tableau Pulse metrics
- WTI Crude Oil Price (daily, period-over-period)
- Total Inventory Change (weekly, vs prior week)
- Heating Degree Days by Region (daily, vs seasonal normal)

### Claude narrative example
The data must support Claude producing narratives like:

> "Gulf Coast crude inventory drew down 8.2M barrels this week, significantly exceeding
> EIA's forecast of a 1.1M barrel build. Two simultaneous pressures drove this divergence:
> a cold snap across the Northeast pushed heating degree days 40% above seasonal norms,
> while the GDELT geopolitical tension score for Saudi Arabia reached a 6-month high.
> [ANOMALY: Region='Gulf Coast' Metric='Inventory Change']"

That narrative requires all four sources to be present in the mart and queryable
via VizQL in a single request.

---

## Deliverables

1. All DDL scripts (`APERTURE_DB.ENERGY` schema, all fact/dim tables, mart view)
2. Stored procedures for initial 3-year backfill of all four sources
3. Snowflake tasks for ongoing automated refresh
4. `MART_ENERGY_DAILY` view definition
5. `TABLEAU_READER` role definition and grants
6. Validation query for each source confirming data looks correct
7. Tableau Cloud connection string details for the live connection setup
8. Brief notes on API rate limits, failure modes, and anything that needs
   manual intervention

---

## Constraints

- **All APIs must be free tier** — no paid subscriptions
- **No hardcoded credentials** — use Snowflake secrets or environment variables
- **Degrade gracefully** — if any single source API call fails, log the failure,
  skip that day's load, never break the pipeline or block other sources
- **Idempotent loads** — re-running any procedure should not create duplicate rows

---

## Notes for Cortex Code

You own all schema and implementation decisions. Make the call and build it.
The only hard constraints are the ones listed above. Everything else — table
structure, task scheduling approach, error handling strategy, PADD region mapping
methodology — is yours to decide.

The Aperture backend (built separately in TypeScript) will query this data exclusively
through Tableau's VizQL Data Service, not directly against Snowflake. Design the mart
with that in mind — clean field captions, no ambiguous column names, every measure
clearly labeled with its unit.
