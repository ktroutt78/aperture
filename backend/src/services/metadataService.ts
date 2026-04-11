/**
 * Tableau Cloud Metadata API (GraphQL) service — TAPI-01 + TAPI-02.
 *
 * Exposes two query modes that both return the shared `SchemaContext` envelope
 * defined in 02-01 (`../types/tableau.ts`):
 *
 *   - `fetchSchemaByDatasourceLuids(luids)` — TAPI-01: given one or more
 *     published-datasource LUIDs, return every field (name, caption, dataType,
 *     description, upstreamLineage) keyed by datasource LUID.
 *   - `fetchWorkbookMetadata(workbookLuid)` — TAPI-02: given a workbook LUID,
 *     return the workbook's worksheets and each worksheet's connected
 *     datasource LUIDs. `datasources` is returned empty; Phase 3's Context
 *     Assembler will call `fetchSchemaByDatasourceLuids` with the collected
 *     LUIDs to populate it.
 *
 * Ground rules honored:
 *   - Every HTTP call routes through `tableauFetch` (single chokepoint for
 *     the shared session header + 401 auto-refresh). Raw `fetch()` is NEVER
 *     used here — `tableauFetch` owns the auth header end-to-end.
 *   - All LUIDs are validated against a strict UUID regex BEFORE any network
 *     call — SSRF + GraphQL-injection defense. LUIDs travel exclusively via
 *     GraphQL `variables`; they are never interpolated into the query string.
 *   - Nothing in this module ever logs the Tableau session token, the PAT
 *     secret, or raw field-level response data at info level. Only counts.
 *   - No mutable module state is exported.
 */
import { tableauFetch } from './tableauFetch.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type {
  SchemaContext,
  SchemaField,
  WorkbookMetadata,
  WorksheetMetadata,
} from '../types/tableau.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'metadataService',
});

/**
 * Metadata API endpoint path. Note this is OUTSIDE the versioned REST tree
 * (`/api/3.19/...`) — it is a fixed constant per Tableau's Metadata GraphQL
 * documentation. LUIDs NEVER appear in this URL; they live in POST-body
 * variables only (SSRF defense, threat T-02-02-03).
 */
const METADATA_GRAPHQL_PATH = '/api/metadata/graphql';

/**
 * Strict UUID (lowercase-or-uppercase hex) guard applied to every caller-
 * supplied LUID before it reaches Tableau. Mitigates T-02-02-02
 * (GraphQL/query-string injection) and T-02-02-03 (SSRF via URL concat).
 */
const LUID_PATTERN = /^[a-f0-9-]{36}$/i;

/**
 * Typed error thrown by this service on configuration failures, HTTP errors,
 * non-JSON responses, or GraphQL `errors[]` bodies. Callers (smoke tests and
 * the Phase 3 Context Assembler) catch this to distinguish "Metadata API told
 * us no" from "our code blew up".
 */
export class MetadataServiceError extends Error {
  override readonly cause: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MetadataServiceError';
    this.cause = cause;
  }
}

