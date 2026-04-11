---
phase: 03-context-assembler-claude
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/src/services/streamParser.ts
  - backend/src/services/__tests__/streamParser.test.ts
  - backend/package.json
autonomous: true
requirements: [CTX-07, CTX-08, CTX-11, CTX-12, CTX-13]
tags: [phase-3, parser, streaming, offline-test, wave-1]

must_haves:
  truths:
    - "StreamParser strips [ANOMALY: fieldName=\"x\" value=\"y\"] tags from the token stream and emits typed anomaly events instead"
    - "StreamParser strips the trailing {\"suggestions\":[...]} JSON from the token stream and emits a typed suggestions event"
    - "StreamParser handles chunk-boundary splits inside both tag forms without losing, duplicating, or leaking tag characters into the token output"
    - "Malformed suggestions JSON emits suggestions { items: [] } and logs a warn, never throws"
    - "StreamParser emits typed events token | anomaly | suggestions | done with exact shapes matching D-07"
    - "Offline unit tests enforce every chunk-boundary edge case with deterministic fixtures"
  artifacts:
    - path: "backend/src/services/streamParser.ts"
      provides: "class StreamParser — stateful tag + suggestions state machine"
      contains: "class StreamParser"
    - path: "backend/src/services/__tests__/streamParser.test.ts"
      provides: "Offline tests for every chunk-boundary and malformed-input case"
      contains: "StreamParser"
    - path: "backend/package.json"
      provides: "smoke:streamparser npm script that runs the offline test"
      contains: "smoke:streamparser"
  key_links:
    - from: "backend/src/services/streamParser.ts"
      to: "backend/src/types/copilot.ts"
      via: "import type { ErrorCode } — imported lazily, parser does not emit error events itself"
      pattern: "StreamParser"
---

<objective>
Build the stateful `StreamParser` class that owns the anomaly-tag and suggestions-JSON state machines. This class is the single point in Phase 3 that transforms a raw Claude text stream into the typed event sequence Phase 4's EventSource consumes (D-06, D-07, D-08, D-09). It is 100% offline-testable — no Anthropic SDK, no Fastify, no network. Downstream plans (03-05 ClaudeService, 03-06 /chat route) feed it chunks and subscribe to its events.

Purpose: Chunk-boundary robustness is THE load-bearing property of the SSE contract. A split mid-tag must NOT leak `[ANOM` into a token event nor drop the tag. A split mid-JSON must NOT leak `{"sugges` nor drop the suggestions event. Prove both with deterministic fixtures in a Wave 1 offline test so downstream plans inherit a verified primitive.

