/**
 * chatRoute — OFFLINE test suite for Plan 03-06 Task 2 (CTX-15).
 *
 * Zero network, zero Anthropic key, zero Tableau credentials. Uses Fastify's
 * built-in `inject()` harness plus injected stubs for BOTH `assembleContext`
 * (via ChatRouteOpts.assembler) and the Anthropic SDK (via
 * ChatRouteOpts.claudeDeps.client).
 *
 * Run with `pnpm --filter @aperture/backend smoke:chatroute`. Exit 0 = plan
 * holds. Exit 1 = regression.
 *
 * Test matrix (12 numbered cases):
 *
 *   Validation (400):
 *     Test 1  — 400 on missing workbookName
 *     Test 2  — 400 on invalid LUID
 *     Test 3  — 400 on empty question
 *     Test 4  — 400 on empty datasourceLuids
 *
 *   Env / assembler errors:
 *     Test 5  — 503 ENV_MISSING when ANTHROPIC_API_KEY is unset AND no stubbed client
 *     Test 6  — 502 SCHEMA_UNAVAILABLE when stubbed assembler throws ContextAssemblerError
 *
 *   Happy path SSE shape (stubbed assembler + stubbed Anthropic):
 *     Test 7  — Content-Type is text/event-stream
 *     Test 8  — first frame is `event: context`
 *     Test 9  — last frame before end is `event: done`
 *     Test 10 — anomaly event appears in the frame stream
 *     Test 11 — `[ANOMALY` substring does NOT appear in any `event: token` data payload
 *     Test 12 — `{"suggestions"` substring does NOT appear in any `event: token` data payload
 *
 * Refinement per INFO 10: Tests 11/12 parse SSE frames by splitting on
 * `\n\n`, filter to frames beginning `event: token\n`, and inspect the
 * `data:` line only. This is robust to frame boundary splits — a substring
 * scan of the raw wire would false-positive on the anomaly frame itself.
 */

// ---------------------------------------------------------------------------
// 1) Stub env vars BEFORE importing anything that calls loadEnv().
// ---------------------------------------------------------------------------
process.env.PORT ||= '3001';
process.env.EXTENSION_ORIGIN ||= 'http://localhost:5173';
// Provide a fake Anthropic key so the env cache bakes it in for Tests 1-4, 6-12.
// Test 5 deletes it, resets the env cache, runs, then restores it.
process.env.ANTHROPIC_API_KEY = 'sk-test-offline-chatroute';

import Fastify, { type FastifyInstance } from 'fastify';

const envModule = await import('../../config/env.js');
envModule.__resetEnvCacheForTests();

// Import route factory AFTER env is stubbed.
const { createChatRoutes } = await import('../../routes/chat.js');
const { ContextAssemblerError } = await import('../errors.js');

import type {
  CopilotContext,
  CopilotContextRequest,
} from '../../types/copilot.js';

// ---------------------------------------------------------------------------
// 2) Helpers.
// ---------------------------------------------------------------------------
const GOOD_LUID = '11111111-2222-3333-4444-555555555555';

function fail(label: string, msg: string): never {
  console.error(`[test] FAIL (${label}): ${msg}`);
  process.exit(1);
}

