# Requirements: Aperture

**Defined:** 2026-04-10
**Core Value:** A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

## v1 Requirements

Requirements for the initial demo release. All map directly to the 5 phases defined in `aperture-spec.md`.

### Scaffold

- [x] **SCAF-01**: Developer can run a TypeScript monorepo with workspaces for `extension/`, `backend/`, `demo-data/`, and `docs/`
- [x] **SCAF-02**: Developer can run the Vite + React + TypeScript extension app locally
- [x] **SCAF-03**: Developer can start the TypeScript backend and `GET /health` returns HTTP 200
- [x] **SCAF-04**: Backend exposes `.env.example` declaring all required vars (`TABLEAU_SERVER_URL`, `TABLEAU_SITE_NAME`, `TABLEAU_PAT_NAME`, `TABLEAU_PAT_SECRET`, `ANTHROPIC_API_KEY`, `SLACK_WEBHOOK_URL`, `PORT`, `EXTENSION_ORIGIN`)
- [x] **SCAF-05**: Backend authenticates against Tableau Cloud REST API with PAT and returns a valid `X-Tableau-Auth` token
- [x] **SCAF-06**: Backend caches the Tableau token and auto-refreshes on any 401 from a downstream Tableau API
- [x] **SCAF-07**: Repo contains a stub `.trex` manifest file that declares the extension

### Tableau Services

- [ ] **TAPI-01**: Metadata API service accepts datasource LUIDs and returns `SchemaContext` with field name, caption, dataType, description, and upstream lineage
- [ ] **TAPI-02**: Metadata API service accepts a workbook LUID and returns its worksheets with their connected datasource LUIDs
- [ ] **TAPI-03**: VizQL Data Service queries published datasources via HTTP with field selection, filters, and a 500-row maximum
- [ ] **TAPI-04**: Every VizQL Data Service request sets `interpretFieldCaptionsAsFieldNames: true`
- [ ] **TAPI-05**: VizQL Data Service attempts SSE streaming (2026.1+) and falls back to JSON when unavailable
- [ ] **TAPI-06**: VizQL Data Service returns a typed `LiveDataContext`
- [ ] **TAPI-07**: Pulse service returns metric definitions connected to a given datasource
- [ ] **TAPI-08**: Pulse service returns AI-generated insight bundles per metric
- [ ] **TAPI-09**: Pulse service returns `InsightFeedbackMetadata` (thumbs up/down per insight type) weighting signals
- [ ] **TAPI-10**: Pulse service degrades gracefully when no metrics exist for a datasource (returns empty `PulseContext`, no crash)
- [ ] **TAPI-11**: Each Tableau service has a runnable test script that executes against the sandbox and prints a clean result

### Context Assembler & Claude

- [ ] **CTX-01**: Context Assembler accepts `{ workbookName, worksheetName, datasourceLuids, selectedMarks, activeFilters }` and fans out to all 3 Tableau services in parallel with `Promise.all`
- [ ] **CTX-02**: Context Assembler merges the three service outputs into a single typed `CopilotContext` object
- [ ] **CTX-03**: Context Assembler performs intelligent truncation when context exceeds ~80k tokens using priority schema > pulse > data rows
- [ ] **CTX-04**: System Prompt Builder produces a prompt dynamically from a `CopilotContext` on every request
- [ ] **CTX-05**: Claude responses reference actual field captions from the `SchemaContext`
- [ ] **CTX-06**: Claude responses build on Pulse insights without repeating them verbatim
- [ ] **CTX-07**: Claude responses flag anomalies inline as `[ANOMALY: fieldName="x" value="y"]`
- [ ] **CTX-08**: Claude responses end with `{"suggestions": ["...", "...", "..."]}`
- [ ] **CTX-09**: Claude responses are ≤ 3 paragraphs
- [ ] **CTX-10**: Claude Service streams chat with conversation history using `claude-sonnet-4-20250514`
- [ ] **CTX-11**: Claude Service parses `[ANOMALY: ...]` tags from the stream as tokens arrive
- [ ] **CTX-12**: Claude Service parses `{"suggestions": [...]}` at end of stream
- [ ] **CTX-13**: Claude Service emits typed stream events: `token | anomaly | suggestions | done`
- [ ] **CTX-14**: Backend exposes `POST /context` that returns assembled `CopilotContext` (debug endpoint)
- [ ] **CTX-15**: Backend exposes `POST /chat` that assembles context and streams the Claude response as SSE
- [ ] **CTX-16**: Backend exposes `POST /export/slack` that posts the narrative to the configured Slack webhook
- [ ] **CTX-17**: Backend exposes `POST /export/pdf` that fetches the workbook PDF via Tableau REST API

### Extension UI

- [ ] **UI-01**: Extension calls `initializeAsync()` on mount and registers the dashboard object model
- [ ] **UI-02**: Extension listens for `MarkSelectionChanged` events on every worksheet
- [ ] **UI-03**: Extension listens for `FilterChanged` events on every worksheet
- [ ] **UI-04**: On each dashboard event, extension extracts current state, calls `POST /chat`, and streams the response into the panel
- [ ] **UI-05**: Co-pilot panel renders a conversation thread with user messages and Claude narrative cards
- [ ] **UI-06**: Claude narrative cards render streamed markdown with anomaly highlights (amber) and positive signals (green)
- [ ] **UI-07**: Suggested question chips render from parsed `suggestions` and send the question to `/chat` when clicked
- [ ] **UI-08**: `ContextBadge` shows which APIs fired (Metadata / VizQL / Pulse) and how many rows were loaded
- [ ] **UI-09**: Panel shows thumbs up / thumbs down feedback controls per narrative
- [ ] **UI-10**: Panel shows a "Push to Slack" button that calls `/export/slack`
- [ ] **UI-11**: Panel shows an "Export PDF" button that calls `/export/pdf`
- [ ] **UI-12**: Mark highlighter parses `[ANOMALY: ...]` tags from the stream and calls `worksheet.selectMarksByValueAsync()` for each parsed anomaly, reliably
- [ ] **UI-13**: `.trex` manifest declares `full data` permission and `tableau.extensions.datasources.get`
- [ ] **UI-14**: `.trex` manifest parameterizes the backend URL for dev vs prod

