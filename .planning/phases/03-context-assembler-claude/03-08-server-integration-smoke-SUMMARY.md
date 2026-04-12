---
phase: 03-context-assembler-claude
plan: 08
subsystem: backend-integration
tags: [phase-3, integration, rate-limit, smoke-test, wave-4, live-uat]
status: complete
completed: 2026-04-12
duration: ~15m (Tasks 1-2 auto) + live UAT
tasks_completed: 3
tasks_total: 3
requires:
  - backend/src/routes/context.ts (Plan 03-06)
  - backend/src/routes/chat.ts (Plan 03-06)
  - backend/src/routes/export.ts (Plan 03-07)
  - backend/src/services/contextAssembler.ts (Plan 03-04)
  - backend/src/services/claudeService.ts (Plan 03-05)
provides:
  - Route registration in server.ts (POST /context, /chat, /export/slack, /export/pdf)
  - "@fastify/rate-limit with D-22 per-route config"
  - "onRoute hook for per-URL rate-limit overrides"
  - "phase3.smoke.ts with Phase A offline burst test + Phase B live SSE verification"
affects:
  - backend/src/server.ts (healthRoutes moved below onRoute hook — Warning 5 fix)
tech_stack:
  added:
    - "@fastify/rate-limit"
  patterns:
    - "onRoute hook installed BEFORE fastifyRateLimit plugin (ordering is load-bearing — see deviation)"
    - "Phase A burst test via app.inject() as permanent regression guard for hook ordering"
key-files:
  modified:
    - backend/src/server.ts
    - backend/package.json
    - pnpm-lock.yaml
  created:
    - backend/src/services/__tests__/phase3.smoke.ts
deviations:
  count: 1
  items:
    - rule: "Rule 1 — Bug"
      description: "Plan template had rate-limit plugin registered BEFORE the onRoute hook. Fastify runs onRoute hooks in add order, so the plugin's internal hook (which reads config.rateLimit) fired before our hook (which sets config.rateLimit). Every route was effectively unlimited. Fixed by swapping the order: install our onRoute hook FIRST, then register fastifyRateLimit. The Phase A burst test caught this immediately (61x200 instead of 60x200 + 1x429)."
      impact: "Would have been a production DoS vulnerability (T-03-08-01 unmitigated)"
      files: ["backend/src/server.ts", "backend/src/services/__tests__/phase3.smoke.ts"]
self_check: PASSED
---

# 03-08 Server Integration + Smoke — SUMMARY

## What Was Built

### Task 1: Route Registration + Rate Limiting (auto)
- Registered all Phase 3 routes in `server.ts`: `contextRoutes`, `chatRoutes`, `exportRoutes`
- Installed `@fastify/rate-limit` with D-22 per-route config via `onRoute` hook:
  - `/chat`, `/context` → 60/min/IP
  - `/export/slack`, `/export/pdf` → 10/min/IP
  - `/health` → no override (global default = effectively unlimited)
- **Warning 5 fix**: `healthRoutes` registration MOVED from line ~48 (before CORS) to AFTER the onRoute hook, ensuring every route (including health) is covered by the hook
- **Deviation fix**: onRoute hook installed BEFORE `fastifyRateLimit` plugin registration (order is load-bearing — plugin's internal hook must see our config.rateLimit values)

### Task 2: phase3.smoke.ts (auto)
- **Phase A** (offline, always runs): 61-request burst via `app.inject()` that mirrors production server.ts bootstrap. Asserts 61st request returns 429 with `Retry-After` header. Catches both scoping regressions (Warning 6) and hook-ordering regressions.
- **Phase B** (live, conditional): Hits running backend's `/context` and `/chat` with the EIA Prices datasource LUID. Parses SSE frames structurally (`split('\n\n')` + per-frame event/data parsing). Asserts event sequence: context → token* → suggestions → done. Checks no `[ANOMALY` or `{"suggestions"` leakage in token frames.
- Cold-boot path: exits 0 when `--datasource` or `ANTHROPIC_API_KEY` is missing (after Phase A has run).

### Task 3: Live UAT (human-verify checkpoint)
Verified against **EIA Prices** datasource (LUID `e1e21925-6e00-49a0-a8ff-d6115adde23d`) on 2026-04-12.

| Observation | Status | Evidence |
|---|---|---|
| 1. `event: context` first, metadata=ok, pulse=ok | PASS | `assemblyMs=1810ms`, `contextChars=115957` |
| 2. Coherent narrative (1-3 paragraphs) | PASS | 1160 chars, 3 paragraphs on WTI prices/spreads/fuels |
| 3. Real field captions in narrative | PASS | `Wti Daily Change`, `Wti Brent Spread`, `Price Date` |
| 4. Anomaly frames | PASS | 4 anomalies: Wti Daily Change (-5.76, +5.31), Wti Brent Spread (28.49, -6.76) |
| 5. Suggestions (exactly 3) | PASS | Volatility factors, spread comparison, seasonal patterns |
| 6. Done frame with non-zero usage | PASS | `stopReason=end_turn`, `inputTokens=23582`, `outputTokens=408` |
| 7. No tag leakage in token frames | PASS | 0 `[ANOMALY` leaks, 0 `{"suggestions"` leaks |
| Rate limiting (D-22) | PASS | `x-ratelimit-limit: 60` header, 429s in sustained burst |

## Verification

- `pnpm --filter @aperture/backend typecheck` — PASS
- `pnpm --filter @aperture/backend build` — PASS
- `pnpm --filter @aperture/backend smoke:phase3` (cold-boot) — PASS (Phase A: 60x200 + 1x429; Phase B: cold-boot)
- `pnpm --filter @aperture/backend smoke:phase3 --datasource <LUID>` (live) — PASS (/context ok, /chat full SSE sequence)
- Live curl UAT — all 7 observations PASS
- Rate limit burst test — PASS (429 + Retry-After confirmed)

## Requirements Addressed

- **CTX-14**: POST /context debug endpoint (live-verified)
- **CTX-15**: POST /chat SSE streaming (live-verified)
- **CTX-16**: POST /export/slack (offline-verified in Plan 03-07)
- **CTX-17**: POST /export/pdf (offline-verified in Plan 03-07)

## Known v1 Limitations

- Rate-limit state is in-memory per-process. Sufficient for single-process Fly.io deployment. Would need Redis adapter for multi-instance.
- `withTimeout` in contextAssembler.ts (Plan 03-04) does not cancel in-flight Tableau API requests on timeout — it resolves the promise boundary but the underlying fetch may complete after the response is sent. Documented in Plan 03-04 SUMMARY.
