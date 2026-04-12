/**
 * Plan 03-02 — OFFLINE unit test for StreamParser.
 *
 * Runs WITHOUT any network access, WITHOUT test framework. Invocation:
 *   `pnpm --filter @aperture/backend smoke:streamparser`
 *
 * Exit 0 = every documented chunk-boundary + malformed case holds.
 * Exit 1 = regression — the parser either crashed, leaked tag/JSON chars
 * into token events, or reordered the mandatory event sequence.
 *
 * The style matches pulseService.empty.test.ts: pure Node `assert`, no
 * vitest/jest/mocha, top-level async `main()` that exits with the
 * accumulated failure count.
 */
import assert from 'node:assert/strict';

import {
  StreamParser,
  type StreamParserEvent,
  type DoneEvent,
} from '../streamParser.js';

// ---------------------------------------------------------------------------
// Test 11 (compile-time) — StreamParserEvent union MUST include the `error`
// variant so claudeService (Plan 03-05) can yield error events through the
// same type without casts. If this line fails to typecheck, claudeService
// will break with a cryptic cast error. Keep it as the first executable
// statement so regressions fail loudly before any runtime case executes.
// ---------------------------------------------------------------------------
const _typecheck: StreamParserEvent = {
  type: 'error',
  data: { code: 'ANTHROPIC_ERROR', message: 'x' },
};
void _typecheck;

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------
const DONE_META: Omit<DoneEvent, 'narrativeChars'> = {
  stopReason: 'end_turn',
  usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
};

interface RunResult {
  readonly events: readonly StreamParserEvent[];
  readonly tokenText: string;
}

/** Feed `input` to a fresh parser in the given chunk sizes, then end(). */
function runParser(input: string, chunkSize = input.length): RunResult {
  const events: StreamParserEvent[] = [];
  const parser = new StreamParser((ev) => events.push(ev));
  for (let i = 0; i < input.length; i += chunkSize) {
    parser.feed(input.slice(i, i + chunkSize));
  }
  parser.end(DONE_META);
  const tokenText = events
    .filter((e): e is Extract<StreamParserEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.data.text)
    .join('');
  return { events, tokenText };
}

/** Feed `input` to a fresh parser split at the given absolute index. */
function runParserSplit(input: string, splitAt: number): RunResult {
  const events: StreamParserEvent[] = [];
  const parser = new StreamParser((ev) => events.push(ev));
  parser.feed(input.slice(0, splitAt));
  parser.feed(input.slice(splitAt));
  parser.end(DONE_META);
  const tokenText = events
    .filter((e): e is Extract<StreamParserEvent, { type: 'token' }> => e.type === 'token')
    .map((e) => e.data.text)
    .join('');
  return { events, tokenText };
}

/**
 * Invariant that every test shares:
 *   1. No token event contains raw `[ANOMALY` or `{"suggestions"` substrings.
 *   2. `done` is the LAST event.
 *   3. `suggestions` precedes `done`.
 *   4. Parser never emits `error` or `context` itself.
 */
