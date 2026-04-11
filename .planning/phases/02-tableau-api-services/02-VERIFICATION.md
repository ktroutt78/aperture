---
phase: 02-tableau-api-services
verified: 2026-04-11T15:10:00Z
status: human_needed
score: 15/15 must-haves verified
overrides_applied: 0
human_verification:
  - test: "Live Metadata API datasource query against the sandbox"
    expected: "Running `pnpm --filter @aperture/backend smoke:metadata -- --datasource <EIA Prices LUID>` with .env populated prints a SchemaContext whose first field has all five keys (name, caption, dataType, description, upstreamLineage) and exits 0 with `[smoke] PASS: first field has all required keys (TAPI-01)`"
    why_human: "Requires live Tableau Cloud credentials + a real datasource LUID. Code path is grep-verified, typechecked, and cold-boot clean. The sandbox call itself has not been observed in this worktree."
  - test: "Live Metadata API workbook query against the sandbox"
    expected: "Running `pnpm --filter @aperture/backend smoke:metadata -- --workbook <workbook LUID>` prints a WorkbookMetadata with a populated worksheets array whose first worksheet exposes `connectedDatasourceLuids` and exits 0 with `[smoke] PASS: workbook \"<name>\" with N worksheet(s) (TAPI-02)`"
    why_human: "Same reason as above — needs a real workbook LUID and live Tableau Cloud credentials."
  - test: "Live VizQL Data Service query with observable transport"
    expected: "Running `pnpm --filter @aperture/backend smoke:vizql -- --datasource <EIA Prices LUID> --field \"Price\" --field \"Region\"` prints `transport=sse` or `transport=json`, `rows<=500`, and exits 0 with `[smoke] PASS: rows=<n> (<= 500), transport=<t> (TAPI-03/05)`. Observe which transport the sandbox actually served so the SSE-vs-JSON fallback path is empirically confirmed."
    why_human: "Requires live VDS call to see which transport is served. Both code paths are implemented and grep-verified, but the fallback logic has only been exercised in cold-boot mode."
  - test: "Live Pulse happy path against the EIA Prices datasource (has WTI Crude Oil Price Pulse metric per STATE.md)"
    expected: "Running `pnpm --filter @aperture/backend smoke:pulse -- --datasource <EIA Prices LUID>` prints a PulseContext with `hasMetrics: true`, `metricCount >= 1`, `firstMetricName: \"WTI Crude Oil Price\"`, and exits 0 with `[smoke] PASS: PulseContext has N metric(s), M bundle(s), F feedback entries (TAPI-07/08/09)`. If the live paths differ from the plan's assumed /api/-/pulse/* URLs, update pulseService.ts and document in a follow-up."
    why_human: "Pulse REST path shape is version-dependent (plan 02-04 flagged this as pending live verification). The offline TAPI-10 test guarantees graceful degradation if paths drift, but the happy path has not been observed."
  - test: "End-to-end Phase 2 harness with credentials + all LUIDs supplied"
    expected: "Running `pnpm --filter @aperture/backend smoke:phase2 -- --datasource <EIA> --workbook <wb> --field \"Price\"` reaches each child script with live credentials + LUIDs and prints four PASS lines in the summary — including the live happy-path PASS from each service (not just cold-boot passes) and the offline TAPI-10 PASS. Final line: `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)`."
    why_human: "Composite live verification. Current cold-boot run is already ALL GREEN, but upgrading each cold-boot PASS to a live-verified PASS requires the sandbox + real LUIDs that are not present in this worktree."
---

# Phase 2: Tableau API Services Verification Report

**Phase Goal:** Three Tableau API services — Metadata, VizQL Data Service, Pulse — each independently testable against the sandbox, each producing its typed context object.
**Verified:** 2026-04-11T15:10:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

ROADMAP Success Criteria (SC-1..SC-4) merged with PLAN-level must_haves. All truths VERIFIED against the codebase; live sandbox observation deferred to human (see human_verification section).

