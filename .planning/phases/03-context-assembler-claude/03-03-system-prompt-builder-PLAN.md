---
phase: 03-context-assembler-claude
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/src/services/systemPromptBuilder.ts
  - backend/src/services/contextBudget.ts
  - backend/src/services/__tests__/systemPromptBuilder.test.ts
  - backend/src/services/__tests__/contextBudget.test.ts
  - backend/package.json
autonomous: true
requirements: [CTX-03, CTX-04, CTX-05, CTX-06, CTX-07, CTX-08, CTX-09]
tags: [phase-3, prompt, truncation, token-budget, offline-test, wave-1]

must_haves:
  truths:
    - "buildSystemPrompt produces a prompt with sections in the exact D-13 order: Role, Output Contract, Schema block, Pulse block, Live data block"
    - "The system prompt's Output Contract block literally forbids repeating Pulse verbatim, enforces ≤ 3 paragraphs, enforces exactly 3 suggested questions, and literally describes the [ANOMALY: fieldName=\"x\" value=\"y\"] tag format"
    - "Anthropic prompt caching is marked via cache_control: { type: 'ephemeral' } at the end of the Schema block (D-14)"
    - "Dashboard state is NOT in the system prompt; it is wrapped into the user-turn preamble as <dashboard_state>...</dashboard_state>\\n<question>...</question> (D-15)"
    - "estimateContextChars counts chars across Schema, Pulse, LiveData, messages, and safety margin (D-16: 12.5% margin, 70k target)"
    - "truncateContext applies the D-17 algorithm in order: halve rows per datasource (500→250→125→62→31→15→7→0), drop pulse bundles FIFO, trim schema fields (description → lineage → whole fields, keep ≥1 per datasource); sets truncated: true; logs counts"
    - "Offline unit tests pass deterministically with fixed fixtures (including a >70k-char fixture)"
  artifacts:
    - path: "backend/src/services/systemPromptBuilder.ts"
      provides: "buildSystemPrompt(context) → { blocks: AnthropicContentBlock[] }, buildUserTurn(state, question) → string"
      contains: "buildSystemPrompt"
    - path: "backend/src/services/contextBudget.ts"
      provides: "estimateContextChars(context), truncateContext(context, targetChars) → CopilotContext"
      contains: "truncateContext"
    - path: "backend/src/services/__tests__/systemPromptBuilder.test.ts"
      provides: "Offline tests for section order, cache marker, output contract literal strings, user-turn wrapping"
      contains: "systemPromptBuilder"
    - path: "backend/src/services/__tests__/contextBudget.test.ts"
      provides: "Offline tests for the truncation algorithm using a fixture >70k chars"
      contains: "truncateContext"
  key_links:
    - from: "backend/src/services/systemPromptBuilder.ts"
      to: "backend/src/types/copilot.ts"
      via: "import type { CopilotContext, DashboardState }"
      pattern: "CopilotContext"
    - from: "backend/src/services/contextBudget.ts"
      to: "backend/src/types/copilot.ts"
      via: "import type { CopilotContext }"
      pattern: "truncateContext"
---

<objective>
Implement the offline primitives that shape every Claude request: the **System Prompt Builder** (D-13, D-14, D-15 + output contract content for CTX-04/05/06/07/08/09), and the **Context Budget + Truncator** (D-16, D-17 for CTX-03). Both are pure functions with fixture-based offline tests — no network, no Anthropic SDK.

Purpose: The inviolable output contract (anomaly tags + suggestions JSON + ≤ 3 paragraphs + real field captions + build-on-pulse-without-repeating) lives in the system prompt literal strings. Phase 4's entire demo hinges on Claude obeying this contract. Likewise, the 3s assembly budget hinges on deterministic truncation — no network round-trips, no probabilistic behavior.

Output: Two source files, two test files, two npm scripts, zero new runtime dependencies.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/types/tableau.ts
@backend/src/services/__tests__/pulseService.empty.test.ts
@CLAUDE.md
</context>

<tasks>

