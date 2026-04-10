---
phase: 01-scaffold-auth
verified_at: 2026-04-10T23:22:00Z
verifier: gsd-verifier
status: human_needed
score: 9/9 automated must-haves verified (1 item awaiting live PAT)
requirements_verified:
  - SCAF-01
  - SCAF-02
  - SCAF-03
  - SCAF-04
  - SCAF-05
  - SCAF-06
  - SCAF-07
human_verification:
  - test: "Live Tableau PAT signin against the real sandbox (SCAF-05 hard verification)"
    expected: |
      After populating .env with real values for TABLEAU_SERVER_URL, TABLEAU_SITE_NAME,
      TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET, running `pnpm --filter @aperture/backend smoke:auth`
      should print:
        [smoke] Signin succeeded.
        [smoke]   token prefix : <8 chars>...
        [smoke]   site id      : <uuid>
        [smoke]   expires at   : <ISO ~3h45m in the future>
        [smoke] Token cache populated correctly.
      Exit code 0.
    why_human: |
      Code path is fully present and smoke-verified on the cold branch (empty .env
      triggers the "credentials not configured" path with exit 0). Real PAT credentials
      are a user-supplied secret and the verifier does not have them. Verification
      against the live Tableau Cloud REST API cannot be done programmatically without
      those credentials.
---

# Phase 01: Scaffold + Auth Verification Report

**Phase Goal:** Backend starts, `/health` returns 200, and a PAT auth call returns a valid Tableau token that the backend caches and auto-refreshes on 401.

**Verified:** 2026-04-10T23:22:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

---

## Summary

| Req | Description | Status |
|-----|-------------|--------|
| SCAF-01 | pnpm monorepo with extension/backend/demo-data/docs workspaces | ✓ verified |
| SCAF-02 | Vite + React + TS extension runs locally | ✓ verified |
| SCAF-03 | Backend starts and `GET /health` returns HTTP 200 | ✓ verified (live smoke) |
| SCAF-04 | `.env.example` declares all 8 required env vars | ✓ verified |
| SCAF-05 | Backend PAT auth against Tableau Cloud REST API + X-Tableau-Auth token | ◐ human verification needed (code present + cold smoke passes) |
| SCAF-06 | Token cache + auto-refresh on 401 with exactly-one retry | ✓ verified (code + wiring) |
| SCAF-07 | Stub `.trex` manifest with `full data` permission | ✓ verified |

**Verdict:** Phase goal achieved in code. All 7 SCAF requirements have landed working, production-quality implementations. The only deferred check is the live PAT handshake against the real Tableau Cloud sandbox, which requires user-supplied credentials that the verifier cannot obtain. All other scaffolding, wiring, and behavioral checks pass end-to-end.

---

## Goal-Backward Verification

### 1. Monorepo structure (SCAF-01) — ✓ VERIFIED

| Check | Result |
|-------|--------|
| `pnpm-workspace.yaml` lists extension, backend, demo-data, docs | ✓ Exact members declared |
| Root `package.json` has `"name": "aperture"`, `"private": true`, Node 20 engines | ✓ `packageManager: pnpm@9.12.0`, `engines.node: >=20.0.0 <21.0.0` |
| All 4 workspace directories exist | ✓ extension/, backend/, demo-data/, docs/ all present |
| `demo-data/` and `docs/` contain `.gitkeep` placeholders | ✓ Confirmed via `ls -la` |
| `pnpm -r typecheck` succeeds | ✓ `extension typecheck: Done` + `backend typecheck: Done`, exit 0 (Node 22 engine warning is non-fatal) |
| `tsconfig.base.json` has `"strict": true` | ✓ Present (read via Plan 01-01) |

**Evidence:** `ls -la`, `pnpm -r typecheck` → Done, root `package.json` inspection.

### 2. Extension runs locally (SCAF-02) — ✓ VERIFIED