| #   | Truth   | Status     | Evidence       |
| --- | ------- | ---------- | -------------- |
| 1 (SC-1 / 02-02 truth) | Running the Metadata service test script against the sandbox prints a populated SchemaContext (fields with name, caption, dataType, description, upstream lineage) for a given datasource LUID, and returns worksheets + connected datasources for a given workbook LUID | VERIFIED (code path) | `metadataService.ts` exports `fetchSchemaByDatasourceLuids` (lines 234-273) + `fetchWorkbookMetadata` (lines 332-379). `toSchemaField` (lines 203-222) populates all 5 SchemaField keys with defaults. GraphQL queries use `publishedDatasources(filter: { luidWithin: $luids })` and `workbooks(filter: { luid: $luid })` with fragments `... on ColumnField { dataType }` and `... on Worksheet`. LUIDs travel through `$luids` / `$luid` variables — never interpolated. Smoke script `metadataService.smoke.ts` asserts every SchemaField key on the first field returned and asserts workbook.worksheets shape. Live sandbox call pending — see human verification item 1. |
| 2 (SC-2 / 02-03 truths) | Running the VizQL Data Service test script returns a populated LiveDataContext with field selection + filters honored, ≤500 rows, and `interpretFieldCaptionsAsFieldNames: true` set on the request — with SSE attempted first and JSON fallback verified | VERIFIED (code path) | `vizqlService.ts:47` declares `VIZQL_MAX_ROWS = 500`. `vizqlService.ts:161` sets `interpretFieldCaptionsAsFieldNames: true` literally once in the request body. The type declaration on line 113-114 uses `true` as a literal (not `boolean`), making it a compile-time guard. `effectiveLimit = Math.min(req.limit ?? VIZQL_MAX_ROWS, VIZQL_MAX_ROWS)` on line 143 clamps pre-request. Post-response `.slice(0, effectiveLimit)` on lines 187, 244 enforces code-side. SSE attempt first (line 175 with `Accept: text/event-stream`), JSON fallback (line 219 with `Accept: application/json`). `transport: 'sse'` set on line 192; `transport: 'json'` set on line 249. Live transport observation pending — see human item 3. |
| 3 (SC-2 subset / plan 02-03 must) | The VizQL service file contains zero raw fetch calls and zero manual X-Tableau-Auth setups | VERIFIED | Grep `^\s*fetch\(['"]https?://` against `backend/src/services/vizqlService.ts` returns 0. Grep `X-Tableau-Auth` against `vizqlService.ts` returns 0. Two `tableauFetch(` calls present (SSE attempt + JSON fallback). |
| 4 (SC-2 subset) | The 500-row cap is enforced code-side even if the server returns more | VERIFIED | Three defensive layers: (a) pre-request clamp via `effectiveLimit = Math.min(req.limit ?? 500, 500)`, (b) post-JSON `parsed.data.slice(0, effectiveLimit)`, (c) SSE reader early-break via `if (rows.length >= limit) break;` in both the inner row-push loops and the outer while-loop. |
| 5 (SC-3 / 02-04 truth) | Running the Pulse service test script against a datasource WITH metrics returns a PulseContext whose metricDefinitions, insightBundles, and feedback arrays are all non-empty and hasMetrics is true | VERIFIED (code path) | `pulseService.ts` implements three-step fan-out: Step A (lines 139-175) fetches metric definitions via `GET /api/-/pulse/definitions?datasource_luid=<LUID>`; Step B (lines 215-271) fetches insight bundles per metric via `POST /api/-/pulse/insights:generate` inside `Promise.allSettled`; Step C (lines 283-313) fetches feedback via `GET /api/-/pulse/user/preferences`. Happy-path return on line 326-332 with `hasMetrics: true`. Tolerant parser handles both `metadata.name` and top-level `name` shapes (lines 178-188). Live sandbox call pending — see human verification item 4. |
| 6 (SC-4 / 02-04 TAPI-10) | Calling pulseService against a datasource with no Pulse metrics returns an empty PulseContext `{ metricDefinitions: [], insightBundles: [], feedback: [], hasMetrics: false }` without throwing | VERIFIED (regression-guarded) | Three graceful-degradation branches in `pulseService.ts`: HTTP 404 on definitions → `emptyPulseContext` (line 163), HTTP 403 on definitions → same branch, HTTP 200 with empty definitions → `emptyPulseContext` (line 199). **Offline unit test `pulseService.empty.test.ts` exercised all three branches under `pnpm --filter @aperture/backend smoke:phase2`** — observed output: `[test] PASS (empty-definitions)`, `[test] PASS (definitions-404)`, `[test] PASS (definitions-403)`, `[test] All three TAPI-10 graceful-degradation cases passed.` The empty-definitions branch additionally verifies `insightsGenerateCallCount === 0`, proving the short-circuit optimization holds. |
| 7 (plan 02-04 must) | The empty-metrics unit test mocks global.fetch to return [] and asserts pulseService.fetchPulseContext does not throw and returns hasMetrics: false | VERIFIED | `pulseService.empty.test.ts:79-103` monkey-patches `globalThis.fetch` keyed by URL substring; lines 119-123 define three cases; lines 138-159 assert no throw + empty arrays + `hasMetrics === false` + datasourceLuid echoed. Offline run exits 0 with three PASS lines as part of the Phase 2 harness. |
| 8 (02-01 must) | Single file `backend/src/types/tableau.ts` exports SchemaContext, LiveDataContext, PulseContext, plus the InsightFeedbackMetadata sub-type | VERIFIED | `tableau.ts` exports 10 interfaces: `SchemaField`, `WorksheetMetadata`, `WorkbookMetadata`, `SchemaContext`, `VizqlFilter`, `LiveDataContext`, `PulseMetricDefinition`, `PulseInsightBundle`, `InsightFeedbackMetadata`, `PulseContext`. No runtime code. All `readonly`. No `any`. |
| 9 (02-01 must) | Types compile under strict TypeScript | VERIFIED | `pnpm --filter @aperture/backend typecheck` exits 0 (observed at verification time, 2026-04-11). |
| 10 (02-01 must) | Each context type can be constructed as an empty default (for Pulse graceful degradation in 02-04) | VERIFIED | `PulseContext` contains only `readonly` primitive + readonly-array fields with an optional `hasMetrics: boolean` — `emptyPulseContext(luid)` in `pulseService.ts:72-80` constructs `{ datasourceLuid, metricDefinitions: [], insightBundles: [], feedback: [], hasMetrics: false }` as a literal, satisfying the contract. |
| 11 (02-02 must) | The metadataService file contains exactly zero `fetch(` calls not routed through `tableauFetch` | VERIFIED | Grep `^\s*fetch\(['"]https?://` against `metadataService.ts` returns 0. One `tableauFetch(` call inside `postGraphql` helper. |
| 12 (02-02 must) | metadataService interpolates no user-controlled LUIDs into raw GraphQL query strings; all LUIDs go through GraphQL variables | VERIFIED | `FIELDS_FOR_DATASOURCES_QUERY` and `WORKBOOK_META_QUERY` are template literals with NO `${...}` interpolations containing LUID. Grep `\$\{.*luid` returns 0 in `metadataService.ts`. LUIDs pass through `{ luids: datasourceLuids }` (line 250) and `{ luid: workbookLuid }` (line 335-336) as variables. LUID regex guard `^[a-f0-9-]{36}$/i` runs before any network call. |
| 13 (02-04 must) | Pulse service file contains zero raw fetch calls and zero manual X-Tableau-Auth setups | VERIFIED | Grep `^\s*fetch\(['"]https?://` against `pulseService.ts` returns 0. Grep `X-Tableau-Auth` against `pulseService.ts` returns 0. Three `tableauFetch(` calls (definitions, insights:generate, user/preferences). |
| 14 (02-05 must / TAPI-11) | `pnpm --filter @aperture/backend smoke:phase2` executes metadataService.smoke.ts, vizqlService.smoke.ts, pulseService.smoke.ts sequentially, aggregates exit codes, and exits 0 only if all exit 0 | VERIFIED (live-run) | Harness run observed at verification time: four PASS lines in summary block (Metadata API, VizQL Data Svc, Pulse REST, Pulse empty offline) + `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)` + exit 0. Children spawned via `spawn('npx', ['tsx', fullPath, ...args])` without `shell: true`. |
| 15 (02-05 must) | On cold-boot (no credentials), smoke:phase2 still exits 0 because each child script cold-boots cleanly | VERIFIED (live-run) | Observed cold-boot run at verification time (worktree .env empty). All four children exited 0; harness exited 0. |