<task type="auto" tdd="true">
  <name>Task 1: Build systemPromptBuilder.ts (section order, output contract, cache marker, user-turn wrapper) with offline tests</name>
  <files>backend/src/services/systemPromptBuilder.ts, backend/src/services/__tests__/systemPromptBuilder.test.ts, backend/package.json</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-13 section order, D-14 cache breakpoint, D-15 user-turn preamble — LOCKED)
    - backend/src/types/copilot.ts (CopilotContext, DashboardState shape — from Plan 03-01)
    - backend/src/types/tableau.ts (SchemaField, PulseMetricDefinition, PulseInsightBundle, InsightFeedbackMetadata — to render into the prompt)
    - CLAUDE.md ("Claude API" section — model lock, output contract rules)
    - backend/src/services/__tests__/pulseService.empty.test.ts (test style reference)
  </read_first>
  <behavior>
    Test cases for systemPromptBuilder.test.ts (write RED first):

    1. **Section order** — buildSystemPrompt returns an array of Anthropic content blocks where the text, joined in order, contains these headers in this order and no other order:
       `# Role`, `# Output Contract`, `# Schema`, `# Pulse`, `# Live Data`.
       Assert: indexOf('# Role') < indexOf('# Output Contract') < indexOf('# Schema') < indexOf('# Pulse') < indexOf('# Live Data').

    2. **Output contract literal strings** — the contract block text must contain every one of:
       - `[ANOMALY: fieldName="x" value="y"]` (the exact literal template)
       - `{"suggestions"` (the exact opening of the trailing JSON)
       - `exactly three` (follow-up questions count)
       - `no more than 3 paragraphs` OR `at most 3 paragraphs` OR `≤ 3 paragraphs`
       - `do not repeat` (build-on-pulse-without-repeating)
       - `use the exact field captions` OR `cite real field captions` (CTX-05)
       - The string `claude-sonnet-4-20250514` MUST NOT appear in the system prompt (model lock is a config concern, not a prompt concern)

    3. **Cache marker** — the block immediately after the Schema block's full text has `cache_control: { type: 'ephemeral' }`. Assert via: find the block whose text ends with the Schema content, confirm it has the field; the next block (Pulse) must NOT have cache_control.

    4. **Schema rendering** — given a fixture CopilotContext with 2 datasources and 3 fields each, the Schema block text contains each field's `caption`, `dataType`, and `description`, rendered as a Markdown table row per field, with one section per datasource labeled by its identifier.

    5. **Pulse rendering with hasMetrics=false** — given a fixture with one datasource whose PulseContext has `hasMetrics: false`, the Pulse block contains that datasource's label followed by the literal `(no metrics configured)` so Claude knows it's intentional.

    6. **Pulse rendering with hasMetrics=true** — given a fixture with one datasource that has 2 metric definitions and 5 insight bundles, the Pulse block includes metric names and at most 3 top-weighted insight summaries (weighted by InsightFeedbackMetadata thumbsUp - thumbsDown per insight type).

    7. **Live data rendering** — given a fixture with 3 LiveDataContext entries of 10 rows each, the Live Data block renders each datasource in a clearly labeled section with the rows as compact JSON.

    8. **User-turn wrapper** — buildUserTurn({ workbookName, worksheetName, selectedMarks, activeFilters }, question) returns a string that contains, in order:
       - `<dashboard_state>` opening tag on its own line
       - `workbook: {workbookName}`
       - `worksheet: {worksheetName}`
       - `selected_marks:` line with each mark as `field=value`
       - `active_filters:` line with each filter as `field=[v1,v2]`
       - `</dashboard_state>` closing tag
       - blank line
       - `<question>{question}</question>`

    9. **User-turn empty arrays** — selectedMarks=[] and activeFilters=[] render as `selected_marks: none` and `active_filters: none` (not empty lines), so Claude has unambiguous signal.
  </behavior>
  <action>
**Step A — Write `backend/src/services/__tests__/systemPromptBuilder.test.ts` first (RED).**

Follow the `pulseService.empty.test.ts` style: pure Node `assert`, `async function main()`, numbered test cases, process.exit at end.

Build fixture CopilotContext objects inline — do NOT import from fixture files. Keep fixtures small enough to reason about (2 datasources, 3 fields each, 2 pulse metrics, 5 rows each for live data). Import the Plan 03-01 types: `import type { CopilotContext, DashboardState } from '../../types/copilot.js';`

**Step B — Confirm test file fails to import systemPromptBuilder (RED).**

**Step C — Write `backend/src/services/systemPromptBuilder.ts` (GREEN).**

