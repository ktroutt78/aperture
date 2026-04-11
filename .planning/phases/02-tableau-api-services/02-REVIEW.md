---
phase: 02-tableau-api-services
reviewed: 2026-04-11T00:00:00Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - backend/src/types/tableau.ts
  - backend/src/services/metadataService.ts
  - backend/src/services/vizqlService.ts
  - backend/src/services/pulseService.ts
  - backend/src/services/__tests__/metadataService.smoke.ts
  - backend/src/services/__tests__/vizqlService.smoke.ts
  - backend/src/services/__tests__/pulseService.smoke.ts
  - backend/src/services/__tests__/pulseService.empty.test.ts
  - backend/src/services/__tests__/phase2.smoke.ts
  - backend/package.json
findings:
  critical: 0
  warning: 4
  info: 6
  total: 10
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-04-11
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

Phase 2 delivers three Tableau API services (Metadata GraphQL, VizQL Data Service, Pulse REST) plus a typed `SchemaContext` / `LiveDataContext` / `PulseContext` envelope, smoke harnesses for each, an offline TAPI-10 graceful-degradation unit test, and a `phase2.smoke.ts` runner.

Overall the code is high quality and the load-bearing ground rules from CLAUDE.md are all honored by construction:

- Every HTTP call routes through `tableauFetch` — no raw `fetch` against Tableau URLs anywhere in the three services (confirmed file by file).
- Strict LUID regex (`/^[a-f0-9-]{36}$/i`) runs before any URL or body is built, closing the SSRF / GraphQL-injection paths the plan called out.
- VizQL request body literally sets `interpretFieldCaptionsAsFieldNames: true`, and the TypeScript type (`true` as a literal, not `boolean`) prevents a future edit from silently flipping it to false.
- Row cap is enforced both server-hint-side (`effectiveLimit`) AND client-side (`.slice(0, effectiveLimit)` on both transports, plus an early break inside the SSE reader).
- Pulse degrades to `emptyPulseContext()` on 404 / 403 / empty-200, and the offline `pulseService.empty.test.ts` monkey-patches `fetch` to lock this contract without network.
- No hardcoded secrets, no `eval`, no `innerHTML`, no `child_process.spawn({ shell: true })`. The only `spawn` call (in `phase2.smoke.ts`) is explicitly shell-less.
- Pino logging is count-only — no raw field data, no bundle text, no tokens.

The findings below are all correctness-adjacent edge cases and code-quality nits. None are exploitable security issues.

## Warnings

### WR-01: `fetchSchemaByDatasourceLuids` silently drops duplicate LUIDs from caller input

**File:** `backend/src/services/metadataService.ts:234-272`

**Issue:** If a caller passes the same LUID twice (e.g. the Phase 3 Context Assembler collects LUIDs from multiple worksheets and does not dedupe), Tableau's Metadata API will still return a single entry for that datasource. The result object `datasources: Record<string, readonly SchemaField[]>` naturally dedupes by key, but the `totalFields` log counter and the `returned` vs `requested` log line become misleading (`requested: 3, returned: 1, totalFields: N` looks like a Metadata API bug report when it is actually caller duplication).

More importantly, there is no upfront dedupe before sending `datasourceLuids` to GraphQL — we send duplicates over the wire. Low-severity but worth cleaning up since Phase 3 will be the primary caller and it will be collecting LUIDs via `flatMap`.

**Fix:**
```ts
// Dedupe after validation, before the network call.
const uniqueLuids = Array.from(new Set(datasourceLuids));
if (uniqueLuids.length === 0) {
  return { datasources: {} };
}
const data = await postGraphql<FieldsForDatasourcesResponse>(
  FIELDS_FOR_DATASOURCES_QUERY,
  { luids: uniqueLuids },
);
// ... log `requested: uniqueLuids.length` not `datasourceLuids.length`
```

---

### WR-02: VizQL SSE fallback re-POSTs the query when the SSE read aborts mid-stream — duplicates server load and risks duplicate side-effects if VDS ever changes semantics

