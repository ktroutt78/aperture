---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
last_updated: "2026-04-12T04:32:37.339Z"
progress:
  total_phases: 5
  completed_phases: 3
  total_plans: 17
  completed_plans: 17
  percent: 100
---

# STATE: Aperture

**Last updated:** 2026-04-11 (Phase 2 complete — 11/11 TAPI-* requirements live-verified against the sandbox; ready to plan Phase 3)

---

## Project Reference

**Core Value:** A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

**Current focus:** Phase 03 — Context Assembler + Claude (ready to plan)

**Authoritative docs:**

- `aperture-spec.md` — technical spec (phases, stack, contracts)
- `CLAUDE.md` — ground rules and technical constraints
- `.planning/PROJECT.md` — project context
- `.planning/REQUIREMENTS.md` — 58 v1 requirements (mapped to 5 phases)
- `.planning/ROADMAP.md` — phase-by-phase goals and success criteria

---

## Current Position

Phase: 01 (Scaffold + Auth) — COMPLETE
Phase: 02 (Tableau API Services) — COMPLETE (5 plans, 3 waves, code review + live UAT passed; TAPI-08/09 partial — bundle endpoint discovery deferred to Phase 3)
**Milestone:** v1 demo
**Phase:** 4
**Plan:** Not started
**Status:** Ready to plan

**Progress:**

```
[██████████] Phase 1: Scaffold + Auth             (100% — complete)
[██████████] Phase 2: Tableau API Services        (100% — complete, live-verified)
[..........] Phase 3: Context Assembler + Claude  (0% — ready to plan)
[..........] Phase 4: Extension UI                (0% — not started)
[..........] Phase 5: Polish + Docs               (0% — not started)
```

**Phases complete:** 2/5
**Requirements shipped:** SCAF-01..07 (Phase 1) + TAPI-01..11 (Phase 2; TAPI-08/09 partial — see 02-VERIFICATION.md Live UAT Addendum)
**Requirements next:** CTX-01..17 (Phase 3 — Context Assembler + Claude)

---

## Performance Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Context assembly time (demo dataset) | < 3s | — |
| Narrative length | ≤ 3 paragraphs | — |
| Judge install-to-working-demo time | < 5 min | — |
| Phases complete | 5/5 | 1/5 |
| v1 requirements shipped | 58/58 | 7/58 |
| Phase 01 P04 | 6m 6s | 3 tasks | 6 files |

### Plan Execution Metrics

| Phase-Plan | Duration | Tasks | Files | Notes |
|------------|----------|-------|-------|-------|
| 01-01 | ~2 min | 2 | 11 | Monorepo scaffold |
| 01-02 | ~5m 45s | 2 | 9 | Fastify backend + /health |
| 01-03 | ~3 min | 2 | 11 | Vite + React extension + .trex |
| 01-04 | 6m 6s | 3 | 6 | Tableau PAT auth + tableauFetch + decisions |

---

## Accumulated Context

### Decisions

| Decision | Rationale | Phase |
|----------|-----------|-------|
| Map GSD roadmap 1:1 to `aperture-spec.md`'s 5 phases | Spec is authoritative; don't re-derive what's decided | Init |
| Coarse granularity (5 phases) | Matches spec exactly | Init |
| Skip project-level research agents | Spec already fixes stack, architecture, APIs, types | Init |
| Backend framework choice deferred to Phase 1 | Spec says "choose the best framework and hosting for the job" | Init |
| Context truncation priority: schema > pulse > data rows | Schema + AI insights are denser signal than raw rows | Init (Phase 3 scope) |
| Auto-refresh Tableau PAT on 401 (reactive) | 4-hour expiry is reliable; reactive is simpler than timer-based | Init (Phase 1 scope) |
| `interpretFieldCaptionsAsFieldNames: true` on every VizQL request | Ensures Claude sees the same field names users see | Init (Phase 2 scope) |
| Use `/ui-ux-pro-max` for all `extension/` work | CLAUDE.md ground rule; Tableau-native polish is core value | Init (Phase 4+ scope) |
| Backend framework = Fastify 5 | TypeScript-first, pino built in, best SSE support for Phase 3 /chat streaming, rich plugin ecosystem | Phase 1 (Plan 01-02 + 01-04) |
| Backend hosting target = Fly.io | Long-lived SSE support, HTTPS out of box, Node 20, Docker-first, free tier; alternatives (Render/Railway/Vercel) rejected for SSE or timeout reasons | Phase 1 (Plan 01-04) |
| Tableau REST API version = 3.19 | Stable minimum supporting PAT signin for Metadata + VizQL + Pulse on Tableau Cloud 2024.2+ | Phase 1 (Plan 01-04) |
| Token cache = in-memory singleton, 3h45m proactive expiry + reactive 401 refresh | Single-process backend; 15-min safety margin under 4h PAT hard expiry; reactive refresh covers any unexpected revocation | Phase 1 (Plan 01-04) |
| `tableauFetch(url, init)` is the single chokepoint for all Tableau API calls | Enforces X-Tableau-Auth injection + exactly-one 401 retry in exactly one place; Phase 2 services MUST use it | Phase 1 (Plan 01-04) |
| Data foundation: 5 independent Snowflake marts published as **5 independent Tableau datasources** (no Tableau-layer joins, no Tableau relationships) | Cortex's design rule: "marts are never joined to each other." Claude + VizQL is the correlation engine. Cross-source relationships (prices↔inventory, geopolitical↔prices, weather↔demand) are discovered at query time by the Context Assembler in Phase 3, not pre-joined in SQL or Tableau. | Phase 2 planning (2026-04-11) |
| Phase 2 service architecture: LUID-parameterized — Metadata/VizQL/Pulse services take datasource LUIDs as input, not hardcoded to any specific datasource | Enables Phase 3's Context Assembler to fan out to all 5 datasources with `Promise.all`; services are agnostic to how many datasources exist | Phase 2 planning (2026-04-11) |
| Primary test subject for Phase 2 smokes = **EIA Prices datasource** (`MART_EIA_PRICES`) | It's the only datasource with a Pulse metric (WTI Crude Oil Price), so Pulse smoke hits `hasMetrics: true` happy path instead of silently cold-booting to empty | Phase 2 planning (2026-04-11) |

