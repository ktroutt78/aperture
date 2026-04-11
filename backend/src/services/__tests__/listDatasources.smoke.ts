/**
 * Developer utility: list all published datasources and workbooks in the
 * configured Tableau site with their real 36-char UUID LUIDs.
 *
 * Purpose:
 *   The Tableau Cloud UI URLs expose short numeric internal IDs, NOT the
 *   UUID LUIDs the Metadata / REST / VDS / Pulse APIs all require. When
 *   you're running the Phase 2 smoke tests by hand, you need those UUIDs
 *   but Tableau Cloud doesn't show them in the browser. This script
 *   authenticates via the same PAT flow the services use and prints them.
 *
 * Usage (from repo root):
 *
 *   pnpm --filter @aperture/backend smoke:list-datasources
 *
 * Or directly:
 *
 *   npx tsx backend/src/services/__tests__/listDatasources.smoke.ts
 *
 * Output format: two sections (DATASOURCES, WORKBOOKS), each listing
 *   name | project | LUID | copy-paste command
 *
 * Safety notes:
 *   - Routes through `tableauFetch` — same auth chokepoint as production
 *     services, same 401 auto-refresh.
 *   - Uses Metadata GraphQL API (read-only, already allowed by the PAT).
 *   - Never prints the session token or PAT secret.
 *   - Exits 0 on cold-boot (creds missing) with a clear skip message,
 *     matching the rest of the smoke script family.
 */
import { tableauFetch } from '../tableauFetch.js';
import { loadEnv } from '../../config/env.js';
import { TableauAuthError } from '../tableauAuth.js';

const METADATA_GRAPHQL_PATH = '/api/metadata/graphql';

const QUERY = /* GraphQL */ `
  query AllDatasourcesAndWorkbooks {
    publishedDatasources {
      luid
      name
      projectName
    }
    workbooks {
      luid
      name
      projectName
    }
  }
`;

interface DatasourceNode {
  readonly luid?: string | null;
  readonly name?: string | null;
  readonly projectName?: string | null;
}

interface WorkbookNode {
  readonly luid?: string | null;
  readonly name?: string | null;
  readonly projectName?: string | null;
}

interface QueryResponse {
  readonly publishedDatasources?: readonly DatasourceNode[];
  readonly workbooks?: readonly WorkbookNode[];
}

function padCol(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function printTable(
  heading: string,
  rows: ReadonlyArray<{ name: string; project: string; luid: string }>,
  smokeCmdTemplate: (luid: string) => string,
): void {
  console.log();
  console.log(`=== ${heading} (${rows.length}) ===`);
  if (rows.length === 0) {
    console.log('  (none)');
    return;
  }
  const nameW = Math.max(4, ...rows.map((r) => r.name.length));
  const projW = Math.max(7, ...rows.map((r) => r.project.length));
  console.log(
    `  ${padCol('NAME', nameW)}  ${padCol('PROJECT', projW)}  LUID`,
  );
  console.log(
    `  ${padCol('----', nameW)}  ${padCol('-------', projW)}  ----`,
  );
  for (const r of rows) {
    console.log(
      `  ${padCol(r.name, nameW)}  ${padCol(r.project, projW)}  ${r.luid}`,
    );
  }
  console.log();
  console.log('  Copy-paste smoke commands:');
  for (const r of rows) {
    console.log(`    # ${r.name}`);
    console.log(`    ${smokeCmdTemplate(r.luid)}`);
  }
}

async function main(): Promise<void> {
  console.log('[list-datasources] Starting…');

  const env = loadEnv();
  if (!env.tableau) {
    console.log(
      '[list-datasources] Tableau credentials not configured — set TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET in .env',
    );
    process.exit(0);
  }

  const baseUrl = env.tableau.serverUrl.replace(/\/$/, '');
  const url = `${baseUrl}${METADATA_GRAPHQL_PATH}`;

  console.log(`[list-datasources] Querying Metadata API on ${baseUrl}…`);

  const res = await tableauFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query: QUERY, variables: {} }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Metadata GraphQL returned HTTP ${res.status}: ${body.slice(0, 500)}`,
    );
  }

  const parsed = (await res.json()) as {
    data?: QueryResponse;
    errors?: unknown[];
  };

  if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new Error(
      `Metadata GraphQL returned errors: ${JSON.stringify(parsed.errors).slice(0, 500)}`,
    );
  }

  const data = parsed.data ?? {};

  const datasources = (data.publishedDatasources ?? [])
    .filter((d): d is Required<Pick<DatasourceNode, 'luid'>> & DatasourceNode =>
      typeof d.luid === 'string' && d.luid.length > 0,
    )
    .map((d) => ({
      name: d.name ?? '(unnamed)',
      project: d.projectName ?? '(no project)',
      luid: d.luid as string,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const workbooks = (data.workbooks ?? [])
    .filter((w): w is Required<Pick<WorkbookNode, 'luid'>> & WorkbookNode =>
      typeof w.luid === 'string' && w.luid.length > 0,
    )
    .map((w) => ({
      name: w.name ?? '(unnamed)',
      project: w.projectName ?? '(no project)',
      luid: w.luid as string,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  printTable(
    'DATASOURCES',
    datasources,
    (luid) =>
      `pnpm --filter @aperture/backend smoke:metadata -- --datasource ${luid}`,
  );

  printTable(
    'WORKBOOKS',
    workbooks,
    (luid) =>
      `pnpm --filter @aperture/backend smoke:metadata -- --workbook ${luid}`,
  );

  console.log();
  console.log(
    `[list-datasources] Found ${datasources.length} datasource(s), ${workbooks.length} workbook(s).`,
  );
  console.log('[list-datasources] PASS');
}

main().catch((err: unknown) => {
  if (err instanceof TableauAuthError) {
    console.error(`[list-datasources] Auth failed: ${err.message}`);
  } else if (err instanceof Error) {
    console.error(`[list-datasources] FAIL: ${err.message}`);
  } else {
    console.error('[list-datasources] FAIL: unknown error', err);
  }
  process.exit(1);
});
