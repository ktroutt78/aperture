/**
 * Plan 03-03 Task 1 — OFFLINE unit test for systemPromptBuilder.
 *
 * Runs WITHOUT any network access, WITHOUT any test framework. Invocation:
 *   `pnpm --filter @aperture/backend smoke:systemprompt`
 *
 * Exit 0 = D-13 section order, D-14 cache marker, D-15 user-turn preamble,
 * and every output contract literal string are present.
 * Exit 1 = regression.
 *
 * The style matches pulseService.empty.test.ts: pure Node `assert`, numbered
 * test cases, a final process.exit with accumulated pass/fail count.
 */
import assert from 'node:assert/strict';

import {
  buildSystemPrompt,
  buildUserTurn,
  type AnthropicContentBlock,
} from '../systemPromptBuilder.js';
import type { CopilotContext, DashboardState } from '../../types/copilot.js';
import type {
  SchemaField,
  PulseContext,
  LiveDataContext,
  SchemaContext,
} from '../../types/tableau.js';

// ---------------------------------------------------------------------------
// Fixture builders (inline — do not import from fixture files)
// ---------------------------------------------------------------------------

function makeField(
  caption: string,
  dataType: string,
  description: string,
  lineage: readonly string[] = [],
): SchemaField {
  return {
    name: caption.toUpperCase().replace(/\s+/g, '_'),
    caption,
    dataType,
    description,
    upstreamLineage: lineage,
  };
}

function makeSchema(): SchemaContext {
  return {
    datasources: {
      'ds-prices': [
        makeField('WTI Price', 'REAL', 'Daily WTI crude oil price in USD'),
        makeField('Brent Price', 'REAL', 'Daily Brent crude oil price in USD'),
        makeField('Date', 'DATE', 'Observation date', ['STG.PRICES.OBS_DT']),
      ],
      'ds-inventory': [
        makeField('Crude Inventory', 'REAL', 'Weekly crude inventory (kbbl)'),
        makeField('PADD', 'STRING', 'Petroleum Administration for Defense District'),
        makeField('Week', 'DATE', 'Observation week'),
      ],
    },
  };
}

function makePulse(hasMetrics: boolean): PulseContext[] {
  if (!hasMetrics) {
    return [
      {
        datasourceLuid: 'ds-prices',
        metricDefinitions: [],
        insightBundles: [],
        feedback: [],
        hasMetrics: false,
      },
    ];
  }
  return [
    {
      datasourceLuid: 'ds-prices',
      metricDefinitions: [
        { id: 'm1', name: 'WTI Crude Oil Price', description: 'Daily WTI', datasourceLuid: 'ds-prices' },
        { id: 'm2', name: 'Brent Crude Oil Price', description: 'Daily Brent', datasourceLuid: 'ds-prices' },
      ],
      insightBundles: [
        { metricId: 'm1', bundleId: 'b1', insightTypes: ['trend'], summary: 'Trend insight (weak)' },
        { metricId: 'm1', bundleId: 'b2', insightTypes: ['ban'], summary: 'BAN insight (strong)' },
        { metricId: 'm1', bundleId: 'b3', insightTypes: ['current-period'], summary: 'Current period (neutral)' },
        { metricId: 'm1', bundleId: 'b4', insightTypes: ['anomaly'], summary: 'Anomaly insight (strongest)' },
        { metricId: 'm1', bundleId: 'b5', insightTypes: ['drivers'], summary: 'Drivers insight (weakest)' },
      ],
      feedback: [
        { insightType: 'anomaly', thumbsUp: 10, thumbsDown: 0 },
        { insightType: 'ban', thumbsUp: 5, thumbsDown: 1 },
        { insightType: 'trend', thumbsUp: 1, thumbsDown: 1 },
        { insightType: 'drivers', thumbsUp: 0, thumbsDown: 5 },
        { insightType: 'current-period', thumbsUp: 2, thumbsDown: 2 },
      ],
      hasMetrics: true,
    },
  ];
}

