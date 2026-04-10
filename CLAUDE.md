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

<!-- GSD:project-start source:PROJECT.md -->
<!-- Project overview, constraints, and ground rules are defined above (hand-authored section). -->
<!-- GSD:project-end -->

<!-- GSD:stack-start source:STACK.md -->
## Technology Stack

Technology stack not yet documented. Will populate after codebase mapping or first phase.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

Conventions not yet established. Will populate as patterns emerge during development.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

Architecture not yet mapped. Follow existing patterns found in the codebase.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
<!-- Project skills are defined in the "Skills" section above (/ui-ux-pro-max for extension/ work). -->
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
