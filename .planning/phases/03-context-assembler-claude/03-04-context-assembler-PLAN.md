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
autonomous: true
requirements: [CTX-01, CTX-02, CTX-03]
tags: [phase-3, context-assembler, fan-out, wave-2]

must_haves:
  truths:
    - "assembleContext fans out to metadataService, vizqlService, and pulseService in parallel via Promise.allSettled (D-01)"
    - "Each service call is wrapped in its own AbortController with a hard 2s timeout (D-02)"
    - "The assembler as a whole has a hard 2.5s budget enforced as a wrapper around Promise.allSettled (D-02)"
    - "Schema fan-out is per-datasource: partial success returns a partial SchemaContext and marks metadata as 'partial' with failedLuids (D-03)"
    - "All-schemas-fail throws ContextAssemblerError with failedLuids populated — the route maps this to HTTP 502 SCHEMA_UNAVAILABLE (D-04)"
    - "VDS and Pulse failures are silently degraded: servicesFired.vizql and servicesFired.pulse record {status:'error',reason}, the narrative continues (D-03)"
    - "assembleContext calls truncateContext before returning, so the returned CopilotContext.servicesFired.contextChars is pre-truncation and .truncated reflects whether any trim ran"
    - "assembleContext returns a CopilotContext whose servicesFired matches D-05 verbatim"
  artifacts:
    - path: "backend/src/services/contextAssembler.ts"
      provides: "assembleContext(request) — the Phase 3 core primitive consumed by /context and /chat routes"
      contains: "export async function assembleContext"
    - path: "backend/src/services/__tests__/contextAssembler.test.ts"
      provides: "Offline tests with monkey-patched service functions proving fan-out, per-service failure handling, and budget enforcement"
      contains: "assembleContext"
  key_links:
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/metadataService.ts"
      via: "import { fetchSchemaByDatasourceLuids }"
      pattern: "fetchSchemaByDatasourceLuids"
    - from: "backend/src/services/contextAssembler.ts"
      to: "backend/src/services/vizqlService.ts"
      via: "import { queryVizqlDatasource }"
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
Implement the `ContextAssembler` — the central Phase 3 primitive that fans out to Metadata / VDS / Pulse in parallel, merges the results into a `CopilotContext`, applies D-17 truncation, and honors the D-01/D-02/D-03/D-04 failure semantics. This plan is Wave 2 and depends on Plans 03-01 (types), 03-03 (truncation + budget). Offline tests monkey-patch the three Phase 2 service functions so the test runs with no Tableau credentials.

Purpose: The assembler is the critical path. Its 2.5s budget is what makes "context assembles in under 3 seconds" achievable. Its partial-failure semantics are what make the demo resilient — one datasource 401 must not take down the whole panel.

Output: One service file, one offline test, one npm script.
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
<!-- Phase 2 service signatures the assembler consumes (from `grep -n export` at plan time). -->

From backend/src/services/metadataService.ts:
```typescript
export async function fetchSchemaByDatasourceLuids(luids: readonly string[]): Promise<SchemaContext>;
export async function fetchWorkbookMetadata(workbookLuid: string): Promise<SchemaContext>;
```

From backend/src/services/vizqlService.ts:
```typescript
export const VIZQL_MAX_ROWS = 500;
export interface VizqlQueryField { name: string; /* see vizqlService.ts for full shape */ }
export interface VizqlQueryRequest {
  datasourceLuid: string;
  fields: readonly VizqlQueryField[];
  filters?: readonly VizqlFilter[];
  limit?: number;
}
export async function queryVizqlDatasource(req: VizqlQueryRequest): Promise<LiveDataContext>;
```

