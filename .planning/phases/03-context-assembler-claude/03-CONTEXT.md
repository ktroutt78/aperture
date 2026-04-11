# Phase 3: Context Assembler + Claude - Context

**Gathered:** 2026-04-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Backend phase that fuses Phase 2's three typed Tableau service outputs
(`SchemaContext`, `LiveDataContext`, `PulseContext`) into a single typed
`CopilotContext`, streams a schema-aware `claude-sonnet-4-20250514` response
over SSE with inline anomaly tags and trailing suggestions JSON, and exposes
two export endpoints (Slack webhook + Tableau workbook PDF).

**In scope (requirements covered):**

- **Context Assembler** (CTX-01, CTX-02, CTX-03) — fan-out to all three
  Tableau services in parallel, merge into typed `CopilotContext`, intelligent
  truncation at the ~80k-token ceiling with priority schema > pulse > data rows.
- **System Prompt Builder** (CTX-04, CTX-05, CTX-06, CTX-09) — produces the
  dynamic Claude system prompt from a `CopilotContext` on every request,
  encoding the inviolable output contract (field captions, build on Pulse
  without repeating, ≤ 3 paragraphs).
- **Claude Service** (CTX-07, CTX-08, CTX-10, CTX-11, CTX-12, CTX-13) —
  streaming chat with conversation history via `@anthropic-ai/sdk`, parses
  `[ANOMALY: ...]` tags inline as tokens arrive, parses `{"suggestions":[...]}`
  at end of stream, emits typed events `token | anomaly | suggestions | done`
  (plus `context` / `error` — see D-09).
- **Routes** (CTX-14, CTX-15, CTX-16, CTX-17) — `POST /context`, `POST /chat`
  (SSE), `POST /export/slack`, `POST /export/pdf`.

**Out of scope for this phase (belongs in Phase 4 or 5):**

- Extension UI, dashboard listeners, panel rendering, mark highlighter (Phase 4)
- Backend deployment to a permanent public HTTPS URL (Phase 5)
- Loading skeletons, responsive layout, graceful error UI (Phase 5)

</domain>

<decisions>
## Implementation Decisions

### Fan-out + degradation policy (Area 1)

- **D-01:** The Context Assembler fans out to Metadata / VDS / Pulse using
  `Promise.allSettled` — not bare `Promise.all` — with a per-service
  `AbortController` so one slow service cannot block the critical path. The
  spec wording "Promise.all" is honored by semantics (parallel fan-out), not
  by literal API choice. `Promise.allSettled` gives us clean per-service
  ok/error handling without try/catch gymnastics inside the assembler.

- **D-02:** **Per-service time budget:** each service call gets a hard 2s
  `AbortController` timeout. The assembler itself has a hard 2.5s total budget
  (enforced as a wrapper around the Promise.allSettled await), leaving ~500ms
  headroom for token-counting, truncation, prompt-builder work, and Fastify
  serialization before the 3s CLAUDE.md "context assembles in under 3 seconds"
  target is breached.

- **D-03:** **Schema is load-bearing, VDS and Pulse are enrichment.** The
  failure semantics differ:
  - **Schema failure — per-datasource granularity.** If Phase 3 was asked for
    N datasource LUIDs and at least one resolves successfully via Metadata,
    the assembler proceeds with the LUIDs that succeeded and records the
    failed ones in `servicesFired.metadata` as `{ status: 'partial', ok, failed, failedLuids }`.
    Only if ALL N schema fetches fail does the assembler hard-fail the request.
  - **VDS failure** — silent degradation. `LiveDataContext` is set to empty
    rows per datasource that failed, `servicesFired.vizql` records
    `{ status: 'error', reason }`. Narrative continues with schema + Pulse.
  - **Pulse failure** — silent degradation. Same pattern. Empty `PulseContext`,
    `servicesFired.pulse` records `{ status: 'error', reason }`. Already the
    contract enforced by Phase 2's `pulseService.empty.test.ts` for the
    no-metrics happy path — Phase 3 extends it to the error path.

