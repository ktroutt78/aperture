/**
 * Phase 3 StreamParser — stateful text-to-events transformer.
 *
 * This module is the single point in the backend where a raw Claude text
 * stream is converted into the typed SSE event sequence Phase 4 consumes
 * (per D-06, D-07, D-08, D-09 in `.planning/phases/03-context-assembler-claude/03-CONTEXT.md`).
 *
 * Zero runtime dependencies beyond the existing pino logger. No Anthropic
 * SDK import, no Fastify import, no network. 100% offline-testable via
 * `backend/src/services/__tests__/streamParser.test.ts`.
 *
 * Contract (load-bearing — see plan 03-02):
 *   - feed(chunk) is synchronous; any chunk-boundary split produces the
 *     identical event sequence as feeding the full input at once.
 *   - Tag text (`[ANOMALY: ...]`) is NEVER emitted in a `token` event —
 *     it is buffered while inside a tag and surfaces as a typed `anomaly`
 *     event the instant the closing `]` is seen.
 *   - The trailing `{"suggestions":[...]}` JSON is NEVER emitted in a
 *     `token` event — it is consumed by the suggestions state machine
 *     and surfaces as a typed `suggestions` event.
 *   - `done` is the last event, always, exactly once.
 *   - Malformed tags / malformed JSON drop the buffered chars and log
 *     `warn` — the parser never throws.
 *   - The parser state machine itself never emits `error`. The `error`
 *     variant exists in the exported StreamParserEvent union so that
 *     `claudeService` (Plan 03-05) can yield error events through the
 *     same type without `as unknown as StreamParserEvent` casts.
 */
import { createLogger } from '../lib/logger.js';
import type { ErrorCode } from '../types/copilot.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'streamParser',
});

// ---------------------------------------------------------------------------
// Public event payload types
// ---------------------------------------------------------------------------
export interface TokenEvent {
  text: string;
}

export interface AnomalyEvent {
  fieldName: string;
  value: string;
  raw: string;
}

export interface SuggestionsEvent {
  items: string[];
}

export interface DoneEvent {
  stopReason: string;
  narrativeChars: number;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number };
}

export interface ErrorEvent {
  code: ErrorCode;
  message: string;
}

/**
 * Union of every event type that flows through the SSE wire, per D-07.
 *
 * IMPORTANT: This union covers ALL events a route or upstream service may
 * emit — not just the ones the parser state machine produces. Plan 03-05
 * (claudeService) yields `error` events through this same union so the
 * route can `reply.raw.write('event: ' + ev.type + ...)` uniformly. Do NOT
 * remove the `error` variant; removing it breaks claudeService type-check
 * and forces `as unknown as StreamParserEvent` casts.
 *
 * Events the parser state machine produces: token | anomaly | suggestions | done.
 * Events claudeService (Plan 03-05) produces additionally: error.
 * Events the route (Plan 03-06) produces additionally: context.
 */
export type StreamParserEvent =
  | { type: 'token'; data: TokenEvent }
  | { type: 'anomaly'; data: AnomalyEvent }
  | { type: 'suggestions'; data: SuggestionsEvent }
  | { type: 'done'; data: DoneEvent }
  | { type: 'error'; data: ErrorEvent };

export type StreamParserHandler = (ev: StreamParserEvent) => void;

// ---------------------------------------------------------------------------
// Internal state machine
// ---------------------------------------------------------------------------
type Mode =
  | 'text'
  | 'maybe-tag' // saw `[`, watching for `A`, `N`, `O`, `M`, `A`, `L`, `Y`, `:`
  | 'in-tag' // inside an anomaly tag body, waiting for `]`
  | 'maybe-suggestions' // saw `{`, watching for `"suggestions":`
  | 'in-suggestions'; // inside the suggestions JSON body, tracking brace depth

