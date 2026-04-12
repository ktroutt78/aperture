/**
 * Plan 03-04 — OFFLINE unit test for contextAssembler.
 *
 * Runs WITHOUT any network access. Invocation:
 *   `pnpm --filter @aperture/backend smoke:assembler`
 *
 * Exercises the two-stage fan-out semantics (D-01/D-02/D-03/D-04), the
 * derived-fields contract (Blocker 2 fix: VDS receives `{ fieldCaption }`
 * derived from Stage A schema), and D-17 truncation on an oversized fixture.
 *
 * Monkey-patch style: the exported `assembleContext(request, deps?)` accepts an
 * optional `deps` object `{ fetchSchema, queryVizql, fetchPulse }` with
 * defaults that point at the real Phase 2 services. Tests inject stubs via
 * that parameter without touching the module loader or env. No test framework.
 * Exit 0 = all pass; exit 1 = any regression.
 */
import assert from 'node:assert/strict';

import {
  assembleContext,
  PER_SERVICE_TIMEOUT_MS,
  TOTAL_BUDGET_MS,
  MAX_VDS_FIELDS_PER_LUID,
} from '../contextAssembler.js';
import { ContextAssemblerError } from '../errors.js';
import { estimateContextChars, EFFECTIVE_TARGET } from '../contextBudget.js';
import type {
  CopilotContextRequest,
  CopilotContext,
} from '../../types/copilot.js';
import type {
  SchemaContext,
  SchemaField,
  LiveDataContext,
  PulseContext,
  PulseMetricDefinition,
  PulseInsightBundle,
} from '../../types/tableau.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeField(caption: string): SchemaField {
  return {
    name: caption.toUpperCase(),
    caption,
    dataType: 'STRING',
    description: `Field ${caption}`,
    upstreamLineage: [],
  };
}

function makeSchema(
  entries: Record<string, readonly string[]>,
): SchemaContext {
  const datasources: Record<string, readonly SchemaField[]> = {};
  for (const [luid, captions] of Object.entries(entries)) {
    datasources[luid] = captions.map(makeField);
  }
  return { datasources };
}

function makeLiveData(
  luid: string,
  rowCount: number,
  fieldCaptions: readonly string[] = ['WTI_PRICE_USD', 'DATE', 'VOLUME'],
): LiveDataContext {
  const rows = Array.from({ length: rowCount }, (_v, i) => {
    const row: Record<string, unknown> = {};
    for (const c of fieldCaptions) row[c] = `v-${c}-${i}`;
    return row;
  });
  return {
    datasourceLuid: luid,
    fields: fieldCaptions,
    filters: [],
    rows,
    transport: 'json',
  };
}

function makePulse(luid: string, withMetrics = true): PulseContext {
  const metricDefinitions: PulseMetricDefinition[] = withMetrics
    ? [
        {
          id: `m-${luid}`,
          name: `Metric for ${luid}`,
          description: 'desc',
          datasourceLuid: luid,
        },
      ]
    : [];
  const insightBundles: PulseInsightBundle[] = withMetrics
    ? [
        {
          metricId: `m-${luid}`,
          bundleId: `b-${luid}`,
          insightTypes: ['trend'],
          summary: 'a real pulse summary',
        },
      ]
    : [];
  return {
    datasourceLuid: luid,
    metricDefinitions,
    insightBundles,
    feedback: [],
    hasMetrics: withMetrics,
  };
}

function makeRequest(luids: readonly string[]): CopilotContextRequest {
  return {
    workbookName: 'TestWorkbook',
    worksheetName: 'TestSheet',
    datasourceLuids: luids,
    selectedMarks: [],
    activeFilters: [],
  };
}

// ---------------------------------------------------------------------------
// Small helpers to build stub bundles
// ---------------------------------------------------------------------------

interface VizqlCall {
  readonly datasourceLuid: string;
  readonly fields: readonly { readonly fieldCaption: string }[];
  readonly limit?: number;
}

