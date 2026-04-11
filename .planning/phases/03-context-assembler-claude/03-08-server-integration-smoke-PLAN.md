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
    - "429 responses from rate limit include a Retry-After header"
    - "A phase3.smoke.ts script runs against the live sandbox with the EIA Prices datasource LUID and proves: (a) /context returns servicesFired.metadata.status='ok' (or 'partial' with ok>=1); (b) /chat emits an 'event: context' frame then streams tokens + anomaly + suggestions + done"
    - "A human verifies via curl the /chat SSE stream against the live EIA Prices LUID and confirms the narrative references real EIA Prices field captions and ends with a {\"suggestions\":[...]} JSON block (before it's stripped by the parser)"
  artifacts:
    - path: "backend/src/server.ts"
      provides: "Route registration + @fastify/rate-limit plugin"
      contains: "rate-limit"
    - path: "backend/src/services/__tests__/phase3.smoke.ts"
      provides: "Live smoke harness that hits /context and /chat against the sandbox"
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

Purpose: The rate limiter is THE mitigation for T-03-05-03 (Anthropic-bill DoS) and T-03-07-04 (export spam). It has to land in the same plan as route registration because the plugin must be registered BEFORE the routes for Fastify's per-route override decorator to attach.

The live smoke proves end-to-end that the three Phase 2 services actually compose with the Phase 3 assembler, prompt builder, Claude service, and SSE route — a final verification that the wave-2 offline-stubbed tests don't miss a real-world surface.

