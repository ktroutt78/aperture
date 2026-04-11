# Roadmap: Aperture

**Created:** 2026-04-10
**Granularity:** Coarse (5 phases, locked 1:1 to `aperture-spec.md`)
**Coverage:** 58/58 v1 requirements mapped
**Core Value:** A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

---

## Phases

- [ ] **Phase 1: Scaffold + Auth** — Stand up the monorepo, both apps, and prove Tableau Cloud PAT auth works end-to-end
- [ ] **Phase 2: Tableau API Services** — Metadata API, VizQL Data Service, and Pulse REST API as three independently testable services
- [ ] **Phase 3: Context Assembler + Claude** — Fuse the three services in parallel, build dynamic prompts, and stream Claude responses through backend routes
- [ ] **Phase 4: Extension UI** — Dashboard listener, co-pilot panel, mark highlighter, and `.trex` manifest wired to the backend
- [ ] **Phase 5: Polish + Docs** — Demo data, loading/error states, public HTTPS deploy, and judging-ready documentation

---

## Phase Details

### Phase 1: Scaffold + Auth
**Goal**: Backend starts, `/health` returns 200, and a PAT auth call returns a valid Tableau token that the backend caches and auto-refreshes on 401.
**Depends on**: Nothing (first phase)
**Requirements**: SCAF-01, SCAF-02, SCAF-03, SCAF-04, SCAF-05, SCAF-06, SCAF-07
**Success Criteria** (what must be TRUE):
  1. Developer can clone the repo, install deps, and run the Vite + React extension app and the TypeScript backend from a single monorepo with workspaces (`extension/`, `backend/`, `demo-data/`, `docs/`).
  2. `GET /health` on the running backend returns HTTP 200.
  3. Backend authenticates against Tableau Cloud REST API using PAT credentials from `.env` and obtains a valid `X-Tableau-Auth` token.
  4. When a downstream Tableau call returns 401, the backend transparently re-authenticates and retries without bubbling the 401 to callers.
  5. Repo contains `.env.example` declaring every required var and a stub `.trex` manifest file for the extension.

**Architecture decision owned here**: choose the TypeScript backend framework and hosting target. Spec says "choose the best framework and hosting for the job" — log the decision in PROJECT.md Key Decisions before leaving Phase 1.

**Plans**: 4 plans
- [x] 01-01-PLAN.md — Monorepo foundation (pnpm workspaces, shared tsconfig, .env.example, .gitignore)
- [x] 01-02-PLAN.md — Fastify backend skeleton + /health endpoint + CORS + env loader
- [x] 01-03-PLAN.md — Vite + React + TS extension app + stub .trex manifest
- [x] 01-04-PLAN.md — Tableau PAT auth + token cache + tableauFetch 401-retry + architecture decision log
**UI hint**: no

---

### Phase 2: Tableau API Services
**Goal**: Three Tableau API services — Metadata, VizQL Data Service, Pulse — each independently testable against the sandbox, each producing its typed context object.
**Depends on**: Phase 1 (shared `X-Tableau-Auth` token, backend framework)
**Requirements**: TAPI-01, TAPI-02, TAPI-03, TAPI-04, TAPI-05, TAPI-06, TAPI-07, TAPI-08, TAPI-09, TAPI-10, TAPI-11
**Success Criteria** (what must be TRUE):
  1. Running the Metadata service test script against the sandbox prints a populated `SchemaContext` (fields with name, caption, dataType, description, upstream lineage) for a given datasource LUID, and returns worksheets + connected datasources for a given workbook LUID.
  2. Running the VizQL Data Service test script returns a populated `LiveDataContext` with field selection + filters honored, at most 500 rows, and `interpretFieldCaptionsAsFieldNames: true` set on the request — with SSE attempted first (2026.1+) and JSON fallback verified.
  3. Running the Pulse service test script returns `PulseContext` containing metric definitions, AI insight bundles, and `InsightFeedbackMetadata` for a datasource that has Pulse metrics.
  4. When Pulse is called against a datasource with no metrics, the service returns an empty `PulseContext` and the calling code does not crash (graceful degradation — this is a hard ground rule).

**Critical call-outs**:
- Every VizQL request must set `interpretFieldCaptionsAsFieldNames: true` so Claude sees the same field names users see in the UI.
- Pulse must degrade gracefully on empty metrics — never crash the panel. This is a shared invariant for every downstream phase.

**Plans**: 5 plans
- [x] 02-01-PLAN.md — Shared Phase 2 typed context module (SchemaContext / LiveDataContext / PulseContext)
- [x] 02-02-PLAN.md — Metadata API GraphQL service (TAPI-01, TAPI-02) + smoke test
- [x] 02-03-PLAN.md — VizQL Data Service with SSE-first / JSON-fallback (TAPI-03, TAPI-04, TAPI-05) + smoke test
- [x] 02-04-PLAN.md — Pulse REST service with graceful empty-metrics degradation (TAPI-07, TAPI-08, TAPI-09, TAPI-10) + offline unit test + live smoke
- [x] 02-05-PLAN.md — Phase 2 verification harness + package.json smoke:* script wiring (TAPI-11)
**UI hint**: no

---

