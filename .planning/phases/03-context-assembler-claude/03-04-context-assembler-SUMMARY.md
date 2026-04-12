---
phase: 03-context-assembler-claude
plan: 04
subsystem: backend-services
tags: [phase-3, context-assembler, fan-out, wave-2, offline-test]
status: complete
completed: 2026-04-11
duration: 9m
tasks_completed: 1
tasks_total: 2
requires:
  - backend/src/types/copilot.ts (Plan 03-01: CopilotContext, CopilotContextRequest, ServicesFired)
  - backend/src/services/errors.ts (Plan 03-01: ContextAssemblerError)
  - backend/src/services/contextBudget.ts (Plan 03-03: estimateContextChars, truncateContext, EFFECTIVE_TARGET)
  - backend/src/services/metadataService.ts (Phase 2: fetchSchemaByDatasourceLuids)
  - backend/src/services/vizqlService.ts (Phase 2: queryVizqlDatasource, VIZQL_MAX_ROWS, VizqlQueryField)
  - backend/src/services/pulseService.ts (Phase 2: fetchPulseContext)
provides:
  - assembleContext(request, deps?) -> Promise<CopilotContext>
  - PER_SERVICE_TIMEOUT_MS = 2_000
  - TOTAL_BUDGET_MS = 2_500
  - MAX_VDS_FIELDS_PER_LUID = 10
  - AssembleDeps (test-only DI shape)
affects:
  - Plan 03-06 (/context and /chat routes) — import assembleContext, catch ContextAssemblerError for HTTP 502 SCHEMA_UNAVAILABLE body (D-04)
  - Plan 03-08 (smoke test) — can run end-to-end against real Tableau creds by omitting `deps`
tech_stack:
  added: []
  patterns:
    - Dependency-injection via optional `deps` parameter (stdlib-only, no mock framework)
    - performance.now() for wall-clock budget enforcement
    - Promise.race against a single shared deadline promise for total-budget wrapper
    - Readonly-in / readonly-out — schema/liveData/pulse widened only at the finalize() boundary
    - Per-service AbortController inside withTimeout; allSettled outside so one failure never propagates
key_files:
  created:
    - backend/src/services/contextAssembler.ts
    - backend/src/services/__tests__/contextAssembler.test.ts
  modified:
    - backend/package.json
decisions:
  - "assembleContext exports an optional `deps` parameter (AssembleDeps) with defaults pointing at the Phase 2 services. This lets offline tests inject stubs without loader hooks or env stubbing. Production callers pass only `request`."
  - "VDS fields[] is derived from Stage A schema captions via `schema.datasources[luid].slice(0, MAX_VDS_FIELDS_PER_LUID).map(f => ({ fieldCaption: f.caption }))` — this is the literal Blocker 2 fix. Fields are cap-limited to 10 per LUID to keep the token budget lean; truncateContext will trim further if needed."
  - "Two-stage fan-out honors D-01's SEMANTIC intent (parallel wherever dependencies allow) even though the literal decision was `Promise.allSettled([metadata, vizql, pulse])`. Stage B runs both VDS and Pulse via allSettled against the resolved LUID set; Stage A gates Stage B because VDS needs real captions. Documented inline as a source comment."
  - "Total-budget wrapper uses a single shared `deadlinePromise` that is raced against both Stage A and Stage B, so wall-clock never exceeds TOTAL_BUDGET_MS even if both stages burn their full per-service budgets. The deadline-fired bookkeeping is logged at debug level."
  - "finalize() is the sole boundary that widens readonly arrays and runs the estimator + truncator. contextChars is captured BEFORE truncateContext runs so the pre-truncation value is preserved in servicesFired per D-05."
metrics:
  duration_minutes: 9
  tasks: 1
  files_touched: 3
  deviations: 1
  blockers: 0
requirements:
  - CTX-01
  - CTX-02
  - CTX-03
---

# Phase 03 Plan 04: Context Assembler Summary

## One-liner