/** Truncate an arbitrary text blob so we never dump a 10MB error body into logs. */
function truncate(s: string, max = 500): string {
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Shared GraphQL POST helper. Builds the Metadata API URL from env, serializes
 * the query + variables, routes through `tableauFetch`, and normalizes error
 * surfaces into `MetadataServiceError`. Returns the typed `data` payload.
 *
 * The generic `T` is the caller's expected shape of `response.data`. We keep
 * this internal — callers never see the raw `{ data, errors }` envelope.
 */
async function postGraphql<T>(
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const env = loadEnv();
  if (!env.tableau) {
    throw new MetadataServiceError(
      'Tableau credentials not configured — set TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET in .env',
    );
  }
  const baseUrl = env.tableau.serverUrl.replace(/\/$/, '');
  const url = `${baseUrl}${METADATA_GRAPHQL_PATH}`;

  let res: Response;
  try {
    res = await tableauFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (err) {
    throw new MetadataServiceError('Network error calling Metadata GraphQL API', err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new MetadataServiceError(
      `Metadata GraphQL API returned HTTP ${res.status}: ${truncate(body)}`,
    );
  }

  let parsed: { data?: T; errors?: unknown[] };
  try {
    parsed = (await res.json()) as { data?: T; errors?: unknown[] };
  } catch (err) {
    throw new MetadataServiceError('Metadata GraphQL API returned non-JSON response', err);
  }

  if (parsed.errors && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw new MetadataServiceError(
      `Metadata GraphQL API returned errors: ${truncate(JSON.stringify(parsed.errors))}`,
    );
  }

  if (parsed.data === undefined) {
    throw new MetadataServiceError('Metadata GraphQL API response missing `data` field');
  }

  return parsed.data;
}

/**
 * Validate a caller-supplied LUID. Throws `MetadataServiceError` on mismatch.
 * Shared by both exported functions so the SSRF/injection guard lives in one
 * place (threats T-02-02-02 / T-02-02-03).
 */
function assertLuid(value: string, label: string): void {
  if (!LUID_PATTERN.test(value)) {
    const safe = truncate(value, 64);
    throw new MetadataServiceError(
      `Invalid ${label}: "${safe}" — expected 36-char UUID (hex + dashes)`,
    );
  }
}

// ---------------------------------------------------------------------------
// TAPI-01: fetchSchemaByDatasourceLuids
// ---------------------------------------------------------------------------

/**
 * Minimal response shape for the `FieldsForDatasources` query. We narrow `any`
 * via these local interfaces instead of leaking `any` into the codebase.
 * Note: every GraphQL response field is optional because the API may omit
 * keys on fields where the fragment doesn't match (e.g. a GroupField is
 * neither ColumnField nor CalculatedField so `dataType` is absent).
 */
interface FieldsForDatasourcesResponse {
  publishedDatasources?: ReadonlyArray<{
    luid?: string;
    fields?: ReadonlyArray<{
      name?: string;
      description?: string | null;
      dataType?: string | null;
      upstreamColumns?: ReadonlyArray<{
        name?: string | null;
        fullyQualifiedName?: string | null;
      }> | null;
    }>;
  }>;
}

/**
 * GraphQL query for TAPI-01. LUIDs are NEVER interpolated here — they travel
 * exclusively via the `$luids` variable at call time (threat T-02-02-02).
 */
const FIELDS_FOR_DATASOURCES_QUERY = /* GraphQL */ `
  query FieldsForDatasources($luids: [String!]!) {
    publishedDatasources(filter: { luidWithin: $luids }) {
      luid
      fields {
        name
        description
        upstreamColumns { name fullyQualifiedName }
        ... on ColumnField { dataType }
        ... on CalculatedField { dataType }
      }
    }
  }
`;

/**
 * Coerce a single GraphQL `field` node into the shared `SchemaField` contract
 * from 02-01. Any missing string becomes `''`; `dataType` defaults to
 * `'UNKNOWN'` when neither ColumnField nor CalculatedField fragment matches.
 * Upstream lineage prefers `fullyQualifiedName` and falls back to `name`.
 */
function toSchemaField(field: NonNullable<
  NonNullable<FieldsForDatasourcesResponse['publishedDatasources']>[number]['fields']
>[number]): SchemaField {
  const lineage: string[] = [];
  for (const col of field.upstreamColumns ?? []) {
    const ref = col.fullyQualifiedName ?? col.name ?? '';
    if (ref) lineage.push(ref);
  }
  const name = field.name ?? '';
  return {
    name,
    // Metadata API's `name` on a published datasource field carries the
    // user-facing caption. If a future schema exposes a distinct caption
    // field, swap this single mapping without touching callers.
    caption: name,
    dataType: field.dataType ?? 'UNKNOWN',
    description: field.description ?? '',
    upstreamLineage: lineage,
  };
}

/**
 * TAPI-01 entry point. Given 1+ published-datasource LUIDs, return a
 * `SchemaContext` whose `datasources` map is keyed by LUID and whose values
 * are the datasource's `SchemaField[]`. `workbook` is left undefined — this
 * entry point has no workbook context.
 *
 * Throws `MetadataServiceError` on invalid LUID input, HTTP failures, GraphQL
 * errors, or non-JSON responses. Empty input (`[]`) returns a SchemaContext
 * with an empty `datasources` map without making a network call.
 */
export async function fetchSchemaByDatasourceLuids(
  datasourceLuids: readonly string[],
): Promise<SchemaContext> {
  // Strict validation up-front — we never send any LUID to Tableau unless all
  // of them pass the UUID guard. This is the choke point for T-02-02-02 and
  // T-02-02-03.
  for (const luid of datasourceLuids) {
    assertLuid(luid, 'datasourceLuid');
  }

  if (datasourceLuids.length === 0) {
    return { datasources: {} };
  }

  const data = await postGraphql<FieldsForDatasourcesResponse>(
    FIELDS_FOR_DATASOURCES_QUERY,
    { luids: datasourceLuids },
  );

  const datasources: Record<string, readonly SchemaField[]> = {};
  let totalFields = 0;
  for (const ds of data.publishedDatasources ?? []) {
    if (!ds.luid) continue;
    const fields = (ds.fields ?? []).map(toSchemaField);
    datasources[ds.luid] = fields;
    totalFields += fields.length;
  }

  // Count-only logging — no field names, no descriptions, no raw response.
  log.info(
    {
      requested: datasourceLuids.length,
      returned: Object.keys(datasources).length,
      totalFields,
    },
    'metadataService.fetchSchemaByDatasourceLuids',
  );

  return { datasources };
}

// ---------------------------------------------------------------------------
// TAPI-02: fetchWorkbookMetadata
// ---------------------------------------------------------------------------

/**
 * Minimal response shape for the `WorkbookMeta` query. Same narrowing
 * strategy as above — keeps `any` out of the public surface.
 */
interface WorkbookMetaResponse {
  workbooks?: ReadonlyArray<{
    luid?: string;
    name?: string;
    sheets?: ReadonlyArray<{
      luid?: string;
      name?: string;
      upstreamDatasources?: ReadonlyArray<{ luid?: string }>;
    }>;
  }>;
}

/**
 * GraphQL query for TAPI-02. Workbook LUID travels via the `$luid` variable.
 * The inline fragment `... on Worksheet` filters out dashboards/stories,
 * keeping `sheets` down to actual worksheets which are the only things that
 * have `upstreamDatasources`.
 */
const WORKBOOK_META_QUERY = /* GraphQL */ `
  query WorkbookMeta($luid: String!) {
    workbooks(filter: { luid: $luid }) {
      luid
      name
      sheets {
        ... on Worksheet {
          luid
          name
          upstreamDatasources { luid }
        }
      }
    }
  }
`;

/**
 * TAPI-02 entry point. Given a workbook LUID, return a `SchemaContext` whose
 * `workbook` field is populated with the workbook's worksheets and each
 * worksheet's connected datasource LUIDs. `datasources` is intentionally left
 * empty — Phase 3's Context Assembler will call `fetchSchemaByDatasourceLuids`
 * with the collected LUIDs to populate the field-level schema separately.
 *
 * Throws `MetadataServiceError` on invalid LUID input, HTTP failures, or
 * GraphQL errors. A workbook that exists but has no sheets returns a valid
 * SchemaContext with `workbook.worksheets = []`.
 *
 * A workbook LUID that resolves to nothing (Tableau returns `workbooks: []`)
 * returns `{ datasources: {} }` with `workbook` undefined — callers should
 * check `ctx.workbook` before dereferencing.
 */
export async function fetchWorkbookMetadata(workbookLuid: string): Promise<SchemaContext> {
  assertLuid(workbookLuid, 'workbookLuid');

  const data = await postGraphql<WorkbookMetaResponse>(WORKBOOK_META_QUERY, {
    luid: workbookLuid,
  });

  const wb = (data.workbooks ?? [])[0];
  if (!wb || !wb.luid) {
    log.info({ workbookLuid, found: false }, 'metadataService.fetchWorkbookMetadata');
    return { datasources: {} };
  }

  const worksheets: WorksheetMetadata[] = [];
  for (const sheet of wb.sheets ?? []) {
    if (!sheet.luid || !sheet.name) continue;
    const connectedDatasourceLuids: string[] = [];
    for (const ds of sheet.upstreamDatasources ?? []) {
      if (ds.luid) connectedDatasourceLuids.push(ds.luid);
    }
    worksheets.push({
      luid: sheet.luid,
      name: sheet.name,
      connectedDatasourceLuids,
    });
  }

  const workbook: WorkbookMetadata = {
    luid: wb.luid,
    name: wb.name ?? '',
    worksheets,
  };

  log.info(
    {
      workbookLuid,
      found: true,
      worksheetCount: worksheets.length,
      totalConnectedDatasources: worksheets.reduce(
        (sum, w) => sum + w.connectedDatasourceLuids.length,
        0,
      ),
    },
    'metadataService.fetchWorkbookMetadata',
  );

  return { datasources: {}, workbook };
}
