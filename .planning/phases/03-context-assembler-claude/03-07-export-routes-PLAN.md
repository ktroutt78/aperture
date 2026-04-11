---
phase: 03-context-assembler-claude
plan: 07
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/src/services/tableauAuth.ts
  - backend/src/routes/export.ts
  - backend/src/services/__tests__/exportRoutes.test.ts
  - backend/package.json
autonomous: true
requirements: [CTX-16, CTX-17]
tags: [phase-3, export, slack, pdf, routes, wave-1]

must_haves:
  truths:
    - "POST /export/slack posts a Slack Block Kit payload to env.slackWebhookUrl (D-19, D-21)"
    - "The Slack webhook URL is ONLY read from env.slackWebhookUrl — the client cannot supply it (D-21 SSRF defense)"
    - "POST /export/slack returns 503 { error: 'ENV_MISSING', key: 'SLACK_WEBHOOK_URL' } when env var is absent"
    - "POST /export/slack returns 502 on webhook POST failure"
    - "POST /export/pdf validates workbookLuid with UUID regex BEFORE building the URL (D-20 SSRF defense)"
    - "POST /export/pdf routes through tableauFetch — the Phase 1 chokepoint — NEVER raw fetch (hard invariant)"
    - "POST /export/pdf resolves the cached Tableau siteId via a new `getCachedSiteId()` helper exported from tableauAuth.ts BEFORE constructing the URL — the final URL contains the real site ID via template literal interpolation, not a `{siteId}` placeholder"
    - "POST /export/pdf pipes the binary PDF body directly to the client (Content-Type: application/pdf, no backend buffering — DoS defense per D-20)"
    - "POST /export/pdf sets Content-Disposition: attachment; filename=\"aperture-workbook-{luid}.pdf\""
  artifacts:
    - path: "backend/src/services/tableauAuth.ts"
      provides: "New exported `getCachedSiteId()` helper that returns the cached siteId, auto-refreshing the token if expired"
      contains: "export async function getCachedSiteId"
    - path: "backend/src/routes/export.ts"
      provides: "exportRoutes(app) — combined Slack + PDF handler"
      contains: "exportRoutes"
    - path: "backend/src/services/__tests__/exportRoutes.test.ts"
      provides: "Offline tests using inject() + stubbed tableauFetch + stubbed global fetch for the Slack webhook + stubbed getCachedSiteId"
      contains: "exportRoutes"
  key_links:
    - from: "backend/src/routes/export.ts"
      to: "backend/src/services/tableauFetch.ts"
      via: "import { tableauFetch }"
      pattern: "tableauFetch"
    - from: "backend/src/routes/export.ts"
      to: "backend/src/services/tableauAuth.ts"
      via: "import { getCachedSiteId } — the new Phase 3 helper that unblocks the PDF route URL construction"
      pattern: "getCachedSiteId"
    - from: "backend/src/routes/export.ts"
      to: "backend/src/config/env.ts"
      via: "import { loadEnv } — read slackWebhookUrl only from env"
      pattern: "env.slackWebhookUrl"
---

<objective>
Implement the two export routes (CTX-16 Slack, CTX-17 workbook PDF) with their security-load-bearing SSRF defenses: D-20 UUID-regex LUID validation, D-21 server-side-only webhook URL. Both routes live in one module because they share request-validation helpers and both are small.

**Blocker 1 fix (PDF route URL construction):** The live Tableau REST PDF endpoint is `/api/3.19/sites/{siteId}/workbooks/{workbookLuid}/pdf`. `tableauFetch` (verified against the live codebase) is a pure auth-header injection passthrough — it does NOT perform `{siteId}` substitution. `tableauAuth.ts` caches the siteId inside `CachedToken` via `tokenCache.get()` but does NOT currently export a public getter. This plan therefore:

1. **Adds a new `getCachedSiteId()` helper** to `backend/src/services/tableauAuth.ts` that returns the cached siteId, calling `getOrRefreshToken()` internally so callers reuse the existing token-cache + auto-refresh semantics. No new state machine, no duplication.
2. **The `/export/pdf` handler calls `getCachedSiteId()` BEFORE URL construction**, then interpolates the real site ID via a template literal: `` `${serverUrl}/api/3.19/sites/${siteId}/workbooks/${luid}/pdf?...` `` — no `{siteId}` placeholder reaches the wire.
3. **Evidence:** `backend/src/services/tableauFetch.ts` lines 31–50 show the pure passthrough (no substitution). `backend/src/services/tableauAuth.ts` lines 171–187 show `getOrRefreshToken()` + `forceRefreshToken()` as the only exported helpers; no siteId getter. `backend/src/services/tokenCache.ts` line 15–22 shows `CachedToken.siteId` is readable via `tokenCache.get()`.

**Wave-assignment fix (Warning 8):** This plan does NOT import any types from Plan 03-01 — validation uses plain LUID regex, error responses use hard-coded string codes, and the new helper only imports from `tokenCache.ts` + existing internal state. Dropping `depends_on: [03-01]` moves this plan into Wave 1 (shortens critical path; export routes run in parallel with types/parser/prompt builder). The plan's frontmatter reflects `wave: 1, depends_on: []`.

Purpose: These routes are where Phase 3 faces the highest SSRF exposure. D-20 and D-21 are not negotiable — they eliminate the two obvious attack vectors by construction. This plan proves both with offline tests that stub `tableauFetch`, global `fetch`, and the new `getCachedSiteId` helper.

Output: One modified auth file (new helper), one combined route module, one offline test, one npm script.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/routes/health.ts
@backend/src/services/tableauFetch.ts
@backend/src/services/tableauAuth.ts
@backend/src/services/tokenCache.ts
@backend/src/config/env.ts
@CLAUDE.md
</context>

<tasks>

<task type="auto">
  <name>Task 1: Add `getCachedSiteId()` helper to backend/src/services/tableauAuth.ts (Blocker 1 prerequisite)</name>
  <files>backend/src/services/tableauAuth.ts</files>
  <read_first>
    - backend/src/services/tableauAuth.ts (lines 171–187 — see existing `getOrRefreshToken()` and `forceRefreshToken()` so the new helper matches the export conventions, JSDoc style, and auto-refresh semantics)
    - backend/src/services/tokenCache.ts (CachedToken shape — `siteId` is readable via `tokenCache.get()`)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-20 PDF route URL construction)
  </read_first>
  <action>
Add a new exported helper to `backend/src/services/tableauAuth.ts`, appended after the existing `forceRefreshToken()` function (do NOT modify anything already in the file — only append). The helper reuses `getOrRefreshToken()` for auto-refresh semantics and reads the siteId from the returned CachedToken:

```typescript
/**
 * Return the Tableau Cloud siteId for the currently-cached token, refreshing
 * the token first if expired or absent. Consumers (Phase 3 PDF export route)
 * use this to interpolate `{siteId}` into REST URLs that take the form
 * `/api/{ver}/sites/{siteId}/...`.
 *
 * Reuses `getOrRefreshToken()` so the token-cache and proactive-refresh
 * semantics from D-28 + D-30 continue to apply — no new state machine.
 */
export async function getCachedSiteId(): Promise<string> {
  const token = await getOrRefreshToken();
  return token.siteId;
}
```

