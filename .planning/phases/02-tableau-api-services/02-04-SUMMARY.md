---
phase: 02-tableau-api-services
plan: 04
subsystem: backend-pulse-service
tags: [phase-2, tableau, pulse, graceful-degradation, tapi-07, tapi-08, tapi-09, tapi-10]
one_liner: "Pulse REST service with TAPI-10 offline-tested graceful empty-metrics degradation"
requires:
  - backend/src/services/tableauFetch.ts (single chokepoint)
  - backend/src/services/tableauAuth.ts (TableauAuthError export)
  - backend/src/services/tokenCache.ts (test seeding only)
  - backend/src/types/tableau.ts (PulseContext + sub-types from 02-01)
  - backend/src/config/env.ts (loadEnv + __resetEnvCacheForTests)
  - backend/src/lib/logger.ts (pino child logger)
provides:
  - fetchPulseContext
  - PulseServiceError
affects:
  - backend/src/server.ts (future — 02-05 will wire smoke:pulse npm script)
  - Phase 3 Context Assembler (consumes PulseContext)
tech_stack:
  added: []
  patterns:
    - "Single-chokepoint tableauFetch for all Tableau HTTP (zero raw fetch, zero session-header construction in-service)"
    - "Promise.allSettled for per-metric fan-out — partial failures degrade to empty bundles, never service-wide throw"
    - "SSRF guard: LUID validated against /^[a-f0-9-]{36}$/ BEFORE URL concatenation + encodeURIComponent"
    - "TAPI-10 graceful degradation: 404/403/empty-array all return emptyPulseContext(luid)"
    - "Offline unit test via npx tsx (no test framework dependency — matches existing smoke style)"
    - "PII discipline: counts-only logging, grep-enforced no-bundle-dump in smoke script"
key_files:
  created:
    - backend/src/services/pulseService.ts
    - backend/src/services/__tests__/pulseService.empty.test.ts
    - backend/src/services/__tests__/pulseService.smoke.ts
  modified: []
decisions:
  - "fetchPulseContext returns emptyPulseContext on HTTP 404 AND HTTP 403 (not just 404) — 403 is the realistic tenant-scope path when the PAT lacks Pulse read permission, and TAPI-10 requires graceful handling regardless of reason"
  - "Zero-definitions short-circuit: when /definitions returns [], service does NOT fan out to insights:generate — saves N round-trips per metric-less datasource (Phase 3 fans out to 5 datasources at once). Enforced by the empty-definitions test case (insightsGenerateCallCount==0 assertion)"
  - "Per-metric bundle fetches isolated behind Promise.allSettled with try/catch inside each task — one slow/failing metric cannot block the other N-1. DoS mitigation T-02-04-04"
  - "Offline test monkey-patches globalThis.fetch and seeds tokenCache.set() instead of using a test framework — matches the existing backend convention (no Vitest/Jest installed yet, runs via npx tsx like tableauAuth.smoke.ts)"
  - "PulseDefinitionsResponse parser is tolerant of both `{ metadata: { name, description } }` and flat `{ name, description }` shapes — Tableau's Pulse REST surface has evolved, and the type contract (PulseMetricDefinition.name: string) must produce a non-null value on both variants"
  - "PulseInsightsGenerateResponse parser falls back to `result.markup` for summary when the flat `summary` field is absent — covers both Pulse response shapes observed in the public API docs"
  - "Smoke script prints `firstMetricName` but never a bundle — PII-safe reporting that still proves TAPI-07 (at least one definition was fetched) on the live path"
metrics:
  duration: "~4 min"
  completed_date: "2026-04-11"
  tasks_completed: 3
  files_touched: 3
  commits: 3
---

# Phase 02 Plan 04: Pulse REST Service — Summary

Built the third and final Tableau API service for Phase 2: `pulseService.fetchPulseContext(luid)` returns a typed `PulseContext` with metric definitions (TAPI-07), AI insight bundles (TAPI-08), and insight feedback metadata (TAPI-09). The load-bearing behavior is TAPI-10 — **graceful empty-metrics degradation** — which is a CLAUDE.md hard ground rule and is enforced by an offline unit test that blocks regressions without requiring Tableau credentials.

## What Shipped

| File | Purpose |
|------|---------|
| `backend/src/services/pulseService.ts` | Main service — `fetchPulseContext(datasourceLuid)` + `PulseServiceError` |
| `backend/src/services/__tests__/pulseService.empty.test.ts` | Offline unit test (monkey-patches `globalThis.fetch`) — regression guard for TAPI-10 |
| `backend/src/services/__tests__/pulseService.smoke.ts` | Live smoke test against the real Pulse REST API — deferred npm script to 02-05 |