function makeVizqlStub(handler: (req: VizqlCall) => Promise<LiveDataContext>): {
  queryVizql: (req: {
    datasourceLuid: string;
    fields: readonly { readonly fieldCaption: string }[];
    limit?: number;
  }) => Promise<LiveDataContext>;
  calls: VizqlCall[];
} {
  const calls: VizqlCall[] = [];
  const queryVizql = async (req: {
    datasourceLuid: string;
    fields: readonly { readonly fieldCaption: string }[];
    limit?: number;
  }): Promise<LiveDataContext> => {
    calls.push({
      datasourceLuid: req.datasourceLuid,
      fields: req.fields,
      limit: req.limit,
    });
    return handler({
      datasourceLuid: req.datasourceLuid,
      fields: req.fields,
      limit: req.limit,
    });
  };
  return { queryVizql, calls };
}

// ---------------------------------------------------------------------------
// Test runner (no test framework)
// ---------------------------------------------------------------------------

interface TestCase {
  readonly name: string;
  readonly fn: () => Promise<void>;
}
const tests: TestCase[] = [];
function test(name: string, fn: () => Promise<void>): void {
  tests.push({ name, fn });
}

// ===========================================================================
// Test 1 — Happy path: all three services return valid contexts.
// ===========================================================================
test('Test 1: happy path — all three services return valid contexts', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const schema = makeSchema({ [luid]: ['WTI_PRICE_USD', 'DATE', 'VOLUME'] });
  const stub = makeVizqlStub(async (req) =>
    makeLiveData(
      req.datasourceLuid,
      10,
      req.fields.map((f) => f.fieldCaption),
    ),
  );
  const ctx = await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => schema,
    queryVizql: stub.queryVizql,
    fetchPulse: async (l) => makePulse(l, true),
  });

  assert.ok(ctx.schema.datasources[luid], 'schema contains LUID');
  assert.equal(ctx.liveData.length, 1, 'liveData length === 1');
  assert.equal(ctx.pulse.length, 1, 'pulse length === 1');
  assert.equal(ctx.servicesFired.metadata.status, 'ok');
  if (ctx.servicesFired.metadata.status === 'ok') {
    assert.equal(ctx.servicesFired.metadata.datasources, 1);
  }
  assert.equal(ctx.servicesFired.vizql.status, 'ok');
  if (ctx.servicesFired.vizql.status === 'ok') {
    assert.ok(ctx.servicesFired.vizql.rows > 0, 'vizql rows > 0');
  }
  assert.equal(ctx.servicesFired.pulse.status, 'ok');
  if (ctx.servicesFired.pulse.status === 'ok') {
    assert.ok(ctx.servicesFired.pulse.metricCount > 0, 'pulse metricCount > 0');
  }
  assert.ok(Number.isFinite(ctx.servicesFired.assemblyMs));
  assert.ok(ctx.servicesFired.assemblyMs >= 0);
  assert.ok(ctx.servicesFired.contextChars > 0);
  assert.equal(ctx.servicesFired.truncated, false);
});

// ===========================================================================
// Test 2 — VDS fails — degrade silently.
// ===========================================================================
test('Test 2: VDS fails — degrade silently (no throw, vizql.status=error)', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const schema = makeSchema({ [luid]: ['WTI_PRICE_USD', 'DATE'] });
  const ctx = await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => schema,
    queryVizql: async () => {
      throw new Error('boom-vds');
    },
    fetchPulse: async (l) => makePulse(l, true),
  });
  assert.equal(ctx.servicesFired.vizql.status, 'error');
  if (ctx.servicesFired.vizql.status === 'error') {
    assert.match(ctx.servicesFired.vizql.reason, /boom-vds|vds/i);
  }
  assert.equal(ctx.liveData.length, 0, 'no livedata when VDS errored');
  assert.ok(ctx.schema.datasources[luid], 'schema still present');
  assert.equal(ctx.pulse.length, 1, 'pulse still present');
});

// ===========================================================================
// Test 3 — Pulse fails — degrade silently.
// ===========================================================================
test('Test 3: Pulse fails — degrade silently (no throw, pulse.status=error)', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const schema = makeSchema({ [luid]: ['WTI_PRICE_USD', 'DATE'] });
  const stub = makeVizqlStub(async (req) =>
    makeLiveData(
      req.datasourceLuid,
      5,
      req.fields.map((f) => f.fieldCaption),
    ),
  );
  const ctx = await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => schema,
    queryVizql: stub.queryVizql,
    fetchPulse: async () => {
      throw new Error('boom-pulse');
    },
  });
  assert.equal(ctx.servicesFired.pulse.status, 'error');
  if (ctx.servicesFired.pulse.status === 'error') {
    assert.match(ctx.servicesFired.pulse.reason, /boom-pulse|pulse/i);
  }
  assert.ok(ctx.schema.datasources[luid]);
  assert.equal(ctx.liveData.length, 1);
});