Do NOT touch the existing exports (`authenticate`, `getOrRefreshToken`, `forceRefreshToken`, `TableauAuthError`). Do NOT refactor the CachedToken type. Do NOT change `tokenCache.ts`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "export async function getCachedSiteId" backend/src/services/tableauAuth.ts`
    - `grep -q "await getOrRefreshToken()" backend/src/services/tableauAuth.ts` (the new helper reuses the existing auto-refresh path)
    - Existing exports still present: `grep -q "export async function authenticate" backend/src/services/tableauAuth.ts`, `grep -q "export async function getOrRefreshToken" backend/src/services/tableauAuth.ts`, `grep -q "export async function forceRefreshToken" backend/src/services/tableauAuth.ts`
    - No changes outside the appended helper (spot-check via `git diff backend/src/services/tableauAuth.ts`)
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>`getCachedSiteId()` is exported from tableauAuth.ts and returns the live cached siteId via the existing auto-refresh path. Downstream export route can import and use it.</done>
</task>

<task type="auto">
  <name>Task 2: Implement POST /export/slack + POST /export/pdf in a single module (CTX-16, CTX-17)</name>
  <files>backend/src/routes/export.ts</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-19 Block Kit shape; D-20 PDF streaming through tableauFetch; D-21 webhook-env-only)
    - backend/src/services/tableauFetch.ts (the signature: `tableauFetch(url: string, init: RequestInit = {}): Promise<Response>` — chokepoint for Tableau auth; confirmed NO `{siteId}` substitution)
    - backend/src/services/tableauAuth.ts (the new `getCachedSiteId()` helper from Task 1)
    - backend/src/config/env.ts (env.slackWebhookUrl is `string | undefined`; read lazily, never at boot)
    - backend/src/routes/health.ts (Fastify FastifyPluginAsync pattern)
    - CLAUDE.md ("no hardcoded secrets — everything through .env")
  </read_first>
  <action>
Create `backend/src/routes/export.ts`. The PDF route MUST call `getCachedSiteId()` BEFORE URL construction and interpolate the real site ID via template literal — there must be NO `{siteId}` placeholder string anywhere in the file.

```typescript
/**
 * POST /export/slack — CTX-16 (D-19, D-21)
 * POST /export/pdf   — CTX-17 (D-20)
 *
 * Both routes share a single FastifyPluginAsync so they register together.
 * SSRF defenses:
 *   - /export/slack: webhook URL is ONLY read from env.slackWebhookUrl. No
 *     user-supplied URL — no SSRF surface by construction (D-21).
 *   - /export/pdf:   workbookLuid is validated with LUID_REGEX BEFORE any
 *     URL construction. The validated LUID + the cached siteId (via
 *     getCachedSiteId from tableauAuth.ts) are the ONLY inputs to the URL
 *     template. The validated URL is passed to tableauFetch, the Phase 1
 *     chokepoint (D-20, hard Phase 1 invariant).
 *
 * Blocker 1 fix: the PDF URL uses ${siteId} template interpolation, NOT a
 * `{siteId}` placeholder string — `tableauFetch` does NOT perform site-id
 * substitution, so the URL must be fully materialized before the call.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { tableauFetch } from '../services/tableauFetch.js';
import { getCachedSiteId } from '../services/tableauAuth.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';

const LUID_REGEX = /^[a-f0-9-]{36}$/i;

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'exportRoutes',
});

// ---------- Slack ----------

interface SlackRequestBody {
  narrative: string;
  anomalies: readonly { fieldName: string; value: string }[];
  workbookName: string;
  worksheetName: string;
}

function validateSlackBody(body: unknown): SlackRequestBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.narrative !== 'string' || b.narrative.length === 0) return { error: 'narrative must be a non-empty string' };
  if (!Array.isArray(b.anomalies)) return { error: 'anomalies must be an array' };
  for (const a of b.anomalies) {
    if (!a || typeof a !== 'object') return { error: 'anomaly must be an object' };
    const ao = a as Record<string, unknown>;
    if (typeof ao.fieldName !== 'string' || typeof ao.value !== 'string') {
      return { error: 'anomaly must have string fieldName and value' };
    }
  }
  if (typeof b.workbookName !== 'string') return { error: 'workbookName must be a string' };
  if (typeof b.worksheetName !== 'string') return { error: 'worksheetName must be a string' };
  return b as unknown as SlackRequestBody;
}

function buildBlockKitPayload(body: SlackRequestBody): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${body.workbookName} / ${body.worksheetName}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: body.narrative },
    },
  ];
  if (body.anomalies.length > 0) {
    blocks.push({
      type: 'context',
      elements: body.anomalies.map((a) => ({
        type: 'mrkdwn',
        text: `:warning: ${a.fieldName} = ${a.value}`,
      })),
    });
  }
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Posted from Aperture' }],
  });
  return { blocks };
}

// ---------- PDF ----------

interface PdfRequestBody {
  workbookLuid: string;
}

function validatePdfBody(body: unknown): PdfRequestBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.workbookLuid !== 'string') return { error: 'workbookLuid must be a string' };
  if (!LUID_REGEX.test(b.workbookLuid)) return { error: 'workbookLuid must be a valid LUID' };
  return { workbookLuid: b.workbookLuid };
}

// ---------- Route plugin ----------

export interface ExportRouteDeps {
  /** Override the Slack webhook POST for testing. Defaults to global fetch. */
  slackFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Override tableauFetch for testing. Defaults to the real one. */
  tableauFetchImpl?: typeof tableauFetch;
  /** Override getCachedSiteId for testing. Defaults to the real helper from tableauAuth. */
  getSiteId?: () => Promise<string>;
}

