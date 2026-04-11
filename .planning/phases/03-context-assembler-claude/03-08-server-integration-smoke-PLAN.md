---
phase: 03-context-assembler-claude
plan: 08
type: execute
wave: 4
depends_on: [03-04, 03-05, 03-06, 03-07]
files_modified:
  - backend/src/server.ts
  - backend/src/services/__tests__/phase3.smoke.ts
  - backend/package.json
autonomous: false
requirements: [CTX-14, CTX-15, CTX-16, CTX-17]
tags: [phase-3, integration, rate-limit, smoke-test, wave-4, live-uat]

must_haves:
  truths:
    - "@fastify/rate-limit is registered globally with per-route overrides per D-22 (60/min for /chat & /context, 10/min for /export/*, unlimited for /health)"
    - "/context, /chat, /export/slack, /export/pdf are all registered in server.ts via app.register()"
    - "healthRoutes registration is MOVED so it occurs AFTER the fastifyRateLimit register AND after the onRoute hook installation (Warning 5 fix) — the hook covers every route including health, and the plugin's global default applies to /health (no explicit override = unlimited)"
    - "429 responses from rate limit include a Retry-After header"
    - "An offline burst test (Fastify inject() 61 requests through a stubbed assembler) asserts the 61st returns 429 with Retry-After AND that the onRoute hook propagated into the /context route scope — proves scoping regression is caught before live UAT"
    - "A phase3.smoke.ts script runs against the live sandbox with the EIA Prices datasource LUID and proves: (a) /context returns servicesFired.metadata.status='ok' (or 'partial' with ok>=1); (b) /chat emits an 'event: context' frame then streams tokens + anomaly + suggestions + done; SSE frame parsing is structural (split on '\\n\\n' + filter 'event: token') rather than substring-scanning the raw bytes (INFO 10 refinement)"
    - "A human verifies via curl the /chat SSE stream against the live EIA Prices LUID and confirms the narrative references real EIA Prices field captions and ends with a {\"suggestions\":[...]} JSON block (before it's stripped by the parser)"
  artifacts:
    - path: "backend/src/server.ts"
      provides: "Route registration + @fastify/rate-limit plugin + onRoute hook with healthRoutes moved AFTER the hook"
      contains: "rate-limit"
    - path: "backend/src/services/__tests__/phase3.smoke.ts"
      provides: "Live smoke harness that hits /context and /chat against the sandbox PLUS an offline burst/scoping regression test"
      contains: "phase3"
    - path: "backend/package.json"
      provides: "@fastify/rate-limit dependency + smoke:phase3 npm script"
      contains: "@fastify/rate-limit"
  key_links:
    - from: "backend/src/server.ts"
      to: "backend/src/routes/context.ts"
      via: "await app.register(contextRoutes)"
      pattern: "contextRoutes"
    - from: "backend/src/server.ts"
      to: "backend/src/routes/chat.ts"
      via: "await app.register(chatRoutes)"
      pattern: "chatRoutes"
    - from: "backend/src/server.ts"
      to: "backend/src/routes/export.ts"
      via: "await app.register(exportRoutes)"
      pattern: "exportRoutes"
    - from: "backend/src/server.ts"
      to: "@fastify/rate-limit"
      via: "await app.register(fastifyRateLimit, {...})"
      pattern: "fastifyRateLimit"
---

<objective>
Wire the Wave 3 routes into `server.ts`, register `@fastify/rate-limit` with D-22 per-route config, and run a live smoke against the sandbox's EIA Prices datasource LUID (Phase 2's primary test subject). This is the integration wave — no new service code, only glue + live verification.

**Hook ordering (Warning 5 fix):** Fastify's `onRoute` hook must be installed BEFORE any route plugin is registered, or it will not see those routes. The existing `server.ts` registers `healthRoutes` at line 48 (before any Phase 3 work). This plan MOVES the `healthRoutes` registration to AFTER the rate-limit plugin AND after the `onRoute` hook installation. Consequence: healthRoutes is covered by the same hook as all Phase 3 routes (with no rate-limit override because the hook's URL branching does not set one for `/health`, so the plugin's global default applies → effectively unlimited for uptime probes).

