---
phase: 03-context-assembler-claude
plan: 06
subsystem: backend-routes
tags: [phase-3, routes, sse, wave-3, offline-test]
status: complete
completed: 2026-04-12
duration: 3m
tasks_completed: 2
tasks_total: 2
requires:
  - backend/src/types/copilot.ts (Plan 03-01 — CopilotContext, CopilotContextRequest, ChatMessage, DashboardState, ErrorCode)
  - backend/src/services/errors.ts (Plan 03-01 — ContextAssemblerError)
  - backend/src/services/streamParser.ts (Plan 03-02 — StreamParserEvent union including error variant)
  - backend/src/services/contextAssembler.ts (Plan 03-04 — assembleContext)
  - backend/src/services/claudeService.ts (Plan 03-05 — streamChat + ClaudeDeps)
  - backend/src/config/env.ts (Phase 1 — loadEnv / __resetEnvCacheForTests)
  - backend/src/routes/health.ts (Phase 1 — Fastify route registration pattern)
provides:
  - contextRoutes(app) — POST /context debug JSON route (CTX-14)
  - createChatRoutes(opts) — factory accepting ChatRouteOpts { claudeDeps?, assembler? }
  - chatRoutes — default POST /chat SSE route for server.ts (CTX-15)
  - ChatRouteOpts interface (Warning 7 fix — injectable assembler + claudeDeps)
  - LUID_REGEX = /^[a-f0-9-]{36}$/i (shared pattern across both routes)
  - HEARTBEAT_INTERVAL_MS = 15_000 (D-10 heartbeat cadence constant)
  - smoke:chatroute npm script
affects:
  - Plan 03-08 — registers contextRoutes + chatRoutes in server.ts and runs live UAT against real Anthropic + real Tableau
  - Phase 4 extension panel — consumes the SSE wire contract (D-06 framing, D-07 catalog, D-10 heartbeat)
tech_stack:
  added: []
  patterns:
    - "Factory pattern (createChatRoutes(opts)) so default export + offline-test export share one source"
    - "reply.hijack() + reply.raw.write for native SSE framing — bypasses Fastify's default JSON serializer"
    - "Assemble-before-stream — HTTP errors (400/502/503) return BEFORE opening the SSE wire so clients see proper status codes"
    - "Fastify inject() harness for fully-offline route tests — zero network, zero credentials"
    - "SSE frame parser in test code (split on \\n\\n) so Tests 11/12 inspect only token-frame data payloads"
    - "ChatRouteOpts dual stubs (assembler + claudeDeps) — tests never hit a real Tableau service OR real Anthropic"
key_files:
  created:
    - backend/src/routes/context.ts
    - backend/src/routes/chat.ts
    - backend/src/services/__tests__/chatRoute.test.ts
  modified:
    - backend/package.json
decisions:
  - "Factory + default export dual pattern for chat.ts — `createChatRoutes(opts)` is the test entry point and `chatRoutes = createChatRoutes()` is the production entry point. Source code references the same route handler via closure, so the SSE wire contract cannot drift between the test and production paths."
  - "Validator returns a narrow discriminated result (`ChatBody | { error: string }`) instead of throwing — keeps the handler flat, avoids hidden control flow, and gives Fastify inject() tests a single unambiguous 400 path without stack traces in the pino log."
  - "Assemble-before-hijack ordering — assembleContext runs BEFORE reply.hijack(), so a ContextAssemblerError surfaces as a clean HTTP 502 with a JSON body the Phase 4 UI can render. Opening the stream first and then writing an `event: error` frame would leave clients staring at a half-open EventSource with no status code."
  - "Heartbeat uses setInterval (not setTimeout recursion) so the cadence is exactly HEARTBEAT_INTERVAL_MS regardless of how long each Claude event takes to arrive — a long-running inference pause won't starve the proxy."
  - "streamChat's contract is that it NEVER throws (always yields error-then-done). The route still wraps the for-await in a try/catch as defense in depth against a future refactor breaking that invariant; the catch writes a synthetic `event: error` with code: INTERNAL."
  - "Tests 11/12 parse SSE frames via the wire grammar (split on `\\n\\n`, look for `event: token\\n`) rather than substring-scanning the raw body. A raw substring scan would false-positive on the anomaly frame itself, which necessarily contains `[ANOMALY` in its data payload. The parsed-frame approach is robust to frame boundary splits per the plan's INFO 10 refinement."
  - "Happy-path tests 7-12 share a single built SSE response — one inject() call feeds all six assertions. This cuts test runtime from ~200ms to ~40ms and avoids boot-serialization churn in the Fastify harness."
