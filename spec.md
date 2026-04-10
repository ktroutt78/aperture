# Tableau Dashboard Co-Pilot — Technical Spec

## What We're Building

A Tableau Cloud Extension that embeds an AI-powered analytics co-pilot inside any published
Tableau dashboard. The co-pilot fuses three Tableau APIs simultaneously — Metadata API,
VizQL Data Service, and Pulse REST API — merges that context, and sends it to Claude to
produce cross-metric narrative intelligence, anomaly explanations, and guided follow-up
questions, all without leaving Tableau.

This is not a chatbot that answers isolated data questions. It is a persistent,
dashboard-aware co-pilot that understands relationships between metrics across an
entire workbook.

---

## Repository Structure

Monorepo. Use npm or pnpm workspaces — your choice.

```
tableau-copilot/
├── extension/                        # Tableau Extension (React + TypeScript)
│   ├── src/
│   │   ├── components/
│   │   │   ├── CopilotPanel.tsx      # Main side panel UI
│   │   │   ├── NarrativeCard.tsx     # Streamed Claude response renderer
│   │   │   ├── SuggestedQuestions.tsx
│   │   │   ├── ContextBadge.tsx      # Shows which APIs fired + data loaded
│   │   │   └── FeedbackButtons.tsx   # Thumbs up/down, push to Slack, export PDF
│   │   ├── hooks/
│   │   │   ├── useTableauContext.ts  # Extensions API listener
│   │   │   └── useCopilot.ts        # Backend communication + streaming
│   │   ├── lib/
│   │   │   └── tableau.ts           # Extensions API helpers
│   │   └── App.tsx
│   ├── public/
│   │   └── tableau-copilot.trex     # Extension manifest
│   └── package.json
│
├── backend/
│   ├── src/
│   │   ├── routes/
│   │   │   ├── context.ts           # POST /context — assemble context payload
│   │   │   ├── chat.ts              # POST /chat — streaming Claude response
│   │   │   └── export.ts            # POST /export — Slack + PDF
│   │   ├── services/
│   │   │   ├── metadataService.ts   # Tableau Metadata API (GraphQL)
│   │   │   ├── vizqlService.ts      # VizQL Data Service
│   │   │   ├── pulseService.ts      # Pulse REST API
│   │   │   ├── claudeService.ts     # Anthropic API streaming
│   │   │   ├── slackService.ts      # Slack webhook
│   │   │   └── tableauRestService.ts
│   │   ├── lib/
│   │   │   ├── tableauAuth.ts       # PAT auth + token management
│   │   │   ├── contextAssembler.ts  # Merges all 3 API payloads
│   │   │   └── systemPrompt.ts      # Dynamic Claude system prompt builder
│   │   └── index.ts
│   └── package.json
│
├── demo-data/
│   └── README.md
├── docs/
│   ├── SETUP.md
│   ├── JUDGING.md
│   └── ARCHITECTURE.md
├── PHASE_LOG.md
├── .env.example
└── README.md
```

---

## Environment Variables

```env
# Tableau Cloud
TABLEAU_SERVER_URL=https://{pod}.online.tableau.com
TABLEAU_SITE_NAME={site-name}
TABLEAU_PAT_NAME={pat-name}
TABLEAU_PAT_SECRET={pat-secret}

# Anthropic
ANTHROPIC_API_KEY={key}

# Slack
SLACK_WEBHOOK_URL={webhook-url}

# Server
PORT=3001
EXTENSION_ORIGIN=http://localhost:5173
```

---

## Phase 1 — Scaffold + Auth

**Goal:** Working monorepo with Tableau authentication flowing end to end.

1. Initialize monorepo with workspaces
2. Scaffold `extension/` as Vite + React + TypeScript
3. Scaffold `backend/` as a TypeScript server — choose Express, Fastify, or Hono
4. Implement `tableauAuth.ts`
   - `POST /api/{version}/auth/signin` with PAT credentials
   - Token caching with expiry (tokens expire after 4 hours)
   - Auto-refresh on 401