- **D-04:** **All-schemas-fail path returns HTTP 502** with a structured body:
  ```json
  {
    "error": "SCHEMA_UNAVAILABLE",
    "failedLuids": ["...", "..."],
    "cause": "human-readable cause string"
  }
  ```
  Phase 4 panel will show an error card with a retry button when it sees
  this code. Chose 502 over 503 so load balancers and clients don't enter
  automatic retry loops against a genuinely broken upstream.

- **D-05:** `CopilotContext` carries a `servicesFired` field typed as a
  **discriminated union per service**, not a flat string enum:
  ```ts
  type ServicesFired = {
    metadata:
      | { status: 'ok'; datasources: number }
      | { status: 'partial'; ok: number; failed: number; failedLuids: string[] }
      | { status: 'error'; reason: string };
    vizql:
      | { status: 'ok'; rows: number }
      | { status: 'empty' }
      | { status: 'error'; reason: string };
    pulse:
      | { status: 'ok'; metricCount: number }
      | { status: 'empty' }
      | { status: 'error'; reason: string };
    assemblyMs: number;
    contextChars: number;  // pre-truncation char count
    truncated: boolean;
  };
  ```
  Phase 4's `ContextBadge` consumes this directly — no lossy mapping.

### /chat SSE wire contract (Area 2)

- **D-06:** **Native SSE `event:` discriminator framing.** Each event is a
  standard SSE frame: `event: <type>\ndata: <json>\n\n`. Phase 4 uses
  `EventSource.addEventListener('<type>', handler)` per type. No bespoke
  dispatch table on the client, fully idiomatic SSE, browser auto-reconnect
  supported.

- **D-07:** **Event type catalog (load-bearing for Phase 4 — do not regress):**

  | Event         | When                            | Data payload                                                                |
  |---------------|---------------------------------|-----------------------------------------------------------------------------|
  | `context`     | First event, before any tokens  | `{ servicesFired, assemblyMs, contextChars, truncated }`                    |
  | `token`       | For each text delta from Claude | `{ text: string }` — **raw `[ANOMALY: ...]` tags are NEVER emitted here**   |
  | `anomaly`     | When a full tag is parsed       | `{ fieldName: string, value: string, raw: string }`                         |
  | `suggestions` | After narrative, before `done`  | `{ items: string[] }` — parsed from trailing `{"suggestions":[...]}`        |
  | `done`        | Stream complete                 | `{ stopReason, usage: { inputTokens, outputTokens, cacheReadTokens }, narrativeChars }` |
  | `error`       | Any unrecoverable failure       | `{ code: ErrorCode, message: string }`                                      |
  | `: ping`      | Heartbeat every 15s             | SSE comment line, ignored by EventSource                                    |

  `ErrorCode` enum (stable across Phase 3 and consumed by Phase 4):
  `ANTHROPIC_TIMEOUT | ANTHROPIC_RATE_LIMITED | ANTHROPIC_ERROR | CONTEXT_ASSEMBLY_FAILED | INTERNAL`.

- **D-08:** **Anomaly parsing strips tags from the token stream.** The stream
  parser buffers characters while inside a `[ANOMALY: fieldName="..." value="..."]`
  tag. The raw tag text is NEVER emitted as `token` events — only a typed
  `anomaly` event the instant the closing `]` is seen. Phase 4 renders the
  token stream straight into markdown with zero filtering. If a chunk boundary
  lands in the middle of a tag, the parser holds the partial buffer until the
  tag completes or the stream ends (malformed tag = drop the buffer, log warn).

- **D-09:** **Suggestions parsing strips the trailing JSON from the token
  stream.** After Claude finishes the narrative, the parser detects the
  opening `{"suggestions":` (with optional whitespace tolerance), buffers to
  the matching closing brace, parses the JSON, and emits `suggestions` then
  `done`. The raw JSON never appears in the rendered markdown. If Claude
  omits or malforms the suggestions block, emit `suggestions` with
  `{ items: [] }` and log warn — never throw.