export function createExportRoutes(deps: ExportRouteDeps = {}): FastifyPluginAsync {
  const doSlackFetch = deps.slackFetch ?? ((url, init) => fetch(url, init));
  const doTableauFetch = deps.tableauFetchImpl ?? tableauFetch;
  const doGetSiteId = deps.getSiteId ?? getCachedSiteId;

  return async (app: FastifyInstance) => {
    // ---------- POST /export/slack ----------
    app.post('/export/slack', async (req, reply) => {
      const validated = validateSlackBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      const env = loadEnv();
      // D-21: URL is server-side only. Never from the client.
      if (!env.slackWebhookUrl) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'SLACK_WEBHOOK_URL' });
      }

      const payload = buildBlockKitPayload(validated);
      try {
        const res = await doSlackFetch(env.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          log.warn({ status: res.status }, 'slack webhook returned non-2xx');
          return reply.code(502).send({ error: 'SLACK_WEBHOOK_FAILED', status: res.status });
        }
        return reply.send({ status: 'ok' });
      } catch (err) {
        log.error({ err: (err as Error).message }, 'slack webhook fetch threw');
        return reply.code(502).send({ error: 'SLACK_WEBHOOK_FAILED', message: 'network error' });
      }
    });

    // ---------- POST /export/pdf ----------
    app.post('/export/pdf', async (req, reply) => {
      const validated = validatePdfBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      const env = loadEnv();
      if (!env.tableau) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'TABLEAU_*' });
      }

      // Blocker 1 fix: resolve the real siteId from the cached token BEFORE
      // URL construction. tableauFetch does NOT substitute {siteId}.
      let siteId: string;
      try {
        siteId = await doGetSiteId();
      } catch (err) {
        log.error({ err: (err as Error).message }, 'getCachedSiteId failed');
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'TABLEAU_*' });
      }

      // D-20: build URL from the validated LUID + resolved siteId. Both are
      // under our control (regex-validated LUID; server-side siteId). No
      // `{siteId}` placeholder reaches the wire.
      const baseUrl = env.tableau.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/api/3.19/sites/${siteId}/workbooks/${validated.workbookLuid}/pdf?type=A4&orientation=Portrait`;

      try {
        const tableauRes = await doTableauFetch(url, { method: 'GET' });
        if (!tableauRes.ok) {
          log.warn({ status: tableauRes.status, luid: validated.workbookLuid }, 'tableau pdf returned non-2xx');
          return reply.code(502).send({ error: 'TABLEAU_PDF_FAILED', status: tableauRes.status });
        }

        // D-20: stream the body through, no backend buffering.
        reply.raw.setHeader('Content-Type', 'application/pdf');
        reply.raw.setHeader(
          'Content-Disposition',
          `attachment; filename="aperture-workbook-${validated.workbookLuid}.pdf"`,
        );
        reply.hijack();

        if (!tableauRes.body) {
          reply.raw.end();
          return;
        }
        // Node fetch Response body is a ReadableStream — pipe via Web Streams API.
        const reader = tableauRes.body.getReader();
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(Buffer.from(value));
          }
        } finally {
          reply.raw.end();
        }
      } catch (err) {
        log.error({ err: (err as Error).message, luid: validated.workbookLuid }, 'tableau pdf fetch threw');
        if (!reply.sent && !reply.raw.headersSent) {
          return reply.code(502).send({ error: 'TABLEAU_PDF_FAILED', message: 'network error' });
        }
        reply.raw.end();
      }
    });
  };
}

/** Default export for server.ts — Plan 03-08 will register this. */
export const exportRoutes: FastifyPluginAsync = createExportRoutes();
```
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/routes/export.ts`
    - `grep -q "export const exportRoutes" backend/src/routes/export.ts`
    - `grep -q "export function createExportRoutes" backend/src/routes/export.ts`
    - `grep -q "app.post('/export/slack'" backend/src/routes/export.ts`
    - `grep -q "app.post('/export/pdf'" backend/src/routes/export.ts`
    - `grep -q "LUID_REGEX = /\^\[a-f0-9-\]{36}\$/i" backend/src/routes/export.ts`
    - `grep -q "env.slackWebhookUrl" backend/src/routes/export.ts`
    - `grep -E "body\.(webhookUrl|webhook_url|url)" backend/src/routes/export.ts` returns NO matches (no user-supplied webhook URL)
    - `grep -q "tableauFetch" backend/src/routes/export.ts`
    - `grep -q "Content-Type', 'application/pdf'" backend/src/routes/export.ts`
    - `grep -q "Content-Disposition" backend/src/routes/export.ts`
    - `grep -q "ENV_MISSING" backend/src/routes/export.ts`
    - `grep -q "reply.code(502)" backend/src/routes/export.ts`
    - `grep -q "reply.code(503)" backend/src/routes/export.ts`
    - `grep -q "reply.code(400)" backend/src/routes/export.ts`
    - `grep -q "SLACK_WEBHOOK_FAILED" backend/src/routes/export.ts`
    - `grep -q "TABLEAU_PDF_FAILED" backend/src/routes/export.ts`
    - **Blocker 1 fix (a)**: the new helper is imported: `grep -q "import { getCachedSiteId } from '../services/tableauAuth.js'" backend/src/routes/export.ts`
    - **Blocker 1 fix (b)**: the route calls it: `grep -q "await doGetSiteId()" backend/src/routes/export.ts` (or `grep -q "await getCachedSiteId()" backend/src/routes/export.ts` if the default path is used directly)
    - **Blocker 1 fix (c)**: the URL template uses `${siteId}` (real interpolation), not the literal `{siteId}` placeholder: `grep -q '${siteId}' backend/src/routes/export.ts` AND `! grep -q '{siteId}' backend/src/routes/export.ts`
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - No direct call to global `fetch` for a tableau URL: every `fetch(` match is either `doSlackFetch(` / `(url, init) => fetch(url, init)` for the slack webhook, never a tableau URL
  </acceptance_criteria>
  <done>/export/slack posts Block Kit to env.slackWebhookUrl, /export/pdf validates LUID + resolves real siteId via getCachedSiteId() + builds a fully-materialized URL + streams through tableauFetch. The `{siteId}` placeholder string appears NOWHERE in the file.</done>
</task>

<task type="auto">
  <name>Task 3: Write offline exportRoutes tests with stubbed tableauFetch + stubbed Slack fetch + stubbed getCachedSiteId</name>
  <files>backend/src/services/__tests__/exportRoutes.test.ts, backend/package.json</files>
  <read_first>
    - backend/src/routes/export.ts (from Task 2 — ExportRouteDeps shape now includes `getSiteId`, LUID_REGEX)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-19 Slack Block Kit; D-20 PDF SSRF guard + streaming; D-21 webhook env only)
    - backend/src/services/__tests__/pulseService.empty.test.ts (offline test style)
  </read_first>
  <action>
Create `backend/src/services/__tests__/exportRoutes.test.ts`. Use Fastify's `inject()`. The test passes `getSiteId: async () => 'aaaa-bbbb-cccc-dddd'` (a fake siteId) so the test never touches the real tableauAuth/tokenCache state machine.

Cases:

**Slack:**
1. 400 on empty narrative
2. 400 on malformed anomalies
3. 503 ENV_MISSING when env.slackWebhookUrl is unset — temporarily delete `process.env.SLACK_WEBHOOK_URL`, call `__resetEnvCacheForTests()`, inject, assert 503 + body `{error: 'ENV_MISSING', key: 'SLACK_WEBHOOK_URL'}`
4. 502 when the stubbed slackFetch returns `new Response(null, { status: 500 })`
5. 502 when the stubbed slackFetch throws
6. 200 with `{status: 'ok'}` on happy path
7. **D-21 SSRF guard** — POST with a malicious body including `webhookUrl: 'http://evil.com'`. Assert the stubbed slackFetch was called with `env.slackWebhookUrl`, NOT the body's URL. Specifically: capture all slackFetch calls and assert every URL argument equals `process.env.SLACK_WEBHOOK_URL`.
8. **Block Kit payload shape** — capture the body passed to slackFetch, JSON.parse it, assert `blocks` is an array with at least a `header`, `section`, `divider`, and `context` block.

**PDF:**
9. 400 on missing workbookLuid
10. 400 on non-UUID workbookLuid (`'../../../etc/passwd'`, `'not-a-luid'`, `'12345'`)
11. **D-20 SSRF guard test** — POST with `workbookLuid: 'http://evil.com/path'`. Assert tableauFetch was NEVER called AND getSiteId was NEVER called (validation fails before either).
12. 503 ENV_MISSING when env.tableau is unset
13. 502 when stubbed tableauFetch returns `new Response(null, {status: 404})`
14. Happy path — stubbed tableauFetch returns a Response with a ReadableStream body containing `%PDF-1.4\n...` bytes. Assert:
    - Response Content-Type header is `application/pdf`
    - Response Content-Disposition contains `aperture-workbook-` + the LUID + `.pdf`
    - The streamed body bytes equal the stubbed input bytes
15. Happy path — confirm the tableauFetch URL argument (captured by the stub) contains the validated LUID substring AND the stubbed siteId substring (`'aaaa-bbbb-cccc-dddd'`) AND does NOT contain the literal string `{siteId}`.
16. **(Blocker 1 regression test) `{siteId}` placeholder never reaches the wire** — capture the tableauFetch URL and assert `url.includes('{siteId}') === false`. This is the load-bearing check that proves Blocker 1 is fixed.

For stubs:
- `slackFetch` stub: `async (url, init) => { captured.push({url, init}); return new Response(JSON.stringify({ok:true}), {status: 200}); }`
- `tableauFetchImpl` stub: returns a Response built from a `ReadableStream` over fixed bytes; captures the URL argument for assertion.
- `getSiteId` stub: `async () => 'aaaa-bbbb-cccc-dddd'` — returns a fixed fake siteId.

Add npm script: `"smoke:exportroutes": "tsx src/services/__tests__/exportRoutes.test.ts"` after `smoke:chatroute`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:exportroutes</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/__tests__/exportRoutes.test.ts`
    - `grep -q "smoke:exportroutes" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:exportroutes` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test file has at least 16 test cases (added Blocker 1 regression test): `grep -c "Test [0-9]" backend/src/services/__tests__/exportRoutes.test.ts` returns at least 16
    - Test file contains the SSRF guard assertion: `grep -q "http://evil.com" backend/src/services/__tests__/exportRoutes.test.ts`
    - Test file asserts tableauFetch is NOT called for malicious LUID: `grep -q "tableauFetch.*NEVER\|not.called\|strictEqual.*calls.length.*0" backend/src/services/__tests__/exportRoutes.test.ts`
    - **Blocker 1 regression test**: `grep -q "{siteId}" backend/src/services/__tests__/exportRoutes.test.ts` (the assertion must mention the literal placeholder string it's guarding against)
    - `grep -q "getSiteId" backend/src/services/__tests__/exportRoutes.test.ts` (test uses the stubbed helper)
  </acceptance_criteria>
  <done>Offline tests cover every SSRF path, every validation path, every env-missing path, the happy path for both endpoints, AND the Blocker 1 regression test asserting `{siteId}` never reaches the tableauFetch URL. Neither endpoint can be tricked into hitting an attacker-controlled URL, and the PDF route's URL is fully materialized before the Tableau call.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Client POST body → /export/slack | Untrusted input; narrative + anomalies + workbook/worksheet names. URL is NEVER from client. |
| Client POST body → /export/pdf | Untrusted input; workbookLuid is the only field, validated with UUID regex before URL construction. |
| /export/slack → Slack webhook | Server-side URL from env, posted via fetch. No user influence on destination. |
| /export/pdf → Tableau REST | URL built from env.tableau.serverUrl + cached siteId + validated LUID; call routed through tableauFetch (Phase 1 chokepoint for X-Tableau-Auth). |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-07-01 | **SSRF** (HIGH) | /export/slack webhook URL | mitigate | **D-21**: URL read ONLY from `env.slackWebhookUrl`. Client body NEVER supplies a URL. Task 2 acceptance grep enforces zero matches for `body.webhookUrl` patterns. Task 3 Test 7 explicitly probes with `webhookUrl: 'http://evil.com'` in the body and asserts the stub was called with env.slackWebhookUrl. |
| T-03-07-02 | **SSRF** (HIGH) | /export/pdf workbookLuid | mitigate | **D-20**: `LUID_REGEX = /^[a-f0-9-]{36}$/i` validates workbookLuid BEFORE any URL construction. Task 3 Test 10 and Test 11 probe with non-LUID and URL-shaped inputs and assert tableauFetch is never called. URL construction uses template interpolation only with the regex-validated LUID AND the server-side-resolved siteId from `getCachedSiteId()` — no user-controlled component. Task 3 Test 16 is the Blocker 1 regression test: captured URL must not contain the literal `{siteId}` string. |
| T-03-07-03 | **DoS** (HIGH) | /export/pdf huge file consuming memory | mitigate | **D-20**: response body is piped through via `reader.read()` loop; no backend buffering. Task 3 Test 14 asserts streaming body bytes equal stubbed input without a full-load materialization step. |
| T-03-07-04 | DoS | Unbounded export requests | mitigate | Plan 03-08 adds rate limit 10/min/IP for both /export/* routes per D-22. |
| T-03-07-05 | Information Disclosure | Tableau session token leakage | mitigate | `tableauFetch` is the only place the session header is touched (Phase 1 invariant). This route never constructs `X-Tableau-Auth` headers. Grep-verifiable: `grep -q "X-Tableau-Auth" backend/src/routes/export.ts` returns no matches. |
| T-03-07-06 | Information Disclosure | PDF content as a side channel | accept | PDFs come from Tableau workbooks the authenticated PAT already has access to. A caller who can reach this backend already has access via the same PAT. Not a new exposure surface. |
| T-03-07-07 | Injection | Slack Block Kit text injection | mitigate | `narrative` is wrapped in an `mrkdwn` section — Slack's own renderer sanitizes. Anomaly `fieldName` / `value` pass through in `:warning:` text blocks; no shell, no SQL, no template evaluation. |
| T-03-07-08 | Information Disclosure | siteId leakage via logs | accept | `getCachedSiteId()` returns the Tableau site ID — a semi-public identifier already present in dashboard URLs. The new helper does not log the siteId itself; existing tableauAuth logging already records siteId at info level in `authenticate()` (Phase 1 pattern). No new disclosure surface. |

Two HIGH threats (T-03-07-01 SSRF Slack, T-03-07-02 SSRF PDF) both mitigated by D-20/D-21 with explicit offline test coverage.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:exportroutes` exits 0
- `pnpm --filter @aperture/backend typecheck` exits 0
- Routes NOT yet registered in server.ts (Plan 03-08 owns server.ts)
- No direct `fetch('http' + tableau...)` call — all Tableau HTTP goes through tableauFetch
- `grep -q "getCachedSiteId" backend/src/services/tableauAuth.ts` matches (Task 1 added the helper)
- `grep -q "{siteId}" backend/src/routes/export.ts` returns NO matches (the literal placeholder is NOT in the file)
</verification>

<success_criteria>
- /export/slack posts to env.slackWebhookUrl with Block Kit payload
- /export/slack returns 503 / 502 / 400 per D-19
- /export/pdf validates LUID with UUID regex
- /export/pdf resolves real siteId via `getCachedSiteId()` before URL construction (Blocker 1 fix)
- /export/pdf URL template uses `${siteId}` interpolation, never the literal `{siteId}` placeholder
- /export/pdf streams binary body without buffering
- Both SSRF defenses have explicit test coverage
- Blocker 1 regression test (Test 16) asserts `{siteId}` never reaches the tableauFetch URL
- No tableau HTTP bypasses tableauFetch
- Wave assignment is 1 (no dependency on Plan 03-01; Warning 8 fix)
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-07-SUMMARY.md`
</output>
