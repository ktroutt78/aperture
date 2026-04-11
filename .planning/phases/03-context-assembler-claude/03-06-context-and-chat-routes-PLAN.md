---
phase: 03-context-assembler-claude
plan: 06
type: execute
wave: 3
depends_on: [03-01, 03-04, 03-05]
files_modified:
  - backend/src/routes/context.ts
  - backend/src/routes/chat.ts
  - backend/src/services/__tests__/chatRoute.test.ts
  - backend/package.json
autonomous: true
requirements: [CTX-14, CTX-15]
tags: [phase-3, routes, sse, wave-3]

must_haves:
  truths:
    - "POST /context exists and returns a CopilotContext JSON body produced by assembleContext"
    - "POST /chat exists and returns an SSE stream (Content-Type: text/event-stream) with native event: framing per D-06"
    - "The first SSE event is always 'context' with { servicesFired, assemblyMs, contextChars, truncated } per D-07"
    - "Subsequent events follow D-07 catalog: token | anomaly | suggestions | done (+ error on failure)"
    - "The SSE response writes ': ping\\n\\n' every 15s per D-10"
    - "Request body validation rejects invalid datasourceLuids (non-UUID strings, empty arrays for /chat) with 400"
    - "All-schemas-fail from assembleContext is mapped to HTTP 502 { error: 'SCHEMA_UNAVAILABLE', failedLuids, cause } per D-04"
    - "Missing ANTHROPIC_API_KEY at request time returns 503 { error: 'ENV_MISSING', key: 'ANTHROPIC_API_KEY' } on /chat (lazy check, never at boot)"
    - "chatRoutes is exported as BOTH a default plugin (`export const chatRoutes = createChatRoutes()`) AND a factory (`createChatRoutes(opts)`) that accepts an optional ChatRouteOpts with injectable claudeDeps AND assembler for offline tests"
    - "Routes register via app.register(contextRoutes) and app.register(chatRoutes) — Phase 1/2 pattern"
  artifacts:
    - path: "backend/src/routes/context.ts"
      provides: "contextRoutes(app) — POST /context handler"
      contains: "contextRoutes"
    - path: "backend/src/routes/chat.ts"
      provides: "createChatRoutes(opts) factory + chatRoutes default export — POST /chat SSE handler with D-06 framing + D-10 heartbeat, accepts optional ChatRouteOpts { claudeDeps, assembler } for offline tests"
      contains: "chatRoutes"
    - path: "backend/src/services/__tests__/chatRoute.test.ts"
      provides: "Offline tests using Fastify's inject() + a stubbed Anthropic client + a stubbed assembler"
      contains: "chatRoutes"
  key_links:
    - from: "backend/src/routes/chat.ts"
      to: "backend/src/services/contextAssembler.ts"
      via: "import { assembleContext }"
      pattern: "assembleContext"
    - from: "backend/src/routes/chat.ts"
      to: "backend/src/services/claudeService.ts"
      via: "import { streamChat }"
      pattern: "streamChat"
    - from: "backend/src/routes/context.ts"
      to: "backend/src/services/contextAssembler.ts"
      via: "import { assembleContext }"
      pattern: "assembleContext"
---

<objective>
Expose the Phase 3 HTTP surface for context assembly and streaming chat: `POST /context` (debug JSON endpoint) and `POST /chat` (native-SSE endpoint). Both are thin wrappers over Wave 2 primitives (contextAssembler + claudeService). This plan owns the SSE wire contract implementation (D-06 native `event:` framing, D-07 event catalog, D-10 heartbeat).

Purpose: The wire contract is load-bearing for Phase 4's EventSource consumer. A single drift in event names, payload shapes, or heartbeat cadence breaks the extension. The test file uses Fastify's built-in `inject()` harness (no network) so the route can be verified offline with a stubbed Anthropic client AND a stubbed assembler.

**Route factory pattern (Warning 7 fix):** `chat.ts` exports BOTH a default plugin (`chatRoutes`) used by `server.ts` AND a factory (`createChatRoutes(opts)`) consumed by the offline test. The factory accepts `ChatRouteOpts = { claudeDeps?, assembler? }` — `claudeDeps` stubs the Anthropic SDK via Plan 03-05's existing ClaudeDeps shape; `assembler` stubs `assembleContext` so tests don't need real Tableau services. Both fields are optional and default to the real implementations.

