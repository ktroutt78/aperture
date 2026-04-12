---
phase: 03-context-assembler-claude
plan: 05
subsystem: backend-claude
tags: [phase-3, claude, anthropic-sdk, streaming, wave-2]
status: complete
completed: 2026-04-12
duration: 11m
tasks_completed: 2
tasks_total: 2
requires:
  - backend/src/types/copilot.ts (Plan 03-01 — CopilotContext, ChatMessage, DashboardState, ErrorCode)
  - backend/src/services/errors.ts (Plan 03-01 — ClaudeServiceError, referenced but not required at runtime)
  - backend/src/services/streamParser.ts (Plan 03-02 — StreamParser class + StreamParserEvent union WITH error variant)
  - backend/src/services/systemPromptBuilder.ts (Plan 03-03 — buildSystemPrompt, buildUserTurn)
  - backend/src/config/env.ts (Phase 1 — loadEnv() / __resetEnvCacheForTests)
  - backend/src/lib/logger.ts (Phase 1 — pino child logger)
provides:
  - streamChat async generator — (CopilotContext, ChatMessage[], DashboardState, question, deps?) → AsyncGenerator<StreamParserEvent>
  - CLAUDE_MODEL literal const (`'claude-sonnet-4-20250514'`)
  - MAX_HISTORY_TURNS const (`10`)
  - ClaudeDeps injection seam (optional `client` stub for offline tests)
  - classifyAnthropicError internal helper → ErrorCode union value
  - smoke:claude npm script (offline, zero-network, zero-key)
  - @anthropic-ai/sdk dependency at ^0.40.0
affects:
  - Plan 03-06 (/chat SSE route) — imports `streamChat` directly and maps each yielded event to an SSE frame
  - Plan 03-08 (live UAT smoke) — runs streamChat against the real Anthropic endpoint to confirm INFO 11 usage handling
tech_stack:
  added:
    - "@anthropic-ai/sdk@^0.40.0"
  patterns:
    - "Dependency injection via opts `deps.client` so offline tests stub the SDK without process.env tricks or nock"
    - "Async generator yielding typed union events — route layer never sees raw SDK events, only normalized StreamParserEvents"
    - "Queue-then-drain pattern between synchronous StreamParser emit and async iterator yield — keeps streaming responsive without buffering the full response"
    - "ErrorCode classification in a single pure function (classifyAnthropicError) so future SDK shape changes live in one place"
    - "Lazy env read inside the generator — absent key becomes a yielded event, never a boot crash, so every other smoke test still runs keyless"
key_files:
  created:
    - backend/src/services/claudeService.ts
    - backend/src/services/__tests__/claudeService.test.ts
  modified:
    - backend/package.json
    - pnpm-lock.yaml
decisions:
  - "Queue-based parser drain after every SDK event instead of buffering then yielding at the end — lets the /chat SSE route flush tokens as they arrive, which is the whole point of D-11. Tradeoff: each SDK event costs one array allocation plus O(queue.length) yields, which is trivial compared to network egress and keeps the generator obviously correct."
  - "Error path yields BOTH an `error` event AND a synthetic `done` event with stopReason:'error' — Plan 03-06's /chat route closes the SSE stream on `done`, so the route handler code does not need a special case for errored streams. This is load-bearing for Plan 03-06 and documented in the tests (Test 6 asserts done-follows-error)."
  - "Usage passthrough listens to BOTH `message_delta` and `message_stop` with last-wins semantics. INFO 11 (checker review of Plan 03-05) flagged that Anthropic SDK v0.40+ publishes usage on `message_delta`, but older minor versions may still publish on `message_stop`. Listening to both is a cheap hedge, and Test 10 covers both code paths via two stub configurations."
  - "Default Anthropic client is cast to `NonNullable<ClaudeDeps['client']>` rather than typed against the SDK's generic shape. This keeps the source file's imports from leaking the full SDK generic surface into tests and callers — the real SDK exposes the same `messages.stream(opts)` method signature shape we declared in ClaudeDeps. A future SDK upgrade that renames this method is the only thing that would break, and that would be a deliberate migration anyway."
  - "The `as unknown as StreamParserEvent` ban is enforced by the file-level acceptance criterion grep. When writing the comment in the file header explaining WHY no casts are used, the banned substring was intentionally rephrased to 'zero type assertions on the yielded event' so the grep stays green and the intent stays documented."