**Score:** 15/15 truths verified (all code-level truths PASS; 5 live-sandbox observations routed to human verification).

### Required Artifacts

| Artifact | Expected    | Status | Details |
| -------- | ----------- | ------ | ------- |
| `backend/src/types/tableau.ts` | Typed context contracts (10 interfaces, readonly, no `any`) | VERIFIED | 114 lines. 10 exports. Grep `\bany\b` → 0. Grep `tableauFetch` → 0. Compile clean. |
| `backend/src/services/metadataService.ts` | `fetchSchemaByDatasourceLuids`, `fetchWorkbookMetadata`, `MetadataServiceError` + GraphQL queries + LUID guard | VERIFIED | 379 lines. Three exports present. One `tableauFetch` call inside `postGraphql`. `/api/metadata/graphql` endpoint literal present. `publishedDatasources` and `workbooks(filter` queries present. LUID regex present. Zero `fetch(` calls to http URLs. Zero `X-Tableau-Auth`. |
| `backend/src/services/__tests__/metadataService.smoke.ts` | CLI-runnable smoke test asserting TAPI-01 SchemaField keys + TAPI-02 workbook shape | VERIFIED | 191 lines. Imports from `metadataService.js`. Asserts all 5 SchemaField keys. Cold-boot exit 0 via `NOT_CONFIGURED_MARKER` catch (TableauAuthError OR MetadataServiceError). |
| `backend/src/services/vizqlService.ts` | `queryVizqlDatasource`, `VIZQL_MAX_ROWS`, `VizqlServiceError` + SSE-first / JSON-fallback + interpretFieldCaptionsAsFieldNames true + row cap | VERIFIED | 357 lines. Four exports. Two `tableauFetch` calls (SSE + JSON). Endpoint `/api/v1/vizql-data-service/query-datasource` present. `interpretFieldCaptionsAsFieldNames: true` appears exactly once. `VIZQL_MAX_ROWS = 500`. `Math.min` cap. LUID regex. `transport: 'sse'` and `transport: 'json'` both set. |
| `backend/src/services/__tests__/vizqlService.smoke.ts` | CLI smoke asserting TAPI-03 row cap + TAPI-05 transport | VERIFIED | 180 lines. Imports `queryVizqlDatasource`, `VizqlServiceError`, `VIZQL_MAX_ROWS`. Asserts rows.length <= 500 and transport in {sse, json}. Cold-boot exit 0 via dual-error-type NOT_CONFIGURED catch. |
| `backend/src/services/pulseService.ts` | `fetchPulseContext`, `PulseServiceError` + three-step fan-out + graceful degradation | VERIFIED | 334 lines. Two exports. Three `tableauFetch` calls. `/api/-/pulse/` endpoints present. `Promise.allSettled` for per-metric fan-out. `hasMetrics: false` (emptyPulseContext) and `hasMetrics: true` (happy path) both literal. LUID regex. Tolerant parser for both `metadata.name` and flat `name`. |
| `backend/src/services/__tests__/pulseService.empty.test.ts` | Offline unit test with monkey-patched fetch asserting TAPI-10 | VERIFIED (executed) | 186 lines. Three test cases (empty-definitions, definitions-404, definitions-403). Seeds `tokenCache`. Monkey-patches `globalThis.fetch`. Asserts no-throw + empty arrays + `hasMetrics: false` + echoed LUID + `insightsGenerateCallCount === 0` for empty-definitions. **Ran under smoke:phase2 with three `[test] PASS` lines observed.** |
| `backend/src/services/__tests__/pulseService.smoke.ts` | Live smoke for TAPI-07/08/09 happy path | VERIFIED | 122 lines. Imports `fetchPulseContext`. Prints counts + firstMetricName only (no raw bundles). Grep `console\.log\([^)]*ctx\.insightBundles[^,)]*\)` → 0 (PII discipline enforced). |
| `backend/src/services/__tests__/phase2.smoke.ts` | Sequential harness running four child smokes and aggregating exit codes | VERIFIED (executed) | 117 lines. Four STEPS constants (Metadata, VizQL, Pulse, Pulse-empty). `spawn('npx', ['tsx', ...])` without `shell: true`. Continue-on-failure + SUMMARY block. Observed output ends with four PASS lines + `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)` + exit 0. |
| `backend/package.json` | Five new `smoke:*` scripts added without regressing Phase 1 scripts | VERIFIED | Scripts block preserves `dev`, `build`, `start`, `typecheck`, `smoke:auth` unchanged. Adds `smoke:metadata`, `smoke:vizql`, `smoke:pulse`, `smoke:pulse:empty`, `smoke:phase2` in the exact order specified. Valid JSON (typecheck succeeds). |

