# STATE: Aperture

**Last updated:** 2026-04-10 (initialization)

---

## Project Reference

**Core Value:** A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

**Current focus:** Project just initialized. Roadmap locked 1:1 to `aperture-spec.md`'s 5 phases. Ready to plan Phase 1 (Scaffold + Auth).

**Authoritative docs:**
- `aperture-spec.md` — technical spec (phases, stack, contracts)
- `CLAUDE.md` — ground rules and technical constraints
- `.planning/PROJECT.md` — project context
- `.planning/REQUIREMENTS.md` — 58 v1 requirements (mapped to 5 phases)
- `.planning/ROADMAP.md` — phase-by-phase goals and success criteria

---

## Current Position

**Milestone:** v1 demo
**Phase:** 1 — Scaffold + Auth (Not started)
**Plan:** None yet
**Status:** Ready for `/gsd-plan-phase 1`

**Progress:**
```
[.....] Phase 1: Scaffold + Auth           (0% — not started)
[.....] Phase 2: Tableau API Services      (0% — not started)
[.....] Phase 3: Context Assembler + Claude (0% — not started)
[.....] Phase 4: Extension UI               (0% — not started)
[.....] Phase 5: Polish + Docs              (0% — not started)
```

**Phases complete:** 0/5
**Requirements shipped:** 0/58

---

## Performance Metrics

| Metric | Target | Current |
|--------|--------|---------|
| Context assembly time (demo dataset) | < 3s | — |
| Narrative length | ≤ 3 paragraphs | — |
| Judge install-to-working-demo time | < 5 min | — |
| Phases complete | 5/5 | 0/5 |
| v1 requirements shipped | 58/58 | 0/58 |

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

### Open Todos

- [ ] Run `/gsd-plan-phase 1` to decompose Phase 1 (Scaffold + Auth) into executable plans.
- [ ] During Phase 1 planning, make and log the backend framework + hosting decision.

### Blockers

None.

---

## Session Continuity

**Last session:** 2026-04-10 — project initialized via `/gsd-new-project`. PROJECT.md, REQUIREMENTS.md, ROADMAP.md, STATE.md all written. Phase structure locked to spec.

**Next session should:**
1. Read `.planning/ROADMAP.md` (Phase 1 details) and `aperture-spec.md` (Phase 1 section).
2. Run `/gsd-plan-phase 1` to produce the Phase 1 execution plan.
3. First Phase 1 plan item: decide backend framework + hosting, log in PROJECT.md Key Decisions.

---
*State initialized: 2026-04-10*
