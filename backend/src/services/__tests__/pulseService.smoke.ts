/**
 * Live smoke test: calls `fetchPulseContext(datasourceLuid)` against the real
 * Tableau Cloud sandbox Pulse REST API using credentials from `.env`.
 *
 * Run with (one of):
 *   npx tsx backend/src/services/__tests__/pulseService.smoke.ts \
 *     --datasource <datasource-luid>
 *   APERTURE_SMOKE_PULSE_DATASOURCE_LUID=<luid> \
 *     npx tsx backend/src/services/__tests__/pulseService.smoke.ts
 *
 * NOTE: a `smoke:pulse` npm script is deferred to Plan 02-05 per the Phase 2
 * plan split — DO NOT edit `backend/package.json` in this plan.
 *
 * Three acceptable exit-0 outcomes:
 *   1. Credentials missing → prints TableauAuthError "not configured" and exits 0
 *      (cold-boot on a fresh checkout).
 *   2. No `--datasource` argument → prints usage help and exits 0 (no-op smoke).
 *   3. Live call succeeds — either:
 *        a. populated PulseContext (`hasMetrics: true`) → TAPI-07/08/09 live path
 *        b. empty PulseContext (`hasMetrics: false`)    → TAPI-10 live path
 *
 * Exit 1 on PulseServiceError, unexpected errors, or inconsistent state
 * (`hasMetrics: true` but `metricDefinitions` empty).
 *
 * PII DISCIPLINE: this script NEVER prints the raw insight bundles array —
 * insight bundle summaries contain AI-generated text that may include customer
 * data. Only counts and at most the first metric NAME are printed. The
 * 02-04 plan's acceptance criteria grep-enforces that no console.log statement
 * dumps the raw bundles field directly; see the acceptance_criteria regex.
 */
import { fetchPulseContext, PulseServiceError } from '../pulseService.js';
import { TableauAuthError } from '../tableauAuth.js';

const NOT_CONFIGURED_MARKER = 'Tableau credentials not configured';

function parseDatasourceArg(): string | undefined {
  // 1) Prefer env var so CI systems can set it without argv plumbing.
  const fromEnv = process.env.APERTURE_SMOKE_PULSE_DATASOURCE_LUID;
  if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();

  // 2) `--datasource <luid>` or `--datasource=<luid>`
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--datasource' && i + 1 < argv.length) return argv[i + 1];
    if (a?.startsWith('--datasource=')) return a.slice('--datasource='.length);
  }
  return undefined;
}

function printUsageAndExit(): never {
  console.log('[smoke] pulseService.smoke.ts — live Pulse REST smoke test');
  console.log('');
  console.log('Usage:');
  console.log('  npx tsx backend/src/services/__tests__/pulseService.smoke.ts --datasource <luid>');
  console.log('  APERTURE_SMOKE_PULSE_DATASOURCE_LUID=<luid> npx tsx backend/src/services/__tests__/pulseService.smoke.ts');
  console.log('');
  console.log('No --datasource provided — exiting 0 (cold-boot, no-op).');
  process.exit(0);
}

async function main(): Promise<void> {
  const datasourceLuid = parseDatasourceArg();
  if (!datasourceLuid) {
    printUsageAndExit();
  }

  console.log(`[smoke] Fetching PulseContext for datasource ${datasourceLuid}...`);
  const ctx = await fetchPulseContext(datasourceLuid);

  // Print counts + one metric name ONLY — never raw bundles.
  const summary = {
    datasourceLuid: ctx.datasourceLuid,
    hasMetrics: ctx.hasMetrics,
    metricCount: ctx.metricDefinitions.length,
    bundleCount: ctx.insightBundles.length,
    feedbackCount: ctx.feedback.length,
    firstMetricName: ctx.metricDefinitions[0]?.name ?? null,
  };
  console.log('[smoke] pulseService returned:');
  console.log(JSON.stringify(summary, null, 2));

  if (!ctx.hasMetrics) {
    console.log(
      '[smoke] PASS: datasource has no Pulse metrics — graceful empty return (TAPI-10 live path)',
    );
    process.exit(0);
  }

  // Happy path — hasMetrics: true must be consistent with a non-empty metric list.
  if (ctx.metricDefinitions.length === 0) {
    console.error('[smoke] FAIL: hasMetrics=true but metricDefinitions empty — inconsistent state');
    process.exit(1);
  }
  console.log(
    `[smoke] PASS: PulseContext has ${ctx.metricDefinitions.length} metric(s), ${ctx.insightBundles.length} bundle(s), ${ctx.feedback.length} feedback entries (TAPI-07/08/09)`,
  );
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof TableauAuthError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
    console.log(
      `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live Pulse smoke test (will verify once .env is populated)`,
    );
    process.exit(0);
  }
  if (err instanceof TableauAuthError) {
    console.error(`[smoke] TableauAuthError: ${err.message}`);
    if (err.status !== undefined) {
      console.error(`[smoke]   HTTP status: ${err.status}`);
    }
    process.exit(1);
  }
  if (err instanceof PulseServiceError) {
    console.error(`[smoke] PulseServiceError: ${err.message}`);
    process.exit(1);
  }
  console.error('[smoke] Unexpected error:', err);
  process.exit(1);
});