- **D-10:** **Heartbeat.** The SSE response writes `: ping\n\n` every 15s to
  keep Fly.io / intermediary proxies from closing the idle connection during
  slow Claude turns (context assembly can eat 2.5s before the first token
  arrives). Comment lines are dropped by `EventSource` so Phase 4 doesn't
  need to handle them.

- **D-11:** **Anthropic SDK wrapper.** Use `anthropic.messages.stream({...})`
  — the SDK's built-in streaming helper that emits typed events. Pipe the
  text delta through a stateful `StreamParser` class that owns the tag /
  suggestions state machine and emits our typed events (`token | anomaly |
  suggestions | done | error`) to the Fastify route handler. No raw
  `ServerSentEvent` handling.

- **D-12:** **Conversation history is client-held, stateless backend.** The
  `/chat` POST body includes `messages: Array<{ role: 'user' | 'assistant', content: string }>`
  which the client replays on every turn. The extension panel in Phase 4 is
  responsible for storing the thread, stripping anomaly tags and the
  suggestions block from assistant content before replaying. Matches
  Anthropic's Messages API 1:1. No backend session map, no DB, no memory
  leaks.

### System prompt + history + caching (Area 3)

- **D-13:** **System prompt section order** (load-bearing for Claude's
  adherence to the output contract and for prompt cache breakpoints):
  1. **Role** — "You are Aperture, an analytics co-pilot embedded inside a
     Tableau dashboard..."
  2. **Output contract** — the inviolable rules: cite real field captions,
     build on Pulse without repeating, ≤ 3 paragraphs, tag anomalies as
     `[ANOMALY: fieldName="x" value="y"]`, end with `{"suggestions":[...]}`.
  3. **Schema block** — `SchemaContext` rendered as a compact Markdown table
     per datasource: `| caption | dataType | description |` plus lineage on
     a second line when present. **This is the cache breakpoint.**
  4. **Pulse block** — `PulseContext` per datasource: metric definitions,
     top-3 insight bundles (weighted by `InsightFeedbackMetadata`), empty
     sections marked `(no metrics configured)` so the model knows it's
     intentional, not missing.
  5. **Live data block** — sampled rows from `LiveDataContext`, formatted as
     compact JSON per datasource (after truncation).
  6. **(Dashboard state does NOT live in the system prompt — see D-15.)**

- **D-14:** **Anthropic prompt caching.** Mark a single `cache_control`
  breakpoint at the end of the Schema block (`type: 'ephemeral'`). The cached
  prefix (Role + Contract + Schema) is reused across turns in a conversation
  — schema is stable for the duration of a dashboard session. Pulse and Live
  data change per turn and ride as the uncached suffix. The Role + Contract
  are themselves stable across all requests, but the Schema block changes
  per datasource set, so the cache is keyed by the assembled prefix as-is
  (no manual keying needed). Expect ~5-20k cached tokens depending on
  datasource fan-out. Below the 1024-token cache minimum the SDK simply
  skips the cache — no code change needed.

- **D-15:** **Dashboard state ships as a user-turn preamble,** not in the
  system prompt. Every user message from `/chat` is wrapped by the backend
  before being sent to Anthropic:
  ```
  <dashboard_state>
    workbook: {workbookName}
    worksheet: {worksheetName}
    selected_marks: [{field}={value}, ...]
    active_filters: [{field}={values}, ...]
  </dashboard_state>

  <question>{user_question}</question>
  ```
  This preserves system-prompt cacheability (system prompt does not change
  per turn within a session) and gives Claude clear XML semantic boundaries.

- **D-16:** **Token-budget measurement = char-based estimate** with a 12.5%
  safety margin. Target **70k chars assembled** (≈17.5k tokens, comfortably
  under the 80k ceiling). Char-based is fast, deterministic, zero-dependency,
  and deterministic across test runs. Anthropic's `messages.countTokens`
  API is NOT used per-request — adding a network round-trip to every
  `/chat` burns the 2.5s assembly budget. It MAY be called at most once as
  a safety check when the char estimate is within 10% of ceiling.

