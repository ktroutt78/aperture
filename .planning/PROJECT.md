# Aperture

## What This Is

Aperture is a Tableau Cloud Extension that embeds an AI analytics co-pilot inside any published dashboard. It fuses three Tableau APIs in parallel — Metadata API, VizQL Data Service, and Pulse REST API — merges that context, and streams it through Claude to produce narrative intelligence, anomaly detection, and guided follow-up questions without the user ever leaving Tableau. When Claude flags an anomaly, the extension highlights the relevant marks directly in the Tableau viz; users can push the narrative to Slack in one click.

## Core Value

A Tableau user sees streamed, schema-aware narrative intelligence (with anomaly tags that highlight marks in the viz) inside their dashboard within 3 seconds of selecting a mark or changing a filter — without leaving Tableau.

## Requirements

### Validated

<!-- Shipped and confirmed valuable. -->

(None yet — ship to validate)

### Active

<!-- Current scope. Building toward these. See REQUIREMENTS.md for detail. -->

- [ ] Monorepo scaffold with Vite+React extension, TypeScript backend, and Tableau Cloud PAT auth with token caching + auto-refresh
- [ ] Metadata API service producing `SchemaContext` (fields, captions, dataTypes, descriptions, lineage)
- [ ] VizQL Data Service producing `LiveDataContext` (field selection, filters, max 500 rows, `interpretFieldCaptionsAsFieldNames: true`, SSE with JSON fallback)
- [ ] Pulse REST API service producing `PulseContext` (metric definitions, insight bundles, `InsightFeedbackMetadata`) with graceful degradation
- [ ] Context Assembler merging all 3 services in parallel into a single `CopilotContext` with 80k-token intelligent truncation
- [ ] System Prompt Builder enforcing Claude output contract: field captions, anomaly tags, 3-paragraph narrative, suggestions JSON
- [ ] Claude Service: streaming chat with conversation history, typed stream events (`token | anomaly | suggestions | done`)
- [ ] Backend routes: `POST /context`, `POST /chat` (SSE), `POST /export/slack`, `POST /export/pdf`
- [ ] Tableau Extension dashboard listener: `initializeAsync()`, listens to `MarkSelectionChanged` + `FilterChanged`, calls `/chat`, streams into panel
- [ ] Co-pilot panel UI: conversation thread, streamed markdown with anomaly/positive highlights, suggested question chips, `ContextBadge`, thumbs up/down, Push to Slack, Export PDF
- [ ] Mark highlighter: parses `[ANOMALY: ...]` from the stream and fires `worksheet.selectMarksByValueAsync()` reliably (the highest-impact demo interaction)
- [ ] `.trex` manifest with `full data` permission, `tableau.extensions.datasources.get`, and parameterized backend URL
- [ ] Demo data: Superstore published, 4-worksheet demo workbook, 2 Pulse metric definitions (Total Sales, Profit Ratio)
- [ ] Production polish: loading skeletons, graceful error states, responsive panel layout
- [ ] Backend deployed to a permanent public HTTPS URL
- [ ] Docs: `SETUP.md`, `JUDGING.md`, `ARCHITECTURE.md`, `README.md`

### Out of Scope

<!-- Explicit boundaries. Includes reasoning to prevent re-adding. -->

- Non-Tableau-Cloud deployments (Server, Desktop) — spec targets Tableau Cloud DataDev sandbox org
- Models other than `claude-sonnet-4-20250514` — spec locks this model
- Non-streaming Claude responses — spec mandates streaming for UX
- Hardcoded secrets — everything through `.env`
- Datasources without `API Access` enabled — VizQL Data Service requires this per-datasource permission
- Custom auth schemes — PAT tokens only (4-hour expiry, auto-refresh on 401)

## Context

**Demo & judging context:** Aperture is being built as a Tableau DataDev hackathon-style entry. A judge with admin credentials must be able to install and test in under 5 minutes. The panel must feel native to Tableau — polished, not bolted on.

**Tableau environment:** Runs in the provisioned Tableau Cloud DataDev sandbox org. All three Tableau APIs (Metadata, VizQL Data Service, Pulse) share a single `X-Tableau-Auth` token obtained via PAT. PAT tokens expire after 4 hours and must auto-refresh on 401. VizQL Data Service requires `API Access` permission enabled per published datasource.

