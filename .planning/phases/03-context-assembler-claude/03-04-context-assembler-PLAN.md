---
phase: 03-context-assembler-claude
plan: 04
type: execute
wave: 2
depends_on: [03-01, 03-03]
files_modified:
  - backend/src/services/contextAssembler.ts
  - backend/src/services/__tests__/contextAssembler.test.ts
  - backend/package.json
  - .planning/STATE.md
autonomous: true
requirements: [CTX-01, CTX-02, CTX-03]
tags: [phase-3, context-assembler, fan-out, wave-2]

must_haves:
  truths:
    - "assembleContext runs a two-stage fan-out: Stage A resolves metadata (schema) first, Stage B fires VDS and Pulse in parallel via Promise.allSettled — honoring D-01's intent of parallelism-wherever-dependencies-allow"
    - "VDS requests derive their `fields` array from the Stage A SchemaContext (top N field captions per datasource) so VDS never receives an empty fields[]"
    - "Each service call is wrapped in its own AbortController with a hard 2s timeout (D-02)"
    - "The assembler as a whole has a hard 2.5s budget enforced as a wrapper around the two stages (D-02)"
    - "Schema fan-out is per-datasource: partial success returns a partial SchemaContext and marks metadata as 'partial' with failedLuids (D-03); VDS is skipped for any LUID whose schema failed"
    - "All-schemas-fail throws ContextAssemblerError with failedLuids populated — the route maps this to HTTP 502 SCHEMA_UNAVAILABLE (D-04)"
    - "VDS and Pulse failures are silently degraded: servicesFired.vizql and servicesFired.pulse record {status:'error',reason}, the narrative continues (D-03)"
    - "assembleContext calls truncateContext before returning, so the returned CopilotContext.servicesFired.contextChars is pre-truncation and .truncated reflects whether any trim ran"
    - "assembleContext returns a CopilotContext whose servicesFired matches D-05 verbatim"
    - "A STATE.md entry documents the known v1 limitation: withTimeout returns control at 2s but underlying Tableau fetches keep running in the background (mitigated by D-22 rate limiting)"
  artifacts:
    - path: "backend/src/services/contextAssembler.ts"
      provides: "assembleContext(request) — the Phase 3 core primitive consumed by /context and /chat routes"
      contains: "export async function assembleContext"
    - path: "backend/src/services/__tests__/contextAssembler.test.ts"
      provides: "Offline tests with monkey-patched service functions proving fan-out, per-service failure handling, budget enforcement, and the derived-fields contract"
      contains: "assembleContext"
    - path: ".planning/STATE.md"
      provides: "Documented v1 known limitation for withTimeout background leak"
      contains: "withTimeout background"
  key_links:
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/metadataService.ts"
      via: "import { fetchSchemaByDatasourceLuids }"
      pattern: "fetchSchemaByDatasourceLuids"
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/vizqlService.ts"
      via: "import { queryVizqlDatasource, VIZQL_MAX_ROWS, type VizqlQueryField }"
      pattern: "queryVizqlDatasource"
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/pulseService.ts"
      via: "import { fetchPulseContext }"
      pattern: "fetchPulseContext"
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/contextBudget.ts"
      via: "import { truncateContext, estimateContextChars }"
      pattern: "truncateContext"
---

<objective>
Implement the `ContextAssembler` — the central Phase 3 primitive that fans out to Metadata / VDS / Pulse, merges the results into a `CopilotContext`, applies D-17 truncation, and honors the D-01/D-02/D-03/D-04 failure semantics. This plan is Wave 2 and depends on Plans 03-01 (types), 03-03 (truncation + budget). Offline tests monkey-patch the three Phase 2 service functions so the test runs with no Tableau credentials.

**CRITICAL two-stage fan-out (Blocker 2 fix):** VDS requires a non-empty `fields[]` array of `{ fieldCaption: string }` — the live VDS API returns empty rows for an empty fields list, which would silently null out CTX-05 (narrative references real field captions). The assembler therefore runs in two stages inside the same 2.5s total budget:

- **Stage A** — metadata fetch (2s timeout). Downstream VDS work depends on its output.
- **Stage B** — `Promise.allSettled([vizql, pulse])` with per-service 2s timeouts. For each LUID that Stage A resolved, VDS is called with `fields` derived from the first N field captions of `SchemaContext.datasources[luid]`. For LUIDs where Stage A failed, VDS is skipped entirely.

