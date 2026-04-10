# Aperture — Technical Spec

## What It Is

A Tableau Cloud Extension that embeds an AI co-pilot inside any published dashboard.
It fuses three Tableau APIs in parallel — Metadata API (schema + lineage), VizQL Data
Service (live data), and Pulse REST API (existing AI insights + user feedback) — merges
that context, and streams it through Claude to produce narrative intelligence, anomaly
detection, and guided follow-up questions without the user ever leaving Tableau.

When Claude identifies an anomaly, the extension highlights the relevant marks directly
in the Tableau viz behind it. Users can ask follow-up questions in a conversation thread,
click AI-generated suggested questions, and push the narrative to Slack in one click.

## Stack

- **Extension frontend:** React + TypeScript (Vite), Tableau Extensions API
- **Backend:** TypeScript — choose the best framework and hosting for the job
- **AI:** Anthropic SDK, model `claude-sonnet-4-20250514`, streaming
- **Tableau APIs:** Metadata API (GraphQL), VizQL Data Service (REST), Pulse REST API, Tableau REST API

## Repo Structure

```
aperture/
├── extension/          # Tableau Extension (React + TypeScript)
├── backend/            # API server
├── demo-data/          # Sample data setup instructions
├── docs/               # SETUP.md, JUDGING.md, ARCHITECTURE.md
├── PHASE_LOG.md
├── .env.example
└── README.md
```

## Environment Variables

```env
TABLEAU_SERVER_URL=https://{pod}.online.tableau.com
TABLEAU_SITE_NAME=
TABLEAU_PAT_NAME=
TABLEAU_PAT_SECRET=
ANTHROPIC_API_KEY=
SLACK_WEBHOOK_URL=
PORT=3001
EXTENSION_ORIGIN=http://localhost:5173
```

---

## Phases

Own all architecture decisions. Update `PHASE_LOG.md` at the end of every phase.
Do not ask questions — make decisions and build.

---

### Phase 1 — Scaffold + Auth
Stand up the monorepo, both apps, and prove Tableau Cloud auth works.

- Monorepo with workspaces
- Vite + React + TypeScript extension app
- TypeScript backend with a `/health` endpoint
- PAT auth against Tableau Cloud REST API with token caching and auto-refresh on 401
- `.env.example` with all required vars
- Stub `.trex` manifest file

**Done when:** backend starts, `/health` returns 200, auth call returns a valid Tableau token.

---

### Phase 2 — Tableau API Services
Three services, each independently testable.

**Metadata API (GraphQL)**
- Given datasource LUIDs → return fields with name, caption, dataType, description, upstream lineage
- Given workbook LUID → return worksheets and their connected datasources
- Output: `SchemaContext` type

**VizQL Data Service**
- Query published datasources programmatically via HTTP
- Support field selection, filters, max 500 rows
- Set `interpretFieldCaptionsAsFieldNames: true` on all requests
- Try SSE streaming (available 2026.1), fall back to JSON
- Output: `LiveDataContext` type

**Pulse REST API**
- Get metric definitions connected to a datasource
- Get AI-generated insight bundles per metric
- Get `InsightFeedbackMetadata` (thumbs up/down per insight type) — use this to weight
  which insights Claude emphasizes
- Output: `PulseContext` type
- Degrade gracefully if Pulse has no metrics for a datasource

**Done when:** each service has a test script that runs against the sandbox and prints a clean result.

---

### Phase 3 — Context Assembler + Claude

**Context Assembler**
- Input: `{ workbookName, worksheetName, datasourceLuids, selectedMarks, activeFilters }`
- Fan out to all 3 services with `Promise.all`
- Merge into single `CopilotContext` object
- Intelligent truncation if context exceeds ~80k tokens (priority: schema > pulse > data rows)

**System Prompt Builder**
- Dynamic prompt built from `CopilotContext`
- Claude must: reference actual field captions, build on Pulse insights without repeating them,
  flag anomalies as `[ANOMALY: fieldName="x" value="y"]`, end every response with
  `{"suggestions": ["...", "...", "..."]}`, keep narrative to 3 paragraphs max

**Claude Service**
- Streaming chat with conversation history
- Parse `[ANOMALY: ...]` tags from the stream as they arrive
- Parse `{"suggestions": [...]}` at end of stream
- Emit typed stream events: `token | anomaly | suggestions | done`

**Routes**
- `POST /context` — returns assembled `CopilotContext` (debug)
- `POST /chat` — assembles context, streams Claude response as SSE
- `POST /export/slack` — posts narrative to Slack webhook
- `POST /export/pdf` — fetches workbook PDF via Tableau REST API

**Done when:** `POST /chat` with a real datasource LUID returns a streamed, schema-aware
Claude response with 3 suggested questions.

---

### Phase 4 — Extension UI

**Dashboard listener**
- `initializeAsync()` on mount
- Listen for `MarkSelectionChanged` and `FilterChanged` events
- On each event: extract state, call `/chat`, stream response into the panel

**Co-pilot panel**
- Conversation thread with user messages and Claude narrative cards
- Streamed markdown rendering with anomaly highlights (amber) and positive signals (green)
- Suggested question chips — clicking sends the question to `/chat`
- `ContextBadge` showing which APIs fired and rows loaded
- Thumbs up/down, Push to Slack, Export PDF buttons

**Mark highlighter**
- Parse `[ANOMALY: ...]` tags from the stream
- Call `worksheet.selectMarksByValueAsync()` for each parsed anomaly
- This is the highest-impact demo interaction — make it reliable

**Manifest**
- `full data` permission + `tableau.extensions.datasources.get`
- Backend URL parameterized for dev vs prod

**Done when:** extension loads in the sandbox, mark selection triggers a Claude response,
suggested questions are clickable, mark highlighter fires on anomalies.

---

### Phase 5 — Polish + Docs

- Publish Superstore to the provisioned org, build a 4-worksheet demo workbook
- Create 2 Pulse metric definitions (Total Sales, Profit Ratio)
- Loading skeletons, graceful error states, responsive panel layout
- Deploy backend to a permanent public HTTPS URL
- Write `docs/SETUP.md`, `docs/JUDGING.md`, `docs/ARCHITECTURE.md`
- Update `README.md` with project summary, stack, and setup link