```typescript
/**
 * System Prompt Builder — D-13, D-14, D-15.
 *
 * Produces the Claude system prompt from a CopilotContext on every /chat
 * request (stateless per D-12). Returns Anthropic content blocks so the
 * caller can feed them directly to anthropic.messages.stream({ system: [...] }).
 *
 * The single cache_control: { type: 'ephemeral' } breakpoint sits at the end
 * of the Schema block. Role + Output Contract + Schema is the cacheable
 * prefix; Pulse + Live Data ride as the uncached suffix.
 *
 * Dashboard state does NOT live here — see buildUserTurn() for the user-turn
 * preamble per D-15.
 */
import type { CopilotContext, DashboardState } from '../types/copilot.js';
import type { SchemaField, PulseContext, LiveDataContext } from '../types/tableau.js';

export interface AnthropicContentBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

export function buildSystemPrompt(context: CopilotContext): AnthropicContentBlock[] {
  const role = buildRoleBlock();
  const contract = buildOutputContractBlock();
  const schema = buildSchemaBlock(context);
  const pulse = buildPulseBlock(context);
  const liveData = buildLiveDataBlock(context);

  // D-14: cache marker at the end of the Schema block. Anthropic cache includes
  // EVERYTHING up to and including the marked block, so Role + Contract + Schema
  // all share the same cache breakpoint.
  return [
    { type: 'text', text: role },
    { type: 'text', text: contract },
    { type: 'text', text: schema, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: pulse },
    { type: 'text', text: liveData },
  ];
}

function buildRoleBlock(): string {
  return `# Role
You are Aperture, an analytics co-pilot embedded inside a Tableau dashboard. You fuse three Tableau APIs (Metadata, VizQL Data Service, Pulse) into a single schema-aware narrative. Your job is to produce executive-readable insight grounded in the exact fields and data the user sees on-screen.
`;
}

function buildOutputContractBlock(): string {
  // Every rule is INVIOLABLE. Do not soften the language. Phase 4's mark
  // highlighter hinges on the anomaly tag format being exact.
  return `# Output Contract
You MUST follow every rule below on every response.

