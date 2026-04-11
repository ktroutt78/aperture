-- =============================================================================
-- Aperture Energy Intelligence — Backfill Stored Procedures
-- Database: APERTURE_DB  |  Schema: ENERGY
-- Run as: SYSADMIN
--
-- Prerequisites:
--   1. Run 01_ddl.sql first
--   2. Set your API keys:
--      ALTER SECRET APERTURE_DB.ENERGY.EIA_API_KEY SET SECRET_STRING = 'your_eia_key';
--      ALTER SECRET APERTURE_DB.ENERGY.NOAA_CDO_TOKEN SET SECRET_STRING = 'your_noaa_token';
--   3. Register free keys:
--      - EIA:  https://www.eia.gov/opendata/
--      - NOAA: https://www.ncei.noaa.gov/cdo-web/token
--      - GDELT: No auth required
--
-- Execution order:
--   CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_PRICES();
--   CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_INVENTORY();
--   CALL APERTURE_DB.ENERGY.SP_BACKFILL_NOAA_WEATHER();
--   CALL APERTURE_DB.ENERGY.SP_BACKFILL_GDELT_EVENTS();
--   CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_STEO();
-- =============================================================================

USE ROLE SYSADMIN;
USE WAREHOUSE COMPUTE_WH;
USE DATABASE APERTURE_DB;
USE SCHEMA ENERGY;

-- ---- Secrets for API keys ----
CREATE OR REPLACE SECRET APERTURE_DB.ENERGY.EIA_API_KEY
  TYPE = GENERIC_STRING
  SECRET_STRING = 'REPLACE_WITH_YOUR_EIA_API_KEY'
  COMMENT = 'EIA Open Data API key — register free at https://www.eia.gov/opendata/';

CREATE OR REPLACE SECRET APERTURE_DB.ENERGY.NOAA_CDO_TOKEN
  TYPE = GENERIC_STRING
  SECRET_STRING = 'REPLACE_WITH_YOUR_NOAA_CDO_TOKEN'
  COMMENT = 'NOAA CDO Web Services token — register free at https://www.ncei.noaa.gov/cdo-web/token';

-- Update external access integration to include secrets
CREATE OR REPLACE EXTERNAL ACCESS INTEGRATION APERTURE_API_ACCESS
  ALLOWED_NETWORK_RULES = (APERTURE_DB.ENERGY.APERTURE_API_NETWORK_RULE)
  ALLOWED_AUTHENTICATION_SECRETS = (APERTURE_DB.ENERGY.EIA_API_KEY, APERTURE_DB.ENERGY.NOAA_CDO_TOKEN)
  ENABLED = TRUE
  COMMENT = 'External access for Aperture energy data pipeline API calls';

-- ============================================================================
-- 1. SP_BACKFILL_EIA_PRICES
--    Pulls 3 years of daily petroleum spot prices from EIA API v2.
--    Series: WTI, Brent, Jet Fuel (gasoline/diesel via SP_BACKFILL_EIA_RETAIL_PRICES)
--    Idempotent via MERGE on (PRICE_DATE, SERIES_ID).
-- ============================================================================
CREATE OR REPLACE PROCEDURE APERTURE_DB.ENERGY.SP_BACKFILL_EIA_PRICES()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (APERTURE_API_ACCESS)
SECRETS = ('eia_key' = APERTURE_DB.ENERGY.EIA_API_KEY)
EXECUTE AS CALLER
AS
$$
import _snowflake
import requests
import json
from datetime import datetime, timedelta

