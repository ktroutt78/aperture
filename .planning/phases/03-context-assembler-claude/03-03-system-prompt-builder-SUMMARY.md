---
phase: 03-context-assembler-claude
plan: 03
subsystem: backend-services
tags: [phase-3, prompt, truncation, token-budget, offline-test, wave-1]
status: complete
completed: 2026-04-11
duration: 8m
tasks_completed: 2
tasks_total: 2
requires:
  - backend/src/types/copilot.ts (Plan 03-01: CopilotContext, DashboardState)
  - backend/src/types/tableau.ts (Phase 2: SchemaField, PulseContext, LiveDataContext, PulseInsightBundle)
  - backend/src/lib/logger.ts (Phase 1: createLogger with redact paths)
provides:
  - buildSystemPrompt(context) -> AnthropicContentBlock[]
  - buildUserTurn(state, question) -> string
  - AnthropicContentBlock (local type)
  - estimateContextChars(context) -> number
  - truncateContext(context, target?, opts?) -> CopilotContext
  - TARGET_CHARS, SAFETY_MARGIN, EFFECTIVE_TARGET, HALVE_SEQUENCE
affects:
  - Plan 03-04 (Context Assembler) — calls estimateContextChars + truncateContext
  - Plan 03-05 (Claude Service) — feeds buildSystemPrompt output into messages.stream({ system })
  - Plan 03-06 (/chat route) — calls buildUserTurn before appending the user-turn content
tech_stack:
  added: []
  patterns:
    - Pure offline functions with fixture-based unit tests (no network, no test framework)
    - Optional logger injection for test mocking (TruncateOpts.logger)
    - Readonly-in, readonly-out with explicit MutablePulseContext local type for in-place FIFO mutation
    - Markdown pipe escaping on all user-controlled schema strings (T-03-03-03)
key_files:
  created:
    - backend/src/services/systemPromptBuilder.ts
    - backend/src/services/__tests__/systemPromptBuilder.test.ts
    - backend/src/services/contextBudget.ts
    - backend/src/services/__tests__/contextBudget.test.ts
  modified:
    - backend/package.json
decisions:
  - "Top-3 insight bundle selection weights by max(thumbsUp - thumbsDown) across matching feedback rows (signed, stable on ties). Keeps the fixture output deterministic even when every feedback row is 0/0."
  - "MutablePulseContext local interface shadows the readonly PulseContext so Step 2 (pulse bundle FIFO drop) can call Array.prototype.shift() in-place without fighting the exported readonly type."
  - "cloneMap() helper returns a shallow copy keyed the same way as SchemaContext.datasources so the working schema object passed to estimateContextChars between Step 3 sub-steps is never re-mutated by an earlier closure."
  - "estimateContextChars ignores wrapper markdown (headers, table separators, newlines) — those are dwarfed by the 12.5% D-16 safety margin and would only couple the estimator to the prompt builder."
metrics:
  duration_minutes: 8
  tasks: 2
  files_touched: 5
  deviations: 1
  blockers: 0
requirements:
  - CTX-03
  - CTX-04
  - CTX-05
  - CTX-06
  - CTX-07
  - CTX-08
  - CTX-09
---

# Phase 03 Plan 03: System Prompt Builder + Context Budget/Truncator Summary

## One-liner

Two offline pure-function modules: `systemPromptBuilder` assembles Anthropic content blocks in D-13 order with the D-14 cache marker and the inviolable output contract (anomaly tags, exactly three suggestions, 3-paragraph cap, field-captions rule, do-not-repeat-Pulse); `contextBudget` exposes `estimateContextChars` plus a D-17 priority-order truncator (rows -> pulse bundles -> schema fields, preserving >=1 field per datasource). 18 offline tests, 0 new runtime deps.

## What Was Built

### Task 1 — `backend/src/services/systemPromptBuilder.ts`

Pure function module, zero runtime dependencies beyond the Plan 03-01 / Phase 2 types and the Phase 1 logger (not used here — pure functions, no logging).