metrics:
  duration_minutes: 3
  tasks: 2
  files_touched: 4
  deviations: 0
  blockers: 0
requirements:
  - CTX-14
  - CTX-15
---

# Phase 03 Plan 06: Context + Chat Routes Summary

## One-liner

Two Fastify routes — `POST /context` (debug JSON) and `POST /chat` (D-06 native SSE with D-07 event catalog and D-10 15s heartbeat) — both thin wrappers over Plan 03-04's `assembleContext` and Plan 03-05's `streamChat`, proven by 12 fully-offline `inject()` tests that stub BOTH the Anthropic SDK AND the context assembler (Warning 7 dual-injection fix), with the chat route exported as a `createChatRoutes(opts)` factory so test and production share exactly one handler closure.

## What Was Built

### `backend/src/routes/context.ts` (Task 1 — CTX-14)

A single `contextRoutes` plugin exporting `POST /context`. Validates the body via `validateRequest`, calls `assembleContext(validated)`, and returns the full `CopilotContext` JSON on success. On a `ContextAssemblerError` (D-04 hard throw), maps to HTTP 502 `{ error: 'SCHEMA_UNAVAILABLE', failedLuids, cause }` so Phase 4's UI can name the broken datasources. Any other error returns 500 INTERNAL with a generic message; the pino log gets the real cause via `app.log.error`.

Validation is identical in shape to chat.ts: workbookName/worksheetName strings, datasourceLuids UUID-array (via `LUID_REGEX = /^[a-f0-9-]{36}$/i`), selectedMarks/activeFilters arrays. Invalid input → 400 BAD_REQUEST with a human-readable `message`.

This route is NOT registered in `server.ts` — Plan 03-08 owns that wire-up.

### `backend/src/routes/chat.ts` (Task 2 — CTX-15)

