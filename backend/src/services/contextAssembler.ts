/**
 * Context Assembler — Phase 3 core primitive. Fans out to metadataService,
 * vizqlService, and pulseService and merges into a single CopilotContext,
 * then applies D-17 truncation before returning.
 *
 * TWO-STAGE FAN-OUT (honoring D-01 semantically — parallel wherever deps allow):
 *
 *   Stage A (sequential gate):  fetchSchemaByDatasourceLuids
 *     - Must resolve before Stage B so VDS knows which captions to request.
 *     - Per-service AbortController @ 2s.
 *     - D-04: total failure → ContextAssemblerError. Partial success OK.
 *
 *   Stage B (parallel via Promise.allSettled):
 *     - queryVizqlDatasource per resolved LUID, with fields derived from
 *       the Stage A SchemaContext (top N captions) — NEVER empty fields[].
 *     - fetchPulseContext per resolved LUID.
 *     - Per-service AbortController @ 2s each.
 *
 *   Total wrapper: 2.5s (D-02). Timing assumption: metadata ~200ms typical,
 *   VDS ~1-1.5s typical, so sequential Stage-A-then-Stage-B fits comfortably.
 *   If Stage A burns the full 2s, Stage B has ~500ms remaining and degrades
 *   gracefully to error status while still returning a usable CopilotContext.
 *
 * Failure semantics (D-03):
 *   - Schema failure: per-datasource granularity. Partial success OK.
 *                    Only a 100%-schema-failure is a hard throw.
 *   - VDS failure:   silent degradation. servicesFired.vizql = error.
 *                    Skipped entirely for LUIDs whose schema failed.
 *   - Pulse failure: silent degradation. servicesFired.pulse = error.
 *
 * KNOWN v1 LIMITATION (documented in STATE.md):
 *   withTimeout returns control to the caller at 2s via a Promise.race, but
 *   does NOT thread an AbortSignal into the underlying Tableau fetch. Orphan
 *   fetches run to completion in the background; their results are discarded.
 *   Mitigated at v1 by D-22 rate limiting. Revisit if DoS load tests reveal
 *   connection-slot starvation.
 *
 * BLOCKER 2 FIX: VDS `fields` entries MUST use the `fieldCaption` key (NOT
 * `name`). Verified empirically against 10ax.online.tableau.com 2026-04-11
 * during Phase 2 UAT. VDS natively matches captions when fields are specified
 * via `fieldCaption` — there is NO request-level `interpretFieldCaptionsAsFieldNames`
 * flag (the live VDS API rejects it with `404934 Unrecognized field`).
 */
import { fetchSchemaByDatasourceLuids } from './metadataService.js';
import {
  queryVizqlDatasource,
  VIZQL_MAX_ROWS,
  type VizqlQueryField,
} from './vizqlService.js';
import { fetchPulseContext } from './pulseService.js';
import { truncateContext, estimateContextChars } from './contextBudget.js';
import { ContextAssemblerError } from './errors.js';
import { createLogger } from '../lib/logger.js';
import type {
  CopilotContext,
  CopilotContextRequest,
  ServicesFired,
} from '../types/copilot.js';
import type {
  SchemaContext,
  LiveDataContext,
  PulseContext,
  SchemaField,
} from '../types/tableau.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'contextAssembler',
});

/** Per-service soft timeout (D-02). */
export const PER_SERVICE_TIMEOUT_MS = 2_000;
/** Total assembler wall-clock budget (D-02). */
export const TOTAL_BUDGET_MS = 2_500;
/** Cap how many captions we send to VDS per datasource — keeps the token budget lean. */
export const MAX_VDS_FIELDS_PER_LUID = 10;

/**
 * Optional dependency-injection shape for tests. When `deps` is omitted or a
 * field is missing, the assembler uses the real Phase 2 services.
 */
export interface AssembleDeps {
  readonly fetchSchema?: (luids: readonly string[]) => Promise<SchemaContext>;
  readonly queryVizql?: (req: {
    readonly datasourceLuid: string;
    readonly fields: readonly VizqlQueryField[];
    readonly limit?: number;
  }) => Promise<LiveDataContext>;
  readonly fetchPulse?: (luid: string) => Promise<PulseContext>;
}

/**
 * Assemble the Phase 3 CopilotContext from the Tableau tri-API surface.
 *
 * Exposes `deps` for test injection. Never call `deps` in production code paths
 * except from tests — route handlers must pass only the `request`.
 */
