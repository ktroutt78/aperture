/**
 * Smoke test: exercises `metadataService.fetchSchemaByDatasourceLuids` and
 * `metadataService.fetchWorkbookMetadata` against the real Tableau Cloud
 * sandbox using credentials from `.env` and prints a populated SchemaContext.
 *
 * Usage (from repo root):
 *
 *   npx tsx backend/src/services/__tests__/metadataService.smoke.ts \
 *     --datasource <luid>
 *
 *   npx tsx backend/src/services/__tests__/metadataService.smoke.ts \
 *     --workbook <luid>
 *
 * Or via env vars:
 *
 *   APERTURE_SMOKE_DATASOURCE_LUIDS=luid1,luid2 \
 *     npx tsx backend/src/services/__tests__/metadataService.smoke.ts
 *
 *   APERTURE_SMOKE_WORKBOOK_LUID=<luid> \
 *     npx tsx backend/src/services/__tests__/metadataService.smoke.ts
 *
 * Note: `backend/package.json` is intentionally NOT modified in plan 02-02.
 * The `smoke:metadata` script alias is added in plan 02-05 alongside the
 * other Phase 2 smoke harnesses. Until then, run this file with `tsx`.
 *
 * Accepted outcomes (matching Phase 1's smoke style):
 *
 *   1. Creds populated AND a datasource/workbook LUID was provided AND the
 *      live call succeeds -> exit 0 with a JSON dump and a PASS line.
 *   2. Creds empty (cold-boot) -> exit 0 with a clear skip message. This is
 *      the expected state on a fresh checkout before the user drops in
 *      their PAT.
 *   3. Creds populated but no LUID was provided -> exit 0 with usage hint.
 *      (Also a cold-boot variant — no input = nothing to verify.)
 *
 * Any OTHER failure (invalid LUID, 4xx/5xx from Metadata API, GraphQL errors,
 * unexpected crash) exits 1.
 *
 * This script NEVER prints a token, PAT secret, or process.env dump.
 */
import {
  fetchSchemaByDatasourceLuids,
  fetchWorkbookMetadata,
  MetadataServiceError,
} from '../metadataService.js';
import { TableauAuthError } from '../tableauAuth.js';

const NOT_CONFIGURED_MARKER = 'Tableau credentials not configured';

interface CliArgs {
  workbookLuid: string | undefined;
  datasourceLuids: string[];
}

/**
 * Parse `process.argv` looking for `--workbook <luid>` and/or one or more
 * `--datasource <luid>` flags. Falls back to APERTURE_SMOKE_WORKBOOK_LUID
 * and APERTURE_SMOKE_DATASOURCE_LUIDS (comma-separated) from env.
 */
function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let workbookLuid: string | undefined;
  const datasourceLuids: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--workbook' && value) {
      workbookLuid = value;
      i++;
    } else if (flag === '--datasource' && value) {
      datasourceLuids.push(value);
      i++;
    }
  }

  if (!workbookLuid && process.env.APERTURE_SMOKE_WORKBOOK_LUID) {
    workbookLuid = process.env.APERTURE_SMOKE_WORKBOOK_LUID;
  }
  if (datasourceLuids.length === 0 && process.env.APERTURE_SMOKE_DATASOURCE_LUIDS) {
    for (const luid of process.env.APERTURE_SMOKE_DATASOURCE_LUIDS.split(',')) {
      const trimmed = luid.trim();
      if (trimmed) datasourceLuids.push(trimmed);
    }
  }

  return { workbookLuid, datasourceLuids };
}

function printUsageAndSkip(): void {
  console.log('[smoke] No LUID provided — skipping live metadataService smoke test.');
  console.log('[smoke] To run against the live sandbox, pass one of:');
  console.log('[smoke]   --datasource <luid>   (repeatable, for TAPI-01)');
  console.log('[smoke]   --workbook <luid>     (for TAPI-02)');
  console.log(
    '[smoke] Or set APERTURE_SMOKE_DATASOURCE_LUIDS (comma-separated) / APERTURE_SMOKE_WORKBOOK_LUID.',
  );
  process.exit(0);
}

async function main(): Promise<void> {
  const { workbookLuid, datasourceLuids } = parseArgs();
  const workbookMode = workbookLuid !== undefined;

  if (!workbookMode && datasourceLuids.length === 0) {
    printUsageAndSkip();
    return;
  }

  console.log('[smoke] Calling metadataService...');
  console.log(
    `[smoke]   mode     : ${workbookMode ? 'workbook (TAPI-02)' : 'datasource (TAPI-01)'}`,
  );
  if (workbookMode && workbookLuid) {
    console.log(`[smoke]   workbook : ${workbookLuid}`);
  } else {
    console.log(`[smoke]   datasources: ${datasourceLuids.length} LUID(s)`);
  }

  try {
    const ctx = workbookMode && workbookLuid
      ? await fetchWorkbookMetadata(workbookLuid)
      : await fetchSchemaByDatasourceLuids(datasourceLuids);

    console.log('[smoke] metadataService returned:');
    console.log(JSON.stringify(ctx, null, 2));

    if (!workbookMode) {
      // TAPI-01 assertion: at least one datasource with at least one field,
      // and the first field exposes every SchemaField key.
      const firstDs = Object.keys(ctx.datasources)[0];
      const firstFieldList = firstDs ? ctx.datasources[firstDs] : undefined;
      const firstField = firstFieldList && firstFieldList[0];
      if (!firstField) {
        console.error('[smoke] FAIL: SchemaContext.datasources is empty for requested LUIDs');
        process.exit(1);
      }
      for (const key of ['name', 'caption', 'dataType', 'description', 'upstreamLineage'] as const) {
        if (!(key in firstField)) {
          console.error(`[smoke] FAIL: first field missing required key: ${key}`);
          process.exit(1);
        }
      }
      console.log('[smoke] PASS: first field has all required keys (TAPI-01)');
    } else {
      // TAPI-02 assertion: workbook present, worksheets array valid shape.
      if (!ctx.workbook) {
        console.error('[smoke] FAIL: workbook metadata missing (LUID did not resolve)');
        process.exit(1);
      }
      if (ctx.workbook.worksheets.length === 0) {
        console.log('[smoke] WARN: workbook has no worksheets (still valid return shape)');
      }
      console.log(
        `[smoke] PASS: workbook "${ctx.workbook.name}" with ${ctx.workbook.worksheets.length} worksheet(s) (TAPI-02)`,
      );
    }

    process.exit(0);
  } catch (err) {
    // Cold-boot path: creds missing is NOT a failure. Matches tableauAuth.smoke.ts.
    if (err instanceof TableauAuthError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
      console.log(
        `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live metadataService smoke test (will verify once .env is populated)`,
      );
      process.exit(0);
    }
    // Same marker can surface from metadataService's own guard if the service
    // short-circuits on missing env before even reaching tableauFetch.
    if (err instanceof MetadataServiceError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
      console.log(
        `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live metadataService smoke test (will verify once .env is populated)`,
      );
      process.exit(0);
    }
    if (err instanceof MetadataServiceError) {
      console.error(`[smoke] MetadataServiceError: ${err.message}`);
    } else if (err instanceof TableauAuthError) {
      console.error(`[smoke] TableauAuthError: ${err.message}`);
      if (err.status !== undefined) console.error(`[smoke]   HTTP status: ${err.status}`);
    } else {
      console.error('[smoke] Unexpected error:', err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err);
  process.exit(1);
});