- **D-17:** **Truncation algorithm** (proportional, priority order is
  schema > pulse > data rows per Init decision, already locked):
  1. **Step 1** — trim `LiveDataContext.rows[]` proportionally per
     datasource until under budget. Halve-and-check: 500 → 250 → 125 → 62
     → 31 → 15 → 7 → 0. Each datasource trimmed at the same step so signal
     stays balanced across sources.
  2. **Step 2** — if still over, drop `PulseContext.insightBundles[]` oldest-
     first (FIFO by metric creation), preserving metric definitions and
     feedback metadata.
  3. **Step 3** — if still over, start trimming `SchemaField` payloads:
     drop `description` first (keep `name/caption/dataType`), then
     `upstreamLineage`, then whole fields. Hard floor: keep at minimum 1
     field per datasource that has a schema.
  4. Every truncation step is logged at `info` level with counts for
     observability. `CopilotContext.truncated: boolean` is set to `true`
     whenever any trim happens.

- **D-18:** **Conversation history cap: 10 turns** (5 user + 5 assistant).
  Sliding window. Backend silently drops oldest turns from `messages[]`
  before calling Anthropic. No client signal, no 400. Demo walkthroughs
  won't hit the cap; if they do, the panel continues streaming normally.

### Export endpoints (Area 4)

- **D-19:** **`POST /export/slack` request shape:**
  ```json
  {
    "narrative": "full rendered markdown narrative from the panel",
    "anomalies": [{ "fieldName": "Region", "value": "West" }, ...],
    "workbookName": "Oil Prices Dashboard",
    "worksheetName": "WTI Daily"
  }
  ```
  Backend composes a **Slack Block Kit** payload:
  - Header block: `workbookName / worksheetName`
  - Section block: narrative as `mrkdwn`
  - Context block: each anomaly as `:warning: {fieldName} = {value}`
  - Divider
  - Footer context: "Posted from Aperture"

  Returns 200 on successful webhook POST, 503 with `{ error: "ENV_MISSING",
  key: "SLACK_WEBHOOK_URL" }` if the env var is not configured, 502 on
  webhook POST failure.

- **D-20:** **`POST /export/pdf` proxies Tableau REST.**
  - Request body: `{ workbookLuid: string }`. LUID validated via the same
    UUID regex Phase 2 uses (`^[a-f0-9-]{36}$/i`) before URL construction —
    SSRF defense.
  - Backend calls `/api/3.19/sites/{siteId}/workbooks/{workbookLuid}/pdf?type=A4&orientation=Portrait`
    via **`tableauFetch`** (hard invariant from Phase 1 — all Tableau calls
    go through the chokepoint).
  - Pipes the binary response body directly to the client as
    `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="aperture-workbook-{workbookLuid}.pdf"`.
  - **No backend buffering.** Streaming defense against DoS-by-huge-PDF.
  - Per-view (`views/{viewLuid}/pdf`) export is deferred to v2.

- **D-21:** **Slack webhook URL is ONLY read from `env.slackWebhookUrl`**
  (already wired in `backend/src/config/env.ts` from Phase 1). The client
  NEVER supplies a webhook URL. This eliminates SSRF by construction —
  there is no user-controlled URL to validate. Matches CLAUDE.md "no
  hardcoded secrets — everything through `.env`" and the Phase 1 Pino
  redact path contract.

- **D-22:** **Rate limiting via `@fastify/rate-limit` plugin** (in-memory
  store, single-process Fly.io is fine), registered globally with
  per-route overrides:
  - `POST /chat` — 60 requests/minute per IP
  - `POST /context` — 60 requests/minute per IP
  - `POST /export/slack` — 10 requests/minute per IP
  - `POST /export/pdf` — 10 requests/minute per IP
  - `GET /health` — unlimited (uptime probes)

  429 responses carry a `Retry-After` header. Mitigates open-CORS
  Anthropic-bill amplification and Slack-webhook spam.