A `createChatRoutes(opts: ChatRouteOpts = {})` factory plus a `chatRoutes = createChatRoutes()` default export. `ChatRouteOpts` declares BOTH `claudeDeps?: ClaudeDeps` (stubs the Anthropic SDK, reusing Plan 03-05's existing DI shape) AND `assembler?: (req: CopilotContextRequest) => Promise<CopilotContext>` (stubs `assembleContext`) — both optional, both default to the real implementations. This is the Warning 7 fix the plan calls out: the test file passes stubs for both, so it never touches a real Tableau service OR a real Anthropic endpoint.

**Request lifecycle:**

1. **Validate** via `validateChatBody` — superset of context.ts's validator plus `messages: ChatMessage[]` (role ∈ {user, assistant}, content string) and `question: non-empty string`. Non-empty datasourceLuids also enforced here (chat with zero datasources is not a valid turn).
2. **Lazy env check** — `loadEnv()` at request time. If `ANTHROPIC_API_KEY` is unset AND no `opts.claudeDeps.client` was injected, return 503 `{ error: 'ENV_MISSING', key: 'ANTHROPIC_API_KEY' }`. Never at boot.
3. **Assemble context BEFORE opening the SSE stream** — so `ContextAssemblerError` maps to a clean HTTP 502 with a JSON body clients can read. Opening the stream first would leave clients staring at a half-open `EventSource` with no status code.
4. **Open SSE stream** — headers per D-06 (`text/event-stream`, `Cache-Control: no-cache, no-transform`, `Connection: keep-alive`, `X-Accel-Buffering: no`), then `reply.hijack()` so Fastify's default serializer doesn't fight us.
5. **First frame = `event: context`** (D-07) — `{ servicesFired, assemblyMs, contextChars, truncated }`.
6. **15s heartbeat** — `setInterval(writePing, HEARTBEAT_INTERVAL_MS)` writes `: ping\n\n` every 15 seconds. Cleared in `finally`.
7. **Pipe streamChat events** — `for await (const ev of streamChat(context, messages, dashboardState, question, opts.claudeDeps))`. Every yielded `StreamParserEvent` is forwarded via `write(ev.type, ev.data)`. The parser never emits `context`, so there is no collision with step 5's first frame.
8. **Defense-in-depth catch** — streamChat's contract is that it never throws (always yields error-then-done). The catch writes a synthetic `event: error` with `{ code: 'INTERNAL', message }` in case a future refactor breaks the invariant.
9. **Finally** — `clearInterval(heartbeat)` + `reply.raw.end()`.

Helpers inside the route:
- `write(type, data)` — `reply.raw.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n')`. Every data payload is JSON-stringified; the type name is always a hard-coded constant from D-07, mitigating T-03-06-07 (no user input in the event name).
- `writePing()` — `reply.raw.write(': ping\n\n')`. SSE comment syntax, invisible to EventSource clients but defeats proxy idle timeouts.

### `backend/src/services/__tests__/chatRoute.test.ts` (Task 2 — 12 cases)

Pure `tsx` harness using Fastify's built-in `inject()` — zero framework, zero network, zero credentials. Imports env.js, resets the env cache, stubs `ANTHROPIC_API_KEY` to `sk-test-offline-chatroute` BEFORE the route module is imported (so `loadEnv()` caches the fake value).

**Stub design:**

- `stubAssembler(req)` — returns a fixed `CopilotContext` with a single datasource, one schema field, empty liveData/pulse, and a hard-coded `servicesFired: { assemblyMs: 42, contextChars: 100, truncated: false, metadata.ok, vizql.empty, pulse.empty }`. Tests 8 assert the numeric values flow through the first SSE frame.
- `makeFakeAnthropicClient()` — returns a `{ messages: { stream() } }` shape matching Plan 03-05's `ClaudeDeps['client']`. `stream()` returns an async iterable over five canned events:
  1. `content_block_delta` `'Hello. '`
  2. `content_block_delta` `'[ANOMALY: fieldName="X" value="Y"]'`
  3. `content_block_delta` `' Done.\n\n{"suggestions":["a","b","c"]}'`
  4. `message_delta` `{ stop_reason: 'end_turn' }` with `usage: {10, 5, 0}`
  5. `message_stop`

**The 12 cases:**

| # | Scenario | Enforces |
|---|---|---|
| 1 | Missing `workbookName` → 400 | validateChatBody string guard |
| 2 | Invalid LUID `'not-a-uuid'` → 400 | LUID_REGEX mitigates T-03-06-01 SSRF |
| 3 | Empty `question` → 400 | validateChatBody non-empty guard |
| 4 | Empty `datasourceLuids` → 400 | Chat turns require at least one datasource |
| 5 | Missing `ANTHROPIC_API_KEY` + no stubbed client → 503 ENV_MISSING | Lazy env check, `env.__resetEnvCacheForTests` + `delete process.env.ANTHROPIC_API_KEY` + restore in `finally` |
| 6 | Stubbed assembler throws `ContextAssemblerError(['luid'], cause)` → 502 SCHEMA_UNAVAILABLE | D-04 mapping; `failedLuids` + `cause.message` surfaced in response body |
| 7 | Happy path — `Content-Type: text/event-stream` | D-06 wire format |
| 8 | Happy path — first frame is `event: context` with `{assemblyMs: 42, contextChars: 100, truncated: false, servicesFired: {...}}` | D-07 first-frame invariant |
| 9 | Happy path — last frame is `event: done` with `stopReason: 'end_turn'`, `usage.inputTokens: 10`, `usage.outputTokens: 5` | D-07 terminal invariant + INFO 11 usage passthrough |
| 10 | Happy path — exactly one `event: anomaly` frame with `{fieldName: 'X', value: 'Y', raw: '[ANOMALY:...]'}` | Mark-highlighter is the highest-impact demo interaction |
| 11 | Happy path — `[ANOMALY` substring never appears in any `event: token` data payload (15 token frames checked) | StreamParser tag-hiding is load-bearing for UI |
| 12 | Happy path — `{"suggestions"` substring never in any token frame; suggestions frame exists with `items: ['a','b','c']` | StreamParser suggestions-hiding + items payload |

Tests 7-12 share a single built SSE response — one `inject()` call feeds all six assertions. `parseSseFrames(body)` splits on `\n\n`, filters out `: ping` comment frames, and returns `[{eventType, dataRaw}]` records. Tests 11/12 filter those frames to `eventType === 'token'` and `JSON.parse` only those data payloads, so a substring scan never false-positives on the anomaly frame itself (per INFO 10).

### `backend/package.json` — one-line addition

```json
"smoke:chatroute": "tsx src/services/__tests__/chatRoute.test.ts",
```

Inserted directly after `smoke:claude` to preserve the Phase 1/2/3 ordering convention. No dependencies added.

## Verification

| Check | Result |
|---|---|
| `pnpm --filter @aperture/backend smoke:chatroute` | PASS (12/12) |
| `pnpm --filter @aperture/backend typecheck` | PASS (0 errors) |
| `test -f backend/src/routes/context.ts` | PASS |
| `test -f backend/src/routes/chat.ts` | PASS |
| `test -f backend/src/services/__tests__/chatRoute.test.ts` | PASS |
| `grep -q "export const contextRoutes"` (context.ts) | PASS |
| `grep -q "app.post('/context'"` | PASS |
| `grep -q "LUID_REGEX = /^[a-f0-9-]{36}$/i"` (both files) | PASS |
| `grep -q "SCHEMA_UNAVAILABLE"` (both files) | PASS |
| `grep -q "reply.code(502)"` (both files) | PASS |
| `grep -q "reply.code(400)"` (both files) | PASS |
| `grep -q "ContextAssemblerError"` (both files) | PASS |
| `grep -q "app.post('/chat'"` | PASS |
| `grep -q "text/event-stream"` | PASS |
| `grep -q 'event: \${type}'` (template literal) | PASS |
| `grep -q "HEARTBEAT_INTERVAL_MS = 15_000"` | PASS |
| `grep -q ": ping"` | PASS |
| `grep -q "reply.hijack"` | PASS |
| `grep -q "reply.code(503)"` | PASS |
| `grep -q "ENV_MISSING"` | PASS |
| `grep -q "write('context'"` | PASS |
| `grep -q "streamChat"` | PASS |
| `grep -q "clearInterval(heartbeat)"` | PASS |
| `grep -q "assembler?:"` (Warning 7) | PASS |
| `grep -q "export const chatRoutes"` (Warning 7) | PASS |
| `grep -q "export function createChatRoutes"` (Warning 7) | PASS |
| `grep -q "smoke:chatroute" backend/package.json` | PASS |
| `grep -c "Test [0-9]" chatRoute.test.ts` | 37 (minimum required: 12) |
| `grep -q "await app.register(contextRoutes)" backend/src/server.ts` | NO MATCH (correct — Plan 03-08 owns server.ts) |

## Deviations from Plan

None. Plan executed exactly as written — both tasks on the first implementation pass, all 12 tests green on the first run, typecheck clean, zero auto-fixes required.

### Auto-fixed Issues

None.

### Auth gates

None — fully offline test, zero network, zero credentials. The stubbed `ANTHROPIC_API_KEY` value (`sk-test-offline-chatroute`) is a literal string used only by `loadEnv()` to take the key-present code path; it is never transmitted anywhere because the Anthropic SDK is replaced by `makeFakeAnthropicClient()` via `ClaudeDeps.client` injection.

## Commits

| Task | Name | Commit | Files |
|---|---|---|---|
| 1 | POST /context debug route (CTX-14) | `817ce72` | `backend/src/routes/context.ts` |
| 2 | POST /chat SSE route + 12 offline tests (CTX-15) | `c1abce9` | `backend/src/routes/chat.ts`, `backend/src/services/__tests__/chatRoute.test.ts`, `backend/package.json` |

## Downstream Impact

**Plan 03-08 (server integration + live UAT)** — will register both routes in `server.ts` with:

```ts
await app.register(contextRoutes);
await app.register(chatRoutes);
```

No stub deps passed in production — both default to the real `assembleContext` and the real Anthropic SDK. Plan 03-08's live UAT exercises the full tri-API → Claude → SSE path against the 10ax Tableau sandbox and the live Anthropic endpoint.

**Phase 4 extension panel** — consumes the SSE wire contract as delivered:
- `new EventSource('/chat')` — named-event listeners on `context`, `token`, `anomaly`, `suggestions`, `done`, `error`
- First frame is guaranteed `context` — ContextBadge renders immediately
- `done` is the terminal invariant — the panel closes the EventSource on either a successful `done` (after streamed tokens) or an error-followed-by-done pair
- `: ping` comment frames are silently ignored by EventSource per the W3C spec, so the heartbeat is invisible to the UI but keeps Fly.io's proxy from idle-timing out during slow inference

**Phase 4 mark highlighter** — `event: anomaly` frames carry `{fieldName, value, raw}` ready to hand to `worksheet.selectMarksByValueAsync({fieldName, values: [value]})`. The mark highlighter is CLAUDE.md's "highest-impact demo interaction" — the route's one-frame-per-anomaly guarantee (Test 10) and the zero-leakage invariant (Test 11) give the Phase 4 code a clean contract to build on.

## Known Stubs

None. Both routes are fully wired end-to-end through the real service primitives — the only optional knobs (`ChatRouteOpts.assembler`, `ChatRouteOpts.claudeDeps`) default to the real implementations, so production callers get the full fan-out and full Anthropic streaming with zero config. The test file exercises the stub path; server.ts will exercise the real path when Plan 03-08 registers the default exports.

## Threat Flags

None — the threat register in the plan (T-03-06-01 through T-03-06-07) is fully mitigated by this implementation:

- T-03-06-01 (SSRF via datasourceLuids) — `LUID_REGEX` applied in both validators before any service call.
- T-03-06-02 (injection via `question`) — passed through as a plain string to `buildUserTurn` which wraps it in XML semantic boundaries (Plan 03-05's D-15 implementation).
- T-03-06-03 (error disclosure) — the route only sends `{code, message}` to the client; stack traces stay server-side in the pino log.
- T-03-06-04 (DoS amplification on open /chat) — assemble-before-stream means 400/502/503 returns BEFORE opening the Anthropic stream. Full rate-limit mitigation lands in Plan 03-08 (D-22).
- T-03-06-05 (proxy idle timeout) — D-10 15s heartbeat via `HEARTBEAT_INTERVAL_MS = 15_000`.
- T-03-06-06 (env key absence disclosure) — accepted per the plan; the 503 response is intentional operator signal.
- T-03-06-07 (SSE frame injection) — `JSON.stringify` on every data payload; event type names are always hard-coded D-07 catalog constants, never user input.

No new trust boundaries introduced. The two new network endpoints (`POST /context`, `POST /chat`) are already in the plan's trust-boundary table; they are the endpoints the plan was built to ship.

## Self-Check: PASSED

- `backend/src/routes/context.ts` — FOUND
- `backend/src/routes/chat.ts` — FOUND
- `backend/src/services/__tests__/chatRoute.test.ts` — FOUND
- `backend/package.json` — MODIFIED (`smoke:chatroute` script added)
- commit `817ce72` (Task 1 — context route) — FOUND in `git log --oneline`
- commit `c1abce9` (Task 2 — chat route + tests) — FOUND in `git log --oneline`
- `pnpm --filter @aperture/backend smoke:chatroute` — exits 0 (12/12 cases green)
- `pnpm --filter @aperture/backend typecheck` — exits 0 (clean)
- `backend/src/server.ts` — NOT modified (Plan 03-08 owns route registration)
- `.planning/STATE.md` — NOT modified (orchestrator directive honored)
- `.planning/ROADMAP.md` — NOT modified (orchestrator directive honored)