### Invariants (never regress)

- Tableau PAT tokens expire after 4 hours — backend must auto-refresh on any 401 from Metadata, VizQL, or Pulse.
- All three Tableau APIs share one `X-Tableau-Auth` token.
- VizQL requires `API Access` permission enabled per datasource in Tableau Cloud.
- Every VizQL request sets `interpretFieldCaptionsAsFieldNames: true`.
- Max 500 rows per VizQL query.
- Claude model is locked to `claude-sonnet-4-20250514`, streaming always.
- Claude output contract: inline `[ANOMALY: fieldName="x" value="y"]` tags + trailing `{"suggestions": ["...", "...", "..."]}` + ≤ 3 paragraphs + real field captions.
- `.trex` manifest declares `full data` permission and `tableau.extensions.datasources.get`.
- Backend served over public HTTPS in production (Tableau Extension requirement).
- Pulse degrades gracefully with no metrics — never crash the panel.
- No hardcoded secrets — everything through `.env`.
- All Tableau API calls in Phase 2+ MUST go through `tableauFetch` — never construct `X-Tableau-Auth` headers anywhere else.
- Never log the full Tableau session token or PAT secret — only `tokenPrefix` (first 8 chars) and `siteId`.
- Tableau datasources are never pre-joined at the Tableau layer. All cross-source correlation happens in the Context Assembler (Phase 3) and Claude's narrative (Phase 3+). SQL marts are also independent — no cross-source joins, no shared dimension tables across data domains.

### Open Todos

- [x] ~~Run `/gsd-plan-phase 1` to decompose Phase 1 (Scaffold + Auth) into executable plans.~~ (Done — 4 plans executed)
- [x] ~~During Phase 1 planning, make and log the backend framework + hosting decision.~~ (Done — Plan 01-04 Task 3)
- [x] ~~User: populate `.env` with real Tableau Cloud PAT credentials and rerun `pnpm --filter @aperture/backend smoke:auth` to hard-verify SCAF-05 against the live sandbox.~~ (Done — commit `bb5327a`)
- [x] ~~Run `/gsd-plan-phase 2` to decompose Phase 2 (Tableau API Services) into Metadata / VizQL / Pulse service plans.~~ (Done — commit `85f945d`, 5 plans across 3 waves, verification passed iteration 1)
- [ ] Run `/gsd-execute-phase 2` to ship Phase 2 (see "Phase 2 Execution Inputs" below for required args).

### Blockers

None. Phase 1 is shippable. SCAF-05 live verification is deferred to user setup (non-blocking — the code path is implemented and smoke-tested on the expected empty-credential cold-boot path).

---

## Session Continuity

**Last session:** 2026-04-11T22:53:00.210Z

## Phase 2 Execution Inputs (for `/gsd-execute-phase 2`)

**Data architecture (authoritative — Phase 3+ must honor this):**