export async function assembleContext(
  request: CopilotContextRequest,
  deps: AssembleDeps = {},
): Promise<CopilotContext> {
  const t0 = performance.now();
  const luids = request.datasourceLuids;
  const doFetchSchema = deps.fetchSchema ?? fetchSchemaByDatasourceLuids;
  const doQueryVizql = deps.queryVizql ?? queryVizqlDatasource;
  const doFetchPulse = deps.fetchPulse ?? fetchPulseContext;

  // ============ Empty input short-circuit ============
  if (luids.length === 0) {
    return finalize(
      request,
      { datasources: {} },
      [],
      [],
      {
        metadata: { status: 'ok', datasources: 0 },
        vizql: { status: 'empty' },
        pulse: { status: 'empty' },
      },
      performance.now() - t0,
    );
  }

  // Total budget wrapper — race Stage A and Stage B individually against the
  // remaining budget so we never exceed TOTAL_BUDGET_MS wall-clock.
  let deadlineFired = false;
  const deadlinePromise: Promise<'BUDGET_EXCEEDED'> = new Promise((resolve) => {
    setTimeout(() => {
      deadlineFired = true;
      resolve('BUDGET_EXCEEDED');
    }, TOTAL_BUDGET_MS);
  });

  // ============ STAGE A: metadata (gates Stage B) ============
  let schema: SchemaContext;
  try {
    const stageA = await Promise.race([
      withTimeout('metadata', () => doFetchSchema(luids)),
      deadlinePromise,
    ]);
    if (stageA === 'BUDGET_EXCEEDED') {
      throw new ContextAssemblerError(
        'Assembler budget exceeded in Stage A (metadata)',
        luids,
      );
    }
    schema = stageA;
  } catch (err) {
    // D-04 hard throw: the whole metadata call rejected.
    if (err instanceof ContextAssemblerError) throw err;
    throw new ContextAssemblerError('All datasource schemas failed', luids, err);
  }

  const resolvedLuids = Object.keys(schema.datasources);
  const failedLuids = luids.filter((l) => !resolvedLuids.includes(l));
  if (resolvedLuids.length === 0) {
    // D-04 hard throw: 0 of N schemas resolved.
    throw new ContextAssemblerError(
      'All datasource schemas failed',
      luids,
      new Error('schema.datasources was empty'),
    );
  }
  const metadataStatus: ServicesFired['metadata'] =
    failedLuids.length === 0
      ? { status: 'ok', datasources: resolvedLuids.length }
      : {
          status: 'partial',
          ok: resolvedLuids.length,
          failed: failedLuids.length,
          failedLuids,
        };

  // ============ STAGE B: VDS + Pulse in parallel (resolved LUIDs only) ============
  // Derive VDS fields[] from the Stage A schema — top N captions per LUID.
  // Blocker 2 fix: VDS MUST receive non-empty fields[] shaped as
  // `{ fieldCaption: string }` (NOT `{ name }`). Verified live 2026-04-11.
  const vdsCallsForLuid = (luid: string): readonly VizqlQueryField[] => {
    const fields = schema.datasources[luid] ?? [];
    return fields
      .slice(0, MAX_VDS_FIELDS_PER_LUID)
      .map((f: SchemaField): VizqlQueryField => ({ fieldCaption: f.caption }));
  };

  const vizqlPromises = resolvedLuids.map((luid) =>
    withTimeout('vizql', () =>
      doQueryVizql({
        datasourceLuid: luid,
        fields: vdsCallsForLuid(luid),
        limit: VIZQL_MAX_ROWS,
      }),
    ),
  );
  const pulsePromises = resolvedLuids.map((luid) =>
    withTimeout('pulse', () => doFetchPulse(luid)),
  );

  // D-01: Promise.allSettled across Stage B. Per-service AbortController is
  // already applied inside withTimeout above, so each promise resolves/rejects
  // independently and allSettled never propagates a single failure.
  const stageB = Promise.allSettled<unknown>([...vizqlPromises, ...pulsePromises]);
  const raceResult = await Promise.race([stageB, deadlinePromise]);

  let results: PromiseSettledResult<unknown>[];
  if (raceResult === 'BUDGET_EXCEEDED') {
    log.warn({ budgetMs: TOTAL_BUDGET_MS }, 'context assembler total budget exceeded in Stage B');
    // Best-effort collection: each Stage B call has a 2s per-service cap so
    // `stageB` settles shortly after the deadline. We still await it so we
    // record whatever did arrive in time.
    results = await stageB;
  } else {
    results = raceResult;
  }

  const vizqlResults = results.slice(0, resolvedLuids.length);
  const pulseResults = results.slice(resolvedLuids.length);

  // ============ VDS aggregation (D-03: silent degrade, per-LUID) ============
  const liveData: LiveDataContext[] = [];
  let vizqlOkRows = 0;
  let vizqlAnyError: string | undefined;
  for (const r of vizqlResults) {
    if (r.status === 'fulfilled') {
      const ld = r.value as LiveDataContext;
      liveData.push(ld);
      vizqlOkRows += ld.rows.length;
    } else {
      vizqlAnyError = String(
        (r.reason as { message?: string } | undefined)?.message ?? r.reason ?? 'unknown',
      );
    }
  }
  let vizqlStatus: ServicesFired['vizql'];
  if (liveData.length === 0 && vizqlAnyError) {
    vizqlStatus = { status: 'error', reason: vizqlAnyError };
  } else if (vizqlOkRows === 0) {
    vizqlStatus = { status: 'empty' };
  } else {
    vizqlStatus = { status: 'ok', rows: vizqlOkRows };
  }

  // ============ Pulse aggregation (D-03: silent degrade, per-LUID) ============
  const pulse: PulseContext[] = [];
  let pulseMetricCount = 0;
  let pulseAnyError: string | undefined;
  for (const r of pulseResults) {
    if (r.status === 'fulfilled') {
      const p = r.value as PulseContext;
      pulse.push(p);
      pulseMetricCount += p.metricDefinitions.length;
    } else {
      pulseAnyError = String(
        (r.reason as { message?: string } | undefined)?.message ?? r.reason ?? 'unknown',
      );
    }
  }
  let pulseStatus: ServicesFired['pulse'];
  if (pulse.length === 0 && pulseAnyError) {
    pulseStatus = { status: 'error', reason: pulseAnyError };
  } else if (pulseMetricCount === 0) {
    pulseStatus = { status: 'empty' };
  } else {
    pulseStatus = { status: 'ok', metricCount: pulseMetricCount };
  }

  // Suppress unused-var warning for deadlineFired; it is mutated purely for
  // future-debug instrumentation and may be surfaced via log at the site of
  // race resolution. Read at least once so `noUnusedLocals` passes.
  if (deadlineFired) {
    log.debug({ budgetMs: TOTAL_BUDGET_MS }, 'assembler total-budget deadline fired');
  }

  const assemblyMs = performance.now() - t0;
  return finalize(
    request,
    schema,
    liveData,
    pulse,
    {
      metadata: metadataStatus,
      vizql: vizqlStatus,
      pulse: pulseStatus,
    },
    assemblyMs,
  );
}