Output: Two route modules, one offline test with `inject()`, one npm script. Routes are NOT registered in server.ts yet — that happens in Plan 03-08.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/routes/health.ts
@backend/src/types/copilot.ts
@backend/src/services/contextAssembler.ts
@backend/src/services/claudeService.ts
@backend/src/services/errors.ts

<interfaces>
Fastify route registration pattern (from backend/src/routes/health.ts):
```typescript
import type { FastifyInstance } from 'fastify';
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => { ... });
}
```

Fastify raw reply access for SSE (Node.js `http.ServerResponse`):
```typescript
app.post('/chat', async (req, reply) => {
  reply.raw.setHeader('Content-Type', 'text/event-stream');
  reply.raw.setHeader('Cache-Control', 'no-cache');
  reply.raw.setHeader('Connection', 'keep-alive');
  reply.raw.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  reply.hijack(); // tell Fastify we own the response lifecycle
  // Now write raw SSE frames:
  reply.raw.write('event: context\ndata: ' + JSON.stringify(ctx) + '\n\n');
  // ...
  reply.raw.end();
});
```

Fastify inject() for offline route testing:
```typescript
const app = Fastify();
await app.register(createChatRoutes({ assembler: stubAssembler, claudeDeps: { client: fakeClient } }));
const res = await app.inject({ method: 'POST', url: '/chat', payload: {...} });
// res.body is the full SSE response body
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Implement POST /context route (debug JSON endpoint, CTX-14)</name>
  <files>backend/src/routes/context.ts</files>
  <read_first>
    - backend/src/routes/health.ts (Fastify route registration pattern — copy it verbatim)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-04 all-schemas-fail → 502 SCHEMA_UNAVAILABLE; D-05 ServicesFired shape)
    - backend/src/types/copilot.ts (CopilotContextRequest shape)
    - backend/src/services/contextAssembler.ts (assembleContext signature — from Plan 03-04)
    - backend/src/services/errors.ts (ContextAssemblerError — from Plan 03-01)
  </read_first>
  <action>
Create `backend/src/routes/context.ts`:

```typescript
/**
 * POST /context — CTX-14 debug endpoint.
 *
 * Returns the assembled CopilotContext as JSON. Primary use: Phase 4
 * development + judging-mode debugging. Phase 4 does NOT hit this in
 * production — it uses /chat directly.
 *
 * Request body: CopilotContextRequest (see backend/src/types/copilot.ts).
 * Response: CopilotContext JSON, OR 400 on validation, OR 502 on all-schemas-fail.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { assembleContext } from '../services/contextAssembler.js';
import { ContextAssemblerError } from '../services/errors.js';
import type { CopilotContextRequest } from '../types/copilot.js';

const LUID_REGEX = /^[a-f0-9-]{36}$/i;

function validateRequest(body: unknown): CopilotContextRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.workbookName !== 'string') return { error: 'workbookName must be a string' };
  if (typeof b.worksheetName !== 'string') return { error: 'worksheetName must be a string' };
  if (!Array.isArray(b.datasourceLuids)) return { error: 'datasourceLuids must be an array' };
  for (const luid of b.datasourceLuids) {
    if (typeof luid !== 'string' || !LUID_REGEX.test(luid)) {
      return { error: `invalid datasource LUID: ${String(luid)}` };
    }
  }
  if (!Array.isArray(b.selectedMarks)) return { error: 'selectedMarks must be an array' };
  if (!Array.isArray(b.activeFilters)) return { error: 'activeFilters must be an array' };
  return {
    workbookName: b.workbookName,
    worksheetName: b.worksheetName,
    datasourceLuids: b.datasourceLuids as string[],
    selectedMarks: b.selectedMarks as CopilotContextRequest['selectedMarks'],
    activeFilters: b.activeFilters as CopilotContextRequest['activeFilters'],
  };
}

export const contextRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/context', async (req, reply) => {
    const validated = validateRequest(req.body);
    if ('error' in validated) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
    }
    try {
      const context = await assembleContext(validated);
      return reply.send(context);
    } catch (err) {
      if (err instanceof ContextAssemblerError) {
        // D-04: all-schemas-fail → 502 SCHEMA_UNAVAILABLE.
        return reply.code(502).send({
          error: 'SCHEMA_UNAVAILABLE',
          failedLuids: err.failedLuids,
          cause: (err.cause as Error | undefined)?.message ?? err.message,
        });
      }
      app.log.error({ err }, 'context assembler unexpected error');
      return reply.code(500).send({ error: 'INTERNAL', message: 'unexpected error' });
    }
  });
};
```

Do NOT register this in server.ts — Plan 03-08 owns server.ts edits.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/routes/context.ts`
    - `grep -q "export const contextRoutes" backend/src/routes/context.ts`
    - `grep -q "app.post('/context'" backend/src/routes/context.ts`
    - `grep -q "LUID_REGEX = /\^\[a-f0-9-\]{36}\$/i" backend/src/routes/context.ts`
    - `grep -q "SCHEMA_UNAVAILABLE" backend/src/routes/context.ts`
    - `grep -q "reply.code(502)" backend/src/routes/context.ts`
    - `grep -q "reply.code(400)" backend/src/routes/context.ts`
    - `grep -q "ContextAssemblerError" backend/src/routes/context.ts`
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>/context route validates input, calls assembleContext, maps ContextAssemblerError → 502, returns CopilotContext JSON on success.</done>
</task>

<task type="auto">
  <name>Task 2: Implement POST /chat SSE route (factory pattern with ChatRouteOpts.assembler + claudeDeps) + offline inject() test</name>
  <files>backend/src/routes/chat.ts, backend/src/services/__tests__/chatRoute.test.ts, backend/package.json</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-06 native SSE; D-07 event catalog and payload shapes; D-10 heartbeat 15s; D-04 502 mapping)
    - backend/src/routes/context.ts (from Task 1 — copy the validateRequest pattern and LUID regex)
    - backend/src/services/claudeService.ts (from Plan 03-05 — streamChat signature + ClaudeDeps for injecting a stubbed client)
    - backend/src/services/contextAssembler.ts (from Plan 03-04 — assembleContext signature; note the two-stage fan-out — tests mock at the assembler boundary, NOT at individual Tableau services)
    - backend/src/types/copilot.ts (ChatMessage, DashboardState shapes, CopilotContext)
    - backend/src/services/streamParser.ts (from Plan 03-02 — StreamParserEvent union includes all variants including error)
  </read_first>
  <action>
Create `backend/src/routes/chat.ts`. **Note the factory pattern (Warning 7 fix):** `ChatRouteOpts` accepts BOTH `claudeDeps` (for stubbing the Anthropic SDK) AND `assembler` (for stubbing `assembleContext`). Both fields are optional and default to the real implementations. The default export `chatRoutes` is produced by calling `createChatRoutes()` with no args — that is what `server.ts` registers in Plan 03-08.

```typescript
/**
 * POST /chat — CTX-15. Streams a Claude response as SSE using native event:
 * framing per D-06, emits the D-07 event catalog, and writes a ': ping' 15s
 * heartbeat per D-10.
 *
 * Request body:
 *   {
 *     workbookName, worksheetName, datasourceLuids[],
 *     selectedMarks[], activeFilters[],
 *     messages: ChatMessage[],    // client-held conversation (D-12)
 *     question: string            // current user turn, wrapped by buildUserTurn
 *   }
 *
 * Response: text/event-stream, frames per D-07:
 *   event: context     { servicesFired, assemblyMs, contextChars, truncated }
 *   event: token       { text }
 *   event: anomaly     { fieldName, value, raw }
 *   event: suggestions { items }
 *   event: done        { stopReason, usage, narrativeChars }
 *   event: error       { code, message }  (unrecoverable only)
 *   : ping             heartbeat every 15s
 *
 * Factory pattern: `createChatRoutes(opts)` accepts ChatRouteOpts with
 * optional claudeDeps AND assembler for offline tests. The default export
 * `chatRoutes` is `createChatRoutes()` — used by server.ts in Plan 03-08.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { assembleContext } from '../services/contextAssembler.js';
import { streamChat, type ClaudeDeps } from '../services/claudeService.js';
import { ContextAssemblerError } from '../services/errors.js';
import { loadEnv } from '../config/env.js';
import type {
  CopilotContext,
  CopilotContextRequest,
  ChatMessage,
  DashboardState,
  ErrorCode,
} from '../types/copilot.js';

const LUID_REGEX = /^[a-f0-9-]{36}$/i;
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Options for `createChatRoutes`. Both fields optional; defaults use the real
 * assembleContext + real Anthropic SDK. Tests override one or both to run
 * fully offline.
 */