`assembleContext` is the Phase 3 central primitive: two-stage fan-out (Stage A metadata with D-04 hard-throw, Stage B `Promise.allSettled([vizql, pulse])` with per-service 2s `AbortController` + 2.5s total budget), derives VDS `fields[]` from Stage A schema captions using the real `{ fieldCaption }` shape (Blocker 2 fix), silently degrades VDS/Pulse failures per D-03, and runs `truncateContext` at the finalize boundary. 11 offline tests via a `deps` DI parameter — zero Tableau credentials required.

## What Was Built

### `backend/src/services/contextAssembler.ts`

Single exported entry point `assembleContext(request, deps?)` plus three exported constants (`PER_SERVICE_TIMEOUT_MS`, `TOTAL_BUDGET_MS`, `MAX_VDS_FIELDS_PER_LUID`) and an `AssembleDeps` interface for test injection.

**Control flow:**

1. **Empty input short-circuit.** `request.datasourceLuids.length === 0` returns immediately with `metadata.status='ok', datasources=0`, `vizql.status='empty'`, `pulse.status='empty'`. Never calls any Tableau service. Covered by Test 10.

2. **Stage A — metadata (sequential gate).** `fetchSchemaByDatasourceLuids(luids)` wrapped in `withTimeout('metadata', ...)` which fires an `AbortController` at 2s. Raced against a shared `deadlinePromise` scoped to `TOTAL_BUDGET_MS`. On any rejection (or deadline firing), throws `ContextAssemblerError` with `failedLuids = luids` and `cause = err`. If the call resolves but `schema.datasources` is empty, same hard-throw path.

3. **Partial-success bookkeeping (D-03).** Computes `resolvedLuids = Object.keys(schema.datasources)`. If strictly fewer than input, builds `metadata.status='partial'` with `ok`, `failed`, and `failedLuids` populated from the input set difference. If all LUIDs resolved, `metadata.status='ok'`. Tested by Test 4 with a 3-LUID input where only 2 are returned.