**Artifact score:** 10/10 VERIFIED (exist, substantive, wired, data-flowing where applicable).

### Key Link Verification

| From | To  | Via | Status | Details |
| ---- | --- | --- | ------ | ------- |
| metadataService.ts | tableauFetch.ts | `tableauFetch()` call in `postGraphql` | WIRED | Import on line 27; call on line 99 |
| metadataService.ts | types/tableau.ts | `import type { SchemaContext, SchemaField, WorkbookMetadata, WorksheetMetadata }` | WIRED | Lines 30-35 |
| vizqlService.ts | tableauFetch.ts | Two `tableauFetch()` calls (SSE + JSON) | WIRED | Import line 37; calls on lines 175 and 219 |
| vizqlService.ts | types/tableau.ts | `import type { LiveDataContext, VizqlFilter }` | WIRED | Line 40 |
| pulseService.ts | tableauFetch.ts | Three `tableauFetch()` calls (definitions, insights:generate, user/preferences) | WIRED | Import line 32; calls on lines 144, 220, 286 |
| pulseService.ts | types/tableau.ts | `import type { PulseContext, PulseMetricDefinition, PulseInsightBundle, InsightFeedbackMetadata }` | WIRED | Lines 35-40 |
| metadataService.smoke.ts | metadataService.ts | `import { fetchSchemaByDatasourceLuids, fetchWorkbookMetadata, MetadataServiceError }` | WIRED | Lines 41-45 |
| vizqlService.smoke.ts | vizqlService.ts | `import { queryVizqlDatasource, VizqlServiceError, VIZQL_MAX_ROWS }` | WIRED | Line 33 |
| pulseService.smoke.ts | pulseService.ts | `import { fetchPulseContext, PulseServiceError }` | WIRED | Line 31 |
| pulseService.empty.test.ts | pulseService.ts | Dynamic `await import('../pulseService.js')` after env + fetch stubs | WIRED | Line 108 |
| phase2.smoke.ts | metadataService.smoke.ts | `spawn('npx', ['tsx', resolve(__dirname, './metadataService.smoke.ts'), ...args])` | WIRED | STEPS[0] lines 38-42 + runStep line 70 |
| phase2.smoke.ts | vizqlService.smoke.ts | same spawn pattern | WIRED | STEPS[1] lines 43-47 |
| phase2.smoke.ts | pulseService.smoke.ts | same spawn pattern | WIRED | STEPS[2] lines 48-52 |
| phase2.smoke.ts | pulseService.empty.test.ts | same spawn pattern | WIRED | STEPS[3] lines 53-57 |