## Task Log

### Task 1: Implement `pulseService.ts` with graceful empty-metrics degradation

- **Commit:** `ea88470`
- **Files:** `backend/src/services/pulseService.ts` (+333 lines)
- **Verification:** `pnpm --filter @aperture/backend typecheck` → exits 0
- **Acceptance criteria — all passing:**

  | Criterion | Required | Actual |
  |-----------|----------|--------|
  | `grep -c "tableauFetch(" …` | ≥3 | 3 ✓ |
  | `grep -cE "^\s*fetch\(['\"]https?://" …` | 0 | 0 ✓ |
  | `grep -c "X-Tableau-Auth" …` | 0 | 0 ✓ |
  | `grep -c "hasMetrics: false" …` | ≥1 | 4 ✓ |
  | `grep -c "hasMetrics: true" …` | ≥1 | 2 ✓ |
  | `grep -c "/api/-/pulse/" …` | ≥2 | 6 ✓ |
  | `grep -c "Promise.allSettled" …` | ≥1 | 3 ✓ |
  | `grep -c "export async function fetchPulseContext" …` | 1 | 1 ✓ |
  | `grep -cE "\^\[a-f0-9-\]\{36\}\$" …` | ≥1 | 2 ✓ |
  | `grep -c "from '../types/tableau" …` | ≥1 | 1 ✓ |
  | Typecheck | exit 0 | exit 0 ✓ |

### Task 2: Offline TAPI-10 unit test

- **Commit:** `c5b1f2a`
- **Files:** `backend/src/services/__tests__/pulseService.empty.test.ts` (+185 lines)
- **Verification:**
  - `pnpm --filter @aperture/backend typecheck` → exits 0
  - `npx tsx backend/src/services/__tests__/pulseService.empty.test.ts` → exits 0
- **Test output (all three cases passed):**

  ```
  [test] PASS (empty-definitions): graceful empty PulseContext (TAPI-10)
  [test] PASS (definitions-404):  graceful empty PulseContext (TAPI-10)
  [test] PASS (definitions-403):  graceful empty PulseContext (TAPI-10)
  [test] All three TAPI-10 graceful-degradation cases passed.
  ```

- **Acceptance criteria — all passing:**

  | Criterion | Required | Actual |
  |-----------|----------|--------|
  | `grep -c "TAPI-10" …` | ≥1 | 6 ✓ |
  | `grep -c "hasMetrics" …` | ≥2 | 3 ✓ |
  | `grep -c "globalThis.fetch" …` | ≥1 | 7 ✓ |
  | `grep -c "tokenCache" …` | ≥1 | 4 ✓ |
  | `grep -c "empty-definitions" …` | ≥1 | 4 ✓ |
  | Typecheck | exit 0 | exit 0 ✓ |
  | Test run | exit 0 | exit 0 ✓ |
  | `[test] PASS` lines | ≥3 | 3 ✓ |

### Task 3: Live smoke test (no `package.json` edit)

- **Commit:** `632cb38`
- **Files:** `backend/src/services/__tests__/pulseService.smoke.ts` (+121 lines)
- **Verification:**
  - `pnpm --filter @aperture/backend typecheck` → exits 0
  - `npx tsx backend/src/services/__tests__/pulseService.smoke.ts` → exits 0 (cold-boot, no `--datasource`)
- **Acceptance criteria — all passing:**

  | Criterion | Required | Actual |
  |-----------|----------|--------|
  | `grep -c "fetchPulseContext" …` | ≥1 | 3 ✓ |
  | `grep -c "Tableau credentials not configured" …` | ≥1 | 1 ✓ |
  | `grep -c "insightBundles" …` | ≥1 | 2 ✓ |
  | `grep -cE "console\.log\([^)]*ctx\.insightBundles[^,)]*\)" …` | 0 | 0 ✓ |
  | `grep -c "TAPI-10" …` | ≥1 | 2 ✓ |
  | `grep -c "smoke:pulse" backend/package.json` | 0 | 0 ✓ |
  | Typecheck | exit 0 | exit 0 ✓ |
  | Smoke cold-boot | exit 0 | exit 0 ✓ |

## Verified Pulse REST Endpoints

The plan listed three Pulse REST endpoint paths as starting points (Tableau Pulse REST surface evolves per release). This plan is an **offline-safe build** — the live endpoint paths **have NOT yet been verified against the sandbox** in this plan because the worktree does not carry live Tableau credentials. The service was built against the plan's canonical paths:

| Endpoint | Purpose | Status |
|----------|---------|--------|
| `GET  /api/-/pulse/definitions?datasource_luid=<LUID>` | Metric definitions (TAPI-07) | Built — pending live verification |
| `POST /api/-/pulse/insights:generate` | Insight bundle generation (TAPI-08) | Built — pending live verification |
| `GET  /api/-/pulse/user/preferences` | Insight feedback metadata (TAPI-09) | Built — pending live verification |

**Critical safety net:** regardless of whether any of these paths returns 404 against the live sandbox, TAPI-10 guarantees the service degrades gracefully — the offline unit test (Task 2) asserts this for HTTP 404, HTTP 403, AND HTTP 200 with empty definitions, so even if the live paths have drifted the service will return an empty `PulseContext` rather than crash.

**Follow-up for Wave 3 (Plan 02-05) live verification:** run the smoke script against the **EIA Prices datasource LUID** (the only datasource with a Pulse metric per STATE.md — "WTI Crude Oil Price"). Expected outcomes:
- `hasMetrics: true` + `metricCount: 1` + `firstMetricName: "WTI Crude Oil Price"` → TAPI-07/08/09 live path confirmed. Document any corrected Pulse REST paths in the 02-05 SUMMARY.
- `hasMetrics: false` → either an endpoint path mismatch (document the 404 and update), or Pulse insights haven't finished async generation yet (STATE.md notes a 10–15 minute delay after metric creation; metrics were set up 2026-04-11 so should be ready).

If the 02-05 live run surfaces a path drift, the fix is a one-line edit to `pulseService.ts` (constants at the top of Steps A/B/C) — no structural change.

## How TAPI-10 Is Enforced

Three independent mechanisms:

1. **Runtime (pulseService.ts):** three graceful-degradation branches
   - HTTP 404 on `/definitions` → `emptyPulseContext(luid)` (line ~135 of service)
   - HTTP 403 on `/definitions` → `emptyPulseContext(luid)` (same branch)
   - HTTP 200 with zero definitions → `emptyPulseContext(luid)` + skip `insights:generate` entirely
2. **Offline test (pulseService.empty.test.ts):** all three branches exercised with mocked `globalThis.fetch` — runs on every CI pass, no credentials needed
3. **Partial-failure isolation:** `Promise.allSettled` around per-metric bundle fetch — one metric failing never takes down the whole context

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Internal inconsistency] Removed `X-Tableau-Auth` literal from service docstring**

- **Found during:** Task 1 acceptance criteria verification
- **Issue:** The plan's Task 1 `<action>` block required the word `X-Tableau-Auth` count to be exactly 0 in the service file, but my first draft's docstring contained "this module must NEVER construct `X-Tableau-Auth` headers directly" — the sentiment is correct, but the literal string tripped the grep gate.
- **Fix:** Rewrote the docstring sentence to say "must NEVER construct Tableau session headers directly" — same meaning, no literal.
- **Files modified:** `backend/src/services/pulseService.ts`
- **Commit:** rolled into `ea88470` (pre-commit)

**2. [Rule 1 — Internal inconsistency] Removed `console.log(...ctx.insightBundles...)` pattern from smoke docstring**

- **Found during:** Task 3 acceptance criteria verification
- **Issue:** The plan's Task 3 acceptance criterion requires `grep -cE "console\.log\([^)]*ctx\.insightBundles[^,)]*\)" …` to return 0. My first draft had a docstring comment explaining the rule that literally contained `console.log(...ctx.insightBundles...)` — the explanation itself tripped the gate the explanation was describing.
- **Fix:** Rewrote the PII discipline paragraph to describe the rule without instantiating the forbidden pattern ("no console.log statement dumps the raw bundles field directly").
- **Files modified:** `backend/src/services/__tests__/pulseService.smoke.ts`
- **Commit:** rolled into `632cb38` (pre-commit)

**3. [Rule 2 — Missing critical functionality] Tolerant definitions-response parser (metadata nesting fallback)**

- **Found during:** Task 1 implementation
- **Issue:** Plan's sample code assumed definitions return `{ id, name, description }` flat, but the public Tableau Pulse REST docs show the shape `{ id, metadata: { name, description } }` for newer Pulse versions (Tableau Cloud 2024.3+). A strict flat-only parser would produce `name: ''` on the live path even when metrics exist, breaking the smoke's `firstMetricName` assertion.
- **Fix:** Parser prefers `d.metadata?.name` and falls back to `d.name` (same for description). Either shape yields a correctly-populated `PulseMetricDefinition.name`. No type contract change — `PulseMetricDefinition.name` is still `string`.
- **Files modified:** `backend/src/services/pulseService.ts`

