/**
 * Smoke test: calls `queryVizqlDatasource()` against a real Tableau Cloud
 * datasource using credentials from `.env`, prints a redacted summary of the
 * returned `LiveDataContext`, and asserts the Phase 2 hard invariants hold.
 *
 * Run (ad-hoc during Plan 02-03 — script registration happens in 02-05):
 *   npx tsx backend/src/services/__tests__/vizqlService.smoke.ts \
 *     --datasource <LUID> \
 *     --field "Sales" --field "Region" \
 *     [--limit 100]
 *
 * Env fallbacks if CLI flags are omitted:
 *   APERTURE_SMOKE_VIZQL_DATASOURCE_LUID=<LUID>
 *   APERTURE_SMOKE_VIZQL_FIELDS="Sales,Region"       (comma-separated)
 *   APERTURE_SMOKE_VIZQL_LIMIT=100                   (optional)
 *
 * Three acceptable outcomes (all exit 0):
 *   1. Credentials populated + datasource/fields supplied → live query → PASS
 *      line with row count and transport.
 *   2. Tableau credentials empty → expected cold-boot skip. Proves the
 *      `env.tableau undefined` guard fires.
 *   3. CLI args + env fallbacks both missing → prints usage help and exits 0
 *      (cold-boot path; CI can run this without needing a datasource LUID).
 *
 * Hard-invariant assertions when live:
 *   - TAPI-03: `ctx.rows.length <= 500` — fail exit 1 if violated.
 *   - TAPI-05: `ctx.transport === 'sse' || 'json'` — fail exit 1 if not.
 *
 * This script NEVER prints full rows beyond `firstRow`, and NEVER prints
 * process.env. All logging is through console so that pino redact rules
 * aren't the only thing protecting secrets on this path.
 */
import { queryVizqlDatasource, VizqlServiceError, VIZQL_MAX_ROWS } from '../vizqlService.js';
import { TableauAuthError } from '../tableauAuth.js';

const NOT_CONFIGURED_MARKER = 'Tableau credentials not configured';

interface CliArgs {
  readonly datasourceLuid: string | undefined;
  readonly fields: readonly string[];
  readonly limit: number | undefined;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let datasourceLuid: string | undefined;
  const fields: string[] = [];
  let limit: number | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--datasource' && i + 1 < argv.length) {
      datasourceLuid = argv[++i];
    } else if (arg === '--field' && i + 1 < argv.length) {
      fields.push(argv[++i]!);
    } else if (arg === '--limit' && i + 1 < argv.length) {
      const raw = argv[++i]!;
      const n = Number(raw);
      if (Number.isFinite(n) && n > 0) limit = n;
    }
  }

  // Env fallbacks
  if (!datasourceLuid && process.env.APERTURE_SMOKE_VIZQL_DATASOURCE_LUID) {
    datasourceLuid = process.env.APERTURE_SMOKE_VIZQL_DATASOURCE_LUID;
  }
  if (fields.length === 0 && process.env.APERTURE_SMOKE_VIZQL_FIELDS) {
    for (const f of process.env.APERTURE_SMOKE_VIZQL_FIELDS.split(',')) {
      const trimmed = f.trim();
      if (trimmed) fields.push(trimmed);
    }
  }
  if (limit === undefined && process.env.APERTURE_SMOKE_VIZQL_LIMIT) {
    const n = Number(process.env.APERTURE_SMOKE_VIZQL_LIMIT);
    if (Number.isFinite(n) && n > 0) limit = n;
  }

  return { datasourceLuid, fields, limit };
}

function printUsage(): void {
  console.log('[smoke] vizqlService smoke test — usage:');
  console.log('[smoke]   npx tsx backend/src/services/__tests__/vizqlService.smoke.ts \\');
  console.log('[smoke]     --datasource <LUID> --field "Sales" [--field "Region"] [--limit 100]');
  console.log('[smoke]');
  console.log('[smoke] Or set APERTURE_SMOKE_VIZQL_DATASOURCE_LUID and APERTURE_SMOKE_VIZQL_FIELDS in .env');
  console.log(`[smoke] Service row cap: VIZQL_MAX_ROWS = ${VIZQL_MAX_ROWS} (TAPI-03)`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.datasourceLuid || args.fields.length === 0) {
    console.log('[smoke] No datasource LUID / fields supplied — skipping live VizQL smoke test.');
    printUsage();
    process.exit(0);
  }

  console.log('[smoke] Querying VizQL Data Service...');
  console.log(`[smoke]   datasource : ${args.datasourceLuid}`);
  console.log(`[smoke]   fields     : ${args.fields.join(', ')}`);
  if (args.limit !== undefined) {
    console.log(`[smoke]   limit      : ${args.limit} (clamped to ${VIZQL_MAX_ROWS})`);
  }

  try {
    const ctx = await queryVizqlDatasource({
      datasourceLuid: args.datasourceLuid,
      fields: args.fields.map((f) => ({ fieldCaption: f })),
      ...(args.limit !== undefined ? { limit: args.limit } : {}),
    });

    console.log('[smoke] vizqlService returned:');
    console.log(
      JSON.stringify(
        {
          datasourceLuid: ctx.datasourceLuid,
          fields: ctx.fields,
          transport: ctx.transport,
          rowCount: ctx.rows.length,
          firstRow: ctx.rows[0],
        },
        null,
        2,
      ),
    );

    // TAPI-03 assertion (row cap)
    if (ctx.rows.length > 500) {
      console.error('[smoke] FAIL: rows.length > 500 violates TAPI-03');
      process.exit(1);
    }
    // TAPI-05 assertion (transport recorded)
    if (ctx.transport !== 'sse' && ctx.transport !== 'json') {
      console.error(`[smoke] FAIL: invalid transport ${String(ctx.transport)}`);
      process.exit(1);
    }
    console.log(
      `[smoke] PASS: rows=${ctx.rows.length} (<= 500), transport=${ctx.transport} (TAPI-03/05)`,
    );
    process.exit(0);
  } catch (err) {
    if (err instanceof TableauAuthError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
      console.log(
        `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live VizQL smoke test (will verify once .env is populated)`,
      );
      process.exit(0);
    }
    if (err instanceof VizqlServiceError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
      // vizqlService ALSO raises its own "Tableau credentials not configured"
      // error if env.tableau is undefined (before tableauFetch is called), so
      // the cold-boot path can surface as either error type — both are OK.
      console.log(
        `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live VizQL smoke test (will verify once .env is populated)`,
      );
      process.exit(0);
    }
    if (err instanceof VizqlServiceError) {
      console.error(`[smoke] VizqlServiceError: ${err.message}`);
      if (err.status !== undefined) {
        console.error(`[smoke]   HTTP status: ${err.status}`);
      }
      process.exit(1);
    }
    if (err instanceof TableauAuthError) {
      console.error(`[smoke] TableauAuthError: ${err.message}`);
      if (err.status !== undefined) {
        console.error(`[smoke]   HTTP status: ${err.status}`);
      }
      process.exit(1);
    }
    console.error('[smoke] Unexpected error:', err);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err);
  process.exit(1);
});