5. Implement `tableauRestService.ts` — thin authenticated REST wrapper
6. Create `.env.example`
7. Create `tableau-copilot.trex` manifest (stub — full permissions in Phase 4)
8. `GET /health` returns 200

**Done when:** backend starts, auth call to Tableau Cloud succeeds and returns a valid token.

---

## Phase 2 — Tableau API Services

**Goal:** All three Tableau APIs queryable and returning typed data.

### 2a — Metadata API (GraphQL)

Implement `metadataService.ts`.

- Endpoint: `https://{pod}.online.tableau.com/api/metadata/graphql`
- Auth: `X-Tableau-Auth` header with PAT token
- Query 1: given datasource LUIDs, return fields with `name`, `caption`, `dataType`,
  `description`, `isHidden`, `upstreamColumns`, `upstreamDatabases`
- Query 2: given a workbook LUID, return all worksheets and their connected datasources
- Output type: `SchemaContext`

```typescript
interface SchemaContext {
  workbookName: string;
  worksheets: {
    name: string;
    datasources: {
      luid: string;
      name: string;
      fields: {
        name: string;
        caption: string;
        dataType: string;
        description?: string;
        upstreamTable?: string;
      }[];
    }[];
  }[];
}
```

### 2b — VizQL Data Service

Implement `vizqlService.ts`.

- Endpoint: `https://{pod}.online.tableau.com/api/v1/vizql-data-service/query-datasource`
- Auth: same `X-Tableau-Auth` token
- `queryDatasource(datasourceLuid, fields, filters, maxRows = 500)` — POST query
- `getDatasourceMetadata(datasourceLuid)` — returns field list with `defaultAggregation`
- Set `interpretFieldCaptionsAsFieldNames: true` in all requests
- Set `bypassMetadataCache: false` by default, expose as param
- Support SSE streaming (`returnServerSentEvents: true`) with fallback to JSON
- Cap rows at 500 to keep Claude context manageable
- Output type: `LiveDataContext`

```typescript
interface LiveDataContext {
  datasourceLuid: string;
  fields: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
```

### 2c — Pulse REST API

Implement `pulseService.ts`.

- Base: `https://{pod}.online.tableau.com/api/3.26/sites/{siteId}/pulse/`
- `getMetricDefinitions(datasourceLuid)` — metric definitions connected to this datasource
- `getInsightsForMetric(metricLuid)` — AI-generated insights bundle
- `getInsightFeedback(metricLuid)` — `InsightFeedbackMetadata` (thumbs up/down per insight type)
- Output type: `PulseContext`

```typescript
interface PulseContext {
  metrics: {
    luid: string;
    name: string;
    insights: {
      type: string;
      text: string;
      feedbackScore: number; // derived from thumbs up/down ratio, 0–1
    }[];
  }[];
}
```

**Done when:** each service has a standalone test script in `backend/src/tests/` that
runs against the sandbox and prints a formatted result. All three pass.

---

## Phase 3 — Context Assembler + Claude Integration

**Goal:** Full pipeline from dashboard state → assembled context → streamed Claude response.

### 3a — Context Assembler

Implement `contextAssembler.ts`.

Input:
```typescript
interface DashboardState {
  workbookName: string;
  worksheetName: string;
  datasourceLuids: string[];
  selectedMarks: Record<string, unknown>[];
  activeFilters: { field: string; values: string[] }[];
}
```

- Fan out to all 3 services in parallel with `Promise.all`
- Merge into a single `CopilotContext` object:

```typescript
interface CopilotContext {
  schema: SchemaContext;
  liveData: LiveDataContext;
  pulseInsights: PulseContext;
  dashboardState: DashboardState;
}
```

- Implement intelligent truncation if total context exceeds ~80k tokens
- Truncation priority: schema first > pulse insights > live data sample rows

### 3b — System Prompt Builder

Implement `systemPrompt.ts`. Build a dynamic system prompt from `CopilotContext`.