def run(session):
    proc_name = 'SP_BACKFILL_EIA_PRICES'
    source = 'EIA_PRICES'
    api_key = _snowflake.get_generic_secret_string('eia_key')

    if api_key == 'REPLACE_WITH_YOUR_EIA_API_KEY':
        msg = 'EIA API key not configured.'
        session.sql(f"""
            INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME, PROCEDURE_NAME, STATUS, MESSAGE)
            VALUES ('{source}', '{proc_name}', 'SKIPPED', '{msg}')
        """).collect()
        return msg

    # NOTE: Gasoline and Diesel retail prices use the v2 faceted endpoint
    # and are loaded by SP_BACKFILL_EIA_RETAIL_PRICES (series IDs:
    # EMM_EPM0_PTE_NUS_DPG, EMD_EPD2DXL0_PTE_NUS_DPG).
    series_map = {
        'PET.RWTC.D':  ('WTI Crude Oil', 'USD/barrel', 0),
        'PET.RBRTE.D': ('Brent Crude Oil', 'USD/barrel', 0),
        'PET.EER_EPJK_PF4_RGC_DPG.D': ('Jet Fuel Gulf Coast', 'USD/gallon', 3),
    }

    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3*365)).strftime('%Y-%m-%d')
    total_rows = 0

    for series_id, (product_name, unit, padd_id) in series_map.items():
        try:
            url = 'https://api.eia.gov/v2/seriesid/' + series_id
            params = {'api_key': api_key, 'start': start_date, 'end': end_date}
            resp = requests.get(url, params=params, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            response_data = data.get('response', data)
            rows = response_data.get('data', [])
            if not rows:
                continue

            batch_size = 500
            for i in range(0, len(rows), batch_size):
                batch = rows[i:i+batch_size]
                values = []
                for row in batch:
                    period = row.get('period', row.get('date', ''))
                    value = row.get('value')
                    if period and value is not None:
                        try:
                            price = float(value)
                            safe_product = product_name.replace("'", "''")
                            values.append(
                                f"('{period}', '{series_id}', '{safe_product}', "
                                f"{price}, '{unit}', {padd_id})")
                        except (ValueError, TypeError):
                            continue
                if values:
                    values_str = ',\n'.join(values)
                    session.sql(f"""
                        MERGE INTO APERTURE_DB.ENERGY.FACT_EIA_PRICES tgt
                        USING (
                            SELECT TO_DATE(column1) AS PRICE_DATE, column2 AS SERIES_ID,
                                   column3 AS PRODUCT_NAME, column4::FLOAT AS PRICE_USD,
                                   column5 AS PRICE_UNIT, column6::SMALLINT AS PADD_ID
                            FROM VALUES {values_str}
                        ) src ON tgt.PRICE_DATE = src.PRICE_DATE AND tgt.SERIES_ID = src.SERIES_ID
                        WHEN MATCHED THEN UPDATE SET tgt.PRICE_USD = src.PRICE_USD, tgt.LOADED_AT = CURRENT_TIMESTAMP()
                        WHEN NOT MATCHED THEN INSERT (PRICE_DATE, SERIES_ID, PRODUCT_NAME, PRICE_USD, PRICE_UNIT, PADD_ID)
                        VALUES (src.PRICE_DATE, src.SERIES_ID, src.PRODUCT_NAME, src.PRICE_USD, src.PRICE_UNIT, src.PADD_ID)
                    """).collect()
                    total_rows += len(values)
        except Exception as e:
            error_msg = str(e).replace("'", "''")[:3900]
            session.sql(f"""
                INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME, PROCEDURE_NAME, STATUS, MESSAGE, ERROR_DETAIL)
                VALUES ('{source}', '{proc_name}', 'ERROR', 'Failed for series {series_id}', '{error_msg}')
            """).collect()
            continue

    session.sql(f"""
        INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME, PROCEDURE_NAME, STATUS, ROWS_AFFECTED, MESSAGE)
        VALUES ('{source}', '{proc_name}', 'SUCCESS', {total_rows}, 'Backfill complete: {total_rows} rows merged')
    """).collect()
    return f'SUCCESS: {total_rows} price rows merged'
$$;

-- ============================================================================
-- 2. SP_BACKFILL_EIA_INVENTORY
--    Pulls 3 years of weekly petroleum inventory levels by PADD region.
--    Computes weekly change as difference from prior week.
--    Idempotent via MERGE on (REPORT_DATE, SERIES_ID, PADD_ID).
-- ============================================================================
CREATE OR REPLACE PROCEDURE APERTURE_DB.ENERGY.SP_BACKFILL_EIA_INVENTORY()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (APERTURE_API_ACCESS)
SECRETS = ('eia_key' = APERTURE_DB.ENERGY.EIA_API_KEY)
EXECUTE AS CALLER
AS
$$
import _snowflake
import requests
from datetime import datetime, timedelta

def run(session):
    proc_name = 'SP_BACKFILL_EIA_INVENTORY'
    source = 'EIA_INVENTORY'
    api_key = _snowflake.get_generic_secret_string('eia_key')

    if api_key == 'REPLACE_WITH_YOUR_EIA_API_KEY':
        session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME, PROCEDURE_NAME, STATUS, MESSAGE) VALUES ('{source}', '{proc_name}', 'SKIPPED', 'EIA API key not configured.')").collect()
        return 'EIA API key not configured.'

    series_map = {
        'PET.WCESTUS1.W': ('Crude Oil Stocks', 0),
        'PET.WCESTP11.W': ('Crude Oil Stocks PADD1', 1),
        'PET.WCESTP21.W': ('Crude Oil Stocks PADD2', 2),
        'PET.WCESTP31.W': ('Crude Oil Stocks PADD3', 3),
        'PET.WCESTP41.W': ('Crude Oil Stocks PADD4', 4),
        'PET.WCESTP51.W': ('Crude Oil Stocks PADD5', 5),
        'PET.WTTSTUS1.W': ('Total Petroleum Stocks', 0),
        'PET.WGTSTUS1.W': ('Motor Gasoline Stocks', 0),
        'PET.WDISTUS1.W': ('Distillate Fuel Oil Stocks', 0),
    }
    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3*365)).strftime('%Y-%m-%d')
    total_rows = 0

    for series_id, (product_name, padd_id) in series_map.items():
        try:
            resp = requests.get(f'https://api.eia.gov/v2/seriesid/{series_id}',
                                params={'api_key': api_key, 'start': start_date, 'end': end_date}, timeout=60)
            resp.raise_for_status()
            data = resp.json()
            rows = data.get('response', data).get('data', [])
            if not rows: continue

            sorted_rows = sorted(rows, key=lambda r: r.get('period', ''))
            prev_value = None
            values = []
            for row in sorted_rows:
                period = row.get('period', row.get('date', ''))
                value = row.get('value')
                if period and value is not None:
                    try:
                        inv = float(value)
                        change = round(inv - prev_value, 1) if prev_value is not None else None
                        change_str = str(change) if change is not None else 'NULL'
                        safe_name = product_name.replace("'", "''")
                        values.append(f"('{period}', '{series_id}', '{safe_name}', {padd_id}, {inv}, {change_str})")
                        prev_value = inv
                    except (ValueError, TypeError): continue

            for vi in range(0, len(values), 500):
                batch = values[vi:vi+500]
                values_str = ',\n'.join(batch)
                session.sql(f"""
                    MERGE INTO APERTURE_DB.ENERGY.FACT_EIA_INVENTORY tgt
                    USING (SELECT TO_DATE(column1) AS REPORT_DATE, column2 AS SERIES_ID, column3 AS PRODUCT_NAME,
                                  column4::SMALLINT AS PADD_ID, column5::FLOAT AS INVENTORY_THOUSAND_BARRELS,
                                  column6::FLOAT AS WEEKLY_CHANGE_THOUSAND_BARRELS
                           FROM VALUES {values_str}) src
                    ON tgt.REPORT_DATE=src.REPORT_DATE AND tgt.SERIES_ID=src.SERIES_ID AND tgt.PADD_ID=src.PADD_ID
                    WHEN MATCHED THEN UPDATE SET tgt.INVENTORY_THOUSAND_BARRELS=src.INVENTORY_THOUSAND_BARRELS,
                        tgt.WEEKLY_CHANGE_THOUSAND_BARRELS=src.WEEKLY_CHANGE_THOUSAND_BARRELS, tgt.LOADED_AT=CURRENT_TIMESTAMP()
                    WHEN NOT MATCHED THEN INSERT (REPORT_DATE,SERIES_ID,PRODUCT_NAME,PADD_ID,INVENTORY_THOUSAND_BARRELS,WEEKLY_CHANGE_THOUSAND_BARRELS)
                    VALUES (src.REPORT_DATE,src.SERIES_ID,src.PRODUCT_NAME,src.PADD_ID,src.INVENTORY_THOUSAND_BARRELS,src.WEEKLY_CHANGE_THOUSAND_BARRELS)
                """).collect()
                total_rows += len(batch)
        except Exception as e:
            error_msg = str(e).replace("'", "''")[:3900]
            session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE,ERROR_DETAIL) VALUES ('{source}','{proc_name}','ERROR','Failed {series_id}','{error_msg}')").collect()
            continue

    session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,ROWS_AFFECTED,MESSAGE) VALUES ('{source}','{proc_name}','SUCCESS',{total_rows},'Backfill: {total_rows} rows')").collect()
    return f'SUCCESS: {total_rows} inventory rows merged'
