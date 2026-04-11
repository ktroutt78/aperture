# Phase 3: Context Assembler + Claude - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-11
**Phase:** 03-context-assembler-claude
**Areas discussed:** Fan-out + degradation policy, /chat SSE wire contract, System prompt + history + caching, Export endpoints

---

## Area selection

**Question:** Phase 3 has a lot of architectural decisions. Which of these gray areas do you want to talk through before I write CONTEXT.md?

| Option | Description | Selected |
|--------|-------------|----------|
| Fan-out + degradation policy | How Promise.all/allSettled fails, load-bearing vs. enrichment, partial-failure CopilotContext shape, per-service timeouts, client visibility. | ✓ |
| /chat SSE wire contract | Exact SSE event shape the extension parses in Phase 4. Load-bearing for Phase 4. | ✓ |
| System prompt + history + caching | Prompt structure, conversation history model, Anthropic prompt caching on the schema block. | ✓ |
| Export endpoints scope | Slack payload shape, PDF endpoint choice, client-vs-backend responsibility split, rate limiting. | ✓ |

**User's choice:** All four areas. Mechanics like regex details, file layout, and JSON Schema vs. Zod are treated as Claude's Discretion per the original framing.

---

## Area 1 — Fan-out + degradation policy

### Q1.1: If the Metadata API (schema) fails for a datasource LUID during /context assembly, what should happen?

| Option | Description | Selected |
|--------|-------------|----------|
| Hard fail the whole /context | 502 with structured error. Schema is load-bearing for CTX-05. | |
| Return partial CopilotContext with schema=null | Let Claude try without captions. Risk: CTX-05 violation. | |
| Per-datasource granularity | Drop failed datasources, proceed with the rest, hard-fail only if ALL schema fetches fail. | ✓ |

**User's choice:** Per-datasource granularity.
**Notes:** Five independent datasources in the demo — losing one shouldn't kill the request.

### Q1.2: If VDS or Pulse fails during /context assembly, what should happen?

| Option | Description | Selected |
|--------|-------------|----------|
| Degrade silently, note in context | `servicesFired` field with per-service status; /context still returns 200. | ✓ (recommended) |
| Degrade silently, no client-visible signal | Simpler, loses observability. | |
| Return 207 Multi-Status | More RESTful but forces clients to handle a new status code. | |

**User's choice:** Degrade silently, note in context.

### Q1.3: What orchestration primitive should the Context Assembler use for the fan-out?

| Option | Description | Selected |
|--------|-------------|----------|
| Promise.allSettled with per-service timeout | Never rejects on partial failure; clean per-service ok/error handling. | ✓ (recommended) |
| Promise.all (spec wording) | Rejects on first failure; more boilerplate inside try/catch. | |
| Custom orchestrator class | Overkill for single-shot request. | |

**User's choice:** Promise.allSettled with per-service AbortController timeout (2s each).

### Q1.4: What total time budget should the Context Assembler enforce?

| Option | Description | Selected |
|--------|-------------|----------|
| 2.5s total, 2s per service | Leaves 500ms for post-processing to hit the 3s CLAUDE.md target. | ✓ (recommended) |
| 3s total, 2.5s per service | Uses full 3s budget — risks downstream overhead blowing the target. | |
| No enforced timeout | Lets Tableau decide — risks indefinite blocking. | |

**User's choice:** 2.5s total, 2s per service.

### Q1.5 (follow-up): If ALL datasource schema fetches fail, what does /context return?

| Option | Description | Selected |
|--------|-------------|----------|
| HTTP 502 with structured error | `{ error: 'SCHEMA_UNAVAILABLE', failedLuids, cause }`. | ✓ (recommended) |
| HTTP 200 with empty CopilotContext | Lets Claude try with empty schema — risks CTX-05 regression. | |
| HTTP 503 Service Unavailable | Semantic match but triggers automatic LB retry behavior. | |

**User's choice:** 502 with structured error.

### Q1.6 (follow-up): Shape of the per-service status signal on CopilotContext?

| Option | Description | Selected |
|--------|-------------|----------|
| Discriminated union per service | Full typed status objects with counts/reasons. ContextBadge consumes directly. | ✓ (recommended) |
| Flat string enum per service | Simpler but ContextBadge needs separate fields for counts. | |
| Full per-service error objects only on failure | More complex type, cleaner error surfacing. | |

**User's choice:** Discriminated union per service.

### Q1.7 (follow-up): Where does servicesFired ride on the /chat SSE stream?

| Option | Description | Selected |
|--------|-------------|----------|
| First SSE event = 'context' with full servicesFired | ContextBadge rendered immediately, before tokens stream. | ✓ (recommended) |
| Include in 'done' event at end of stream | Badge arrives late. Rejected for UX. | |
| HTTP header on the SSE response | Works but less structured. | |

**User's choice:** First SSE event = 'context'.

---

## Area 2 — /chat SSE wire contract

### Q2.1: What event framing should the /chat SSE stream use?

