---
phase: 02-tableau-api-services
plan: 01
subsystem: backend-types
tags: [phase-2, types, tableau, interface-first]
one_liner: "Typed context contracts (SchemaContext / LiveDataContext / PulseContext) for Phase 2 services"
requires: []
provides:
  - SchemaContext
  - SchemaField
  - WorksheetMetadata
  - WorkbookMetadata
  - LiveDataContext
  - VizqlFilter
  - PulseContext
  - PulseMetricDefinition
  - PulseInsightBundle
  - InsightFeedbackMetadata
affects:
  - backend/src/services/metadataService.ts (future — 02-02)
  - backend/src/services/vizqlService.ts (future — 02-03)
  - backend/src/services/pulseService.ts (future — 02-04)
  - backend/src/services/ (future Phase 3 Context Assembler)
tech_stack:
  added: []
  patterns:
    - "TypeScript interface-first: all Wave 2 services import a single source of truth"
    - "readonly-everywhere style (matches tokenCache.ts CachedToken)"
    - "Empty-default constructability (PulseContext can be built empty for TAPI-10 graceful degradation)"
key_files:
  created:
    - backend/src/types/tableau.ts
  modified: []
decisions:
  - "Used TypeScript `interface` (not `type` aliases) for every record-shaped export to match the style of `CachedToken` in `tokenCache.ts`"
  - "All fields `readonly` and `readonly`-wrapped collections for immutability at compile time"
  - "`SchemaContext` unifies byDatasource and byWorkbook query modes via `datasources: Record<LUID, SchemaField[]>` + optional `workbook?: WorkbookMetadata` — single shape for both entry points in 02-02"
  - "`LiveDataContext.transport: 'sse' | 'json'` lets 02-05's smoke harness report which path VizQL actually used"
  - "`PulseContext.hasMetrics: boolean` is the load-bearing flag for TAPI-10 graceful degradation — empty PulseContext is a valid value, not an error"
  - "Removed `interpretFieldCaptionsAsFieldNames` from comment text to satisfy acceptance-criteria grep gate (runtime flag belongs in 02-03 vizqlService, not in the types file)"
metrics:
  duration: "~10 min"
  completed_date: "2026-04-11"
  tasks_completed: 1
  files_touched: 1
  commits: 1
---

# Phase 02 Plan 01: Shared Phase 2 Tableau Context Types — Summary

Interface-first deliverable for Phase 2. Defines the three typed context objects — `SchemaContext`, `LiveDataContext`, `PulseContext` — that all Phase 2 services (02-02 Metadata, 02-03 VizQL, 02-04 Pulse) will produce and that Phase 3's Context Assembler will merge into a single `CopilotContext`. Strict TypeScript, no runtime, no `any`, ready to import.

## What Shipped

A single file: `backend/src/types/tableau.ts` (114 lines), exporting 10 interfaces:

| Interface                | Purpose                                                                    |
| ------------------------ | -------------------------------------------------------------------------- |
| `SchemaField`            | One field inside a Tableau datasource (name, caption, dataType, lineage)   |
| `WorksheetMetadata`      | One worksheet + its connected datasource LUIDs                             |
| `WorkbookMetadata`       | Workbook LUID + name + worksheets                                          |
| `SchemaContext`          | Output of metadataService — unifies byDatasource and byWorkbook modes      |
| `VizqlFilter`            | One filter on a VDS query — `SET / QUANTITATIVE_DATE / ... / TOP`          |
| `LiveDataContext`        | Output of vizqlService — rows (≤500), fields, filters, transport, totalRows |
| `PulseMetricDefinition`  | One Pulse metric definition (id, name, description, datasourceLuid)        |
| `PulseInsightBundle`     | One Pulse AI insight bundle (metricId, bundleId, insightTypes, summary)    |
| `InsightFeedbackMetadata`| Per-insight-type thumbs up/down — weights Claude's emphasis                 |
| `PulseContext`           | Output of pulseService — metricDefinitions, insightBundles, feedback, hasMetrics |

## Downstream Consumers

These types will be imported by:

1. **02-02 metadataService** — `import type { SchemaContext, WorkbookMetadata } from '../types/tableau.js'`
2. **02-03 vizqlService** — `import type { LiveDataContext, VizqlFilter } from '../types/tableau.js'`
3. **02-04 pulseService** — `import type { PulseContext, PulseMetricDefinition, PulseInsightBundle, InsightFeedbackMetadata } from '../types/tableau.js'`
4. **02-05 phase2.smoke** — reads `LiveDataContext.transport` to report which VDS path was taken
5. **Phase 3 Context Assembler** (future) — merges all three context objects into a `CopilotContext` for Claude

Because this plan ships only types, no downstream plan has to modify this file to land its own work — they just import.

## Task Log

### Task 1: Create shared Phase 2 Tableau context types

- **Commit:** `8bf6ea6`
- **Files:** `backend/src/types/tableau.ts` (new, 114 lines)
- **Verification:** `pnpm --filter @aperture/backend typecheck` → exits 0
- **Acceptance criteria (all passing):**
  - `grep -c "export interface SchemaContext" …` → 1 ✓
  - `grep -c "export interface LiveDataContext" …` → 1 ✓
  - `grep -c "export interface PulseContext" …` → 1 ✓
  - `grep -c "export interface InsightFeedbackMetadata" …` → 1 ✓
  - `grep -c "hasMetrics: boolean" …` → 1 ✓
  - `grep -c "interpretFieldCaptionsAsFieldNames" …` → 0 ✓
  - `grep -c "tableauFetch" …` → 0 ✓
  - `grep -E "\\bany\\b" …` → 0 matches ✓
  - `pnpm --filter @aperture/backend typecheck` → 0 ✓

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 — Plan internal inconsistency] Removed `interpretFieldCaptionsAsFieldNames` mentions from comments**

- **Found during:** Task 1 verification
- **Issue:** The `<action>` block in the plan literally contains the string `interpretFieldCaptionsAsFieldNames` in two doc comments (the header JSDoc and the `LiveDataContext.rows` JSDoc), but the plan's own `<acceptance_criteria>` requires `grep -c "interpretFieldCaptionsAsFieldNames" backend/src/types/tableau.ts` to return `0` (runtime flag belongs in 02-03, not in types). The `<action>` and `<acceptance_criteria>` blocks are internally inconsistent.
- **Fix:** Rewrote both comment lines to describe the behavior without using the exact runtime flag name. The header comment now reads "VizQL always requests that field captions be interpreted as field names" and the row comment reads "keys are field captions (vizqlService always requests caption-as-name interpretation)". Meaning preserved; grep gate satisfied.
- **Files modified:** `backend/src/types/tableau.ts`
- **Commit:** `8bf6ea6` (fix rolled into the initial create since grep gates are compile-time / acceptance-time, not a separate commit)

No architectural changes. No new dependencies. No Rule 4 escalations.

## Known Stubs

None. This plan ships types only — there is no runtime surface to stub. Downstream plans (02-02, 02-03, 02-04) will implement the services that produce instances of these types.

## Threat Flags

None. Pure type definitions, no runtime, no data flow, no new trust boundary crossed. Matches the plan's threat model (T-02-01-01 accept, T-02-01-02 mitigate-via-single-source-of-truth).

## Requirements Completed

- **TAPI-06** — "VizQL Data Service returns a typed LiveDataContext" — the type contract is now defined. Implementation of the service that returns it lands in 02-03.

## Verification Evidence

```bash
$ pnpm --filter @aperture/backend typecheck
> @aperture/backend@0.1.0 typecheck
> tsc -p tsconfig.json --noEmit
# exit 0

$ wc -l backend/src/types/tableau.ts
     114 backend/src/types/tableau.ts

$ git log --oneline -1
8bf6ea6 feat(02-01): add shared Phase 2 Tableau context types
```

## Self-Check: PASSED

- [x] `backend/src/types/tableau.ts` exists on disk
- [x] Commit `8bf6ea6` present in `git log`
- [x] All 10 exported interfaces present
- [x] `pnpm --filter @aperture/backend typecheck` exits 0
- [x] No `any`, no `tableauFetch`, no `interpretFieldCaptionsAsFieldNames` literals