**Scoping regression (Warning 6 fix):** Fastify plugins each get their own encapsulation scope. An `onRoute` hook installed at the app level must propagate into plugin scopes — this is the default behavior, but it's easy to break by registering a route plugin inside a nested scope (e.g. `register(async (scope) => {...})` accidentally). This plan adds an offline burst test that fires 61 requests through a stubbed assembler via `app.inject()`, asserts the 61st returns 429 with `Retry-After`, AND implicitly verifies the hook applied to `contextRoutes` (scoping regression catch). Pure offline — no Tableau, no Anthropic.

Purpose: The rate limiter is THE mitigation for T-03-05-03 (Anthropic-bill DoS) and T-03-07-04 (export spam). It has to land in the same plan as route registration because the plugin must be registered BEFORE the routes for Fastify's per-route override decorator to attach.

The live smoke proves end-to-end that the three Phase 2 services actually compose with the Phase 3 assembler, prompt builder, Claude service, and SSE route — a final verification that the wave-2 offline-stubbed tests don't miss a real-world surface.

Output: server.ts updated (with healthRoutes moved after the hook), rate-limit plugin installed + registered, offline burst test, live smoke script, phase 3 npm script, human checkpoint for the live UAT.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/server.ts
@backend/package.json
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install @fastify/rate-limit and register routes + rate limit in server.ts (Warning 5 — MOVE healthRoutes below the hook)</name>
  <files>backend/src/server.ts, backend/package.json</files>
  <read_first>
    - backend/src/server.ts (existing bootstrap — import order matters: dotenv → Fastify → cors → routes; healthRoutes is currently registered at roughly line 48, BEFORE any Phase 3 work. This plan moves it.)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-22: 60/min for /chat & /context, 10/min for /export/*, unlimited for /health; 429 with Retry-After header)
    - backend/src/routes/context.ts (from Plan 03-06 — contextRoutes export)
    - backend/src/routes/chat.ts (from Plan 03-06 — chatRoutes default export produced by createChatRoutes())
    - backend/src/routes/export.ts (from Plan 03-07 — exportRoutes default export)
  </read_first>
  <action>
**Step A — install plugin:** `pnpm --filter @aperture/backend add @fastify/rate-limit`

**Step B — edit `backend/src/server.ts`.** The existing file imports dotenv FIRST (load order is load-bearing — see the top comment). Preserve that.

**CRITICAL ORDER OF OPERATIONS — Warning 5 fix:**

1. Add new imports at top (after existing imports):
   ```typescript
   import fastifyRateLimit from '@fastify/rate-limit';
   import { contextRoutes } from './routes/context.js';
   import { chatRoutes } from './routes/chat.js';
   import { exportRoutes } from './routes/export.js';
   ```

2. **MOVE the existing `await app.register(healthRoutes)` call.** It currently sits at approximately line 48 of `server.ts` (immediately after the CORS registration block, under the `// Routes` comment). Delete that call from its current position.

3. Inside `main()`, AFTER CORS registration and BEFORE any route registration (including the now-deleted healthRoutes call), add the rate-limit plugin:
   ```typescript
   // D-22: rate limiting. Global default is permissive (1000/min) — individual
   // routes apply tighter overrides via the onRoute hook below. /health uses
   // the global default (no override = effectively unlimited for uptime probes).
   await app.register(fastifyRateLimit, {
     global: false, // opt-in per route via onRoute hook
     max: 1000,
     timeWindow: '1 minute',
     skipOnError: true,
     addHeaders: { 'retry-after': true },
   });
   ```

4. Immediately AFTER the rate-limit plugin register, install the `onRoute` hook that applies D-22 limits by URL:
   ```typescript
   // Install the onRoute hook BEFORE any route plugin is registered, so
   // Fastify applies it to every subsequent route registration (including
   // healthRoutes, which is moved below this line). D-22 per-URL overrides:
   //   - /chat, /context           → 60/min
   //   - /export/slack, /export/pdf → 10/min
   //   - /health                   → no override (global default = unlimited)
   app.addHook('onRoute', (routeOpts) => {
     if (!routeOpts.config) routeOpts.config = {};
     const cfg = routeOpts.config as Record<string, unknown>;
     if (cfg.rateLimit !== undefined) return; // already set
     const url = routeOpts.url ?? '';
     let max: number | undefined;
     if (url === '/chat' || url === '/context') max = 60;
     else if (url === '/export/slack' || url === '/export/pdf') max = 10;
     // /health and any other unlisted route: no override → global default applies
     if (max !== undefined) {
       cfg.rateLimit = { max, timeWindow: '1 minute' };
     }
   });
   ```

5. **NOW** register all routes, including the MOVED healthRoutes call. Order:
   ```typescript
   // Route registration — MUST be after the onRoute hook above so every
   // registered route inherits the D-22 rate-limit config via the hook.
   // healthRoutes was previously registered at ~line 48, ABOVE the CORS
   // block — it is MOVED here so the onRoute hook covers it (Warning 5 fix).
   await app.register(healthRoutes);
   await app.register(contextRoutes);
   await app.register(chatRoutes);
   await app.register(exportRoutes);
   ```

Do NOT touch the dotenv loading order. Do NOT touch the CORS setup (already locked to `env.extensionOrigin`). Do NOT leave the old `healthRoutes` registration above the hook — the grep acceptance criterion below enforces ordering.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck && pnpm --filter @aperture/backend build</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "@fastify/rate-limit" backend/package.json`
    - `test -d backend/node_modules/@fastify/rate-limit`
    - `grep -q "import fastifyRateLimit from '@fastify/rate-limit'" backend/src/server.ts`
    - `grep -q "import { contextRoutes } from './routes/context.js'" backend/src/server.ts`
    - `grep -q "import { chatRoutes } from './routes/chat.js'" backend/src/server.ts`
    - `grep -q "import { exportRoutes } from './routes/export.js'" backend/src/server.ts`
    - `grep -q "await app.register(fastifyRateLimit" backend/src/server.ts`
    - `grep -q "await app.register(healthRoutes)" backend/src/server.ts`
    - `grep -q "await app.register(contextRoutes)" backend/src/server.ts`
    - `grep -q "await app.register(chatRoutes)" backend/src/server.ts`
    - `grep -q "await app.register(exportRoutes)" backend/src/server.ts`
    - `grep -q "app.addHook('onRoute'" backend/src/server.ts`
    - `grep -q "max: 60" backend/src/server.ts`
    - `grep -q "max: 10" backend/src/server.ts`
    - `grep -q "'/chat' || url === '/context'" backend/src/server.ts` or equivalent URL-branching pattern
    - **Warning 5 fix — healthRoutes is AFTER the rate-limit register**: `test $(grep -n 'app.register(healthRoutes)' backend/src/server.ts | head -1 | cut -d: -f1) -gt $(grep -n 'app.register(fastifyRateLimit' backend/src/server.ts | head -1 | cut -d: -f1)` (healthRoutes line number > fastifyRateLimit line number)
    - **Warning 5 fix — healthRoutes is AFTER the onRoute hook**: `test $(grep -n 'app.register(healthRoutes)' backend/src/server.ts | head -1 | cut -d: -f1) -gt $(grep -n "app.addHook('onRoute'" backend/src/server.ts | head -1 | cut -d: -f1)` (healthRoutes line number > onRoute hook line number)
    - Only ONE `app.register(healthRoutes)` in the file (old registration fully removed, not duplicated): `grep -c "app.register(healthRoutes)" backend/src/server.ts` returns `1`
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - `pnpm --filter @aperture/backend build` exits 0
  </acceptance_criteria>
  <done>Server bootstraps with rate limiter, four new routes registered, healthRoutes MOVED to after the onRoute hook, CORS untouched, build succeeds.</done>
</task>

<task type="auto">
  <name>Task 2: Write phase3.smoke.ts (live) AND offline burst test (Warning 6 — scoping regression catch + Retry-After assertion)</name>
  <files>backend/src/services/__tests__/phase3.smoke.ts, backend/package.json</files>
  <read_first>
    - backend/src/services/__tests__/phase2.smoke.ts (spawn-based sequential harness pattern, tsx runner, --datasource flag conventions)
    - backend/src/services/__tests__/metadataService.smoke.ts (how smoke scripts parse --datasource / --field flags and cold-boot gracefully)
    - .planning/STATE.md ("Phase 2 Execution Inputs" — EIA Prices is the primary test subject because it's the only datasource with a configured Pulse metric)
    - backend/src/routes/chat.ts (createChatRoutes factory — used by the offline burst test to inject a stubbed assembler)
  </read_first>
  <action>
Create `backend/src/services/__tests__/phase3.smoke.ts`:

A standalone tsx script that runs TWO phases. Phase A is an ALWAYS-RUN offline burst test (scoping regression catch). Phase B is a conditional live test against the sandbox.

**Phase A — Offline burst test (always runs, pure in-memory, Warning 6 fix):**

1. Import `Fastify` + `fastifyRateLimit` + `createChatRoutes` + `contextRoutes`.
2. Build a tiny Fastify instance that mirrors the real server.ts bootstrap: register `fastifyRateLimit`, install the same `onRoute` hook, then register a stubbed `contextRoutes` variant (or just the real one with a stubbed assembler injected). Simplest path: register `createChatRoutes({ assembler: stubAssembler, claudeDeps: { client: noopClient } })` for /chat AND a tiny inline route module for /context that uses the same stubbed assembler.
3. Fire 61 sequential `app.inject({ method: 'POST', url: '/context', payload: validBody })` requests.
4. Assert:
   - At least one response (typically the 61st) has `statusCode === 429`
   - The 429 response headers include a `retry-after` header (string)
   - At least the first 60 responses all have `statusCode` in [200, 502, 400] — never 429
   - If no response was 429, print the full status-code histogram and FAIL (scoping regression caught: hook didn't propagate into plugin scope)
5. Log: `PASS: burst test — onRoute hook propagated into contextRoutes scope, 61st request returned 429 + Retry-After`

**Phase B — Live smoke (runs only when --datasource and ANTHROPIC_API_KEY are present):**

1. Parses `--datasource <LUID>` from `process.argv.slice(2)`. Defaults to cold-boot if absent (prints "COLD-BOOT PASS: no LUID supplied, skipping live verification" and exits 0 — after Phase A has already run).
2. Parses `--workbook <name>` and `--worksheet <name>`, defaults to 'EIA Prices' / 'WTI Daily'.
3. Spawns the backend via `spawn('npx', ['tsx', 'src/server.ts'])` as a child process — OR assumes the user has it running on `http://localhost:${PORT}`. Default: assume running.
4. Hits `POST /context` with body `{ workbookName, worksheetName, datasourceLuids: [<LUID>], selectedMarks: [], activeFilters: [] }`. Assert:
   - HTTP 200
   - Response body has `servicesFired.metadata.status` in `['ok', 'partial']`
   - `servicesFired.metadata.datasources >= 1` (if 'ok') or `metadata.ok >= 1` (if 'partial')
   - Response body has `schema.datasources` with at least one LUID key
   - `assemblyMs < 3000`
   - Logs: `PASS: /context returned valid CopilotContext (metadata: <status>, assemblyMs: <ms>, chars: <chars>, truncated: <bool>)`

5. Hits `POST /chat` with body `{ ..., messages: [], question: 'Summarize the recent WTI crude oil price trend' }`. Opens the SSE stream via `fetch` with `Accept: text/event-stream`. Parse the response body **structurally** (INFO 10 refinement):
   - Split the raw response body on `\n\n` to get individual SSE frames.
   - For each frame, parse the `event:` line and `data:` line.
   - Assert:
     - First non-comment frame is `event: context`
     - At least one frame has `event: token`
     - At least one frame has `event: suggestions`
     - Last frame is `event: done`
     - **For every frame where `event === 'token'`**, parse `data:` as JSON and assert its serialized form contains NEITHER `[ANOMALY` NOR `{"suggestions"` (this is robust to frame-boundary splits because we check per-frame, not the raw wire)
     - Log: `PASS: /chat emitted context → tokens → suggestions → done with <N> tokens`

6. If either step fails, print the observed frame sequence for debugging and exit non-zero.

7. Cold-boot path: if either ANTHROPIC_API_KEY is missing OR --datasource is not supplied, print warnings and exit 0 (after Phase A has passed). This mirrors Phase 2 smoke conventions.

Add npm script: `"smoke:phase3": "tsx src/services/__tests__/phase3.smoke.ts"` after `smoke:exportroutes`.

Do NOT modify any existing smoke script (Phase 2's `smoke:phase2` harness stays untouched).
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:phase3</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "smoke:phase3" backend/package.json`
    - `grep -q "event: context" backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "event: done" backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "event: suggestions" backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "\[ANOMALY" backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "datasourceLuids" backend/src/services/__tests__/phase3.smoke.ts`
    - `grep -q "COLD-BOOT PASS\|cold-boot" backend/src/services/__tests__/phase3.smoke.ts`
    - **Warning 6 fix — burst test present**: `grep -q "61\|burst" backend/src/services/__tests__/phase3.smoke.ts`
    - **Warning 6 fix — 429 assertion**: `grep -q "429" backend/src/services/__tests__/phase3.smoke.ts`
    - **Warning 6 fix — Retry-After assertion**: `grep -q "retry-after\|Retry-After" backend/src/services/__tests__/phase3.smoke.ts`
    - **Warning 6 fix — uses inject()**: `grep -q "app.inject\|\\.inject(" backend/src/services/__tests__/phase3.smoke.ts`
    - **INFO 10 refinement — structural SSE parsing**: `grep -q "split.*\\\\n\\\\n\|split('\\\\n\\\\n')" backend/src/services/__tests__/phase3.smoke.ts` (frames parsed by splitting on blank-line boundaries, not raw substring scan)
    - `pnpm --filter @aperture/backend smoke:phase3` exits 0 (Phase A always passes; Phase B cold-boot path when no credentials)
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>phase3.smoke.ts runs green in two phases: Phase A offline burst test always runs and catches scoping regressions by firing 61 requests and asserting 429 + Retry-After on the 61st; Phase B runs live when credentials are supplied and parses SSE frames structurally to verify the /chat wire contract without substring-scanning the raw bytes.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: LIVE UAT — human verifies /chat against the EIA Prices datasource LUID</name>
  <files>backend/src/server.ts (observed via curl), backend/src/services/__tests__/phase3.smoke.ts (observed via npm script)</files>
  <action>This is a human verification checkpoint. The executor has already finished Tasks 1 and 2 (routes registered, healthRoutes moved below the onRoute hook, smoke script written with offline burst + live phases). No additional file edits in this task — the executor presents the verification steps to the user and waits for approval. If the human reports failures, loop back to iterate on whichever layer (system prompt, parser, rate-limit config) the failure implicates.</action>
  <verify><automated>echo "manual checkpoint — see how-to-verify steps"</automated></verify>
  <what-built>
    - Phase 3 routes registered: POST /context, POST /chat, POST /export/slack, POST /export/pdf
    - healthRoutes registration MOVED to after the onRoute hook (Warning 5 fix)
    - @fastify/rate-limit installed and configured per D-22
    - phase3.smoke.ts script with TWO phases: (A) offline burst test for the rate-limit scoping regression catch, (B) live /context + /chat verification
    - All Wave 1-3 offline tests pass (streamParser, systemPromptBuilder, contextBudget, contextAssembler, claudeService, chatRoute, exportRoutes)
  </what-built>
  <how-to-verify>
    Prerequisite: `.env` populated with `TABLEAU_*` vars AND `ANTHROPIC_API_KEY`. (Slack webhook optional.)

    **Step 1 — start the backend:**
    ```bash
    pnpm --filter @aperture/backend dev
    ```
    Expected: `Aperture backend listening` log line.

    **Step 2 — run the phase 3 smoke against the EIA Prices datasource LUID** (same LUID Phase 2 used; it's in STATE.md Phase 2 Execution Inputs):
    ```bash
    pnpm --filter @aperture/backend smoke:phase3 \
      --datasource <EIA_PRICES_LUID> \
      --workbook 'EIA Prices' \
      --worksheet 'WTI Daily'
    ```
    Expected: `PASS: burst test — onRoute hook propagated…` (Phase A) THEN two PASS lines (/context and /chat from Phase B). If any FAIL, the executor must iterate.

    **Step 3 — human curl verification of /chat** (the load-bearing demo interaction):
    ```bash
    curl -N -X POST http://localhost:${PORT:-3001}/chat \
      -H "Content-Type: application/json" \
      -H "Origin: http://localhost:5173" \
      -d '{
        "workbookName": "EIA Prices",
        "worksheetName": "WTI Daily",
        "datasourceLuids": ["<EIA_PRICES_LUID>"],
        "selectedMarks": [],
        "activeFilters": [],
        "messages": [],
        "question": "What is happening with WTI crude oil prices recently?"
      }'
    ```

    Expected observations (check each manually):
    1. **First frame is `event: context`** followed by JSON containing `servicesFired` with `metadata.status` in `['ok','partial']` and `pulse.status === 'ok'` (EIA Prices has the WTI metric) and `truncated: false` (small dataset)
    2. **A stream of `event: token`** frames arrives; when concatenated, forms a coherent 1-3 paragraph narrative
    3. **The narrative references real EIA Prices field captions** — e.g. "WTI_PRICE_USD", "DATE", or similar actual captions from the datasource (not invented names like "oilPrice" or "Price"). If Claude invents field names → FAIL, iterate on the system prompt
    4. **An `event: anomaly` frame appears** if the narrative identifies any anomaly (not strictly required — if no anomalies exist in the data, none should be emitted)
    5. **`event: suggestions`** appears near the end with `items` array of length exactly 3
    6. **`event: done`** is the last frame with `stopReason: 'end_turn'` and a non-zero `usage.inputTokens` (note: if `usage.inputTokens === 0`, claudeService's usage handler may need to move from `message_stop` to `message_delta` — see INFO 11 in Plan 03-05)
    7. **No `[ANOMALY` or `{"suggestions"` substring** leaks into any `event: token` frame's data payload (grep the saved curl output)

    **Step 4 — rate limit verification:**
    ```bash
    # Fire 61 /context requests in a burst; expect the 61st to return 429.
    for i in $(seq 1 61); do
      curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:${PORT:-3001}/context \
        -H "Content-Type: application/json" \
        -H "Origin: http://localhost:5173" \
        -d '{"workbookName":"x","worksheetName":"y","datasourceLuids":["<EIA_PRICES_LUID>"],"selectedMarks":[],"activeFilters":[]}'
    done | tail -5
    ```
    Expected: at least one 429 in the tail. Header `Retry-After` present.

    **Step 5 — CTX-14..17 coverage confirmation:** /context and /chat both hit successfully. /export/slack and /export/pdf have offline tests; live PDF export can be optionally smoke-tested by posting a valid workbookLuid (from Phase 2's workbook metadata) to /export/pdf and saving the response to a file. Slack webhook live test is optional (requires SLACK_WEBHOOK_URL set).
  </how-to-verify>
  <acceptance_criteria>
    - User confirms all 7 /chat observations (especially #3: real field captions, and #7: no tag leakage)
    - User confirms /context returns within 3s
    - User confirms rate limit fires at 60+ requests in a minute
    - If any observation fails, user describes the gap and execute-phase loops back to iterate
  </acceptance_criteria>
  <resume-signal>Type "approved — live UAT passed" or describe the observed failures for iteration.</resume-signal>
  <done>Human has confirmed end-to-end /chat streaming against the live EIA Prices datasource returns a narrative that (a) references real field captions, (b) strips anomaly tags from token frames, (c) ends with suggestions + done, and (d) fires rate limiting at the D-22 threshold.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Rate limiter state | In-memory per-IP counter. Fly.io is single-process so in-memory is sufficient. |
| Live smoke HTTP → backend → Tableau / Anthropic | All three Phase 2 invariants still apply (tableauFetch chokepoint, PAT auto-refresh, no hardcoded secrets). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-08-01 | **DoS** (HIGH) | Anthropic-bill amplification via /chat | mitigate | **D-22**: `@fastify/rate-limit` 60/min/IP on /chat + /context. Task 1 acceptance greps for `max: 60`. Task 2 Phase A offline burst test + Task 3 Step 4 manual probe both assert 429 at the 61st request. |
| T-03-08-02 | **DoS** | /export/slack and /export/pdf spam | mitigate | **D-22**: `max: 10` per minute per IP for both export routes. Task 1 acceptance greps for `max: 10`. |
| T-03-08-03 | **DoS** | /health getting throttled | mitigate | Task 1 hook's URL branching leaves `/health` with no rateLimit config → plugin's global default (1000/min) applies → effectively unlimited for uptime probes. Grep-verified: healthRoutes registration is AFTER the onRoute hook so the hook sees it, but the hook's if-branch does not set a rateLimit override for `/health`. |
| T-03-08-04 | **Secret exposure in logs** | Live smoke hitting Anthropic | mitigate | `.env` is git-ignored. phase3.smoke.ts never prints env.anthropicApiKey. Pino redact paths cover auth headers. Live UAT checkpoint (Task 3) runs on developer machine only. |
| T-03-08-05 | **Env-missing boot failure** | Routes that need ANTHROPIC_API_KEY / SLACK_WEBHOOK_URL | mitigate | All four routes lazy-check their env vars inside the request handler (Plans 03-06 and 03-07). Task 3 Step 1 confirms `pnpm dev` starts even when optional env vars are missing — only routes that need them return 503. |
| T-03-08-06 | **Scoping regression** | onRoute hook not propagating into plugin scopes | mitigate | Task 2 Phase A offline burst test fires 61 `app.inject()` requests through a stubbed assembler and asserts 429+Retry-After on the 61st. If the hook fails to propagate into `contextRoutes`' plugin scope, every request returns 200 and the test fails loudly. This catches the regression before live UAT. |

One HIGH threat (T-03-08-01) mitigated by D-22 + active human verification in Task 3.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend typecheck` exits 0
- `pnpm --filter @aperture/backend build` exits 0
- `pnpm --filter @aperture/backend smoke:phase3` exits 0 (Phase A burst test + Phase B cold-boot or live path)
- Human UAT checkpoint (Task 3) explicitly approved
- All 17 CTX-01..17 requirements now code-complete AND live-verified where possible (CTX-14/15 via Task 3 live /context + /chat; CTX-16/17 via offline tests in Plan 03-07 with optional live smoke in Task 3 Step 5)
- healthRoutes registration is MOVED to after the onRoute hook (grep-verified via line number comparison)
- exactly ONE `app.register(healthRoutes)` occurrence in server.ts (old registration fully removed)
</verification>

<success_criteria>
- Backend boots with four new routes registered
- healthRoutes is registered AFTER the onRoute hook so it inherits the hook (Warning 5 fix)
- /context returns in < 3s against live EIA Prices datasource
- /chat streams real narrative with real field captions and zero tag leakage
- Rate limit fires at 60/min for /chat + /context, 10/min for /export/*
- Phase A burst test (offline) catches scoping regressions via 61-request inject() burst (Warning 6 fix)
- SSE frame parsing in Phase B is structural (split on `\n\n`), not substring-based (INFO 10 refinement)
- Human-verified via curl
- phase3.smoke.ts wired as `smoke:phase3` npm script
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-08-SUMMARY.md` — MUST include the live-UAT observations from Task 3 verbatim (what the judge would see).
</output>