### Claude's Discretion

The planner has latitude on:

- **File layout** under `backend/src/services/` and `backend/src/routes/`.
  Suggested: `services/contextAssembler.ts`, `services/claudeService.ts`,
  `services/streamParser.ts` (tag + suggestions state machine),
  `services/systemPromptBuilder.ts`, `routes/context.ts`, `routes/chat.ts`,
  `routes/export.ts` (combined Slack + PDF), but the planner may split or
  merge as makes sense.
- **Request body validation library** — Fastify JSON Schema (built in),
  Zod, or hand-rolled type guards. The existing Phase 2 services use
  hand-rolled guards; consistency argues for the same, but Fastify JSON
  Schema gives auto-generated OpenAPI for free. Pick whichever.
- **Anomaly / suggestions parser regex mechanics** — the spec's tag format
  is stable, so the parser implementation (char-by-char state machine vs.
  chunked regex scan) is planner's call. Acceptance criterion: chunk-boundary
  robustness, tested with deterministic split points in unit tests.
- **Per-datasource PulseContext ordering and insight selection** — top-3 by
  feedback weight is the default, but the planner can refine.
- **`CopilotContext` internal field names** as long as the `servicesFired`
  shape in D-05 is honored verbatim and Phase 4 can consume it without
  mapping.
- **Test strategy** — offline unit tests for StreamParser (fixed fixtures),
  offline unit tests for context truncation (fixture CopilotContext >70k
  chars), and live smoke tests against the EIA Prices datasource LUID
  (same primary subject as Phase 2).
- **Prompt string content** for the Role and Output Contract blocks — the
  sections are locked (D-13), the literal wording is the planner/executor's
  call as long as the contract rules are enforced.

### Folded Todos

None — no todos matched this phase in the backlog.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project-level (authoritative)
- `CLAUDE.md` — Ground rules: Tableau auth, Claude model lock, output contract
  (anomaly tags + suggestions JSON + 3-paragraph cap), `.trex` manifest
  requirements, Pulse graceful degradation rule.
- `aperture-spec.md` § "Phase 3 — Context Assembler + Claude" — authoritative
  scope for the Context Assembler, System Prompt Builder, Claude Service,
  and the four routes.
- `.planning/PROJECT.md` — Core value, active requirements, locked
  constraints (Fastify, Fly.io, Tableau REST 3.19, model lock).
- `.planning/REQUIREMENTS.md` § "Context Assembler & Claude" — CTX-01..17
  acceptance criteria.
- `.planning/ROADMAP.md` § "Phase 3" — goal + success criteria.
- `.planning/STATE.md` — Accumulated decisions and invariants from Phase 1 & 2
  that Phase 3 must honor (`tableauFetch` chokepoint, PAT auto-refresh,
  VDS field caption handling, Pulse empty-context contract, 5-datasource
  independence).

### Phase 2 artifacts Phase 3 builds on
- `backend/src/types/tableau.ts` — `SchemaContext`, `LiveDataContext`,
  `PulseContext`, `WorkbookMetadata` types. Phase 3's `CopilotContext` is
  the merge of these three.
- `backend/src/services/metadataService.ts` — `fetchSchemaByDatasourceLuids(luids)`
  and `fetchWorkbookMetadata(workbookLuid)`. Entry points for the assembler
  fan-out.
- `backend/src/services/vizqlService.ts` — `queryVizqlDatasource(req)`.
  Note the live-verified correction that VDS matches field captions natively
  via the `fieldCaption` key — no `interpretFieldCaptionsAsFieldNames` flag
  (see CLAUDE.md § "Tableau auth" and Phase 2 plan 02-03).