// ===========================================================================
// Test 4 — One of N schemas fails — partial success + VDS skipped for failed.
// ===========================================================================
test('Test 4: partial metadata success — VDS skipped for failed LUIDs', async () => {
  const l1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const l2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const l3 = 'cccccccccccccccccccccccccccccccc';
  const schema = makeSchema({
    [l1]: ['WTI_PRICE_USD', 'DATE'],
    [l2]: ['VOLUME'],
    // l3 missing intentionally
  });
  const stub = makeVizqlStub(async (req) =>
    makeLiveData(
      req.datasourceLuid,
      3,
      req.fields.map((f) => f.fieldCaption),
    ),
  );
  const ctx = await assembleContext(makeRequest([l1, l2, l3]), {
    fetchSchema: async () => schema,
    queryVizql: stub.queryVizql,
    fetchPulse: async (l) => makePulse(l, true),
  });

  assert.equal(ctx.servicesFired.metadata.status, 'partial');
  if (ctx.servicesFired.metadata.status === 'partial') {
    assert.equal(ctx.servicesFired.metadata.ok, 2);
    assert.equal(ctx.servicesFired.metadata.failed, 1);
    assert.equal(ctx.servicesFired.metadata.failedLuids.length, 1);
    assert.equal(ctx.servicesFired.metadata.failedLuids[0], l3);
  }
  // VDS called only for the 2 resolved LUIDs
  assert.equal(stub.calls.length, 2, 'vizql called for 2 resolved luids only');
  const calledLuids = stub.calls.map((c) => c.datasourceLuid).sort();
  assert.deepEqual(calledLuids, [l1, l2].sort());
  // l3 NOT among the calls
  assert.ok(!calledLuids.includes(l3));
});

// ===========================================================================
// Test 5 — All schemas fail — hard throw.
// ===========================================================================
test('Test 5: all schemas fail — throws ContextAssemblerError with failedLuids', async () => {
  const luids = ['11111111111111111111111111111111', '22222222222222222222222222222222'];
  let vdsCalled = false;
  let pulseCalled = false;
  let caught: unknown = null;
  try {
    await assembleContext(makeRequest(luids), {
      fetchSchema: async () => {
        throw new Error('boom-schema');
      },
      queryVizql: async () => {
        vdsCalled = true;
        return makeLiveData('x', 0);
      },
      fetchPulse: async () => {
        pulseCalled = true;
        return makePulse('x', false);
      },
    });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ContextAssemblerError, 'throws ContextAssemblerError');
  if (caught instanceof ContextAssemblerError) {
    assert.deepEqual([...caught.failedLuids].sort(), [...luids].sort());
    assert.ok(caught.cause !== undefined, 'cause is set');
  }
  assert.equal(vdsCalled, false, 'VDS stub NEVER called (Stage B skipped)');
  assert.equal(pulseCalled, false, 'Pulse stub NEVER called (Stage B skipped)');
});

// ===========================================================================
// Test 6 — Per-service 2s timeout (D-02).
// ===========================================================================
test('Test 6: per-service 2s timeout — pulse hang resolves within 2.5s', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const schema = makeSchema({ [luid]: ['WTI_PRICE_USD'] });
  const t0 = performance.now();
  const ctx = await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => schema,
    queryVizql: async (req) =>
      makeLiveData(
        req.datasourceLuid,
        3,
        req.fields.map((f) => f.fieldCaption),
      ),
    fetchPulse: () =>
      new Promise<PulseContext>(() => {
        // never resolves
      }),
  });
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 2_800, `elapsed ${elapsed}ms < 2800ms`);
  assert.ok(elapsed >= PER_SERVICE_TIMEOUT_MS - 100, `elapsed ${elapsed}ms >= ~${PER_SERVICE_TIMEOUT_MS}ms`);
  assert.equal(ctx.servicesFired.pulse.status, 'error');
  if (ctx.servicesFired.pulse.status === 'error') {
    assert.match(ctx.servicesFired.pulse.reason, /timed out|timeout|abort/i);
  }
});

