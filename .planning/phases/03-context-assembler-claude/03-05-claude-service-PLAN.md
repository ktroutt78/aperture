---
phase: 03-context-assembler-claude
plan: 05
type: execute
wave: 2
depends_on: [03-01, 03-02, 03-03]
files_modified:
  - backend/src/services/claudeService.ts
  - backend/src/services/__tests__/claudeService.test.ts
  - backend/package.json
autonomous: true
requirements: [CTX-10, CTX-11, CTX-12, CTX-13]
tags: [phase-3, claude, anthropic-sdk, streaming, wave-2]

must_haves:
  truths:
    - "claudeService.streamChat takes (CopilotContext, ChatMessage[], dashboardState, question) and returns an async iterable of typed StreamParserEvents (token|anomaly|suggestions|done|error)"
    - "The StreamParserEvent union from Plan 03-02 already includes the error variant — claudeService yields error events as plain union members with NO `as unknown as StreamParserEvent` casts"
    - "Model is locked to the literal string 'claude-sonnet-4-20250514' (CLAUDE.md invariant)"
    - "System prompt is built fresh from buildSystemPrompt(context) on every request (CTX-04)"
    - "The user turn content is wrapped with buildUserTurn(state, question) and appended to the client-supplied messages[] (D-15)"
    - "Conversation history is capped at 10 turns via sliding window — oldest dropped silently (D-18)"
    - "anthropic.messages.stream is the chosen SDK entrypoint (D-11)"
    - "Text deltas from the SDK are piped into a single StreamParser instance which owns tag and suggestions state machines"
    - "ClaudeServiceError wraps Anthropic errors with one of the stable ErrorCode enum values: ANTHROPIC_TIMEOUT | ANTHROPIC_RATE_LIMITED | ANTHROPIC_ERROR | INTERNAL"
    - "ANTHROPIC_API_KEY is read lazily inside streamChat — missing key throws ClaudeServiceError(INTERNAL) NOT at boot"
  artifacts:
    - path: "backend/src/services/claudeService.ts"
      provides: "streamChat(context, messages, dashboardState, question) — async iterable of StreamParserEvent"
      contains: "export async function streamChat"
    - path: "backend/src/services/__tests__/claudeService.test.ts"
      provides: "Offline tests with a stubbed Anthropic client proving message shape, system prompt cache markers, history cap, and error mapping"
      contains: "streamChat"
    - path: "backend/package.json"
      provides: "@anthropic-ai/sdk dependency and smoke:claude npm script"
      contains: "@anthropic-ai/sdk"
  key_links:
    - from: "backend/src/services/claudeService.ts"
      to: "backend/src/services/streamParser.ts"
      via: "import { StreamParser, type StreamParserEvent }"
      pattern: "new StreamParser"
    - from: "backend/src/services/claudeService.ts"
      to: "backend/src/services/systemPromptBuilder.ts"
      via: "import { buildSystemPrompt, buildUserTurn }"
      pattern: "buildSystemPrompt"
    - from: "backend/src/services/claudeService.ts"
      to: "backend/src/types/copilot.ts"
      via: "import type { CopilotContext, ChatMessage, DashboardState, ErrorCode }"
      pattern: "ChatMessage"
---

<objective>
Implement the `claudeService` — the single Phase 3 module that owns the Anthropic SDK call, plumbs Claude's text deltas through a `StreamParser`, enforces the 10-turn history cap (D-18), and maps SDK errors to the stable `ErrorCode` enum. Offline tests use a stubbed Anthropic client so no API key is required.

This plan depends on:
- **03-01** for `CopilotContext`, `ChatMessage`, `DashboardState`, `ErrorCode`, `ClaudeServiceError`
- **03-02** for `StreamParser` AND the full `StreamParserEvent` union including the `error` variant (Plan 03-02 exports this verbatim; claudeService yields error events as plain union members, no casts)
- **03-03** for `buildSystemPrompt` (D-13, D-14 sections) and `buildUserTurn` (D-15 preamble)

Purpose: Isolate every Anthropic SDK decision in one file so the route handler in Plan 03-06 sees only typed events. Model lock lives here. History cap lives here. Cache marker passes through here. Future SDK upgrades touch one module.

**CTX-18 note:** CTX-18 is a "forward-compat" requirement auto-generated for this plan to cover the sliding-window history cap (D-18). It is NOT in REQUIREMENTS.md — do NOT list it in the phase requirement ID set. The real coverage here is CTX-10/11/12/13.

