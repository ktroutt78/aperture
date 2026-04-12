---
phase: 03-context-assembler-claude
plan: 01
subsystem: backend-types
tags: [phase-3, types, foundation, copilot-context, errors]
status: complete
completed: 2026-04-12
duration: 2m
tasks_completed: 2
tasks_total: 2
requires:
  - backend/src/types/tableau.ts (Phase 2 SchemaContext / LiveDataContext / PulseContext / WorkbookMetadata)
provides:
  - CopilotContext
  - CopilotContextRequest
  - ServicesFired (D-05 discriminated union)
  - ChatMessage
  - DashboardState
  - SelectedMark
  - ActiveFilter
  - ErrorCode (D-07)
  - ContextAssemblerError
  - ClaudeServiceError
affects:
  - All downstream Phase 3 plans (03-02..03-08) — they import from these two files
tech_stack:
  added: []
  patterns:
    - Phase 2 service-error class pattern (override readonly cause, optional cause constructor arg)
    - Readonly-by-default discriminated unions for per-service status
    - ESM .js import suffix (TS NodeNext / module=ESNext with moduleResolution=node)
key_files:
  created:
    - backend/src/types/copilot.ts
    - backend/src/services/errors.ts
  modified: []
decisions:
  - "ContextAssemblerError carries `readonly failedLuids: readonly string[]` so D-04 (HTTP 502 SCHEMA_UNAVAILABLE body) can be constructed directly from the thrown error without re-collecting LUIDs at the route layer"
  - "ClaudeServiceError carries a `readonly code: ErrorCode` so the /chat SSE error event (D-07) can emit the stable code without a mapping table"
  - "Both error classes use `override readonly cause?: unknown` — the backend tsconfig enforces TS 4114 strict override, matching MetadataServiceError in Phase 2"
metrics:
  duration_minutes: 2
  tasks: 2
  files_touched: 2
  deviations: 1
  blockers: 0
requirements:
  - CTX-02
---

# Phase 03 Plan 01: CopilotContext Types + Service Errors Summary

## One-liner

Typed foundation for Phase 3: `CopilotContext` envelope, `ServicesFired` discriminated union (D-05), `ErrorCode` union (D-07), and `ContextAssemblerError` + `ClaudeServiceError` classes following the Phase 2 service-error pattern — two new files, zero runtime behavior, every downstream plan now imports contracts instead of inventing shapes.

## What Was Built

### `backend/src/types/copilot.ts` (Task 1)

A pure-types module exporting:

- **`ServicesFired`** — per-service discriminated union (`metadata | vizql | pulse`) with `assemblyMs`, `contextChars`, and `truncated` observability fields. Every status shape matches D-05 verbatim, including:
  - `metadata.partial` carrying `ok`, `failed`, and `failedLuids: readonly string[]`
  - `vizql` distinguishing `ok` vs `empty` vs `error`
  - `pulse.ok` carrying `metricCount`
- **`CopilotContextRequest`** — the POST body shape shared by `/context` and `/chat` (the chat route will extend with `question` + `messages` in plan 03-06). Carries `workbookName`, `worksheetName`, `datasourceLuids`, `selectedMarks`, `activeFilters`.
- **`DashboardState`** + **`SelectedMark`** + **`ActiveFilter`** — the shape of the user-turn preamble block that wraps `/chat` questions (D-15). Deliberately separate from `CopilotContextRequest` because D-15 puts dashboard state in the user turn, not the system prompt.
- **`ChatMessage`** — `{ role: 'user' | 'assistant', content: string }`. Roles locked to Anthropic Messages API shape.
- **`CopilotContext`** — the merged envelope: `request`, `schema`, `liveData`, `pulse`, `servicesFired`, optional `workbook`.
- **`ErrorCode`** — `ANTHROPIC_TIMEOUT | ANTHROPIC_RATE_LIMITED | ANTHROPIC_ERROR | CONTEXT_ASSEMBLY_FAILED | INTERNAL` (D-07 literal).