- **5 independent Snowflake marts** = **5 independent Tableau datasources** (no Tableau-layer joins, no Tableau relationships, no bundled publishing):
  1. **EIA Prices** (`MART_EIA_PRICES`) — daily WTI/Brent/Gasoline/Jet/Diesel, national grain, ~5k rows, back to 2006 — **PRIMARY TEST SUBJECT for Phase 2 smokes** (has the WTI Pulse metric)
  2. **EIA Inventory** (`MART_EIA_INVENTORY`) — weekly petroleum inventory by PADD, ~11.7k rows, back to 1982
  3. **EIA STEO** (`MART_EIA_STEO`) — monthly forecasts, ~456 rows — **NO Pulse metric by design** (monthly + forward-looking is a poor Pulse fit; forecast divergence is a Phase 3 Claude-narrative concern)
  4. **Weather** (`MART_WEATHER`) — daily NOAA temperature + degree days by PADD, ~5.5k rows
  5. **Geopolitical** (`MART_GEOPOLITICAL`) — weekly GDELT event scores by country, ~21.6k rows
- Full schema reference: `docs/data_source_documentation.md`
- Claude + VizQL = the correlation engine. Cross-source relationships (prices↔inventory, geopolitical↔prices, weather↔distillate-demand) are discovered at query time in Phase 3's Context Assembler, never pre-joined.

**Tableau Pulse metrics configured (2026-04-11):**

| # | Datasource | Metric | Measure | Filter | Grain |
|---|---|---|---|---|---|
| 1 | EIA Prices | WTI Crude Oil Price | `WTI_PRICE_USD` | none | daily |
| 2 | EIA Inventory | US Total Crude Oil Inventory | `CRUDE_INVENTORY_KBBL` | `PADD_ID = 0` | weekly |
| 3 | Weather | Midwest Heating Degree Days | `HEATING_DEGREE_DAYS` | `PADD_ID = 2` | daily |
| 4 | Geopolitical | Middle East Tension Score | `GEOPOLITICAL_TENSION_SCORE` | `COUNTRY_CODE IN ('SAU','IRN','IRQ','KWT','ARE','YEM')` | weekly |

**Execution guidance for the smoke tests:**

- When `02-02 metadataService.smoke` / `02-03 vizqlService.smoke` / `02-04 pulseService.smoke` / `02-05 phase2.smoke` prompt for `--datasource <LUID>`, pass the **EIA Prices datasource LUID** as the primary subject. That's the only datasource guaranteed to hit Pulse's `hasMetrics: true` happy path with the WTI metric configured on it.
- The other 3 Pulse-equipped datasources (Inventory, Weather, Geopolitical) are available for optional additional smoke runs — but EIA Prices is the single LUID that makes TAPI-07/08/09 live-verifiable in one pass.
- The EIA STEO datasource, if published, will return an empty `PulseContext` when the Pulse smoke hits it — this is the TAPI-10 graceful-degradation path and is additionally enforced by the offline unit test `pulseService.empty.test.ts`.
- Pulse insight bundles generate **asynchronously** after metric creation; metrics were configured 2026-04-11, so insights should be populated by execution time. If `hasMetrics: true` but `insightBundles: []`, wait 10–15 minutes and re-run the Pulse smoke — not a code bug.

**Key context for Phase 2 executors (same as planner context, repeated here for session-continuity):**

- `tableauFetch` is the single chokepoint. Metadata / VizQL / Pulse services each import `tableauFetch` from `backend/src/services/tableauFetch.js` and call it instead of native `fetch`. Never touch `X-Tableau-Auth` directly.
- `tokenCache` is private — Phase 2 services should not import it. Use `getOrRefreshToken()` / `forceRefreshToken()` as the public auth surface if they need to trigger a refresh outside a fetch call (rare).
- Pino redact paths already cover the PAT secret. Services can log request/response bodies freely — but NEVER `console.log` Pulse `insightBundles` (PII concern; plan 02-04 acceptance criteria grep-enforces this).
- Fastify `app.register()` pattern is the route-addition mechanism — but Phase 2 plans do NOT create any new routes. All three services are pure service modules under `backend/src/services/` called by Phase 3's `/context` route (which is a Phase 3 deliverable, not Phase 2).
- The Pulse REST API endpoint paths in `02-04-PLAN.md` are best-guess starting points (Tableau's Pulse REST surface evolves). The executor MUST verify the actual paths against the live sandbox during Task 1 and document corrections in `02-04-SUMMARY.md`. Because any 404 silently degrades to empty `PulseContext`, the SUMMARY must positively confirm at least one live run observed `hasMetrics: true` before declaring TAPI-07/08/09 verified.

**Next session should:**

1. Read this STATE.md (Session Continuity + Phase 2 Execution Inputs sections).
2. Read `.planning/phases/02-tableau-api-services/02-0{1..5}-PLAN.md`.
3. Have the EIA Prices datasource LUID ready to paste when the executor prompts.
4. Run `/gsd-execute-phase 2`.

---
*State initialized: 2026-04-10*
*Phase 1 completed: 2026-04-10*
*Phase 2 planned: 2026-04-11 (ready to execute)*
