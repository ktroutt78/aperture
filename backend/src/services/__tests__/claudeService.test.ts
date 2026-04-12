/**
 * Plan 03-05 Task 2 — OFFLINE unit test for claudeService.
 *
 * Runs WITHOUT any network access and WITHOUT any API key. Invocation:
 *   `pnpm --filter @aperture/backend smoke:claude`
 *
 * Exit 0 = model lock, system prompt shape, user-turn wrapping (D-15),
 * 10-turn history cap (D-18), StreamParser pipe-through, and every
 * ErrorCode mapping from classifyAnthropicError hold.
 * Exit 1 = regression.
 *
 * The style matches streamParser.test.ts / systemPromptBuilder.test.ts:
 * pure Node `assert/strict`, numbered test cases, injected SDK stub (via
 * `deps.client`) so no real Anthropic client is ever constructed.
 */
import assert from 'node:assert/strict';

import { streamChat, CLAUDE_MODEL, MAX_HISTORY_TURNS } from '../claudeService.js';
import type { StreamParserEvent } from '../streamParser.js';
import type {
  CopilotContext,
  ChatMessage,
  DashboardState,
} from '../../types/copilot.js';
import type { SchemaContext, LiveDataContext, PulseContext } from '../../types/tableau.js';
import { __resetEnvCacheForTests } from '../../config/env.js';

// ---------------------------------------------------------------------------
// Fixture builders — inline, no fixture file imports
// ---------------------------------------------------------------------------
function makeSchema(): SchemaContext {
  return {
    datasources: {
      'ds-prices': [
        {
          name: 'WTI_PRICE',
          caption: 'WTI Price',
          dataType: 'REAL',
          description: 'Daily WTI crude oil price in USD',
          upstreamLineage: [],
        },
      ],
    },
  };
}

function makeLiveData(): LiveDataContext[] {
  return [
    {
      datasourceLuid: 'ds-prices',
      fields: ['WTI Price'],
      filters: [],
      rows: [{ 'WTI Price': 82.5 }],
      transport: 'json',
    },
  ];
}

function makePulse(): PulseContext[] {
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

function makeContext(): CopilotContext {
  return {
    request: {
      workbookName: 'Oil',
      worksheetName: 'WTI',
      datasourceLuids: ['ds-prices'],
      selectedMarks: [],
      activeFilters: [],
    },
    schema: makeSchema(),
    liveData: makeLiveData(),
    pulse: makePulse(),
    servicesFired: {
      metadata: { status: 'ok', datasources: 1 },
      vizql: { status: 'ok', rows: 1 },
      pulse: { status: 'empty' },
      assemblyMs: 100,
      contextChars: 500,
      truncated: false,
    },
  };
}

const STATE: DashboardState = {
  workbookName: 'Oil',
  worksheetName: 'WTI',
  selectedMarks: [],
  activeFilters: [],
};

// ---------------------------------------------------------------------------
// Stub Anthropic SDK client
// ---------------------------------------------------------------------------
type StreamEvent =
  | { type: 'content_block_delta'; delta: { text: string } }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: Record<string, number> }
  | { type: 'message_stop'; message?: { usage?: Record<string, number> } };

interface StubCapture {
  calls: Array<{
    model: string;
    system: unknown;
    messages: Array<{ role: string; content: string }>;
    max_tokens?: number;
  }>;
}

function makeStub(
  events: readonly StreamEvent[] | (() => AsyncIterable<StreamEvent>),
  opts: { throwOnStream?: unknown } = {},
): { client: NonNullable<Parameters<typeof streamChat>[4]>['client']; capture: StubCapture } {
  const capture: StubCapture = { calls: [] };

  async function* iter(): AsyncGenerator<StreamEvent> {
    if (Array.isArray(events)) {
      for (const ev of events) yield ev;
    } else if (typeof events === 'function') {
      for await (const ev of events()) yield ev;
    }
  }

  const client = {
    messages: {
      stream: (reqOpts: unknown) => {
        capture.calls.push(reqOpts as StubCapture['calls'][number]);
        if (opts.throwOnStream !== undefined) {
          throw opts.throwOnStream;
        }
        // Return an async iterable — claudeService iterates it with `for await`.
        // The cast mirrors the loose `AsyncIterable<unknown>` the ClaudeDeps type
        // specifies, so nothing here depends on the real SDK's generic shape.
        return iter() as unknown as AsyncIterable<unknown> & {
          finalMessage?: () => Promise<unknown>;
        };
      },
    },
  };

  return { client, capture };
}