### Phase 3: Context Assembler + Claude
**Goal**: `POST /chat` with a real datasource LUID returns a streamed, schema-aware Claude response with anomaly tags and 3 suggested questions.
**Depends on**: Phase 2 (the three Tableau services must produce typed context)
**Requirements**: CTX-01, CTX-02, CTX-03, CTX-04, CTX-05, CTX-06, CTX-07, CTX-08, CTX-09, CTX-10, CTX-11, CTX-12, CTX-13, CTX-14, CTX-15, CTX-16, CTX-17
**Success Criteria** (what must be TRUE):
  1. Calling `POST /context` with `{ workbookName, worksheetName, datasourceLuids, selectedMarks, activeFilters }` returns a single typed `CopilotContext` object assembled by fanning out to all three Tableau services in parallel via `Promise.all`.
  2. When assembled context exceeds ~80k tokens, the Context Assembler truncates using the priority order **schema > pulse > data rows** and still returns a valid `CopilotContext`.
  3. Calling `POST /chat` streams a `claude-sonnet-4-20250514` response as SSE whose narrative (a) references actual field captions from the `SchemaContext`, (b) builds on Pulse insights without repeating them verbatim, and (c) is 3 paragraphs or fewer.
  4. The `/chat` stream emits typed events `token | anomaly | suggestions | done`, with `[ANOMALY: fieldName="x" value="y"]` tags parsed inline as tokens arrive and `{"suggestions": ["...", "...", "..."]}` parsed at end of stream.
  5. `POST /export/slack` posts the assembled narrative to the configured Slack webhook, and `POST /export/pdf` fetches the workbook PDF via the Tableau REST API.

**Output contract enforced by the System Prompt Builder**: inline `[ANOMALY: fieldName="x" value="y"]` tags for the mark highlighter, trailing `{"suggestions": [...]}` for the chip UI, ≤ 3 paragraphs, references real field captions. This contract is load-bearing for Phase 4 and must not regress.

**Plans**: TBD
**UI hint**: no

---

### Phase 4: Extension UI
**Goal**: Extension loads in the Tableau Cloud sandbox, mark selection triggers a streamed Claude response in the panel, suggested questions are clickable, and the mark highlighter fires reliably on parsed anomalies.
**Depends on**: Phase 3 (backend `/chat` SSE contract)
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06, UI-07, UI-08, UI-09, UI-10, UI-11, UI-12, UI-13, UI-14
**Success Criteria** (what must be TRUE):
  1. Extension installed in the sandbox calls `initializeAsync()` on mount and registers listeners for `MarkSelectionChanged` and `FilterChanged` on every worksheet in the dashboard.
  2. When a user selects a mark or changes a filter, the extension calls `POST /chat`, streams the response into the co-pilot panel, and renders markdown with amber anomaly highlights and green positive-signal highlights as tokens arrive.
  3. Parsed `[ANOMALY: ...]` tags trigger `worksheet.selectMarksByValueAsync()` for each anomaly, reliably highlighting the corresponding marks in the underlying Tableau viz — this is the highest-impact demo interaction, verified end-to-end.
  4. Clicking a suggested question chip sends that question to `/chat` and streams the follow-up response into the same conversation thread; `ContextBadge` shows which APIs fired and how many rows were loaded; thumbs up/down, Push to Slack, and Export PDF buttons all fire their backend routes.
  5. `.trex` manifest declares `full data` permission and `tableau.extensions.datasources.get`, and parameterizes the backend URL for dev vs prod.

**Critical call-out**: the mark highlighter (`worksheet.selectMarksByValueAsync()` driven by stream-parsed `[ANOMALY: ...]` tags) is the highest-impact demo interaction per CLAUDE.md ground rules. Make it fast and reliable — judging hinges on it.

**Plans**: TBD
**UI hint**: yes

---

### Phase 5: Polish + Docs
**Goal**: A judge with admin credentials can install Aperture and test it end-to-end in under 5 minutes against the provisioned sandbox, with polished UI states and deployed backend.
**Depends on**: Phase 4 (working extension) and a public HTTPS backend
**Requirements**: POL-01, POL-02, POL-03, POL-04, POL-05, POL-06, POL-07, POL-08, POL-09, POL-10
**Success Criteria** (what must be TRUE):
  1. Superstore is published to the provisioned Tableau Cloud DataDev org with a 4-worksheet demo workbook, and two Pulse metric definitions (Total Sales, Profit Ratio) are live against the demo datasource.
  2. Panel shows loading skeletons during context assembly and streaming, and graceful error states for every failure path (auth failure, empty Tableau APIs, Claude errors) — panel never crashes.
  3. Panel layout remains legible and usable as the containing dashboard is resized.
  4. Backend is deployed to a permanent public HTTPS URL that the `.trex` production config points at, and the extension loads end-to-end from that deployed URL.
  5. A judge reading `docs/JUDGING.md` can install the extension in the sandbox and watch a streamed Claude response with working mark highlighting in **under 5 minutes**; `docs/SETUP.md`, `docs/ARCHITECTURE.md`, and `README.md` cover local setup, the 3-API fusion architecture, and project summary respectively.

**Plans**: TBD
**UI hint**: yes

---

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Scaffold + Auth | 0/4 | Planned | - |
| 2. Tableau API Services | 0/0 | Not started | - |
| 3. Context Assembler + Claude | 0/0 | Not started | - |
| 4. Extension UI | 0/0 | Not started | - |
| 5. Polish + Docs | 0/0 | Not started | - |

## Coverage Validation

| Category | Requirements | Phase |
|----------|--------------|-------|
| Scaffold | SCAF-01..07 (7) | Phase 1 |
| Tableau Services | TAPI-01..11 (11) | Phase 2 |
| Context & Claude | CTX-01..17 (17) | Phase 3 |
| Extension UI | UI-01..14 (14) | Phase 4 |
| Polish & Docs | POL-01..10 (10) | Phase 5 |

**Total:** 58/58 v1 requirements mapped. No orphans. No duplicates. Matches `REQUIREMENTS.md#Traceability` exactly.

---
*Roadmap created: 2026-04-10*
*Phase structure locked to `aperture-spec.md` — do not re-derive.*