function assertEqual<T>(label: string, actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    fail(label, `${msg}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertTrue(label: string, cond: boolean, msg: string): void {
  if (!cond) fail(label, msg);
}

/** Stub assembler — returns a fixed CopilotContext with minimal schema. */
const stubAssembler = async (req: CopilotContextRequest): Promise<CopilotContext> => ({
  request: req,
  schema: {
    datasources: {
      [GOOD_LUID]: [
        {
          name: 'f1',
          caption: 'Field 1',
          dataType: 'STRING',
          description: '',
          upstreamLineage: [],
        },
      ],
    },
  },
  liveData: [],
  pulse: [],
  servicesFired: {
    metadata: { status: 'ok', datasources: 1 },
    vizql: { status: 'empty' },
    pulse: { status: 'empty' },
    assemblyMs: 42,
    contextChars: 100,
    truncated: false,
  },
});

/**
 * Build a minimal fake Anthropic client that yields a canned event stream
 * exercising the full happy path: plain text → anomaly tag → more text →
 * suggestions JSON → message_delta (usage + stop_reason) → message_stop.
 */
function makeFakeAnthropicClient(): {
  messages: {
    stream: (opts: unknown) => AsyncIterable<unknown> & { finalMessage?: () => Promise<unknown> };
  };
} {
  const events: Array<Record<string, unknown>> = [
    { type: 'content_block_delta', delta: { text: 'Hello. ' } },
    {
      type: 'content_block_delta',
      delta: { text: '[ANOMALY: fieldName="X" value="Y"]' },
    },
    {
      type: 'content_block_delta',
      delta: { text: ' Done.\n\n{"suggestions":["a","b","c"]}' },
    },
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 },
    },
    { type: 'message_stop' },
  ];
  return {
    messages: {
      stream: () => {
        const asyncIter = {
          async *[Symbol.asyncIterator]() {
            for (const e of events) yield e;
          },
        };
        return asyncIter as AsyncIterable<unknown> & {
          finalMessage?: () => Promise<unknown>;
        };
      },
    },
  };
}

/** Build a fresh Fastify app with injected route opts. */
async function buildApp(opts: {
  assembler?: (req: CopilotContextRequest) => Promise<CopilotContext>;
  claudeDeps?: { client?: ReturnType<typeof makeFakeAnthropicClient> };
}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(
    createChatRoutes({
      assembler: opts.assembler,
      claudeDeps: opts.claudeDeps,
    }),
  );
  await app.ready();
  return app;
}

/** Build a valid request body for the happy-path tests. */
function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    workbookName: 'WB',
    worksheetName: 'WS',
    datasourceLuids: [GOOD_LUID],
    selectedMarks: [],
    activeFilters: [],
    messages: [],
    question: 'Why?',
    ...overrides,
  };
}

/**
 * Parse an SSE body into an array of `{ eventType, dataRaw }` records. Uses
 * the SSE wire grammar — frames are separated by `\n\n`, each frame has one
 * `event:` line and one `data:` line (our route only emits single-line data).
 * Heartbeat `: ping` frames are filtered out.
 */
interface SseFrame {
  eventType: string;
  dataRaw: string;
}
function parseSseFrames(body: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const chunk of body.split('\n\n')) {
    if (!chunk.trim()) continue;
    if (chunk.startsWith(':')) continue; // heartbeat comment
    const lines = chunk.split('\n');
    let eventType = '';
    let dataRaw = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) eventType = line.slice('event: '.length);
      else if (line.startsWith('data: ')) dataRaw = line.slice('data: '.length);
    }
    if (eventType) frames.push({ eventType, dataRaw });
  }
  return frames;
}

// ---------------------------------------------------------------------------
// 3) Tests.
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  // ---------------- Validation (400) ----------------

  // Test 1 — 400 on missing workbookName
  {
    const label = 'Test 1: 400 on missing workbookName';
    const app = await buildApp({ assembler: stubAssembler, claudeDeps: { client: makeFakeAnthropicClient() } });
    const body = validBody();
    delete body.workbookName;
    const res = await app.inject({ method: 'POST', url: '/chat', payload: body });
    assertEqual(label, res.statusCode, 400, 'status');
    const j = res.json() as { error: string };
    assertEqual(label, j.error, 'BAD_REQUEST', 'error code');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 2 — 400 on invalid LUID
  {
    const label = 'Test 2: 400 on invalid LUID';
    const app = await buildApp({ assembler: stubAssembler, claudeDeps: { client: makeFakeAnthropicClient() } });
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: validBody({ datasourceLuids: ['not-a-uuid'] }),
    });
    assertEqual(label, res.statusCode, 400, 'status');
    const j = res.json() as { error: string; message: string };
    assertEqual(label, j.error, 'BAD_REQUEST', 'error code');
    assertTrue(label, j.message.includes('invalid datasource LUID'), 'message mentions LUID');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 3 — 400 on empty question
  {
    const label = 'Test 3: 400 on empty question';
    const app = await buildApp({ assembler: stubAssembler, claudeDeps: { client: makeFakeAnthropicClient() } });
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: validBody({ question: '' }),
    });
    assertEqual(label, res.statusCode, 400, 'status');
    const j = res.json() as { error: string; message: string };
    assertEqual(label, j.error, 'BAD_REQUEST', 'error code');
    assertTrue(label, j.message.includes('question'), 'message mentions question');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // Test 4 — 400 on empty datasourceLuids
  {
    const label = 'Test 4: 400 on empty datasourceLuids';
    const app = await buildApp({ assembler: stubAssembler, claudeDeps: { client: makeFakeAnthropicClient() } });
    const res = await app.inject({
      method: 'POST',
      url: '/chat',
      payload: validBody({ datasourceLuids: [] }),
    });
    assertEqual(label, res.statusCode, 400, 'status');
    const j = res.json() as { error: string; message: string };
    assertEqual(label, j.error, 'BAD_REQUEST', 'error code');
    assertTrue(label, j.message.includes('non-empty'), 'message mentions non-empty');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // ---------------- Env / assembler errors ----------------

  // Test 5 — 503 ENV_MISSING when ANTHROPIC_API_KEY is unset AND no stubbed client.
  // Deletes the key, resets env cache, runs the request, then restores + resets again.
  {
    const label = 'Test 5: 503 ENV_MISSING when key absent and no stubbed client';
    const savedKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    envModule.__resetEnvCacheForTests();
    try {
      const app = await buildApp({ assembler: stubAssembler /* NO claudeDeps */ });
      const res = await app.inject({ method: 'POST', url: '/chat', payload: validBody() });
      assertEqual(label, res.statusCode, 503, 'status');
      const j = res.json() as { error: string; key: string };
      assertEqual(label, j.error, 'ENV_MISSING', 'error code');
      assertEqual(label, j.key, 'ANTHROPIC_API_KEY', 'key field');
      await app.close();
    } finally {
      if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
      envModule.__resetEnvCacheForTests();
    }
    console.log(`[test] PASS: ${label}`);
  }

  // Test 6 — 502 SCHEMA_UNAVAILABLE when stubbed assembler throws.
  {
    const label = 'Test 6: 502 SCHEMA_UNAVAILABLE on assembler throw';
    const throwingAssembler = async (): Promise<CopilotContext> => {
      throw new ContextAssemblerError('all failed', [GOOD_LUID], new Error('root cause'));
    };
    const app = await buildApp({
      assembler: throwingAssembler,
      claudeDeps: { client: makeFakeAnthropicClient() },
    });
    const res = await app.inject({ method: 'POST', url: '/chat', payload: validBody() });
    assertEqual(label, res.statusCode, 502, 'status');
    const j = res.json() as { error: string; failedLuids: string[]; cause: string };
    assertEqual(label, j.error, 'SCHEMA_UNAVAILABLE', 'error code');
    assertEqual(label, j.failedLuids.length, 1, 'failedLuids length');
    assertEqual(label, j.failedLuids[0], GOOD_LUID, 'failedLuids content');
    assertEqual(label, j.cause, 'root cause', 'cause surfaced');
    await app.close();
    console.log(`[test] PASS: ${label}`);
  }

  // ---------------- Happy path SSE shape ----------------

  // Shared app for Tests 7-12 — builds one happy-path stream and reuses the body.
  let happyBody = '';
  let happyContentType = '';
  {
    const app = await buildApp({
      assembler: stubAssembler,
      claudeDeps: { client: makeFakeAnthropicClient() },
    });
    const res = await app.inject({ method: 'POST', url: '/chat', payload: validBody() });
    happyBody = res.body;
    happyContentType = res.headers['content-type'] as string;
    await app.close();
  }

  // Test 7 — Content-Type is text/event-stream
  {
    const label = 'Test 7: Content-Type is text/event-stream';
    assertTrue(
      label,
      happyContentType.includes('text/event-stream'),
      `content-type was: ${happyContentType}`,
    );
    console.log(`[test] PASS: ${label}`);
  }

  const frames = parseSseFrames(happyBody);

  // Test 8 — first frame is `event: context`
  {
    const label = 'Test 8: first frame is event: context';
    assertTrue(label, frames.length > 0, 'no frames parsed');
    assertEqual(label, frames[0]!.eventType, 'context', 'first frame type');
    const ctxPayload = JSON.parse(frames[0]!.dataRaw) as {
      servicesFired: unknown;
      assemblyMs: number;
      contextChars: number;
      truncated: boolean;
    };
    assertEqual(label, ctxPayload.assemblyMs, 42, 'assemblyMs');
    assertEqual(label, ctxPayload.contextChars, 100, 'contextChars');
    assertEqual(label, ctxPayload.truncated, false, 'truncated');
    assertTrue(label, ctxPayload.servicesFired !== undefined, 'servicesFired present');
    console.log(`[test] PASS: ${label}`);
  }

  // Test 9 — last frame before end is `event: done`
  {
    const label = 'Test 9: last frame before end is event: done';
    assertTrue(label, frames.length >= 2, 'not enough frames');
    assertEqual(label, frames[frames.length - 1]!.eventType, 'done', 'last frame type');
    const donePayload = JSON.parse(frames[frames.length - 1]!.dataRaw) as {
      stopReason: string;
      usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
      narrativeChars: number;
    };
    assertEqual(label, donePayload.stopReason, 'end_turn', 'stopReason');
    assertEqual(label, donePayload.usage.inputTokens, 10, 'inputTokens');
    assertEqual(label, donePayload.usage.outputTokens, 5, 'outputTokens');
    console.log(`[test] PASS: ${label}`);
  }

  // Test 10 — anomaly event appears in the frame stream
  {
    const label = 'Test 10: anomaly event present with parsed fieldName + value';
    const anomalyFrames = frames.filter((f) => f.eventType === 'anomaly');
    assertEqual(label, anomalyFrames.length, 1, 'anomaly frame count');
    const anomalyPayload = JSON.parse(anomalyFrames[0]!.dataRaw) as {
      fieldName: string;
      value: string;
      raw: string;
    };
    assertEqual(label, anomalyPayload.fieldName, 'X', 'fieldName');
    assertEqual(label, anomalyPayload.value, 'Y', 'value');
    assertTrue(label, anomalyPayload.raw.includes('[ANOMALY:'), 'raw preserved');
    console.log(`[test] PASS: ${label}`);
  }

  // Test 11 — `[ANOMALY` substring does NOT appear in any `event: token` data payload
  {
    const label = 'Test 11: [ANOMALY substring never in any token frame data';
    const tokenFrames = frames.filter((f) => f.eventType === 'token');
    assertTrue(label, tokenFrames.length > 0, 'expected at least one token frame');
    for (const f of tokenFrames) {
      const payload = JSON.parse(f.dataRaw) as { text: string };
      assertTrue(
        label,
        !payload.text.includes('[ANOMALY'),
        `token frame leaked anomaly tag: ${payload.text}`,
      );
    }
    console.log(`[test] PASS: ${label} (checked ${tokenFrames.length} frames)`);
  }

  // Test 12 — `{"suggestions"` substring does NOT appear in any `event: token` data payload
  {
    const label = 'Test 12: {"suggestions" substring never in any token frame data';
    const tokenFrames = frames.filter((f) => f.eventType === 'token');
    for (const f of tokenFrames) {
      const payload = JSON.parse(f.dataRaw) as { text: string };
      assertTrue(
        label,
        !payload.text.includes('{"suggestions"'),
        `token frame leaked suggestions JSON: ${payload.text}`,
      );
    }
    // Also assert a suggestions frame was emitted with the expected items.
    const suggFrames = frames.filter((f) => f.eventType === 'suggestions');
    assertEqual(label, suggFrames.length, 1, 'suggestions frame count');
    const sugg = JSON.parse(suggFrames[0]!.dataRaw) as { items: string[] };
    assertEqual(label, sugg.items.length, 3, 'suggestions items count');
    assertEqual(label, sugg.items[0], 'a', 'suggestions[0]');
    console.log(`[test] PASS: ${label}`);
  }

  console.log('[test] ALL PASS (12/12)');
  process.exit(0);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
