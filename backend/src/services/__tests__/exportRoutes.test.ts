/**
 * exportRoutes — OFFLINE test suite for Plan 03-07 (CTX-16 + CTX-17).
 *
 * This suite covers both export routes and their SSRF / validation
 * defenses WITHOUT any network access, WITHOUT any Tableau credentials,
 * and WITHOUT any real slack webhook. Invocation:
 *   `pnpm --filter @aperture/backend smoke:exportroutes`
 *
 * Exit 0 = plan holds. Exit 1 = regression.
 *
 * Test surface (16 cases):
 *
 *   Slack (/export/slack):
 *     1.  400 on empty narrative
 *     2.  400 on malformed anomalies
 *     3.  503 ENV_MISSING when SLACK_WEBHOOK_URL is unset
 *     4.  502 when stubbed slackFetch returns non-2xx
 *     5.  502 when stubbed slackFetch throws
 *     6.  200 happy path
 *     7.  D-21 SSRF guard — client body supplying `webhookUrl: http://evil.com`
 *         must NOT influence the destination URL
 *     8.  Block Kit payload shape — header/section/divider/context blocks
 *
 *   PDF (/export/pdf):
 *     9.  400 on missing workbookLuid
 *     10. 400 on non-UUID workbookLuid (multiple malformed inputs)
 *     11. D-20 SSRF guard — URL-shaped LUID never reaches tableauFetch or getSiteId
 *     12. 503 ENV_MISSING when env.tableau is unset
 *     13. 502 when stubbed tableauFetch returns 404
 *     14. Happy path streams the stubbed body bytes unchanged
 *     15. tableauFetch URL contains validated LUID + stubbed siteId
 *     16. Blocker 1 regression — captured URL must NOT contain the literal
 *         placeholder string `{siteId}` (the fix we are guarding against).
 *
 * No external test framework — plain tsx + asserts + process.exit.
 */
import Fastify, { type FastifyInstance } from 'fastify';

// ---------------------------------------------------------------------------
// 1) Stub env vars BEFORE importing anything that calls loadEnv().
// ---------------------------------------------------------------------------
process.env.PORT ||= '3001';
process.env.EXTENSION_ORIGIN ||= 'http://localhost:5173';
process.env.TABLEAU_SERVER_URL = 'https://fake.online.tableau.com';
process.env.TABLEAU_SITE_NAME = 'fake-site';
process.env.TABLEAU_PAT_NAME = 'fake-pat';
process.env.TABLEAU_PAT_SECRET = 'fake-secret';
process.env.SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/FAKE/WEBHOOK/URL';

const envModule = await import('../../config/env.js');
envModule.__resetEnvCacheForTests();

// Import route factory AFTER env is stubbed.
const { createExportRoutes } = await import('../../routes/export.js');

// ---------------------------------------------------------------------------
// 2) Helpers.
// ---------------------------------------------------------------------------
const FAKE_SITE_ID = 'aaaa-bbbb-cccc-dddd';
const GOOD_LUID = '12345678-1234-1234-1234-123456789012';

interface SlackCapture {
  url: string;
  init: RequestInit;
}

interface TableauCapture {
  url: string;
  init: RequestInit;
}

function fail(label: string, msg: string): never {
  console.error(`[test] FAIL (${label}): ${msg}`);
  process.exit(1);
}

