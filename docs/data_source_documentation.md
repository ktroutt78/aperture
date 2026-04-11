# Aperture Energy Intelligence — Snowflake Data Source Documentation

Database: `APERTURE_DB` | Schema: `ENERGY` | Warehouse: `COMPUTE_WH`

---

## Architecture Overview

Aperture's data layer is a star-schema-style warehouse built on Snowflake. Five external
APIs feed five fact tables through stored procedures on scheduled tasks. Dimension tables
provide descriptive attributes and are joined only to facts from the same data source.
Five mart views sit on top — one per fact — and serve as the query interface for Tableau
and the Claude-powered analytics co-pilot.

### Design Rules

1. **Same-source dimension joins only.** A dimension is joined to a fact only when both
   originate from the same external API / data domain. EIA dimensions join EIA facts.
   GDELT dimensions join GDELT facts. NOAA dimensions do not join EIA facts. No
   cross-source joins.
2. **Always LEFT JOIN.** Dimension joins use LEFT JOIN so no fact rows are lost if a
   dimension key is missing.
3. **One mart per fact.** Each mart view reads from exactly one fact table (plus its
   same-source dimension if applicable). Marts are never joined to each other.
4. **Application-layer relationship discovery.** The Aperture co-pilot (Claude + VizQL
   Data Service) discovers cross-source relationships at query time. The warehouse
   does not pre-join across data sources.

---

## Data Sources and External APIs

| Source | API | Frequency | Secrets |
|--------|-----|-----------|---------|
| EIA (Energy Information Administration) | EIA Open Data v2 | Daily / Weekly / Monthly | `EIA_API_KEY` |
| NOAA (National Oceanic and Atmospheric Administration) | NOAA CDO Web Services | Daily | `NOAA_CDO_TOKEN` |
| GDELT (Global Database of Events, Language, and Tone) | GDELT GKG/Event API | Weekly | None (public) |

External access is configured through the `APERTURE_API_ACCESS` integration.

---

## Fact Tables

### FACT_EIA_PRICES
EIA daily national petroleum spot and retail prices.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `PRICE_DATE` | DATE | No | **PK part 1.** Trading day. |
| `SERIES_ID` | VARCHAR(50) | No | **PK part 2.** EIA series identifier. |
| `PRODUCT_NAME` | VARCHAR(100) | No | Human-readable product label. |
| `PRICE_USD` | FLOAT | Yes | Price in US dollars. |
| `PRICE_UNIT` | VARCHAR(50) | Yes | Default `USD/barrel`. |
| `PADD_ID` | NUMBER(38,0) | Yes | Default `0` (national). |
| `LOADED_AT` | TIMESTAMP_NTZ | Yes | ETL load timestamp. |

**Grain:** One row per `PRICE_DATE` per `SERIES_ID`.
**Date range:** 2006-05-10 to present.
**Row count:** ~15,312 (fact), ~5,082 (mart after pivot).

**Series IDs in use:**

| SERIES_ID | Product |
|-----------|---------|
| `PET.RWTC.D` | WTI Crude Oil |
| `PET.RBRTE.D` | Brent Crude Oil |
| `EMM_EPM0_PTE_NUS_DPG` | Regular Gasoline Retail |
| `PET.EER_EPJK_PF4_RGC_DPG.D` | Jet Fuel Gulf Coast |
| `EMD_EPD2DXL0_PTE_NUS_DPG` | No 2 Diesel Retail |

---

### FACT_EIA_INVENTORY
EIA weekly petroleum inventory levels by PADD.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `REPORT_DATE` | DATE | No | **PK part 1.** Weekly report date. |
| `SERIES_ID` | VARCHAR(50) | No | **PK part 2.** EIA series identifier. |
| `PRODUCT_NAME` | VARCHAR(100) | No | Human-readable product label. |
| `PADD_ID` | NUMBER(38,0) | No | **PK part 3.** PADD district (0=US total, 1-5). |
| `INVENTORY_THOUSAND_BARRELS` | FLOAT | Yes | Stock level in thousands of barrels. |
| `WEEKLY_CHANGE_THOUSAND_BARRELS` | FLOAT | Yes | Week-over-week change. |
| `LOADED_AT` | TIMESTAMP_NTZ | Yes | ETL load timestamp. |