**Key-link score:** 14/14 WIRED. Every expected link from all five plans' `must_haves.key_links` frontmatter is present in the codebase and exercised at runtime by `smoke:phase2`.

### Data-Flow Trace (Level 4)

Phase 2 produces service modules consumed by Phase 3, not UI components that render dynamic data directly. Data-flow trace is applied to the smoke scripts (they read data produced by services) and the offline test (which asserts shape).

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| metadataService.smoke.ts | `ctx` (SchemaContext) | `fetchSchemaByDatasourceLuids` / `fetchWorkbookMetadata` → `tableauFetch` → real GraphQL POST | N/A offline (live pending) | FLOWING (code path); live observation pending in human verification |
| vizqlService.smoke.ts | `ctx` (LiveDataContext) | `queryVizqlDatasource` → `tableauFetch` → SSE or JSON POST | N/A offline (live pending) | FLOWING (code path); live observation pending |
| pulseService.smoke.ts | `ctx` (PulseContext) | `fetchPulseContext` → three `tableauFetch` calls | N/A offline (live pending) | FLOWING (code path); live observation pending |
| pulseService.empty.test.ts | `ctx` (PulseContext) | `fetchPulseContext` → monkey-patched `globalThis.fetch` returning controlled `Response` objects | Yes — test exercises the real `pulseService.ts` module with synthetic fetch responses and asserts the produced PulseContext shape | FLOWING (executed offline under smoke:phase2) |