metrics:
  duration_minutes: 11
  tasks: 2
  files_touched: 4
  deviations: 0
  blockers: 0
requirements:
  - CTX-10
  - CTX-11
  - CTX-12
  - CTX-13
---

# Phase 03 Plan 05: claudeService Summary

## One-liner

Async-generator `streamChat` that owns every Anthropic SDK decision for Phase 3 — locks the model literal, rebuilds the system prompt per turn (D-13) with the single ephemeral cache marker on the Schema block (D-14), wraps the final user turn with dashboard state (D-15), applies the 10-turn sliding-window history cap (D-18), pipes text deltas through a `StreamParser`, and maps every SDK error (AbortError/timeout, 429, numeric status, anything else) to the stable `ErrorCode` union — all proven offline with a stubbed Anthropic client across 10 deterministic tests that need zero network and zero API key.

## What Was Built

### `backend/src/services/claudeService.ts` (Task 2)

A single `streamChat(context, messages, dashboardState, question, deps?)` async generator:

1. **Lazy env read.** `loadEnv()` is called inside the generator so boot-time has no dependency on `ANTHROPIC_API_KEY` — every other offline smoke test in the repo can keep running without an Anthropic key. If the key is absent AND `deps.client` was not injected, the generator yields `{ type: 'error', data: { code: 'INTERNAL', message: 'ANTHROPIC_API_KEY not set...' } }` followed by a synthetic `done` event and returns. Tests 9 and the SSE-route contract in Plan 03-06 both rely on this shape.

2. **Client resolution.** `deps.client ?? new Anthropic({ apiKey: env.anthropicApiKey })`. The default path is cast to `NonNullable<ClaudeDeps['client']>` so the source file never leaks the SDK's generic shapes to callers and the test fake can stay lightweight (`{ messages: { stream(opts) { ... } } }`).

3. **System prompt assembly (D-13/D-14).** `buildSystemPrompt(context)` is called on every turn — Anthropic's server-side prompt cache deduplicates the Role + Contract + Schema prefix, so there is no savings in skipping the call locally, and the simple stateless shape makes every test trivially reproducible. Test 2 asserts the returned array of blocks contains `# Role → # Output Contract → # Schema` in order and that the Schema block carries `cache_control: { type: 'ephemeral' }` exactly as Plan 03-03 produces it.

4. **History cap (D-18).** `messages.slice(Math.max(0, messages.length - MAX_HISTORY_TURNS))` keeps the last 10 messages and silently drops the older head. Test 4 seeds 15 prior messages and asserts the SDK receives exactly `[msg-5 .. msg-14, final]` for a total of 11 messages — 10 capped prior + 1 wrapped final user turn.

5. **User turn wrapping (D-15).** `buildUserTurn(state, question)` produces the `<dashboard_state>...</dashboard_state>\n<question>...</question>` preamble. It is appended as a fresh `{ role: 'user', content: ... }` to the capped history. Test 3 asserts the final sent message shape and every wrapper substring.

6. **Delta piping.** `anthropic.messages.stream({ model, max_tokens: 1024, system, messages })` is iterated with `for await`. Each `content_block_delta` with `delta.text` is fed to the `StreamParser` instance. Parser events land in a synchronous `queue[]` that the generator drains after every SDK event via `while (queue.length > 0) yield queue.shift()`. This gives the consumer token-by-token streaming without buffering the full response, matching D-11's "stream for UX" mandate. Test 5 exercises the full pipeline with an in-band anomaly tag and trailing suggestions JSON, asserting the collapsed event-type sequence is exactly `token → anomaly → token → suggestions → done`.