**Claude contract:** The model is `claude-sonnet-4-20250514` (streaming always). The system prompt is built dynamically from assembled context on every request. Claude must emit `[ANOMALY: fieldName="x" value="y"]` tags inline (parsed during stream to drive the mark highlighter) and end every response with `{"suggestions": ["...", "...", "..."]}` (parsed at end of stream for chips).

**UX principles:** Context assembles in under 3 seconds for the demo dataset. Narrative is executive-readable: 3 paragraphs max, specific field names, no filler. Mark highlighter is the highest-leverage demo interaction — make it fast and reliable.

**Graceful degradation:** If any Tableau API returns empty (especially Pulse without metrics for a datasource), never crash the panel — skip and note in UI.

## Constraints

- **Tech stack**: TypeScript monorepo — Vite + React extension frontend, TypeScript backend (framework decision owned during Phase 1), Anthropic SDK — locked by spec
- **Model**: `claude-sonnet-4-20250514` with streaming — locked by spec
- **Deployment**: Backend must be reachable over public HTTPS before end-to-end testing works — Tableau Extension requires HTTPS in production
- **Auth**: Tableau PAT only, 4-hour expiry, single token shared across Metadata / VizQL / Pulse
- **VizQL**: `interpretFieldCaptionsAsFieldNames: true` on every request; max 500 rows per query
- **Manifest**: `.trex` must declare `full data` permission and `tableau.extensions.datasources.get`
- **Secrets**: Everything through `.env` — never hardcoded
- **Environment**: Tableau Cloud DataDev sandbox org (no Server, no Desktop)
- **Performance**: Full context assembly < 3s for demo dataset; narrative ≤ 3 paragraphs
- **Setup**: Judge with admin credentials can install and test in under 5 minutes

## Key Decisions

<!-- Decisions that constrain future work. Add throughout project lifecycle. -->

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Map GSD roadmap 1:1 to the spec's 5 phases | Spec is authoritative; don't re-derive what's decided | — Pending |
| Coarse granularity in GSD config | Spec's 5 phases are broad; matches coarse profile (3-5 phases) | — Pending |
| Skip project-level research agents | aperture-spec.md already fixes stack, architecture, APIs, types | — Pending |
| Keep `plan_check` and `verifier` on | Spec has precise acceptance criteria worth verifying per phase | — Pending |
| Use `/ui-ux-pro-max` for all `extension/` work | CLAUDE.md ground rule; Tableau-native polish is a core value driver | — Pending |
| Backend framework deferred to Phase 1 | "Choose the best framework" per spec — architecture decision owned at scaffold time | — Pending |
| Auto-refresh Tableau PAT on 401 rather than timer-based refresh | 4-hour expiry is reliable but reactive refresh is simpler and safer | — Pending |
| `interpretFieldCaptionsAsFieldNames: true` on every VizQL request | Ensures Claude sees the same field names users see in the UI | — Pending |
| Context truncation priority: schema > pulse > data rows | Schema + existing AI insights are denser signal than raw rows | — Pending |
| **Backend framework: Fastify 5.x** (Phase 1, 2026-04-10) | TypeScript-first, pino logger built in, best-in-class SSE support for Phase 3 `/chat` streaming, rich plugin ecosystem (`@fastify/cors`, future SSE plugins), minimal boilerplate. Alternatives considered: Hono (newer, less battle-tested for our SSE streaming needs), Express (slower, no first-class TS, manual pino wiring). Installed in Plan 01-02; decision logged in Plan 01-04 per ROADMAP Phase 1 requirement and CLAUDE.md "Own all architecture decisions". | Locked — Phase 1 |
| **Backend hosting target: Fly.io** (Phase 1, 2026-04-10) | Supports long-lived SSE connections (critical for Phase 3 `/chat` streaming), public HTTPS + custom domains out of the box (Tableau Extension requirement), Node 20 runtime, first-class Docker support, generous free tier, simple `fly launch` / `fly deploy` workflow. Alternatives considered: Render (SSE connection limits on free tier), Railway (pricing unclear at scale), Vercel (serverless function 10s timeout incompatible with long-lived SSE streaming). Actual deployment happens in Phase 5; Phase 1 just locks the target so Phase 2/3 can design with it in mind. | Locked — Phase 1 |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-10 after initialization*
