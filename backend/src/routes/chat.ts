/**
 * POST /chat — CTX-15. Streams a Claude response as SSE using native `event:`
 * framing per D-06, emits the D-07 event catalog, and writes a ': ping\n\n'
 * 15-second heartbeat per D-10.
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
 * Error contract:
 *   - 400 BAD_REQUEST on invalid body (before SSE open)
 *   - 503 ENV_MISSING when ANTHROPIC_API_KEY is absent AND no stubbed client
 *         was injected (lazy check at request time — never at boot)
 *   - 502 SCHEMA_UNAVAILABLE when the assembler throws ContextAssemblerError
 *         BEFORE the SSE stream opens (D-04)
 *   - once the stream is open, any error is piped as `event: error` followed
 *     by a synthetic `event: done` (terminal event invariant)
 *
 * Factory pattern (Warning 7 fix): `createChatRoutes(opts)` accepts a
 * ChatRouteOpts with optional `claudeDeps` (stubs the Anthropic SDK) AND
 * `assembler` (stubs assembleContext) so offline tests can run fully
 * hermetic. Both fields default to the real implementations. The default
 * export `chatRoutes` is `createChatRoutes()` — that is what server.ts
 * registers in Plan 03-08.
 *
 * SSE framing responsibilities (threat T-03-06-07): every `write(type, data)`
 * JSON.stringifies the data payload and hard-codes the `event:` type name
 * from the D-07 catalog — no user input is concatenated into the event name.
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

/** Tableau LUIDs are UUID-shaped. Case-insensitive. Matches context.ts. */
const LUID_REGEX = /^[a-f0-9-]{36}$/i;

/** D-10: SSE heartbeat cadence. 15s is well under typical 60s proxy idle timeouts. */
const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Options for `createChatRoutes`. Both fields are optional; defaults use the
 * real `assembleContext` + real Anthropic SDK. Tests override one or both to
 * run fully offline.
 */
export interface ChatRouteOpts {
  claudeDeps?: ClaudeDeps;
  assembler?: (req: CopilotContextRequest) => Promise<CopilotContext>;
}

interface ChatBody extends CopilotContextRequest {
  readonly messages: readonly ChatMessage[];
  readonly question: string;
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
    if (mo.role !== 'user' && mo.role !== 'assistant') {
      return { error: 'message.role must be user|assistant' };
    }
    if (typeof mo.content !== 'string') return { error: 'message.content must be a string' };
  }
  if (typeof b.question !== 'string' || b.question.length === 0) {
    return { error: 'question must be a non-empty string' };
  }
  return {
    workbookName: b.workbookName,
    worksheetName: b.worksheetName,
    datasourceLuids: b.datasourceLuids as string[],
    selectedMarks: b.selectedMarks as CopilotContextRequest['selectedMarks'],
    activeFilters: b.activeFilters as CopilotContextRequest['activeFilters'],
    messages: b.messages as readonly ChatMessage[],
    question: b.question,
  };
}

/**
 * Build a chat route plugin. Call with no args to get the real route used by
 * server.ts in Plan 03-08; call with stubs to run hermetic offline tests.
 */
export function createChatRoutes(opts: ChatRouteOpts = {}): FastifyPluginAsync {
  const doAssemble = opts.assembler ?? assembleContext;

  return async (app: FastifyInstance) => {
    app.post('/chat', async (req, reply) => {
      const validated = validateChatBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      // Lazy env check — never at boot. If the operator runs the backend
      // without an Anthropic key, /health still works and /chat returns 503
      // with a machine-readable shape the Phase 4 panel can render.
      const env = loadEnv();
      if (!env.anthropicApiKey && !opts.claudeDeps?.client) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'ANTHROPIC_API_KEY' });
      }

      // Assemble context first — the assembler throws ContextAssemblerError
      // on 100%-schema-failure (D-04), which we map to a proper HTTP 502
      // BEFORE opening the SSE stream so clients get a normal HTTP error
      // response (not a half-open EventSource).
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

      // ---- SSE stream open -------------------------------------------------
      // Headers per D-06. `X-Accel-Buffering: no` disables nginx/Fly buffering
      // so tokens flush to the client as they arrive, not at chunk boundaries.
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache, no-transform');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('X-Accel-Buffering', 'no');
      // Tell Fastify we own the reply lifecycle from here on — without this,
      // Fastify's default response serializer will try to send a body after
      // the handler returns and the client will see a dangling connection.
      reply.hijack();

      const write = (type: string, data: unknown): void => {
        reply.raw.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const writePing = (): void => {
        reply.raw.write(`: ping\n\n`);
      };

      // D-07: first event is always `context` — gives the UI the servicesFired
      // observability snapshot so it can render ContextBadge before the first
      // token arrives.
      write('context', {
        servicesFired: context.servicesFired,
        assemblyMs: context.servicesFired.assemblyMs,
        contextChars: context.servicesFired.contextChars,
        truncated: context.servicesFired.truncated,
      });

      // D-10: heartbeat every 15s. Cleared in `finally` below.
      const heartbeat = setInterval(writePing, HEARTBEAT_INTERVAL_MS);

      const dashboardState: DashboardState = {
        workbookName: validated.workbookName,
        worksheetName: validated.worksheetName,
        selectedMarks: validated.selectedMarks,
        activeFilters: validated.activeFilters,
      };

      try {
        // streamChat yields StreamParserEvents (token | anomaly | suggestions |
        // done | error) — forward every one verbatim. The parser never emits
        // `context`, so there is no collision with the first frame above.
        for await (const ev of streamChat(
          context,
          validated.messages,
          dashboardState,
          validated.question,
          opts.claudeDeps,
        )) {
          write(ev.type, ev.data);
        }
      } catch (err) {
        // streamChat's contract is that it never throws — it yields an
        // `error` followed by `done`. This catch is a defense-in-depth net
        // in case a future refactor breaks that contract.
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
