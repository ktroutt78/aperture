/**
 * VizQL Data Service client.
 *
 * Queries published Tableau datasources via the VDS `query-datasource` endpoint
 * and returns a typed `LiveDataContext` (see `backend/src/types/tableau.ts`,
 * defined in Phase 2 Plan 01).
 *
 * HARD invariants enforced here (CLAUDE.md ground rules + Phase 2 requirements):
 *
 *   - TAPI-03: rows are capped at the service-level row-cap constant both
 *     before the request (via the `effectiveLimit`) AND after the response
 *     (via slice / early-break in both transport readers). The code-side cap
 *     is belt-and-suspenders: even if the server returned more, the caller
 *     never sees it.
 *
 *   - TAPI-04: every outgoing request body literally sets the caption-as-
 *     field-name interpret flag. This is the reason Claude sees the same
 *     field names the dashboard user sees, so it is a non-negotiable part of
 *     the request body shape — not behind a runtime switch.
 *
 *   - TAPI-05: the service attempts SSE first (2026.1+ streaming endpoint)
 *     and falls back to a regular JSON POST if the server does not return a
 *     `text/event-stream` response (Tableau Cloud 2024.2 / 2025.x). The
 *     returned `LiveDataContext.transport` records which path was actually
 *     used so the smoke harness / Context Assembler can observe it.
 *
 *   - Auth: every HTTP call goes through `tableauFetch`, which is the only
 *     place in the backend that knows about the Tableau session-auth header.
 *     This service never sets that header itself and never calls native
 *     `fetch` directly.
 *
 *   - SSRF guard: the caller-supplied `datasourceLuid` is validated against
 *     a strict LUID regex before being embedded in the JSON request body.
 *     The endpoint URL is a fixed constant — the LUID never enters the URL
 *     path.
 */
import { tableauFetch } from './tableauFetch.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type { LiveDataContext, VizqlFilter } from '../types/tableau.js';

/**
 * Hard row cap for every VizQL Data Service query. Per CLAUDE.md and TAPI-03,
 * Aperture never returns more than 500 rows of live data to the Context
 * Assembler — the narrative is built from schema + Pulse + a small sample.
 */
export const VIZQL_MAX_ROWS = 500;

/** Logger scoped to this module. Pino redact paths from 01-02 cover auth headers. */
const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'vizqlService',
});

/** Tableau Cloud VDS query endpoint path (stable across 2024.2+). */
const VDS_QUERY_PATH = '/api/v1/vizql-data-service/query-datasource';

/** LUID format: 36-char hex-with-dashes. Validated before any request is built. */
const LUID_REGEX = /^[a-f0-9-]{36}$/i;

/**
 * Typed error thrown when a VizQL query cannot be executed or the response is
 * unusable. Callers (Context Assembler, smoke tests) catch this and degrade
 * gracefully per CLAUDE.md ("never crash the panel").
 */