**Grain:** One row per `REPORT_DATE` per `SERIES_ID` per `PADD_ID`.
**Date range:** 1982-08-20 to present.
**Row count:** ~17,786 (fact), ~11,731 (mart after pivot).

**Series IDs in use:**

| SERIES_ID | Product |
|-----------|---------|
| `PET.WCESTUS1.W` | Crude Oil Stocks (US total) |
| `PET.WCESTP11.W` through `PET.WCESTP51.W` | Crude Oil Stocks (PADDs 1-5) |
| `PET.WTTSTUS1.W` | Total Petroleum Stocks |
| `PET.WGTSTUS1.W` | Motor Gasoline Stocks |
| `PET.WDISTUS1.W` | Distillate Fuel Oil Stocks |

---

### FACT_EIA_STEO_FORECASTS
EIA Short-Term Energy Outlook monthly forecasts.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `FORECAST_MONTH` | DATE | No | **PK part 1.** First of the forecast month. |
| `SERIES_ID` | VARCHAR(50) | No | **PK part 2.** STEO series identifier. |
| `METRIC_NAME` | VARCHAR(100) | No | Human-readable metric label. |
| `FORECAST_VALUE` | FLOAT | Yes | Forecast value in native units. |
| `FORECAST_UNIT` | VARCHAR(50) | Yes | Unit of measure. |
| `PUBLICATION_DATE` | DATE | Yes | Date EIA published this forecast. |
| `LOADED_AT` | TIMESTAMP_NTZ | Yes | ETL load timestamp. |

**Grain:** One row per `FORECAST_MONTH` per `SERIES_ID`.
**Date range:** 1990-01-01 to 2027-12-01 (includes forward forecasts).
**Row count:** ~2,280 (fact), ~456 (mart after pivot).

**Series IDs in use:**

| SERIES_ID | Metric |
|-----------|--------|
| `STEO.BREPUUS.M` | WTI Crude Oil Price Forecast |
| `STEO.COPRPUS.M` | US Crude Oil Production Forecast |
| `STEO.D2RCAUS.M` | Diesel Retail Price Forecast |
| `STEO.MGEIAUS.M` | Motor Gasoline Price Forecast |
| `STEO.NGPRPUS.M` | US Natural Gas Production Forecast |

**Note:** The mart also defines pivot columns for `STEO.BRIPUUS.M` (Brent forecast) and
`STEO.PAPRPUS.M` (consumption forecast). These series have not been backfilled yet and
currently return NULL.

---

### FACT_NOAA_WEATHER
NOAA daily temperature and degree-day observations aggregated to PADD level.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `OBSERVATION_DATE` | DATE | No | **PK part 1.** |
| `PADD_ID` | NUMBER(38,0) | No | **PK part 2.** PADD district (1-5). |
| `AVG_TEMP_F` | FLOAT | Yes | Average temperature (Fahrenheit). |
| `MIN_TEMP_F` | FLOAT | Yes | Minimum temperature. |
| `MAX_TEMP_F` | FLOAT | Yes | Maximum temperature. |
| `HEATING_DEGREE_DAYS` | FLOAT | Yes | HDD (base 65 F). |
| `COOLING_DEGREE_DAYS` | FLOAT | Yes | CDD (base 65 F). |
| `STATION_COUNT` | NUMBER(38,0) | Yes | Number of stations in the PADD average. |
| `LOADED_AT` | TIMESTAMP_NTZ | Yes | ETL load timestamp. |

**Grain:** One row per `OBSERVATION_DATE` per `PADD_ID`.
**Date range:** 2023-04-11 to present.
**Row count:** ~5,465.