Output: server.ts updated, rate-limit plugin installed + registered, live smoke script, phase 3 npm script, human checkpoint for the live UAT.
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
  <name>Task 1: Install @fastify/rate-limit and register routes + rate limit in server.ts</name>
  <files>backend/src/server.ts, backend/package.json</files>
  <read_first>
    - backend/src/server.ts (existing bootstrap — import order matters: dotenv → Fastify → cors → routes)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-22: 60/min for /chat & /context, 10/min for /export/*, unlimited for /health; 429 with Retry-After header)
    - backend/src/routes/context.ts (from Plan 03-06 — contextRoutes export)
    - backend/src/routes/chat.ts (from Plan 03-06 — chatRoutes export)
    - backend/src/routes/export.ts (from Plan 03-07 — exportRoutes export)
  </read_first>
  <action>
**Step A — install plugin:** `pnpm --filter @aperture/backend add @fastify/rate-limit`

**Step B — edit `backend/src/server.ts`.** The existing file imports dotenv FIRST (load order is load-bearing — see the top comment). Preserve that. Add:

```typescript
// near top, after existing imports:
import fastifyRateLimit from '@fastify/rate-limit';
import { contextRoutes } from './routes/context.js';
import { chatRoutes } from './routes/chat.js';
import { exportRoutes } from './routes/export.js';
```

Inside `main()`, AFTER cors registration and BEFORE route registration:

```typescript
// D-22: rate limiting. Global default is permissive (1000/min) — individual
// routes apply tighter overrides via the config decorator below. /health is
// exempted so uptime probes don't get throttled.
await app.register(fastifyRateLimit, {
  global: false, // opt-in per route
  max: 1000,
  timeWindow: '1 minute',
  skipOnError: true,
  addHeaders: { 'retry-after': true },
});
```

Then, register the routes with per-route overrides. Fastify's `@fastify/rate-limit` accepts config via `config.rateLimit` on each route, OR via the plugin's `onRoute` hook. Easiest pattern: register each route module inside a `app.register(async (scope) => {...})` wrapper that sets `rateLimit` on the route options. BUT because our route modules already call `app.post('/path', ...)` internally, we wrap them instead via Fastify's global default set by the plugin — and per-route config on each handler.

Simplest fix: modify Plan 03-06 / 03-07 routes to accept rateLimit config OR add rate-limit config to the module-level `app.register()` hook in server.ts. Example using onRoute hook:

```typescript
// BEFORE route registration, install an onRoute hook that applies D-22 limits by URL:
app.addHook('onRoute', (routeOpts) => {
  if (!routeOpts.config) routeOpts.config = {};
  const rl = (routeOpts.config as Record<string, unknown>).rateLimit;
  if (rl !== undefined) return; // already set
  const url = routeOpts.url ?? '';
  let max: number | undefined;
  if (url === '/chat' || url === '/context') max = 60;
  else if (url === '/export/slack' || url === '/export/pdf') max = 10;
  else if (url === '/health') max = undefined; // unlimited
  if (max !== undefined) {
    (routeOpts.config as Record<string, unknown>).rateLimit = { max, timeWindow: '1 minute' };
  }
});

// Register the routes AFTER the hook is installed.
await app.register(healthRoutes);
await app.register(contextRoutes);
await app.register(chatRoutes);
await app.register(exportRoutes);
```

**IMPORTANT:** the onRoute hook must be registered BEFORE `app.register(healthRoutes)` or any route plugin so Fastify applies it to every subsequent route registration. Verify during execution that the hook actually attaches config to each route — test via a unit test in Task 3 that hits a non-existent endpoint and confirms 404 (not rate-limited) vs. hits /context 61 times in a burst and confirms the 61st returns 429 with `Retry-After`.

Do NOT touch the dotenv loading order. Do NOT touch the CORS setup (already locked to `env.extensionOrigin`).
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
    - `grep -q "await app.register(contextRoutes)" backend/src/server.ts`
    - `grep -q "await app.register(chatRoutes)" backend/src/server.ts`
    - `grep -q "await app.register(exportRoutes)" backend/src/server.ts`
    - `grep -q "app.addHook('onRoute'" backend/src/server.ts`
    - `grep -q "max: 60" backend/src/server.ts`
    - `grep -q "max: 10" backend/src/server.ts`
    - `grep -q "'/chat' || url === '/context'" backend/src/server.ts` or equivalent URL-branching pattern
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - `pnpm --filter @aperture/backend build` exits 0
  </acceptance_criteria>
  <done>Server bootstraps with rate limiter, four new routes registered, existing health route + CORS untouched, build succeeds.</done>
</task>

<task type="auto">
  <name>Task 2: Write phase3.smoke.ts that hits /context and /chat against the live EIA Prices datasource LUID</name>
  <files>backend/src/services/__tests__/phase3.smoke.ts, backend/package.json</files>
  <read_first>
    - backend/src/services/__tests__/phase2.smoke.ts (spawn-based sequential harness pattern, tsx runner, --datasource flag conventions)
    - backend/src/services/__tests__/metadataService.smoke.ts (how smoke scripts parse --datasource / --field flags and cold-boot gracefully)
    - .planning/STATE.md ("Phase 2 Execution Inputs" — EIA Prices is the primary test subject because it's the only datasource with a configured Pulse metric)
  </read_first>
  <action>
Create `backend/src/services/__tests__/phase3.smoke.ts`:

A standalone tsx script that:
1. Parses `--datasource <LUID>` from `process.argv.slice(2)`. Defaults to cold-boot if absent (prints "COLD-BOOT PASS: no LUID supplied, skipping live verification" and exits 0).
2. Parses `--workbook <name>` and `--worksheet <name>`, defaults to 'EIA Prices' / 'WTI Daily'.
3. Spawns the backend via `spawn('npx', ['tsx', 'src/server.ts'])` as a child process — OR assumes the user has it running on `http://localhost:${PORT}`. Default: assume running.
4. Hits `POST /context` with body `{ workbookName, worksheetName, datasourceLuids: [<LUID>], selectedMarks: [], activeFilters: [] }`. Assert:
   - HTTP 200
   - Response body has `servicesFired.metadata.status` in `['ok', 'partial']`
   - `servicesFired.metadata.datasources >= 1` (if 'ok') or `metadata.ok >= 1` (if 'partial')
   - Response body has `schema.datasources` with at least one LUID key
   - `assemblyMs < 3000`
   - Logs: `PASS: /context returned valid CopilotContext (metadata: <status>, assemblyMs: <ms>, chars: <chars>, truncated: <bool>)`

5. Hits `POST /chat` with body `{ ..., messages: [], question: 'Summarize the recent WTI crude oil price trend' }`. Opens the SSE stream via `fetch` with `Accept: text/event-stream`. Parse the response body line-by-line and assert:
   - First non-comment event is `event: context`
   - At least one `event: token` appears
   - At least one `event: suggestions` appears (items may be empty)
   - Last event is `event: done`
   - No `event: token` data payload contains the substring `[ANOMALY` or `{"suggestions"`
   - Log: `PASS: /chat emitted context → tokens → suggestions → done with <N> tokens`

6. If either step fails, print the observed frame sequence for debugging and exit non-zero.

7. Cold-boot path: if either ANTHROPIC_API_KEY is missing OR --datasource is not supplied, print warnings and exit 0. This mirrors Phase 2 smoke conventions.

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
    - `pnpm --filter @aperture/backend smoke:phase3` exits 0 (cold-boot path when no credentials)
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>phase3.smoke.ts runs green on cold-boot (no credentials) and passes live when --datasource is supplied against a running backend with real env.</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <name>Task 3: LIVE UAT — human verifies /chat against the EIA Prices datasource LUID</name>
  <files>backend/src/server.ts (observed via curl), backend/src/services/__tests__/phase3.smoke.ts (observed via npm script)</files>
  <action>This is a human verification checkpoint. The executor has already finished Tasks 1 and 2 (routes registered, smoke script written). No additional file edits in this task — the executor presents the verification steps to the user and waits for approval. If the human reports failures, loop back to iterate on whichever layer (system prompt, parser, rate-limit config) the failure implicates.</action>
  <verify><automated>echo "manual checkpoint — see how-to-verify steps"</automated></verify>
  <what-built>
    - Phase 3 routes registered: POST /context, POST /chat, POST /export/slack, POST /export/pdf
    - @fastify/rate-limit installed and configured per D-22
    - phase3.smoke.ts script that runs against localhost with a supplied --datasource flag
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
    Expected: two PASS lines (/context and /chat). If any FAIL, the executor must iterate.

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
    6. **`event: done`** is the last frame with `stopReason: 'end_turn'` and a non-zero `usage.inputTokens`
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
| T-03-08-01 | **DoS** (HIGH) | Anthropic-bill amplification via /chat | mitigate | **D-22**: `@fastify/rate-limit` 60/min/IP on /chat + /context. Task 1 acceptance greps for `max: 60`. Task 3 Step 4 manually probes 61 requests and asserts 429. |
| T-03-08-02 | **DoS** | /export/slack and /export/pdf spam | mitigate | **D-22**: `max: 10` per minute per IP for both export routes. Task 1 acceptance greps for `max: 10`. |
| T-03-08-03 | **DoS** | /health getting throttled | mitigate | Task 1 hook leaves `/health` with no rateLimit config → plugin's default (1000/min) applies → effectively unlimited for uptime probes. Grep-verified: `grep -A2 "'/health'" backend/src/server.ts` shows no rate-limit override. |
| T-03-08-04 | **Secret exposure in logs** | Live smoke hitting Anthropic | mitigate | `.env` is git-ignored. phase3.smoke.ts never prints env.anthropicApiKey. Pino redact paths cover auth headers. Live UAT checkpoint (Task 3) runs on developer machine only. |
| T-03-08-05 | **Env-missing boot failure** | Routes that need ANTHROPIC_API_KEY / SLACK_WEBHOOK_URL | mitigate | All four routes lazy-check their env vars inside the request handler (Plans 03-06 and 03-07). Task 3 Step 1 confirms `pnpm dev` starts even when optional env vars are missing — only routes that need them return 503. |

One HIGH threat (T-03-08-01) mitigated by D-22 + active human verification in Task 3.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend typecheck` exits 0
- `pnpm --filter @aperture/backend build` exits 0
- `pnpm --filter @aperture/backend smoke:phase3` exits 0 (cold-boot path or live path)
- Human UAT checkpoint (Task 3) explicitly approved
- All 17 CTX-01..17 requirements now code-complete AND live-verified where possible (CTX-14/15 via Task 3 live /context + /chat; CTX-16/17 via offline tests in Plan 03-07 with optional live smoke in Task 3 Step 5)
</verification>

<success_criteria>
- Backend boots with four new routes registered
- /context returns in < 3s against live EIA Prices datasource
- /chat streams real narrative with real field captions and zero tag leakage
- Rate limit fires at 60/min for /chat + /context, 10/min for /export/*
- Human-verified via curl
- phase3.smoke.ts wired as `smoke:phase3` npm script
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-08-SUMMARY.md` — MUST include the live-UAT observations from Task 3 verbatim (what the judge would see).
</output>