$$;

-- ============================================================================
-- 3. SP_BACKFILL_NOAA_WEATHER
--    Pulls 3 years of daily GHCND data (TMAX, TMIN, TAVG) from NOAA CDO API.
--    Aggregates station observations to PADD-level daily averages.
--    Computes heating/cooling degree days (base 65F).
--    Idempotent via MERGE on (OBSERVATION_DATE, PADD_ID).
-- ============================================================================
CREATE OR REPLACE PROCEDURE APERTURE_DB.ENERGY.SP_BACKFILL_NOAA_WEATHER()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (APERTURE_API_ACCESS)
SECRETS = ('noaa_token' = APERTURE_DB.ENERGY.NOAA_CDO_TOKEN)
EXECUTE AS CALLER
AS
$$
import _snowflake
import requests
import time
from datetime import datetime, timedelta

def run(session):
    proc_name = 'SP_BACKFILL_NOAA_WEATHER'
    source = 'NOAA_WEATHER'
    token = _snowflake.get_generic_secret_string('noaa_token')

    if token == 'REPLACE_WITH_YOUR_NOAA_CDO_TOKEN':
        session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE) VALUES ('{source}','{proc_name}','SKIPPED','NOAA CDO token not configured.')").collect()
        return 'NOAA CDO token not configured.'

    station_rows = session.sql("SELECT NOAA_STATION_ID, PADD_ID FROM APERTURE_DB.ENERGY.DIM_NOAA_STATION_PADD_MAP WHERE NOAA_STATION_ID IS NOT NULL").collect()
    padd_stations = {}
    for r in station_rows:
        padd_stations.setdefault(r['PADD_ID'], []).append(r['NOAA_STATION_ID'])

    end_date = datetime.now()
    start_date = end_date - timedelta(days=3*365)
    total_rows = 0
    base_url = 'https://www.ncei.noaa.gov/cdo-web/api/v2/data'
    headers = {'token': token}

    for padd_id, stations in padd_stations.items():
        chunk_start = start_date
        while chunk_start < end_date:
            chunk_end = min(chunk_start + timedelta(days=364), end_date)
            try:
                params = {'datasetid': 'GHCND', 'datatypeid': 'TMAX,TMIN,TAVG',
                    'stationid': ','.join([f'GHCND:{s}' for s in stations[:5]]),
                    'startdate': chunk_start.strftime('%Y-%m-%d'), 'enddate': chunk_end.strftime('%Y-%m-%d'),
                    'units': 'standard', 'limit': 1000, 'offset': 1}
                all_obs = []
                while True:
                    time.sleep(0.25)
                    resp = requests.get(base_url, headers=headers, params=params, timeout=60)
                    if resp.status_code == 429: time.sleep(2); continue
                    resp.raise_for_status()
                    data = resp.json()
                    results = data.get('results', [])
                    if not results: break
                    all_obs.extend(results)
                    meta = data.get('metadata', {}).get('resultset', {})
                    if meta.get('offset', 0) + len(results) >= meta.get('count', 0): break
                    params['offset'] = meta.get('offset', 0) + len(results)

                daily = {}
                for obs in all_obs:
                    d = obs.get('date', '')[:10]
                    dt = obs.get('datatype', '')
                    v = obs.get('value')
                    if d and v is not None:
                        daily.setdefault(d, {'TMAX':[],'TMIN':[],'TAVG':[]}).setdefault(dt, [])
                        if dt in daily[d]: daily[d][dt].append(float(v))

                values = []
                for d, t in daily.items():
                    tavg = t.get('TAVG',[]); tmax = t.get('TMAX',[]); tmin = t.get('TMIN',[])
                    avg_t = sum(tavg)/len(tavg) if tavg else ((sum(tmax)/len(tmax)+sum(tmin)/len(tmin))/2 if tmax and tmin else None)
                    if avg_t is not None:
                        hdd = max(65.0-avg_t,0); cdd = max(avg_t-65.0,0)
                        min_s = str(round(min(tmin),1)) if tmin else 'NULL'
                        max_s = str(round(max(tmax),1)) if tmax else 'NULL'
                        sc = max(len(tmax),len(tmin),len(tavg))
                        values.append(f"('{d}',{padd_id},{round(avg_t,1)},{min_s},{max_s},{round(hdd,1)},{round(cdd,1)},{sc})")

                for vi in range(0, len(values), 500):
                    batch = values[vi:vi+500]
                    session.sql(f"""
                        MERGE INTO APERTURE_DB.ENERGY.FACT_NOAA_WEATHER tgt
                        USING (SELECT TO_DATE(column1) AS OBSERVATION_DATE, column2::SMALLINT AS PADD_ID,
                                      column3::FLOAT AS AVG_TEMP_F, column4::FLOAT AS MIN_TEMP_F, column5::FLOAT AS MAX_TEMP_F,
                                      column6::FLOAT AS HEATING_DEGREE_DAYS, column7::FLOAT AS COOLING_DEGREE_DAYS, column8::INTEGER AS STATION_COUNT
                               FROM VALUES {','.join(batch)}) src
                        ON tgt.OBSERVATION_DATE=src.OBSERVATION_DATE AND tgt.PADD_ID=src.PADD_ID
                        WHEN MATCHED THEN UPDATE SET tgt.AVG_TEMP_F=src.AVG_TEMP_F, tgt.MIN_TEMP_F=src.MIN_TEMP_F, tgt.MAX_TEMP_F=src.MAX_TEMP_F,
                            tgt.HEATING_DEGREE_DAYS=src.HEATING_DEGREE_DAYS, tgt.COOLING_DEGREE_DAYS=src.COOLING_DEGREE_DAYS, tgt.STATION_COUNT=src.STATION_COUNT, tgt.LOADED_AT=CURRENT_TIMESTAMP()
                        WHEN NOT MATCHED THEN INSERT (OBSERVATION_DATE,PADD_ID,AVG_TEMP_F,MIN_TEMP_F,MAX_TEMP_F,HEATING_DEGREE_DAYS,COOLING_DEGREE_DAYS,STATION_COUNT)
                        VALUES (src.OBSERVATION_DATE,src.PADD_ID,src.AVG_TEMP_F,src.MIN_TEMP_F,src.MAX_TEMP_F,src.HEATING_DEGREE_DAYS,src.COOLING_DEGREE_DAYS,src.STATION_COUNT)
                    """).collect()
                    total_rows += len(batch)
            except Exception as e:
                error_msg = str(e).replace("'","''")[:3900]
                session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE,ERROR_DETAIL) VALUES ('{source}','{proc_name}','ERROR','PADD {padd_id} chunk {chunk_start.strftime(\"%Y-%m-%d\")}','{error_msg}')").collect()
            chunk_start = chunk_end + timedelta(days=1)

    session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,ROWS_AFFECTED,MESSAGE) VALUES ('{source}','{proc_name}','SUCCESS',{total_rows},'Backfill: {total_rows} weather rows')").collect()
    return f'SUCCESS: {total_rows} weather rows merged'