### Polish & Docs

- [ ] **POL-01**: Superstore is published to the provisioned Tableau Cloud DataDev org with a 4-worksheet demo workbook
- [ ] **POL-02**: Two Pulse metric definitions (Total Sales, Profit Ratio) are created against the demo datasource
- [ ] **POL-03**: Panel shows loading skeletons during context assembly and streaming
- [ ] **POL-04**: Panel shows graceful error states for every failure path (auth fail, empty APIs, Claude errors)
- [ ] **POL-05**: Panel layout is responsive to dashboard resize
- [ ] **POL-06**: Backend is deployed to a permanent public HTTPS URL
- [ ] **POL-07**: `docs/SETUP.md` walks a new developer through full local setup
- [ ] **POL-08**: `docs/JUDGING.md` lets a judge install and test the extension in under 5 minutes
- [ ] **POL-09**: `docs/ARCHITECTURE.md` explains the 3-API fusion, context assembler, and Claude contract
- [ ] **POL-10**: `README.md` contains project summary, stack, and a link to `docs/SETUP.md`

## v2 Requirements

Deferred post-demo.

### Experience

- **V2-01**: Multi-turn context refinement across panels
- **V2-02**: Custom anomaly sensitivity thresholds per datasource
- **V2-03**: Per-user insight memory across sessions

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Tableau Server / Desktop support | Spec targets Tableau Cloud DataDev sandbox only |
| Non-streaming Claude responses | Spec mandates streaming for UX |
| Claude models other than `claude-sonnet-4-20250514` | Locked by spec |
| Hardcoded secrets | All credentials via `.env` (ground rule) |
| Custom auth schemes beyond PAT | Single shared `X-Tableau-Auth` token across all three APIs |
| Datasources without `API Access` enabled | Hard Tableau Cloud constraint for VizQL Data Service |
| Row counts above 500 per VizQL query | Hard spec cap |

## Traceability

Populated during roadmap creation. Each requirement maps to exactly one phase.

| Requirement | Phase | Status |
|-------------|-------|--------|
| SCAF-01 | Phase 1 | Complete |
| SCAF-02 | Phase 1 | Complete |
| SCAF-03 | Phase 1 | Complete |
| SCAF-04 | Phase 1 | Complete |
| SCAF-05 | Phase 1 | Complete |
| SCAF-06 | Phase 1 | Complete |
| SCAF-07 | Phase 1 | Complete |
| TAPI-01 | Phase 2 | Pending |
| TAPI-02 | Phase 2 | Pending |
| TAPI-03 | Phase 2 | Pending |
| TAPI-04 | Phase 2 | Pending |
| TAPI-05 | Phase 2 | Pending |
| TAPI-06 | Phase 2 | Pending |
| TAPI-07 | Phase 2 | Pending |
| TAPI-08 | Phase 2 | Pending |
| TAPI-09 | Phase 2 | Pending |
| TAPI-10 | Phase 2 | Pending |
| TAPI-11 | Phase 2 | Pending |
| CTX-01 | Phase 3 | Pending |
| CTX-02 | Phase 3 | Pending |
| CTX-03 | Phase 3 | Pending |
| CTX-04 | Phase 3 | Pending |
| CTX-05 | Phase 3 | Pending |
| CTX-06 | Phase 3 | Pending |
| CTX-07 | Phase 3 | Pending |
| CTX-08 | Phase 3 | Pending |
| CTX-09 | Phase 3 | Pending |
| CTX-10 | Phase 3 | Pending |
| CTX-11 | Phase 3 | Pending |
| CTX-12 | Phase 3 | Pending |
| CTX-13 | Phase 3 | Pending |
| CTX-14 | Phase 3 | Pending |
| CTX-15 | Phase 3 | Pending |
| CTX-16 | Phase 3 | Pending |
| CTX-17 | Phase 3 | Pending |
| UI-01 | Phase 4 | Pending |
| UI-02 | Phase 4 | Pending |
| UI-03 | Phase 4 | Pending |
| UI-04 | Phase 4 | Pending |
| UI-05 | Phase 4 | Pending |
| UI-06 | Phase 4 | Pending |
| UI-07 | Phase 4 | Pending |
| UI-08 | Phase 4 | Pending |
| UI-09 | Phase 4 | Pending |
| UI-10 | Phase 4 | Pending |
| UI-11 | Phase 4 | Pending |
| UI-12 | Phase 4 | Pending |
| UI-13 | Phase 4 | Pending |
| UI-14 | Phase 4 | Pending |
| POL-01 | Phase 5 | Pending |
| POL-02 | Phase 5 | Pending |
| POL-03 | Phase 5 | Pending |
| POL-04 | Phase 5 | Pending |
| POL-05 | Phase 5 | Pending |
| POL-06 | Phase 5 | Pending |
| POL-07 | Phase 5 | Pending |
| POL-08 | Phase 5 | Pending |
| POL-09 | Phase 5 | Pending |
| POL-10 | Phase 5 | Pending |

**Coverage:**
- v1 requirements: 58 total
- Mapped to phases: 58
- Unmapped: 0 ✓

---
*Requirements defined: 2026-04-10*
*Last updated: 2026-04-10 after initialization*