**4. [Rule 2 — Missing critical functionality] Bundle summary fallback to `result.markup`**

- **Found during:** Task 1 implementation
- **Issue:** Plan's sample assumes `bundles[].summary: string`, but Tableau's Pulse `insights:generate` response in some versions returns textual content under `bundles[].result.markup` instead. Without a fallback, `summary` would be empty on the live path, degrading the Phase 3 Context Assembler's Claude prompt quality.
- **Fix:** `summary: b.summary ?? b.result?.markup ?? ''` — belt-and-suspenders, still produces a valid `string` in either case.
- **Files modified:** `backend/src/services/pulseService.ts`

No Rule 4 architectural escalations. No new dependencies. No changes outside the three planned files.

## Known Stubs

None. The service is fully wired. The live Pulse endpoint paths are "pending live verification" in the sense that they haven't been hit against the real sandbox yet, but that is an empirical observation rather than a stub — the code path exists, the happy path is built, and if the paths have drifted the TAPI-10 graceful-degradation net catches the regression without crashing the panel.

## Threat Flags

No new threat surface beyond what the plan's `<threat_model>` already covers. The SSRF guard, PII log discipline, Promise.allSettled DoS mitigation, and feedback-fetch isolation all match the plan's threat register exactly (T-02-04-01 through T-02-04-06).

## Requirements Completed

- **TAPI-07** — "Pulse REST returns typed metric definitions" — `fetchPulseContext` returns `metricDefinitions: PulseMetricDefinition[]` on the happy path
- **TAPI-08** — "Pulse REST returns insight bundles per metric" — `fetchPulseContext` fans out via `Promise.allSettled` and returns `insightBundles: PulseInsightBundle[]`
- **TAPI-09** — "Pulse REST returns InsightFeedbackMetadata for thumbs-weight" — `fetchPulseContext` returns `feedback: InsightFeedbackMetadata[]` (non-fatal — empty on fetch failure)
- **TAPI-10** — "Pulse degrades gracefully if no metrics exist" — three code branches + three offline test cases + `hasMetrics: boolean` UI flag. **Fully enforced.**

All four requirements for Plan 02-04 are code-complete and, for TAPI-10, regression-guarded offline. TAPI-07/08/09's live verification rolls up into Plan 02-05's Phase 2 smoke run against the EIA Prices datasource (per STATE.md Phase 2 Execution Inputs).

## Verification Evidence

```bash
$ pnpm --filter @aperture/backend typecheck
# exits 0 (no errors)

$ npx tsx backend/src/services/__tests__/pulseService.empty.test.ts
[test] PASS (empty-definitions): graceful empty PulseContext (TAPI-10)
[test] PASS (definitions-404): graceful empty PulseContext (TAPI-10)
[test] PASS (definitions-403): graceful empty PulseContext (TAPI-10)
[test] All three TAPI-10 graceful-degradation cases passed.
# exit 0

$ npx tsx backend/src/services/__tests__/pulseService.smoke.ts
[smoke] pulseService.smoke.ts — live Pulse REST smoke test
Usage:
  npx tsx backend/src/services/__tests__/pulseService.smoke.ts --datasource <luid>
  APERTURE_SMOKE_PULSE_DATASOURCE_LUID=<luid> npx tsx backend/src/services/__tests__/pulseService.smoke.ts
No --datasource provided — exiting 0 (cold-boot, no-op).
# exit 0

$ git diff 98b0a0c HEAD -- backend/package.json | wc -l
0
# package.json untouched — smoke:pulse script deferred to 02-05 as required

$ git log --oneline 98b0a0c..HEAD
632cb38 test(02-04): add live Pulse smoke test (deferred npm script to 02-05)
c5b1f2a test(02-04): add offline TAPI-10 graceful-degradation unit test
ea88470 feat(02-04): implement Pulse REST service with TAPI-10 graceful degradation
```

## Self-Check: PASSED

- [x] `backend/src/services/pulseService.ts` exists on disk
- [x] `backend/src/services/__tests__/pulseService.empty.test.ts` exists on disk
- [x] `backend/src/services/__tests__/pulseService.smoke.ts` exists on disk
- [x] Commit `ea88470` present in `git log`
- [x] Commit `c5b1f2a` present in `git log`
- [x] Commit `632cb38` present in `git log`
- [x] `backend/package.json` unchanged from plan start (0 diff lines)
- [x] Typecheck exits 0
- [x] Offline TAPI-10 test exits 0 (all 3 cases PASS)
- [x] Smoke cold-boot exits 0
- [x] All Task 1/2/3 acceptance-criteria greps pass (see tables above)