Honoring D-01 semantically: D-01 says "fans out using Promise.allSettled — not bare Promise.all — with per-service AbortController." The spirit is "parallel where possible, graceful per-service failure." Two-stage fan-out with VDS and Pulse in parallel inside Stage B honors that spirit while fixing Blocker 2. The `servicesFired` structure in D-05 is unchanged — metadata, vizql, pulse are still reported separately.

Timing assumption: in practice metadata is the fast Metadata-API query (~200ms typical) and VDS is the slower one (~1-1.5s). Sequential Stage-A-then-Stage-B worst case (2s + 2s = 4s) is bounded by the 2.5s total wrapper; if Stage A burns the full 2s, Stage B has ~500ms remaining and will timeout quickly, degrading VDS/Pulse to error status but still returning a usable CopilotContext. Document this timing assumption in the source comments.

Purpose: The assembler is the critical path. Its 2.5s budget is what makes "context assembles in under 3 seconds" achievable. Its partial-failure semantics are what make the demo resilient — one datasource 401 must not take down the whole panel.

Output: One service file, one offline test, one npm script, one STATE.md entry.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/services/metadataService.ts
@backend/src/services/vizqlService.ts
@backend/src/services/pulseService.ts
@backend/src/types/tableau.ts
@backend/src/types/copilot.ts
@backend/src/services/contextBudget.ts
@backend/src/services/errors.ts

<interfaces>
<!-- Phase 2 service signatures the assembler consumes. EXACT shapes extracted
     from the live codebase on 2026-04-11 — do not paraphrase. -->

From backend/src/services/metadataService.ts:
```typescript
export async function fetchSchemaByDatasourceLuids(luids: readonly string[]): Promise<SchemaContext>;
export async function fetchWorkbookMetadata(workbookLuid: string): Promise<SchemaContext>;
```

From backend/src/services/vizqlService.ts (VERIFIED LIVE SHAPE — Blocker 2 fix):
```typescript
export const VIZQL_MAX_ROWS = 500;

/** One field in a VizQL query — caption plus optional aggregation function. */
export interface VizqlQueryField {
  readonly fieldCaption: string;  // <-- KEY: fieldCaption, NOT "name"
  readonly function?: 'SUM' | 'AVG' | 'COUNT' | 'MIN' | 'MAX' | 'MEDIAN';
}

export interface VizqlQueryRequest {
  readonly datasourceLuid: string;
  readonly fields: readonly VizqlQueryField[];
  readonly filters?: readonly VizqlFilter[];
  readonly limit?: number;
}

export async function queryVizqlDatasource(req: VizqlQueryRequest): Promise<LiveDataContext>;
```

Note: CLAUDE.md previously mentioned an `interpretFieldCaptionsAsFieldNames` toggle
that is NOT real. VDS natively matches field captions when fields are specified
using the `fieldCaption` key (verified empirically 2026-04-11 against 10ax.online.tableau.com
in Phase 2 live UAT). The assembler MUST pass `{ fieldCaption: ... }` objects.

From backend/src/services/pulseService.ts:
```typescript
export async function fetchPulseContext(datasourceLuid: string): Promise<PulseContext>;
// Already encodes TAPI-10 graceful-degradation: empty PulseContext on no-metrics / 404 / 403.
// Phase 3 MUST NOT re-wrap its error handling.
```

From backend/src/types/tableau.ts (SchemaContext shape — the source of VDS fields):
```typescript
export interface SchemaField {
  readonly name: string;
  readonly caption: string;     // <-- source for fieldCaption
  readonly dataType: string;
  readonly description: string;
  readonly upstreamLineage: readonly string[];
}
export interface SchemaContext {
  readonly datasources: Readonly<Record<string, readonly SchemaField[]>>;
  readonly workbook?: WorkbookMetadata;
}
```

From backend/src/types/copilot.ts (Plan 03-01):
```typescript
export interface CopilotContext { request, schema, liveData, pulse, servicesFired, workbook? }
export type ServicesFired = { metadata: ..., vizql: ..., pulse: ..., assemblyMs, contextChars, truncated }
```