---

### FACT_GDELT_EVENTS
GDELT weekly geopolitical event scores for energy-relevant countries.

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `EVENT_DATE` | DATE | No | **PK part 1.** Week-ending date. |
| `COUNTRY_CODE` | VARCHAR(3) | No | **PK part 2.** ISO 3-letter code (from GDELT). |
| `COUNTRY_NAME` | VARCHAR(100) | Yes | Country name (from GDELT). |
| `AVG_TONE` | FLOAT | Yes | Average media tone (-100 to +100). |
| `AVG_GOLDSTEIN_SCALE` | FLOAT | Yes | Goldstein conflict-cooperation scale (-10 to +10). |
| `EVENT_COUNT` | NUMBER(38,0) | Yes | Total events recorded. |
| `CONFLICT_EVENT_COUNT` | NUMBER(38,0) | Yes | Events with negative Goldstein score. |
| `COOPERATION_EVENT_COUNT` | NUMBER(38,0) | Yes | Events with positive Goldstein score. |
| `GEOPOLITICAL_TENSION_SCORE` | FLOAT | Yes | Derived tension index. |
| `PRIMARY_PADD_IMPACT` | NUMBER(38,0) | Yes | PADD most affected by this country's events. |
| `LOADED_AT` | TIMESTAMP_NTZ | Yes | ETL load timestamp. |

**Grain:** One row per `EVENT_DATE` per `COUNTRY_CODE`.
**Date range:** 2023-04-11 to present.
**Row count:** ~21,580.

**Countries tracked (20):** AGO, ARE, BRA, CAN, CHN, EGY, IND, IRN, IRQ, KWT, LBY,
MEX, NGA, NOR, RUS, SAU, TUR, UKR, VEN, YEM.

---

## Dimension Tables

### DIM_PADD_REGIONS
**Data source:** EIA (energy domain).
**Joined to:** `FACT_EIA_INVENTORY` only (same source). Not joined to NOAA or GDELT facts.
**Row count:** 6 (PADD 0-5).

| Column | Type | Notes |
|--------|------|-------|
| `PADD_ID` | NUMBER(38,0) | **PK.** 0=US total, 1-5=districts. |
| `PADD_CODE` | VARCHAR(10) | Short code (US, PADD1, ..., PADD5). |
| `PADD_NAME` | VARCHAR(100) | Full name (United States Total, East Coast, ...). |
| `PADD_DESCRIPTION` | VARCHAR(500) | States and notes. |
| `CENTROID_LAT` | FLOAT | Geographic centroid latitude. |
| `CENTROID_LON` | FLOAT | Geographic centroid longitude. |
| `STATES_INCLUDED` | VARCHAR(1000) | Comma-separated state abbreviations. |
| `COMMENT` | VARCHAR(500) | Descriptive note. |

**PADD reference:**

| PADD_ID | Code | Name | States |
|---------|------|------|--------|
| 0 | US | United States Total | All |
| 1 | PADD1 | East Coast | CT, ME, MA, NH, RI, VT, DE, DC, FL, GA, MD, NJ, NY, NC, PA, SC, VA, WV |
| 2 | PADD2 | Midwest | IL, IN, IA, KS, KY, MI, MN, MO, NE, ND, SD, OH, OK, TN, WI |
| 3 | PADD3 | Gulf Coast | AL, AR, LA, MS, NM, TX |
| 4 | PADD4 | Rocky Mountain | CO, ID, MT, UT, WY |
| 5 | PADD5 | West Coast | AK, AZ, CA, HI, NV, OR, WA |

---

### DIM_GDELT_COUNTRY_PADD_MAP
**Data source:** GDELT domain (curated country metadata for energy relevance).
**Joined to:** `FACT_GDELT_EVENTS` only (same source). Not joined to EIA or NOAA facts.
**Row count:** 20.