async function drain(
  gen: AsyncGenerator<StreamParserEvent, void, undefined>,
): Promise<StreamParserEvent[]> {
  const out: StreamParserEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`[test] PASS: ${name}`);
  } catch (err) {
    failed++;
    console.error(`[test] FAIL: ${name}`);
    console.error((err as Error).stack ?? (err as Error).message);
  }
}

// Ensure env cache always starts clean and has a key set (except Test 9).
function primeEnv(): void {
  __resetEnvCacheForTests();
  process.env.PORT = process.env.PORT ?? '3001';
  process.env.EXTENSION_ORIGIN = process.env.EXTENSION_ORIGIN ?? 'http://localhost:5173';
  process.env.ANTHROPIC_API_KEY = 'sk-test-offline-key';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Test 1 — Model lock (CLAUDE.md invariant)
  // -------------------------------------------------------------------------
  await test('Test 1: model is locked to claude-sonnet-4-20250514', async () => {
    primeEnv();
    const { client, capture } = makeStub([
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_stop' },
    ]);
    const events = await drain(
      streamChat(makeContext(), [], STATE, 'Question?', { client }),
    );
    assert.equal(capture.calls.length, 1, 'SDK stub was not called exactly once');
    assert.equal(
      capture.calls[0]!.model,
      'claude-sonnet-4-20250514',
      'model string must be the Phase-locked literal',
    );
    assert.equal(CLAUDE_MODEL, 'claude-sonnet-4-20250514');
    // Sanity: the iterator must have yielded something.
    assert.ok(events.length > 0, 'streamChat should yield events');
  });

  // -------------------------------------------------------------------------
  // Test 2 — System prompt block shape + cache marker on Schema (D-13/D-14)
  // -------------------------------------------------------------------------
  await test('Test 2: system blocks include Role/Contract/Schema with ephemeral cache marker', async () => {
    primeEnv();
    const { client, capture } = makeStub([{ type: 'message_stop' }]);
    await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
    const system = capture.calls[0]!.system as Array<{
      type: string;
      text: string;
      cache_control?: { type: string };
    }>;
    assert.ok(Array.isArray(system), 'system must be an array of content blocks');
    const joined = system.map((b) => b.text).join('\n');
    const iRole = joined.indexOf('# Role');
    const iContract = joined.indexOf('# Output Contract');
    const iSchema = joined.indexOf('# Schema');
    assert.ok(iRole >= 0 && iContract > iRole && iSchema > iContract, 'section order');
    // The Schema block (and ONLY a later block is allowed to also have marker in
    // the current design, but Plan 03-03 puts the single marker on Schema).
    const schemaBlock = system.find((b) => b.text.includes('# Schema'));
    assert.ok(schemaBlock, 'schema block missing');
    assert.deepEqual(schemaBlock!.cache_control, { type: 'ephemeral' });
  });

  // -------------------------------------------------------------------------
  // Test 3 — User turn wrapping (D-15)
  // -------------------------------------------------------------------------
  await test('Test 3: final user turn wraps dashboard state + question (D-15)', async () => {
    primeEnv();
    const { client, capture } = makeStub([{ type: 'message_stop' }]);
    const messages: ChatMessage[] = [
      { role: 'user', content: 'prev Q1' },
      { role: 'assistant', content: 'A1' },
    ];
    await drain(
      streamChat(
        makeContext(),
        messages,
        { workbookName: 'Oil', worksheetName: 'WTI', selectedMarks: [], activeFilters: [] },
        'Why the spike?',
        { client },
      ),
    );
    const sent = capture.calls[0]!.messages;
    assert.equal(sent.length, 3, 'should send prior 2 + 1 wrapped user turn');
    assert.equal(sent[0]!.role, 'user');
    assert.equal(sent[0]!.content, 'prev Q1');
    assert.equal(sent[1]!.role, 'assistant');
    assert.equal(sent[1]!.content, 'A1');
    assert.equal(sent[2]!.role, 'user');
    const finalContent = sent[2]!.content;
    assert.match(finalContent, /<dashboard_state>/, 'dashboard_state tag missing');
    assert.match(finalContent, /workbook: Oil/, 'workbook line missing');
    assert.match(finalContent, /worksheet: WTI/, 'worksheet line missing');
    assert.match(finalContent, /<question>Why the spike\?<\/question>/, 'question tag missing');
  });

  // -------------------------------------------------------------------------
  // Test 4 — 10-turn sliding window (D-18)
  // -------------------------------------------------------------------------
  await test('Test 4: history capped at 10 turns, oldest dropped (D-18)', async () => {
    primeEnv();
    assert.equal(MAX_HISTORY_TURNS, 10, 'MAX_HISTORY_TURNS constant must be 10');
    const { client, capture } = makeStub([{ type: 'message_stop' }]);
    const prior: ChatMessage[] = Array.from({ length: 15 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `msg-${i}`,
    }));
    await drain(streamChat(makeContext(), prior, STATE, 'final?', { client }));
    const sent = capture.calls[0]!.messages;
    // 10 prior + 1 wrapped final user turn = 11 total
    assert.equal(sent.length, 11, 'should be 10 capped prior + 1 final');
    // Oldest 5 (msg-0..msg-4) must be dropped; kept window is msg-5..msg-14.
    assert.equal(sent[0]!.content, 'msg-5', 'oldest dropped (expected msg-5 at head)');
    assert.equal(sent[9]!.content, 'msg-14', 'kept last msg at index 9');
    assert.match(sent[10]!.content, /<question>final\?<\/question>/);
  });

  // -------------------------------------------------------------------------
  // Test 5 — Text delta piping through StreamParser
  // -------------------------------------------------------------------------
  await test('Test 5: text deltas pipe through StreamParser to typed events', async () => {
    primeEnv();
    const { client } = makeStub([
      { type: 'content_block_delta', delta: { text: 'Prices rose. ' } },
      {
        type: 'content_block_delta',
        delta: { text: '[ANOMALY: fieldName="Region" value="West"]' },
      },
      { type: 'content_block_delta', delta: { text: ' Trend.' } },
      {
        type: 'content_block_delta',
        delta: { text: '\n\n{"suggestions":["q1","q2","q3"]}' },
      },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { input_tokens: 42, output_tokens: 7, cache_read_input_tokens: 3 },
      },
      { type: 'message_stop' },
    ]);
    const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));

    // Collapse event type sequence (deduped adjacent tokens) for ordering check.
    const order: string[] = [];
    for (const ev of events) {
      if (order[order.length - 1] !== ev.type) order.push(ev.type);
    }
    assert.deepEqual(order, ['token', 'anomaly', 'token', 'suggestions', 'done']);

    // Concatenate token text — must equal the narrative minus the tag + JSON.
    const tokenText = events
      .filter((e): e is Extract<StreamParserEvent, { type: 'token' }> => e.type === 'token')
      .map((e) => e.data.text)
      .join('');
    assert.equal(tokenText, 'Prices rose.  Trend.\n\n');

    const anomaly = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'anomaly' }> => e.type === 'anomaly',
    );
    assert.ok(anomaly, 'anomaly event missing');
    assert.equal(anomaly!.data.fieldName, 'Region');
    assert.equal(anomaly!.data.value, 'West');

    const suggestions = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.ok(suggestions);
    assert.deepEqual(suggestions!.data.items, ['q1', 'q2', 'q3']);

    const done = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(done);
    assert.equal(done!.data.stopReason, 'end_turn');
    assert.equal(done!.data.usage.inputTokens, 42);
    assert.equal(done!.data.usage.outputTokens, 7);
    assert.equal(done!.data.usage.cacheReadTokens, 3);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Anthropic timeout → ErrorCode.ANTHROPIC_TIMEOUT
  // -------------------------------------------------------------------------
  await test('Test 6: AbortError/timeout maps to ANTHROPIC_TIMEOUT', async () => {
    primeEnv();
    const err = new Error('stream timeout after 30000ms');
    err.name = 'AbortError';
    const { client } = makeStub([], { throwOnStream: err });
    const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
    const errEvent = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'error' }> => e.type === 'error',
    );
    assert.ok(errEvent, 'error event missing');
    assert.equal(errEvent!.data.code, 'ANTHROPIC_TIMEOUT');
    // done must follow so the SSE route can close cleanly.
    const doneEvent = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'done' }> => e.type === 'done',
    );
    assert.ok(doneEvent, 'done event must follow error');
  });

  // -------------------------------------------------------------------------
  // Test 7 — Anthropic 429 → ErrorCode.ANTHROPIC_RATE_LIMITED
  // -------------------------------------------------------------------------
  await test('Test 7: status 429 maps to ANTHROPIC_RATE_LIMITED', async () => {
    primeEnv();
    const err = Object.assign(new Error('rate limited'), { status: 429 });
    const { client } = makeStub([], { throwOnStream: err });
    const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
    const errEvent = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'error' }> => e.type === 'error',
    );
    assert.ok(errEvent);
    assert.equal(errEvent!.data.code, 'ANTHROPIC_RATE_LIMITED');
  });

  // -------------------------------------------------------------------------
  // Test 8 — generic Anthropic error → ANTHROPIC_ERROR
  // -------------------------------------------------------------------------
  await test('Test 8: generic APIError (status 500) maps to ANTHROPIC_ERROR', async () => {
    primeEnv();
    const err = Object.assign(new Error('internal server error'), { status: 500 });
    const { client } = makeStub([], { throwOnStream: err });
    const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
    const errEvent = events.find(
      (e): e is Extract<StreamParserEvent, { type: 'error' }> => e.type === 'error',
    );
    assert.ok(errEvent);
    assert.equal(errEvent!.data.code, 'ANTHROPIC_ERROR');
  });

  // -------------------------------------------------------------------------
  // Test 9 — Missing API key → ClaudeServiceError(INTERNAL) on first call
  // -------------------------------------------------------------------------
  await test('Test 9: missing ANTHROPIC_API_KEY → INTERNAL error on first yield', async () => {
    const prior = process.env.ANTHROPIC_API_KEY;
    try {
      delete process.env.ANTHROPIC_API_KEY;
      __resetEnvCacheForTests();
      // NOTE: deps.client is NOT passed — we want the "missing key + no stub" path.
      const events = await drain(streamChat(makeContext(), [], STATE, 'Q'));
      const first = events[0];
      assert.ok(first, 'should yield at least one event');
      assert.equal(first!.type, 'error');
      const errEvent = first as Extract<StreamParserEvent, { type: 'error' }>;
      assert.equal(errEvent.data.code, 'INTERNAL');
      assert.match(errEvent.data.message, /ANTHROPIC_API_KEY/);
    } finally {
      if (prior !== undefined) process.env.ANTHROPIC_API_KEY = prior;
      __resetEnvCacheForTests();
    }
  });

  // -------------------------------------------------------------------------
  // Test 10 — Usage passthrough from message_delta (INFO 11 coverage)
  // -------------------------------------------------------------------------
  await test('Test 10: usage accumulates from message_delta and falls back to 0 otherwise', async () => {
    primeEnv();
    // First sub-case: message_delta carries usage.
    {
      const { client } = makeStub([
        { type: 'content_block_delta', delta: { text: 'Hi.' } },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 33 },
        },
      ]);
      const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
      const done = events.find(
        (e): e is Extract<StreamParserEvent, { type: 'done' }> => e.type === 'done',
      );
      assert.ok(done);
      assert.equal(done!.data.usage.inputTokens, 11);
      assert.equal(done!.data.usage.outputTokens, 22);
      assert.equal(done!.data.usage.cacheReadTokens, 33);
    }

    // Second sub-case: stub provides NO usage at all — falls back to 0/0/0.
    {
      const { client } = makeStub([
        { type: 'content_block_delta', delta: { text: 'Hi.' } },
        { type: 'message_stop' },
      ]);
      const events = await drain(streamChat(makeContext(), [], STATE, 'Q', { client }));
      const done = events.find(
        (e): e is Extract<StreamParserEvent, { type: 'done' }> => e.type === 'done',
      );
      assert.ok(done);
      assert.equal(done!.data.usage.inputTokens, 0);
      assert.equal(done!.data.usage.outputTokens, 0);
      assert.equal(done!.data.usage.cacheReadTokens, 0);
    }
  });

  // -------------------------------------------------------------------------
  // Final summary
  // -------------------------------------------------------------------------
  console.log('');
  console.log(`[test] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('[test] fatal:', err);
  process.exit(1);
});
