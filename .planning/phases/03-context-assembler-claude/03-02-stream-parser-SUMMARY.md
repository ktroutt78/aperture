---
phase: 03-context-assembler-claude
plan: 02
subsystem: backend-parser
tags: [phase-3, parser, streaming, offline-test, wave-1]
status: complete
completed: 2026-04-11
duration: 6m
tasks_completed: 1
tasks_total: 1
requires:
  - backend/src/types/copilot.ts (Plan 03-01 — ErrorCode type)
  - backend/src/lib/logger.ts (Phase 1 — pino child logger)
provides:
  - StreamParser class (stateful text-to-events transformer)
  - StreamParserEvent union (token | anomaly | suggestions | done | error)
  - TokenEvent | AnomalyEvent | SuggestionsEvent | DoneEvent | ErrorEvent interfaces
  - StreamParserHandler type alias
  - smoke:streamparser npm script (offline, zero-network)
affects:
  - Plan 03-05 (claudeService) — imports StreamParser + StreamParserEvent as verified primitive
  - Plan 03-06 (/chat route) — consumes the union directly, writes SSE frames per D-07
tech_stack:
  added: []
  patterns:
    - Offline unit test without framework (pure node:assert, matches pulseService.empty.test.ts)
    - Phase 1 logger .child({ module }) count-only logging discipline
    - Char-by-char state machine with speculative buffering for chunk-boundary robustness
key_files:
  created:
    - backend/src/services/streamParser.ts
    - backend/src/services/__tests__/streamParser.test.ts
  modified:
    - backend/package.json
decisions:
  - "Speculative pending-horizontal-whitespace buffer in text mode — whitespace runs (spaces/tabs) that turn out to precede `{` are dropped by the suggestions machine, otherwise flush on the next non-ws non-`{` char. Newlines are NOT buffered — they are narrative paragraph breaks per D-13, not pre-opener padding. This is the minimal change that satisfies test case 8's 'token stream ends at the first whitespace preceding the `{`' spec without affecting the happy-path tests."
  - "Per-char token emission — the parser emits token events one character at a time rather than batching runs. This is simpler to reason about for chunk-boundary correctness, keeps the state machine stateless between chars, and adds negligible SSE frame overhead (Phase 4 concatenates freely). Test 9's ordering invariant asserts collapsed-type order to be robust against this choice."
  - "Anomaly tag regex supports escaped `\\\"` inside value strings via `(?:[^\"\\\\]|\\\\.)*` — linear, anchored, no catastrophic backtracking (T-03-02-01). Unescape via simple `\\\\(.)` → `$1` after capture. Test 10 passes in the strict parsing branch (not the graceful-drop branch)."
  - "Suggestions brace-depth tracker with explicit string-mode handling — braces inside JSON string literals do not count toward depth, and backslash escapes inside strings are honored. 16KB buffer ceiling per T-03-02-02 mitigation."
  - "Parser state machine NEVER emits error — the `error` variant exists in the exported StreamParserEvent union solely so claudeService (Plan 03-05) can yield error events through the same type without `as unknown as StreamParserEvent` casts. Documented in a JSDoc block on the union itself so future maintainers do not remove it."
metrics:
  duration_minutes: 6
  tasks: 1
  files_touched: 3
  deviations: 0
  blockers: 0
requirements:
  - CTX-07
  - CTX-08
  - CTX-11
  - CTX-12
  - CTX-13
---

# Phase 03 Plan 02: StreamParser Summary

## One-liner

Chunk-boundary-robust stateful parser that transforms a raw Claude text stream into typed `token | anomaly | suggestions | done` events, strips `[ANOMALY: fieldName="x" value="y"]` tags and trailing `{"suggestions":[...]}` JSON from the wire without leaking a single character into token output, and exports a union that already includes the `error` variant so Plan 03-05's `claudeService` compiles without casts — all offline-tested with 11 deterministic cases including every chunk-boundary split inside both tag forms.

## What Was Built

### `backend/src/services/streamParser.ts` (Task 1)

A stateful `StreamParser` class owning two parallel state machines:

- **Anomaly tag machine** — `text → maybe-tag → in-tag → text`. On `[` we buffer speculatively; as long as the buffer remains a prefix of the literal `[ANOMALY:` we keep buffering; on mismatch we flush the buffered chars as token text and re-process the offending char from the top (fallback symmetry with the suggestions machine). Inside the tag body we accumulate until `]`, then parse via an anchored regex `^\[ANOMALY:\s+fieldName="((?:[^"\\]|\\.)*)"\s+value="((?:[^"\\]|\\.)*)"\]$` (linear, no catastrophic backtracking, supports `\"` escapes inside values). Malformed tags drop the buffer and log warn — never throw.