From backend/src/services/pulseService.ts:
```typescript
export async function fetchPulseContext(datasourceLuid: string): Promise<PulseContext>;
// Already encodes TAPI-10 graceful-degradation: empty PulseContext on no-metrics / 404 / 403.
// Phase 3 MUST NOT re-wrap its error handling.
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
  <name>Task 1: Write offline contextAssembler tests with monkey-patched services, then implement assembleContext</name>
  <files>backend/src/services/contextAssembler.ts, backend/src/services/__tests__/contextAssembler.test.ts, backend/package.json</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-01 Promise.allSettled; D-02 2s/2.5s budgets; D-03 per-datasource schema semantics; D-04 all-schemas-fail → throw; D-05 ServicesFired shape; D-17 truncation order)
    - backend/src/services/metadataService.ts (lines 233–333, fetchSchemaByDatasourceLuids signature and return shape)
    - backend/src/services/vizqlService.ts (lines 77–130, VizqlQueryRequest + queryVizqlDatasource)
    - backend/src/services/pulseService.ts (lines 125–180, fetchPulseContext return shape on error vs success)
    - backend/src/types/copilot.ts (from 03-01 — CopilotContext shape)
    - backend/src/services/contextBudget.ts (from 03-03 — truncateContext signature)
    - backend/src/services/errors.ts (from 03-01 — ContextAssemblerError)
    - backend/src/services/__tests__/pulseService.empty.test.ts (monkey-patch-via-module-injection pattern reference)
  </read_first>
  <behavior>
    Offline test cases (monkey-patch the three service functions via dependency injection — export an `assembleContext` variant `assembleContextWithDeps` that takes an opts object with `{ fetchSchema, queryVizql, fetchPulse }` functions, or refactor to accept a deps arg):

    1. **Happy path — all three services return valid contexts.**
       Inject stub fetchers that return populated SchemaContext / LiveDataContext / PulseContext for 1 datasource LUID. Assert:
       - returned CopilotContext.schema.datasources has the LUID
       - .liveData.length === 1
       - .pulse.length === 1
       - .servicesFired.metadata.status === 'ok' with datasources === 1
       - .servicesFired.vizql.status === 'ok' with rows > 0
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

    4. **One of N schemas fails — partial metadata success.**
       Input: 3 LUIDs. Stub fetchSchemaByDatasourceLuids to return SchemaContext with 2 of 3 datasources populated (the 3rd missing). Assert:
       - .servicesFired.metadata.status === 'partial'
       - .servicesFired.metadata.ok === 2
       - .servicesFired.metadata.failed === 1
       - .servicesFired.metadata.failedLuids.length === 1
       - assembleContext RESOLVES (does not throw)

    5. **All schemas fail — hard throw.**
       Stub fetchSchemaByDatasourceLuids to throw. Assert:
       - assembleContext throws ContextAssemblerError
       - error.failedLuids equals the input LUIDs
       - error.cause is the underlying error

    6. **Per-service 2s timeout — D-02.**
       Stub fetchPulse to return a promise that never resolves (or delays 3000ms). The assembler's per-service AbortController should fire at 2s. Assert:
       - assembleContext resolves within 2.5s wall clock (use performance.now())
       - .servicesFired.pulse.status === 'error' with reason containing 'timeout' or 'abort'

    7. **Total 2.5s assembler budget — D-02.**
       Stub all three services to delay 3000ms. Assert:
       - assembleContext resolves within 2800ms (leave 300ms of scheduling slop)
       - All three services recorded as error with reason indicating budget exceeded
       - If all schemas error out this way → ContextAssemblerError thrown, total wall clock still < 2800ms

    8. **Truncation applied — D-17.**
       Stub services to return a huge context (>70k chars — use repeated row fixtures). Assert:
       - .servicesFired.truncated === true
       - estimateContextChars on the returned context is ≤ EFFECTIVE_TARGET
       - .servicesFired.contextChars is the PRE-truncation value (per D-05)

    9. **assemblyMs is monotonic.**
       Stub services with deterministic 100ms delays. Assert .servicesFired.assemblyMs is ≥ 100 and < 2500.

    10. **Empty datasourceLuids.**
        Input: datasourceLuids: []. Expected: assembler returns immediately with an empty-but-valid CopilotContext. metadata.status: 'ok' with datasources: 0. Do NOT call any Tableau service.
  </behavior>
  <action>
**Step A — Write the test file first.** Use the offline / monkey-patch style. Key pattern: export the assembler as `assembleContext(request, deps?)` where `deps` is an optional object `{ fetchSchema, queryVizql, fetchPulse }` with defaults pointing at the real Phase 2 services. This lets tests inject stubs without touching the module loader.

**Step B — Write `backend/src/services/contextAssembler.ts`.**

```typescript
/**
 * Context Assembler — Phase 3 core primitive. Fans out to metadataService,
 * vizqlService, and pulseService in parallel, merges into a single
 * CopilotContext, and applies D-17 truncation before returning.
 *
 * Failure semantics (D-03):
 *   - Schema failure: per-datasource granularity. Partial success OK.
 *                    Only a 100%-schema-failure is a hard throw.
 *   - VDS failure:   silent degradation. servicesFired.vizql = error.
 *   - Pulse failure: silent degradation. servicesFired.pulse = error.
 *
 * Budget (D-02):
 *   - Per-service: 2s AbortController.
 *   - Total:       2.5s wrapper wall clock.
 */
import { fetchSchemaByDatasourceLuids } from './metadataService.js';
import { queryVizqlDatasource, VIZQL_MAX_ROWS } from './vizqlService.js';
import { fetchPulseContext } from './pulseService.js';
import { truncateContext, estimateContextChars } from './contextBudget.js';
import { ContextAssemblerError } from './errors.js';
import { createLogger } from '../lib/logger.js';
import type {
  CopilotContext,
  CopilotContextRequest,
  ServicesFired,
} from '../types/copilot.js';
import type { SchemaContext, LiveDataContext, PulseContext } from '../types/tableau.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'contextAssembler',
});

export const PER_SERVICE_TIMEOUT_MS = 2_000;
export const TOTAL_BUDGET_MS = 2_500;

export interface AssembleDeps {
  fetchSchema?: (luids: readonly string[]) => Promise<SchemaContext>;
  queryVizql?: (req: { datasourceLuid: string; fields: readonly { name: string }[]; limit?: number }) => Promise<LiveDataContext>;
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