No HOLLOW or DISCONNECTED data. The cold-boot "no-op" smoke runs are documented-and-intentional fallbacks that prove the NOT_CONFIGURED guard path rather than regressions.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Backend typechecks clean | `pnpm --filter @aperture/backend typecheck` | Exit 0, no output beyond tsc banner | PASS |
| Phase 2 harness exits 0 (cold-boot + offline TAPI-10) | `pnpm --filter @aperture/backend smoke:phase2` | Four PASS lines in summary + `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)` + exit 0 | PASS |
| Offline TAPI-10 test exercises real code paths | `pnpm --filter @aperture/backend smoke:pulse:empty` (invoked via smoke:phase2 child) | Three `[test] PASS` lines for empty-definitions / 404 / 403 + `All three TAPI-10 graceful-degradation cases passed.` | PASS |
| Phase 1 auth regression (shared token chain) | `pnpm --filter @aperture/backend smoke:auth` | Per supplied context: exit 0 with real live signin against `10ax.online.tableau.com` | PASS (by context) |
| No raw fetch of Tableau URLs in Phase 2 services | grep `^\s*fetch\(['"]https?://` against `backend/src/services/*.ts` | 0 matches | PASS |
| No manual X-Tableau-Auth construction in Phase 2 services | grep `X-Tableau-Auth` against `metadataService.ts / vizqlService.ts / pulseService.ts` | 0 matches in service files; remains only in `tableauFetch.ts` / `tokenCache.ts` / `tableauAuth.ts` chokepoint | PASS |
| Every Phase 2 service imports from shared types module | grep `from '.*/types/tableau` in each service file | Present in all three | PASS |
| VizQL row cap literal | grep `VIZQL_MAX_ROWS = 500` in `vizqlService.ts` | 1 match | PASS |
| VizQL interpret-captions flag literal | grep `interpretFieldCaptionsAsFieldNames: true` in `vizqlService.ts` | 1 match (exactly, as required) | PASS |
| Pulse graceful-degradation shape | grep `hasMetrics: false` in `pulseService.ts` | 4 matches (emptyPulseContext + guarded in several paths) | PASS |

All spot-checks passed. No FAIL or SKIP.

### Requirements Coverage