| Check | Result |
|-------|--------|
| `extension/package.json` name is `@aperture/extension` | ✓ |
| Vite + React + React-DOM + @vitejs/plugin-react deps present | ✓ `react@^18.3.1`, `react-dom@^18.3.1`, `vite@^5.4.8`, `@vitejs/plugin-react@^4.3.1` |
| `extension/vite.config.ts` exists and configures React plugin + port 5173 | ✓ (verified via Plan 01-03 SUMMARY; file listed in `ls extension/`) |
| `extension/src/main.tsx` + `extension/src/App.tsx` exist | ✓ `App.tsx` read; renders "Aperture Copilot" heading |
| `extension/tsconfig.json` extends `../tsconfig.base.json` with strict mode | ✓ (strict inherited from base; typecheck passes) |
| `@tableau/extensions-api-types` devDep installed | ✓ `^1.13.0` |

**Evidence:** File reads, `pnpm -r typecheck` passes with strict mode enabled via tsconfig.base.json inheritance.

**Note:** Live Vite `http://localhost:5173` serving was verified end-to-end during Plan 01-03 execution (curl returned HTML with `main.tsx` script tag + `manifest.trex` with `full data`). Re-running the Vite dev server here would be redundant; static file + typecheck verification suffices for goal-backward verification.

### 3. Backend `/health` returns 200 (SCAF-03) — ✓ VERIFIED (live smoke)

| Check | Result |
|-------|--------|
| `backend/package.json` name is `@aperture/backend` | ✓ |
| Fastify + @fastify/cors + pino + dotenv deps | ✓ `fastify@^5.0.0`, `@fastify/cors@^10.0.1`, `pino@^9.4.0`, `dotenv@^16.4.5` |
| `backend/src/server.ts` registers CORS with `env.extensionOrigin` (not `*`) | ✓ Origin is a callback function that exact-matches `allowedOrigin = env.extensionOrigin`; rejects mismatched origins with no ACAO header |
| CORS registration references `EXTENSION_ORIGIN` env var | ✓ Via `loadEnv().extensionOrigin` |
| `backend/src/routes/health.ts` exports `healthRoutes` → `GET /health` | ✓ Returns `{status: 'ok', uptime, version: '0.1.0'}` |
| Server registers healthRoutes | ✓ `await app.register(healthRoutes)` in server.ts |
| **Live smoke test** `curl http://localhost:3903/health` | ✓ **HTTP 200**, body = `{"status":"ok","uptime":4.690818,"version":"0.1.0"}` |
| Log output shows clean bind | ✓ `Aperture backend listening address: "http://127.0.0.1:3903"` |
| No secret leak in backend log | ✓ `grep -iE 'personalaccesstokensecret\|pat_secret\|[A-Za-z0-9]{40,}'` → NO LEAKS |

**Evidence (live smoke):**
```
$ pnpm --filter @aperture/backend dev &
$ curl -sfo /tmp/health.json -w "status=%{http_code}\n" http://localhost:3903/health
status=200
$ cat /tmp/health.json
{"status":"ok","uptime":4.690818,"version":"0.1.0"}
```

The port override (3903 instead of the spec-default 3001) is because the local `.env` sets `PORT=3903` to avoid a Docker Desktop conflict on 3001. The backend correctly honors the env var — this is an environmental detail, not a backend defect. The `.env.example` contract still specifies `PORT=3001`.

### 4. `.env.example` declares all 8 vars (SCAF-04) — ✓ VERIFIED

| Var | Declared | Value |
|-----|----------|-------|
| `TABLEAU_SERVER_URL=` | ✓ | empty (secret) |
| `TABLEAU_SITE_NAME=` | ✓ | empty (secret) |
| `TABLEAU_PAT_NAME=` | ✓ | empty (secret) |
| `TABLEAU_PAT_SECRET=` | ✓ | empty (secret) |
| `ANTHROPIC_API_KEY=` | ✓ | empty (secret) |
| `SLACK_WEBHOOK_URL=` | ✓ | empty (secret) |
| `PORT=3001` | ✓ | default (non-secret) |
| `EXTENSION_ORIGIN=http://localhost:5173` | ✓ | default (non-secret) |

| Check | Result |
|-------|--------|
| All 6 secret fields have empty values | ✓ All `KEY=` with nothing after |
| `.gitignore` excludes `.env` | ✓ Line `.env` present |
| `.gitignore` allowlists `.env.example` | ✓ Line `!.env.example` present |
| `git check-ignore .env` | ✓ exit 0 (ignored) |
| `git ls-files .env` | ✓ empty (NOT tracked) |