**`buildSystemPrompt(context: CopilotContext): AnthropicContentBlock[]`**

Returns an ordered array of Anthropic content blocks in D-13 order:

1. `# Role` — identity + purpose
2. `# Output Contract` — six numbered inviolable rules
3. `# Schema` — per-datasource markdown tables (`| caption | dataType | description |`), lineage on a second line when present **— carries `cache_control: { type: 'ephemeral' }` (D-14)**
4. `# Pulse` — per-datasource metric definitions + top-3 insight bundles by signed feedback weight, with `(no metrics configured)` fallback when `hasMetrics === false`
5. `# Live Data` — per-datasource rows as compact JSON

Every section header string is literal so acceptance-criteria greps are trivial. Every pipe character in user-controlled schema strings (caption, dataType, description) is escaped to `\|` and newlines are collapsed so a rogue description cannot shred the markdown table (T-03-03-03 mitigation).

The output contract block literally contains:

- `[ANOMALY: fieldName="x" value="y"]` — exact template for Phase 4's mark highlighter
- `{"suggestions"` — exact opening of the trailing JSON chip block
- `exactly three` — follow-up questions count
- `no more than 3 paragraphs` — 3-paragraph cap
- `Do not repeat Pulse summaries word-for-word` — build-on-pulse-without-repeating
- `Use the exact field captions` — CTX-05