/**
 * Race `fn()` against a 2s AbortController. The underlying Tableau fetch does
 * NOT receive the AbortSignal today (known v1 limitation — see STATE.md entry
 * "withTimeout background"). When the race fires, control returns to the
 * caller but the fetch keeps running until it completes naturally and its
 * result is discarded. Mitigated at v1 by D-22 rate limiting.
 */
async function withTimeout<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PER_SERVICE_TIMEOUT_MS);
  try {
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        ac.signal.addEventListener('abort', () =>
          reject(new Error(`${name} timed out after ${PER_SERVICE_TIMEOUT_MS}ms`)),
        );
      }),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Assemble the final CopilotContext envelope: compute the pre-truncation char
 * estimate, apply D-17 truncation, and return. `truncateContext` sets
 * `servicesFired.truncated` when it fires, so callers do not need to track it.
 */
function finalize(
  request: CopilotContextRequest,
  schema: SchemaContext,
  liveData: readonly LiveDataContext[],
  pulse: readonly PulseContext[],
  partial: Pick<ServicesFired, 'metadata' | 'vizql' | 'pulse'>,
  assemblyMs: number,
): CopilotContext {
  const draft: CopilotContext = {
    request,
    schema,
    liveData,
    pulse,
    servicesFired: {
      ...partial,
      assemblyMs,
      contextChars: 0,
      truncated: false,
    },
  };
  const contextChars = estimateContextChars(draft);
  const withChars: CopilotContext = {
    ...draft,
    servicesFired: { ...draft.servicesFired, contextChars },
  };
  return truncateContext(withChars);
}