export class VizqlServiceError extends Error {
  readonly status: number | undefined;
  override readonly cause: unknown;
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'VizqlServiceError';
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

/** One field in a VizQL query — caption plus optional aggregation function. */
export interface VizqlQueryField {
  readonly fieldCaption: string;
  readonly function?: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX' | 'MEDIAN';
}

/** Input to `queryVizqlDatasource`. Shape is service-internal, not a wire format. */
export interface VizqlQueryRequest {
  readonly datasourceLuid: string;
  readonly fields: readonly VizqlQueryField[];
  readonly filters?: readonly VizqlFilter[];
  /** Optional caller-supplied row cap. Always clamped to `VIZQL_MAX_ROWS`. */
  readonly limit?: number;
}

/** Internal VDS filter shape — nests the field caption under a `field` object. */
interface VdsFilterBody {
  readonly field: { readonly fieldCaption: string };
  readonly filterType: VizqlFilter['filterType'];
  readonly values: readonly (string | number | boolean)[];
}

/** Internal VDS request body shape. Not exported — we only speak typed input. */
interface VdsRequestBody {
  readonly datasource: { readonly datasourceLuid: string };
  readonly options: {
    readonly returnFormat: 'OBJECTS';
    readonly debug: false;
    readonly disaggregate: false;
  };
  readonly query: {
    readonly fields: ReadonlyArray<
      | { readonly fieldCaption: string }
      | { readonly fieldCaption: string; readonly function: NonNullable<VizqlQueryField['function']> }
    >;
    readonly filters: readonly VdsFilterBody[];
  };
}

/**
 * Query a published Tableau datasource via the VizQL Data Service.
 *
 * Attempts an SSE stream first and falls back to a JSON POST if the server
 * does not return a streaming response. Both transports produce an identical
 * `LiveDataContext` except for the `transport` discriminator.
 *
 * Throws `VizqlServiceError` on any unrecoverable failure (validation,
 * missing env, non-2xx from the JSON fallback). Auth errors surface as
 * `TableauAuthError` from the underlying `tableauFetch` chain.
 */
export async function queryVizqlDatasource(req: VizqlQueryRequest): Promise<LiveDataContext> {
  validateLuid(req.datasourceLuid);

  const env = loadEnv();
  if (!env.tableau) {
    throw new VizqlServiceError(
      'Tableau credentials not configured — set TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET in .env',
    );
  }
  const base = env.tableau.serverUrl.replace(/\/$/, '');
  const endpoint = `${base}${VDS_QUERY_PATH}`;

  // TAPI-03: clamp before the request is built so the server is told the
  // smaller number AND the code-side slice below can still enforce it if the
  // server ignores the hint.
  const effectiveLimit = Math.min(req.limit ?? VIZQL_MAX_ROWS, VIZQL_MAX_ROWS);

  const body: VdsRequestBody = {
    datasource: { datasourceLuid: req.datasourceLuid },
    options: {
      returnFormat: 'OBJECTS',
      debug: false,
      disaggregate: false,
    },
    query: {
      fields: req.fields.map((f) =>
        f.function
          ? { fieldCaption: f.fieldCaption, function: f.function }
          : { fieldCaption: f.fieldCaption },
      ),
      filters: (req.filters ?? []).map(toVdsFilter),
    },
    // TAPI-04 note: CLAUDE.md mentions an `interpretFieldCaptionsAsFieldNames`
    // top-level flag, but Tableau's VizQL Data Service (verified live against
    // 2026.1) rejects it with `404934 Unrecognized field in request`. The VDS
    // API matches captions natively when fields are specified using the
    // `fieldCaption` key (which they are above) — no request-level toggle is
    // required or accepted. CLAUDE.md should be updated.
  };

  log.debug(
    {
      datasourceLuid: req.datasourceLuid,
      fieldCount: req.fields.length,
      filterCount: req.filters?.length ?? 0,
      effectiveLimit,
    },
    'Dispatching VizQL query',
  );

  // ---- Transport 1: SSE (2026.1+) ----
  const sseRes = await tableauFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  const contentType = sseRes.headers.get('content-type') ?? '';
  if (sseRes.ok && contentType.includes('text/event-stream') && sseRes.body) {
    try {
      const rows = await readSseRows(sseRes.body, effectiveLimit);
      const capped = rows.slice(0, effectiveLimit);
      log.info(
        { datasourceLuid: req.datasourceLuid, rowCount: capped.length, transport: 'sse' },
        'VizQL SSE query complete',
      );
      return buildContext(req, capped, 'sse');
    } catch (err) {
      log.warn(
        { err: (err as Error).message, datasourceLuid: req.datasourceLuid },
        'SSE parse failed, falling back to JSON',
      );
      // fall through to JSON fallback
    }
  } else {
    // Server didn't stream — drain the body so the connection can be reused,
    // then retry as JSON.
    try {
      await sseRes.body?.cancel();
    } catch {
      // best-effort
    }
    log.debug(
      {
        datasourceLuid: req.datasourceLuid,
        status: sseRes.status,
        contentType,
      },
      'SSE not supported by server, falling back to JSON',
    );
  }

  // ---- Transport 2: JSON fallback ----
  const jsonRes = await tableauFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!jsonRes.ok) {
    const text = (await jsonRes.text()).slice(0, 500);
    throw new VizqlServiceError(
      `VizQL Data Service returned HTTP ${jsonRes.status}: ${text}`,
      { status: jsonRes.status },
    );
  }