Output: One class, one test file, one npm script.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/services/__tests__/pulseService.empty.test.ts
@backend/package.json
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Write offline StreamParser tests first (RED) and StreamParser implementation to pass them (GREEN)</name>
  <files>backend/src/services/__tests__/streamParser.test.ts, backend/src/services/streamParser.ts</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-07 event catalog, D-08 anomaly tag stripping, D-09 suggestions parsing)
    - backend/src/services/__tests__/pulseService.empty.test.ts (to see the project's offline-test style: pure Node, assert, no test framework; `.test.ts` convention)
    - backend/package.json (to see existing `smoke:*` npm script ordering)
  </read_first>
  <behavior>
    RED test cases the parser must pass (write these first, confirm they fail against a stub, then implement):

    1. **Happy path — single chunk, tag then suggestions.**
       Input: `Prices rose. [ANOMALY: fieldName="Region" value="West"] Trend holds.\n\n{"suggestions":["q1","q2","q3"]}`
       Expected events in order:
         - token { text: "Prices rose. " }
         - anomaly { fieldName: "Region", value: "West", raw: '[ANOMALY: fieldName="Region" value="West"]' }
         - token { text: " Trend holds.\n\n" }
         - suggestions { items: ["q1","q2","q3"] }
         - done { stopReason: "end_turn", narrativeChars: number, usage: passed-through }
       NO token event contains `[ANOMALY` or `{"suggestions"`.

    2. **Chunk boundary mid-tag.** Feed the same input split at character 16 (inside `[ANOMALY:`), then character 32, then character 48. Expected sequence is IDENTICAL to case 1 regardless of split point. Tag characters must not leak into any token event.

    3. **Chunk boundary mid-suggestions-JSON.** Feed input split at every position inside the trailing `{"suggestions":["q1","q2","q3"]}` substring. Expected sequence identical; no JSON characters leak into token events.

    4. **Multiple anomaly tags.** Input with three consecutive anomaly tags — three anomaly events emitted in order, narrative tokens between them stream through.

    5. **Malformed tag (missing closing bracket at end of stream).** Input: `foo [ANOMALY: fieldName="X" value="Y"` with no `]` and stream ends. Expected: parser drops the buffered tag contents, logs warn, emits token for "foo " only (not the partial tag), then done. No crash.

    6. **Malformed suggestions JSON.** Input: `ok.\n\n{"suggestions":[unterminated`. Expected: parser emits `suggestions { items: [] }` and `done`, logs warn, never throws.

    7. **No suggestions at all.** Input: `just narrative text`. Expected: token { text: "just narrative text" } then `suggestions { items: [] }` then `done`. (Parser emits empty suggestions at EOS if none seen.)

    8. **Whitespace tolerance on suggestions opener.** Input: `text\n\n  {"suggestions": [ "a", "b", "c" ]}`. Expected: clean extraction, items: ["a","b","c"], token stream ends at the first whitespace preceding the `{`.

    9. **Event ordering invariant.** `done` must ALWAYS be the last event. `suggestions` must always precede `done`. `context` is emitted by the route, not by this parser — parser must NOT emit `context`.

    10. **Tag with escaped quotes inside value.** Input: `[ANOMALY: fieldName="A" value="B\"C"]`. Expected: anomaly { fieldName: "A", value: 'B"C', raw: '[ANOMALY: fieldName="A" value="B\\"C"]' }. (Planner note: implementation may choose to not support embedded quotes and document it — but the parser must not crash.)

    Edge rule: if implementation cannot support case 10, the test for case 10 should assert the tag is dropped (warn logged) rather than crashing — still a pass.
  </behavior>
  <action>
**Step A — Write the test file first (RED).** Create `backend/src/services/__tests__/streamParser.test.ts` using the same style as `backend/src/services/__tests__/pulseService.empty.test.ts`: pure Node `assert` (no vitest/jest, no test framework, runs under `tsx`), top-level `async function main()` with numbered test cases, a captured events array, and process.exit(failures > 0 ? 1 : 0) at the end.

Each test feeds a `StreamParser` with chunks via a loop calling `parser.feed(chunk)` (synchronous — the parser does NOT await). The parser exposes typed callbacks or a `.on(type, handler)` method. At end of stream, test calls `parser.end({ stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 } })` which triggers `suggestions` (if not already) and `done`.

Every test captures the emitted events into a plain array `events: Array<{type: 'token'|'anomaly'|'suggestions'|'done', data: unknown}>` and asserts:
  - NO element of events where `type === 'token'` has a `text` field containing the substring `[ANOMALY` or `{"suggestions"`
  - The full concatenation of all token `text` values equals the input with every tag and suggestions JSON removed
  - The anomaly events appear in the same order the tags appeared in the input
  - The done event is the last event

**Step B — Run the test, confirm RED** (parser file does not exist yet, expect tsx import failure). Document this in the SUMMARY.

**Step C — Write the parser (GREEN).** Create `backend/src/services/streamParser.ts`:

```typescript
import { createLogger } from '../lib/logger.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'streamParser',
});

export interface TokenEvent { text: string; }
export interface AnomalyEvent { fieldName: string; value: string; raw: string; }
export interface SuggestionsEvent { items: string[]; }
export interface DoneEvent {
  stopReason: string;
  narrativeChars: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export type StreamParserEvent =
  | { type: 'token'; data: TokenEvent }
  | { type: 'anomaly'; data: AnomalyEvent }
  | { type: 'suggestions'; data: SuggestionsEvent }
  | { type: 'done'; data: DoneEvent };

export type StreamParserHandler = (ev: StreamParserEvent) => void;

type Mode = 'text' | 'maybe-tag' | 'in-tag' | 'maybe-suggestions' | 'in-suggestions';

/**
 * Stateful parser that transforms a raw Claude text stream into the typed
 * event sequence Phase 4 consumes. Owns the [ANOMALY: ...] tag and trailing
 * {"suggestions":[...]} JSON state machines. Chunk-boundary robust by design:
 * feed() may be called with any substring split.
 *
 * Contract:
 *   - NEVER emits tag characters or JSON characters as token events.
 *   - Emits 'anomaly' the instant a closing ']' is seen after a valid tag open.
 *   - Emits 'suggestions' when the JSON block parses, or { items: [] } on end
 *     of stream if never seen / malformed.
 *   - 'done' is the last event. Always emitted exactly once via .end().
 *   - Malformed tags/JSON drop the buffered chars and log warn — never throw.
 */
export class StreamParser {
  private mode: Mode = 'text';
  private tagBuffer = '';           // chars accumulated while in 'in-tag' or 'maybe-tag'
  private suggestionsBuffer = '';    // chars accumulated while in 'in-suggestions' / 'maybe-suggestions'
  private pendingText = '';          // chars that may or may not be a tag opener (e.g. "[" followed by "A")
  private narrativeChars = 0;
  private suggestionsEmitted = false;
  private doneEmitted = false;
  private readonly handler: StreamParserHandler;

  constructor(handler: StreamParserHandler) {
    this.handler = handler;
  }

  /** Feed a chunk from the Claude stream. Synchronous; may emit 0..N events. */
  feed(chunk: string): void {
    for (const ch of chunk) {
      this.consumeChar(ch);
    }
  }

  /** End the stream. Flushes pending buffers, emits suggestions (empty if none), emits done. */
  end(doneMeta: Omit<DoneEvent, 'narrativeChars'>): void {
    if (this.doneEmitted) return;
    // Flush pending text — if we were mid-tag with no close, drop and warn.
    if (this.mode === 'in-tag' || this.mode === 'maybe-tag') {
      log.warn({ buffered: this.tagBuffer.length }, 'stream ended mid-anomaly-tag; dropping buffered chars');
      this.tagBuffer = '';
    } else if (this.pendingText.length > 0) {
      this.emitToken(this.pendingText);
      this.pendingText = '';
    }
    // Parse buffered suggestions if we were in it.
    if (this.mode === 'in-suggestions' || this.mode === 'maybe-suggestions') {
      this.tryEmitSuggestions();
    }
    if (!this.suggestionsEmitted) {
      this.handler({ type: 'suggestions', data: { items: [] } });
      this.suggestionsEmitted = true;
    }
    this.handler({
      type: 'done',
      data: { ...doneMeta, narrativeChars: this.narrativeChars },
    });
    this.doneEmitted = true;
  }

  private consumeChar(ch: string): void {
    // ... state machine: on '[' enter maybe-tag, on 'A' while maybe-tag enter in-tag, etc.
    // on ']' while in-tag, parse tag and emit anomaly or warn+drop.
    // on '{' in text, peek for "suggestions" prefix — maybe-suggestions mode.
    // on matching close brace with JSON.parse succeeding, emit suggestions.
    // Any text that's safely not a tag opener gets emitted as token {text: ch}.
    // IMPLEMENTATION: full state machine below (see inline comments).
    // ...
  }

  private emitToken(text: string): void {
    if (text.length === 0) return;
    this.narrativeChars += text.length;
    this.handler({ type: 'token', data: { text } });
  }

  private tryEmitSuggestions(): void {
    // Attempt JSON.parse on `{"suggestions":${payload}}` — if failure, log warn and emit empty.
    try {
      const parsed = JSON.parse(this.suggestionsBuffer) as { suggestions?: unknown };
      const items = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((x): x is string => typeof x === 'string')
        : [];
      this.handler({ type: 'suggestions', data: { items } });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'malformed suggestions JSON; emitting empty');
      this.handler({ type: 'suggestions', data: { items: [] } });
    }
    this.suggestionsEmitted = true;
    this.suggestionsBuffer = '';
    this.mode = 'text';
  }
}
```

The executor MUST finish implementing `consumeChar` as a real char-by-char state machine per the mode table above. The skeleton shows the structure; the body is the executor's responsibility. Suggested state transitions:

- `text` → on `[` set pendingText = "[", mode = `maybe-tag`. On `{` set suggestionsBuffer = "{", mode = `maybe-suggestions`. Else emit token {text: ch}.
- `maybe-tag` → if next char is `A` and running pendingText matches `[A`, continue until pendingText is `[ANOMALY:` (exact literal), then mode = `in-tag`, tagBuffer = pendingText + rest. If mismatch, flush pendingText as token and return to `text`.
- `in-tag` → accumulate into tagBuffer; on `]`, parse with regex `/^\[ANOMALY:\s+fieldName="([^"]*)"\s+value="([^"]*)"\]$/`. On match emit anomaly; on miss log warn and drop tagBuffer. Then mode = `text`, tagBuffer = "".
- `maybe-suggestions` → accumulate into suggestionsBuffer until it matches or falsifies the `{"suggestions":` prefix (whitespace-tolerant). If it matches, mode = `in-suggestions`. If it falsifies (e.g. `{` followed by non-`"suggestions"` content), flush the buffer as token output and return to `text`.
- `in-suggestions` → track brace depth; on depth return to 0, call `tryEmitSuggestions()`.

**Step D — Run the test, confirm GREEN.**

**Step E — Add the npm script.** Edit `backend/package.json` to add `"smoke:streamparser": "tsx src/services/__tests__/streamParser.test.ts"` directly after `"smoke:pulse:empty"` (preserves Phase 2 ordering: `smoke:auth → smoke:metadata → smoke:vizql → smoke:pulse → smoke:pulse:empty → smoke:streamparser → smoke:phase2`).

Do NOT add any dependency to package.json. The parser uses only built-in `JSON.parse` and the existing logger.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:streamparser</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/streamParser.ts`
    - File exists: `test -f backend/src/services/__tests__/streamParser.test.ts`
    - `grep -q "export class StreamParser" backend/src/services/streamParser.ts`
    - `grep -q "feed(chunk: string): void" backend/src/services/streamParser.ts`
    - `grep -q "end(doneMeta" backend/src/services/streamParser.ts`
    - `grep -q "type: 'token'" backend/src/services/streamParser.ts`
    - `grep -q "type: 'anomaly'" backend/src/services/streamParser.ts`
    - `grep -q "type: 'suggestions'" backend/src/services/streamParser.ts`
    - `grep -q "type: 'done'" backend/src/services/streamParser.ts`
    - Parser does NOT emit `[ANOMALY` in any token text (verified in test via substring assertion)
    - Parser does NOT emit `{"suggestions"` in any token text
    - `grep -q "smoke:streamparser" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:streamparser` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
    - Test file contains at least 8 distinct numbered test cases covering: happy path, mid-tag split, mid-JSON split, multiple anomalies, malformed tag, malformed JSON, no suggestions, whitespace tolerance
    - `grep -c "Test [0-9]" backend/src/services/__tests__/streamParser.test.ts` returns at least 8
  </acceptance_criteria>
  <done>Offline test passes, parser is chunk-boundary robust for all documented cases, npm script wired, zero new dependencies.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| Claude-stream → parser | Parser input is text from Anthropic API (trusted transport, but content may be adversarial if a prompt-injection slips through) |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-02-01 | Injection | Anomaly tag regex | mitigate | Regex is anchored and does not use a backreference or unbounded `.*` — no catastrophic backtracking. Malformed tags are dropped, not re-injected. |
| T-03-02-02 | DoS | Suggestions brace depth counter | mitigate | Parser tracks brace depth with a plain integer; no recursion, no unbounded buffers. If buffer grows past a sane ceiling (16KB), parser drops and emits empty suggestions. Add `if (this.suggestionsBuffer.length > 16384) { log.warn; this.handler({suggestions:{items:[]}}); reset }` to the state machine. |
| T-03-02-03 | Information Disclosure | Parser logs | accept | Parser only logs count + error message, never the tag contents or JSON payload. Pino redact paths already cover auth headers. No PII surface. |
| T-03-02-04 | Tampering | Partial tag leakage | mitigate | Case 2 and case 3 of the offline test set (chunk-boundary mid-tag / mid-JSON) grep-enforce that no `[ANOMALY` or `{"suggestions"` substring reaches a token event. |

No HIGH threats — this is an offline, pure-function primitive.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:streamparser` exits 0 (offline, no env needed)
- `pnpm --filter @aperture/backend typecheck` exits 0
- No new dependency added to `backend/package.json`
- Parser is consumable from `03-05 claudeService.ts` as `new StreamParser(handler)`
</verification>

<success_criteria>
- StreamParser class exists with `feed()` and `end()` methods
- Offline test passes with all 8+ chunk-boundary cases green
- `smoke:streamparser` npm script exists and runs
- `grep -q "[ANOMALY" backend/src/services/streamParser.ts` matches in regex definitions only, never in token-emit code paths
- Downstream plans 03-05 and 03-06 can import StreamParser as a verified primitive
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-02-SUMMARY.md`
</output>