The prompt must instruct Claude to:
- Act as a data analytics co-pilot embedded in Tableau — concise, executive-readable
- Reference actual field captions from the schema when discussing data
- Acknowledge any Pulse insights and build on them — never repeat them verbatim
- Identify anomalies and mark them with this exact tag so the UI can parse them:
  `[ANOMALY: fieldName="Region" value="West"]`
- End every response with exactly this JSON block (no exceptions):
  `{"suggestions": ["question 1", "question 2", "question 3"]}`
- Confidence prefix on definitive statements: `[HIGH]`, `[MEDIUM]`, or `[LOW]`
- Max 3 paragraphs for the main narrative — brevity is a feature

### 3c — Claude Service

Implement `claudeService.ts` using `@anthropic-ai/sdk`.

- Model: `claude-sonnet-4-20250514`
- Streaming chat with conversation history
- Parse `[ANOMALY: ...]` tags from the response stream as they arrive
- Parse `{"suggestions": [...]}` block at end of stream
- Expose: `streamChat(context, conversationHistory, userMessage): AsyncIterable<StreamEvent>`

```typescript
type StreamEvent =
  | { type: 'token'; content: string }
  | { type: 'anomaly'; fieldName: string; value: string }
  | { type: 'suggestions'; items: string[] }
  | { type: 'done' };
```

### 3d — Backend Routes

**POST /context**
- Body: `DashboardState`
- Returns: `CopilotContext` (for debugging/testing)

**POST /chat**
- Body: `{ dashboardState: DashboardState, conversationHistory: Message[], userMessage: string }`
- Assembles context, streams Claude response as SSE
- SSE event format:
  ```
  data: {"type":"token","content":"Sales in the West region..."}
  data: {"type":"anomaly","fieldName":"Region","value":"West"}
  data: {"type":"suggestions","items":["Why is West down?","..."]}
  data: {"type":"done"}
  ```

**POST /export/slack**
- Body: `{ narrative: string, dashboardImageUrl?: string }`
- Posts to `SLACK_WEBHOOK_URL`

**POST /export/pdf**
- Calls Tableau REST API `GET /sites/{siteId}/workbooks/{workbookId}/pdf`
- Returns PDF binary

**Done when:** `POST /chat` with a real Superstore datasource LUID returns a streamed
Claude response with schema-aware narrative and 3 suggested questions.

---

## Phase 4 — Tableau Extension UI

**Goal:** Full co-pilot panel running inside a Tableau Cloud dashboard.

### 4a — Extensions API Integration

Implement `useTableauContext.ts` hook.

- Call `tableau.extensions.initializeAsync()` on mount
- Extract workbook name, active worksheet, datasource LUIDs
- Register `TableauEventType.MarkSelectionChanged` listener on the active worksheet
- Register `TableauEventType.FilterChanged` listener
- On each event: extract current state, call backend `/chat`, stream response
- Extension library: `https://online.tableau.com/javascripts/api/tableau.extensions.1.latest.js`

### 4b — Co-pilot Panel

Implement `CopilotPanel.tsx`.

Layout:
- Conversation thread (user messages + Claude narrative cards) — scrollable, fills height
- Text input + send button — pinned to bottom
- `ContextBadge` — top right corner, shows which APIs fired and how many rows loaded

**NarrativeCard.tsx**
- Renders streamed markdown
- Anomaly phrases highlighted in amber
- Positive signals highlighted in green
- Confidence badge (`[HIGH]` / `[MEDIUM]` / `[LOW]`) rendered as a colored pill
- Skeleton loading state while streaming

**SuggestedQuestions.tsx**
- Parses `{"suggestions": [...]}` from Claude's stream
- Renders as clickable chips
- Clicking a chip sends it as a user message to `/chat`

**FeedbackButtons.tsx**
- Thumbs up / thumbs down
- "Push to Slack" → calls `POST /export/slack`
- "Export PDF" → calls `POST /export/pdf`

### 4c — Mark Highlighter

Parse `[ANOMALY: fieldName="..." value="..."]` tags from the response stream.