The string `claude-sonnet-4-20250514` is intentionally absent (model lock is a config concern that belongs in Plan 03-05's `claudeService`, not in the prompt).

**`buildUserTurn(state: DashboardState, question: string): string`**

D-15 user-turn preamble. Wraps every `/chat` question in:

```
<dashboard_state>
workbook: {workbookName}
worksheet: {worksheetName}
selected_marks: Region=West, ...
active_filters: Year=[2025,2026]; ...
</dashboard_state>

<question>{question}</question>
```

Empty `selectedMarks` / `activeFilters` render as the literal `none` (not empty lines), so Claude has unambiguous signal. This preserves system-prompt cacheability across turns because the system prompt is identical turn-to-turn for a given schema — dashboard state varies per turn but rides entirely in the user-turn content.

**`AnthropicContentBlock`** — local interface (`{ type: 'text', text, cache_control? }`) so Plan 03-05's Anthropic SDK integration can pass the array directly into `anthropic.messages.stream({ system: [...] })` without conversion. Keeping the shape local means we don't need `@anthropic-ai/sdk` as a build-time dep of this module.

**Offline tests (9 cases, `systemPromptBuilder.test.ts`):**

1. Section order — `indexOf('# Role') < '# Output Contract' < '# Schema' < '# Pulse' < '# Live Data'`
2. Output contract literal strings — every phrase above, plus the negative assertion on `claude-sonnet-4-20250514`
3. Cache marker — exactly the Schema block carries `cache_control: { type: 'ephemeral' }`; every other block is bare
4. Schema rendering — 2 datasources × 3 fields, captions + dataTypes + descriptions + table headers all present
5. Pulse rendering with `hasMetrics: false` — literal `(no metrics configured)`
6. Pulse rendering with `hasMetrics: true` — top-3 weighted selection cuts the lowest-weighted bundle
7. Live data rendering — 3 datasources × 10 rows each, rows present as compact JSON
8. User-turn wrapper — opening/closing tags, workbook/worksheet/marks/filters/question in order, blank line between close tag and question
9. User-turn empty arrays — `selected_marks: none` and `active_filters: none`

### Task 2 — `backend/src/services/contextBudget.ts`

**Exported constants (D-16):**

| Constant | Value | Purpose |
|---|---|---|
| `TARGET_CHARS` | `70_000` | Upper bound on assembled prompt chars |
| `SAFETY_MARGIN` | `0.125` | 12.5% headroom for user turn, messages, glue |
| `EFFECTIVE_TARGET` | `61_250` | `floor(TARGET_CHARS × (1 - SAFETY_MARGIN))` |
| `HALVE_SEQUENCE` | `[500, 250, 125, 62, 31, 15, 7, 0]` | D-17 Step 1 row caps |

**`estimateContextChars(context: CopilotContext): number`**

Pure deterministic char estimator. Counts:

- Schema: `caption.length + dataType.length + description.length + sum(upstreamLineage[].length)` for every field in every datasource
- Live data: `JSON.stringify(row).length` per row, plus `sum(fields[].length)` per datasource
- Pulse: `metricDefinition.name.length + metricDefinition.description.length` per metric + `insightBundle.summary.length` per bundle

Wrapper markdown (headers, table separators, newlines) is intentionally not counted — it's dwarfed by the 12.5% safety margin and would couple the estimator to the prompt builder's exact rendering.

**`truncateContext(context, target?, opts?): CopilotContext`**

Deterministic truncation in D-17 priority order. Every step is a check-then-act loop against `estimateContextChars` so the algorithm short-circuits as soon as the target is met:

1. **Halve rows in lockstep** — iterates `HALVE_SEQUENCE` values; after each application, every datasource's row count equals the same cap (500, then 250, then 125, ...). Halving is proportional — one datasource is never trimmed while others keep their rows.
2. **Drop Pulse bundles FIFO, round-robin** — `insightBundles[0]` is `shift()`ed from every datasource's bundle list in round-robin passes. Metric definitions and feedback metadata are preserved (only bundles are dropped). Loop safety counter: 10,000 iterations.
3. **Trim schema fields in order** — (3a) drop `description` (set to `''`) across every field, (3b) drop `upstreamLineage` (set to `[]`), (3c) drop whole fields halve-per-datasource while preserving `>= 1` field per datasource. Loop safety counter: 200 iterations.

**`servicesFired.truncated` is set to `true`** via a `finalize()` helper whenever any step fired. When nothing fired (under-budget input), the returned context is referentially identical to the input.

**Logging** — every step logs counts-only at info level using a child logger (`module: 'contextBudget'`). Shapes:

- `{ step: 'halve-rows', cap, datasources, rowsPerDs }`
- `{ step: 'drop-pulse-bundles', remaining }`
- `{ step: 'trim-schema-descriptions' }`
- `{ step: 'trim-schema-lineage' }`
- `{ step: 'trim-schema-fields-whole', totals }`

The `TruncateOpts.logger` parameter allows tests to inject a mock logger and assert which steps fired. T-03-03-05 is mitigated by never logging raw content (no row payloads, no Pulse summary text, no schema descriptions).

**Offline tests (9 cases, `contextBudget.test.ts`):**

1. Exported D-16/D-17 constants match spec exactly
2. `estimateContextChars` deterministic and within 1% of a hand-computed reference
3. Under-budget input → returned unchanged, `truncated: false`
4. Live data halving on a ~150k-char fixture — final row counts ∈ `HALVE_SEQUENCE`, `halve-rows` logged, post-truncation estimate ≤ target
5. Halving is proportional — 3 datasources × 500 rows → all three end at the same cap
6. Pulse bundle FIFO drop on a 100-bundle fixture (rows already at 0) — some bundles dropped, first remaining bundle's id > `b0`, metric definitions preserved, `drop-pulse-bundles` logged
7. Schema trim order on a 200-field fixture (rows=0, bundles=0) — post-truncation ≤ target, `trim-schema*` logged, every datasource retains ≥1 field
8. Extreme truncation pressure (target=500 chars, 3 datasources × 50 fields with 1000-char descriptions) — minimum-1-field-per-datasource invariant holds
9. `>70k-char` fixture combining rows + bundles + schema — pulled under `EFFECTIVE_TARGET`, `truncated: true`

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend smoke:systemprompt` | PASS (9/9) |
| `pnpm --filter @aperture/backend smoke:budget` | PASS (9/9) |
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors after Deviation #1 fix) |
| Task 1 grep acceptance criteria (17 patterns) | PASS |
| Task 2 grep acceptance criteria (9 patterns) | PASS |
| `grep -c 'claude-sonnet-4-20250514' backend/src/services/systemPromptBuilder.ts` | 0 (model lock kept out of prompt) |
| No new runtime dependencies | PASS (both files use stdlib + existing logger only) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `readonly PulseInsightBundle[]` cannot call `Array.prototype.shift()`**

- **Found during:** Task 2 typecheck (initial GREEN run)
- **Issue:** The plan's verbatim Step 2 code spread `{ ...p, insightBundles: [...p.insightBundles] }` to produce a mutable copy, but because `PulseContext.insightBundles` is typed as `readonly PulseInsightBundle[]` in `backend/src/types/tableau.ts`, the spread inferred the same readonly type on the resulting object. `tsc` rejected with:
  ```
  src/services/contextBudget.ts(152,28): error TS2339: Property 'shift' does not exist on type 'readonly PulseInsightBundle[]'.
  ```
  Runtime tests passed (tsx is permissive), but the typecheck gate is load-bearing for the CI path.
- **Fix:** Declared a local `MutablePulseContext` interface with `insightBundles: PulseInsightBundle[]` (non-readonly) so Step 2 can `shift()` bundles in place. Explicit field-by-field construction in the `.map()` call so the resulting object widens cleanly to `MutablePulseContext[]`. The exported `PulseContext` type in `types/tableau.ts` is not modified — readonly remains the public contract, mutability is a strictly local implementation detail of the truncator.
- **Files modified:** `backend/src/services/contextBudget.ts` (same commit as Task 2)
- **Commit:** `29eb2b5`
- **Rationale:** Matches the Phase 2 readonly-in / readonly-out contract while permitting in-place FIFO. No API change, no test change.

No other deviations — plan executed as written. No auth gates, no blockers, no architectural questions.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 | systemPromptBuilder + offline tests + npm script | `35b073f` | `backend/src/services/systemPromptBuilder.ts`, `backend/src/services/__tests__/systemPromptBuilder.test.ts`, `backend/package.json` |
| 2 | contextBudget + offline tests + npm script | `29eb2b5` | `backend/src/services/contextBudget.ts`, `backend/src/services/__tests__/contextBudget.test.ts`, `backend/package.json` |

## Downstream Impact

- **Plan 03-04 (Context Assembler)** — will call `estimateContextChars(ctx)` immediately after merge to populate `servicesFired.contextChars`, then call `truncateContext(ctx, EFFECTIVE_TARGET)` before handing the context to the prompt builder. The truncator already sets `servicesFired.truncated` so the assembler doesn't have to.
- **Plan 03-05 (Claude Service)** — will import `buildSystemPrompt` and pass its output directly into `anthropic.messages.stream({ system: <blocks> })`. The `AnthropicContentBlock` shape is structurally identical to the SDK's expected system block type, so no mapping layer is needed.
- **Plan 03-06 (`/chat` route)** — will import `buildUserTurn` and prepend its output to every incoming user question before appending to the `messages` array sent to Anthropic. The client never sees the wrapped form; the client sends raw questions and the backend wraps.
- **Plan 03-05 error path** — `truncateContext` never throws, even under extreme pressure. The claudeService error path does not need a truncation-specific error code.

## Known Stubs

None — both modules are fully implemented end-to-end with no placeholder data paths.

## Self-Check: PASSED

- `backend/src/services/systemPromptBuilder.ts` — FOUND
- `backend/src/services/__tests__/systemPromptBuilder.test.ts` — FOUND
- `backend/src/services/contextBudget.ts` — FOUND
- `backend/src/services/__tests__/contextBudget.test.ts` — FOUND
- `backend/package.json` — MODIFIED (smoke:systemprompt + smoke:budget scripts added)
- commit `35b073f` — FOUND in `git log`
- commit `29eb2b5` — FOUND in `git log`
- `pnpm --filter @aperture/backend smoke:systemprompt` — PASS (9/9)
- `pnpm --filter @aperture/backend smoke:budget` — PASS (9/9)
- `pnpm --filter @aperture/backend typecheck` — PASS (0 errors)