export interface ChatRouteOpts {
  claudeDeps?: ClaudeDeps;
  assembler?: (req: CopilotContextRequest) => Promise<CopilotContext>;
}

interface ChatBody extends CopilotContextRequest {
  messages: readonly ChatMessage[];
  question: string;
}

function validateChatBody(body: unknown): ChatBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.workbookName !== 'string') return { error: 'workbookName must be a string' };
  if (typeof b.worksheetName !== 'string') return { error: 'worksheetName must be a string' };
  if (!Array.isArray(b.datasourceLuids) || b.datasourceLuids.length === 0) {
    return { error: 'datasourceLuids must be a non-empty array' };
  }
  for (const luid of b.datasourceLuids) {
    if (typeof luid !== 'string' || !LUID_REGEX.test(luid)) {
      return { error: `invalid datasource LUID: ${String(luid)}` };
    }
  }
  if (!Array.isArray(b.selectedMarks)) return { error: 'selectedMarks must be an array' };
  if (!Array.isArray(b.activeFilters)) return { error: 'activeFilters must be an array' };
  if (!Array.isArray(b.messages)) return { error: 'messages must be an array' };
  for (const m of b.messages) {
    if (!m || typeof m !== 'object') return { error: 'messages elements must be objects' };
    const mo = m as Record<string, unknown>;
    if (mo.role !== 'user' && mo.role !== 'assistant') return { error: 'message.role must be user|assistant' };
    if (typeof mo.content !== 'string') return { error: 'message.content must be a string' };
  }
  if (typeof b.question !== 'string' || b.question.length === 0) {
    return { error: 'question must be a non-empty string' };
  }
  return b as unknown as ChatBody;
}