| Column | Type | Notes |
|--------|------|-------|
| `COUNTRY_CODE` | VARCHAR(3) | **PK.** ISO 3-letter code. |
| `COUNTRY_NAME` | VARCHAR(100) | Country name. |
| `ENERGY_RELEVANCE` | VARCHAR(50) | Category: OPEC Producer, Major Producer, Major Consumer, Transit Country, Chokepoint. |
| `PRIMARY_PADD_IMPACT` | NUMBER(38,0) | PADD most affected by this country. |
| `DESCRIPTION` | VARCHAR(500) | Why this country matters to US energy. |

---

### DIM_NOAA_STATION_PADD_MAP
**Data source:** NOAA (weather domain).
**Joined to:** Nothing at the mart level. `FACT_NOAA_WEATHER` is already aggregated to
PADD-level daily — there is no station-level grain in the fact table, so this dimension
has no useful join target.
**Row count:** 51.

| Column | Type | Notes |
|--------|------|-------|
| `STATE_FIPS` | VARCHAR(2) | FIPS state code. |
| `STATE_ABBR` | VARCHAR(2) | State abbreviation. |
| `STATE_NAME` | VARCHAR(50) | State name. |
| `PADD_ID` | NUMBER(38,0) | PADD the station belongs to. |
| `NOAA_STATION_ID` | VARCHAR(20) | NOAA station identifier. |
| `STATION_NAME` | VARCHAR(100) | Human-readable station name. |
| `STATION_LAT` | FLOAT | Station latitude. |
| `STATION_LON` | FLOAT | Station longitude. |

---

## Mart Views

These are the query interface for Tableau and the Aperture co-pilot. Each reads from one
fact table with an optional same-source dimension LEFT JOIN.

### MART_EIA_PRICES
**Source:** `FACT_EIA_PRICES` (no dimension join — national grain, no geographic key).
**Grain:** `PRICE_DATE` (one row per trading day).
**Row count:** ~5,082 | **Columns:** 14

| Column | Source | Description |
|--------|--------|-------------|
| `PRICE_DATE` | Fact | Trading day |
| `DAY_OF_WEEK` | Derived | DAYNAME of PRICE_DATE |
| `WEEK_OF_YEAR` | Derived | WEEKOFYEAR of PRICE_DATE |
| `MONTH_NUM` | Derived | Month number |
| `MONTH_NAME` | Derived | Month name |
| `QUARTER_NUM` | Derived | Quarter number |
| `YEAR_NUM` | Derived | Year |
| `WTI_PRICE_USD` | Fact pivot | WTI crude spot price |
| `BRENT_PRICE_USD` | Fact pivot | Brent crude spot price |
| `GASOLINE_PRICE_USD` | Fact pivot | Regular gasoline retail |
| `JET_FUEL_PRICE_USD` | Fact pivot | Jet fuel Gulf Coast |
| `DIESEL_PRICE_USD` | Fact pivot | No 2 diesel retail |
| `WTI_DAILY_CHANGE` | Derived | WTI day-over-day price change |
| `WTI_BRENT_SPREAD` | Derived | Brent minus WTI on same day |

---

### MART_EIA_INVENTORY
**Source:** `FACT_EIA_INVENTORY` LEFT JOIN `DIM_PADD_REGIONS` ON `PADD_ID` (same EIA source).
**Grain:** `REPORT_DATE x PADD_ID` (one row per weekly report per PADD).
**Row count:** ~11,731 | **Columns:** 15