- `backend/src/services/pulseService.ts` — `fetchPulseContext(datasourceLuid)`.
  Already encodes the TAPI-10 graceful degradation path; Phase 3 must not
  re-wrap its error handling.
- `backend/src/services/tableauFetch.ts` — the single chokepoint for ALL
  Tableau HTTP calls. Phase 3's `/export/pdf` implementation MUST route
  through it (never raw `fetch`, never set `X-Tableau-Auth` manually).
- `backend/src/config/env.ts` — `anthropicApiKey` and `slackWebhookUrl` are
  already declared; Phase 3 consumes them, does not re-declare.
- `backend/src/server.ts` — current Fastify bootstrap + CORS allowlist.
  Phase 3 routes register via `await app.register(...)`.
- `backend/src/lib/logger.ts` — Pino instance with redact paths for auth
  headers. Phase 3 services must `.child({ module: '...' })` and follow
  the same count-only logging discipline (no raw rows, no Pulse bundle
  text, no Claude system prompt at info level).

### Phase 2 contracts Phase 3 MUST honor
- `.planning/phases/02-tableau-api-services/02-01-PLAN.md` — types contract.
- `.planning/phases/02-tableau-api-services/02-04-PLAN.md` — Pulse graceful
  degradation contract (empty `PulseContext` on no-metrics / 404 / 403).
- `.planning/phases/02-tableau-api-services/02-03-PLAN.md` — VDS transport
  fallback (SSE-first, JSON-fallback), 500-row hard cap, field-caption
  handling.
- `.planning/phases/02-tableau-api-services/02-VERIFICATION.md` — live UAT
  addendum noting TAPI-08/09 partial (Pulse bundle endpoint discovery
  deferred into Phase 3 — the assembler may need to call
  `insights:generate` and handle async bundle population).

### External (not in repo — researcher should fetch fresh when needed)
- Anthropic Messages API streaming — `anthropic.messages.stream()` helper.
- Anthropic prompt caching — `cache_control: { type: 'ephemeral' }` breakpoint
  semantics, 1024-token minimum, cache TTL.
- Tableau REST API 3.19 — `workbooks/{luid}/pdf` endpoint parameters.
- Slack incoming webhooks — Block Kit payload shape.
- `@fastify/rate-limit` plugin — in-memory store configuration.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- **`tableauFetch(url, init)`** (`backend/src/services/tableauFetch.ts`) —
  the single chokepoint for Tableau auth. `/export/pdf` must route through
  this. Already owns the 401 auto-refresh semantics end-to-end.
- **`fetchSchemaByDatasourceLuids` / `fetchWorkbookMetadata` / `queryVizqlDatasource` /
  `fetchPulseContext`** — the four Phase 2 service functions that the Context
  Assembler fans out to. Signatures are stable and typed.
- **`loadEnv()`** (`backend/src/config/env.ts`) — already declares
  `anthropicApiKey` and `slackWebhookUrl` as optional strings. Phase 3 reads
  them, throws a typed error if missing when a dependent route is hit.
- **`createLogger({ pretty })`** (`backend/src/lib/logger.ts`) — pino factory
  with redact paths for `X-Tableau-Auth`. Phase 3 modules call
  `.child({ module: '...' })` and inherit the redaction.
- **Phase 2 shared types** (`backend/src/types/tableau.ts`) — `SchemaContext`,
  `LiveDataContext`, `PulseContext`. `CopilotContext` is the merge.

### Established Patterns

- **Single exported async function per service** — each Phase 2 service
  exports one (or two, for metadata) public function returning a typed
  context envelope. Phase 3's `contextAssembler.ts` and `claudeService.ts`
  should follow this pattern.
- **Typed service-specific `Error` subclass** — each service has a
  `<Name>ServiceError` with a `cause` field. Phase 3 services should define
  `ContextAssemblerError` and `ClaudeServiceError` in the same style.
- **SSRF guards on LUIDs upfront** — validate against `/^[a-f0-9-]{36}$/i`
  BEFORE building any URL. Already used in metadata / VDS / Pulse services;
  `/export/pdf` must repeat the pattern.