export function createChatRoutes(opts: ChatRouteOpts = {}): FastifyPluginAsync {
  const doAssemble = opts.assembler ?? assembleContext;

  return async (app: FastifyInstance) => {
    app.post('/chat', async (req, reply) => {
      const validated = validateChatBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      // Lazy env check (never at boot).
      const env = loadEnv();
      if (!env.anthropicApiKey && !opts.claudeDeps?.client) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'ANTHROPIC_API_KEY' });
      }

      // Assemble context first — assembler throws ContextAssemblerError on
      // all-schemas-fail (D-04), which we map to 502 BEFORE opening the SSE
      // stream so clients get a proper HTTP error response.
      let context: CopilotContext;
      try {
        context = await doAssemble({
          workbookName: validated.workbookName,
          worksheetName: validated.worksheetName,
          datasourceLuids: validated.datasourceLuids,
          selectedMarks: validated.selectedMarks,
          activeFilters: validated.activeFilters,
        });
      } catch (err) {
        if (err instanceof ContextAssemblerError) {
          return reply.code(502).send({
            error: 'SCHEMA_UNAVAILABLE',
            failedLuids: err.failedLuids,
            cause: (err.cause as Error | undefined)?.message ?? err.message,
          });
        }
        throw err;
      }

      // Open SSE stream.
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      reply.hijack();

      const write = (type: string, data: unknown): void => {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const writePing = (): void => {
        reply.raw.write(`: ping\n\n`);
      };

      // D-07: first event is `context`.
      write('context', {
        servicesFired: context.servicesFired,
        assemblyMs: context.servicesFired.assemblyMs,
        contextChars: context.servicesFired.contextChars,
        truncated: context.servicesFired.truncated,
      });

      // D-10: heartbeat every 15s.
      const heartbeat = setInterval(writePing, HEARTBEAT_INTERVAL_MS);

      const dashboardState: DashboardState = {
        workbookName: validated.workbookName,
        worksheetName: validated.worksheetName,
        selectedMarks: validated.selectedMarks,
        activeFilters: validated.activeFilters,
      };

      try {
        for await (const ev of streamChat(context, validated.messages, dashboardState, validated.question, opts.claudeDeps)) {
          // Pipe StreamParserEvent → SSE frame. The parser never emits 'context'
          // (that's the route's job) so we forward every other type verbatim.
          // StreamParserEvent is the full union (token|anomaly|suggestions|done|error)
          // from Plan 03-02 — no type gymnastics required.
          write(ev.type, ev.data);
        }
      } catch (err) {
        const message = (err as Error)?.message ?? 'unknown';
        write('error', { code: 'INTERNAL' satisfies ErrorCode, message });
      } finally {
        clearInterval(heartbeat);
        reply.raw.end();
      }
    });
  };
}

