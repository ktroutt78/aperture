/**
 * TAPI-10 — OFFLINE unit test for Pulse graceful empty-metrics degradation.
 *
 * This test is the load-bearing proof of the CLAUDE.md HARD ground rule:
 *   "Degrade gracefully if any Tableau API returns empty — never crash the panel"
 *
 * It runs WITHOUT any network access, WITHOUT any Tableau credentials, WITHOUT
 * any test framework. Invocation:
 *   `npx tsx backend/src/services/__tests__/pulseService.empty.test.ts`
 *
 * Exit 0 = TAPI-10 holds. Exit 1 = regression — pulseService either threw on
 * an empty-metrics path or returned a non-empty/non-false PulseContext.
 *
 * Three cases are exercised, each short-circuited at the /definitions endpoint:
 *   A. empty-definitions — HTTP 200 with `{ definitions: [] }`
 *   B. definitions-404   — HTTP 404 (tenant disabled Pulse or no access)
 *   C. definitions-403   — HTTP 403 (caller lacks Pulse scope)
 *
 * In each case `fetchPulseContext(fakeLuid)` must:
 *   1. NOT throw
 *   2. Return { hasMetrics: false, metricDefinitions: [], insightBundles: [], feedback: [], datasourceLuid: <echoed> }
 *   3. NOT call insights:generate (optimization check for the empty-definitions
 *      case — once we know there are zero metrics we must not waste a round-trip)
 *
 * How this works without a test framework:
 *   - Env vars are stubbed BEFORE importing pulseService so loadEnv() returns a
 *     valid env.tableau shape.
 *   - tokenCache is seeded with a fake token so tableauFetch's getOrRefreshToken
 *     is satisfied without ever calling real signin.
 *   - globalThis.fetch is monkey-patched to key off URL substrings and return
 *     canned Response objects for each endpoint. A closed-over `caseStatus` /
 *     `caseBody` lets us flip the definitions response between test cases.
 *   - pulseService is imported dynamically AFTER the env + fetch stubs are in
 *     place so the module picks up the mocked environment.
 */
import { tokenCache } from '../tokenCache.js';

// ---------------------------------------------------------------------------
// 1) Stub env vars BEFORE importing anything that calls loadEnv().
// ---------------------------------------------------------------------------
process.env.PORT ||= '3001';
process.env.EXTENSION_ORIGIN ||= 'http://localhost:5173';
process.env.TABLEAU_SERVER_URL ||= 'https://fake.online.tableau.com';
process.env.TABLEAU_SITE_NAME ||= 'fake-site';
process.env.TABLEAU_PAT_NAME ||= 'fake-pat';
process.env.TABLEAU_PAT_SECRET ||= 'fake-secret';

// Reset any cached env so the stubbed values take effect.
const envModule = await import('../../config/env.js');
envModule.__resetEnvCacheForTests();

// ---------------------------------------------------------------------------
// 2) Seed tokenCache so tableauFetch.getOrRefreshToken() returns instantly
//    without trying to call the real signin endpoint.
// ---------------------------------------------------------------------------
tokenCache.set({
  token: 'FAKE_TOKEN_FOR_TEST',
  siteId: 'fake-site-id',
  expiresAt: Date.now() + 60_000, // valid for 1 minute
});

// ---------------------------------------------------------------------------
// 3) Monkey-patch globalThis.fetch with controlled responses.
// ---------------------------------------------------------------------------
const realFetch = globalThis.fetch;

// Closed-over state that each test case mutates before invoking fetchPulseContext.
let caseStatus = 200;
let caseBody: unknown = { definitions: [] };
let insightsGenerateCallCount = 0;

function makeRes(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).fetch = (async (
  url: string | URL | Request,
  _init?: RequestInit,
): Promise<Response> => {
  const u =
    typeof url === 'string'
      ? url
      : url instanceof URL
        ? url.toString()
        : (url as Request).url;

  if (u.includes('/api/-/pulse/definitions')) {
    return makeRes(caseStatus, caseBody);
  }
  if (u.includes('/api/-/pulse/insights:generate')) {
    insightsGenerateCallCount++;
    return makeRes(200, { bundles: [] });
  }
  if (u.includes('/api/-/pulse/user/preferences')) {
    return makeRes(200, { insight_feedback: [] });
  }
  // Any other URL (signin, etc) — fail loudly so regressions are visible.
  return makeRes(404, { mocked: true, url: u });
}) as typeof globalThis.fetch;

// ---------------------------------------------------------------------------
// 4) Dynamically import pulseService AFTER env + fetch stubs are in place.
// ---------------------------------------------------------------------------
const { fetchPulseContext } = await import('../pulseService.js');

const FAKE_LUID = '12345678-1234-1234-1234-123456789012';
import type { PulseContext } from '../../types/tableau.js';

interface TestCase {
  readonly label: string;
  readonly status: number;
  readonly body: unknown;
}

const cases: readonly TestCase[] = [
  { label: 'empty-definitions', status: 200, body: { definitions: [] } },
  { label: 'definitions-404', status: 404, body: {} },
  { label: 'definitions-403', status: 403, body: {} },
];

function fail(label: string, msg: string): never {
  console.error(`[test] FAIL (${label}): ${msg}`);
  // Restore real fetch before exiting to keep Node happy.
  globalThis.fetch = realFetch;
  process.exit(1);
}

async function run(): Promise<void> {
  for (const tc of cases) {
    caseStatus = tc.status;
    caseBody = tc.body;
    insightsGenerateCallCount = 0;

    let ctx: PulseContext;
    try {
      ctx = await fetchPulseContext(FAKE_LUID);
    } catch (err) {
      fail(tc.label, `fetchPulseContext threw — TAPI-10 violated: ${(err as Error).message}`);
    }

    if (ctx.hasMetrics !== false) {
      fail(tc.label, `hasMetrics should be false, got ${String(ctx.hasMetrics)}`);
    }
    if (ctx.metricDefinitions.length !== 0) {
      fail(tc.label, `metricDefinitions should be empty, got length ${ctx.metricDefinitions.length}`);
    }
    if (ctx.insightBundles.length !== 0) {
      fail(tc.label, `insightBundles should be empty, got length ${ctx.insightBundles.length}`);
    }
    if (ctx.feedback.length !== 0) {
      fail(tc.label, `feedback should be empty, got length ${ctx.feedback.length}`);
    }
    if (ctx.datasourceLuid !== FAKE_LUID) {
      fail(tc.label, `datasourceLuid not echoed — got ${ctx.datasourceLuid}`);
    }

    // Optimization guarantee: when the definitions endpoint says "no metrics"
    // the service MUST NOT fan out to insights:generate. A regression here
    // wouldn't break TAPI-10's correctness, but it would waste a round-trip on
    // every metric-less datasource (Phase 3 fans out to N datasources at once).
    if (tc.label === 'empty-definitions' && insightsGenerateCallCount !== 0) {
      fail(
        tc.label,
        `service called insights:generate ${insightsGenerateCallCount} time(s) despite zero definitions`,
      );
    }

    console.log(`[test] PASS (${tc.label}): graceful empty PulseContext (TAPI-10)`);
  }

  // Restore real fetch and exit clean.
  globalThis.fetch = realFetch;
  console.log('[test] All three TAPI-10 graceful-degradation cases passed.');
  process.exit(0);
}

run().catch((err) => {
  console.error('[test] Fatal (outside per-case handler):', err);
  globalThis.fetch = realFetch;
  process.exit(1);
});