| Column | Source | Description |
|--------|--------|-------------|
| `REPORT_DATE` | Fact | Weekly report date |
| `DAY_OF_WEEK` | Derived | DAYNAME of REPORT_DATE |
| `WEEK_OF_YEAR` | Derived | WEEKOFYEAR of REPORT_DATE |
| `MONTH_NUM` | Derived | Month number |
| `MONTH_NAME` | Derived | Month name |
| `QUARTER_NUM` | Derived | Quarter number |
| `YEAR_NUM` | Derived | Year |
| `PADD_ID` | Fact | PADD district integer (0=US, 1-5) |
| `PADD_CODE` | Dimension | Short code (US, PADD1, ..., PADD5) |
| `PADD_NAME` | Dimension | Full name (East Coast, Midwest, ...) |
| `CRUDE_INVENTORY_KBBL` | Fact pivot | Crude oil stocks (thousand barrels) |
| `CRUDE_WEEKLY_CHANGE_KBBL` | Fact pivot | Crude week-over-week change |
| `TOTAL_PETROLEUM_INVENTORY_KBBL` | Fact pivot | Total petroleum stocks |
| `GASOLINE_INVENTORY_KBBL` | Fact pivot | Motor gasoline stocks |
| `DISTILLATE_INVENTORY_KBBL` | Fact pivot | Distillate fuel oil stocks |

---

### MART_EIA_STEO
**Source:** `FACT_EIA_STEO_FORECASTS` (no dimension join — national grain).
**Grain:** `FORECAST_MONTH` (one row per month).
**Row count:** ~456 | **Columns:** 11

| Column | Source | Description |
|--------|--------|-------------|
| `FORECAST_MONTH` | Fact | First of the forecast month |
| `MONTH_NAME` | Derived | Month name |
| `QUARTER_NUM` | Derived | Quarter number |
| `YEAR_NUM` | Derived | Year |
| `STEO_WTI_FORECAST` | Fact pivot | WTI price forecast (USD/barrel) |
| `STEO_BRENT_FORECAST` | Fact pivot | Brent price forecast (currently NULL — not yet backfilled) |
| `STEO_PRODUCTION_FORECAST` | Fact pivot | US crude production forecast |
| `STEO_CONSUMPTION_FORECAST` | Fact pivot | US petroleum consumption forecast (currently NULL) |
| `STEO_GASOLINE_PRICE_FORECAST` | Fact pivot | Gasoline price forecast |
| `STEO_DIESEL_PRICE_FORECAST` | Fact pivot | Diesel price forecast |
| `STEO_PUBLICATION_DATE` | Fact | Most recent publication date for the forecast month |

---

### MART_WEATHER
**Source:** `FACT_NOAA_WEATHER` (no dimension join — NOAA API did not provide PADD dimension).
**Grain:** `OBSERVATION_DATE x PADD_ID` (daily, PADDs 1-5).
**Row count:** ~5,465 | **Columns:** 14

| Column | Source | Description |
|--------|--------|-------------|
| `OBSERVATION_DATE` | Fact | Observation day |
| `DAY_OF_WEEK` | Derived | DAYNAME of OBSERVATION_DATE |
| `WEEK_OF_YEAR` | Derived | WEEKOFYEAR of OBSERVATION_DATE |
| `MONTH_NUM` | Derived | Month number |
| `MONTH_NAME` | Derived | Month name |
| `QUARTER_NUM` | Derived | Quarter number |
| `YEAR_NUM` | Derived | Year |
| `PADD_ID` | Fact | PADD district integer (1-5) |
| `AVG_TEMP_F` | Fact | Average temperature (Fahrenheit) |
| `MIN_TEMP_F` | Fact | Minimum temperature |
| `MAX_TEMP_F` | Fact | Maximum temperature |
| `HEATING_DEGREE_DAYS` | Fact | Heating degree days (base 65 F) |
| `COOLING_DEGREE_DAYS` | Fact | Cooling degree days (base 65 F) |
| `WEATHER_STATION_COUNT` | Fact | Stations contributing to the PADD average |

---

### MART_GEOPOLITICAL
**Source:** `FACT_GDELT_EVENTS` LEFT JOIN `DIM_GDELT_COUNTRY_PADD_MAP` ON `COUNTRY_CODE` (same GDELT source).
**Grain:** `EVENT_DATE x COUNTRY_CODE` (weekly, 20 countries).
**Row count:** ~21,580 | **Columns:** 18