// ===========================================================================
// Test 7 — Total 2.5s assembler budget (D-02).
// ===========================================================================
test('Test 7: total 2.5s budget — all services hang → resolves or throws within 2800ms', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const t0 = performance.now();
  let caught: unknown = null;
  let ctx: CopilotContext | null = null;
  try {
    ctx = await assembleContext(makeRequest([luid]), {
      fetchSchema: () =>
        new Promise<SchemaContext>(() => {
          // never resolves — Stage A hangs, withTimeout @2s fires
        }),
      queryVizql: () =>
        new Promise<LiveDataContext>(() => {
          // never resolves
        }),
      fetchPulse: () =>
        new Promise<PulseContext>(() => {
          // never resolves
        }),
    });
  } catch (err) {
    caught = err;
  }
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 2_800, `wall clock ${elapsed}ms < 2800ms`);
  // Either Stage A timed out as a ContextAssemblerError, or the total budget fired.
  // Either way we must not exceed the wall-clock bound.
  if (caught) {
    assert.ok(caught instanceof ContextAssemblerError, 'if thrown, is ContextAssemblerError');
  } else if (ctx) {
    // Unlikely path: Stage A somehow resolved but Stage B errored out.
    assert.equal(ctx.servicesFired.vizql.status, 'error');
    assert.equal(ctx.servicesFired.pulse.status, 'error');
  }
});

// ===========================================================================
// Test 8 — Truncation applied (D-17) on >70k-char fixture.
// ===========================================================================
test('Test 8: truncation applied — oversized context is trimmed', async () => {
  const l1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const l2 = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  // Build a big schema — many fields with long descriptions per LUID.
  const bigFields: SchemaField[] = Array.from({ length: 10 }, (_, i) => ({
    name: `FIELD_${i}`,
    caption: `FIELD_${i}`,
    dataType: 'STRING',
    description: 'x'.repeat(200),
    upstreamLineage: [],
  }));
  const schema: SchemaContext = {
    datasources: {
      [l1]: bigFields,
      [l2]: bigFields,
    },
  };
  // Live data: many rows with many chars per row per LUID.
  const bigLiveData = (luid: string): LiveDataContext => ({
    datasourceLuid: luid,
    fields: bigFields.map((f) => f.caption),
    filters: [],
    rows: Array.from({ length: 500 }, (_, i) => {
      const row: Record<string, unknown> = {};
      for (const f of bigFields) row[f.caption] = 'y'.repeat(50) + i;
      return row;
    }),
    transport: 'json',
  });
  const stub = makeVizqlStub(async (req) => bigLiveData(req.datasourceLuid));
  const ctx = await assembleContext(makeRequest([l1, l2]), {
    fetchSchema: async () => schema,
    queryVizql: stub.queryVizql,
    fetchPulse: async (l) => makePulse(l, true),
  });
  assert.equal(ctx.servicesFired.truncated, true, 'truncated=true on oversized input');
  const post = estimateContextChars(ctx);
  assert.ok(post <= EFFECTIVE_TARGET, `post-truncation ${post} <= EFFECTIVE_TARGET ${EFFECTIVE_TARGET}`);
  // contextChars is PRE-truncation per D-05
  assert.ok(
    ctx.servicesFired.contextChars >= post,
    `contextChars (pre-trunc ${ctx.servicesFired.contextChars}) >= post-trunc estimate ${post}`,
  );
});