For each tag:
```typescript
await worksheet.selectMarksByValueAsync(
  [{ fieldName: parsedFieldName, value: parsedValue }],
  SelectionUpdateType.Replace
);
```

This is the highest-impact interaction in the demo. Make it reliable and fast.

### 4d — Extension Manifest

Complete `tableau-copilot.trex` with:
- `full data` permission
- `tableau.extensions.datasources.get` permission
- Correct backend URL (parameterized for dev vs prod)

**Done when:** extension loads in the Tableau Cloud sandbox, selecting marks triggers
a Claude response in the panel, suggested questions are clickable, mark highlighter fires.

---

## Phase 5 — Demo Data + Polish

**Goal:** Compelling, reliable demo environment on the DataDev sandbox.

1. Publish Superstore (or a richer dataset) to the provisioned org
2. Create a demo workbook with 4 worksheets:
   - Sales over time (line chart)
   - Sales by Region + Category (bar chart)
   - Profitability scatter
   - Map view
3. Create Pulse metric definitions for Total Sales and Profit Ratio so the Pulse
   API layer has real data
4. Loading states: skeleton cards while context assembles
5. Error states: helpful messages if any API fails (degrade gracefully — show
   what's available rather than a blank panel)
6. Context assembly target: under 3 seconds for the demo dataset
7. Responsive layout for different extension panel sizes

---

## Phase 6 — Docs + Judging Package

**Goal:** Judges can install, test, and understand the project without asking any questions.

1. Deploy backend to a permanent public HTTPS URL
2. Publish extension to provisioned org
3. Write `docs/SETUP.md` — full install instructions
4. Write `docs/JUDGING.md`:
   - Provisioned org URL
   - Admin credentials (placeholder — user fills before submission)
   - Which workbook to open
   - What to interact with and what to expect
   - Which APIs are being called and why
5. Write `docs/ARCHITECTURE.md` — data flow diagram (ASCII or Mermaid) + API usage summary
6. Populate `README.md` with project summary, tech stack, and setup link

---

## PHASE_LOG.md

Maintain this file throughout the build. Update at the end of every phase.

```markdown
# Phase Log

## Phase 1 — Scaffold + Auth
Status: not started | in progress | complete
Decisions: [framework, package manager, hosting rationale]
Issues: [any blockers]
Summary: [what's working]

## Phase 2 — Tableau API Services
...
```

---

## Technical Notes

### Auth
- PAT tokens expire after 4 hours — implement auto-refresh on 401
- VizQL Data Service uses the same `X-Tableau-Auth` token as the REST API
- Metadata API (GraphQL) also uses the same token
- Extension in production needs Connected Apps / JWT for user-level auth —
  for the hackathon demo, server-level PAT auth is acceptable

### VizQL Data Service
- Datasource must have `API Access` permission enabled in the provisioned org
- Always set `interpretFieldCaptionsAsFieldNames: true`
- SSE streaming available from Tableau 2026.1 — try it, fall back to JSON if unavailable
- 500 row cap is a starting point — tune based on context window usage

### Metadata API
- Use `fieldsConnection` query filtered by datasource LUID
- `upstreamColumns` and `upstreamDatabases` provide lineage — include in schema context
  so Claude understands where data comes from

### Pulse API
- Pulse must be enabled on the provisioned site before any Pulse endpoints work
- `InsightFeedbackMetadata` is the key differentiator — use it to weight which
  insight types Claude emphasizes in its narrative
- If no Pulse metrics exist for a datasource, degrade gracefully — skip Pulse
  context and note it in the `ContextBadge`

### Streaming
- The `/chat` SSE stream must stay open until `{"type":"done"}` is sent
- Parse `[ANOMALY: ...]` tags as tokens arrive — do not wait for the full response
- The `{"suggestions": [...]}` block always comes at the very end of the stream

### Extension
- Must be served over HTTPS in production (Tableau Cloud enforces this)
- The `.trex` manifest backend URL must match the deployed backend exactly
- `full data` permission in the manifest is required for VizQL queries to work