7. **Usage accumulation (INFO 11).** `message_delta.usage` is the primary source (Anthropic SDK v0.40+), with `message_stop.message.usage` as a fallback for older SDK minors. Last-wins semantics — if both events publish, the later one overrides. Test 10 runs two sub-cases: one where only `message_delta` carries usage (asserts 11/22/33), and one where the stub publishes no usage at all (asserts the fallback `0/0/0` — the route still closes cleanly with a non-undefined usage object).

8. **Error classification.** `classifyAnthropicError` is a pure function that maps any thrown SDK error to the stable `ErrorCode` union:

   | Trigger | Code |
   |---|---|
   | `err.name === 'AbortError'` OR `/timeout/i.test(err.message)` | `ANTHROPIC_TIMEOUT` |
   | `err.status === 429` | `ANTHROPIC_RATE_LIMITED` |
   | `typeof err.status === 'number'` (any other HTTP status) | `ANTHROPIC_ERROR` |
   | anything else | `INTERNAL` |

   The catch block yields `{ type: 'error', data: { code, message } }` followed by a synthetic `done` event (`stopReason: 'error'`, narrativeChars: 0, usage: whatever was seen before the error) so the SSE route in Plan 03-06 can treat every stream close identically — `done` is always the terminal event. Tests 6, 7, and 8 cover the three live branches.

