---
phase: 03-context-assembler-claude
reviewed: 2026-04-11T12:00:00Z
depth: standard
files_reviewed: 12
files_reviewed_list:
  - backend/src/types/copilot.ts
  - backend/src/services/errors.ts
  - backend/src/services/streamParser.ts
  - backend/src/services/systemPromptBuilder.ts
  - backend/src/services/contextBudget.ts
  - backend/src/services/contextAssembler.ts
  - backend/src/services/claudeService.ts
  - backend/src/routes/context.ts
  - backend/src/routes/chat.ts
  - backend/src/routes/export.ts
  - backend/src/server.ts
  - backend/src/services/tableauAuth.ts
findings:
  critical: 1
  warning: 5
  info: 4
  total: 10
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-04-11T12:00:00Z
**Depth:** standard
**Files Reviewed:** 12
**Status:** issues_found

## Summary

Phase 3 introduces the context assembly pipeline (fan-out to Metadata/VDS/Pulse), Claude streaming service, SSE routes, export routes, and rate limiting. The code is well-structured overall with strong defensive patterns: SSRF prevention on export routes, input validation with UUID regex on all LUID inputs, proper SSE lifecycle management, and careful secret-redaction in logging.

Key concerns: one critical timer leak in the context assembler, several moderate issues around dead code, missing `done` event on error paths in SSE streaming, and a validation gap in the context route that allows empty datasource arrays (inconsistent with the chat route).

## Critical Issues

### CR-01: Timer leak in contextAssembler — `deadlinePromise` setTimeout never cleared

**File:** `backend/src/services/contextAssembler.ts:126-131`
**Issue:** The `deadlinePromise` creates a `setTimeout` with `TOTAL_BUDGET_MS` (2500ms) but never clears the timer handle. If `assembleContext` resolves before the deadline (the normal fast path), the timer callback fires 2.5s later and resolves a dangling promise. While the resolved value is never consumed after the race completes, the timer itself keeps the Node.js event loop alive unnecessarily and prevents the process from exiting cleanly in test harnesses or short-lived serverless contexts. Under sustained load (60 req/min rate limit), this means up to ~150 orphaned timers at any given instant.
**Fix:**
```typescript
let deadlineFired = false;
let deadlineTimer: ReturnType<typeof setTimeout>;
const deadlinePromise: Promise<'BUDGET_EXCEEDED'> = new Promise((resolve) => {
  deadlineTimer = setTimeout(() => {
    deadlineFired = true;
    resolve('BUDGET_EXCEEDED');
  }, TOTAL_BUDGET_MS);
});

// ... at the end of the function, before returning:
clearTimeout(deadlineTimer!);
```
Wrap the entire body after the empty-input short-circuit in a `try/finally` that clears the timer.

## Warnings

### WR-01: Dead code in `selectTopInsightBundles` — `weight` variable computed but never used

**File:** `backend/src/services/systemPromptBuilder.ts:148-157`
**Issue:** The function computes `weight` (line 149, clamped to non-negative via `if (w > weight)`) and then immediately recomputes `signedWeight` (line 159) using the exact same loop logic but allowing negatives. The `weight` variable and its loop (lines 149-154) are dead code — the function only uses `signedWeight` (line 167). This is not a bug (the final sort uses `signedWeight` correctly) but it doubles the iteration cost for no reason and confuses readers.
**Fix:** Remove the `weight` variable and its computation loop (lines 148-154). Rename `signedWeight` to `weight` for clarity.

### WR-02: `/context` route allows empty `datasourceLuids[]` but `/chat` requires non-empty

**File:** `backend/src/routes/context.ts:41` vs `backend/src/routes/chat.ts:83`
**Issue:** The `/context` validation (line 41) accepts `datasourceLuids` as any array including empty, while `/chat` (line 83) explicitly requires `b.datasourceLuids.length === 0` to fail. While `assembleContext` handles empty LUIDs gracefully (short-circuit at line 108 of contextAssembler.ts), the inconsistency is surprising — a caller testing with `/context` may get an empty-but-valid response and then be confused when `/chat` rejects the same body. If the intent is that `/context` is a debug endpoint that tolerates empty input, this should be documented.
**Fix:** Either add `|| b.datasourceLuids.length === 0` to the context route validation to match chat, or add a JSDoc comment explaining the intentional divergence.

### WR-03: Chat SSE `catch` block writes `error` event but no `done` event