All imports from `./tableau.js` use the `.js` suffix per the repo's ESM + `moduleResolution: node` config.

### `backend/src/services/errors.ts` (Task 2)

Two error classes following the Phase 2 pattern (`MetadataServiceError` lines 62-69 of `metadataService.ts`):

- **`ContextAssemblerError`** — `(message, failedLuids?, cause?)`. `failedLuids` defaults to `[]`. Consumed by the `/context` + `/chat` routes in plan 03-06 to build the D-04 HTTP 502 `SCHEMA_UNAVAILABLE` body.
- **`ClaudeServiceError`** — `(message, code, cause?)`. `code` is required (`ErrorCode`) so the SSE error event in plan 03-05 can emit a stable code without a mapping table.

Both classes:
- Use `override readonly cause?: unknown` (matches `MetadataServiceError` on `metadataService.ts:63`, satisfies TS 4114 `noImplicitOverride`).
- Call only `super(message)` in the constructor, then assign readonly fields. No logging, no prototype mutation, no side effects — matching the T-03-01-02 accept rationale in the plan's threat model.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors after Task 2 fix) |
| `test -f backend/src/types/copilot.ts` | PASS |
| `test -f backend/src/services/errors.ts` | PASS |
| All Task 1 grep acceptance criteria (9 patterns) | PASS |
| All Task 2 grep acceptance criteria (5 patterns) | PASS |
| `grep -r "from '../types/copilot.js'" backend/src/` | Returns only the errors.ts import (expected — downstream plans will add more) |
| No tests added | Correct (types-only plan) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `override` modifier required on `Error.cause` in errors.ts**

- **Found during:** Task 2 typecheck
- **Issue:** The plan's verbatim code block in Task 2 declared `readonly cause?: unknown;`, but `backend/tsconfig.json` extends `tsconfig.base.json` which enforces TS 4114 (`noImplicitOverride`). The compiler rejected both classes with:
  ```
  src/services/errors.ts(9,12): error TS4114: This member must have an 'override' modifier because it overrides a member in the base class 'Error'.
  src/services/errors.ts(20,12): error TS4114: This member must have an 'override' modifier because it overrides a member in the base class 'Error'.
  ```
- **Fix:** Added `override` to both `cause` declarations: `override readonly cause?: unknown;`. This matches the Phase 2 pattern on `backend/src/services/metadataService.ts:63` exactly (`override readonly cause: unknown;`), which the plan instructed to follow verbatim. The plan's Task 2 code block was written without the `override` keyword — the fix aligns with both the Phase 2 reference pattern and the strict TS config. No behavior change, no API change.
- **Files modified:** `backend/src/services/errors.ts`
- **Commit:** `448f90f` (the fix was applied before the single Task 2 commit, so both the compile error and its resolution are captured in one commit).

No other deviations — plan executed exactly as written otherwise. No auth gates, no blockers, no architectural questions.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 | CopilotContext types | `8aebea3` | `backend/src/types/copilot.ts` |
| 2 | ContextAssemblerError + ClaudeServiceError | `448f90f` | `backend/src/services/errors.ts` |

## Downstream Impact

Every remaining Phase 3 plan (03-02 StreamParser, 03-03 SystemPromptBuilder, 03-04 ContextAssembler, 03-05 ClaudeService, 03-06 context + chat routes, 03-07 export routes, 03-08 smoke) can now:

- `import type { CopilotContext, CopilotContextRequest, ServicesFired, ChatMessage, DashboardState, ErrorCode } from '../types/copilot.js'`
- `import { ContextAssemblerError, ClaudeServiceError } from '../services/errors.js'`

No additional type definitions required downstream. Phase 4's `ContextBadge` component (built in plan 04-*) will consume `ServicesFired` directly, per D-05.

## Self-Check: PASSED

- `backend/src/types/copilot.ts` — FOUND
- `backend/src/services/errors.ts` — FOUND
- commit `8aebea3` — FOUND
- commit `448f90f` — FOUND
- typecheck — PASS
