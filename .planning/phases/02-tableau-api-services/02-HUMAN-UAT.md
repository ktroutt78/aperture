---
status: passed
phase: 02-tableau-api-services
source: [02-VERIFICATION.md]
started: 2026-04-11T15:10:00Z
updated: 2026-04-11T15:48:00Z
---

## Current Test

[all complete]

## Tests

### 1. Live Metadata API datasource query against the sandbox
expected: Running `pnpm --filter @aperture/backend smoke:metadata -- --datasource <EIA Prices LUID>` with `.env` populated prints a SchemaContext whose first field has all five keys (name, caption, dataType, description, upstreamLineage) and exits 0 with `[smoke] PASS: first field has all required keys (TAPI-01)`
result: passed
evidence: 16 SchemaFields returned for MART_EIA_PRICES (LUID e1e21925-6e00-49a0-a8ff-d6115adde23d) including "Wti Price Usd" (REAL), "Brent Price Usd" (REAL), "Price Date" (DATE), "Jet Fuel Price Usd" (REAL). All five SchemaField keys populated.
fix_required: yes — commit f3b71a5 dropped `Column.fullyQualifiedName` from the GraphQL fragment (live API rejected it with FieldUndefined). Lineage now uses Column.name only.

### 2. Live Metadata API workbook query against the sandbox
expected: Running `pnpm --filter @aperture/backend smoke:metadata -- --workbook <workbook LUID>` prints a WorkbookMetadata with a populated worksheets array whose first worksheet exposes `connectedDatasourceLuids` and exits 0 with `[smoke] PASS: workbook "<name>" with N worksheet(s) (TAPI-02)`
result: passed
evidence: "Average Weekly Crude Price" workbook (040285a4-00e9-4b46-b1c7-0ffb3b2ad9e5) → 1 worksheet → connected datasource LUID resolved back to MART_EIA_PRICES (e1e21925-...). Round-trip correct.
fix_required: yes — commit fd60fbd corrected two GraphQL schema mismatches: (a) Workbook.sheets is the concrete `Sheet` OBJECT type (no `... on Worksheet` fragment); (b) Sheet.upstreamDatasources returns the `Datasource` interface where `luid` only exists on the `PublishedDatasource` concrete type — wrapped in `... on PublishedDatasource { luid }`.

### 3. Live VizQL Data Service query with observable transport
expected: Running `pnpm --filter @aperture/backend smoke:vizql -- --datasource <EIA Prices LUID> --field "Price" --field "Region"` prints `transport=sse` or `transport=json`, `rows<=500`, and exits 0 with `[smoke] PASS: rows=<n> (<= 500), transport=<t> (TAPI-03/05)`. Observe which transport the sandbox actually served so the SSE-vs-JSON fallback path is empirically confirmed.
result: passed
evidence: 500 rows returned with real WTI Price + Price Date data (first row: Wti Price Usd=124.72, Price Date=2008-07-28). Transport empirically observed: **JSON** — sandbox does not serve SSE, so the JSON fallback path is now live-verified working.
fix_required: yes — commit c7325a7 dropped `interpretFieldCaptionsAsFieldNames: true` from the VDS request body. The flag is rejected by Tableau VDS with `404934 Unrecognized field in request`. CLAUDE.md was wrong about this being a hard invariant; field captions are matched natively when fields use the `fieldCaption` key (which they already do).

### 4. Live Pulse happy path against the EIA Prices datasource
expected: Running `pnpm --filter @aperture/backend smoke:pulse -- --datasource <EIA Prices LUID>` prints a PulseContext with `hasMetrics: true`, `metricCount >= 1`, `firstMetricName: "WTI Crude Oil Price"` (or whichever Pulse metric is attached to the EIA Prices datasource), and exits 0 with `[smoke] PASS: PulseContext has N metric(s), M bundle(s), F feedback entries (TAPI-07/08/09)`. If the live paths differ from the plan's assumed `/api/-/pulse/*` URLs, update `pulseService.ts` and document in a follow-up.
result: passed (with TAPI-08/09 partial — see notes)
evidence: hasMetrics=true, metricCount=1, firstMetricName="WTI Crude Oil Price", bundleCount=0, feedbackCount=0. TAPI-07 (definition discovery) live-verified end-to-end.
fix_required: yes — commit 271010c made three Pulse fixes: (a) dropped `?datasource_luid=` query param (Tableau Pulse REST does not accept any server-side filter — must filter client-side); (b) parser now reads `metadata.id` instead of top-level `id` (Pulse nests it under metadata); (c) HTTP 400 added to graceful-degradation set alongside 404/403.
notes_tapi_08_09: Bundle generation endpoint shape on this Tableau Cloud version does not match any documented Pulse REST pattern — `/api/-/pulse/insights:generate`, `metrics/<id>:generateInsightBundle`, `metrics:generateInsightBundle`, `insightBundles:generate`, and 5 other variations all return 404 or 405. The existing per-metric `Promise.allSettled` graceful degradation handles this correctly: bundleCount stays 0 and the WARN log fires once per metric. The `/user/preferences` endpoint exists and returns 200 but the response shape does NOT include an `insight_feedback` field — the feedback array is naturally empty. Both TAPI-08 (insights) and TAPI-09 (feedback) are tracked as `partial` in 02-VERIFICATION.md and will be revisited during Phase 3 when the actual consumer (Context Assembler → Claude) starts making demands on the bundle text.

### 5. End-to-end Phase 2 harness with credentials + all LUIDs supplied
expected: Running `pnpm --filter @aperture/backend smoke:phase2 -- --datasource <EIA> --workbook <wb> --field "Price"` reaches each child script with live credentials + LUIDs and prints four PASS lines in the summary — including the live happy-path PASS from each service (not just cold-boot passes) and the offline TAPI-10 PASS. Final line: `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)`.
result: passed
evidence: Live composite run with --datasource e1e21925-... --workbook 040285a4-... --field "Wti Price Usd" --field "Price Date" → all four child scripts PASS (Metadata API live, VizQL Data Svc live, Pulse REST live with hasMetrics:true, Pulse empty offline). Final line: "ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)".

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

### TAPI-08 / TAPI-09 partial — Pulse insight bundle endpoint discovery
status: deferred
severity: low
debug_session: none
description: Tableau Pulse REST insight-bundle generation endpoint shape is unknown on this Tableau Cloud version. Architecture is sound (per-metric graceful degradation), so bundleCount/feedbackCount return 0 without crashing. Discovery is best done in Phase 3 when the Context Assembler starts feeding bundle text into Claude — that will surface the right shape empirically.
how_to_close: Probe the live endpoint while building the Phase 3 Context Assembler. The `/user/preferences` endpoint is the parallel question for TAPI-09 (feedback) and may live under a different Pulse subpath entirely (e.g., a per-metric reaction endpoint).
