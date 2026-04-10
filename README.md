# Aperture

Tableau Cloud Extension that embeds an AI analytics co-pilot inside any published dashboard. Fuses Tableau Metadata API, VizQL Data Service, and Pulse REST API and streams merged context through Claude for narrative intelligence, anomaly detection, and guided follow-up questions.

See `aperture-spec.md` for the full technical spec.

## Quick start

```bash
nvm use                 # Node 20
pnpm install
cp .env.example .env    # fill in TABLEAU_* and ANTHROPIC_API_KEY
pnpm dev:backend        # starts backend on http://localhost:3001
pnpm dev:extension      # starts extension on http://localhost:5173
```

## Structure

- `extension/` — Tableau Extension (Vite + React + TypeScript)
- `backend/` — TypeScript backend API (Fastify)
- `demo-data/` — Sample data setup instructions
- `docs/` — SETUP.md, JUDGING.md, ARCHITECTURE.md

Full setup, architecture, and judging docs land in Phase 5.