4. **Stage B — VDS + Pulse in parallel.** Only `resolvedLuids` are fired (the failed LUID from Stage A is NOT queried). Each VDS call receives `fields` derived from:

   ```ts
   schema.datasources[luid]
     .slice(0, MAX_VDS_FIELDS_PER_LUID)
     .map((f: SchemaField): VizqlQueryField => ({ fieldCaption: f.caption }))
   ```

   This is the Blocker 2 fix — the VDS API matches field captions natively when specified via the `fieldCaption` key (verified in Phase 2 live UAT; CLAUDE.md's earlier `interpretFieldCaptionsAsFieldNames` claim was wrong). Every VDS call passes `limit: VIZQL_MAX_ROWS`. Every Pulse call is a simple `fetchPulseContext(luid)` under its own `withTimeout`.

5. **Stage B race.** `Promise.allSettled([...vizqlPromises, ...pulsePromises])` is raced against the same shared `deadlinePromise`. If the deadline fires first, the code still awaits the already-settled collection (each per-service timeout caps at 2s, so settling completes shortly after the deadline). If the race wins, results come back directly.

6. **Aggregation (D-03: silent degrade).** VDS results are partitioned into `liveData[]` and error reasons:
   - any fulfilled → pushed; `vizqlOkRows` accumulates
   - any rejected → captured as `vizqlAnyError`
   - Final status: `error` if `liveData.length === 0 && vizqlAnyError`, else `empty` if `vizqlOkRows === 0`, else `ok{ rows }`
   - Pulse follows the same three-way logic on `metricCount`.

7. **finalize() → truncation.** `finalize(request, schema, liveData, pulse, partial, assemblyMs)` constructs the draft `CopilotContext`, runs `estimateContextChars` to populate `servicesFired.contextChars` (pre-truncation), then calls `truncateContext(withChars)`. `truncateContext` sets `servicesFired.truncated=true` only if any D-17 step fired.

**Known v1 limitation (source-documented):** `withTimeout` fires an `AbortController.abort()` at 2s, but the underlying `tableauFetch` chain does NOT currently thread an AbortSignal into `globalThis.fetch`. Orphan fetches run to completion in the background and their results are discarded. The inline doc comment on `withTimeout` points at the STATE.md entry the orchestrator will write. Mitigated at v1 by D-22 rate limiting.

### `backend/src/services/__tests__/contextAssembler.test.ts` — 11 offline tests

| # | Scenario | Enforces |
|---|---|---|
| 1 | Happy path — all 3 services return valid contexts | D-05 `servicesFired` shape, `truncated=false`, `rows>0`, `metricCount>0` |
| 2 | VDS throws → silent degrade | D-03, `vizql.status='error'` with reason, schema + pulse preserved |
| 3 | Pulse throws → silent degrade | D-03, `pulse.status='error'` with reason, schema + liveData preserved |
| 4 | 3 LUIDs in, 2 resolved → partial | D-03 per-LUID partial, `failedLuids.length===1`, VDS called ONLY for resolved LUIDs (stub-capture asserted) |
| 5 | 100% schema failure → hard throw | D-04 `ContextAssemblerError` with `failedLuids` + `cause`, VDS/Pulse stubs NEVER called (Stage B skipped) |
| 6 | Pulse hangs forever → 2s timeout | D-02, wall clock < 2800ms, `pulse.reason` matches /timeout\|abort/ |
| 7 | All three hang → 2.5s budget | D-02, wall clock < 2800ms; either throws `ContextAssemblerError` or returns with all-error statuses |
| 8 | >70k-char fixture → truncation | D-17, `truncated=true`, post-`estimateContextChars` ≤ `EFFECTIVE_TARGET`, `contextChars` preserved as pre-truncation value (D-05) |
| 9 | 100ms delay per service → assemblyMs monotonic | `assemblyMs ≥ 100 && < TOTAL_BUDGET_MS` |
| 10 | Empty datasourceLuids → short-circuit | No Tableau service called, `metadata.datasources===0`, empty arrays |
| 11 | **Blocker 2 contract** — VDS receives non-empty fields[] | `stub.calls.length===1`, `fields.length ∈ (0, MAX_VDS_FIELDS_PER_LUID]`, every entry has `fieldCaption` (NOT `name`), every caption is a real schema caption, JSON-stringified calls contain `"fieldCaption"` and NOT `"name":"WTI_PRICE_USD"` |

**Stub pattern:** `makeVizqlStub(handler)` returns `{ queryVizql, calls }` where `calls` is a mutable array the test closes over. Every `queryVizql` invocation pushes `{ datasourceLuid, fields, limit }` into `calls` before dispatching to `handler`. Tests assert on the captured array for Blocker 2 and partial-success coverage. No test framework: each `test(name, fn)` just pushes to a `tests[]` array, and a bottom-of-file runner loops them, prints `PASS`/`FAIL`, and exits non-zero on any failure.

### `backend/package.json`

Added one npm script after `smoke:budget`:

```json
"smoke:assembler": "tsx src/services/__tests__/contextAssembler.test.ts",
```

No dependencies added. `performance.now()`, `AbortController`, and `Promise.allSettled` are Node 20+ builtins.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend smoke:assembler` | PASS (11/11) |
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors) |
| `test -f backend/src/services/contextAssembler.ts` | PASS |
| `test -f backend/src/services/__tests__/contextAssembler.test.ts` | PASS |
| All Task 1 grep acceptance criteria (17 patterns) | PASS |
| `grep -q "tableauFetch" backend/src/services/contextAssembler.ts` | NO MATCH (correct — assembler never touches tableauFetch directly) |
| `grep -q "fieldCaption" backend/src/services/contextAssembler.ts` | PASS (Blocker 2 fix) |
| `grep -c "Test [0-9]"` in test file | 22 (11 test registrations + 11 human-readable names) |
| No new runtime deps | PASS |

## Deviations from Plan

### Plan deviations

**1. [Orchestrator directive] Task 2 skipped — STATE.md not modified**

- **Found during:** Plan parsing, before Task 2 execution
- **Issue:** The plan's Task 2 instructs the executor to append a "Known Limitations" entry to `.planning/STATE.md` documenting the `withTimeout` background-leak v1 limitation. The orchestrator's spawn prompt explicitly overrides this: *"DO NOT modify .planning/STATE.md"*. The plan frontmatter's `files_modified: [.planning/STATE.md]` is an artifact of the planning phase and is explicitly ignored in parallel-executor mode.
- **Fix:** Task 2 was not executed as a file write. Instead, this SUMMARY.md documents the limitation in full below (see "Known v1 Limitations") so the orchestrator can decide where to propagate it. The corresponding inline source-level documentation is already present in `contextAssembler.ts` (doc comment on the `withTimeout` helper function and on the top-of-file JSDoc block), so the limitation is captured at the code level regardless of STATE.md.
- **Files modified:** None (skipped)
- **Commit:** N/A

### Auto-fixed Issues

None. Plan executed exactly as written for Task 1 — test-first TDD, all 11 tests went RED then GREEN on the first implementation pass, typecheck clean, no blockers.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 (RED) | Offline contextAssembler test (11 cases) | `f5ff9f3` | `backend/src/services/__tests__/contextAssembler.test.ts`, `backend/package.json` |
| 1 (GREEN) | contextAssembler two-stage fan-out implementation | `2c36b9a` | `backend/src/services/contextAssembler.ts` |
| 2 | (SKIPPED — orchestrator owns STATE.md) | — | — |

## Known v1 Limitations (for orchestrator to propagate)

**withTimeout background-leak:**

> Context assembler timeouts return control to callers at 2s but do NOT abort the underlying Tableau HTTP fetches. Orphan fetches run to completion in the background and their results are discarded. Mitigated at v1 by rate limiting (D-22). Revisit in a dedicated phase if DoS load tests reveal connection-slot starvation.

The assembler's `withTimeout` helper fires an `AbortController` at 2s, but `tableauFetch` (the chokepoint consumed by all three Phase 2 services) does not currently thread an `AbortSignal` into `globalThis.fetch`. Retrofitting AbortSignal threading through the `tableauFetch` wrapper is a cross-phase change and would expand Phase 3 scope — deferred to a dedicated phase if load testing reveals connection-slot starvation. Mitigated at v1 by D-22 per-route rate limiting (60/min/IP on `/chat`, 10/min on `/export`).

This limitation is already source-documented in two places inside `backend/src/services/contextAssembler.ts`:

- Top-of-file JSDoc block (`KNOWN v1 LIMITATION` section)
- Helper-function JSDoc on `async function withTimeout<T>` just above the implementation

## Downstream Impact

- **Plan 03-06 (`/context` + `/chat` routes)** — will `import { assembleContext } from '../services/contextAssembler.js'` and wrap the call in a try/catch on `ContextAssemblerError`. On catch, build the D-04 HTTP 502 `SCHEMA_UNAVAILABLE` body directly from `err.failedLuids`. Pass only `request` — never `deps` in production.
- **Plan 03-05 (Claude service)** — unaffected. The `CopilotContext` shape returned by `assembleContext` is already what `claudeService.streamNarrative` expects.
- **Plan 03-08 (smoke test)** — can call `assembleContext(request)` directly against a real Tableau sandbox to prove the tri-API path end-to-end. 100% offline path is already proven by the 11 tests committed in this plan.
- **Phase 4 extension UI** — `servicesFired` is consumed by the `ContextBadge` component in Phase 4 plan 04-*. Its shape is locked by D-05 and has not changed.

## Known Stubs

None — `assembleContext` is fully implemented end-to-end. The only optional field (`deps`) defaults to the real Phase 2 services, so production callers get the full fan-out with zero config.

## Self-Check: PASSED

- `backend/src/services/contextAssembler.ts` — FOUND
- `backend/src/services/__tests__/contextAssembler.test.ts` — FOUND
- `backend/package.json` — MODIFIED (smoke:assembler script added)
- commit `f5ff9f3` (RED test) — FOUND in `git log`
- commit `2c36b9a` (GREEN implementation) — FOUND in `git log`
- `pnpm --filter @aperture/backend smoke:assembler` — PASS (11/11)
- `pnpm --filter @aperture/backend typecheck` — PASS (0 errors)
- `.planning/STATE.md` — NOT modified (orchestrator directive honored)