| Column | Source | Description |
|--------|--------|-------------|
| `EVENT_DATE` | Fact | Week-ending date |
| `DAY_OF_WEEK` | Derived | DAYNAME of EVENT_DATE |
| `WEEK_OF_YEAR` | Derived | WEEKOFYEAR of EVENT_DATE |
| `MONTH_NUM` | Derived | Month number |
| `MONTH_NAME` | Derived | Month name |
| `QUARTER_NUM` | Derived | Quarter number |
| `YEAR_NUM` | Derived | Year |
| `COUNTRY_CODE` | Fact | ISO 3-letter country code |
| `COUNTRY_NAME` | Fact | Country name |
| `PRIMARY_PADD_IMPACT` | Fact | PADD most affected by this country |
| `ENERGY_RELEVANCE` | Dimension | Category: OPEC Producer, Major Producer, Major Consumer, Transit Country, Chokepoint |
| `COUNTRY_DESCRIPTION` | Dimension | Why this country matters to US energy supply |
| `AVG_TONE` | Fact | Average media tone (-100 to +100) |
| `AVG_GOLDSTEIN_SCALE` | Fact | Goldstein conflict-cooperation scale (-10 to +10) |
| `EVENT_COUNT` | Fact | Total events recorded that week |
| `CONFLICT_EVENT_COUNT` | Fact | Events with negative Goldstein score |
| `COOPERATION_EVENT_COUNT` | Fact | Events with positive Goldstein score |
| `GEOPOLITICAL_TENSION_SCORE` | Fact | Derived tension index |

---

## Operational Tables

### GDELT_BACKFILL_QUEUE
Tracks per-country GDELT backfill progress. Used by `SP_GDELT_FETCH_NEXT`.

| Column | Type | Description |
|--------|------|-------------|
| `COUNTRY_CODE` | VARCHAR | ISO 3-letter code |
| `FIPS_CODE` | VARCHAR | FIPS country code (GDELT uses FIPS) |
| `COUNTRY_NAME` | VARCHAR | Country name |
| `PRIMARY_PADD_IMPACT` | NUMBER(38,0) | PADD link |
| `STATUS` | VARCHAR | PENDING, PROCESSING, DONE, ERROR |
| `PROCESSED_AT` | TIMESTAMP_NTZ | When processing completed |

### PIPELINE_LOG
Audit log for all ETL procedure runs.

| Column | Type | Description |
|--------|------|-------------|
| `LOG_ID` | NUMBER (IDENTITY) | Auto-increment PK |
| `LOG_TIMESTAMP` | TIMESTAMP_NTZ | When the log entry was created |
| `SOURCE_NAME` | VARCHAR(50) | Data source name (EIA, NOAA, GDELT) |
| `PROCEDURE_NAME` | VARCHAR(100) | Stored procedure that ran |
| `STATUS` | VARCHAR(20) | SUCCESS, ERROR, WARNING |
| `ROWS_AFFECTED` | NUMBER(38,0) | Rows inserted/updated |
| `MESSAGE` | VARCHAR(4000) | Summary message |
| `ERROR_DETAIL` | VARCHAR(4000) | Error details if STATUS = ERROR |

---

## Stored Procedures

| Procedure | Arguments | Description |
|-----------|-----------|-------------|
| `SP_BACKFILL_EIA_PRICES` | () | Fetches latest EIA spot/retail prices and upserts into FACT_EIA_PRICES. |
| `SP_BACKFILL_EIA_RETAIL_PRICES` | () | Fetches weekly EIA retail gasoline/diesel prices. |
| `SP_BACKFILL_EIA_INVENTORY` | () | Fetches latest EIA weekly inventory data by PADD. |
| `SP_BACKFILL_EIA_STEO` | () | Fetches latest STEO monthly forecasts. |
| `SP_BACKFILL_NOAA_WEATHER` | () | Fetches daily NOAA temperature/degree-day data for PADD stations. |
| `SP_BACKFILL_NOAA_PADD5_GAP` | () | Fills specific gaps in PADD 5 weather data. |
| `SP_BACKFILL_GDELT_EVENTS` | () | Fetches weekly GDELT event data for all tracked countries. |
| `SP_BACKFILL_GDELT_EVENTS_CHUNK` | (START_DT, END_DT) | Fetches GDELT events for a specific date range. |
| `SP_GDELT_FETCH_NEXT` | () | Processes the next country in GDELT_BACKFILL_QUEUE (rate-limit-aware). |
| `TEST_GDELT_CONNECTIVITY` | () | Tests GDELT API connectivity. |
| `TEST_GDELT_SINGLE` | () | Tests a single GDELT country fetch. |