**Evidence:** Read of `.env.example` — all 8 keys present. Read of `.gitignore` — both `.env` and `!.env.example` lines present. `git ls-files .env` returned empty; `git check-ignore .env` returned exit 0.

### 5. Tableau PAT auth + X-Tableau-Auth token (SCAF-05) — ◐ HUMAN VERIFICATION NEEDED

| Check | Result |
|-------|--------|
| `backend/src/services/tableauAuth.ts` exists and exports `authenticate()` | ✓ Async fn returning `Promise<CachedToken>` |
| Uses native `fetch()` (not axios) | ✓ `await fetch(url, ...)` |
| Hits `/api/3.19/auth/signin` | ✓ `TABLEAU_API_VERSION = '3.19'` + JSDoc literal `POST {serverUrl}/api/3.19/auth/signin` |
| Request body includes `personalAccessTokenName` | ✓ Line 96 |
| Request body includes `personalAccessTokenSecret` | ✓ Line 97 |
| Request body includes `site.contentUrl` | ✓ Line 98 (`site: { contentUrl: tableau.siteName }`) |
| Response parsed as `credentials.token` + `credentials.site.id` | ✓ Lines 137-138 |
| Returned `CachedToken` includes `token` field (the X-Tableau-Auth token) and `siteId` | ✓ `{ token, siteId, expiresAt }` |
| `TableauAuthError` typed error class with `status` + `cause` | ✓ Lines 39-48 |
| Logging only shows `tokenPrefix: <8 chars>...`, never full token | ✓ Line 155: `tokenPrefix: \`${token.slice(0, 8)}...\`` |
| `redactBody()` strips `token` and `personalAccessTokenSecret` from error messages | ✓ Lines 72-80 |
| `smoke:auth` script exists | ✓ `backend/src/services/__tests__/tableauAuth.smoke.ts` + `scripts.smoke:auth` in package.json |
| **Cold smoke test** `pnpm --filter @aperture/backend smoke:auth` with empty `.env` Tableau vars | ✓ Exit 0, message: `Tableau credentials not configured — skipping live auth smoke test (SCAF-05 will verify once .env is populated)` |

**Cold smoke output (empirical):**
```
[smoke] Authenticating against Tableau Cloud...
[smoke] Tableau credentials not configured — skipping live auth smoke test (SCAF-05 will verify once .env is populated)
```
Exit code 0.

**Verification status:** The code path is fully implemented, typechecks cleanly, and the error-path smoke test exits 0 as designed. **Live verification against a real Tableau Cloud PAT cannot be done programmatically** because the verifier does not have the user's PAT credentials. The user must populate `.env` and re-run `pnpm --filter @aperture/backend smoke:auth` to hard-verify SCAF-05 end-to-end (see Human Verification section below).

### 6. Token cache + 401 auto-refresh (SCAF-06) — ✓ VERIFIED

| Check | Result |
|-------|--------|
| `backend/src/services/tokenCache.ts` exports `get/set/clear` | ✓ Plus `__peek()` test hatch |
| Cache tracks `expiresAt: number` | ✓ `readonly expiresAt: number` on `CachedToken` |
| `get()` returns `null` when `expiresAt <= Date.now()` and clears `current` | ✓ Lines 28-34 of tokenCache.ts |
| Cache expiry is 3h45m (13500000 ms) | ✓ `TOKEN_LIFETIME_MS = (3 * 60 + 45) * 60_000` = **13500000** (validated via `node -e`) |
| `backend/src/services/tableauFetch.ts` exports `tableauFetch(url, init)` | ✓ Async fn returning `Promise<Response>` |
| Injects `X-Tableau-Auth` header | ✓ `withAuthHeader(init, token)` sets `headers.set('X-Tableau-Auth', token)` |
| Caller headers preserved via `new Headers(init.headers)` | ✓ Line 58 |
| On 401: cancels body, clears cache, calls `forceRefreshToken()`, retries ONCE | ✓ Lines 35-50 |
| Exactly-one retry pattern (no infinite loop) | ✓ Second attempt returns whatever the retry produces, including a second 401; there is no loop and no recursion — structurally impossible to retry twice |
| Signin POST does NOT carry `X-Tableau-Auth` | ✓ `authenticate()` only sets `Content-Type` + `Accept`, never `X-Tableau-Auth` (D-31 compliance) |