| Option | Description | Selected |
|--------|-------------|----------|
| Native SSE `event:` discriminator | EventSource.addEventListener per type. Idiomatic, strongly typed. | ✓ (recommended) |
| Single 'message' event with type field in data | Simpler server, client writes its own dispatch table. | |
| JSON Lines inside one continuous data frame | Misuses SSE — loses reconnect and event dispatch. | |

**User's choice:** Native SSE event: discriminator.

### Q2.2: Ordering guarantee between token events and anomaly events?

| Option | Description | Selected |
|--------|-------------|----------|
| Strip tags from token stream, emit anomaly events at tag-close | Parser buffers inside tags; raw tag never hits clients; typed anomaly event the instant the closing ] arrives. | ✓ (recommended) |
| Emit both: raw tag as token, then anomaly event | Phase 4 has to filter client-side. More work. | |
| Emit anomaly events only at end-of-stream | Loses 'lights up as it's mentioned' UX. | |

**User's choice:** Strip tags from token stream, emit anomaly events at tag-close.

### Q2.3: How should the stream handle the trailing suggestions JSON?

| Option | Description | Selected |
|--------|-------------|----------|
| Strip from token stream, emit suggestions event before done | Raw JSON never appears in rendered markdown. | ✓ (recommended) |
| Emit on done event only | Couples two concepts. | |
| Pass through as tokens + client parses | Error-prone client-side regex. | |

**User's choice:** Strip from token stream, emit suggestions event before done.

### Q2.4: What should done event payload contain, and what does error look like?

| Option | Description | Selected |
|--------|-------------|----------|
| done: { stopReason, usage, narrativeChars }; error: { code, message } | Full observability, stable error code enum. | ✓ (recommended) |
| done: {} (empty marker); error: plain string | Minimal, no observability. | |
| done includes full narrative text | Redundant with concatenated token events. | |

**User's choice:** done: { stopReason, usage, narrativeChars }; error: { code, message }.

### Q2.5 (follow-up): Should the /chat stream send heartbeat pings?

| Option | Description | Selected |
|--------|-------------|----------|
| Yes, SSE comment ping every 15s | Keeps proxies from closing idle connection during slow Claude turns. | ✓ (recommended) |
| No heartbeats | Risks proxy closing connection before first token. | |

**User's choice:** Yes, SSE comment ping every 15s.

### Q2.6 (follow-up): How does the Claude Service wrap the Anthropic SDK?

| Option | Description | Selected |
|--------|-------------|----------|
| anthropic.messages.stream() + custom transform | Use the SDK's streaming helper, pipe through stateful StreamParser. | ✓ (recommended) |
| Raw SSE from anthropic.messages.create({ stream: true }) | More control but reinvents SDK functionality. | |
| Third-party streaming helper | Adds dependency with no Phase 3 benefit. | |

**User's choice:** anthropic.messages.stream() + custom transform.

### Q2.7 (follow-up): Conversation history — where does it live?

| Option | Description | Selected |
|--------|-------------|----------|
| Client passes messages: [{role, content}] on every POST | Stateless backend. Matches Anthropic Messages API 1:1. | ✓ (recommended) |
| Backend holds session map keyed by client session ID | Introduces state, memory pressure, session expiry concerns. | |
| No history — each /chat is fresh single-turn | Violates CTX-10. | |

**User's choice:** Client passes messages on every POST (stateless backend).

---

## Area 3 — System prompt + history + caching

### Q3.1: System Prompt Builder structure?

| Option | Description | Selected |
|--------|-------------|----------|
| Role → Output contract → Schema → Pulse → Live data → Dashboard state | Dense-to-sparse, cache breakpoint at schema end. | ✓ (recommended) |
| Role → Context blob → Output contract | Contract-last for adherence. Kills cacheability. | |
| Role + contract in system; everything else as user turn preamble | Tiny stable system. Trades cacheability for separation. | |

**User's choice:** Role → Output contract → Schema → Pulse → Live data → Dashboard state.
**Notes:** See D-15 — dashboard_state actually ships in the user turn, not the system prompt. The recommended ordering applies to the system-prompt-only sections.

### Q3.2: Anthropic prompt caching?

| Option | Description | Selected |
|--------|-------------|----------|
| Cache system prompt + Schema block, not Pulse/VDS | cache_control breakpoint at end of schema block. | ✓ (recommended) |
| No caching — ship it simpler | Fine for demo but leaves money on the table. | |
| Cache everything up through Live Data rows | Live data changes per turn, cache hits rare. | |

**User's choice:** Cache system prompt + Schema block.

### Q3.3: Dashboard state injection — system prompt or user turn?

| Option | Description | Selected |
|--------|-------------|----------|
| User-turn preamble under <dashboard_state> XML tag | Keeps system prompt cacheable. Claude treats XML as semantic boundaries. | ✓ (recommended) |
| System prompt section, regenerated per request | Defeats system-prompt caching. | |
| Two-message exchange: assistant ack then user question | Artificial turn structure. | |