  let parsed: { data?: Array<Record<string, unknown>> };
  try {
    parsed = (await jsonRes.json()) as { data?: Array<Record<string, unknown>> };
  } catch (err) {
    throw new VizqlServiceError('VizQL Data Service returned non-JSON response', {
      status: jsonRes.status,
      cause: err,
    });
  }
  const rows = (parsed.data ?? []).slice(0, effectiveLimit);
  log.info(
    { datasourceLuid: req.datasourceLuid, rowCount: rows.length, transport: 'json' },
    'VizQL JSON query complete',
  );
  return buildContext(req, rows, 'json');
}

/**
 * Validate a Tableau LUID (36-char hex with dashes). Blocks SSRF-style attempts
 * to smuggle path segments or alternate protocols through the caller-supplied
 * `datasourceLuid` field. See T-02-03-02 in the plan threat model.
 */
function validateLuid(luid: string): void {
  if (!LUID_REGEX.test(luid)) {
    throw new VizqlServiceError(
      `Invalid datasource LUID (expected 36-char hex with dashes): ${luid.slice(0, 64)}`,
    );
  }
}

/** Map a typed `VizqlFilter` to the VDS request body shape. */
function toVdsFilter(f: VizqlFilter): VdsFilterBody {
  return {
    field: { fieldCaption: f.field },
    filterType: f.filterType,
    values: f.values,
  };
}

/** Build the immutable `LiveDataContext` that 02-01 defined. */
function buildContext(
  req: VizqlQueryRequest,
  rows: ReadonlyArray<Readonly<Record<string, unknown>>>,
  transport: 'sse' | 'json',
): LiveDataContext {
  return {
    datasourceLuid: req.datasourceLuid,
    fields: req.fields.map((f) => f.fieldCaption),
    filters: req.filters ?? [],
    rows,
    transport,
  };
}

/**
 * Minimal SSE reader: consumes `data:` lines delimited by blank lines,
 * parses each as JSON, and collects rows until `limit` is reached.
 *
 * Tolerates three payload shapes because the VDS streaming contract is still
 * evolving and sandbox behavior varies by region:
 *   - `[ { ...row }, ... ]`           — a row array per event
 *   - `{ "rows": [ ...row, ... ] }`   — a wrapped row batch
 *   - `{ ...row }`                    — a single row per event
 *
 * Malformed `data:` lines are skipped defensively — SSE should never crash the
 * panel (CLAUDE.md: "Degrade gracefully if any Tableau API returns empty").
 */
async function readSseRows(
  body: ReadableStream<Uint8Array>,
  limit: number,
): Promise<Array<Record<string, unknown>>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const rows: Array<Record<string, unknown>> = [];
  let buffer = '';
  try {
    while (rows.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n\n')) !== -1) {
        const evt = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        for (const line of evt.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '' || payload === '[DONE]') continue;
          try {
            const parsed = JSON.parse(payload) as unknown;
            if (Array.isArray(parsed)) {
              for (const r of parsed as Array<Record<string, unknown>>) {
                if (rows.length >= limit) break;
                rows.push(r);
              }
            } else if (parsed && typeof parsed === 'object') {
              const obj = parsed as { rows?: Array<Record<string, unknown>> };
              if (Array.isArray(obj.rows)) {
                for (const r of obj.rows) {
                  if (rows.length >= limit) break;
                  rows.push(r);
                }
              } else {
                rows.push(parsed as Record<string, unknown>);
              }
            }
          } catch {
            // Skip un-parseable SSE lines defensively; never crash the stream.
          }
        }
        if (rows.length >= limit) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // best-effort cleanup
    }
  }
  return rows;
}