/** Default export with no stubbed deps — used by server.ts in Plan 03-08. */
export const chatRoutes: FastifyPluginAsync = createChatRoutes();
```

**Test file** — `backend/src/services/__tests__/chatRoute.test.ts`:

Use Fastify's `inject()` for offline route testing. The test file stubs BOTH the assembler (via `opts.assembler`) AND the Anthropic SDK (via `opts.claudeDeps.client`):

```typescript
import Fastify from 'fastify';
import { createChatRoutes } from '../../routes/chat.js';
import assert from 'node:assert/strict';
import type { CopilotContext, CopilotContextRequest } from '../../types/copilot.js';

async function main(): Promise<void> {
  // Fake Anthropic client that emits a short canned stream.
  const fakeClient = {
    messages: {
      stream: () => {
        const events = [
          { type: 'content_block_delta', delta: { text: 'Hello. ' } },
          { type: 'content_block_delta', delta: { text: '[ANOMALY: fieldName="X" value="Y"]' } },
          { type: 'content_block_delta', delta: { text: ' Done.\n\n{"suggestions":["a","b","c"]}' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 } },
        ];
        return {
          async *[Symbol.asyncIterator]() { for (const e of events) yield e; },
        };
      },
    },
  };

  // Stub assembler — returns a fixed CopilotContext with minimal schema.
  const stubAssembler = async (req: CopilotContextRequest): Promise<CopilotContext> => ({
    request: req,
    schema: { datasources: { '11111111-2222-3333-4444-555555555555': [{ name: 'f1', caption: 'Field 1', dataType: 'STRING', description: '', upstreamLineage: [] }] } },
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

  // ... test cases:
  // Test 1: 400 on missing workbookName
  // Test 2: 400 on invalid LUID
  // Test 3: 400 on empty question
  // Test 4: 400 on empty datasourceLuids
  // Test 5: 503 ENV_MISSING when env.anthropicApiKey is unset and no claudeDeps
  // Test 6: 502 SCHEMA_UNAVAILABLE when stubbed assembler throws ContextAssemblerError
  // Test 7: Happy path — Content-Type is text/event-stream
  // Test 8: Happy path — first frame is 'event: context\n'
  // Test 9: Happy path — last frame before end is 'event: done\n'
  // Test 10: Happy path — anomaly event appears in the frame stream
  // Test 11: Happy path — '[ANOMALY' substring does NOT appear in any 'event: token' frame's data payload
  //          (INFO 10 refinement: parse SSE frames by splitting on '\n\n', filter to frames with 'event: token', then check the data: line for substring. Robust to frame boundary splits.)
  // Test 12: Happy path — '{"suggestions"' substring does NOT appear in any 'event: token' frame's data payload (same SSE-frame-parsed approach)

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Add npm script: `"smoke:chatroute": "tsx src/services/__tests__/chatRoute.test.ts"` after `smoke:claude`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:chatroute</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/routes/chat.ts`
    - File exists: `test -f backend/src/services/__tests__/chatRoute.test.ts`
    - `grep -q "app.post('/chat'" backend/src/routes/chat.ts`
    - `grep -q "text/event-stream" backend/src/routes/chat.ts`
    - `grep -q "event: \\\${type}" backend/src/routes/chat.ts`
    - `grep -q "HEARTBEAT_INTERVAL_MS = 15_000" backend/src/routes/chat.ts`
    - `grep -q ": ping" backend/src/routes/chat.ts`
    - `grep -q "reply.hijack" backend/src/routes/chat.ts`
    - `grep -q "reply.code(503)" backend/src/routes/chat.ts`
    - `grep -q "reply.code(502)" backend/src/routes/chat.ts`
    - `grep -q "ENV_MISSING" backend/src/routes/chat.ts`
    - `grep -q "SCHEMA_UNAVAILABLE" backend/src/routes/chat.ts`
    - `grep -q "LUID_REGEX = /\^\[a-f0-9-\]{36}\$/i" backend/src/routes/chat.ts`
    - `grep -q "write('context'" backend/src/routes/chat.ts`
    - `grep -q "streamChat" backend/src/routes/chat.ts`
    - `grep -q "clearInterval(heartbeat)" backend/src/routes/chat.ts`
    - **Warning 7 fix**: `grep -q "assembler?:" backend/src/routes/chat.ts` (ChatRouteOpts declares the assembler field)
    - **Warning 7 fix**: `grep -q "export const chatRoutes" backend/src/routes/chat.ts` (default export still exists)
    - **Warning 7 fix**: `grep -q "export function createChatRoutes" backend/src/routes/chat.ts` (factory is exported)
    - `grep -q "smoke:chatroute" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:chatroute` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test file has at least 12 test cases: `grep -c "Test [0-9]" backend/src/services/__tests__/chatRoute.test.ts` returns at least 12
  </acceptance_criteria>
  <done>/chat route assembles context via injectable factory, opens SSE stream with D-06 framing, emits first `context` event, pipes streamChat events over the full StreamParserEvent union (no casts), writes 15s heartbeat, closes cleanly on done/error. All offline inject() tests pass using stubbed assembler + stubbed Anthropic SDK.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Client POST body → /context, /chat | Untrusted input crosses HTTP. Every field validated before reaching services. |
| SSE response → proxy/Fly.io | Heartbeat prevents idle timeouts. Raw SSE frames are plain text; no binary injection surface. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-06-01 | SSRF | `datasourceLuids` in request body | mitigate | `LUID_REGEX = /^[a-f0-9-]{36}$/i` validation in BOTH route handlers before any service call. Non-matching LUIDs → 400 BAD_REQUEST. |
| T-03-06-02 | Injection | `question` field | mitigate | Wrapped by `buildUserTurn` in XML semantic boundaries in Plan 03-05 (D-15). Route passes through as plain string; no shell interpolation, no SQL, no template rendering. |
| T-03-06-03 | Information Disclosure | SSE error payloads | mitigate | Route never sends the raw Error object to the client — only `{ code, message }`. Stack traces stay server-side in pino logs. |
| T-03-06-04 | DoS | Anthropic-bill amplification via open /chat | mitigate | Partial: assemble-before-stream means a 400/502 returns BEFORE opening the Anthropic stream. Full mitigation lands in Plan 03-08 (D-22 rate limit 60/min/IP). |
| T-03-06-05 | DoS | Proxy idle timeout killing slow streams | mitigate | D-10 `: ping\n\n` heartbeat every 15s. `HEARTBEAT_INTERVAL_MS` is a constant, asserted by grep. |
| T-03-06-06 | Information Disclosure | env key check timing | accept | The 503 ENV_MISSING response discloses that the key is absent. This is a server-side configuration flag, not a user secret — disclosure is intentional so the operator sees the problem. |
| T-03-06-07 | Tampering | SSE frame injection via user content | mitigate | All `write(type, data)` calls JSON.stringify the data payload. No user input is concatenated into the `event:` type name — types are hard-coded constants from the D-07 catalog. |

No HIGH threats remain open after Plan 03-08 adds rate limiting.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:chatroute` exits 0 (offline, stubbed Anthropic + stubbed assembler)
- `pnpm --filter @aperture/backend typecheck` exits 0
- Routes are NOT registered in server.ts yet (Plan 03-08 owns that)
- `grep -q "await app.register(contextRoutes)" backend/src/server.ts` returns NO matches yet
</verification>

<success_criteria>
- /context returns assembled CopilotContext JSON
- /chat returns SSE stream with native `event:` framing
- First frame is always `event: context` with D-05 servicesFired payload
- Anomaly tags from Claude are parsed and emitted as `event: anomaly` frames
- `[ANOMALY` substring never appears in `event: token` data payloads (verified by parsing SSE frames, not substring-scanning the raw wire)
- `{"suggestions"` substring never appears in `event: token` data payloads
- 15s heartbeat is wired via setInterval
- All-schemas-fail → 502 SCHEMA_UNAVAILABLE (from D-04)
- Missing API key → 503 ENV_MISSING (lazy, not at boot)
- `ChatRouteOpts` includes both `claudeDeps?` and `assembler?` fields (Warning 7 fix)
- `createChatRoutes(opts)` factory and `chatRoutes` default export both exist (Warning 7 fix)
- Offline inject() tests cover all validation paths + happy path + error path using stubbed assembler + stubbed Anthropic SDK
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-06-SUMMARY.md`
</output>
