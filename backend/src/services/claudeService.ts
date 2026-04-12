/**
 * Claude streaming service (CTX-10..13, CTX-18 forward-compat).
 *
 * Single responsibility: call anthropic.messages.stream with the assembled
 * system prompt + capped history + wrapped user turn, pipe text deltas into
 * a StreamParser, and yield typed events to the caller.
 *
 * Do NOT route through Fastify reply streams here — this module returns an
 * async iterable and the route in Plan 03-06 handles SSE framing.
 *
 * Type note: StreamParserEvent (exported from ./streamParser.js) already
 * includes the `error` variant per Plan 03-02. This module yields error
 * events as plain union members — zero type assertions on the yielded event.
 *
 * Decisions honored here:
 *   D-11  anthropic.messages.stream is the chosen SDK entry point.
 *   D-12  Stateless messages[] — history is client-held and passed in fresh.
 *   D-13  System prompt is rebuilt from context every turn (cache handles dedup).
 *   D-14  Schema block carries the single ephemeral cache_control marker.
 *   D-15  Final user turn wraps dashboard state + question via buildUserTurn.
 *   D-18  10-turn sliding window on prior messages (silent drop of oldest).
 *   D-07  SSE error events carry a stable ErrorCode union value.
 *
 * INFO 11 (checker note): Anthropic SDK v0.40+ delivers final usage via
 * `message_delta`, not `message_stop`. This module listens to BOTH events and
 * the last observed usage wins, so the downstream UI never sees 0/0/0 on a
 * well-formed stream. If live UAT in Plan 03-08 Task 3 observes 0/0/0 tokens,
 * narrow the handler to `message_delta` only.
 */
import Anthropic from '@anthropic-ai/sdk';

import { StreamParser, type StreamParserEvent } from './streamParser.js';
import { buildSystemPrompt, buildUserTurn } from './systemPromptBuilder.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type {
  CopilotContext,
  ChatMessage,
  DashboardState,
  ErrorCode,
} from '../types/copilot.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'claudeService',
});

/** D-18: 10-turn sliding window on history. */
export const MAX_HISTORY_TURNS = 10;

/** CLAUDE.md invariant — this literal is the ONLY model string in the source. */
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514' as const;

/**
 * Dependency-injection seam so offline tests can pass a fake Anthropic client
 * without touching process.env or installing nock-style interceptors. The opts
 * parameter type is intentionally `unknown` so this seam does not leak the
 * real SDK generics into test fixtures.
 */
export interface ClaudeDeps {
  client?: {
    messages: {
      stream: (opts: unknown) => AsyncIterable<unknown> & {
        finalMessage?: () => Promise<unknown>;
      };
    };
  };
}

/** Usage passthrough shape carried on the `done` event. */
interface UsageCounters {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

/**
 * Stream a Claude chat turn as an async iterable of typed StreamParserEvents.
 * Call sites (Plan 03-06 /chat SSE route) use `for await (const ev of streamChat(...))`
 * and map each event type to an `event: ...\ndata: ...\n\n` SSE frame.
 *
 * Error semantics: Anthropic SDK errors are caught, classified via
 * classifyAnthropicError, and yielded as `error` events followed by a `done`
 * event so the SSE route can cleanly close the stream. The async generator
 * never throws to the caller — one yielded `error` is the contract.
 */
export async function* streamChat(
  context: CopilotContext,
  messages: readonly ChatMessage[],
  dashboardState: DashboardState,
  question: string,
  deps: ClaudeDeps = {},
): AsyncGenerator<StreamParserEvent, void, undefined> {
  // Lazy env read — no process.exit at boot if the key is absent. This keeps
  // every other offline smoke test runnable without ANTHROPIC_API_KEY set.
  const env = loadEnv();
  if (!env.anthropicApiKey && !deps.client) {
    // The error variant is part of StreamParserEvent's union (Plan 03-02) —
    // no cast needed. Do NOT throw; the SSE route treats a yielded error +
    // done as a normal stream close.
    yield {
      type: 'error',
      data: {
        code: 'INTERNAL' satisfies ErrorCode,
        message: 'ANTHROPIC_API_KEY not set — cannot start Claude stream',
      },
    };
    yield {
      type: 'done',
      data: {
        stopReason: 'error',
        narrativeChars: 0,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
      },
    };
    return;
  }

  const client =
    deps.client ??
    (new Anthropic({ apiKey: env.anthropicApiKey }) as unknown as NonNullable<
      ClaudeDeps['client']
    >);

  // D-13/D-14: rebuild system prompt from context every turn. Anthropic's
  // prompt cache server-side dedupes the Role + Contract + Schema prefix.
  const system = buildSystemPrompt(context);

  // D-18: sliding window — keep the last N messages, silently drop older.
  const capped = messages.slice(Math.max(0, messages.length - MAX_HISTORY_TURNS));

  // D-15: wrap the final user turn with dashboard-state preamble.
  const userTurnContent = buildUserTurn(dashboardState, question);
  const finalMessages = [
    ...capped.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userTurnContent },
  ];