**User's choice:** User-turn preamble under `<dashboard_state>` tag.

### Q3.4: Token budget measurement?

| Option | Description | Selected |
|--------|-------------|----------|
| Rough char-based estimate (chars/4) with conservative margin | Fast, deterministic, zero dependency. Target 70k chars. | ✓ (recommended) |
| Anthropic Token Counting API (messages.countTokens) | Accurate but adds network round-trip per request. | |
| tiktoken (OpenAI tokenizer) | Wrong tokenizer. | |

**User's choice:** Rough char-based estimate with 12.5% safety margin.

### Q3.5 (follow-up): Truncation algorithm?

| Option | Description | Selected |
|--------|-------------|----------|
| Drop live-data rows proportionally per datasource, then pulse bundles FIFO, then schema fields evenly | Halve-and-check, floor of 1 field per datasource, log every step. | ✓ (recommended) |
| Drop entire sections atomically | Simpler but loses gradient. | |
| Weighted density scoring | Overkill for v1. | |

**User's choice:** Proportional drop with priority schema > pulse > data rows (already locked).

### Q3.6 (follow-up): History cap strategy?

| Option | Description | Selected |
|--------|-------------|----------|
| Cap at 10 turns (5 user + 5 assistant), drop oldest first | Simple sliding window. | ✓ (recommended) |
| Cap at 20 turns | Bigger window, still bounded. | |
| No cap — let Anthropic reject | Raw API error to user. | |

**User's choice:** Cap at 10 turns.

### Q3.7 (follow-up): Behavior when history gets trimmed?

| Option | Description | Selected |
|--------|-------------|----------|
| Backend silently drops oldest turns | Simpler; client doesn't need retry logic. | ✓ (recommended) |
| Backend rejects with 400 + client re-trims and retries | Explicit but adds retry dance. | |

**User's choice:** Silent trim.

---

## Area 4 — Export endpoints

### Q4.1: /export/slack request body + what backend posts to webhook?

| Option | Description | Selected |
|--------|-------------|----------|
| Client sends { narrative, anomalies, workbookName, worksheetName }; backend formats as Slack Block Kit | Backend owns Slack schema. | ✓ (recommended) |
| Client sends { text }; backend posts as plain text | Loses anomaly highlighting. | |
| Client sends full Block Kit payload | Frontend knows too much about Slack. | |

**User's choice:** Client sends structured fields; backend formats as Block Kit.

### Q4.2: /export/pdf target endpoint?

| Option | Description | Selected |
|--------|-------------|----------|
| workbooks/{workbookLuid}/pdf via tableauFetch, streamed straight to client | Streaming; mitigates DoS-by-huge-PDF. | ✓ (recommended) |
| views/{viewLuid}/pdf per worksheet | Deferred to v2. | |
| Backend buffers PDF in memory | Breaks on large exports. | |

**User's choice:** workbooks/{luid}/pdf streamed.

### Q4.3: Rate limiting scope?

| Option | Description | Selected |
|--------|-------------|----------|
| @fastify/rate-limit plugin: 60/min on /chat, 10/min on /export/* | In-memory; kills webhook spam and Anthropic-bill amplification. | ✓ (recommended) |
| No rate limits in Phase 3 | Leaves /chat open as an Anthropic bill amplifier. | |
| Rate limit /chat + /export/slack only | Middle ground — Tableau REST has its own limits. | |

**User's choice:** @fastify/rate-limit with 60/min chat, 10/min exports.

### Q4.4: Slack webhook URL source?

| Option | Description | Selected |
|--------|-------------|----------|
| Only env.SLACK_WEBHOOK_URL — never client-supplied | Eliminates SSRF by construction. | ✓ (recommended) |
| Client supplies URL, backend validates domain | Opens SSRF surface. | |
| Client supplies workspace ID, backend looks up | Out of scope for v1. | |

**User's choice:** Only from env — never client-supplied.

---

## Claude's Discretion

Areas the user left to Claude/planner judgment:

- File layout under `backend/src/services/` and `backend/src/routes/`
- Request body validation library (Fastify JSON Schema vs. Zod vs. hand-rolled)
- Anomaly / suggestions parser regex mechanics (char-by-char state machine vs. chunked regex)
- Per-datasource PulseContext ordering and insight selection algorithm
- `CopilotContext` internal field naming (as long as D-05 `servicesFired` shape is honored verbatim)
- Test strategy (offline units + live smoke against EIA Prices)
- Literal prompt wording for Role and Output Contract blocks

## Deferred Ideas

- Per-view (`views/{luid}/pdf`) export — v2
- Backend-held conversation state keyed by session ID — v2 (V2-03 placeholder)
- Multi-tenant / workspace-scoped Slack webhooks — v2
- Redis-backed rate limit store — future multi-instance deployment
- Routine `messages.countTokens` safety net — D-16 allows guarded use only
- Structured cross-source correlation scoring pass — v2

---

*Discussion completed: 2026-04-11*