$$;

-- ============================================================================
-- 4. SP_BACKFILL_GDELT_EVENTS
--    Pulls 3 years of weekly geopolitical event summaries from GDELT DOC API.
--    Filters by energy-relevant countries (from DIM_GDELT_COUNTRY_PADD_MAP)
--    and energy-related keywords.
--    Computes tension score (0-10) from tone analysis.
--    No auth required. Idempotent via MERGE on (EVENT_DATE, COUNTRY_CODE).
-- ============================================================================
CREATE OR REPLACE PROCEDURE APERTURE_DB.ENERGY.SP_BACKFILL_GDELT_EVENTS()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (APERTURE_API_ACCESS)
EXECUTE AS CALLER
AS
$$
import requests
import time
import csv
import io
from datetime import datetime, timedelta

def run(session):
    proc_name = 'SP_BACKFILL_GDELT_EVENTS'
    source = 'GDELT_EVENTS'

    country_rows = session.sql("SELECT COUNTRY_CODE, COUNTRY_NAME, PRIMARY_PADD_IMPACT FROM APERTURE_DB.ENERGY.DIM_GDELT_COUNTRY_PADD_MAP").collect()
    countries = {r['COUNTRY_CODE']: (r['COUNTRY_NAME'], r['PRIMARY_PADD_IMPACT']) for r in country_rows}

    end_date = datetime.now()
    start_date = end_date - timedelta(days=3*365)
    total_rows = 0
    base_url = 'https://api.gdeltproject.org/api/v2/doc/doc'

    current = start_date
    while current < end_date:
        week_end = min(current + timedelta(days=6), end_date)
        start_str = current.strftime('%Y%m%d%H%M%S')
        end_str = week_end.strftime('%Y%m%d%H%M%S')

        for cc in countries:
            cn, padd = countries[cc]
            try:
                params = {'query': f'sourcelang:english sourcecountry:{cc.lower()} (oil OR petroleum OR crude OR energy OR OPEC OR sanctions OR pipeline)',
                          'mode': 'timelinetone', 'startdatetime': start_str, 'enddatetime': end_str, 'format': 'csv'}
                time.sleep(0.5)
                resp = requests.get(base_url, params=params, timeout=30)
                if resp.status_code != 200: continue
                content = resp.text.strip()
                if not content or len(content) < 10: continue

                reader = csv.reader(io.StringIO(content))
                tones, volumes = [], []
                for rd in reader:
                    if len(rd) < 3: continue
                    try: tones.append(float(rd[1])); volumes.append(int(float(rd[2])))
                    except: continue

                if not tones: continue
                avg_tone = round(sum(tones)/len(tones), 3)
                total_ev = sum(volumes)
                conflict = sum(1 for t in tones if t < -2)
                coop = sum(1 for t in tones if t > 2)
                goldstein = round(avg_tone/5.0, 3)
                tension = round(max(0, min(10, 5-avg_tone)), 2)
                ed = current.strftime('%Y-%m-%d')
                safe = cn.replace("'","''")
                ps = str(padd) if padd is not None else 'NULL'

                session.sql(f"""
                    MERGE INTO APERTURE_DB.ENERGY.FACT_GDELT_EVENTS tgt
                    USING (SELECT TO_DATE('{ed}') AS EVENT_DATE, '{cc}' AS COUNTRY_CODE, '{safe}' AS COUNTRY_NAME,
                                  {avg_tone} AS AVG_TONE, {goldstein} AS AVG_GOLDSTEIN_SCALE, {total_ev} AS EVENT_COUNT,
                                  {conflict} AS CONFLICT_EVENT_COUNT, {coop} AS COOPERATION_EVENT_COUNT,
                                  {tension} AS GEOPOLITICAL_TENSION_SCORE, {ps}::SMALLINT AS PRIMARY_PADD_IMPACT) src
                    ON tgt.EVENT_DATE=src.EVENT_DATE AND tgt.COUNTRY_CODE=src.COUNTRY_CODE
                    WHEN MATCHED THEN UPDATE SET tgt.AVG_TONE=src.AVG_TONE, tgt.AVG_GOLDSTEIN_SCALE=src.AVG_GOLDSTEIN_SCALE,
                        tgt.EVENT_COUNT=src.EVENT_COUNT, tgt.CONFLICT_EVENT_COUNT=src.CONFLICT_EVENT_COUNT,
                        tgt.COOPERATION_EVENT_COUNT=src.COOPERATION_EVENT_COUNT, tgt.GEOPOLITICAL_TENSION_SCORE=src.GEOPOLITICAL_TENSION_SCORE, tgt.LOADED_AT=CURRENT_TIMESTAMP()
                    WHEN NOT MATCHED THEN INSERT (EVENT_DATE,COUNTRY_CODE,COUNTRY_NAME,AVG_TONE,AVG_GOLDSTEIN_SCALE,EVENT_COUNT,CONFLICT_EVENT_COUNT,COOPERATION_EVENT_COUNT,GEOPOLITICAL_TENSION_SCORE,PRIMARY_PADD_IMPACT)
                    VALUES (src.EVENT_DATE,src.COUNTRY_CODE,src.COUNTRY_NAME,src.AVG_TONE,src.AVG_GOLDSTEIN_SCALE,src.EVENT_COUNT,src.CONFLICT_EVENT_COUNT,src.COOPERATION_EVENT_COUNT,src.GEOPOLITICAL_TENSION_SCORE,src.PRIMARY_PADD_IMPACT)
                """).collect()
                total_rows += 1
            except Exception as e:
                error_msg = str(e).replace("'","''")[:3900]
                session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE,ERROR_DETAIL) VALUES ('{source}','{proc_name}','ERROR','{cc} week {current.strftime(\"%Y-%m-%d\")}','{error_msg}')").collect()
                continue
        current = week_end + timedelta(days=1)

    session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,ROWS_AFFECTED,MESSAGE) VALUES ('{source}','{proc_name}','SUCCESS',{total_rows},'Backfill: {total_rows} GDELT rows')").collect()
    return f'SUCCESS: {total_rows} GDELT event rows merged'