const TAG_PREFIX = '[ANOMALY:';
/** `{` plus optional whitespace plus `"suggestions"` plus optional whitespace plus `:` */
const SUGGESTIONS_PREFIX_RE = /^\{\s*"suggestions"\s*:/;

/** 16 KB ceiling per T-03-02-02 — mitigates DoS-by-unbounded-suggestions-buffer. */
const SUGGESTIONS_BUFFER_MAX = 16 * 1024;
/** 8 KB ceiling on tag buffer — anomaly tags are tiny, anything larger is a bug or attack. */
const TAG_BUFFER_MAX = 8 * 1024;

/**
 * Parse a complete anomaly tag buffer (including the surrounding brackets)
 * into its fieldName/value payload. Returns null on any shape mismatch so
 * the caller can log+drop without throwing.
 *
 * Anchored, no catastrophic backtracking (T-03-02-01). Supports escaped
 * double-quotes inside the value via a negated-character-class plus
 * explicit `\\.` escape step — stays linear.
 */
function parseAnomalyTag(raw: string): { fieldName: string; value: string } | null {
  // `[ANOMALY: fieldName="..." value="..."]` with optional whitespace tolerance.
  // fieldName chars: anything except `"` and `\`, or a `\` followed by any char.
  // value chars: same rule. We anchor start/end so random text can't match.
  const re =
    /^\[ANOMALY:\s+fieldName="((?:[^"\\]|\\.)*)"\s+value="((?:[^"\\]|\\.)*)"\]$/;
  const m = re.exec(raw);
  if (!m) return null;
  // Unescape `\"` → `"` and `\\` → `\` inside the captured strings.
  const unescape = (s: string): string => s.replace(/\\(.)/g, '$1');
  return { fieldName: unescape(m[1]!), value: unescape(m[2]!) };
}

/**
 * StreamParser owns the tag + suggestions state machines. One instance per
 * /chat turn. Feed chunks in order; call .end() when the upstream stream
 * completes to flush and emit `done`.
 */
export class StreamParser {
  private mode: Mode = 'text';

  /** Accumulates characters buffered inside `maybe-tag` or `in-tag`. */
  private tagBuffer = '';

  /** Accumulates characters buffered inside `maybe-suggestions` or `in-suggestions`. */
  private suggestionsBuffer = '';

  /**
   * Trailing horizontal whitespace (spaces/tabs) held speculatively in
   * `text` mode. If followed by `{` we absorb it into the suggestions
   * machine (whitespace before a suggestions opener is not narrative, per
   * D-09 / plan test 8). On any other non-whitespace char, flush as token
   * text. Newlines flush immediately — they are narrative, not pre-opener
   * padding.
   */
  private pendingWhitespace = '';

  /** Tracks `{` depth inside `in-suggestions`. */
  private suggestionsDepth = 0;

  /** Set when we are inside a double-quoted string inside the suggestions JSON. */
  private suggestionsInString = false;

  /** Previous char was a backslash inside a suggestions string (for escape handling). */
  private suggestionsEscape = false;

  /** Running count of characters emitted as token text. */
  private narrativeChars = 0;

  /** Guard: only emit `suggestions` once per parser instance. */
  private suggestionsEmitted = false;

  /** Guard: only emit `done` once. */
  private doneEmitted = false;

  private readonly handler: StreamParserHandler;

  constructor(handler: StreamParserHandler) {
    this.handler = handler;
  }

  /**
   * Feed a chunk from the Claude stream. Synchronous; may emit 0..N events.
   * Safe to call with any substring split — the state machine carries
   * cross-chunk state in its own fields.
   */
  feed(chunk: string): void {
    if (this.doneEmitted) return;
    for (const ch of chunk) {
      this.consumeChar(ch);
    }
  }

  /**
   * End the stream. Flushes any buffered state, emits `suggestions` (empty
   * if none seen or malformed) and `done`. Idempotent.
   */
  end(doneMeta: Omit<DoneEvent, 'narrativeChars'>): void {
    if (this.doneEmitted) return;

    // Flush according to the mode we're stuck in.
    switch (this.mode) {
      case 'text':
        // Flush any pending horizontal whitespace — at EOS there is no
        // opener following, so the whitespace IS trailing narrative.
        if (this.pendingWhitespace.length > 0) {
          this.emitToken(this.pendingWhitespace);
          this.pendingWhitespace = '';
        }
        break;
      case 'maybe-tag':
      case 'in-tag':
        log.warn(
          { buffered: this.tagBuffer.length },
          'stream ended mid-anomaly-tag; dropping buffered chars',
        );
        this.tagBuffer = '';
        this.mode = 'text';
        break;
      case 'maybe-suggestions':
        // Ambiguous — the buffered `{...}` never resolved into a real
        // suggestions block. Try to emit it as token text so we don't lose
        // narrative, then fall through to the empty-suggestions default.
        if (this.suggestionsBuffer.length > 0) {
          // The buffer at this point is the unresolved `{...` payload. It
          // never matched the suggestions prefix. Since we're at EOS and
          // can't know intent, drop it with a warn — leaking partial JSON
          // back into token text would violate the D-09 invariant.
          log.warn(
            { buffered: this.suggestionsBuffer.length },
            'stream ended mid-maybe-suggestions; dropping ambiguous buffer',
          );
          this.suggestionsBuffer = '';
        }
        this.mode = 'text';
        break;
      case 'in-suggestions':
        // Partial JSON — attempt to parse, fall back to empty.
        this.tryEmitSuggestions();
        break;
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

  // -------------------------------------------------------------------------
  // State machine core
  // -------------------------------------------------------------------------
  private consumeChar(ch: string): void {
    switch (this.mode) {
      case 'text':
        this.consumeText(ch);
        return;
      case 'maybe-tag':
        this.consumeMaybeTag(ch);
        return;
      case 'in-tag':
        this.consumeInTag(ch);
        return;
      case 'maybe-suggestions':
        this.consumeMaybeSuggestions(ch);
        return;
      case 'in-suggestions':
        this.consumeInSuggestions(ch);
        return;
    }
  }

  private consumeText(ch: string): void {
    if (ch === '{') {
      // Possible suggestions JSON opener. Discard any pending horizontal
      // whitespace — per D-09 / plan test 8, whitespace immediately
      // preceding the opener is formatting padding, not narrative, and
      // must not leak into token text. If the `{` turns out NOT to open a
      // suggestions block the `maybe-suggestions` fallback will flush the
      // buffered chars; the dropped pre-opener whitespace is a single
      // bounded leak (at most a handful of chars) that is acceptable per
      // D-09's explicit "whitespace tolerance" language.
      this.pendingWhitespace = '';
      this.suggestionsBuffer = '{';
      this.mode = 'maybe-suggestions';
      return;
    }
    if (ch === ' ' || ch === '\t') {
      // Horizontal whitespace — append to the speculative run. If a `{`
      // opener follows the whole run gets absorbed by the suggestions
      // machine; otherwise it flushes on the next non-ws non-`{` char.
      // (Newlines intentionally NOT buffered; they're narrative paragraph
      // breaks, not pre-opener padding.)
      this.pendingWhitespace += ch;
      return;
    }
    // Any non-`{` non-horizontal-ws character means the pending whitespace
    // run was NOT pre-opener padding. Flush it back out as token text
    // before dispatching the current char.
    if (this.pendingWhitespace.length > 0) {
      this.emitToken(this.pendingWhitespace);
      this.pendingWhitespace = '';
    }
    if (ch === '[') {
      // Possible anomaly tag opener. Buffer it and wait for the next chars.
      this.tagBuffer = '[';
      this.mode = 'maybe-tag';
      return;
    }
    // Plain text — emit as a single-char token event.
    this.emitToken(ch);
  }

  /**
   * Inside `maybe-tag` we have buffered some prefix of `[ANOMALY:`. As long
   * as `tagBuffer` remains a prefix of `TAG_PREFIX`, keep buffering. On
   * mismatch, flush the buffer back out as token text and re-consume the
   * offending character as plain text (so a `[` followed by non-A chars is
   * not lost).
   *
   * Once `tagBuffer === TAG_PREFIX` exactly, transition to `in-tag`.
   */
  private consumeMaybeTag(ch: string): void {
    const candidate = this.tagBuffer + ch;
    if (TAG_PREFIX.startsWith(candidate)) {
      this.tagBuffer = candidate;
      if (candidate === TAG_PREFIX) {
        // Stay in tagBuffer accumulation mode but now we're inside the tag
        // body, waiting for the closing `]`.
        this.mode = 'in-tag';
      }
      return;
    }
    // Mismatch — the buffered chars were NOT the start of an anomaly tag.
    // Flush the buffered chars as token text (they're normal narrative) and
    // re-process the current char from the top of the state machine.
    const flushed = this.tagBuffer;
    this.tagBuffer = '';
    this.mode = 'text';
    this.emitToken(flushed);
    this.consumeChar(ch);
  }

  /**
   * Inside the tag body. Accumulate every char into tagBuffer until we see
   * a closing `]`. On `]`, try to parse; on success emit `anomaly`; on
   * miss, log warn and drop the buffer.
   */
  private consumeInTag(ch: string): void {
    this.tagBuffer += ch;
    if (this.tagBuffer.length > TAG_BUFFER_MAX) {
      log.warn(
        { buffered: this.tagBuffer.length },
        'anomaly tag buffer exceeded ceiling; dropping',
      );
      this.tagBuffer = '';
      this.mode = 'text';
      return;
    }
    if (ch !== ']') return;
    const raw = this.tagBuffer;
    this.tagBuffer = '';
    this.mode = 'text';
    const parsed = parseAnomalyTag(raw);
    if (parsed) {
      this.handler({
        type: 'anomaly',
        data: { fieldName: parsed.fieldName, value: parsed.value, raw },
      });
    } else {
      log.warn({ rawLength: raw.length }, 'malformed anomaly tag; dropping');
    }
  }

  /**
   * Inside `maybe-suggestions` we have buffered some prefix starting at `{`.
   * We need to decide whether this `{` opens a real suggestions block or is
   * just a `{` in the narrative text.
   *
   * Rule: keep accumulating until either
   *   - the buffer matches SUGGESTIONS_PREFIX_RE (transition to `in-suggestions`
   *     and seed brace depth), OR
   *   - the buffer can no longer possibly match (flush as token text).
   */
  private consumeMaybeSuggestions(ch: string): void {
    this.suggestionsBuffer += ch;
    if (this.suggestionsBuffer.length > SUGGESTIONS_BUFFER_MAX) {
      log.warn(
        { buffered: this.suggestionsBuffer.length },
        'maybe-suggestions buffer exceeded ceiling; dropping',
      );
      this.suggestionsBuffer = '';
      this.mode = 'text';
      return;
    }
    if (SUGGESTIONS_PREFIX_RE.test(this.suggestionsBuffer)) {
      // Matched `{ "suggestions" :` — enter the JSON body state machine.
      // Seed the brace depth: the opening `{` we just consumed is depth 1.
      this.suggestionsDepth = 1;
      this.suggestionsInString = false;
      this.suggestionsEscape = false;
      this.mode = 'in-suggestions';
      return;
    }
    if (!isSuggestionsPrefixPrefix(this.suggestionsBuffer)) {
      // Can no longer match — this `{...}` is not a suggestions block. Flush
      // the buffered chars as token text. If it accidentally contained
      // another `{`, we will re-enter maybe-suggestions on that char via the
      // re-processing step below.
      const flushed = this.suggestionsBuffer;
      this.suggestionsBuffer = '';
      this.mode = 'text';
      // Emit all but the last char (the last char is what caused the mismatch)
      // as safe text, then re-process the last char from the top — this is
      // symmetric with the maybe-tag fallback and preserves the invariant
      // that any `{` we encounter re-enters maybe-suggestions.
      if (flushed.length > 1) {
        this.emitToken(flushed.slice(0, -1));
      } else {
        this.emitToken(flushed);
        return;
      }
      const replay = flushed[flushed.length - 1]!;
      this.consumeChar(replay);
    }
    // Otherwise keep accumulating — still a viable prefix of the opener.
  }

  /**
   * Inside the suggestions JSON body. Track brace depth with proper string
   * handling (braces inside strings don't count) so we can find the matching
   * closing brace even if a suggestion string contains `{` or `}`.
   */
  private consumeInSuggestions(ch: string): void {
    this.suggestionsBuffer += ch;
    if (this.suggestionsBuffer.length > SUGGESTIONS_BUFFER_MAX) {
      log.warn(
        { buffered: this.suggestionsBuffer.length },
        'suggestions buffer exceeded ceiling; dropping and emitting empty',
      );
      // Drop buffer, emit empty suggestions, return to text mode.
      this.suggestionsBuffer = '';
      this.suggestionsDepth = 0;
      this.mode = 'text';
      if (!this.suggestionsEmitted) {
        this.handler({ type: 'suggestions', data: { items: [] } });
        this.suggestionsEmitted = true;
      }
      return;
    }

    if (this.suggestionsInString) {
      if (this.suggestionsEscape) {
        this.suggestionsEscape = false;
        return;
      }
      if (ch === '\\') {
        this.suggestionsEscape = true;
        return;
      }
      if (ch === '"') {
        this.suggestionsInString = false;
      }
      return;
    }

    // Not inside a string.
    if (ch === '"') {
      this.suggestionsInString = true;
      return;
    }
    if (ch === '{') {
      this.suggestionsDepth++;
      return;
    }
    if (ch === '}') {
      this.suggestionsDepth--;
      if (this.suggestionsDepth === 0) {
        // Complete JSON block — try to parse and emit.
        this.tryEmitSuggestions();
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Emit helpers
  // -------------------------------------------------------------------------
  private emitToken(text: string): void {
    if (text.length === 0) return;
    this.narrativeChars += text.length;
    this.handler({ type: 'token', data: { text } });
  }

  /**
   * Attempt to parse `suggestionsBuffer` as JSON and emit a `suggestions`
   * event. On any failure, emit `suggestions { items: [] }` and log warn.
   * Idempotent via `suggestionsEmitted` guard.
   */
  private tryEmitSuggestions(): void {
    if (this.suggestionsEmitted) {
      this.suggestionsBuffer = '';
      this.suggestionsDepth = 0;
      this.mode = 'text';
      return;
    }
    try {
      const parsed = JSON.parse(this.suggestionsBuffer) as { suggestions?: unknown };
      const items = Array.isArray(parsed.suggestions)
        ? parsed.suggestions.filter((x): x is string => typeof x === 'string')
        : [];
      this.handler({ type: 'suggestions', data: { items } });
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        'malformed suggestions JSON; emitting empty',
      );
      this.handler({ type: 'suggestions', data: { items: [] } });
    }
    this.suggestionsEmitted = true;
    this.suggestionsBuffer = '';
    this.suggestionsDepth = 0;
    this.mode = 'text';
  }
}

// ---------------------------------------------------------------------------
// Helper: is `s` a viable prefix of a whitespace-tolerant `{"suggestions":`
// opener? Returns true if there exists some extension of `s` that would match
// SUGGESTIONS_PREFIX_RE. Used in the maybe-suggestions fallback logic.
// ---------------------------------------------------------------------------
function isSuggestionsPrefixPrefix(s: string): boolean {
  // The canonical opener, no whitespace, is `{"suggestions":`. Because the
  // regex allows optional whitespace between `{`, `"suggestions"`, and `:`,
  // a viable prefix is any string that is either:
  //   - a prefix of `{"suggestions":` (ignoring optional whitespace), OR
  //   - contains only `{`, whitespace, and a prefix of `"suggestions"`, OR
  //   - contains `{`, ws, `"suggestions"`, ws, and (optionally) `:`.
  // The simplest correct implementation: walk a tiny state machine over `s`.
  let i = 0;
  // Must start with `{`
  if (i >= s.length) return true;
  if (s[i] !== '{') return false;
  i++;
  // Optional whitespace
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return true;
  // Must start `"suggestions"` — accept any prefix of that literal.
  const lit = '"suggestions"';
  let k = 0;
  while (i < s.length && k < lit.length && s[i] === lit[k]) {
    i++;
    k++;
  }
  if (i < s.length && k < lit.length) return false; // mismatch in the middle of the literal
  if (i >= s.length) return true; // still building the literal
  // Consumed the full literal. Optional whitespace.
  while (i < s.length && /\s/.test(s[i]!)) i++;
  if (i >= s.length) return true;
  // Must be `:`
  if (s[i] !== ':') return false;
  return true;
}