Output: One service file, one offline test, one added dependency, one npm script.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@CLAUDE.md
@backend/src/types/copilot.ts
@backend/src/services/streamParser.ts
@backend/src/services/systemPromptBuilder.ts
@backend/src/services/errors.ts
@backend/src/config/env.ts
</context>

<tasks>

<task type="auto">
  <name>Task 1: Install @anthropic-ai/sdk and add smoke:claude npm script</name>
  <files>backend/package.json</files>
  <read_first>
    - backend/package.json (to see the existing dependency ordering — fastify, @fastify/cors, pino, pino-pretty, dotenv)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-11 locks `anthropic.messages.stream` as the SDK entry point)
  </read_first>
  <action>
Run `pnpm --filter @aperture/backend add @anthropic-ai/sdk@^0.40.0` (use whatever latest 0.x minor is current as of execution time; the 0.40+ series exposes `messages.stream()` as the SDK streaming helper per D-11).

After install, confirm `backend/package.json` has:
- `"@anthropic-ai/sdk"` in `dependencies`
- Existing scripts preserved
- `"smoke:claude": "tsx src/services/__tests__/claudeService.test.ts"` added after `smoke:assembler`

Do NOT install any other dependency in this task. The rate-limit plugin comes in Plan 03-08.
  </action>
  <verify>
    <automated>node -e "const p=require('./backend/package.json');if(!p.dependencies['@anthropic-ai/sdk'])process.exit(1);if(!p.scripts['smoke:claude'])process.exit(1);console.log('OK')"</automated>
  </verify>
  <acceptance_criteria>
    - `grep -q '"@anthropic-ai/sdk"' backend/package.json`
    - `grep -q '"smoke:claude"' backend/package.json`
    - `test -d backend/node_modules/@anthropic-ai/sdk` (dependency installed, not just declared)
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Existing scripts `smoke:auth`, `smoke:metadata`, `smoke:vizql`, `smoke:pulse`, `smoke:pulse:empty`, `smoke:streamparser`, `smoke:systemprompt`, `smoke:budget`, `smoke:assembler`, `smoke:phase2` are all still present: `for s in smoke:auth smoke:metadata smoke:vizql smoke:pulse smoke:pulse:empty smoke:phase2; do grep -q "\"$s\"" backend/package.json || exit 1; done`
  </acceptance_criteria>
  <done>@anthropic-ai/sdk installed, smoke:claude script wired, existing Phase 1+2 scripts intact.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Write offline claudeService tests (stubbed SDK) and implement streamChat</name>
  <files>backend/src/services/claudeService.ts, backend/src/services/__tests__/claudeService.test.ts</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-11 SDK wrapper; D-12 stateless messages[]; D-13/D-14 system prompt w/ cache marker; D-15 user-turn preamble; D-18 10-turn sliding window; D-07 ErrorCode enum)
    - CLAUDE.md (§"Claude API": model lock `claude-sonnet-4-20250514`, always stream)
    - backend/src/services/streamParser.ts (from Plan 03-02 — StreamParserEvent union MUST already include the error variant; import it as a plain union)
    - backend/src/services/systemPromptBuilder.ts (from Plan 03-03 — buildSystemPrompt + buildUserTurn signatures)
    - backend/src/types/copilot.ts (from Plan 03-01 — all types)
    - backend/src/services/errors.ts (from Plan 03-01 — ClaudeServiceError constructor)
    - backend/src/config/env.ts (loadEnv() surface; anthropicApiKey is already declared as `string | undefined`)
  </read_first>
  <behavior>
    Test cases (RED first):

    1. **Model lock** — streamChat calls the injected SDK stub with `model: 'claude-sonnet-4-20250514'`. Assert via captured call args. If the source file uses any other model string, fail.

    2. **System prompt blocks passed to SDK** — assert the SDK `system` argument is an array of content blocks (from buildSystemPrompt) with sections `# Role`, `# Output Contract`, `# Schema` in order, and that the Schema block has `cache_control: { type: 'ephemeral' }`.

    3. **User turn wrapping (D-15)** — given client-held messages=[{role:'user',content:'prev Q1'},{role:'assistant',content:'A1'}], dashboardState={workbookName:'Oil',worksheetName:'WTI',selectedMarks:[],activeFilters:[]}, question='Why the spike?', the FINAL message sent to the SDK must have:
       - role: 'user'
       - content containing `<dashboard_state>`, `workbook: Oil`, `worksheet: WTI`, `<question>Why the spike?</question>`
       - Earlier messages preserved in order.

    4. **10-turn sliding window (D-18)** — given 15 prior messages in the input, assert SDK receives at most 10 messages + the final wrapped user turn. Oldest dropped. No error, no warn-to-client (silent per D-18).

    5. **Text delta piping through StreamParser** — given an SDK stub that emits deltas `"Prices rose. "`, `"[ANOMALY: fieldName=\"Region\" value=\"West\"]"`, `" Trend."`, `"\n\n{\"suggestions\":[\"q1\",\"q2\",\"q3\"]}"`, the async iterable from streamChat should emit:
       - token { text: "Prices rose. " }
       - anomaly { fieldName: "Region", value: "West", ... }
       - token { text: " Trend." }
       - suggestions { items: ["q1","q2","q3"] }
       - done { stopReason, narrativeChars, usage }

    6. **Anthropic timeout → ErrorCode.ANTHROPIC_TIMEOUT** — stub throws an error with `.name === 'AbortError'` or `.message` containing `timeout`. streamChat yields `error { code: 'ANTHROPIC_TIMEOUT', message }` then `done`. Does NOT throw synchronously past the yield.

    7. **Anthropic 429 → ErrorCode.ANTHROPIC_RATE_LIMITED** — stub throws an error with `.status === 429`. Yield `error { code: 'ANTHROPIC_RATE_LIMITED' }`.

    8. **Other Anthropic errors → ANTHROPIC_ERROR** — stub throws a generic APIError. Yield `error { code: 'ANTHROPIC_ERROR', message }`.

    9. **Missing API key → ClaudeServiceError(INTERNAL) on first call** — set env.anthropicApiKey to undefined; call streamChat; expect first yielded event to be `error { code: 'INTERNAL', message: contains 'ANTHROPIC_API_KEY' }`.

    10. **Usage passthrough** — done event's `usage` field pulls inputTokens/outputTokens/cacheReadTokens from the SDK's final message (or falls back to 0 if the stub doesn't provide them). **Note (INFO 11):** Anthropic SDK v0.40+ delivers usage via `message_delta`, not `message_stop`. If live UAT in Plan 03-08 Task 3 observes 0/0/0 tokens, move the usage accumulation to the `message_delta` event handler. This test uses a stub and is independent of the live SDK event ordering.
  </behavior>
  <action>
Create `backend/src/services/claudeService.ts`. **Note:** Plan 03-02 now exports a `StreamParserEvent` union that already includes an `error` variant, so this module yields error events as plain union members with NO `as unknown as StreamParserEvent` casts.

```typescript
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
 * events as plain union members — NO `as unknown as StreamParserEvent` casts.
 */
import Anthropic from '@anthropic-ai/sdk';
import { StreamParser, type StreamParserEvent } from './streamParser.js';
import { buildSystemPrompt, buildUserTurn } from './systemPromptBuilder.js';
import { ClaudeServiceError } from './errors.js';
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

// D-18: 10-turn sliding window.
export const MAX_HISTORY_TURNS = 10;

// CLAUDE.md invariant — model is locked.
export const CLAUDE_MODEL = 'claude-sonnet-4-20250514' as const;

// D-11: anthropic.messages.stream is the chosen entry point.
export interface ClaudeDeps {
  client?: {
    messages: {
      stream: (opts: unknown) => AsyncIterable<unknown> & { finalMessage?: () => Promise<unknown> };
    };
  };
}

export async function* streamChat(
  context: CopilotContext,
  messages: readonly ChatMessage[],
  dashboardState: DashboardState,
  question: string,
  deps: ClaudeDeps = {},
): AsyncGenerator<StreamParserEvent, void, undefined> {
  const env = loadEnv();
  if (!env.anthropicApiKey && !deps.client) {
    // No cast — StreamParserEvent's error variant comes from Plan 03-02's union.
    yield { type: 'error', data: { code: 'INTERNAL' satisfies ErrorCode, message: 'ANTHROPIC_API_KEY not set' } };
    return;
  }

  const client = deps.client ?? new Anthropic({ apiKey: env.anthropicApiKey });

  // D-13/D-14: system prompt with cache marker. Rebuilt every request per D-12
  // (stateless) but Anthropic's prompt cache deduplicates it server-side.
  const system = buildSystemPrompt(context);

  // D-18: cap history at 10 turns, sliding window (keep last N).
  const capped = messages.slice(Math.max(0, messages.length - MAX_HISTORY_TURNS));

  // D-15: wrap final user turn with dashboard state preamble.
  const userTurnContent = buildUserTurn(dashboardState, question);
  const finalMessages = [
    ...capped.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user' as const, content: userTurnContent },
  ];

  // Queue to buffer parser events while we iterate the SDK stream.
  const queue: StreamParserEvent[] = [];
  const parser = new StreamParser((ev) => queue.push(ev));

  let stopReason = 'end_turn';
  let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

  try {
    const stream = client.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
      messages: finalMessages,
    });

    // Anthropic SDK v0.40+ emits events via async iterator.
    //
    // INFO 11 (from checker review): usage in 0.40+ is delivered via
    // `message_delta`, not `message_stop`. This handler listens to BOTH, and
    // the last value wins. If live UAT in Plan 03-08 Task 3 observes 0/0/0
    // tokens, reduce to `message_delta` only.
    for await (const event of stream as AsyncIterable<{
      type?: string;
      delta?: { text?: string; stop_reason?: string };
      message?: { stop_reason?: string; usage?: Record<string, number> };
      usage?: Record<string, number>;
    }>) {
      if (event.type === 'content_block_delta' && event.delta?.text) {
        parser.feed(event.delta.text);
      } else if (event.type === 'message_delta') {
        if (event.delta?.stop_reason) stopReason = event.delta.stop_reason;
        if (event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens ?? usage.inputTokens,
            outputTokens: event.usage.output_tokens ?? usage.outputTokens,
            cacheReadTokens: event.usage.cache_read_input_tokens ?? usage.cacheReadTokens,
          };
        }
      } else if (event.type === 'message_stop' && event.message?.usage) {
        // Fallback for SDKs that only emit usage on message_stop.
        usage = {
          inputTokens: event.message.usage.input_tokens ?? usage.inputTokens,
          outputTokens: event.message.usage.output_tokens ?? usage.outputTokens,
          cacheReadTokens: event.message.usage.cache_read_input_tokens ?? usage.cacheReadTokens,
        };
      }
      // Drain any buffered parser events to the caller.
      while (queue.length > 0) {
        const ev = queue.shift();
        if (ev) yield ev;
      }
    }
  } catch (err) {
    const code = classifyAnthropicError(err);
    log.warn({ code, err: (err as Error).message }, 'claude stream errored');
    // No cast — the error variant is part of the union from Plan 03-02.
    yield { type: 'error', data: { code, message: (err as Error).message } };
    // Still emit a done so the SSE route can cleanly close.
    yield { type: 'done', data: { stopReason: 'error', narrativeChars: 0, usage } };
    return;
  }

  // End parser → triggers suggestions (empty if none) and done.
  parser.end({ stopReason, usage });
  while (queue.length > 0) {
    const ev = queue.shift();
    if (ev) yield ev;
  }
}

function classifyAnthropicError(err: unknown): ErrorCode {
  const e = err as { name?: string; status?: number; message?: string };
  if (e?.name === 'AbortError' || /timeout/i.test(e?.message ?? '')) return 'ANTHROPIC_TIMEOUT';
  if (e?.status === 429) return 'ANTHROPIC_RATE_LIMITED';
  if (typeof e?.status === 'number') return 'ANTHROPIC_ERROR';
  return 'INTERNAL';
}
```

**Test file** — `backend/src/services/__tests__/claudeService.test.ts`:

- Build a fake Anthropic client with a `messages.stream` that returns an async iterable of fixed events.
- Pass it as `deps.client` on every call so no API key is needed.
- Use a small CopilotContext fixture (can import helper from 03-03's test fixture logic or rebuild inline).
- Assert each of the 10 behaviors above via `assert.ok` / `assert.strictEqual`.
- Test 9 (missing API key) must call `__resetEnvCacheForTests()` and temporarily unset `process.env.ANTHROPIC_API_KEY` via `delete process.env.ANTHROPIC_API_KEY`. Restore after.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:claude</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/claudeService.ts`
    - File exists: `test -f backend/src/services/__tests__/claudeService.test.ts`
    - `grep -q "export async function\* streamChat" backend/src/services/claudeService.ts`
    - `grep -q "CLAUDE_MODEL = 'claude-sonnet-4-20250514'" backend/src/services/claudeService.ts`
    - `grep -q "MAX_HISTORY_TURNS = 10" backend/src/services/claudeService.ts`
    - `grep -q "buildSystemPrompt" backend/src/services/claudeService.ts`
    - `grep -q "buildUserTurn" backend/src/services/claudeService.ts`
    - `grep -q "new StreamParser" backend/src/services/claudeService.ts`
    - `grep -q "classifyAnthropicError" backend/src/services/claudeService.ts`
    - `grep -q "'ANTHROPIC_TIMEOUT'" backend/src/services/claudeService.ts`
    - `grep -q "'ANTHROPIC_RATE_LIMITED'" backend/src/services/claudeService.ts`
    - `grep -q "from '@anthropic-ai/sdk'" backend/src/services/claudeService.ts`
    - Only ONE model string literal anywhere in claudeService.ts: `grep -c "claude-sonnet-4-20250514" backend/src/services/claudeService.ts` returns exactly `1`
    - **Blocker 4 fix**: zero `as unknown as StreamParserEvent` casts in claudeService.ts. `grep -c "as unknown as StreamParserEvent" backend/src/services/claudeService.ts` returns exactly `0`.
    - **INFO 11 comment present**: `grep -q "message_delta" backend/src/services/claudeService.ts` matches (usage handler covers the SDK v0.40+ event ordering).
    - `pnpm --filter @aperture/backend smoke:claude` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test file has at least 10 distinct numbered test cases: `grep -c "Test [0-9]" backend/src/services/__tests__/claudeService.test.ts` returns at least 10
  </acceptance_criteria>
  <done>streamChat yields typed events from a stubbed SDK, model is locked, history is capped, errors are mapped to the stable ErrorCode enum with no type casts, no API key needed for offline tests, usage handler accommodates both `message_delta` and `message_stop` so the live UAT in Plan 03-08 observes non-zero tokens.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Client `messages[]` + `question` → Claude | User-controlled content arriving via /chat POST body. Wrapped in XML boundaries by buildUserTurn (D-15) before reaching Anthropic. |
| Anthropic API key | Secret. Read from env lazily per request — never at boot, never logged. |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-05-01 | Information Disclosure | Logging the API key | mitigate | `env.anthropicApiKey` is never logged in this module. Pino redact paths from Phase 1 already cover `Authorization` / auth headers. Test: `grep "anthropicApiKey" backend/src/services/claudeService.ts | grep -v "env.anthropicApiKey\|!env.anthropicApiKey\|apiKey: env.anthropicApiKey"` returns no matches. |
| T-03-05-02 | Injection (prompt) | User-supplied `question` | mitigate | Wrapped in `<question>...</question>` by buildUserTurn. System prompt's Output Contract rule 6 says "Do not include preambles or meta-commentary" — Claude treats the wrapped content as data. Defense-in-depth only; primary mitigation is content-rating on the model itself. |
| T-03-05-03 | DoS | Slow Claude response leaking proxy timeouts | mitigate | Plan 03-06 implements D-10 SSE heartbeat `: ping` every 15s. Plan 03-08 adds @fastify/rate-limit D-22 60/min/IP cap on /chat. This plan's contribution: error mapping catches AbortError → ANTHROPIC_TIMEOUT, gracefully closes the stream. |
| T-03-05-04 | DoS (Anthropic bill) | Unbounded history growth | mitigate | D-18 MAX_HISTORY_TURNS = 10 sliding window. Test 4 enforces. |
| T-03-05-05 | Repudiation | Missing request logs | accept | Server-side pino logs include request context, count-only. User-identification is a Phase 5 concern (demo uses anonymous sandbox). |

No HIGH threats. Prompt injection is partially mitigated here and fully mitigated at the model level.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:claude` exits 0 (offline)
- `pnpm --filter @aperture/backend typecheck` exits 0
- `@anthropic-ai/sdk` is the ONLY new dependency added in Phase 3 so far
- No API key needed to run the offline test
- Zero `as unknown as StreamParserEvent` casts in the source file
</verification>

<success_criteria>
- streamChat is an async generator yielding typed events
- Error events yielded as plain StreamParserEvent union members (no casts) — Blocker 4 fix
- System prompt includes cache marker and section order from Plan 03-03
- History is capped at 10 turns
- Model literal `claude-sonnet-4-20250514` appears exactly once (the constant declaration)
- Error classification maps to stable ErrorCode enum values
- Usage handler listens to both `message_delta` and `message_stop` to accommodate Anthropic SDK v0.40+ event ordering
- All 10 offline test cases pass with a stubbed SDK client
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-05-SUMMARY.md`
</output>