  // Per-service wrappers: AbortController + 2s timeout
  const schemaPromise = withTimeout('metadata', () => doFetchSchema(luids));
  const vizqlPromises = luids.map((luid) =>
    withTimeout('vizql', () => doQueryVizql({ datasourceLuid: luid, fields: [], limit: VIZQL_MAX_ROWS })),
  );
  const pulsePromises = luids.map((luid) => withTimeout('pulse', () => doFetchPulse(luid)));

  // Total-budget wrapper
  const budgetDeadline = new Promise<'BUDGET_EXCEEDED'>((resolve) =>
    setTimeout(() => resolve('BUDGET_EXCEEDED'), TOTAL_BUDGET_MS),
  );
  const allPromise = Promise.allSettled([schemaPromise, ...vizqlPromises, ...pulsePromises]);
  const raceResult = await Promise.race([allPromise, budgetDeadline]);

  let results: PromiseSettledResult<unknown>[];
  if (raceResult === 'BUDGET_EXCEEDED') {
    log.warn({ budgetMs: TOTAL_BUDGET_MS }, 'context assembler total budget exceeded');
    // Collect whatever is already settled; the unresolved ones are forced to error.
    // Simplest: wait briefly for the already-running Promise.allSettled since each has a 2s per-service cap.
    results = await allPromise;
  } else {
    results = raceResult;
  }

  // Split results
  const schemaResult = results[0];
  const vizqlResults = results.slice(1, 1 + luids.length);
  const pulseResults = results.slice(1 + luids.length);

  // Schema handling (D-03 + D-04)
  let schema: SchemaContext = { datasources: {} };
  let metadataStatus: ServicesFired['metadata'];
  if (schemaResult.status === 'fulfilled') {
    schema = schemaResult.value as SchemaContext;
    const resolved = Object.keys(schema.datasources);
    const failedLuids = luids.filter((l) => !resolved.includes(l));
    if (failedLuids.length === 0) {
      metadataStatus = { status: 'ok', datasources: resolved.length };
    } else if (resolved.length === 0) {
      throw new ContextAssemblerError('All datasource schemas failed', luids, new Error('schema.datasources was empty'));
    } else {
      metadataStatus = {
        status: 'partial',
        ok: resolved.length,
        failed: failedLuids.length,
        failedLuids,
      };
    }
  } else {
    // Full schema call rejected → D-04 hard throw.
    throw new ContextAssemblerError('All datasource schemas failed', luids, schemaResult.reason);
  }

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
      vizqlAnyError = String(r.reason?.message ?? r.reason ?? 'unknown');
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
      pulseAnyError = String(r.reason?.message ?? r.reason ?? 'unknown');
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

async function withTimeout<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), PER_SERVICE_TIMEOUT_MS);
  try {
    // Services don't take AbortSignal directly today — we race against the timeout.
    const result = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => ac.signal.addEventListener('abort', () => reject(new Error(`${name} timed out after ${PER_SERVICE_TIMEOUT_MS}ms`)))),
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

**IMPORTANT note on test 6 / 7:** the `withTimeout` implementation races against an AbortController. If the underlying Phase 2 service does not natively accept an AbortSignal, the race still returns control to the assembler at 2s — the in-flight Tableau fetch keeps running in the background but its result is discarded. Document this in the SUMMARY. Budget-deadline path depends on the Phase 2 services reacting to the 2s race; for this plan's offline tests that is true because stubs honor the race directly.
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
    - `grep -q "AbortController" backend/src/services/contextAssembler.ts`
    - `grep -q "ContextAssemblerError" backend/src/services/contextAssembler.ts`
    - `grep -q "status: 'partial'" backend/src/services/contextAssembler.ts`
    - `grep -q "truncateContext" backend/src/services/contextAssembler.ts`
    - `grep -q "smoke:assembler" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:assembler` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test 7 (total 2.5s budget) measures wall clock via `performance.now()` — grep-verify: `grep -q "performance.now" backend/src/services/__tests__/contextAssembler.test.ts`
  </acceptance_criteria>
  <done>assembleContext fans out in parallel, honors all D-01/D-02/D-03/D-04 semantics, applies truncation, and passes ≥ 10 offline test cases via injected stubs.</done>
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

No HIGH threats. SSRF is defence-in-depth: the primary control lives in the services.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:assembler` exits 0 (offline, monkey-patched)
- `pnpm --filter @aperture/backend typecheck` exits 0
- No new dependency added
- `grep -q "tableauFetch" backend/src/services/contextAssembler.ts` returns NO matches (assembler never touches tableauFetch directly; it only calls the Phase 2 services)
</verification>

<success_criteria>
- assembleContext returns a CopilotContext with all fan-out paths honored
- Partial schema success (4/5 LUIDs) proceeds without throwing
- 100% schema failure throws ContextAssemblerError with failedLuids
- VDS + Pulse failures record servicesFired.error without throwing
- Wall-clock tests 6 and 7 pass within the 2.5s budget
- Truncation applied on >70k-char fixture
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-04-SUMMARY.md`
</output>