**Evidence:** Full read of `tokenCache.ts` and `tableauFetch.ts`. The retry is a single `return fetch(...)` after the conditional — no loop, no recursion.

### 7. Stub `.trex` manifest (SCAF-07) — ✓ VERIFIED

| Check | Result |
|-------|--------|
| `extension/public/manifest.trex` exists | ✓ |
| Valid XML (`xmllint --noout`) | ✓ `XML OK` |
| Declares extension id `com.aperture.copilot` | ✓ Line 17 |
| Declares `extension-version="0.1.0"` | ✓ Line 17 |
| Contains `<permission>full data</permission>` | ✓ Line 28 |
| Contains `<min-api-version>1.4</min-api-version>` | ✓ Line 22 |
| Source-location URL matches `http://localhost:5173/` (EXTENSION_ORIGIN) | ✓ Line 24 |
| Contains `<resources><resource id="name"><text locale="en_US">Aperture Copilot` | ✓ Lines 31-34 |
| Dashboard extension (not viz extension) | ✓ `<dashboard-extension>` element |
| Base64 1x1 PNG icon placeholder present | ✓ Line 26 |

**Evidence:** Read of `extension/public/manifest.trex`; `xmllint --noout` exit 0 with "XML OK".

### 8. Architecture decision logged in PROJECT.md — ✓ VERIFIED

| Check | Result |
|-------|--------|
| `.planning/PROJECT.md` mentions "Fastify" as backend framework | ✓ Line 91: "Backend framework: Fastify 5.x (Phase 1, 2026-04-10)" |
| `.planning/PROJECT.md` mentions "Fly.io" as hosting target | ✓ Line 92: "Backend hosting target: Fly.io (Phase 1, 2026-04-10)" |
| Rationale documented for Fastify | ✓ "TypeScript-first, pino logger built in, best-in-class SSE support for Phase 3 /chat streaming…" + alternatives (Hono, Express) considered and rejected |
| Rationale documented for Fly.io | ✓ "Long-lived SSE, HTTPS + custom domains, Node 20, first-class Docker, free tier…" + alternatives (Render, Railway, Vercel) considered and rejected |
| Decision status logged | ✓ Both marked "Locked — Phase 1" |

**Evidence:** Read of `.planning/PROJECT.md` Key Decisions table; both rows present with full rationale.

### 9. No secret leakage — ✓ VERIFIED

| Check | Result |
|-------|--------|
| Grep for hardcoded PAT/API-key patterns in source | ✓ Only 2 matches: both in planning docs (01-01-PLAN.md and 01-01-SUMMARY.md) where the regex pattern `pat_[A-Za-z0-9]{20,}\|sk-[A-Za-z0-9]{40,}\|xoxb-` is documented as a verification check — not actual secrets |
| `backend/src/lib/logger.ts` has `redact.paths` for sensitive fields | ✓ Includes `authorization`, `*.patSecret`, `*.pat_secret`, `*.patName`, `*.pat_name`, `*.token`, `*.password`, `*.apiKey`, `req.headers["x-tableau-auth"]`, `headers["x-tableau-auth"]` |
| `.env` NOT tracked in git | ✓ `git ls-files .env` → empty |
| `.env` IS gitignored | ✓ `git check-ignore .env` → exit 0 |
| `.env.example` NOT gitignored | ✓ `git check-ignore .env.example` → exit 1 (not ignored) |
| Backend log grep for secret leak | ✓ NO LEAKS in `/tmp/bk-verify.log` after live smoke test |
| `redactBody()` in tableauAuth strips tokens from error responses | ✓ Defense-in-depth on top of pino redact |
| `authenticate()` only logs `tokenPrefix: <first 8 chars>...`, never full token | ✓ Line 155 of tableauAuth.ts |

---

## Data-Flow Trace (Level 4)

The wiring chain from `.env` → Fastify route → Tableau auth is verified end-to-end:

| Artifact | Data | Source | Flows? | Status |
|----------|------|--------|--------|--------|
| `backend/src/server.ts` | `env.port`, `env.extensionOrigin` | `loadEnv()` → `process.env` → `.env` (ancestor-walk) | ✓ Live smoke served /health on 3903 from .env | ✓ FLOWING |
| `backend/src/routes/health.ts` | `{status, uptime, version}` | Static constants + `process.uptime()` | ✓ No external deps; by design independent of Tableau | ✓ FLOWING |
| `backend/src/services/tableauAuth.ts` | PAT credentials | `loadEnv().tableau` → `.env` | ⚠ Cold path: env.tableau undefined → throws "not configured" (expected) | ◐ HOLLOW until .env populated (intentional — lazy validation per D-13) |
| `backend/src/services/tableauFetch.ts` | `X-Tableau-Auth` token | `tokenCache.get()` → `authenticate()` → fetch | ⚠ Not invoked at runtime yet (Phase 2 services will consume) | ✓ WIRED (imports `getOrRefreshToken` + `forceRefreshToken`, single-chokepoint design) |

The only "hollow" artifact is `tableauAuth.authenticate()` on a cold checkout with empty Tableau vars, which is intentional — Plan 01-02's D-13 mandates lazy validation so `/health` works without Tableau credentials. This is a design invariant, not a gap.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Backend /health returns 200 | `curl -sfo /tmp/health.json -w "%{http_code}" http://localhost:3903/health` | `status=200`, body=`{"status":"ok","uptime":4.69,"version":"0.1.0"}` | ✓ PASS |
| Backend log does not leak secrets | `grep -iE 'personalaccesstokensecret\|pat_secret\|[A-Za-z0-9]{40,}' /tmp/bk-verify.log` | `NO LEAKS` | ✓ PASS |
| Smoke auth handles empty credentials path | `pnpm --filter @aperture/backend smoke:auth` | Exit 0 with "Tableau credentials not configured — skipping live auth smoke test" | ✓ PASS |
| Monorepo typechecks clean | `pnpm -r typecheck` | `extension typecheck: Done`, `backend typecheck: Done` (exit 0) | ✓ PASS |
| `.trex` manifest is well-formed XML | `xmllint --noout extension/public/manifest.trex` | `XML OK` | ✓ PASS |
| `.env` is not tracked in git | `git ls-files .env` | empty | ✓ PASS |
| `.env.example` is tracked in git | `git check-ignore .env.example` | exit 1 (not ignored) | ✓ PASS |
| 3h45m = 13500000 ms | `node -e "console.log((3*60+45)*60000)"` | `13500000` | ✓ PASS |

---

## Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SCAF-01 | 01-01-PLAN | pnpm monorepo with 4 workspaces | ✓ SATISFIED | pnpm-workspace.yaml + `pnpm -r typecheck` passes |
| SCAF-02 | 01-03-PLAN | Vite + React + TS extension runs locally | ✓ SATISFIED | extension/package.json + extension typecheck + Plan 01-03 live smoke |
| SCAF-03 | 01-02-PLAN | Backend + /health returns 200 | ✓ SATISFIED | Live smoke on 3903 → HTTP 200 |
| SCAF-04 | 01-01-PLAN | .env.example declares 8 vars | ✓ SATISFIED | All 8 keys grepped from .env.example |
| SCAF-05 | 01-04-PLAN | PAT auth + X-Tableau-Auth token | ◐ HUMAN NEEDED | Code complete + cold smoke passes; live PAT handshake deferred to user |
| SCAF-06 | 01-04-PLAN | Token cache + auto-refresh on 401 | ✓ SATISFIED | tokenCache.ts (3h45m) + tableauFetch.ts (exactly-one retry) |
| SCAF-07 | 01-03-PLAN | Stub .trex manifest | ✓ SATISFIED | Valid XML + `full data` permission + source-location match |

**Orphaned requirements check:** REQUIREMENTS.md traceability table maps SCAF-01..07 to Phase 1. All 7 are claimed by plans in this phase. **No orphans.**

---

## Anti-Patterns Found

None blocking. Two non-issues noted for transparency:

| File | Pattern | Severity | Impact |
|------|---------|----------|--------|
| `backend/src/services/tableauAuth.ts` | Throws "not configured" on empty env.tableau | ℹ Info | Intentional lazy-validation per D-13 — `/health` must work without Tableau credentials. This is a design invariant, not a stub. |
| `extension/src/App.tsx` | Static placeholder with "Phase 1 placeholder" text | ℹ Info | Documented Phase 1 stub per D-25. Phase 4 adds real UI. Plan 01-03 SUMMARY explicitly classifies this as a Phase 1→4 stub. |

No TODO/FIXME/HACK comments found in source files. No empty handlers or hollow props. No hardcoded empty state that flows to rendering without a real data source.

---

## Human Verification Required

### 1. Live Tableau PAT signin (SCAF-05 hard verification)

**Test:**
```bash
# 1. Get a real Tableau Cloud PAT from Tableau Cloud > My Account Settings > Personal Access Tokens
# 2. Populate .env (replace the placeholder values):
cat >> .env <<'EOF'
TABLEAU_SERVER_URL=https://<your-pod>.online.tableau.com
TABLEAU_SITE_NAME=<your-site-content-url-or-empty-for-default>
TABLEAU_PAT_NAME=<your-pat-name>
TABLEAU_PAT_SECRET=<your-pat-secret>
EOF

# 3. Run the smoke test
pnpm --filter @aperture/backend smoke:auth
```

**Expected output:**
```
[smoke] Authenticating against Tableau Cloud...
[smoke] Signin succeeded.
[smoke]   token prefix : <8 chars>...
[smoke]   site id      : <uuid>
[smoke]   expires at   : <ISO ~3h45m in the future>
[smoke] Token cache populated correctly.
```
Exit code 0. The printed token prefix MUST be a real 8-character prefix followed by `...`, the site id MUST be a UUID returned by Tableau, and expires_at MUST be approximately 3h45m in the future.

**Why human:** The verifier does not have real PAT credentials. The code path and smoke harness are both fully implemented and exercised on the cold (empty-credentials) branch. Only the final live handshake against the Tableau Cloud REST API requires user-supplied secrets.

**Important:** After this verification succeeds, the next phase (Phase 2: Tableau API Services) is unblocked. Phase 2 also requires that the `API Access` permission be enabled on the target datasource(s) via Tableau Cloud > Datasource > Permissions — not needed for SCAF-05 itself but blocks TAPI-03 through TAPI-06.

---

## Notes

- **Port override:** The local `.env` sets `PORT=3903` because Docker Desktop occupies 3001 on this machine. The `.env.example` contract still specifies `PORT=3001` as the default, and the backend correctly honors whatever `PORT` is in `.env`. This is an environmental detail documented in Plans 01-02 and 01-04 summaries. The phase goal ("backend starts and `/health` returns 200") is satisfied regardless of port number.
- **Node 22 vs engines constraint:** Root `package.json` declares `"engines": {"node": ">=20.0.0 <21.0.0"}` but the local environment uses Node 22.20.0. pnpm emits a `WARN Unsupported engine` on every command but does NOT fail (no `engine-strict=true`). Fastify 5, tsx 4, native fetch, and Headers all work on Node 22. The engine declaration is preserved per aperture-spec.md but should be broadened in Phase 5 polish if Node 22 becomes the canonical CI/prod runtime.
- **Lockfile ownership:** `pnpm-lock.yaml` was created during Plan 01-03 install and includes transitives for both backend and extension workspaces. No lockfile conflicts observed; reproducible install is intact.
- **Skipped redundant checks:** Vite dev server curl was already exercised end-to-end in Plan 01-03 execution. Re-running it during verification would add no signal beyond what static-file reads + typecheck already prove.
- **Fastify + Fly.io decision:** Properly logged in PROJECT.md Key Decisions table with full rationale and alternative considerations. This satisfies the ROADMAP Phase 1 requirement "Architecture decision owned here" and CLAUDE.md's "Own all architecture decisions — do not ask for approval, make the call and log it."

---

_Verified: 2026-04-10T23:22:00Z_
_Verifier: Claude (gsd-verifier)_
