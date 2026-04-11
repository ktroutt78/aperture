---
status: partial
phase: 02-tableau-api-services
source: [02-VERIFICATION.md]
started: 2026-04-11T15:10:00Z
updated: 2026-04-11T15:10:00Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Live Metadata API datasource query against the sandbox
expected: Running `pnpm --filter @aperture/backend smoke:metadata -- --datasource <EIA Prices LUID>` with `.env` populated prints a SchemaContext whose first field has all five keys (name, caption, dataType, description, upstreamLineage) and exits 0 with `[smoke] PASS: first field has all required keys (TAPI-01)`
result: [pending]

### 2. Live Metadata API workbook query against the sandbox
expected: Running `pnpm --filter @aperture/backend smoke:metadata -- --workbook <workbook LUID>` prints a WorkbookMetadata with a populated worksheets array whose first worksheet exposes `connectedDatasourceLuids` and exits 0 with `[smoke] PASS: workbook "<name>" with N worksheet(s) (TAPI-02)`
result: [pending]

### 3. Live VizQL Data Service query with observable transport
expected: Running `pnpm --filter @aperture/backend smoke:vizql -- --datasource <EIA Prices LUID> --field "Price" --field "Region"` prints `transport=sse` or `transport=json`, `rows<=500`, and exits 0 with `[smoke] PASS: rows=<n> (<= 500), transport=<t> (TAPI-03/05)`. Observe which transport the sandbox actually served so the SSE-vs-JSON fallback path is empirically confirmed.
result: [pending]

### 4. Live Pulse happy path against the EIA Prices datasource
expected: Running `pnpm --filter @aperture/backend smoke:pulse -- --datasource <EIA Prices LUID>` prints a PulseContext with `hasMetrics: true`, `metricCount >= 1`, `firstMetricName: "WTI Crude Oil Price"` (or whichever Pulse metric is attached to the EIA Prices datasource), and exits 0 with `[smoke] PASS: PulseContext has N metric(s), M bundle(s), F feedback entries (TAPI-07/08/09)`. If the live paths differ from the plan's assumed `/api/-/pulse/*` URLs, update `pulseService.ts` and document in a follow-up.
result: [pending]

### 5. End-to-end Phase 2 harness with credentials + all LUIDs supplied
expected: Running `pnpm --filter @aperture/backend smoke:phase2 -- --datasource <EIA> --workbook <wb> --field "Price"` reaches each child script with live credentials + LUIDs and prints four PASS lines in the summary — including the live happy-path PASS from each service (not just cold-boot passes) and the offline TAPI-10 PASS. Final line: `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)`.
result: [pending]

## Summary

total: 5
passed: 0
issues: 0
pending: 5
skipped: 0
blocked: 0

## Gaps
