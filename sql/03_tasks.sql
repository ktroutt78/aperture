-- =============================================================================
-- Aperture Energy Intelligence — Snowflake Tasks
-- Database: APERTURE_DB  |  Schema: ENERGY
-- Run as: SYSADMIN
--
-- Tasks are created in SUSPENDED state by default.
-- After backfilling historical data and verifying API keys work, resume with:
--   ALTER TASK APERTURE_DB.ENERGY.TASK_DAILY_EIA_PRICES RESUME;
--   ALTER TASK APERTURE_DB.ENERGY.TASK_DAILY_NOAA_WEATHER RESUME;
--   ALTER TASK APERTURE_DB.ENERGY.TASK_WEEKLY_EIA_INVENTORY RESUME;
--   ALTER TASK APERTURE_DB.ENERGY.TASK_WEEKLY_GDELT_EVENTS RESUME;
--   ALTER TASK APERTURE_DB.ENERGY.TASK_MONTHLY_EIA_STEO RESUME;
-- =============================================================================

USE ROLE SYSADMIN;
USE WAREHOUSE COMPUTE_WH;
USE DATABASE APERTURE_DB;
USE SCHEMA ENERGY;

-- ---- 1. Daily EIA Prices ----
-- Refreshes WTI, Brent, gasoline, jet fuel, diesel spot prices.
-- Schedule: 7 AM ET daily (EIA updates overnight).
CREATE OR REPLACE TASK APERTURE_DB.ENERGY.TASK_DAILY_EIA_PRICES
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 0 7 * * * America/New_York'
  COMMENT = 'Daily EIA price refresh at 7 AM ET (after market data updates)'
AS
  CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_PRICES();

-- ---- 2. Daily NOAA Weather ----
-- Refreshes temperature and degree-day data aggregated by PADD region.
-- Schedule: 8:30 AM ET daily (staggered 90 min after prices).
CREATE OR REPLACE TASK APERTURE_DB.ENERGY.TASK_DAILY_NOAA_WEATHER
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 30 8 * * * America/New_York'
  COMMENT = 'Daily NOAA weather refresh at 8:30 AM ET (staggered after prices)'
AS
  CALL APERTURE_DB.ENERGY.SP_BACKFILL_NOAA_WEATHER();

-- ---- 3. Weekly EIA Inventory ----
-- Refreshes crude oil, gasoline, distillate stock levels by PADD.
-- Schedule: Wednesday noon ET (EIA Weekly Petroleum Status Report at 10:30 AM).
CREATE OR REPLACE TASK APERTURE_DB.ENERGY.TASK_WEEKLY_EIA_INVENTORY
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 0 12 * * 3 America/New_York'
  COMMENT = 'Weekly EIA inventory refresh — Wednesday noon ET (after 10:30 AM EIA release)'
AS
  CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_INVENTORY();

-- ---- 4. Weekly GDELT Events ----
-- Refreshes geopolitical tension scores for energy-relevant countries.
-- Schedule: Sunday 6 AM ET (low-activity window, summarizes prior week).
CREATE OR REPLACE TASK APERTURE_DB.ENERGY.TASK_WEEKLY_GDELT_EVENTS
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 0 6 * * 0 America/New_York'
  COMMENT = 'Weekly GDELT geopolitical event refresh — Sunday 6 AM ET'
AS
  CALL APERTURE_DB.ENERGY.SP_BACKFILL_GDELT_EVENTS();

-- ---- 5. Monthly EIA STEO Forecasts ----
-- Refreshes Short Term Energy Outlook price/production forecasts.
-- Schedule: 10th of each month at 2 PM ET (EIA releases STEO ~7th-10th).
CREATE OR REPLACE TASK APERTURE_DB.ENERGY.TASK_MONTHLY_EIA_STEO
  WAREHOUSE = COMPUTE_WH
  SCHEDULE = 'USING CRON 0 14 10 * * America/New_York'
  COMMENT = 'Monthly STEO forecast refresh — 10th of month 2 PM ET (after EIA STEO release)'
AS
  CALL APERTURE_DB.ENERGY.SP_BACKFILL_EIA_STEO();