- **Suggestions JSON machine** — `text → maybe-suggestions → in-suggestions → text`. On `{` we enter the maybe-state and keep accumulating as long as the buffer remains a viable prefix of `{\s*"suggestions"\s*:` (walked explicitly by the helper `isSuggestionsPrefixPrefix`). Once the prefix regex matches, we transition to `in-suggestions` and track `{` depth with proper JSON-string handling (braces inside quoted strings don't count; `\\` and `\"` inside strings are honored). When depth returns to 0 we call `JSON.parse` on the accumulated buffer; on failure we log warn and emit `{ items: [] }` — never throw.

- **Speculative horizontal whitespace buffer** — while in `text` mode, spaces and tabs are held in a `pendingWhitespace` run. A following `{` drops the run (it was pre-opener padding, per D-09's whitespace tolerance language); any other non-ws char flushes it back out as token text; newlines flush immediately because they are paragraph breaks, not padding. This is the minimal change that made test case 8 pass without regressing tests 1–7.

### `StreamParserEvent` union

Exported as `token | anomaly | suggestions | done | error` with each variant carrying a typed `data` payload matching D-07 verbatim:

- `token { text: string }` — stripped of tag and JSON characters
- `anomaly { fieldName: string; value: string; raw: string }`
- `suggestions { items: string[] }` — parsed from trailing JSON or `[]` on any failure
- `done { stopReason: string; narrativeChars: number; usage: { inputTokens, outputTokens, cacheReadTokens } }`
- `error { code: ErrorCode; message: string }` — **NOT emitted by the parser state machine**, present in the union so `claudeService` (Plan 03-05) can yield error events through the same type without `as unknown as StreamParserEvent` casts. A JSDoc block on the union explicitly warns maintainers not to remove this variant.

`ErrorCode` is imported as a type-only import from `backend/src/types/copilot.js` (Plan 03-01), satisfying the zero-new-runtime-dependency constraint.

### `backend/src/services/__tests__/streamParser.test.ts` (Task 1)

Pure `node:assert/strict` test file — no vitest, no jest, no test framework — matching the style of Phase 2's `pulseService.empty.test.ts`. Runs under `tsx` via `pnpm --filter @aperture/backend smoke:streamparser` with zero network, zero env vars, zero credentials.

Eleven numbered cases plus a shared `assertInvariants` helper that every test calls:

1. **Happy path — single chunk, tag then suggestions.** Verifies exact event sequence and raw payload shapes.
2. **Chunk boundary mid-tag.** Feeds the same input split at positions 14, 15, 16, 32, 48, 53, 54 (inside `[ANOMALY:`, inside the tag body, and near the closing bracket). All produce the identical event sequence as the baseline.
3. **Chunk boundary mid-suggestions-JSON.** Sweeps every split position inside the trailing `{"suggestions":["q1","q2","q3"]}` substring (11 splits). No JSON characters leak into any token event.
4. **Multiple anomaly tags.** Three consecutive tags, narrative between them streams through, three anomaly events in order.
5. **Malformed tag (missing closing bracket at EOS).** Buffer is dropped with warn, only the prefix narrative survives, no crash, no anomaly events.
6. **Malformed suggestions JSON.** `{"suggestions":[unterminated` — emits empty suggestions, logs warn, never throws.
7. **No suggestions at all.** Pure narrative — parser emits empty suggestions + done at EOS.
8. **Whitespace tolerance on suggestions opener.** `text\n\n  {"suggestions": [ "a", "b", "c" ]}` — token text ends at `text\n\n`, the two-space indent is dropped by the speculative whitespace buffer.
9. **Event ordering invariant.** Collapsed event-type sequence is exactly `token → anomaly → token → suggestions → done`.
10. **Tag with escaped quotes inside value.** `[ANOMALY: fieldName="A" value="B\"C"]` — regex supports the escape, value unescapes to `B"C`, no crash. (Strict-parse branch exercised; graceful-drop branch remains available.)
11. **Compile-time type fence.** A top-level `const _typecheck: StreamParserEvent = { type: 'error', data: { code: 'ANTHROPIC_ERROR', message: 'x' } };` — if the union is ever narrowed to exclude `error`, `pnpm typecheck` fails with a clear type error before any runtime case executes.

The shared `assertInvariants` helper enforces on EVERY case that:
- No token event contains the substring `[ANOMALY`
- No token event contains the substring `{"suggestions"`
- `done` is the last event, emitted exactly once
- `suggestions` precedes `done`
- Parser never emits `error` or `context` (those are produced by claudeService and the route, respectively)

### `backend/package.json` (Task 1)

Added `smoke:streamparser` between `smoke:pulse:empty` and `smoke:phase2`, preserving the Phase 2 ordering convention (`auth → metadata → vizql → pulse → pulse:empty → streamparser → phase2`). Zero new dependencies — the parser uses only the existing `pino` logger and built-in `JSON.parse`, and `ErrorCode` is a type-only import.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend smoke:streamparser` | PASS (11/11 cases green) |
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors) |
| `test -f backend/src/services/streamParser.ts` | PASS |
| `test -f backend/src/services/__tests__/streamParser.test.ts` | PASS |
| `grep -q "export class StreamParser"` | PASS |
| `grep -q "feed(chunk: string): void"` | PASS |
| `grep -q "end(doneMeta"` | PASS |
| `grep -q "type: 'token'"` | PASS |
| `grep -q "type: 'anomaly'"` | PASS |
| `grep -q "type: 'suggestions'"` | PASS |
| `grep -q "type: 'done'"` | PASS |
| `grep -q "type: 'error'"` (Blocker 4: union includes error variant) | PASS |
| `grep -q "import type { ErrorCode } from '../types/copilot.js'"` | PASS |
| `grep -q "smoke:streamparser" backend/package.json` | PASS |
| Test file contains compile-time error-variant fence (`type: 'error'`) | PASS |
| `grep -c "Test [0-9]" …/streamParser.test.ts` | 35 (well above the required 8) |
| No `[ANOMALY` leak in any token event (case 2 sweep) | PASS |
| No `{"suggestions"` leak in any token event (case 3 sweep) | PASS |
| No new runtime dependency added | PASS — zero deps added; `ErrorCode` is type-only |

### Automated invariant enforcement

Every one of the 11 test cases calls the shared `assertInvariants(label, res)` helper, which verifies on EVERY event emitted:

- `token.text` contains neither `[ANOMALY` nor `{"suggestions"`
- Parser never emitted `error` or `context`
- Last event is `done`
- Exactly one `done` event
- `suggestions` precedes `done`

This enforces T-03-02-04 (partial tag leakage) and D-07 (event ordering) with a single shared assertion called from every test — a regression in any case fails loudly with its label in the message.

## Deviations from Plan

None — plan executed exactly as written.

### Auth gates

None — offline test, zero network, zero credentials required.

### Architectural decisions

None — the plan already specified the state machine structure, regex shapes, buffer ceilings, and union contract verbatim. The executor's only design freedom was the pending-horizontal-whitespace buffer needed to satisfy test case 8, which is documented in the Decisions section above and comes from the plan's own D-09 "whitespace tolerance on the suggestions opener" language.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 | StreamParser + offline test + npm script (TDD RED → GREEN) | `99df210` | `backend/src/services/streamParser.ts`, `backend/src/services/__tests__/streamParser.test.ts`, `backend/package.json` |

Note: Per plan 03-02 Task 1's RED → GREEN flow, the test was written first and confirmed failing (module-not-found import error) before the parser implementation was added. Per the parallel-executor `--no-verify` protocol, both RED and GREEN were captured in a single commit rather than split — the test file and parser file were committed together once the full case set was green. The RED-phase module-not-found error is reproducible by temporarily renaming or deleting `streamParser.ts` and rerunning `pnpm --filter @aperture/backend smoke:streamparser`.

## Downstream Impact

Plan 03-05 (ClaudeService) and Plan 03-06 (`/chat` route) can now:

- `import { StreamParser, type StreamParserEvent } from './streamParser.js'`
- Instantiate `new StreamParser((ev) => { /* forward to SSE writer */ })`
- Forward the Anthropic SDK `text_delta` events via `parser.feed(delta)`
- Call `parser.end({ stopReason, usage })` on stream completion
- Yield typed `error` events (`{ type: 'error', data: { code: 'ANTHROPIC_TIMEOUT', message } }`) through the same union without casts — the compile-time fence in `streamParser.test.ts` guarantees this stays true across future edits.

The chunk-boundary robustness is proven by the deterministic split sweeps in test cases 2 and 3, so downstream plans can treat StreamParser as a verified primitive and focus on wiring rather than on the parser internals.

## Threat Flags

None — this plan is a pure offline state-machine primitive with no new network surface, no new trust boundary, and no schema changes. All threats in the plan's threat register (`T-03-02-01` through `T-03-02-04`) are mitigated as planned: regex is anchored and linear (T-03-02-01), both buffers have explicit size ceilings at 8KB / 16KB (T-03-02-02), logging is count-only — the raw tag body and suggestions JSON are never logged at info level, only lengths (T-03-02-03), and the chunk-boundary sweep tests (cases 2 and 3) grep-enforce that no tag or JSON character reaches a token event (T-03-02-04).

## Self-Check: PASSED

- `backend/src/services/streamParser.ts` — FOUND
- `backend/src/services/__tests__/streamParser.test.ts` — FOUND
- `backend/package.json` — MODIFIED (smoke:streamparser script added)
- commit `99df210` — FOUND (`git log --oneline -1` returns it)
- `pnpm --filter @aperture/backend smoke:streamparser` — exits 0 (11/11 cases green)
- `pnpm --filter @aperture/backend typecheck` — exits 0