**File:** `backend/src/services/vizqlService.ts:174-216`

**Issue:** The SSE path does `await tableauFetch(...)` with `Accept: text/event-stream`. If the server returns `text/event-stream` and `sseRes.ok` but `readSseRows` throws mid-stream (malformed event boundary, network hiccup, decoder error), the catch block logs `"SSE parse failed, falling back to JSON"` and falls through to a second `tableauFetch` POST of the **same query**. VDS `query-datasource` is a read operation today, so this is currently safe, but:

1. It means every SSE parse failure sends two identical queries to Tableau (wire cost + VDS query-token cost doubled).
2. It makes the worst-case behavior on flaky networks "silently send queries twice" which is surprising.
3. It couples SSE correctness to JSON fallback correctness — if both paths fail for the same underlying reason (auth, rate limit) the caller will see a `VizqlServiceError` that references the JSON status, hiding the SSE root cause.

**Fix:** Narrow the retry condition to only the case where the server did NOT speak SSE, not the case where SSE started streaming and then failed. Once we have received any SSE rows (or a `text/event-stream` content-type), treat a parse failure as a hard failure with a clear error:
```ts
if (sseRes.ok && contentType.includes('text/event-stream') && sseRes.body) {
  try {
    const rows = await readSseRows(sseRes.body, effectiveLimit);
    return buildContext(req, rows.slice(0, effectiveLimit), 'sse');
  } catch (err) {
    // SSE stream started but failed to parse — do NOT re-POST. Raise
    // a typed error so the caller can decide whether to retry.
    throw new VizqlServiceError('VizQL SSE stream parse failed mid-stream', {
      status: sseRes.status,
      cause: err,
    });
  }
}
// Only fall through to JSON when the server never spoke SSE at all.
```

---

### WR-03: Pulse feedback JSON parse is not wrapped — a malformed 200 body will throw out of the try/catch and surface as `PulseServiceError` instead of degrading

**File:** `backend/src/services/pulseService.ts:290-296`

**Issue:** The feedback block is wrapped in a `try/catch (err)`, but the `await fbRes.json()` call can throw a `SyntaxError` mid-parse which IS caught by the outer `catch`, **so this works** — false alarm on that path. However, the narrower issue is that the mapping step assumes `f.insight_type` is present and of type string. If a feedback record comes back with `insight_type: null` or missing entirely, the shape mapping builds `{ insightType: null, ... }` which violates the `InsightFeedbackMetadata` contract (`readonly insightType: string`).

TypeScript won't catch it because `PulseFeedbackResponse.insight_feedback[].insight_type` is declared `string` without optionality, but the wire data is external and should be treated as untrusted.

**Fix:**
```ts
feedback = (fbJson.insight_feedback ?? [])
  .filter((f): f is { insight_type: string; thumbs_up?: number; thumbs_down?: number } =>
    typeof f?.insight_type === 'string' && f.insight_type.length > 0,
  )
  .map((f) => ({
    insightType: f.insight_type,
    thumbsUp: f.thumbs_up ?? 0,
    thumbsDown: f.thumbs_down ?? 0,
  }));
```

---

### WR-04: `metadataService.toSchemaField` declares `SchemaField.caption` but always sets it equal to `name`, silently hiding a field-caption/name distinction if Metadata API evolves

**File:** `backend/src/services/metadataService.ts:198-222`

**Issue:** The function comment explicitly says "Metadata API's `name` on a published datasource field carries the user-facing caption. If a future schema exposes a distinct caption field, swap this single mapping without touching callers." That is correct today, but the query (`FIELDS_FOR_DATASOURCES_QUERY`) does not request any `caption` field, so if Tableau adds one in a future release it will never enter this codepath — the reviewer won't see the divergence until Claude starts producing narratives that don't match the dashboard labels. Since `interpretFieldCaptionsAsFieldNames: true` is load-bearing in VizQL (TAPI-04), field-caption handling is a CLAUDE.md rail and deserves defense-in-depth here.