From backend/src/services/contextBudget.ts (Plan 03-03):
```typescript
export function estimateContextChars(context: CopilotContext): number;
export function truncateContext(context: CopilotContext, target?, opts?): CopilotContext;
```
</interfaces>
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Write offline contextAssembler tests with monkey-patched services, then implement assembleContext with two-stage fan-out</name>
  <files>backend/src/services/contextAssembler.ts, backend/src/services/__tests__/contextAssembler.test.ts, backend/package.json</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-01 Promise.allSettled; D-02 2s/2.5s budgets; D-03 per-datasource schema semantics; D-04 all-schemas-fail → throw; D-05 ServicesFired shape; D-17 truncation order)
    - backend/src/services/metadataService.ts (lines 233–333, fetchSchemaByDatasourceLuids signature and return shape)
    - backend/src/services/vizqlService.ts (lines 77–130, VizqlQueryField uses `fieldCaption` NOT `name` — Blocker 2 evidence)
    - backend/src/services/pulseService.ts (lines 125–180, fetchPulseContext return shape on error vs success)
    - backend/src/types/tableau.ts (SchemaField.caption is the source for VDS fieldCaption)
    - backend/src/types/copilot.ts (from 03-01 — CopilotContext shape)
    - backend/src/services/contextBudget.ts (from 03-03 — truncateContext signature)
    - backend/src/services/errors.ts (from 03-01 — ContextAssemblerError)
    - backend/src/services/__tests__/pulseService.empty.test.ts (monkey-patch-via-dependency-injection pattern reference)
  </read_first>
  <behavior>
    Offline test cases. Export `assembleContext(request, deps?)` where `deps` is an optional `{ fetchSchema, queryVizql, fetchPulse }` object with defaults pointing at the real Phase 2 services. Tests inject stubs without touching the module loader.

    **Stub contract for tests 1, 8, 11:** The `queryVizql` stub must CAPTURE the args it's called with so tests can assert on the derived `fields[]` values. Minimal pattern:
    ```ts
    const vizqlCalls: Array<{ datasourceLuid: string; fields: readonly { fieldCaption: string }[]; limit?: number }> = [];
    const queryVizql = async (req) => { vizqlCalls.push(req); return {...fixedLiveDataContext, datasourceLuid: req.datasourceLuid}; };
    ```

    1. **Happy path — all three services return valid contexts.**
       Inject stub fetchSchema returning a `SchemaContext` with 1 LUID and at least 3 named `SchemaField`s (e.g. captions `"WTI_PRICE_USD"`, `"DATE"`, `"VOLUME"`). Stub fetchPulse returns populated PulseContext. Stub queryVizql echoes non-empty rows when called with non-empty fields[]. Assert:
       - returned CopilotContext.schema.datasources has the LUID
       - .liveData.length === 1
       - .pulse.length === 1
       - .servicesFired.metadata.status === 'ok' with datasources === 1
       - **.servicesFired.vizql.status === 'ok' with rows > 0** (this now holds because the assembler passes real fields from Stage A, not an empty array)
       - .servicesFired.pulse.status === 'ok' with metricCount > 0
       - .servicesFired.assemblyMs is a finite number > 0
       - .servicesFired.contextChars is > 0
       - .servicesFired.truncated === false (small fixture)

    2. **VDS fails — degrade silently.**
       Stub queryVizql to throw. Assert:
       - assembleContext RESOLVES (does not throw)
       - .servicesFired.vizql.status === 'error' with reason: string
       - .liveData is empty array OR array of empty-rows contexts per datasource (planner's call; test both)
       - .schema and .pulse are still populated

    3. **Pulse fails — degrade silently.**
       Stub fetchPulse to throw for one datasource. Assert:
       - .servicesFired.pulse.status === 'error'
       - .schema and .liveData still populated

    4. **One of N schemas fails — partial metadata success + VDS skipped for failed LUID.**
       Input: 3 LUIDs. Stub fetchSchemaByDatasourceLuids to return SchemaContext with 2 of 3 datasources populated (the 3rd missing). Assert:
       - .servicesFired.metadata.status === 'partial'
       - .servicesFired.metadata.ok === 2
       - .servicesFired.metadata.failed === 1
       - .servicesFired.metadata.failedLuids.length === 1
       - assembleContext RESOLVES (does not throw)
       - **VDS was called ONLY for the 2 resolved LUIDs** — assert vizqlCalls.length === 2, and every call's datasourceLuid is one of the 2 resolved LUIDs (not the failed one)

    5. **All schemas fail — hard throw.**
       Stub fetchSchemaByDatasourceLuids to throw. Assert:
       - assembleContext throws ContextAssemblerError
       - error.failedLuids equals the input LUIDs
       - error.cause is the underlying error
       - VDS and Pulse stubs were NEVER called (Stage B does not start without Stage A)

    6. **Per-service 2s timeout — D-02.**
       Stub fetchPulse to return a promise that never resolves (or delays 3000ms). The assembler's per-service AbortController should fire at 2s. Assert:
       - assembleContext resolves within 2.5s wall clock (use performance.now())
       - .servicesFired.pulse.status === 'error' with reason containing 'timeout' or 'abort'

    7. **Total 2.5s assembler budget — D-02.**
       Stub all three services to delay 3000ms. Assert:
       - assembleContext resolves or throws within 2800ms (leave 300ms of scheduling slop)
       - If Stage A (metadata) times out → ContextAssemblerError thrown, total wall clock still < 2800ms
       - If Stage A somehow resolves but Stage B runs out of budget → servicesFired.vizql and .pulse both have error status; CopilotContext still returned

    8. **Truncation applied — D-17.**
       Stub services to return a huge context (>70k chars — use repeated row fixtures via the echoing queryVizql stub that returns many rows). Assert:
       - .servicesFired.truncated === true
       - estimateContextChars on the returned context is ≤ EFFECTIVE_TARGET
       - .servicesFired.contextChars is the PRE-truncation value (per D-05)

    9. **assemblyMs is monotonic.**
       Stub services with deterministic 100ms delays. Assert .servicesFired.assemblyMs is ≥ 100 and < 2500.

    10. **Empty datasourceLuids.**
        Input: datasourceLuids: []. Expected: assembler returns immediately with an empty-but-valid CopilotContext. metadata.status: 'ok' with datasources: 0. Do NOT call any Tableau service.

    11. **(Blocker 2 contract test) VDS receives non-empty fields derived from schema.**
        Given a schema stub returning captions `["WTI_PRICE_USD","DATE","VOLUME","FOO","BAR"]` for one LUID, assert via the captured vizqlCalls array:
        - vizqlCalls.length === 1 (one call per resolved LUID)
        - vizqlCalls[0].fields.length > 0 AND ≤ 10 (top-N cap keeps token budget lean)
        - Every entry in vizqlCalls[0].fields has the shape `{ fieldCaption: string }` (NOT `{ name: string }` — grep-check via JSON.stringify)
        - Every fieldCaption is a member of the set `["WTI_PRICE_USD","DATE","VOLUME","FOO","BAR"]` (derived, not invented)
  </behavior>
  <action>
**Step A — Write the test file first.** Use the offline / monkey-patch style. Key pattern: export the assembler as `assembleContext(request, deps?)` where `deps` is an optional object `{ fetchSchema, queryVizql, fetchPulse }` with defaults pointing at the real Phase 2 services. This lets tests inject stubs without touching the module loader.

**Step B — Write `backend/src/services/contextAssembler.ts`.** Two-stage fan-out, annotated:

```typescript
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
 */
import { fetchSchemaByDatasourceLuids } from './metadataService.js';
import { queryVizqlDatasource, VIZQL_MAX_ROWS, type VizqlQueryField } from './vizqlService.js';
import { fetchPulseContext } from './pulseService.js';
import { truncateContext, estimateContextChars } from './contextBudget.js';
import { ContextAssemblerError } from './errors.js';
import { createLogger } from '../lib/logger.js';
import type {
  CopilotContext,
  CopilotContextRequest,
  ServicesFired,
} from '../types/copilot.js';
import type { SchemaContext, LiveDataContext, PulseContext, SchemaField } from '../types/tableau.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'contextAssembler',
});

export const PER_SERVICE_TIMEOUT_MS = 2_000;
export const TOTAL_BUDGET_MS = 2_500;
/** Cap how many captions we send to VDS per datasource — keeps the token budget lean. */
export const MAX_VDS_FIELDS_PER_LUID = 10;

export interface AssembleDeps {
  fetchSchema?: (luids: readonly string[]) => Promise<SchemaContext>;
  queryVizql?: (req: { datasourceLuid: string; fields: readonly VizqlQueryField[]; limit?: number }) => Promise<LiveDataContext>;
  fetchPulse?: (luid: string) => Promise<PulseContext>;
}

export async function assembleContext(
  request: CopilotContextRequest,
  deps: AssembleDeps = {},
): Promise<CopilotContext> {
  const t0 = performance.now();
  const luids = request.datasourceLuids;
  const doFetchSchema = deps.fetchSchema ?? fetchSchemaByDatasourceLuids;
  const doQueryVizql = deps.queryVizql ?? queryVizqlDatasource;
  const doFetchPulse = deps.fetchPulse ?? fetchPulseContext;

  // Empty input short-circuit
  if (luids.length === 0) {
    return finalize(request, { datasources: {} }, [], [], {
      metadata: { status: 'ok', datasources: 0 },
      vizql: { status: 'empty' },
      pulse: { status: 'empty' },
    }, performance.now() - t0);
  }

  // Total budget wrapper — race the whole two-stage fan-out against 2.5s.
  const deadlinePromise = new Promise<'BUDGET_EXCEEDED'>((resolve) =>
    setTimeout(() => resolve('BUDGET_EXCEEDED'), TOTAL_BUDGET_MS),
  );

  // ============ STAGE A: metadata (gates Stage B) ============
  let schema: SchemaContext;
  let metadataStatus: ServicesFired['metadata'];
  let resolvedLuids: string[];

  try {
    const stageA = await Promise.race([
      withTimeout('metadata', () => doFetchSchema(luids)),
      deadlinePromise,
    ]);
    if (stageA === 'BUDGET_EXCEEDED') {
      throw new ContextAssemblerError('Assembler budget exceeded in Stage A (metadata)', luids);
    }
    schema = stageA as SchemaContext;
  } catch (err) {
    // D-04 hard throw: the whole metadata call rejected.
    if (err instanceof ContextAssemblerError) throw err;
    throw new ContextAssemblerError('All datasource schemas failed', luids, err);
  }

  resolvedLuids = Object.keys(schema.datasources);
  const failedLuids = luids.filter((l) => !resolvedLuids.includes(l));
  if (resolvedLuids.length === 0) {
    // D-04 hard throw: 0 of N schemas resolved.
    throw new ContextAssemblerError('All datasource schemas failed', luids, new Error('schema.datasources was empty'));
  }
  metadataStatus =
    failedLuids.length === 0
      ? { status: 'ok', datasources: resolvedLuids.length }
      : { status: 'partial', ok: resolvedLuids.length, failed: failedLuids.length, failedLuids };

  // ============ STAGE B: VDS + Pulse in parallel (resolved LUIDs only) ============
  // Derive VDS fields[] from the Stage A schema — top N captions per LUID.
  // This is the Blocker 2 fix: VDS MUST receive non-empty fields[] for live
  // rows to come back. The shape is `{ fieldCaption }` per VizqlQueryField,
  // NOT `{ name }` — verified live against 10ax.online.tableau.com 2026-04-11.
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
  const pulsePromises = resolvedLuids.map((luid) => withTimeout('pulse', () => doFetchPulse(luid)));

  // D-01: Promise.allSettled across Stage B, still per-service AbortController
  // via withTimeout. Race against the total deadline so we never exceed 2.5s.
  const stageB = Promise.allSettled([...vizqlPromises, ...pulsePromises]);
  const raceResult = await Promise.race([stageB, deadlinePromise]);

  let results: PromiseSettledResult<unknown>[];
  if (raceResult === 'BUDGET_EXCEEDED') {
    log.warn({ budgetMs: TOTAL_BUDGET_MS }, 'context assembler total budget exceeded in Stage B');
    // Best-effort collection of already-settled values. Each Stage B call has a
    // 2s per-service cap, so `stageB` will settle shortly after the deadline.
    results = await stageB;
  } else {
    results = raceResult;
  }

  const vizqlResults = results.slice(0, resolvedLuids.length);
  const pulseResults = results.slice(resolvedLuids.length);

  // VDS (D-03: silent degrade, per-LUID)
  const liveData: LiveDataContext[] = [];
  let vizqlStatus: ServicesFired['vizql'];
  let vizqlOkRows = 0;
  let vizqlAnyError: string | undefined;
  for (const r of vizqlResults) {
    if (r.status === 'fulfilled') {
      const ld = r.value as LiveDataContext;
      liveData.push(ld);
      vizqlOkRows += ld.rows.length;
    } else {
      vizqlAnyError = String((r.reason as Error)?.message ?? r.reason ?? 'unknown');
    }
  }
  if (liveData.length === 0 && vizqlAnyError) {
    vizqlStatus = { status: 'error', reason: vizqlAnyError };
  } else if (vizqlOkRows === 0) {
    vizqlStatus = { status: 'empty' };
  } else {
    vizqlStatus = { status: 'ok', rows: vizqlOkRows };
  }

  // Pulse (D-03: silent degrade, per-LUID)
  const pulse: PulseContext[] = [];
  let pulseStatus: ServicesFired['pulse'];
  let pulseMetricCount = 0;
  let pulseAnyError: string | undefined;
  for (const r of pulseResults) {
    if (r.status === 'fulfilled') {
      const p = r.value as PulseContext;
      pulse.push(p);
      pulseMetricCount += p.metricDefinitions.length;
    } else {
      pulseAnyError = String((r.reason as Error)?.message ?? r.reason ?? 'unknown');
    }
  }
  if (pulse.length === 0 && pulseAnyError) {
    pulseStatus = { status: 'error', reason: pulseAnyError };
  } else if (pulseMetricCount === 0) {
    pulseStatus = { status: 'empty' };
  } else {
    pulseStatus = { status: 'ok', metricCount: pulseMetricCount };
  }

  const assemblyMs = performance.now() - t0;
  return finalize(request, schema, liveData, pulse, {
    metadata: metadataStatus,
    vizql: vizqlStatus,
    pulse: pulseStatus,
  }, assemblyMs);
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
      new Promise<never>((_, reject) =>
        ac.signal.addEventListener('abort', () =>
          reject(new Error(`${name} timed out after ${PER_SERVICE_TIMEOUT_MS}ms`)),
        ),
      ),
    ]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

function finalize(
  request: CopilotContextRequest,
  schema: SchemaContext,
  liveData: LiveDataContext[],
  pulse: PulseContext[],
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
```

**Step C — Add npm script:** `"smoke:assembler": "tsx src/services/__tests__/contextAssembler.test.ts"` after `smoke:budget`.

Do NOT add any new runtime dependency. `performance.now()` is a Node builtin. `AbortController` is a Node builtin.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:assembler</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/contextAssembler.ts`
    - File exists: `test -f backend/src/services/__tests__/contextAssembler.test.ts`
    - `grep -q "export async function assembleContext" backend/src/services/contextAssembler.ts`
    - `grep -q "Promise.allSettled" backend/src/services/contextAssembler.ts`
    - `grep -q "PER_SERVICE_TIMEOUT_MS = 2_000" backend/src/services/contextAssembler.ts`
    - `grep -q "TOTAL_BUDGET_MS = 2_500" backend/src/services/contextAssembler.ts`
    - `grep -q "MAX_VDS_FIELDS_PER_LUID" backend/src/services/contextAssembler.ts`
    - `grep -q "AbortController" backend/src/services/contextAssembler.ts`
    - `grep -q "ContextAssemblerError" backend/src/services/contextAssembler.ts`
    - `grep -q "status: 'partial'" backend/src/services/contextAssembler.ts`
    - `grep -q "truncateContext" backend/src/services/contextAssembler.ts`
    - `grep -q "fieldCaption" backend/src/services/contextAssembler.ts` (Blocker 2 fix: must use the real VDS field shape, NOT `name`)
    - `grep -q "VizqlQueryField" backend/src/services/contextAssembler.ts` (type import from vizqlService.ts)
    - `grep -q "smoke:assembler" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:assembler` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test 7 (total 2.5s budget) measures wall clock via `performance.now()` — grep-verify: `grep -q "performance.now" backend/src/services/__tests__/contextAssembler.test.ts`
    - Test 11 (derived fields contract) captures VDS stub calls and asserts non-empty fields[] per LUID: `grep -q "vizqlCalls" backend/src/services/__tests__/contextAssembler.test.ts` AND `grep -q "fieldCaption" backend/src/services/__tests__/contextAssembler.test.ts`
    - Test file has at least 11 test cases: `grep -c "Test [0-9]" backend/src/services/__tests__/contextAssembler.test.ts` returns at least 11
  </acceptance_criteria>
  <done>assembleContext runs two-stage fan-out (Stage A metadata → Stage B Promise.allSettled[vizql, pulse]), derives VDS fields from Stage A schema using the real `fieldCaption` shape, honors all D-01/D-02/D-03/D-04 semantics, applies truncation, and passes ≥ 11 offline test cases via injected stubs.</done>
</task>

<task type="auto">
  <name>Task 2: Document withTimeout background-leak known limitation in STATE.md (Warning 9)</name>
  <files>.planning/STATE.md</files>
  <read_first>
    - .planning/STATE.md (existing structure — append under a "Known limitations" section or add one if absent)
  </read_first>
  <action>
Append a short entry to `.planning/STATE.md` documenting the withTimeout background-leak known limitation. Do NOT refactor tableauFetch to thread AbortSignal — that is a cross-phase change and expands scope.

The entry must include the literal substring `withTimeout background` so the acceptance criterion can grep-verify it, and must contain (verbatim or paraphrased closely):

> Context assembler timeouts return control to callers at 2s but do NOT abort the underlying Tableau HTTP fetches. Orphan fetches run to completion in the background and their results are discarded. Mitigated at v1 by rate limiting (D-22). Revisit in a dedicated phase if DoS load tests reveal connection-slot starvation.

Place under an appropriate section (e.g. "Known Limitations" or "Phase 3 Notes"); add the section header if needed. Do NOT touch unrelated STATE.md content.
  </action>
  <verify>
    <automated>grep -q "withTimeout background" .planning/STATE.md</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q "withTimeout background" .planning/STATE.md`
    - `grep -q "D-22\|rate limiting" .planning/STATE.md` (context of the mitigation)
    - No unrelated STATE.md content removed (spot-check via `git diff .planning/STATE.md`)
  </acceptance_criteria>
  <done>STATE.md entry documents the withTimeout background-leak v1 limitation so future phases see it during retrospective reviews.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CopilotContextRequest → Tableau services | `datasourceLuids` from the /context or /chat POST body. Each Phase 2 service already applies `LUID_REGEX` SSRF guards before URL construction. The assembler does NOT re-validate — it trusts the Phase 2 chokepoint. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-04-01 | DoS | Slow upstream taking down /chat | mitigate | D-02 per-service 2s AbortController + 2.5s total budget wrapper. Test 6 and 7 enforce wall-clock bounds. |
| T-03-04-02 | DoS | Oversized context consuming Anthropic budget | mitigate | D-17 truncateContext runs unconditionally inside `finalize()` before return. Test 8 enforces. |
| T-03-04-03 | Information Disclosure | Logging schema/pulse contents | mitigate | Logger calls are count-only: `{ budgetMs }`, `{ datasources }`, etc. Test file can grep-verify that no `log.info` in the source contains `schema.datasources` or `pulse.insightBundles` as object values. |
| T-03-04-04 | SSRF | `datasourceLuids` input | mitigate | Each Phase 2 service enforces `LUID_REGEX` before any URL build. The assembler passes LUIDs through without interpolation. Covered by Phase 2 Plan 02-04 plus the `tableauFetch` chokepoint. |
| T-03-04-05 | DoS (connection exhaustion) | withTimeout orphan fetches | accept (v1) | Known limitation: `withTimeout` does not thread AbortSignal into the underlying fetch. Orphan fetches run to completion in the background. Mitigated at v1 by D-22 rate limiting (60/min/IP on /chat, 10/min on /export). Documented in STATE.md for future revisit. |

No HIGH threats. SSRF is defence-in-depth: the primary control lives in the services.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:assembler` exits 0 (offline, monkey-patched)
- `pnpm --filter @aperture/backend typecheck` exits 0
- No new dependency added
- `grep -q "tableauFetch" backend/src/services/contextAssembler.ts` returns NO matches (assembler never touches tableauFetch directly; it only calls the Phase 2 services)
- `grep -q "withTimeout background" .planning/STATE.md` matches (Warning 9 known-limitation entry present)
</verification>

<success_criteria>
- assembleContext returns a CopilotContext with all fan-out paths honored
- VDS receives non-empty fields[] derived from Stage A schema using the real `fieldCaption` shape (Blocker 2 fix)
- Partial schema success (4/5 LUIDs) proceeds without throwing and VDS is skipped for the failed LUIDs
- 100% schema failure throws ContextAssemblerError with failedLuids
- VDS + Pulse failures record servicesFired.error without throwing
- Wall-clock tests 6 and 7 pass within the 2.5s budget
- Truncation applied on >70k-char fixture
- STATE.md documents the withTimeout background-leak v1 limitation
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-04-SUMMARY.md`
</output>