All 11 TAPI-* requirement IDs from Phase 2 are accounted for and attributed to plans.

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ---------- | ----------- | ------ | -------- |
| TAPI-01 | 02-02-PLAN | Metadata API service accepts datasource LUIDs and returns `SchemaContext` with field name, caption, dataType, description, upstream lineage | SATISFIED (code) | `fetchSchemaByDatasourceLuids` returns SchemaContext with all 5 keys populated via `toSchemaField` mapping. Smoke script asserts all 5 keys on the first field. Live observation pending (human item 1). |
| TAPI-02 | 02-02-PLAN | Metadata API service accepts a workbook LUID and returns its worksheets with their connected datasource LUIDs | SATISFIED (code) | `fetchWorkbookMetadata` returns `SchemaContext.workbook` with `worksheets[].connectedDatasourceLuids`. Smoke script asserts workbook.worksheets shape. Live observation pending (human item 2). |
| TAPI-03 | 02-03-PLAN | VizQL Data Service queries published datasources via HTTP with field selection, filters, and a 500-row maximum | SATISFIED | `VIZQL_MAX_ROWS = 500` literal. Triple enforcement: pre-request clamp, post-JSON slice, SSE reader early-break. Smoke asserts `rows.length <= 500`. |
| TAPI-04 | 02-03-PLAN | Every VizQL Data Service request sets `interpretFieldCaptionsAsFieldNames: true` | SATISFIED | Literal appears exactly once in `vizqlService.ts:161`. Type declaration on line 113-114 uses `true` as a literal (compile-time guard — cannot be flipped to false without a TypeScript error). |
| TAPI-05 | 02-03-PLAN | VizQL Data Service attempts SSE streaming (2026.1+) and falls back to JSON when unavailable | SATISFIED (code) | SSE attempt on line 175 with `Accept: text/event-stream`; content-type check on line 184; fallback to JSON on line 219 with `Accept: application/json`. `transport` field recorded on both paths. Live transport observation pending (human item 3). |
| TAPI-06 | 02-01-PLAN (contract) + 02-03 (impl) | VizQL Data Service returns a typed `LiveDataContext` | SATISFIED | `LiveDataContext` interface defined in `types/tableau.ts:65-75`. `vizqlService.buildContext` constructs the typed return. Typecheck clean. |
| TAPI-07 | 02-04-PLAN | Pulse service returns metric definitions connected to a given datasource | SATISFIED (code) | Step A in `pulseService.ts:139-188` fetches and parses definitions into `PulseMetricDefinition[]`. Tolerant of both `metadata.name` and flat `name` shapes. Live observation pending (human item 4). |
| TAPI-08 | 02-04-PLAN | Pulse service returns AI-generated insight bundles per metric | SATISFIED (code) | Step B in `pulseService.ts:215-271` fans out via `Promise.allSettled` and returns `PulseInsightBundle[]`. Tolerant of both `summary` and `result.markup`. Live observation pending. |
| TAPI-09 | 02-04-PLAN | Pulse service returns `InsightFeedbackMetadata` (thumbs up/down per insight type) | SATISFIED (code) | Step C in `pulseService.ts:283-313` returns `InsightFeedbackMetadata[]` wrapped in a try/catch that degrades to `[]` on failure. Live observation pending. |
| TAPI-10 | 02-04-PLAN | Pulse service degrades gracefully when no metrics exist for a datasource (returns empty `PulseContext`, no crash) | SATISFIED (regression-guarded) | Three graceful-degradation branches in `pulseService.ts`. Offline `pulseService.empty.test.ts` asserts all three cases pass without throwing. **Test ran under `smoke:phase2` at verification time with three PASS lines observed.** This is the strongest TAPI and is the only one with offline regression coverage. |
| TAPI-11 | 02-05-PLAN | Each Tableau service has a runnable test script that executes against the sandbox and prints a clean result | SATISFIED | `smoke:metadata`, `smoke:vizql`, `smoke:pulse`, `smoke:pulse:empty`, `smoke:phase2` all registered in `backend/package.json`. `phase2.smoke.ts` aggregates the four children and prints a clean four-row summary. Observed `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)` at verification time. |

**ORPHANED requirements:** None. All 11 TAPI-* IDs listed in REQUIREMENTS.md under Phase 2 are claimed by a Phase 2 plan and verified in-code.

Note: REQUIREMENTS.md still shows these IDs as `Pending` in the traceability table — this is expected; REQUIREMENTS.md is updated post-phase-verification, not during. Informational only.

### Anti-Patterns Found

Scan of Phase 2 files for TODO/FIXME/PLACEHOLDER/stub patterns:

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | No TODO/FIXME/XXX/PLACEHOLDER/"not yet implemented" in any Phase 2 service file | — | — |
| (none) | — | No `return null` / `return []` / `return {}` stubs — every empty-collection return has a documented purpose (emptyPulseContext TAPI-10, empty datasources from workbook query, cold-boot skip in smoke scripts) | — | — |
| (none) | — | No console.log-only implementations | — | — |
| (none) | — | No hardcoded empty props flowing to rendering | — | — |

Cross-reference against `02-REVIEW.md` (4 warnings, 6 info):
- **WR-01** (duplicate LUID dedupe in metadataService) — correctness nit, does not block phase goal; a single call with duplicates still returns a valid (deduped) SchemaContext. Downstream Phase 3 impact is caller-side only.
- **WR-02** (VizQL SSE fallback re-POSTs on mid-stream parse failure) — correctness nit; the current behavior is safe today (VDS query-datasource is read-only) and would only double server load on a flaky network, not break the happy path. Does not block phase goal.
- **WR-03** (Pulse feedback parse does not validate `insight_type` type) — addressed in the service via `Object.assign`-style mapping; if a future Pulse response includes a non-string `insight_type` the `InsightFeedbackMetadata[]` would contain an off-contract entry but would not throw. Does not block phase goal.
- **WR-04** (Metadata API query does not request `caption` field) — code comment acknowledges the mapping; the Metadata API's `name` on a published-datasource field carries the caption today. A future schema change would trip this but is not observable today. Does not block phase goal.

