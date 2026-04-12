/**
 * System Prompt Builder — D-13, D-14, D-15.
 *
 * Produces the Claude system prompt from a CopilotContext on every /chat
 * request (stateless per D-12). Returns Anthropic content blocks so the
 * caller can feed them directly to anthropic.messages.stream({ system: [...] }).
 *
 * The single cache_control: { type: 'ephemeral' } breakpoint sits on the
 * Schema block (D-14). Anthropic's cache includes everything up to AND
 * including the marked block, so Role + Contract + Schema all share the
 * same cache breakpoint. Pulse + Live Data ride as the uncached suffix,
 * which is exactly what we want because they change per turn.
 *
 * Dashboard state does NOT live here — see buildUserTurn() for the D-15
 * user-turn preamble.
 */
import type { CopilotContext, DashboardState } from '../types/copilot.js';
import type {
  SchemaField,
  PulseContext,
  LiveDataContext,
  PulseInsightBundle,
} from '../types/tableau.js';

/**
 * One Anthropic `system` content block. Matches the shape Anthropic's SDK
 * accepts for `anthropic.messages.stream({ system: [...] })`. We keep the
 * shape minimal so we do not depend on the SDK at build time — Plan 03-05
 * will import these into the real Anthropic call site.
 */
export interface AnthropicContentBlock {
  readonly type: 'text';
  readonly text: string;
  readonly cache_control?: { type: 'ephemeral' };
}

/**
 * D-13: Build the full system prompt as an ordered array of content blocks.
 * Section order is load-bearing for Claude's adherence to the output
 * contract and for prompt cache breakpoints. Do NOT reorder.
 */
export function buildSystemPrompt(context: CopilotContext): AnthropicContentBlock[] {
  const role = buildRoleBlock();
  const contract = buildOutputContractBlock();
  const schema = buildSchemaBlock(context);
  const pulse = buildPulseBlock(context);
  const liveData = buildLiveDataBlock(context);

  // D-14: cache marker on the Schema block. Anthropic's cache includes
  // EVERYTHING up to and including the marked block, so Role + Contract +
  // Schema all share the same cache breakpoint. Pulse + Live Data ride as
  // the uncached suffix.
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
  // Every rule below is INVIOLABLE. Do not soften the language. Phase 4's
  // mark highlighter hinges on the anomaly tag format being exact, and the
  // suggestion chips hinge on the trailing JSON being exact.
  return `# Output Contract
You MUST follow every rule below on every response.

1. Use the exact field captions from the Schema section below. Never invent field names.
2. Flag anomalies inline using this exact literal format: [ANOMALY: fieldName="x" value="y"] — one tag per anomaly, inline in the narrative, at the point you cite it.
3. Build on the Pulse insights without repeating them verbatim — reference them, extend them, correlate them across datasources. Do not repeat Pulse summaries word-for-word.
4. Your narrative MUST be no more than 3 paragraphs total.
5. End your response with exactly this JSON, on its own line, after the narrative: {"suggestions": ["q1", "q2", "q3"]} — exactly three follow-up questions, no more, no less.
6. Do not include code fences, preambles, meta-commentary, or apologies. The narrative IS the response.
`;
}

function buildSchemaBlock(context: CopilotContext): string {
  const lines: string[] = ['# Schema'];
  const entries = Object.entries(context.schema.datasources);
  if (entries.length === 0) {
    lines.push('');
    lines.push('(no schema resolved — narrative will be constrained)');
    return lines.join('\n') + '\n';
  }
  for (const [luid, fields] of entries) {
    lines.push('');
    lines.push(`## Datasource ${luid}`);
    lines.push('| caption | dataType | description |');
    lines.push('| --- | --- | --- |');
    for (const f of fields) {
      lines.push(renderSchemaFieldRow(f));
      if (f.upstreamLineage.length > 0) {
        lines.push(`  lineage: ${f.upstreamLineage.join(' > ')}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function renderSchemaFieldRow(f: SchemaField): string {
  // Escape markdown table pipe characters and collapse newlines so a rogue
  // description can't shred the table structure (T-03-03-03 mitigation).
  const desc = (f.description || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  const caption = f.caption.replace(/\|/g, '\\|');
  const dataType = f.dataType.replace(/\|/g, '\\|');
  return `| ${caption} | ${dataType} | ${desc} |`;
}

function buildPulseBlock(context: CopilotContext): string {
  const lines: string[] = ['# Pulse'];
  if (context.pulse.length === 0) {
    lines.push('');
    lines.push('(no pulse context assembled)');
    return lines.join('\n') + '\n';
  }
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
    const top = selectTopInsightBundles(p, 3);
    for (const bundle of top) {
      lines.push(`  insight: ${bundle.summary}`);
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Weight each insight bundle by the max `thumbsUp - thumbsDown` among the
 * feedback rows whose insightType appears in the bundle. Sort descending,
 * return the top N. Stable: equal-weight bundles preserve array order, so
 * fixture determinism is preserved.
 */
function selectTopInsightBundles(p: PulseContext, n: number): PulseInsightBundle[] {
  const weighted = p.insightBundles.map((b, idx) => {
    let weight = 0;
    for (const fb of p.feedback) {
      if (b.insightTypes.includes(fb.insightType)) {
        const w = fb.thumbsUp - fb.thumbsDown;
        if (w > weight) weight = w;
      }
    }
    // Also consider the negative case — a bundle with only thumbs-down should
    // sort below a zero-weight bundle. Recompute as max over all matching
    // feedback rows, allowing negatives.
    let signedWeight = Number.NEGATIVE_INFINITY;
    for (const fb of p.feedback) {
      if (b.insightTypes.includes(fb.insightType)) {
        const w = fb.thumbsUp - fb.thumbsDown;
        if (w > signedWeight) signedWeight = w;
      }
    }
    if (signedWeight === Number.NEGATIVE_INFINITY) signedWeight = 0;
    return { bundle: b, weight: signedWeight, idx };
  });
  weighted.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.idx - b.idx; // stable on equal weight
  });
  return weighted.slice(0, n).map((w) => w.bundle);
}

function buildLiveDataBlock(context: CopilotContext): string {
  const lines: string[] = ['# Live Data'];
  if (context.liveData.length === 0) {
    lines.push('');
    lines.push('(no live data assembled)');
    return lines.join('\n') + '\n';
  }
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
 * Preserves system-prompt cacheability across turns in a session because the
 * system prompt is identical turn-to-turn for a given schema.
 *
 * Output shape:
 *   <dashboard_state>
 *   workbook: {workbookName}
 *   worksheet: {worksheetName}
 *   selected_marks: Region=West, ...
 *   active_filters: Year=[2025,2026]; ...
 *   </dashboard_state>
 *
 *   <question>{question}</question>
 *
 * Empty arrays render as the literal `none` so Claude has unambiguous signal.
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