function assertEqual<T>(label: string, actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    fail(label, `${msg}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(label: string, cond: boolean, msg: string): void {
  if (!cond) fail(label, msg);
}

/**
 * Build a fresh Fastify app with stubbed export-route dependencies.
 * Each test case gets its own app so state does not bleed between cases.
 */
async function buildApp(opts: {
  slackFetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  tableauFetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  getSiteIdImpl?: () => Promise<string>;
  slackCaptures?: SlackCapture[];
  tableauCaptures?: TableauCapture[];
  getSiteIdCalls?: { count: number };
}): Promise<FastifyInstance> {
  const slackStub =
    opts.slackFetchImpl ??
    (async (url: string, init: RequestInit) => {
      opts.slackCaptures?.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

  const tableauStub =
    opts.tableauFetchImpl ??
    (async (url: string, init: RequestInit) => {
      opts.tableauCaptures?.push({ url, init });
      return new Response(null, { status: 200 });
    });

  const getSiteIdStub =
    opts.getSiteIdImpl ??
    (async () => {
      if (opts.getSiteIdCalls) opts.getSiteIdCalls.count++;
      return FAKE_SITE_ID;
    });

  const app = Fastify({ logger: false });
  await app.register(
    createExportRoutes({
      slackFetch: slackStub,
      tableauFetchImpl: tableauStub as unknown as (
        url: string,
        init?: RequestInit,
      ) => Promise<Response>,
      getSiteId: getSiteIdStub,
    }),
  );
  await app.ready();
  return app;
}

// Tracking counters to assert Test 11 and happy-path isolation.
function makeCounter(): { count: number } {
  return { count: 0 };
}

// ---------------------------------------------------------------------------
// 3) Tests.
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  // -------------------- SLACK --------------------

  // Test 1 — 400 on empty narrative
  {
    const label = 'Test 1: slack empty narrative -> 400';
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: '',
        anomalies: [],
        workbookName: 'wb',
        worksheetName: 'ws',
      },
    });
    assertEqual(label, res.statusCode, 400, 'status');
    const body = res.json() as { error: string };
    assertEqual(label, body.error, 'BAD_REQUEST', 'error code');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 2 — 400 on malformed anomalies
  {
    const label = 'Test 2: slack malformed anomalies -> 400';
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'hello',
        anomalies: [{ wrong: 'shape' }],
        workbookName: 'wb',
        worksheetName: 'ws',
      },
    });
    assertEqual(label, res.statusCode, 400, 'status');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 3 — 503 ENV_MISSING when SLACK_WEBHOOK_URL is unset
  {
    const label = 'Test 3: slack env missing -> 503';
    const savedWebhook = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    envModule.__resetEnvCacheForTests();
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'hello',
        anomalies: [],
        workbookName: 'wb',
        worksheetName: 'ws',
      },
    });
    assertEqual(label, res.statusCode, 503, 'status');
    const body = res.json() as { error: string; key: string };
    assertEqual(label, body.error, 'ENV_MISSING', 'error code');
    assertEqual(label, body.key, 'SLACK_WEBHOOK_URL', 'env key');
    // Restore for subsequent tests.
    process.env.SLACK_WEBHOOK_URL = savedWebhook;
    envModule.__resetEnvCacheForTests();
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 4 — 502 when stubbed slackFetch returns non-2xx
  {
    const label = 'Test 4: slack upstream 500 -> 502';
    const app = await buildApp({
      slackFetchImpl: async () => new Response(null, { status: 500 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'hello',
        anomalies: [],
        workbookName: 'wb',
        worksheetName: 'ws',
      },
    });
    assertEqual(label, res.statusCode, 502, 'status');
    const body = res.json() as { error: string };
    assertEqual(label, body.error, 'SLACK_WEBHOOK_FAILED', 'error code');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 5 — 502 when stubbed slackFetch throws
  {
    const label = 'Test 5: slack upstream throws -> 502';
    const app = await buildApp({
      slackFetchImpl: async () => {
        throw new Error('simulated network error');
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'hello',
        anomalies: [],
        workbookName: 'wb',
        worksheetName: 'ws',
      },
    });
    assertEqual(label, res.statusCode, 502, 'status');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 6 — 200 happy path
  {
    const label = 'Test 6: slack happy path -> 200';
    const captures: SlackCapture[] = [];
    const app = await buildApp({ slackCaptures: captures });
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'Sales dropped 12% QoQ',
        anomalies: [{ fieldName: 'Region', value: 'West' }],
        workbookName: 'Sales',
        worksheetName: 'Overview',
      },
    });
    assertEqual(label, res.statusCode, 200, 'status');
    const body = res.json() as { status: string };
    assertEqual(label, body.status, 'ok', 'status ok');
    assertEqual(label, captures.length, 1, 'slackFetch call count');
    assertEqual(
      label,
      captures[0]!.url,
      process.env.SLACK_WEBHOOK_URL!,
      'destination url',
    );
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 7 — D-21 SSRF guard: malicious body `webhookUrl` is IGNORED
  {
    const label = 'Test 7: slack D-21 SSRF guard ignores body.webhookUrl';
    const captures: SlackCapture[] = [];
    const app = await buildApp({ slackCaptures: captures });
    const res = await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'hello',
        anomalies: [],
        workbookName: 'wb',
        worksheetName: 'ws',
        // Malicious extras — must have zero effect on destination.
        webhookUrl: 'http://evil.com/steal',
        webhook_url: 'http://evil.com/steal',
        url: 'http://evil.com/steal',
      } as unknown as Record<string, unknown>,
    });
    assertEqual(label, res.statusCode, 200, 'status');
    assertEqual(label, captures.length, 1, 'slackFetch call count');
    // Every call's URL arg must equal the env-configured webhook.
    for (const c of captures) {
      assertEqual(label, c.url, process.env.SLACK_WEBHOOK_URL!, 'captured url');
      assertTrue(
        label,
        !c.url.includes('evil.com'),
        'captured url must not contain evil.com',
      );
    }
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 8 — Block Kit payload shape
  {
    const label = 'Test 8: slack Block Kit payload shape';
    const captures: SlackCapture[] = [];
    const app = await buildApp({ slackCaptures: captures });
    await app.inject({
      method: 'POST',
      url: '/export/slack',
      payload: {
        narrative: 'Sales dropped 12%',
        anomalies: [{ fieldName: 'Region', value: 'West' }],
        workbookName: 'Sales',
        worksheetName: 'Overview',
      },
    });
    assertEqual(label, captures.length, 1, 'slackFetch call count');
    const raw = captures[0]!.init.body;
    assertTrue(label, typeof raw === 'string', 'body must be a string');
    const parsed = JSON.parse(raw as string) as {
      blocks: Array<{ type: string }>;
    };
    assertTrue(
      label,
      Array.isArray(parsed.blocks),
      'blocks must be an array',
    );
    const types = parsed.blocks.map((b) => b.type);
    assertTrue(label, types.includes('header'), 'header block present');
    assertTrue(label, types.includes('section'), 'section block present');
    assertTrue(label, types.includes('divider'), 'divider block present');
    assertTrue(label, types.includes('context'), 'context block present');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // -------------------- PDF --------------------

  // Test 9 — 400 on missing workbookLuid
  {
    const label = 'Test 9: pdf missing luid -> 400';
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: {},
    });
    assertEqual(label, res.statusCode, 400, 'status');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 10 — 400 on non-UUID workbookLuid (multiple inputs)
  {
    const label = 'Test 10: pdf non-uuid luid -> 400';
    const malformed = ['../../../etc/passwd', 'not-a-luid', '12345'];
    for (const luid of malformed) {
      const app = await buildApp({});
      const res = await app.inject({
        method: 'POST',
        url: '/export/pdf',
        payload: { workbookLuid: luid },
      });
      assertEqual(`${label} (${luid})`, res.statusCode, 400, 'status');
      await app.close();
    }
    console.log(`[test] PASS: ${label}`);
  }

  // Test 11 — D-20 SSRF guard: URL-shaped LUID never reaches tableauFetch/getSiteId
  {
    const label = 'Test 11: pdf D-20 SSRF guard';
    const tableauCaptures: TableauCapture[] = [];
    const getSiteIdCalls = makeCounter();
    const app = await buildApp({
      tableauCaptures,
      getSiteIdCalls,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: 'http://evil.com/path' },
    });
    assertEqual(label, res.statusCode, 400, 'status');
    // tableauFetch was NEVER called — validation fails before either is touched.
    assertEqual(label, tableauCaptures.length, 0, 'tableauFetch call count');
    assertEqual(label, getSiteIdCalls.count, 0, 'getSiteId call count');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 12 — 503 ENV_MISSING when env.tableau is unset
  {
    const label = 'Test 12: pdf env missing -> 503';
    const saved = {
      serverUrl: process.env.TABLEAU_SERVER_URL,
      siteName: process.env.TABLEAU_SITE_NAME,
      patName: process.env.TABLEAU_PAT_NAME,
      patSecret: process.env.TABLEAU_PAT_SECRET,
    };
    delete process.env.TABLEAU_SERVER_URL;
    delete process.env.TABLEAU_SITE_NAME;
    delete process.env.TABLEAU_PAT_NAME;
    delete process.env.TABLEAU_PAT_SECRET;
    envModule.__resetEnvCacheForTests();
    const app = await buildApp({});
    const res = await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: GOOD_LUID },
    });
    assertEqual(label, res.statusCode, 503, 'status');
    const body = res.json() as { error: string; key: string };
    assertEqual(label, body.error, 'ENV_MISSING', 'error code');
    // Restore.
    if (saved.serverUrl) process.env.TABLEAU_SERVER_URL = saved.serverUrl;
    if (saved.siteName !== undefined) process.env.TABLEAU_SITE_NAME = saved.siteName;
    if (saved.patName) process.env.TABLEAU_PAT_NAME = saved.patName;
    if (saved.patSecret) process.env.TABLEAU_PAT_SECRET = saved.patSecret;
    envModule.__resetEnvCacheForTests();
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 13 — 502 when stubbed tableauFetch returns 404
  {
    const label = 'Test 13: pdf upstream 404 -> 502';
    const app = await buildApp({
      tableauFetchImpl: async () => new Response(null, { status: 404 }),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: GOOD_LUID },
    });
    assertEqual(label, res.statusCode, 502, 'status');
    const body = res.json() as { error: string };
    assertEqual(label, body.error, 'TABLEAU_PDF_FAILED', 'error code');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 14 — Happy path streams body bytes unchanged + correct headers
  {
    const label = 'Test 14: pdf happy path streams bytes + headers';
    const fakePdfBytes = new TextEncoder().encode('%PDF-1.4\nfake pdf content\n%%EOF');
    const tableauCaptures: TableauCapture[] = [];
    const app = await buildApp({
      tableauCaptures,
      tableauFetchImpl: async (url: string, init: RequestInit) => {
        tableauCaptures.push({ url, init });
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(fakePdfBytes);
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: GOOD_LUID },
    });
    assertEqual(label, res.statusCode, 200, 'status');
    assertEqual(
      label,
      res.headers['content-type'],
      'application/pdf',
      'content-type header',
    );
    const disposition = res.headers['content-disposition'];
    assertTrue(
      label,
      typeof disposition === 'string' &&
        disposition.includes('aperture-workbook-') &&
        disposition.includes(GOOD_LUID) &&
        disposition.includes('.pdf'),
      `content-disposition should include filename with luid, got: ${String(disposition)}`,
    );
    // Compare raw bytes — res.rawPayload is a Buffer.
    const rawPayload = res.rawPayload;
    assertTrue(
      label,
      rawPayload.length === fakePdfBytes.length,
      `streamed byte length mismatch: expected ${fakePdfBytes.length}, got ${rawPayload.length}`,
    );
    for (let i = 0; i < fakePdfBytes.length; i++) {
      if (rawPayload[i] !== fakePdfBytes[i]) {
        fail(label, `byte mismatch at index ${i}`);
      }
    }
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 15 — tableauFetch URL contains validated LUID + stubbed siteId
  {
    const label = 'Test 15: pdf URL contains luid + siteId';
    const tableauCaptures: TableauCapture[] = [];
    const app = await buildApp({
      tableauCaptures,
      tableauFetchImpl: async (url: string, init: RequestInit) => {
        tableauCaptures.push({ url, init });
        return new Response(null, { status: 200 });
      },
    });
    await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: GOOD_LUID },
    });
    assertEqual(label, tableauCaptures.length, 1, 'tableauFetch call count');
    const capturedUrl = tableauCaptures[0]!.url;
    assertTrue(
      label,
      capturedUrl.includes(GOOD_LUID),
      `url should contain luid, got: ${capturedUrl}`,
    );
    assertTrue(
      label,
      capturedUrl.includes(FAKE_SITE_ID),
      `url should contain stubbed siteId (${FAKE_SITE_ID}), got: ${capturedUrl}`,
    );
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 16 — Blocker 1 regression: the literal `{siteId}` placeholder string
  // must NEVER reach the wire. This is the load-bearing check for Blocker 1.
  {
    const label = 'Test 16: Blocker 1 regression — no {siteId} literal in URL';
    const tableauCaptures: TableauCapture[] = [];
    const app = await buildApp({
      tableauCaptures,
      tableauFetchImpl: async (url: string, init: RequestInit) => {
        tableauCaptures.push({ url, init });
        return new Response(null, { status: 200 });
      },
    });
    await app.inject({
      method: 'POST',
      url: '/export/pdf',
      payload: { workbookLuid: GOOD_LUID },
    });
    assertEqual(label, tableauCaptures.length, 1, 'tableauFetch call count');
    const capturedUrl = tableauCaptures[0]!.url;
    // The literal string `{siteId}` must NOT appear anywhere in the URL.
    assertTrue(
      label,
      !capturedUrl.includes('{siteId}'),
      `URL must not contain literal {siteId} placeholder, got: ${capturedUrl}`,
    );
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  console.log('\n[test] All 16 export route cases passed (CTX-16 + CTX-17).');
  process.exit(0);
}

run().catch((err) => {
  console.error('[test] Fatal (outside per-case handler):', err);
  process.exit(1);
});