$$;

-- ============================================================================
-- 5. SP_BACKFILL_EIA_STEO
--    Pulls 3 years of monthly STEO (Short Term Energy Outlook) forecasts.
--    Series: WTI/Brent price, production, consumption, natural gas, exports/imports.
--    Idempotent via MERGE on (FORECAST_MONTH, SERIES_ID).
-- ============================================================================
CREATE OR REPLACE PROCEDURE APERTURE_DB.ENERGY.SP_BACKFILL_EIA_STEO()
RETURNS STRING
LANGUAGE PYTHON
RUNTIME_VERSION = '3.11'
PACKAGES = ('snowflake-snowpark-python', 'requests')
HANDLER = 'run'
EXTERNAL_ACCESS_INTEGRATIONS = (APERTURE_API_ACCESS)
SECRETS = ('eia_key' = APERTURE_DB.ENERGY.EIA_API_KEY)
EXECUTE AS CALLER
AS
$$
import _snowflake
import requests
from datetime import datetime, timedelta

def run(session):
    proc_name = 'SP_BACKFILL_EIA_STEO'
    source = 'EIA_STEO'
    api_key = _snowflake.get_generic_secret_string('eia_key')

    if api_key == 'REPLACE_WITH_YOUR_EIA_API_KEY':
        session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE) VALUES ('{source}','{proc_name}','SKIPPED','EIA API key not configured.')").collect()
        return 'EIA API key not configured.'

    series_map = {
        'STEO.BREPUUS.M':  ('WTI Crude Oil Price Forecast', 'USD/barrel'),
        'STEO.BRIPUUS.M':  ('Brent Crude Oil Price Forecast', 'USD/barrel'),
        'STEO.COPRPUS.M':  ('US Crude Oil Production Forecast', 'million barrels/day'),
        'STEO.PAPRPUS.M':  ('US Petroleum Consumption Forecast', 'million barrels/day'),
        'STEO.NGPRPUS.M':  ('US Natural Gas Production Forecast', 'billion cubic feet/day'),
        'STEO.T3EXPUS.M':  ('Total Energy Exports Forecast', 'quadrillion BTU'),
        'STEO.T3IMPUS.M':  ('Total Energy Imports Forecast', 'quadrillion BTU'),
        'STEO.MGEIAUS.M':  ('Motor Gasoline Price Forecast', 'USD/gallon'),
        'STEO.D2RCAUS.M':  ('Diesel Retail Price Forecast', 'USD/gallon'),
    }
    end_date = datetime.now().strftime('%Y-%m-%d')
    start_date = (datetime.now() - timedelta(days=3*365)).strftime('%Y-%m-%d')
    pub_date = datetime.now().strftime('%Y-%m-%d')
    total_rows = 0

    for series_id, (metric_name, unit) in series_map.items():
        try:
            resp = requests.get(f'https://api.eia.gov/v2/seriesid/{series_id}',
                                params={'api_key': api_key, 'start': start_date, 'end': end_date}, timeout=60)
            resp.raise_for_status()
            rows = resp.json().get('response', resp.json()).get('data', [])
            if not rows: continue

            values = []
            for row in rows:
                period = row.get('period', row.get('date', ''))
                value = row.get('value')
                if period and value is not None:
                    try:
                        fval = float(value)
                        if len(period) == 7: period += '-01'
                        safe = metric_name.replace("'","''")
                        values.append(f"('{period}','{series_id}','{safe}',{fval},'{unit}','{pub_date}')")
                    except: continue

            for vi in range(0, len(values), 500):
                batch = values[vi:vi+500]
                session.sql(f"""
                    MERGE INTO APERTURE_DB.ENERGY.FACT_EIA_STEO_FORECASTS tgt
                    USING (SELECT TO_DATE(column1) AS FORECAST_MONTH, column2 AS SERIES_ID, column3 AS METRIC_NAME,
                                  column4::FLOAT AS FORECAST_VALUE, column5 AS FORECAST_UNIT, TO_DATE(column6) AS PUBLICATION_DATE
                           FROM VALUES {','.join(batch)}) src
                    ON tgt.FORECAST_MONTH=src.FORECAST_MONTH AND tgt.SERIES_ID=src.SERIES_ID
                    WHEN MATCHED THEN UPDATE SET tgt.FORECAST_VALUE=src.FORECAST_VALUE, tgt.PUBLICATION_DATE=src.PUBLICATION_DATE, tgt.LOADED_AT=CURRENT_TIMESTAMP()
                    WHEN NOT MATCHED THEN INSERT (FORECAST_MONTH,SERIES_ID,METRIC_NAME,FORECAST_VALUE,FORECAST_UNIT,PUBLICATION_DATE)
                    VALUES (src.FORECAST_MONTH,src.SERIES_ID,src.METRIC_NAME,src.FORECAST_VALUE,src.FORECAST_UNIT,src.PUBLICATION_DATE)
                """).collect()
                total_rows += len(batch)
        except Exception as e:
            error_msg = str(e).replace("'","''")[:3900]
            session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,MESSAGE,ERROR_DETAIL) VALUES ('{source}','{proc_name}','ERROR','Failed {series_id}','{error_msg}')").collect()
            continue

    session.sql(f"INSERT INTO APERTURE_DB.ENERGY.PIPELINE_LOG (SOURCE_NAME,PROCEDURE_NAME,STATUS,ROWS_AFFECTED,MESSAGE) VALUES ('{source}','{proc_name}','SUCCESS',{total_rows},'Backfill: {total_rows} STEO rows')").collect()
    return f'SUCCESS: {total_rows} STEO forecast rows merged'
$$;
