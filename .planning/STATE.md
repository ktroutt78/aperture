---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: planning
last_updated: "2026-04-10T23:17:44.793Z"
progress:
  total_phases: 5
  completed_phases: 1
  total_plans: 4
  completed_plans: 4
  percent: 100
---

# STATE: Aperture

**Last updated:** 2026-04-10 (Phase 1 complete — Plan 01-04 Tableau PAT auth shipped)

---

## Project Reference

**Core Value:** A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

**Current focus:** Phase 02 — Tableau API Services (next)

**Authoritative docs:**

- `aperture-spec.md` — technical spec (phases, stack, contracts)
- `CLAUDE.md` — ground rules and technical constraints
- `.planning/PROJECT.md` — project context
- `.planning/REQUIREMENTS.md` — 58 v1 requirements (mapped to 5 phases)
- `.planning/ROADMAP.md` — phase-by-phase goals and success criteria

---

## Current Position

Phase: 01 (Scaffold + Auth) — COMPLETE
Plan: 4 of 4
**Milestone:** v1 demo
**Phase:** 1 — Scaffold + Auth (Complete)
**Plan:** 01-04 (Tableau PAT auth) — Complete
**Status:** Phase 01 complete — ready for Phase 02 planning

**Progress:**

```
[██████████] Phase 1: Scaffold + Auth           (100% — complete)
[..........] Phase 2: Tableau API Services      (0% — not started)
[..........] Phase 3: Context Assembler + Claude (0% — not started)
[..........] Phase 4: Extension UI               (0% — not started)
[..........] Phase 5: Polish + Docs              (0% — not started)
```

**Phases complete:** 1/5
**Requirements shipped:** SCAF-01, SCAF-02, SCAF-03, SCAF-04, SCAF-05, SCAF-06, SCAF-07 (Phase 1 complete)

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

### Open Todos

- [x] ~~Run `/gsd-plan-phase 1` to decompose Phase 1 (Scaffold + Auth) into executable plans.~~ (Done — 4 plans executed)
- [x] ~~During Phase 1 planning, make and log the backend framework + hosting decision.~~ (Done — Plan 01-04 Task 3)
- [ ] User: populate `.env` with real Tableau Cloud PAT credentials and rerun `pnpm --filter @aperture/backend smoke:auth` to hard-verify SCAF-05 against the live sandbox.
- [ ] Run `/gsd-plan-phase 2` to decompose Phase 2 (Tableau API Services) into Metadata / VizQL / Pulse service plans.

### Blockers

None. Phase 1 is shippable. SCAF-05 live verification is deferred to user setup (non-blocking — the code path is implemented and smoke-tested on the expected empty-credential cold-boot path).

---

## Session Continuity

**Last session:** 2026-04-10 — Phase 1 completed. Plan 01-04 shipped Tableau PAT authentication pipeline (tokenCache singleton, authenticate() against REST API 3.19, tableauFetch wrapper with exactly-one 401 retry, smoke:auth script) plus logged Fastify 5 + Fly.io architecture decisions in PROJECT.md. Three atomic commits (`ba40b52`, `77225c3`, `0307016`) + SUMMARY.md.

**Next session should:**

1. Read `.planning/phases/01-scaffold-auth/01-04-SUMMARY.md` for Phase 1 wrap-up context.
2. Read `.planning/ROADMAP.md` Phase 2 section and `aperture-spec.md` Phase 2 section (three services: Metadata GraphQL, VizQL Data Service, Pulse REST).
3. Run `/gsd-plan-phase 2` to decompose Phase 2 into service-level plans.
4. Remind the user that Phase 2 verification requires real Tableau Cloud PAT credentials in `.env` — have them rerun `pnpm --filter @aperture/backend smoke:auth` to confirm live signin before starting Phase 2.

**Key context for Phase 2 planners:**

- `tableauFetch` is the single chokepoint. Metadata / VizQL / Pulse services each import `tableauFetch` from `backend/src/services/tableauFetch.js` and call it instead of native `fetch`. Never touch `X-Tableau-Auth` directly.
- `tokenCache` is private — Phase 2 services should not import it. Use `getOrRefreshToken()` / `forceRefreshToken()` as the public auth surface if they need to trigger a refresh outside a fetch call (rare).
- Pino redact paths already cover the PAT secret. Services can log request/response bodies freely.
- Fastify `app.register()` pattern is the route-addition mechanism. Each service gets its own route file under `backend/src/routes/`.

---
*State initialized: 2026-04-10*
*Phase 1 completed: 2026-04-10*