function assertInvariants(label: string, res: RunResult): void {
  for (const ev of res.events) {
    if (ev.type === 'token') {
      assert.ok(
        !ev.data.text.includes('[ANOMALY'),
        `${label}: token event leaked "[ANOMALY" substring: ${JSON.stringify(ev.data.text)}`,
      );
      assert.ok(
        !ev.data.text.includes('{"suggestions"'),
        `${label}: token event leaked '{"suggestions"' substring: ${JSON.stringify(ev.data.text)}`,
      );
    }
    assert.notStrictEqual(
      ev.type,
      'error',
      `${label}: parser emitted an error event — the state machine must never emit error`,
    );
    assert.notStrictEqual(
      ev.type,
      'context',
      `${label}: parser emitted a context event — context is emitted by the route, not the parser`,
    );
  }
  const last = res.events[res.events.length - 1];
  assert.ok(last, `${label}: no events emitted`);
  assert.strictEqual(last.type, 'done', `${label}: last event must be 'done' (got '${last.type}')`);
  const suggestionsIdx = res.events.findIndex((e) => e.type === 'suggestions');
  const doneIdx = res.events.findIndex((e) => e.type === 'done');
  assert.ok(suggestionsIdx >= 0, `${label}: no suggestions event emitted`);
  assert.ok(suggestionsIdx < doneIdx, `${label}: suggestions must precede done`);
  assert.strictEqual(
    res.events.filter((e) => e.type === 'done').length,
    1,
    `${label}: done must be emitted exactly once`,
  );
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------
let failures = 0;
function runCase(label: string, fn: () => void): void {
  try {
    fn();
    console.log(`[test] PASS ${label}`);
  } catch (err) {
    failures++;
    console.error(`[test] FAIL ${label}`);
    console.error((err as Error).message);
  }
}

async function main(): Promise<void> {
  // -------------------------------------------------------------------------
  // Test 1 — Happy path: tag then suggestions in a single chunk.
  // -------------------------------------------------------------------------
  runCase('Test 1: happy path single chunk', () => {
    const input =
      'Prices rose. [ANOMALY: fieldName="Region" value="West"] Trend holds.\n\n{"suggestions":["q1","q2","q3"]}';
    const res = runParser(input);
    assertInvariants('Test 1', res);

    // Token text must equal the input with tag + suggestions stripped.
    assert.strictEqual(res.tokenText, 'Prices rose.  Trend holds.\n\n');

    // Exactly one anomaly event with the right payload.
    const anomalies = res.events.filter(
      (e): e is Extract<StreamParserEvent, { type: 'anomaly' }> => e.type === 'anomaly',
    );
    assert.strictEqual(anomalies.length, 1, 'expected one anomaly event');
    assert.strictEqual(anomalies[0]!.data.fieldName, 'Region');
    assert.strictEqual(anomalies[0]!.data.value, 'West');
    assert.strictEqual(
      anomalies[0]!.data.raw,
      '[ANOMALY: fieldName="Region" value="West"]',
    );

    // Suggestions parsed correctly.
    const suggestions = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.deepStrictEqual(suggestions!.data.items, ['q1', 'q2', 'q3']);

    // Done carries narrativeChars + usage passthrough.
    const done = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'done' }> => e.type === 'done',
    )!;
    assert.strictEqual(done.data.stopReason, 'end_turn');
    assert.strictEqual(done.data.usage.inputTokens, 100);
    assert.strictEqual(done.data.usage.outputTokens, 50);
    assert.strictEqual(done.data.narrativeChars, 'Prices rose.  Trend holds.\n\n'.length);
  });

  // -------------------------------------------------------------------------
  // Test 2 — Chunk boundary mid-tag: split at positions 16, 32, 48 inside
  // `[ANOMALY:` / tag body. Expected output identical regardless of split.
  // -------------------------------------------------------------------------
  runCase('Test 2: chunk boundary mid-tag', () => {
    const input =
      'Prices rose. [ANOMALY: fieldName="Region" value="West"] Trend holds.\n\n{"suggestions":["q1","q2","q3"]}';
    const baseline = runParser(input);

    for (const splitAt of [16, 32, 48, 14, 15, 53, 54]) {
      const res = runParserSplit(input, splitAt);
      assertInvariants(`Test 2 split@${splitAt}`, res);
      assert.strictEqual(
        res.tokenText,
        baseline.tokenText,
        `split@${splitAt}: tokenText diverged from baseline`,
      );
      const anomalies = res.events.filter((e) => e.type === 'anomaly');
      assert.strictEqual(anomalies.length, 1, `split@${splitAt}: expected one anomaly`);
      const suggestions = res.events.find(
        (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> =>
          e.type === 'suggestions',
      );
      assert.deepStrictEqual(suggestions!.data.items, ['q1', 'q2', 'q3']);
    }
  });

  // -------------------------------------------------------------------------
  // Test 3 — Chunk boundary mid-suggestions-JSON: sweep every split position
  // inside `{"suggestions":["q1","q2","q3"]}`.
  // -------------------------------------------------------------------------
  runCase('Test 3: chunk boundary mid-suggestions-JSON', () => {
    const prefix = 'Narrative complete.\n\n';
    const jsonPart = '{"suggestions":["q1","q2","q3"]}';
    const input = prefix + jsonPart;

    const baseline = runParser(input);
    assertInvariants('Test 3 baseline', baseline);
    assert.strictEqual(baseline.tokenText, 'Narrative complete.\n\n');

    for (let i = prefix.length; i <= input.length; i++) {
      const res = runParserSplit(input, i);
      assertInvariants(`Test 3 split@${i}`, res);
      assert.strictEqual(
        res.tokenText,
        baseline.tokenText,
        `split@${i}: tokenText diverged`,
      );
      const suggestions = res.events.find(
        (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> =>
          e.type === 'suggestions',
      );
      assert.deepStrictEqual(
        suggestions!.data.items,
        ['q1', 'q2', 'q3'],
        `split@${i}: suggestions did not parse`,
      );
    }
  });

  // -------------------------------------------------------------------------
  // Test 4 — Multiple anomaly tags.
  // -------------------------------------------------------------------------
  runCase('Test 4: multiple anomaly tags', () => {
    const input =
      'A [ANOMALY: fieldName="F1" value="V1"] B [ANOMALY: fieldName="F2" value="V2"] C [ANOMALY: fieldName="F3" value="V3"] D\n\n{"suggestions":["a","b","c"]}';
    const res = runParser(input);
    assertInvariants('Test 4', res);

    const anomalies = res.events.filter(
      (e): e is Extract<StreamParserEvent, { type: 'anomaly' }> => e.type === 'anomaly',
    );
    assert.strictEqual(anomalies.length, 3);
    assert.deepStrictEqual(
      anomalies.map((a) => a.data.fieldName),
      ['F1', 'F2', 'F3'],
    );
    assert.deepStrictEqual(
      anomalies.map((a) => a.data.value),
      ['V1', 'V2', 'V3'],
    );

    // Narrative between tags streams through.
    assert.strictEqual(res.tokenText, 'A  B  C  D\n\n');
  });

  // -------------------------------------------------------------------------
  // Test 5 — Malformed tag (no closing bracket at end of stream).
  // The buffered tag chars must NOT appear in token events.
  // -------------------------------------------------------------------------
  runCase('Test 5: malformed tag (missing closing bracket)', () => {
    const input = 'foo [ANOMALY: fieldName="X" value="Y"';
    const res = runParser(input);
    assertInvariants('Test 5', res);

    // The partial tag must be dropped — only "foo " should survive.
    assert.strictEqual(res.tokenText, 'foo ');
    // No anomaly events.
    const anomalies = res.events.filter((e) => e.type === 'anomaly');
    assert.strictEqual(anomalies.length, 0);
    // Suggestions still emitted (empty) at EOS.
    const suggestions = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.deepStrictEqual(suggestions!.data.items, []);
  });

  // -------------------------------------------------------------------------
  // Test 6 — Malformed suggestions JSON. Must emit empty suggestions, never throw.
  // -------------------------------------------------------------------------
  runCase('Test 6: malformed suggestions JSON', () => {
    const input = 'ok.\n\n{"suggestions":[unterminated';
    const res = runParser(input);
    assertInvariants('Test 6', res);

    assert.strictEqual(res.tokenText, 'ok.\n\n');
    const suggestions = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.deepStrictEqual(suggestions!.data.items, []);
  });

  // -------------------------------------------------------------------------
  // Test 7 — No suggestions at all. Parser must emit empty suggestions + done.
  // -------------------------------------------------------------------------
  runCase('Test 7: no suggestions at all', () => {
    const input = 'just narrative text';
    const res = runParser(input);
    assertInvariants('Test 7', res);

    assert.strictEqual(res.tokenText, 'just narrative text');
    const suggestions = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.deepStrictEqual(suggestions!.data.items, []);
  });

  // -------------------------------------------------------------------------
  // Test 8 — Whitespace tolerance on suggestions opener.
  // -------------------------------------------------------------------------
  runCase('Test 8: whitespace-tolerant suggestions opener', () => {
    const input = 'text\n\n  {"suggestions": [ "a", "b", "c" ]}';
    const res = runParser(input);
    assertInvariants('Test 8', res);

    // Token text ends at the first whitespace preceding the `{` — i.e. the
    // two-space gap and the `{...}` are consumed by the suggestions machine.
    assert.strictEqual(res.tokenText, 'text\n\n');
    const suggestions = res.events.find(
      (e): e is Extract<StreamParserEvent, { type: 'suggestions' }> => e.type === 'suggestions',
    );
    assert.deepStrictEqual(suggestions!.data.items, ['a', 'b', 'c']);
  });

  // -------------------------------------------------------------------------
  // Test 9 — Event ordering invariant already enforced by assertInvariants;
  // we add an explicit case that asserts the parser never emits context/error.
  // -------------------------------------------------------------------------
  runCase('Test 9: event ordering invariant', () => {
    const input =
      'hello [ANOMALY: fieldName="A" value="B"] world\n\n{"suggestions":["q"]}';
    const res = runParser(input);
    assertInvariants('Test 9', res);

    // Expected exact order: token, anomaly, token, suggestions, done.
    const types = res.events.map((e) => e.type);
    // Collapse consecutive token events for robustness — impl may emit per char.
    const collapsed: string[] = [];
    for (const t of types) {
      if (t === 'token' && collapsed[collapsed.length - 1] === 'token') continue;
      collapsed.push(t);
    }
    assert.deepStrictEqual(collapsed, ['token', 'anomaly', 'token', 'suggestions', 'done']);
  });

  // -------------------------------------------------------------------------
  // Test 10 — Tag with escaped quotes. Edge rule: impl may support exact value
  // with embedded quotes OR drop the tag gracefully — but must not crash.
  // -------------------------------------------------------------------------
  runCase('Test 10: tag with escaped quotes (graceful)', () => {
    const input = 'x [ANOMALY: fieldName="A" value="B\\"C"] y\n\n{"suggestions":["q"]}';
    // Must not throw.
    const res = runParser(input);
    assertInvariants('Test 10', res);

    // Either the tag parses (anomaly emitted) OR is dropped silently. Both OK.
    const anomalies = res.events.filter(
      (e): e is Extract<StreamParserEvent, { type: 'anomaly' }> => e.type === 'anomaly',
    );
    assert.ok(anomalies.length <= 1, 'Test 10: at most one anomaly event');
    // If parsed, fieldName must be A. Value may be anything the regex captures.
    if (anomalies.length === 1) {
      assert.strictEqual(anomalies[0]!.data.fieldName, 'A');
    }
    // Regardless, token text MUST NOT contain `[ANOMALY`.
    assert.ok(!res.tokenText.includes('[ANOMALY'));
  });

  // -------------------------------------------------------------------------
  // Test 11 — compile-time fence at top of file (see _typecheck above).
  // Nothing to do at runtime; logging a PASS keeps the count >=11 visible.
  // -------------------------------------------------------------------------
  runCase('Test 11: StreamParserEvent union includes error variant (compile-time)', () => {
    // If the file compiled and ran, the union accepts the error variant.
    assert.strictEqual(_typecheck.type, 'error');
  });

  if (failures > 0) {
    console.error(`[test] FAIL — ${failures} case(s) failed`);
    process.exit(1);
  }
  console.log('[test] All StreamParser cases passed.');
  process.exit(0);
}

main().catch((err) => {
  console.error('[test] Fatal:', err);
  process.exit(1);
});