function makeLiveData(): LiveDataContext[] {
  const rows = Array.from({ length: 10 }, (_, i) => ({
    'WTI Price': 70 + i,
    Date: `2026-04-${String(i + 1).padStart(2, '0')}`,
  }));
  return [
    {
      datasourceLuid: 'ds-prices',
      fields: ['WTI Price', 'Date'],
      filters: [],
      rows,
      transport: 'json',
    },
    {
      datasourceLuid: 'ds-inventory',
      fields: ['Crude Inventory', 'Week'],
      filters: [],
      rows: Array.from({ length: 10 }, (_, i) => ({
        'Crude Inventory': 400000 + i * 100,
        Week: `2026-W${i + 1}`,
      })),
      transport: 'json',
    },
    {
      datasourceLuid: 'ds-weather',
      fields: ['HDD'],
      filters: [],
      rows: Array.from({ length: 10 }, (_, i) => ({ HDD: 10 + i })),
      transport: 'json',
    },
  ];
}

function makeContext(opts: { hasMetrics?: boolean } = {}): CopilotContext {
  const hasMetrics = opts.hasMetrics ?? true;
  return {
    request: {
      workbookName: 'Oil Prices Dashboard',
      worksheetName: 'WTI Daily',
      datasourceLuids: ['ds-prices', 'ds-inventory', 'ds-weather'],
      selectedMarks: [],
      activeFilters: [],
    },
    schema: makeSchema(),
    liveData: makeLiveData(),
    pulse: makePulse(hasMetrics),
    servicesFired: {
      metadata: { status: 'ok', datasources: 2 },
      vizql: { status: 'ok', rows: 30 },
      pulse: { status: hasMetrics ? 'ok' : 'empty', ...(hasMetrics ? { metricCount: 2 } : {}) } as
        | { status: 'ok'; metricCount: number }
        | { status: 'empty' },
      assemblyMs: 1234,
      contextChars: 5000,
      truncated: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Test harness
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

function joinBlocks(blocks: readonly AnthropicContentBlock[]): string {
  return blocks.map((b) => b.text).join('\n');
}

// ---------------------------------------------------------------------------
// Test 1 — Section order (D-13)
// ---------------------------------------------------------------------------
test('1. section order D-13: Role → Output Contract → Schema → Pulse → Live Data', () => {
  const ctx = makeContext();
  const blocks = buildSystemPrompt(ctx);
  const joined = joinBlocks(blocks);

  const iRole = joined.indexOf('# Role');
  const iContract = joined.indexOf('# Output Contract');
  const iSchema = joined.indexOf('# Schema');
  const iPulse = joined.indexOf('# Pulse');
  const iLive = joined.indexOf('# Live Data');

  assert.ok(iRole >= 0, '# Role header missing');
  assert.ok(iContract >= 0, '# Output Contract header missing');
  assert.ok(iSchema >= 0, '# Schema header missing');
  assert.ok(iPulse >= 0, '# Pulse header missing');
  assert.ok(iLive >= 0, '# Live Data header missing');

  assert.ok(iRole < iContract, 'Role must come before Output Contract');
  assert.ok(iContract < iSchema, 'Output Contract must come before Schema');
  assert.ok(iSchema < iPulse, 'Schema must come before Pulse');
  assert.ok(iPulse < iLive, 'Pulse must come before Live Data');
});

// ---------------------------------------------------------------------------
// Test 2 — Output contract literal strings
// ---------------------------------------------------------------------------
test('2. output contract literal strings', () => {
  const ctx = makeContext();
  const blocks = buildSystemPrompt(ctx);
  const joined = joinBlocks(blocks);

  assert.ok(
    joined.includes('[ANOMALY: fieldName="x" value="y"]'),
    'anomaly tag template missing',
  );
  assert.ok(joined.includes('{"suggestions"'), 'suggestions JSON opener missing');
  assert.ok(joined.includes('exactly three'), '"exactly three" missing');
  assert.ok(
    joined.includes('no more than 3 paragraphs') ||
      joined.includes('at most 3 paragraphs') ||
      joined.includes('≤ 3 paragraphs'),
    '3-paragraph cap literal missing',
  );
  assert.ok(joined.includes('do not repeat') || joined.includes('Do not repeat'), 'do not repeat missing');
  assert.ok(
    joined.includes('use the exact field captions') ||
      joined.includes('Use the exact field captions') ||
      joined.includes('cite real field captions'),
    'field captions directive missing',
  );
  assert.ok(
    !joined.includes('claude-sonnet-4-20250514'),
    'model ID MUST NOT appear in system prompt (model lock is a config concern)',
  );
});

// ---------------------------------------------------------------------------
// Test 3 — Cache marker on Schema block (D-14)
// ---------------------------------------------------------------------------
test('3. cache_control: ephemeral on Schema block, NOT on Pulse/Live/Role/Contract', () => {
  const ctx = makeContext();
  const blocks = buildSystemPrompt(ctx);

  // Find the block whose text contains the Schema header.
  const schemaIdx = blocks.findIndex((b) => b.text.includes('# Schema'));
  assert.ok(schemaIdx >= 0, 'Schema block not found');
  const schemaBlock = blocks[schemaIdx];
  assert.ok(schemaBlock !== undefined, 'Schema block undefined');
  assert.deepEqual(
    schemaBlock!.cache_control,
    { type: 'ephemeral' },
    'Schema block must carry cache_control: { type: ephemeral }',
  );

  // Every OTHER block must NOT have cache_control.
  for (let i = 0; i < blocks.length; i++) {
    if (i === schemaIdx) continue;
    const b = blocks[i]!;
    assert.equal(
      b.cache_control,
      undefined,
      `block ${i} unexpectedly has cache_control (only Schema may have it)`,
    );
  }
});

// ---------------------------------------------------------------------------
// Test 4 — Schema rendering (two datasources, three fields each)
// ---------------------------------------------------------------------------
test('4. schema rendering: caption, dataType, description per field', () => {
  const ctx = makeContext();
  const blocks = buildSystemPrompt(ctx);
  const schemaText = blocks.find((b) => b.text.includes('# Schema'))!.text;

  // Per-datasource labels
  assert.ok(schemaText.includes('ds-prices'), 'ds-prices section missing');
  assert.ok(schemaText.includes('ds-inventory'), 'ds-inventory section missing');

  // Field captions from fixture
  assert.ok(schemaText.includes('WTI Price'), 'WTI Price caption missing');
  assert.ok(schemaText.includes('Brent Price'), 'Brent Price caption missing');
  assert.ok(schemaText.includes('Crude Inventory'), 'Crude Inventory caption missing');
  assert.ok(schemaText.includes('PADD'), 'PADD caption missing');

  // Data types
  assert.ok(schemaText.includes('REAL'), 'REAL dataType missing');
  assert.ok(schemaText.includes('DATE'), 'DATE dataType missing');
  assert.ok(schemaText.includes('STRING'), 'STRING dataType missing');

  // Descriptions
  assert.ok(schemaText.includes('Daily WTI crude oil price in USD'), 'WTI description missing');
  assert.ok(schemaText.includes('Weekly crude inventory (kbbl)'), 'inventory description missing');

  // Markdown table rows format — each line with 3 columns separated by `|`
  assert.ok(schemaText.includes('| caption | dataType | description |'), 'table header missing');
});

// ---------------------------------------------------------------------------
// Test 5 — Pulse rendering with hasMetrics=false
// ---------------------------------------------------------------------------
test('5. pulse rendering with hasMetrics=false: (no metrics configured)', () => {
  const ctx = makeContext({ hasMetrics: false });
  const blocks = buildSystemPrompt(ctx);
  const pulseText = blocks.find((b) => b.text.includes('# Pulse'))!.text;

  assert.ok(pulseText.includes('ds-prices'), 'ds-prices datasource label missing in Pulse block');
  assert.ok(
    pulseText.includes('(no metrics configured)'),
    'literal "(no metrics configured)" missing',
  );
});

// ---------------------------------------------------------------------------
// Test 6 — Pulse rendering with hasMetrics=true (top-3 by weight)
// ---------------------------------------------------------------------------
test('6. pulse rendering with hasMetrics=true: metrics + top-3 insights by weight', () => {
  const ctx = makeContext({ hasMetrics: true });
  const blocks = buildSystemPrompt(ctx);
  const pulseText = blocks.find((b) => b.text.includes('# Pulse'))!.text;

  // Metric names
  assert.ok(pulseText.includes('WTI Crude Oil Price'), 'WTI metric missing');
  assert.ok(pulseText.includes('Brent Crude Oil Price'), 'Brent metric missing');

  // Top-3 by weight (anomaly=+10, ban=+4, trend=0, current-period=0, drivers=-5)
  // Expected top 3: anomaly, ban, then trend or current-period (both 0 — either is acceptable).
  assert.ok(pulseText.includes('Anomaly insight (strongest)'), 'top-weighted anomaly insight missing');
  assert.ok(pulseText.includes('BAN insight (strong)'), 'second-weighted ban insight missing');

  // Weakest (drivers, weight -5) must NOT appear in the top-3 render
  assert.ok(
    !pulseText.includes('Drivers insight (weakest)'),
    'weakest drivers insight should be cut from top-3',
  );
});

// ---------------------------------------------------------------------------
// Test 7 — Live data rendering
// ---------------------------------------------------------------------------
test('7. live data rendering: one section per datasource, rows as compact JSON', () => {
  const ctx = makeContext();
  const blocks = buildSystemPrompt(ctx);
  const liveText = blocks.find((b) => b.text.includes('# Live Data'))!.text;

  // Each datasource labeled
  assert.ok(liveText.includes('ds-prices'), 'ds-prices live section missing');
  assert.ok(liveText.includes('ds-inventory'), 'ds-inventory live section missing');
  assert.ok(liveText.includes('ds-weather'), 'ds-weather live section missing');

  // Rows as compact JSON
  assert.ok(liveText.includes('"WTI Price":70'), 'WTI row 0 missing');
  assert.ok(liveText.includes('"Crude Inventory":400000'), 'inventory row 0 missing');
  assert.ok(liveText.includes('"HDD":10'), 'weather row 0 missing');
});

// ---------------------------------------------------------------------------
// Test 8 — User-turn wrapper (D-15)
// ---------------------------------------------------------------------------
test('8. buildUserTurn: dashboard_state + question wrap order', () => {
  const state: DashboardState = {
    workbookName: 'Oil Prices Dashboard',
    worksheetName: 'WTI Daily',
    selectedMarks: [{ field: 'Region', value: 'West' }],
    activeFilters: [{ field: 'Year', values: ['2025', '2026'] }],
  };
  const out = buildUserTurn(state, 'Why did WTI spike last week?');

  const lines = out.split('\n');
  // Order: opening tag, workbook, worksheet, selected_marks, active_filters, closing tag, blank, question
  assert.ok(out.includes('<dashboard_state>'), 'opening dashboard_state tag missing');
  assert.ok(out.includes('</dashboard_state>'), 'closing dashboard_state tag missing');
  assert.ok(out.includes('workbook: Oil Prices Dashboard'), 'workbook line missing');
  assert.ok(out.includes('worksheet: WTI Daily'), 'worksheet line missing');
  assert.ok(out.includes('Region=West'), 'selected_marks rendering missing');
  assert.ok(out.includes('Year=[2025,2026]'), 'active_filters rendering missing');
  assert.ok(out.includes('<question>Why did WTI spike last week?</question>'), 'question tag missing');

  // Order check — opening tag BEFORE closing tag BEFORE question
  const iOpen = out.indexOf('<dashboard_state>');
  const iClose = out.indexOf('</dashboard_state>');
  const iQ = out.indexOf('<question>');
  assert.ok(iOpen < iClose, 'open must precede close');
  assert.ok(iClose < iQ, 'dashboard_state close must precede question');

  // blank line between closing tag and question
  const closeLineIdx = lines.findIndex((l) => l === '</dashboard_state>');
  assert.ok(closeLineIdx >= 0, 'closing tag must be on its own line');
  assert.equal(lines[closeLineIdx + 1], '', 'blank line required after </dashboard_state>');
});

// ---------------------------------------------------------------------------
// Test 9 — User-turn with empty marks and filters
// ---------------------------------------------------------------------------
test('9. buildUserTurn: empty arrays render as "none"', () => {
  const state: DashboardState = {
    workbookName: 'wb',
    worksheetName: 'ws',
    selectedMarks: [],
    activeFilters: [],
  };
  const out = buildUserTurn(state, 'hi');

  assert.ok(out.includes('selected_marks: none'), 'empty selectedMarks must render as "none"');
  assert.ok(out.includes('active_filters: none'), 'empty activeFilters must render as "none"');
});

// ---------------------------------------------------------------------------
// Final summary
// ---------------------------------------------------------------------------
console.log(`\n[test] ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