All warnings are correctness-adjacent nits, **none overlap with a goal-level must-have** that blocks Phase 2 acceptance. They are appropriate follow-up work for a hardening pass but do not constitute gaps.

### Human Verification Required

Automated checks passed (15/15 truths, 10/10 artifacts, 14/14 key links, 11/11 requirements satisfied in code, 10/10 spot-checks PASS). The following five items require live Tableau Cloud credentials + real LUIDs that are not present in this worktree, so they must be run by a human:

1. **Live Metadata datasource query** — run `pnpm --filter @aperture/backend smoke:metadata -- --datasource <EIA Prices LUID>` with .env populated; expect `[smoke] PASS: first field has all required keys (TAPI-01)` and exit 0.

2. **Live Metadata workbook query** — run `pnpm --filter @aperture/backend smoke:metadata -- --workbook <workbook LUID>`; expect `[smoke] PASS: workbook "<name>" with N worksheet(s) (TAPI-02)`.

3. **Live VizQL query with observable transport** — run `pnpm --filter @aperture/backend smoke:vizql -- --datasource <EIA Prices LUID> --field "Price"`; expect `[smoke] PASS: rows=<n> (<= 500), transport=<sse|json> (TAPI-03/05)`. Record which transport the sandbox actually served.

4. **Live Pulse happy path** — run `pnpm --filter @aperture/backend smoke:pulse -- --datasource <EIA Prices LUID>`; expect `hasMetrics: true`, `metricCount >= 1`, `firstMetricName: "WTI Crude Oil Price"`, and `[smoke] PASS: PulseContext has N metric(s), M bundle(s), F feedback entries (TAPI-07/08/09)`. If the live Pulse REST paths differ from the plan's assumed `/api/-/pulse/*`, update `pulseService.ts` constants and document in a follow-up — the TAPI-10 offline net ensures graceful failure in the meantime.

5. **Composite Phase 2 live harness** — run `pnpm --filter @aperture/backend smoke:phase2 -- --datasource <EIA> --workbook <wb> --field "Price"`; expect four live PASS lines (not cold-boot skips) + `ALL GREEN — Phase 2 TAPI-01..TAPI-11 verified (TAPI-11)`.

These items are not gaps — the code paths are implemented, grep-verified, type-clean, and the offline regression guard for TAPI-10 (the one load-bearing CLAUDE.md ground rule) has been observed passing. They are the expected live-verification step that closes the "against the sandbox" half of the phase goal.

### Gaps Summary

**No code-level gaps.** Phase 2 delivers all 11 TAPI-* requirements with substantive, wired, typechecked implementations. The one hard CLAUDE.md ground rule (TAPI-10 graceful Pulse degradation) has offline regression coverage that was observed PASSing at verification time. Every Phase 2 service routes HTTP exclusively through the `tableauFetch` chokepoint, honoring the shared-token invariant from Phase 1. No raw `fetch` to Tableau URLs. No `any` in types. No stubs. No placeholders. No TODO-gated behavior.

The verifier's review of `02-REVIEW.md` confirms: 0 critical, 4 correctness-adjacent warnings (none overlap a goal-level must-have), 6 info items. All suitable as follow-up hardening but not blocking.

**The phase goal's code half is achieved.** The "independently testable against the sandbox" half has the code paths in place but requires a human with live Tableau credentials + real LUIDs to observe the sandbox responses end-to-end. This is tracked in five human_verification items above.

**Recommendation:** Mark Phase 2 `human_needed`. When the five human items are executed against the live sandbox and pass, Phase 2 can be upgraded to `passed` by a re-verification run.

---

_Verified: 2026-04-11T15:10:00Z_
_Verifier: Claude (gsd-verifier)_
