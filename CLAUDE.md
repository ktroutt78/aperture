# Aperture — CLAUDE.md

## Project

Aperture is a Tableau Cloud Extension that embeds an AI analytics co-pilot inside any
published dashboard. It fuses three Tableau APIs in parallel — Metadata API, VizQL Data
Service, and Pulse REST API — and streams the merged context through Claude to produce
narrative intelligence, anomaly detection, and guided follow-up questions without the
user ever leaving Tableau.

Read `aperture-spec.md` for the full technical spec.

---

## Skills

### /ui-ux-pro-max
Use for all UI work in the `extension/` directory. Invoke before writing any component,
layout, or interaction. Every visual element in the co-pilot panel goes through this skill.

---

## Ground Rules

- Own all architecture decisions — do not ask for approval, make the call and log it
- Never hardcode secrets — everything through `.env`
- Backend must be reachable over public HTTPS before the extension can be tested end-to-end
- Extension runs on the provisioned Tableau Cloud DataDev sandbox org
- Degrade gracefully if any Tableau API returns empty — never crash the panel
- Run `claude --dangerously-skip-permissions` for uninterrupted execution

---

## Key Technical Constraints

**Tableau auth**
- PAT tokens expire after 4 hours — auto-refresh on 401
- All three APIs (Metadata, VizQL Data Service, Pulse) share the same `X-Tableau-Auth` token
- VizQL Data Service requires `API Access` permission enabled per datasource in Tableau Cloud
- Set `interpretFieldCaptionsAsFieldNames: true` on all VizQL requests

**Claude API**
- Model: `claude-sonnet-4-20250514`, always stream responses
- System prompt is built dynamically from assembled context on every request
- Claude must output `[ANOMALY: fieldName="x" value="y"]` tags for the mark highlighter
- Claude must end every response with `{"suggestions": ["...", "...", "..."]}`

**Tableau Extension**
- Must declare `full data` permission in the `.trex` manifest
- Must be served over HTTPS in production
- Mark highlighter calls `worksheet.selectMarksByValueAsync()` on each parsed anomaly tag —
  this is the highest-impact demo interaction, make it fast and reliable

**Pulse**
- Degrade gracefully if no Pulse metrics exist for a datasource — skip and note in UI
- `InsightFeedbackMetadata` (thumbs up/down per insight type) weights Claude's emphasis

---

## What Good Looks Like

- Context assembles in under 3 seconds for the demo dataset
- Narrative is executive-readable: 3 paragraphs max, specific field names, no filler
- The panel feels native to Tableau — polished, not bolted on
- A judge with admin credentials can install and test in under 5 minutes