// ===========================================================================
// Test 9 — assemblyMs is monotonic.
// ===========================================================================
test('Test 9: assemblyMs is ≥ 100ms when services delay 100ms, and < 2500ms', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const schema = makeSchema({ [luid]: ['WTI_PRICE_USD'] });
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));
  const ctx = await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => {
      await delay(100);
      return schema;
    },
    queryVizql: async (req) => {
      await delay(100);
      return makeLiveData(
        req.datasourceLuid,
        3,
        req.fields.map((f) => f.fieldCaption),
      );
    },
    fetchPulse: async (l) => {
      await delay(100);
      return makePulse(l, true);
    },
  });
  assert.ok(
    ctx.servicesFired.assemblyMs >= 100,
    `assemblyMs ${ctx.servicesFired.assemblyMs} >= 100`,
  );
  assert.ok(
    ctx.servicesFired.assemblyMs < TOTAL_BUDGET_MS,
    `assemblyMs ${ctx.servicesFired.assemblyMs} < ${TOTAL_BUDGET_MS}`,
  );
});

// ===========================================================================
// Test 10 — Empty datasourceLuids short-circuits.
// ===========================================================================
test('Test 10: empty datasourceLuids — no service called, empty-but-valid context', async () => {
  let fetchSchemaCalled = false;
  let vdsCalled = false;
  let pulseCalled = false;
  const ctx = await assembleContext(makeRequest([]), {
    fetchSchema: async () => {
      fetchSchemaCalled = true;
      return { datasources: {} };
    },
    queryVizql: async () => {
      vdsCalled = true;
      return makeLiveData('x', 0);
    },
    fetchPulse: async () => {
      pulseCalled = true;
      return makePulse('x', false);
    },
  });
  assert.equal(fetchSchemaCalled, false, 'fetchSchema NOT called');
  assert.equal(vdsCalled, false, 'queryVizql NOT called');
  assert.equal(pulseCalled, false, 'fetchPulse NOT called');
  assert.equal(ctx.servicesFired.metadata.status, 'ok');
  if (ctx.servicesFired.metadata.status === 'ok') {
    assert.equal(ctx.servicesFired.metadata.datasources, 0);
  }
  assert.equal(ctx.liveData.length, 0);
  assert.equal(ctx.pulse.length, 0);
  assert.deepEqual(Object.keys(ctx.schema.datasources), []);
});

// ===========================================================================
// Test 11 — Blocker 2 contract: VDS receives non-empty fields derived from schema.
// ===========================================================================
test('Test 11: VDS receives non-empty fields[] derived from schema captions (Blocker 2)', async () => {
  const luid = 'abc123def456abc123def456abc123de';
  const captions = ['WTI_PRICE_USD', 'DATE', 'VOLUME', 'FOO', 'BAR'];
  const schema = makeSchema({ [luid]: captions });
  const stub = makeVizqlStub(async (req) =>
    makeLiveData(
      req.datasourceLuid,
      1,
      req.fields.map((f) => f.fieldCaption),
    ),
  );
  await assembleContext(makeRequest([luid]), {
    fetchSchema: async () => schema,
    queryVizql: stub.queryVizql,
    fetchPulse: async (l) => makePulse(l, true),
  });

  assert.equal(stub.calls.length, 1, 'exactly 1 vizql call per resolved LUID');
  const call = stub.calls[0]!;
  assert.ok(call.fields.length > 0, 'fields non-empty');
  assert.ok(call.fields.length <= MAX_VDS_FIELDS_PER_LUID, `fields length ≤ ${MAX_VDS_FIELDS_PER_LUID}`);
  // Shape check: each entry has `fieldCaption`, NOT `name`
  for (const f of call.fields) {
    assert.equal(typeof f.fieldCaption, 'string', 'field has string fieldCaption');
    assert.ok(!('name' in f), 'field does NOT have `name` key');
    assert.ok(captions.includes(f.fieldCaption), `fieldCaption ${f.fieldCaption} is a real caption`);
  }
  // Stringify check matches the acceptance grep: `fieldCaption`
  const asJson = JSON.stringify(stub.calls);
  assert.ok(asJson.includes('fieldCaption'), 'serialized calls include `fieldCaption`');
  assert.ok(!asJson.includes('"name":"WTI_PRICE_USD"'), 'serialized calls do NOT use `name` key');
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
(async (): Promise<void> => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      // eslint-disable-next-line no-console
      console.log(`  PASS  ${t.name}`);
    } catch (err) {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`  FAIL  ${t.name}`);
      // eslint-disable-next-line no-console
      console.error(err);
    }
  }
  // eslint-disable-next-line no-console
  console.log(`\n${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