**Fix:** Either (a) add `caption` to the GraphQL query now — Metadata API does expose a caption field on `DatasourceField` in recent releases — and fall back to `name` at mapping time, or (b) add a TODO with the exact schema check:
```graphql
query FieldsForDatasources($luids: [String!]!) {
  publishedDatasources(filter: { luidWithin: $luids }) {
    luid
    fields {
      name
      # Metadata API exposes a separate caption field on ColumnField /
      # CalculatedField in 2024.2+. Falls back to `name` at mapping time.
      ... on ColumnField { caption dataType }
      ... on CalculatedField { caption dataType }
      description
      upstreamColumns { name fullyQualifiedName }
    }
  }
}
```
Then at mapping: `caption: field.caption ?? name,`.

## Info

### IN-01: `LUID_PATTERN` is duplicated across three services — consolidate into a shared `tableauLuid.ts` util

**File:**
- `backend/src/services/metadataService.ts:54`
- `backend/src/services/vizqlService.ts:58`
- `backend/src/services/pulseService.ts:52`

**Issue:** All three services define the same regex `/^[a-f0-9-]{36}$/i` locally. If Phase 3 or a future Metadata API update tightens the LUID format (e.g. disallow uppercase, require specific dash positions), we would have to fix it in three places. The regex is also permissive: it accepts `36 characters of any mix of hex and dashes`, e.g. `------------------------------------` (36 dashes) passes. A stricter UUID regex would be:
```
/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
```

**Fix:** Create `backend/src/lib/tableauLuid.ts` exporting `isTableauLuid(value: string): boolean` and `assertTableauLuid(value: string, label: string): void` using the strict pattern, and import it from all three services. Keep `MetadataServiceError` / `VizqlServiceError` / `PulseServiceError` as the thrown types — the helper should throw a generic `Error` that each service catches and re-throws as its own typed error, or take a factory.

---

### IN-02: `VizqlServiceError.status` and `PulseServiceError` have inconsistent constructor shapes — `MetadataServiceError` takes `(msg, cause)`, the other two take `(msg, { cause })`

**File:**
- `backend/src/services/metadataService.ts:62-69`
- `backend/src/services/vizqlService.ts:65-74`
- `backend/src/services/pulseService.ts:59-66`

**Issue:** Three services, three slightly different error-class signatures. The Phase 3 Context Assembler will have to remember which is which when wrapping. Harmonize to one shape:
```ts
constructor(message: string, opts: { status?: number; cause?: unknown } = {}) { ... }
```
Metadata doesn't currently expose `status`, but should — all three services want "HTTP status if this was a response error" for the Context Assembler to decide degrade-vs-throw.

---

### IN-03: `vizqlService.readSseRows` does not handle Windows-style `\r\n\r\n` event boundaries

**File:** `backend/src/services/vizqlService.ts:302-356`

**Issue:** The SSE reader splits events on `'\n\n'` only. RFC-compliant SSE senders use `\r\n\r\n` or `\n\n` — Tableau Cloud currently sends `\n\n`, but a future proxy (CloudFront, a corporate TLS appliance, an nginx in front of the sandbox) could normalize line endings to `\r\n\r\n` and silently break the reader. Symptoms would be: buffer grows unbounded, no rows are ever produced, the outer `while (rows.length < limit)` loop exits on `done`, we return `[]`, and the catch falls through to... nothing (the SSE path returns `buildContext(req, [], 'sse')` which is technically valid but empty).

**Fix:** Normalize line endings once per decode, or split on a regex:
```ts
buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
```

---

### IN-04: `metadataService.smoke.ts` assertion `firstFieldList[0]` does not guard against empty arrays

**File:** `backend/src/services/__tests__/metadataService.smoke.ts:131-143`