**File:** `backend/src/routes/chat.ts:214-219`
**Issue:** The defense-in-depth `catch` block (lines 214-219) writes an `error` SSE event but does not write a terminal `done` event. The SSE contract (D-07) states that `done` is always the last event. If `streamChat` ever throws (violating its own contract), the client receives `error` with no `done`, which may leave Phase 4's panel in a "loading" state indefinitely until the connection closes.
**Fix:**
```typescript
} catch (err) {
  const message = (err as Error)?.message ?? 'unknown';
  write('error', { code: 'INTERNAL' satisfies ErrorCode, message });
  write('done', {
    stopReason: 'error',
    narrativeChars: 0,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  });
}
```

### WR-04: `selectedMarks` and `activeFilters` arrays are not deeply validated in either route

**File:** `backend/src/routes/context.ts:47-48` and `backend/src/routes/chat.ts:91-92`
**Issue:** Both routes check `Array.isArray` for `selectedMarks` and `activeFilters` but then cast them directly to the typed arrays without validating element shapes. Malformed elements (e.g., `selectedMarks: [42, null, "oops"]`) pass validation and flow into `buildUserTurn` which calls `m.field` and `m.value` on each element. This won't crash (accessing `.field` on a number returns `undefined`, and template literals coerce to `"undefined"`), but it produces garbled Claude prompts. The comment says "the assembler + downstream services do their own field-level checks" but `buildUserTurn` does no such checks.
**Fix:** Add element-shape validation:
```typescript
for (const m of b.selectedMarks) {
  if (!m || typeof m !== 'object') return { error: 'selectedMarks elements must be objects' };
  const mo = m as Record<string, unknown>;
  if (typeof mo.field !== 'string' || typeof mo.value !== 'string') {
    return { error: 'selectedMark must have string field and value' };
  }
}
```

### WR-05: Slack Block Kit `mrkdwn` text uses unescaped user input

**File:** `backend/src/routes/export.ts:74-76`
**Issue:** The anomaly `fieldName` and `value` are interpolated directly into Slack `mrkdwn` text (`:warning: ${a.fieldName} = ${a.value}`). Slack's mrkdwn supports formatting like `*bold*`, `<link|text>`, and `@here` mentions. A crafted anomaly value of `@here <https://evil.com|Click me>` would produce a visible @here ping and a clickable link in the Slack channel. While the anomaly data originates from Claude's output (not directly from user input), the narrative and workbook/worksheet names (lines 65, 69) are also unescaped.
**Fix:** Escape Slack mrkdwn special characters in user-controlled fields:
```typescript
function escapeSlackMrkdwn(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Then:
text: `:warning: ${escapeSlackMrkdwn(a.fieldName)} = ${escapeSlackMrkdwn(a.value)}`
```

## Info

### IN-01: Duplicated LUID_REGEX across three files

**File:** `backend/src/routes/context.ts:34`, `backend/src/routes/chat.ts:58`, `backend/src/routes/export.ts:26`
**Issue:** The same UUID regex is defined independently in three route files. If the LUID format ever changes (e.g., Tableau starts using longer IDs), all three must be updated in lockstep.
**Fix:** Extract to a shared validation utility, e.g., `backend/src/lib/validation.ts`.

### IN-02: `systemPromptBuilder` does not cap live data rows in the prompt

**File:** `backend/src/services/systemPromptBuilder.ts:188-189`
**Issue:** `buildLiveDataBlock` serializes every row via `JSON.stringify(row)` with no row count limit. The truncation logic in `contextBudget.ts` should have already capped rows, but if a caller bypasses truncation (e.g., in tests or a future debug path), the system prompt could become very large. This is informational since the truncator is correctly wired in the production path.
**Fix:** Consider adding a defensive `rows.slice(0, MAX_DISPLAY_ROWS)` in the prompt builder as a belt-and-suspenders measure.

### IN-03: `contextBudget.ts` `cloneMap` does a shallow copy of field arrays

**File:** `backend/src/services/contextBudget.ts:269-275`
**Issue:** `cloneMap` copies the record keys but shares the underlying `SchemaField[]` arrays by reference. This is currently safe because the caller (`truncateContext` step 3c) replaces entire arrays via `datasources[luid] = current.slice(0, keep)` rather than mutating elements in place. However, if future code mutates individual fields within a cloned map, it would affect the original context. Purely informational — no bug today.
**Fix:** No action needed unless mutation patterns change. Document the shallow-copy contract.

### IN-04: `claudeService.ts` `max_tokens` is hardcoded to 1024

**File:** `backend/src/services/claudeService.ts:150`
**Issue:** The Claude `max_tokens` parameter is hardcoded to 1024. For a 3-paragraph narrative plus anomaly tags plus a trailing JSON suggestions block, 1024 tokens may be tight depending on the data complexity. If responses are consistently truncated in UAT, this will need to be bumped. This is informational for now since the output contract mandates concise responses.
**Fix:** Consider making this configurable via env or at least documenting the rationale for 1024 in a comment.

---

_Reviewed: 2026-04-11T12:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
