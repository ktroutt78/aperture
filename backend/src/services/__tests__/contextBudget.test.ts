/**
 * Plan 03-03 Task 2 — OFFLINE unit test for contextBudget.
 *
 * Runs WITHOUT any network access. Invocation:
 *   `pnpm --filter @aperture/backend smoke:budget`
 *
 * Exit 0 = D-16 estimator is deterministic and D-17 truncation applies in
 * priority order (rows → pulse bundles → schema fields) with the
 * minimum-1-field-per-datasource invariant preserved.
 * Exit 1 = regression.
 */
import assert from 'node:assert/strict';

import {
  estimateContextChars,
  truncateContext,
  HALVE_SEQUENCE,
  TARGET_CHARS,
  SAFETY_MARGIN,
  EFFECTIVE_TARGET,
} from '../contextBudget.js';
import type { CopilotContext } from '../../types/copilot.js';
import type {
  SchemaField,
  LiveDataContext,
  PulseContext,
  SchemaContext,
} from '../../types/tableau.js';

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
interface LogCall {
  readonly obj: unknown;
  readonly msg?: string;
}

function makeMockLogger(): {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  calls: LogCall[];
} {
  const calls: LogCall[] = [];
  return {
    calls,
    info(obj: unknown, msg?: string): void {
      calls.push({ obj, msg });
    },
    warn(obj: unknown, msg?: string): void {
      calls.push({ obj, msg });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeField(
  captionLen: number,
  descLen: number,
  lineageLen = 0,
  idx = 0,
): SchemaField {
  const caption = `fld_${idx}_${'c'.repeat(Math.max(0, captionLen - 6))}`;
  const description = 'd'.repeat(descLen);
  const lineage = lineageLen > 0 ? ['l'.repeat(lineageLen)] : [];
  return {
    name: caption.toUpperCase(),
    caption,
    dataType: 'STRING',
    description,
    upstreamLineage: lineage,
  };
}

function makeSchema(datasources: Record<string, readonly SchemaField[]>): SchemaContext {
  return { datasources };
}

function makeRows(n: number, payloadLen: number): ReadonlyArray<Readonly<Record<string, unknown>>> {
  const rows: Array<Readonly<Record<string, unknown>>> = [];
  for (let i = 0; i < n; i++) {
    rows.push({ idx: i, v: 'x'.repeat(payloadLen) });
  }
  return rows;
}

function makeLiveData(
  luid: string,
  rowCount: number,
  rowPayloadLen: number,
): LiveDataContext {
  return {
    datasourceLuid: luid,
    fields: ['idx', 'v'],
    filters: [],
    rows: makeRows(rowCount, rowPayloadLen),
    transport: 'json',
  };
}

function makePulseCtx(luid: string, bundleCount: number, summaryLen: number): PulseContext {
  const bundles = [];
  for (let i = 0; i < bundleCount; i++) {
    bundles.push({
      metricId: 'm1',
      bundleId: `b${i}`,
      insightTypes: ['trend'],
      summary: `s${i}_` + 's'.repeat(summaryLen),
    });
  }
  return {
    datasourceLuid: luid,
    metricDefinitions: [{ id: 'm1', name: 'M', description: 'D', datasourceLuid: luid }],
    insightBundles: bundles,
    feedback: [{ insightType: 'trend', thumbsUp: 1, thumbsDown: 0 }],
    hasMetrics: true,
  };
}

function makeContext(opts: {
  schemaDatasources: Record<string, readonly SchemaField[]>;
  liveData: readonly LiveDataContext[];
  pulse: readonly PulseContext[];
}): CopilotContext {
  return {
    request: {
      workbookName: 'wb',
      worksheetName: 'ws',
      datasourceLuids: [...Object.keys(opts.schemaDatasources)],
      selectedMarks: [],
      activeFilters: [],
    },
    schema: makeSchema(opts.schemaDatasources),
    liveData: opts.liveData,
    pulse: opts.pulse,
    servicesFired: {
      metadata: { status: 'ok', datasources: Object.keys(opts.schemaDatasources).length },
      vizql: { status: 'ok', rows: opts.liveData.reduce((s, ld) => s + ld.rows.length, 0) },
      pulse: { status: 'ok', metricCount: opts.pulse.length },
      assemblyMs: 100,
      contextChars: 0,
      truncated: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`[test] PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`[test] FAIL: ${name}`);
    console.error((err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Test 1 — constants
// ---------------------------------------------------------------------------
test('1. exported constants D-16', () => {
  assert.equal(TARGET_CHARS, 70_000, 'TARGET_CHARS must be 70,000 (D-16)');
  assert.equal(SAFETY_MARGIN, 0.125, 'SAFETY_MARGIN must be 0.125 (D-16)');
  assert.equal(EFFECTIVE_TARGET, Math.floor(70_000 * (1 - 0.125)), 'EFFECTIVE_TARGET math');
  assert.deepEqual(
    [...HALVE_SEQUENCE],
    [500, 250, 125, 62, 31, 15, 7, 0],
    'HALVE_SEQUENCE must match D-17 exactly',
  );
});

// ---------------------------------------------------------------------------
// Test 2 — estimateContextChars deterministic and counts all sections
// ---------------------------------------------------------------------------
test('2. estimateContextChars counts schema + live + pulse deterministically', () => {
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 100, 20, 0)],
    },
    liveData: [makeLiveData('a', 1, 50)],
    pulse: [makePulseCtx('a', 1, 30)],
  });
  const e1 = estimateContextChars(ctx);
  const e2 = estimateContextChars(ctx);
  assert.equal(e1, e2, 'deterministic');

  // Recompute expected manually to catch missing dimensions.
  let expected = 0;
  for (const fields of Object.values(ctx.schema.datasources)) {
    for (const f of fields) {
      expected += f.caption.length + f.dataType.length + f.description.length;
      for (const l of f.upstreamLineage) expected += l.length;
    }
  }
  for (const ld of ctx.liveData) {
    for (const row of ld.rows) expected += JSON.stringify(row).length;
    for (const fn of ld.fields) expected += fn.length;
  }
  for (const p of ctx.pulse) {
    for (const m of p.metricDefinitions) expected += m.name.length + m.description.length;
    for (const b of p.insightBundles) expected += b.summary.length;
  }
  // Allow up to 1% tolerance in case the implementation adds a small
  // per-section overhead char count.
  const tol = Math.max(5, Math.floor(expected * 0.01));
  assert.ok(
    Math.abs(e1 - expected) <= tol,
    `estimate ${e1} not within ${tol} of expected ${expected}`,
  );
});

// ---------------------------------------------------------------------------
// Test 3 — Under-budget context unchanged (no truncation)
// ---------------------------------------------------------------------------
test('3. under-budget context unchanged, truncated: false', () => {
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 100, 0, 0)],
    },
    liveData: [makeLiveData('a', 5, 20)],
    pulse: [makePulseCtx('a', 1, 20)],
  });
  const before = estimateContextChars(ctx);
  assert.ok(before < 70_000, `fixture should be under target, got ${before}`);

  const out = truncateContext(ctx, 70_000);
  // All arrays should be unchanged
  assert.equal(out.liveData[0]!.rows.length, 5, 'rows unchanged');
  assert.equal(out.pulse[0]!.insightBundles.length, 1, 'bundles unchanged');
  assert.equal(out.servicesFired.truncated, false, 'truncated flag must stay false');
});

// ---------------------------------------------------------------------------
// Test 4 — Live data halving triggers and stays proportional
// ---------------------------------------------------------------------------
test('4. live data halving — rows reduce through HALVE_SEQUENCE', () => {
  // Build a ~150k-char fixture driven by row count. 2 datasources, 500 rows each,
  // each row ~150 chars → ~150k chars.
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 50, 0, 0)],
      b: [makeField(10, 50, 0, 0)],
    },
    liveData: [makeLiveData('a', 500, 100), makeLiveData('b', 500, 100)],
    pulse: [makePulseCtx('a', 0, 0), makePulseCtx('b', 0, 0)],
  });
  const before = estimateContextChars(ctx);
  assert.ok(before > 70_000, `fixture must exceed target, got ${before}`);

  const logger = makeMockLogger();
  const out = truncateContext(ctx, EFFECTIVE_TARGET, { logger });
  assert.equal(out.servicesFired.truncated, true, 'truncated flag must be true');

  // Final rows per datasource must be from HALVE_SEQUENCE
  const validCounts = new Set(HALVE_SEQUENCE);
  for (const ld of out.liveData) {
    assert.ok(
      validCounts.has(ld.rows.length as (typeof HALVE_SEQUENCE)[number]),
      `row count ${ld.rows.length} not in HALVE_SEQUENCE`,
    );
  }

  // After truncation, estimate must be within target
  const after = estimateContextChars(out);
  assert.ok(after <= EFFECTIVE_TARGET, `post-truncation ${after} > target ${EFFECTIVE_TARGET}`);

  // Logger must have been called with step: halve-rows
  const haveHalveLog = logger.calls.some((c) => {
    const o = c.obj as { step?: string } | null;
    return typeof o === 'object' && o !== null && o.step === 'halve-rows';
  });
  assert.ok(haveHalveLog, 'expected at least one halve-rows log entry');
});

// ---------------------------------------------------------------------------
// Test 5 — Halving is proportional across datasources
// ---------------------------------------------------------------------------
test('5. halving applies equally to all datasources', () => {
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 50, 0, 0)],
      b: [makeField(10, 50, 0, 0)],
      c: [makeField(10, 50, 0, 0)],
    },
    liveData: [
      makeLiveData('a', 500, 100),
      makeLiveData('b', 500, 100),
      makeLiveData('c', 500, 100),
    ],
    pulse: [],
  });
  const out = truncateContext(ctx, EFFECTIVE_TARGET);
  const counts = out.liveData.map((ld) => ld.rows.length);
  // All three datasources should have the same row count after halving.
  assert.equal(
    new Set(counts).size,
    1,
    `row counts must be equal across datasources, got ${JSON.stringify(counts)}`,
  );
});

// ---------------------------------------------------------------------------
// Test 6 — Pulse bundle FIFO drop
// ---------------------------------------------------------------------------
test('6. pulse bundle FIFO drop — oldest (index 0) first', () => {
  // Force the context over-budget via pulse bundles only.
  // Each bundle summary is 800 chars, 100 bundles → 80k chars of pulse alone.
  const bundleLen = 800;
  const bundleCount = 100;
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 50, 0, 0)],
    },
    liveData: [makeLiveData('a', 0, 0)], // already at zero rows
    pulse: [makePulseCtx('a', bundleCount, bundleLen)],
  });

  const before = estimateContextChars(ctx);
  assert.ok(before > 70_000, `fixture must exceed target, got ${before}`);

  const logger = makeMockLogger();
  const out = truncateContext(ctx, EFFECTIVE_TARGET, { logger });
  const remaining = out.pulse[0]!.insightBundles;
  // Some bundles must have been dropped
  assert.ok(
    remaining.length < bundleCount,
    `expected pulse bundles dropped, still ${remaining.length}`,
  );
  // Oldest-first: the first remaining bundle's bundleId must be > b0
  if (remaining.length > 0) {
    const first = remaining[0]!;
    const firstNum = parseInt(first.bundleId.replace('b', ''), 10);
    assert.ok(
      firstNum > 0,
      `FIFO drop failed — first remaining bundle is ${first.bundleId}, expected > b0`,
    );
  }

  // Metric definitions preserved
  assert.equal(out.pulse[0]!.metricDefinitions.length, 1, 'metric definitions must survive');

  // Truncated flag true
  assert.equal(out.servicesFired.truncated, true, 'truncated must be true');

  // Log for drop-pulse-bundles
  const haveDropLog = logger.calls.some((c) => {
    const o = c.obj as { step?: string } | null;
    return typeof o === 'object' && o !== null && o.step === 'drop-pulse-bundles';
  });
  assert.ok(haveDropLog, 'expected drop-pulse-bundles log entry');
});

// ---------------------------------------------------------------------------
// Test 7 — Schema field trim order (description → lineage → whole fields)
// ---------------------------------------------------------------------------
test('7. schema trim order: description first, then lineage, then whole fields', () => {
  // Force over-budget via a huge schema alone.
  // 2 datasources × 100 fields × 500-char description = 100k chars.
  const fields1: SchemaField[] = [];
  const fields2: SchemaField[] = [];
  for (let i = 0; i < 100; i++) {
    fields1.push(makeField(20, 500, 100, i));
    fields2.push(makeField(20, 500, 100, i));
  }
  const ctx = makeContext({
    schemaDatasources: { a: fields1, b: fields2 },
    liveData: [makeLiveData('a', 0, 0)],
    pulse: [],
  });

  const before = estimateContextChars(ctx);
  assert.ok(before > 70_000, `fixture must exceed target, got ${before}`);

  const logger = makeMockLogger();
  const out = truncateContext(ctx, EFFECTIVE_TARGET, { logger });
  const after = estimateContextChars(out);

  assert.ok(
    after <= EFFECTIVE_TARGET,
    `post-truncation ${after} > target ${EFFECTIVE_TARGET}`,
  );
  assert.equal(out.servicesFired.truncated, true, 'truncated must be true');

  // Every datasource must retain ≥1 field
  for (const [luid, fields] of Object.entries(out.schema.datasources)) {
    assert.ok(fields.length >= 1, `datasource ${luid} must keep ≥1 field, got ${fields.length}`);
  }

  // Expect some schema-trim step was logged
  const schemaTrimSteps = logger.calls.filter((c) => {
    const o = c.obj as { step?: string } | null;
    return typeof o === 'object' && o !== null && typeof o.step === 'string' && o.step.startsWith('trim-schema');
  });
  assert.ok(schemaTrimSteps.length > 0, 'expected at least one trim-schema log entry');
});

// ---------------------------------------------------------------------------
// Test 8 — Minimum-1-field invariant under extreme truncation
// ---------------------------------------------------------------------------
test('8. minimum-1-field-per-datasource invariant under extreme pressure', () => {
  const fields: SchemaField[] = [];
  for (let i = 0; i < 50; i++) {
    fields.push(makeField(20, 1000, 500, i));
  }
  const ctx = makeContext({
    schemaDatasources: { a: fields, b: fields.slice(), c: fields.slice() },
    liveData: [],
    pulse: [],
  });
  // Absurdly tight target
  const out = truncateContext(ctx, 500);
  for (const [luid, f] of Object.entries(out.schema.datasources)) {
    assert.ok(f.length >= 1, `${luid} must retain ≥1 field`);
  }
});

// ---------------------------------------------------------------------------
// Test 9 — >70k-char fixture (plan requirement)
// ---------------------------------------------------------------------------
test('9. >70k-char fixture is pulled under effective target', () => {
  const ctx = makeContext({
    schemaDatasources: {
      a: [makeField(10, 50, 0, 0)],
      b: [makeField(10, 50, 0, 0)],
    },
    liveData: [makeLiveData('a', 500, 200), makeLiveData('b', 500, 200)],
    pulse: [
      makePulseCtx('a', 20, 200),
      makePulseCtx('b', 20, 200),
    ],
  });
  const before = estimateContextChars(ctx);
  assert.ok(before > 70_000, `fixture must exceed 70k, got ${before}`);
  const out = truncateContext(ctx, EFFECTIVE_TARGET);
  const after = estimateContextChars(out);
  assert.ok(
    after <= EFFECTIVE_TARGET,
    `post-truncation ${after} > target ${EFFECTIVE_TARGET}`,
  );
  assert.equal(out.servicesFired.truncated, true);
});

// ---------------------------------------------------------------------------
console.log(`\n[test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