**Issue:** `const firstField = firstFieldList && firstFieldList[0];` — if a datasource returns a non-empty LUID entry with a zero-length `fields` array (plausible if the sandbox has a datasource with only calculated fields Metadata API cannot introspect), `firstField` is `undefined` and the smoke fails with the generic `"FAIL: SchemaContext.datasources is empty"` message, which is misleading (it isn't empty — it has one datasource with zero fields). Minor but the diagnostic is the whole value of a smoke test.

**Fix:**
```ts
const firstField = firstFieldList?.[0];
if (!firstDs) {
  console.error('[smoke] FAIL: SchemaContext.datasources has no entries');
  process.exit(1);
}
if (!firstField) {
  console.error(`[smoke] FAIL: datasource ${firstDs} returned zero fields`);
  process.exit(1);
}
```

---

### IN-05: `pulseService.empty.test.ts` leaks the monkey-patched `globalThis.fetch` if an assertion throws outside the caught cases

**File:** `backend/src/services/__tests__/pulseService.empty.test.ts:125-186`

**Issue:** The `fail()` helper correctly restores `globalThis.fetch = realFetch` before `process.exit(1)`, and the top-level `run().catch(...)` does likewise. However, a synchronous throw during `run()` BEFORE the first `try/catch` (e.g. an import-time error in the dynamic import) would process-exit without restoration. This is not a leak in practice — the process is exiting — but it's a code-smell in a unit-test harness that will probably be copied for future offline tests.

**Fix:** Wrap the whole run in a `try/finally`:
```ts
try {
  await run();
} finally {
  globalThis.fetch = realFetch;
}
```

---

### IN-06: `phase2.smoke.ts` continues running subsequent steps after a failure but the log message `"[phase2] {label} exited with code {code}"` is identical to an ordinary info line — no visual separator

**File:** `backend/src/services/__tests__/phase2.smoke.ts:82-92`

**Issue:** When running manually, a failing early step (say, `metadataService.smoke.ts` exits 1 on a 403) gets a single-line log that blends into the PASS output from later steps. The final SUMMARY block does show PASS/FAIL, but the in-flight experience is confusing. Minor UX nit, not a correctness issue.

**Fix:** Promote failures mid-run to a visually distinct banner:
```ts
if (code !== 0) {
  console.log(`\n[phase2] !!!!!! ${step.label} FAILED (exit ${code}) !!!!!!\n`);
}
```

---

## Files Reviewed

1. `backend/src/types/tableau.ts` — Phase 2 shared types. All `readonly`, no mutation surface exported. `interpretFieldCaptionsAsFieldNames: true` lives in the request-body type (vizqlService) as a literal, not a boolean, which prevents a future edit from flipping it — excellent use of the type system as a guardrail. No issues.
2. `backend/src/services/metadataService.ts` — Metadata GraphQL service. Solid SSRF / injection guards. LUIDs only ever travel via `variables`, never interpolated into the query string. Findings: WR-01, WR-04, IN-01, IN-02.
3. `backend/src/services/vizqlService.ts` — VizQL Data Service client with SSE-first / JSON-fallback transport. Row cap enforced in both paths. Findings: WR-02, IN-01, IN-02, IN-03.
4. `backend/src/services/pulseService.ts` — Pulse REST service with graceful degradation on 404/403/empty-200. Per-metric `Promise.allSettled` isolates bundle failures. Findings: WR-03, IN-01, IN-02.
5. `backend/src/services/__tests__/metadataService.smoke.ts` — Live smoke. Cold-boot-clean. Finding: IN-04.
6. `backend/src/services/__tests__/vizqlService.smoke.ts` — Live smoke. Enforces TAPI-03 and TAPI-05 invariants. No issues.
7. `backend/src/services/__tests__/pulseService.smoke.ts` — Live smoke with strict PII discipline. Never prints raw bundles. No issues.
8. `backend/src/services/__tests__/pulseService.empty.test.ts` — Offline TAPI-10 unit test. Excellent use of dynamic import + fetch monkey-patch. Finding: IN-05.
9. `backend/src/services/__tests__/phase2.smoke.ts` — Phase 2 verification harness. Shell-less `spawn`, stdio inherited. Finding: IN-06.
10. `backend/package.json` — New `smoke:metadata`, `smoke:vizql`, `smoke:pulse`, `smoke:pulse:empty`, `smoke:phase2` scripts wired. No issues.

---

_Reviewed: 2026-04-11_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