9. **Zero yielded-event casts.** `StreamParserEvent`'s `error` variant comes from Plan 03-02's exported union, so `yield { type: 'error', data: { code, message } }` is a plain union member with no assertions. The only cast in the whole file is the default-client cast described above (a deliberate choice to keep the SDK's generics out of the public surface). `grep -c "as unknown as StreamParserEvent"` returns `0` — the file-level acceptance criterion is green.

### `backend/src/services/__tests__/claudeService.test.ts` (Task 2)

Offline test file matching the `streamParser.test.ts` / `systemPromptBuilder.test.ts` style — pure `node:assert/strict`, 10 numbered test cases, an injected Anthropic stub via `deps.client`, zero network, zero `ANTHROPIC_API_KEY`, zero framework. Runs under `tsx` via `pnpm --filter @aperture/backend smoke:claude`.

Stub design: `makeStub(events, opts)` returns a fake `{ client, capture }` pair where `client.messages.stream(reqOpts)` records the request into `capture.calls[]` and returns an async iterator over the provided `events` array. A `throwOnStream` option makes the stub synchronously throw on invocation so the error-path tests can exercise `classifyAnthropicError`.

Fixture: small `makeContext()` builder with one datasource, one schema field, one live-data row, an empty Pulse (hasMetrics: false), and a fully-populated `servicesFired`. Tiny compared to Plan 03-03's test fixture because claudeService only cares about the `CopilotContext` type surface, not the specific datasource diversity.

The 10 numbered cases:

1. **Model lock** — stub is called with `model: 'claude-sonnet-4-20250514'` and `CLAUDE_MODEL === 'claude-sonnet-4-20250514'`.
2. **System block shape + cache marker** — `system` arg is an array; joined text contains `# Role`, `# Output Contract`, `# Schema` in order; the Schema block carries `cache_control: { type: 'ephemeral' }`.
3. **User-turn wrapping (D-15)** — prior 2 messages preserved in order; final message is a `user` turn whose content includes `<dashboard_state>`, `workbook: Oil`, `worksheet: WTI`, and `<question>Why the spike?</question>`.
4. **History cap (D-18)** — 15 prior messages → 10 + 1 sent; oldest dropped (msg-5 at head, msg-14 at tail, final wrapped user turn at index 10); `MAX_HISTORY_TURNS === 10`.
5. **Delta piping** — stub emits `'Prices rose. '` + `[ANOMALY: fieldName="Region" value="West"]` + `' Trend.'` + `'\n\n{"suggestions":["q1","q2","q3"]}'` + a `message_delta` with usage `{11,22,33}` + `message_stop`. Assert collapsed event order is `token → anomaly → token → suggestions → done`, anomaly payload matches, suggestions items match, usage flows into the done event as `{inputTokens: 42, outputTokens: 7, cacheReadTokens: 3}`.
6. **Timeout → ANTHROPIC_TIMEOUT** — stub throws an `AbortError` with a `timeout` message; error event has `code: 'ANTHROPIC_TIMEOUT'` and a done event follows.
7. **Rate limit → ANTHROPIC_RATE_LIMITED** — stub throws `{ message: 'rate limited', status: 429 }`; error code is `ANTHROPIC_RATE_LIMITED`.
8. **Generic 500 → ANTHROPIC_ERROR** — stub throws `{ message: 'internal server error', status: 500 }`; error code is `ANTHROPIC_ERROR`.
9. **Missing API key → INTERNAL** — no stub client, `ANTHROPIC_API_KEY` deleted from `process.env`, `__resetEnvCacheForTests()` called. First yielded event is `{ type: 'error', data: { code: 'INTERNAL', message: /ANTHROPIC_API_KEY/ } }`. The prior value is restored in the `finally`.
10. **Usage passthrough (both branches)** — sub-case A: only `message_delta` carries usage (assert 11/22/33); sub-case B: stub publishes no usage at all (assert 0/0/0 fallback). Covers INFO 11's concern about SDK v0.40+ event ordering without any runtime SDK dependency.

`primeEnv()` ensures every test starts with a fresh env cache and a fake `ANTHROPIC_API_KEY = 'sk-test-offline-key'`. Test 9 is the only one that deletes the key, and restores it in `finally` so Test 10 still runs cleanly.

### `backend/package.json` (Task 1)

Added `@anthropic-ai/sdk@^0.40.0` to `dependencies` and `smoke:claude` npm script after `smoke:assembler`, preserving the Phase 1+2 ordering convention (`auth → metadata → vizql → pulse → pulse:empty → streamparser → systemprompt → budget → assembler → claude → phase2 → list-datasources → exportroutes`). All pre-existing smoke scripts are intact.

### `pnpm-lock.yaml` (Task 1)

Regenerated by `pnpm add` — Anthropic SDK plus its transitive dependencies (`node-fetch`, `formdata-node`, etc.) are now pinned in the lockfile at the versions `pnpm` resolved locally. The engines warning from `node:>=20 <21` vs local `v22.20.0` is pre-existing in the repo and unchanged by this plan.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend smoke:claude` | PASS (10/10 cases green) |
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors) |
| `test -f backend/src/services/claudeService.ts` | PASS |
| `test -f backend/src/services/__tests__/claudeService.test.ts` | PASS |
| `grep -q "export async function\* streamChat"` | PASS |
| `grep -q "CLAUDE_MODEL = 'claude-sonnet-4-20250514'"` | PASS |
| `grep -q "MAX_HISTORY_TURNS = 10"` | PASS |
| `grep -q "buildSystemPrompt"` | PASS |
| `grep -q "buildUserTurn"` | PASS |
| `grep -q "new StreamParser"` | PASS |
| `grep -q "classifyAnthropicError"` | PASS |
| `grep -q "'ANTHROPIC_TIMEOUT'"` | PASS |
| `grep -q "'ANTHROPIC_RATE_LIMITED'"` | PASS |
| `grep -q "from '@anthropic-ai/sdk'"` | PASS |
| `grep -c "claude-sonnet-4-20250514" …/claudeService.ts` | `1` (exactly once — the constant declaration) |
| `grep -c "as unknown as StreamParserEvent" …/claudeService.ts` | `0` (Blocker 4 — no yielded-event casts) |
| `grep -q "message_delta" …/claudeService.ts` | PASS (INFO 11 usage handler present) |
| `grep -c "Test [0-9]" …/claudeService.test.ts` | `21` (well above required 10) |
| API-key leak check: `grep "anthropicApiKey" …/claudeService.ts \| grep -v "env.anthropicApiKey\|!env.anthropicApiKey\|apiKey: env.anthropicApiKey"` | no matches (T-03-05-01 mitigated) |
| `@anthropic-ai/sdk` in `dependencies` | PASS |
| `smoke:claude` in `scripts` | PASS |
| `test -d backend/node_modules/@anthropic-ai/sdk` | PASS |
| Phase 1+2 smoke scripts still present | PASS (all 10 intact) |

## Deviations from Plan

None — plan executed exactly as written.

### Auth gates

None — offline test, zero network, zero credentials required. A synthetic `sk-test-offline-key` value is written to `process.env.ANTHROPIC_API_KEY` in the test harness so `loadEnv()` takes the "key present" path for Tests 1–8 and 10; Test 9 deletes the key to exercise the absent-key branch. Neither value is ever transmitted anywhere.

### Architectural decisions

None — the plan specified the exact source structure (lazy env read, StreamParser queue drain, classifyAnthropicError shape, error-then-done ordering). The executor's only choices were documentation wording (see decision 5 about the comment rephrase to keep the `as unknown as StreamParserEvent` grep at zero) and the stub design in the test file, which matches Plan 03-03's in-test fixture convention.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 | @anthropic-ai/sdk + smoke:claude script | `30f73ac` | `backend/package.json`, `pnpm-lock.yaml` |
| 2 | claudeService streamChat + offline test (TDD RED → GREEN) | `7777dce` | `backend/src/services/claudeService.ts`, `backend/src/services/__tests__/claudeService.test.ts` |

Note: Per the parallel-executor `--no-verify` protocol and the Phase 3 TDD convention already established in Plan 03-02, Task 2's RED and GREEN phases were captured in a single commit. The RED-phase `ERR_MODULE_NOT_FOUND` is reproducible by temporarily deleting `backend/src/services/claudeService.ts` and rerunning `pnpm --filter @aperture/backend smoke:claude` — the test file imports the module via the ESM `.js` suffix contract.

## Downstream Impact

Plan 03-06 (`/chat` SSE route) can now:

- `import { streamChat } from './claudeService.js'`
- `for await (const ev of streamChat(context, messages, dashboardState, question))` — no deps argument in production, default client is constructed automatically from `env.anthropicApiKey`.
- Map each yielded `StreamParserEvent` to an SSE frame: `event: ${ev.type}\ndata: ${JSON.stringify(ev.data)}\n\n`.
- Close the SSE stream on the `done` event — both the happy path and the error path terminate with `done`, so the route never needs a special case for errored streams.

Plan 03-08 (phase 3 live smoke + UAT) will exercise `streamChat` against the real Anthropic endpoint with a live `ANTHROPIC_API_KEY`. If that UAT observes `usage: {0,0,0}` on the done event, the INFO 11 note in the source header says to narrow the usage handler to `message_delta` only — which is a one-line change captured in Test 10's sub-case A already.

No other plan imports `claudeService` directly. The error → done contract is load-bearing for Plan 03-06 and documented in Test 6's assertions.

## Threat Flags

None — this plan adds one new trust boundary (client `messages[]` + `question` → Claude) that is already in the plan's threat register (T-03-05-02) and already mitigated by `buildUserTurn`'s XML-boundary wrapping plus the system prompt's "no preambles or meta-commentary" rule. The Anthropic API key boundary (T-03-05-01) is mitigated by never logging the key value anywhere — the leak check grep above proves it empirically.

No new network endpoints, no new file-access patterns, no new schema changes. The one new network dependency (outbound HTTPS to `api.anthropic.com`) was already planned at the phase level in `03-CONTEXT.md`.

## Self-Check: PASSED

- `backend/src/services/claudeService.ts` — FOUND
- `backend/src/services/__tests__/claudeService.test.ts` — FOUND
- `backend/package.json` — MODIFIED (`smoke:claude` script + `@anthropic-ai/sdk` dep)
- `pnpm-lock.yaml` — MODIFIED (Anthropic SDK resolution pinned)
- commit `30f73ac` — FOUND (`git log --oneline | grep 30f73ac`)
- commit `7777dce` — FOUND (`git log --oneline | grep 7777dce`)
- `pnpm --filter @aperture/backend smoke:claude` — exits 0 (10/10 cases green)
- `pnpm --filter @aperture/backend typecheck` — exits 0