All procedures log to `PIPELINE_LOG` on completion.

---

## Scheduled Tasks

All tasks run on `COMPUTE_WH`. Schedules use `America/New_York` timezone unless noted.

| Task | Schedule | Procedure | Description |
|------|----------|-----------|-------------|
| `TASK_DAILY_EIA_PRICES` | `0 7 * * *` (daily 7 AM ET) | SP_BACKFILL_EIA_PRICES | Daily price refresh after market data updates. |
| `TASK_DAILY_NOAA_WEATHER` | `30 8 * * *` (daily 8:30 AM ET) | SP_BACKFILL_NOAA_WEATHER | Daily weather refresh, staggered after prices. |
| `TASK_WEEKLY_EIA_INVENTORY` | `0 12 * * 3` (Wed noon ET) | SP_BACKFILL_EIA_INVENTORY | After EIA's 10:30 AM Wednesday release. |
| `TASK_WEEKLY_EIA_RETAIL_PRICES` | `0 7 * * 2` (Tue 7 AM ET) | SP_BACKFILL_EIA_RETAIL_PRICES | After EIA's Monday retail price release. |
| `TASK_WEEKLY_GDELT_EVENTS` | `0 6 * * 0` (Sun 6 AM ET) | SP_BACKFILL_GDELT_EVENTS | Weekly GDELT geopolitical refresh. |
| `TASK_MONTHLY_EIA_STEO` | `0 14 10 * *` (10th of month, 2 PM ET) | SP_BACKFILL_EIA_STEO | After EIA's monthly STEO release. |
| `TASK_GDELT_BACKFILL_ONESHOT` | Every 5 minutes | SP_GDELT_FETCH_NEXT | Processes one country per run from the backfill queue. |

All tasks are in `started` state with `NO_OVERLAP` policy.

---

## Secrets and Security

| Secret | Type | Description |
|--------|------|-------------|
| `EIA_API_KEY` | GENERIC_STRING | EIA Open Data API key. |
| `NOAA_CDO_TOKEN` | GENERIC_STRING | NOAA CDO Web Services token. |

External access integration: `APERTURE_API_ACCESS` (allows HTTPS calls to EIA, NOAA, GDELT endpoints).

---

## Cross-Source Relationship Map

These relationships are NOT enforced in SQL joins. They exist conceptually and are
discovered by the application layer (Claude + VizQL Data Service) at query time.

| Relationship | Join Key | Notes |
|-------------|----------|-------|
| Prices <-> Inventory | `PRICE_DATE` ~ `REPORT_DATE` (nearest date) | Both EIA, different frequencies (daily vs weekly). |
| Prices <-> STEO | `PRICE_DATE` ~ `FORECAST_MONTH` (truncate to month) | Actuals vs forecasts. |
| Inventory <-> Weather | `PADD_ID` + date proximity | Both have PADD-level grain. Weather affects demand. |
| Geopolitical <-> Prices | `EVENT_DATE` ~ `PRICE_DATE` (nearest date) | Geopolitical events can drive price movement. |
| Geopolitical <-> Inventory | `PRIMARY_PADD_IMPACT` ~ `PADD_ID` + date | Country events affect regional supply. |

These are hints for Claude's analysis — the warehouse intentionally does not pre-join them.