  // Parser events are queued synchronously during each SDK event iteration
  // and drained to the caller after each one so the consumer sees deltas as
  // they arrive instead of all at once at stream-end.
  const queue: StreamParserEvent[] = [];
  const parser = new StreamParser((ev) => queue.push(ev));

  let stopReason = 'end_turn';
  const usage: UsageCounters = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  try {
    const stream = client.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
      messages: finalMessages,
    });

    // Anthropic SDK v0.40+ emits events via async iterator. We only care
    // about content_block_delta (text), message_delta (stop_reason + usage),
    // and message_stop (fallback usage). The loose `unknown` cast below keeps
    // this code decoupled from the SDK's changing generic shapes.
    for await (const rawEvent of stream as AsyncIterable<{
      type?: string;
      delta?: { text?: string; stop_reason?: string };
      message?: { stop_reason?: string; usage?: Record<string, number> };
      usage?: Record<string, number>;
    }>) {
      const event = rawEvent;
      if (event.type === 'content_block_delta' && event.delta?.text) {
        parser.feed(event.delta.text);
      } else if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage) {
          // INFO 11: usage lives on message_delta in SDK v0.40+. Last-wins.
          if (typeof event.usage.input_tokens === 'number') {
            usage.inputTokens = event.usage.input_tokens;
          }
          if (typeof event.usage.output_tokens === 'number') {
            usage.outputTokens = event.usage.output_tokens;
          }
          if (typeof event.usage.cache_read_input_tokens === 'number') {
            usage.cacheReadTokens = event.usage.cache_read_input_tokens;
          }
        }
      } else if (event.type === 'message_stop') {
        // Fallback for SDK versions that publish usage on message_stop only.
        const u = event.message?.usage;
        if (u) {
          if (typeof u.input_tokens === 'number') usage.inputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') usage.outputTokens = u.output_tokens;
          if (typeof u.cache_read_input_tokens === 'number') {
            usage.cacheReadTokens = u.cache_read_input_tokens;
          }
        }
      }
      // Drain any parser events accumulated during this SDK event.
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev) yield ev;
      }
    }
  } catch (err) {
    const code = classifyAnthropicError(err);
    const message = (err as Error).message ?? 'unknown anthropic error';
    log.warn({ code, err: message }, 'claude stream errored');
    // Plain union member — no cast. Plan 03-02's StreamParserEvent union
    // already includes the error variant specifically for this call site.
    yield { type: 'error', data: { code, message } };
    yield {
      type: 'done',
      data: { stopReason: 'error', narrativeChars: 0, usage },
    };
    return;
  }

  // End parser — flushes any pending state, emits suggestions (empty if none)
  // and the final done event with narrativeChars + usage.
  parser.end({ stopReason, usage });
  while (queue.length > 0) {
    const ev = queue.shift();
    if (ev) yield ev;
  }
}

/**
 * Map an arbitrary Anthropic SDK error to the stable ErrorCode union from
 * Plan 03-01 (D-07). The SSE route emits this code verbatim; Phase 4's panel
 * renders a user-visible message keyed on it, so the mapping must be stable
 * across SDK upgrades.
 *
 *   AbortError / "timeout" in message → ANTHROPIC_TIMEOUT
 *   status === 429                    → ANTHROPIC_RATE_LIMITED
 *   any other numeric status          → ANTHROPIC_ERROR
 *   otherwise                         → INTERNAL
 */
function classifyAnthropicError(err: unknown): ErrorCode {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) return 'ANTHROPIC_TIMEOUT';
  if (e?.status === 429) return 'ANTHROPIC_RATE_LIMITED';
  if (typeof e?.status === 'number') return 'ANTHROPIC_ERROR';
  return 'INTERNAL';
}