- **Count-only logging** at info level — never log row contents, Pulse
  insight text, or Claude prompt/response bodies. Raw payloads are debug-only.
- **GraphQL variables, never string interpolation** — applies to any future
  Metadata-API-adjacent code (PDF uses REST, so N/A for this phase).

### Integration Points

- **Fastify registration:** Phase 3 route modules register via
  `await app.register(<routeFn>)` in `backend/src/server.ts`. Existing
  pattern is `routes/health.ts` → `import { healthRoutes } from '...'` →
  `await app.register(healthRoutes)`.
- **CORS allowlist** (`backend/src/server.ts`) is already locked to
  `env.extensionOrigin`. Phase 3 routes inherit this — no additional
  CORS setup needed.
- **Env var flow** — add no new required env vars in Phase 3. The two
  optional ones (`ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`) are already
  declared. Routes that depend on them must fail fast with
  `503 ENV_MISSING` when absent, not at boot.

</code_context>

<specifics>
## Specific Ideas

- **Pulse insight bundle discovery in the Phase 3 assembler.** Phase 2's
  02-VERIFICATION.md "Live UAT Addendum" flagged TAPI-08/09 as partial:
  live bundle fetch against `insights:generate` was not exercised end-to-end
  because bundles generate asynchronously after metric creation. Phase 3's
  `contextAssembler.ts` is the first real consumer of `fetchPulseContext()`
  against live bundles — expect the first live run to reveal edge cases in
  the Pulse REST response shape. The planner should include a task to
  verify bundle response shapes against the EIA Prices datasource during
  the smoke phase and log corrections inline.

- **EIA Prices datasource as primary test subject** (continued from Phase 2).
  `/context` and `/chat` smoke tests should default to the EIA Prices LUID
  because it's the only datasource guaranteed to produce a non-empty Pulse
  context (WTI Crude Oil Price metric configured 2026-04-11). The other
  three Pulse-equipped datasources (Inventory, Weather, Geopolitical) are
  available for multi-datasource fan-out smoke runs.

- **Demo cross-source correlation story.** The prompt structure in D-13
  must support Claude correlating across datasources (e.g., "WTI price
  spiked the same week inventory drew down in PADD 3 while Middle East
  tension rose"). The five-datasource fan-out is the demo's core value
  prop — the system prompt builder should render each datasource's context
  in a clearly labeled section so Claude can cite cross-source relationships
  by name.

- **`suggestions` must be three follow-up questions** (spec: `{"suggestions": ["...", "...", "..."]}`).
  The output contract phrasing in the system prompt should literally say
  "exactly three suggested follow-up questions". Phase 4's chip UI assumes
  three.

</specifics>

<deferred>
## Deferred Ideas

- **Per-view PDF export** (`views/{viewLuid}/pdf`) — Phase 3 ships whole-
  workbook PDF only. Per-worksheet PDF is a v2 ask.
- **Backend-held conversation state** (keyed by session ID) — Phase 3 is
  stateless; each `/chat` POST replays history client-side. Server-side
  session state is v2 (V2-03 in REQUIREMENTS.md is already the placeholder).
- **Workspace / tenant-scoped Slack webhooks** — v1 uses the single
  `SLACK_WEBHOOK_URL` env var. Multi-tenant webhook routing is a v2 concern.
- **Redis-backed rate limit store** — v1 uses in-memory (single-process
  Fly.io). Multi-instance deployment would need Redis.
- **`messages.countTokens` API as a routine safety net** — deferred. D-16
  allows one guarded call when the char estimate is near-ceiling, but
  routine use costs too much latency against the 3s budget.
- **Semantic cross-source correlation scoring** — v1 relies on Claude's
  narrative to correlate across the five datasources. A structured pre-
  correlation pass is a v2 idea.

</deferred>

---

*Phase: 03-context-assembler-claude*
*Context gathered: 2026-04-11*