1. Use the exact field captions from the Schema section below. Never invent field names.
2. Flag anomalies inline using this exact literal format: [ANOMALY: fieldName="x" value="y"] — one tag per anomaly, inline in the narrative, at the point you cite it.
3. Build on the Pulse insights without repeating them verbatim — reference them, extend them, correlate them across datasources.
4. Your narrative MUST be no more than 3 paragraphs total.
5. End your response with exactly this JSON, on its own line, after the narrative: {"suggestions": ["q1", "q2", "q3"]} — exactly three follow-up questions, no more, no less.
6. Do not include code fences, preambles, meta-commentary, or apologies. The narrative IS the response.
`;
}

function buildSchemaBlock(context: CopilotContext): string {
  const lines: string[] = ['# Schema'];
  const entries = Object.entries(context.schema.datasources);
  if (entries.length === 0) {
    lines.push('(no schema resolved — narrative will be constrained)');
  }
  for (const [luid, fields] of entries) {
    lines.push('');
    lines.push(`## Datasource ${luid}`);
    lines.push('| caption | dataType | description |');
    lines.push('| --- | --- | --- |');
    for (const f of fields) {
      const desc = (f.description || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      lines.push(`| ${f.caption} | ${f.dataType} | ${desc} |`);
      if (f.upstreamLineage && f.upstreamLineage.length > 0) {
        lines.push(`  lineage: ${f.upstreamLineage.join(' > ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function buildPulseBlock(context: CopilotContext): string {
  const lines: string[] = ['# Pulse'];
  for (const p of context.pulse) {
    lines.push('');
    lines.push(`## Datasource ${p.datasourceLuid}`);
    if (!p.hasMetrics || p.metricDefinitions.length === 0) {
      lines.push('(no metrics configured)');
      continue;
    }
    for (const m of p.metricDefinitions) {
      lines.push(`- metric: ${m.name} — ${m.description}`);
    }
    // Top-3 by feedback weight
    const weighted = p.insightBundles.map((b) => {
      const fb = p.feedback.find((f) => b.insightTypes.includes(f.insightType));
      const weight = fb ? fb.thumbsUp - fb.thumbsDown : 0;
      return { bundle: b, weight };
    });
    weighted.sort((a, b) => b.weight - a.weight);
    for (const { bundle } of weighted.slice(0, 3)) {
      lines.push(`  insight: ${bundle.summary}`);
    }
  }
  return lines.join('\n') + '\n';
}

function buildLiveDataBlock(context: CopilotContext): string {
  const lines: string[] = ['# Live Data'];
  for (const ld of context.liveData) {
    lines.push('');
    lines.push(`## Datasource ${ld.datasourceLuid}`);
    lines.push(`fields: ${ld.fields.join(', ')}`);
    lines.push(`rows (${ld.rows.length}):`);
    for (const row of ld.rows) {
      lines.push(JSON.stringify(row));
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * D-15: Dashboard state wraps every user-turn content. NOT in system prompt.
 * Preserves system-prompt cacheability across turns in a session.
 */
export function buildUserTurn(state: DashboardState, question: string): string {
  const marks =
    state.selectedMarks.length === 0
      ? 'none'
      : state.selectedMarks.map((m) => `${m.field}=${m.value}`).join(', ');
  const filters =
    state.activeFilters.length === 0
      ? 'none'
      : state.activeFilters.map((f) => `${f.field}=[${f.values.join(',')}]`).join('; ');
  return [
    '<dashboard_state>',
    `workbook: ${state.workbookName}`,
    `worksheet: ${state.worksheetName}`,
    `selected_marks: ${marks}`,
    `active_filters: ${filters}`,
    '</dashboard_state>',
    '',
    `<question>${question}</question>`,
  ].join('\n');
}
```

**Step D — Run the test, confirm GREEN.**

**Step E — Add npm script:** edit `backend/package.json` to add `"smoke:systemprompt": "tsx src/services/__tests__/systemPromptBuilder.test.ts"` after `smoke:streamparser`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:systemprompt</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/systemPromptBuilder.ts`
    - File exists: `test -f backend/src/services/__tests__/systemPromptBuilder.test.ts`
    - `grep -q "export function buildSystemPrompt" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "export function buildUserTurn" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "cache_control: { type: 'ephemeral' }" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "# Role" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "# Output Contract" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "# Schema" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "# Pulse" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "# Live Data" backend/src/services/systemPromptBuilder.ts`
    - `grep -q '\[ANOMALY: fieldName="x" value="y"\]' backend/src/services/systemPromptBuilder.ts`
    - `grep -q '{"suggestions":' backend/src/services/systemPromptBuilder.ts`
    - `grep -q "exactly three" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "no more than 3 paragraphs" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "<dashboard_state>" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "<question>" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "(no metrics configured)" backend/src/services/systemPromptBuilder.ts`
    - `grep -q "claude-sonnet-4-20250514" backend/src/services/systemPromptBuilder.ts` returns NO matches (model lock is in claudeService, not here)
    - `grep -q "smoke:systemprompt" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:systemprompt` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>buildSystemPrompt produces blocks in D-13 order with D-14 cache marker; buildUserTurn produces D-15 preamble; all output contract literals present; offline tests pass.</done>
</task>

<task type="auto" tdd="true">
  <name>Task 2: Build contextBudget.ts (char-based estimator + D-17 truncation algorithm) with offline tests using a >70k-char fixture</name>
  <files>backend/src/services/contextBudget.ts, backend/src/services/__tests__/contextBudget.test.ts, backend/package.json</files>
  <read_first>
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-16 budget math — 70k target, 12.5% margin; D-17 algorithm — halve rows 500→250→125→62→31→15→7→0, then drop Pulse bundles FIFO, then trim schema fields description→lineage→whole fields keeping ≥1 per datasource)
    - backend/src/types/copilot.ts (CopilotContext shape)
    - backend/src/types/tableau.ts (LiveDataContext.rows, PulseContext.insightBundles, SchemaField shape)
  </read_first>
  <behavior>
    Test cases for contextBudget.test.ts (RED first):

    1. **estimateContextChars counts all sections** — given a CopilotContext with known sizes (schema fields with known description lengths, live data rows with known JSON lengths, pulse bundles with known summary lengths), the returned estimate equals the sum of serialized chars across schema + live data + pulse + messages (if provided). Within 1% tolerance.

    2. **Under-budget context is unchanged** — input a CopilotContext estimated at 10k chars, call truncateContext with target 70k. Output equals input deeply, `truncated: false`.

    3. **Live data halving** — input with 2 datasources, each with 500 rows, estimated total 100k chars. truncateContext should halve to 250 rows per datasource first, re-estimate, and halve again as needed. Final `servicesFired.truncated === true`.

    4. **Halve sequence exact** — after each halve step, rows counts are in the set {500, 250, 125, 62, 31, 15, 7, 0}. Prove by logging each step's per-datasource row count and asserting against that set.

    5. **Halved equally across datasources** — if input has 3 datasources with 500 rows each, after step 1 all three must have 250 (never 250/500/500 — halving is proportional).

    6. **Pulse bundle FIFO drop** — input with rows already at 0 and still over budget; truncateContext drops pulse.insightBundles[0] first (oldest by position — we treat array order as creation order). Metric definitions and feedback are preserved.

    7. **Schema field trim order** — input huge schema (2 datasources, 100 fields each with long descriptions), rows=0, pulse bundles=0, still over budget. Truncator drops `description` first (sets to empty string or drops the field's description field), then `upstreamLineage`, then whole fields. Minimum 1 field per datasource preserved.

    8. **Minimum-1-field invariant** — even if the fixture forces extreme truncation, every datasource in `truncated.schema.datasources` still has `.length >= 1`.

    9. **truncated: true is set** — whenever ANY trim happened.

    10. **Logging at info level** — truncator uses the module logger. Spy/stub mechanism: inject a logger or capture via pino's `level: 'silent'` workaround. Minimum: the offline test asserts that a `.log` property or a mock-logger was called with `{ step: 'halve-rows' | 'drop-pulse-bundles' | 'trim-schema-fields', ... }`.
  </behavior>
  <action>
**Step A — Write `backend/src/services/__tests__/contextBudget.test.ts` (RED).**

Construct a `buildFixture(size: 'small' | 'huge')` helper inside the test file that builds a CopilotContext via the Plan 03-01 types. `small` = 10k chars target, `huge` = 100k chars target. Use repeated characters (e.g., `'x'.repeat(200)` for descriptions) so size is deterministic.

Logger mocking: the simplest approach is to pass a custom logger instance into an optional `opts.logger` parameter on `truncateContext` for testing. Export a default that uses `createLogger({...}).child({module:'contextBudget'})` but allow `truncateContext(ctx, target, { logger: mockLogger })`.

**Step B — Confirm RED.**

**Step C — Write `backend/src/services/contextBudget.ts` (GREEN).**

```typescript
/**
 * Context Budget + Truncator — D-16, D-17.
 *
 * Pure functions. No network. Char-based token estimate with 12.5% safety
 * margin (D-16). Deterministic truncation in priority order data rows > pulse
 * bundles > schema fields (D-17).
 */
import type { CopilotContext } from '../types/copilot.js';
import type { LiveDataContext, PulseContext, SchemaContext, SchemaField } from '../types/tableau.js';
import { createLogger } from '../lib/logger.js';

export const TARGET_CHARS = 70_000;
export const SAFETY_MARGIN = 0.125;
export const EFFECTIVE_TARGET = Math.floor(TARGET_CHARS * (1 - SAFETY_MARGIN)); // ~61,250 — leaves headroom for the user turn, messages, system prompt glue

// D-17 step 1: halve rows in this sequence.
export const HALVE_SEQUENCE = [500, 250, 125, 62, 31, 15, 7, 0] as const;

const defaultLogger = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'contextBudget',
});

export interface TruncateOpts {
  logger?: { info: (obj: unknown, msg?: string) => void; warn: (obj: unknown, msg?: string) => void };
}

export function estimateContextChars(context: CopilotContext): number {
  let total = 0;
  // Schema
  for (const fields of Object.values(context.schema.datasources)) {
    for (const f of fields) {
      total += (f.caption?.length ?? 0) + (f.dataType?.length ?? 0) + (f.description?.length ?? 0);
      for (const l of f.upstreamLineage ?? []) total += l.length;
    }
  }
  // Live data
  for (const ld of context.liveData) {
    for (const row of ld.rows) total += JSON.stringify(row).length;
    for (const f of ld.fields) total += f.length;
  }
  // Pulse
  for (const p of context.pulse) {
    for (const m of p.metricDefinitions) total += m.name.length + m.description.length;
    for (const b of p.insightBundles) total += b.summary.length;
  }
  return total;
}

/**
 * Truncate in D-17 priority order. Returns a new CopilotContext (the inputs
 * are readonly). Mutates `servicesFired.truncated` to true if any step ran.
 */
export function truncateContext(
  context: CopilotContext,
  target: number = EFFECTIVE_TARGET,
  opts: TruncateOpts = {},
): CopilotContext {
  const log = opts.logger ?? defaultLogger;
  let working = context;
  let truncated = false;

  // Step 1: halve rows proportionally.
  let liveData = [...working.liveData];
  for (const cap of HALVE_SEQUENCE) {
    if (estimateContextChars({ ...working, liveData }) <= target) break;
    liveData = liveData.map((ld) => ({ ...ld, rows: ld.rows.slice(0, cap) }));
    truncated = true;
    log.info({ step: 'halve-rows', cap, datasources: liveData.length }, 'truncation halved rows');
  }
  working = { ...working, liveData };

  if (estimateContextChars(working) <= target) {
    return finalize(working, truncated);
  }

  // Step 2: drop Pulse bundles FIFO (oldest first — array index 0 first).
  let pulse = working.pulse.map((p) => ({ ...p, insightBundles: [...p.insightBundles] }));
  // Round-robin across datasources so one datasource isn't gutted while others keep their bundles.
  let loopSafety = 10_000;
  while (estimateContextChars({ ...working, pulse }) > target && loopSafety-- > 0) {
    let dropped = false;
    for (const p of pulse) {
      if (p.insightBundles.length > 0) {
        p.insightBundles.shift();
        dropped = true;
        truncated = true;
      }
    }
    if (!dropped) break; // nothing left to drop
  }
  log.info({ step: 'drop-pulse-bundles', remaining: pulse.reduce((s, p) => s + p.insightBundles.length, 0) }, 'truncation dropped pulse bundles');
  working = { ...working, pulse };

  if (estimateContextChars(working) <= target) {
    return finalize(working, truncated);
  }

  // Step 3: trim schema fields. Order: description → lineage → whole fields
  // keeping ≥1 per datasource.
  const datasources: Record<string, SchemaField[]> = {};
  for (const [luid, fields] of Object.entries(working.schema.datasources)) {
    datasources[luid] = fields.map((f) => ({ ...f, upstreamLineage: [...f.upstreamLineage] }));
  }

  // 3a: drop descriptions
  for (const luid of Object.keys(datasources)) {
    datasources[luid] = datasources[luid].map((f) => ({ ...f, description: '' }));
  }
  truncated = true;
  log.info({ step: 'trim-schema-descriptions' }, 'truncation dropped schema descriptions');
  if (estimateContextChars({ ...working, schema: { ...working.schema, datasources } }) <= target) {
    return finalize({ ...working, schema: { ...working.schema, datasources } }, truncated);
  }

  // 3b: drop lineage
  for (const luid of Object.keys(datasources)) {
    datasources[luid] = datasources[luid].map((f) => ({ ...f, upstreamLineage: [] as readonly string[] }));
  }
  log.info({ step: 'trim-schema-lineage' }, 'truncation dropped schema lineage');
  if (estimateContextChars({ ...working, schema: { ...working.schema, datasources } }) <= target) {
    return finalize({ ...working, schema: { ...working.schema, datasources } }, truncated);
  }

  // 3c: drop whole fields keeping ≥1 per datasource (halve-and-check within each ds)
  let safety = 200;
  while (estimateContextChars({ ...working, schema: { ...working.schema, datasources } }) > target && safety-- > 0) {
    let dropped = false;
    for (const luid of Object.keys(datasources)) {
      if (datasources[luid].length > 1) {
        datasources[luid] = datasources[luid].slice(0, Math.max(1, Math.floor(datasources[luid].length / 2)));
        dropped = true;
      }
    }
    if (!dropped) break;
  }
  log.info({ step: 'trim-schema-fields-whole', totals: Object.fromEntries(Object.entries(datasources).map(([k, v]) => [k, v.length])) }, 'truncation trimmed whole schema fields');

  return finalize({ ...working, schema: { ...working.schema, datasources } }, truncated);
}

function finalize(ctx: CopilotContext, truncated: boolean): CopilotContext {
  if (!truncated) return ctx;
  return {
    ...ctx,
    servicesFired: { ...ctx.servicesFired, truncated: true },
  };
}
```

**Step D — Confirm GREEN.**

**Step E — Add npm script:** `"smoke:budget": "tsx src/services/__tests__/contextBudget.test.ts"` after `smoke:systemprompt`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend smoke:budget</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/contextBudget.ts`
    - File exists: `test -f backend/src/services/__tests__/contextBudget.test.ts`
    - `grep -q "export function estimateContextChars" backend/src/services/contextBudget.ts`
    - `grep -q "export function truncateContext" backend/src/services/contextBudget.ts`
    - `grep -q "TARGET_CHARS = 70_000" backend/src/services/contextBudget.ts`
    - `grep -q "SAFETY_MARGIN = 0.125" backend/src/services/contextBudget.ts`
    - `grep -q "HALVE_SEQUENCE = \[500, 250, 125, 62, 31, 15, 7, 0\]" backend/src/services/contextBudget.ts`
    - `grep -q "step: 'halve-rows'" backend/src/services/contextBudget.ts`
    - `grep -q "step: 'drop-pulse-bundles'" backend/src/services/contextBudget.ts`
    - `grep -q "step: 'trim-schema" backend/src/services/contextBudget.ts`
    - `grep -q "smoke:budget" backend/package.json`
    - `pnpm --filter @aperture/backend smoke:budget` exits 0
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>estimateContextChars is deterministic; truncateContext applies D-17 in order; fixture >70k chars gets pulled under target; minimum-1-field invariant holds; npm script wired.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| CopilotContext input → system prompt text | Field captions, pulse summaries, live data rows come from Tableau APIs. Treated as semi-trusted — we wrap Tableau content in markdown sections but never execute it |
| DashboardState input → user turn | `workbookName`, `worksheetName`, `question` originate from the extension. Wrapped in XML semantic boundaries (`<dashboard_state>`, `<question>`) so Claude treats them as data, not instructions |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-03-01 | Injection (prompt) | buildUserTurn XML wrapping | mitigate | D-15 XML semantic boundaries (`<dashboard_state>`, `<question>`) combined with the Output Contract block's "do not include preambles or meta-commentary" rule. Task 1 acceptance criteria grep-enforce both literals are present. |
| T-03-03-02 | Injection (prompt) | Pulse insight text, field captions, row data | mitigate | The system prompt's Output Contract explicitly says "Use the exact field captions from the Schema section below. Never invent field names." Attackers would have to poison Tableau content upstream — out of scope for backend. |
| T-03-03-03 | Injection (markdown table) | Schema field descriptions with `|` chars | mitigate | `buildSchemaBlock` escapes `|` to `\|` and replaces newlines in descriptions, preserving table structure. Task 1 test case 4 verifies the rendering with a field description containing `|`. |
| T-03-03-04 | DoS | Oversized context never returning | mitigate | D-17 truncation has an explicit loop safety counter (`loopSafety-- > 0`) in each step, so pathological inputs terminate. Task 2 test case 8 enforces the minimum-1-field invariant. |
| T-03-03-05 | Information Disclosure | Logging prompt text | accept | Logger calls use count-only objects (`{step, cap, datasources}`) — never the prompt text itself. Phase 1 Pino redact paths already cover auth headers. |

No HIGH threats — this is pure-function offline code.
</threat_model>

<verification>
- `pnpm --filter @aperture/backend smoke:systemprompt` exits 0
- `pnpm --filter @aperture/backend smoke:budget` exits 0
- `pnpm --filter @aperture/backend typecheck` exits 0
- No new runtime dependency added (both files use only stdlib + existing logger)
</verification>

<success_criteria>
- buildSystemPrompt produces D-13 section order with D-14 cache marker
- Output contract literals match every acceptance criteria grep
- buildUserTurn produces D-15 preamble with `<dashboard_state>` and `<question>` tags
- truncateContext reduces any >70k-char CopilotContext below target via D-17 priority order
- Minimum-1-field-per-datasource invariant holds under extreme truncation
- All offline tests pass deterministically (no time-based flakiness, no network)
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-03-SUMMARY.md`
</output>
