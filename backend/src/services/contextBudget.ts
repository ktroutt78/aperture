/**
 * Context Budget + Truncator — D-16, D-17.
 *
 * Pure functions. No network. Char-based token estimate with a 12.5% safety
 * margin (D-16). Deterministic truncation in priority order:
 *   data rows > pulse bundles > schema fields (D-17).
 *
 * The char estimate is NOT a token count — it's a fast proxy (chars are
 * cheaper than a network round-trip to Anthropic's countTokens API, which
 * would burn the 2.5s assembly budget). We over-reserve with a 12.5% margin
 * so the char → token conversion slack is always in our favor.
 */
import type { CopilotContext } from '../types/copilot.js';
import type {
  SchemaField,
  PulseContext,
  PulseInsightBundle,
  PulseMetricDefinition,
  InsightFeedbackMetadata,
  LiveDataContext,
  SchemaContext,
} from '../types/tableau.js';
import { createLogger } from '../lib/logger.js';

/**
 * A local, mutable mirror of PulseContext so Step 2 can `shift()` bundles in
 * place without TS rejecting mutations on the exported readonly type.
 */
interface MutablePulseContext {
  datasourceLuid: string;
  metricDefinitions: readonly PulseMetricDefinition[];
  insightBundles: PulseInsightBundle[];
  feedback: readonly InsightFeedbackMetadata[];
  hasMetrics: boolean;
}

// ---------------------------------------------------------------------------
// D-16 constants
// ---------------------------------------------------------------------------
export const TARGET_CHARS = 70_000;
export const SAFETY_MARGIN = 0.125;
export const EFFECTIVE_TARGET: number = Math.floor(TARGET_CHARS * (1 - SAFETY_MARGIN));

// D-17 halve sequence — row caps applied to every LiveDataContext in lockstep.
export const HALVE_SEQUENCE = [500, 250, 125, 62, 31, 15, 7, 0] as const;

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------
const defaultLogger = createLogger({
  pretty: process.env.NODE_ENV !== 'production',
}).child({ module: 'contextBudget' });

export interface TruncationLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
}

export interface TruncateOpts {
  readonly logger?: TruncationLogger;
}

// ---------------------------------------------------------------------------
// Estimator
// ---------------------------------------------------------------------------

/**
 * D-16 char estimate. Counts the chars we actually serialize into the system
 * prompt: schema field captions/dataTypes/descriptions/lineage, live data
 * rows as JSON, pulse metric definitions + insight summaries. Does NOT count
 * wrapper markdown (headers, table separators) — they're noise relative to
 * the 12.5% safety margin.
 */
export function estimateContextChars(context: CopilotContext): number {
  let total = 0;

  // Schema
  for (const fields of Object.values(context.schema.datasources)) {
    for (const f of fields) {
      total += f.caption.length;
      total += f.dataType.length;
      total += f.description.length;
      for (const l of f.upstreamLineage) total += l.length;
    }
  }

  // Live data — rows as JSON + field-name overhead
  for (const ld of context.liveData) {
    for (const row of ld.rows) total += JSON.stringify(row).length;
    for (const fn of ld.fields) total += fn.length;
  }

  // Pulse
  for (const p of context.pulse) {
    for (const m of p.metricDefinitions) {
      total += m.name.length;
      total += m.description.length;
    }
    for (const b of p.insightBundles) {
      total += b.summary.length;
    }
  }

  return total;
}

// ---------------------------------------------------------------------------
// Truncator (D-17)
// ---------------------------------------------------------------------------

/**
 * Truncate a CopilotContext to fit within `target` chars. Returns a new
 * CopilotContext (inputs are readonly — we clone what we mutate).
 *
 * Priority order (D-17):
 *   1. Halve rows across every datasource through HALVE_SEQUENCE in lockstep
 *   2. Drop PulseContext.insightBundles oldest-first, round-robin across
 *      datasources so one isn't gutted while others keep their bundles
 *   3. Schema fields — drop descriptions, then lineage, then whole fields
 *      (halve-and-check per datasource), preserving ≥ 1 field per datasource
 *
 * The `servicesFired.truncated` flag is set to true if ANY step fired.
 * Every step logs counts at info level (never raw content — see T-03-03-05).
 */
export function truncateContext(
  context: CopilotContext,
  target: number = EFFECTIVE_TARGET,
  opts: TruncateOpts = {},
): CopilotContext {
  const log = opts.logger ?? defaultLogger;
  let working: CopilotContext = context;
  let truncated = false;

  // ---- Step 1: halve rows in lockstep across all datasources ----
  if (estimateContextChars(working) > target) {
    let liveData: LiveDataContext[] = working.liveData.map((ld) => ({ ...ld, rows: [...ld.rows] }));
    for (const cap of HALVE_SEQUENCE) {
      const probe: CopilotContext = { ...working, liveData };
      if (estimateContextChars(probe) <= target) break;
      liveData = liveData.map((ld) => ({ ...ld, rows: ld.rows.slice(0, cap) }));
      truncated = true;
      log.info(
        {
          step: 'halve-rows',
          cap,
          datasources: liveData.length,
          rowsPerDs: liveData.map((ld) => ld.rows.length),
        },
        'truncation halved rows',
      );
    }
    working = { ...working, liveData };
  }

  if (estimateContextChars(working) <= target) {
    return finalize(working, truncated);
  }

  // ---- Step 2: drop Pulse bundles FIFO, round-robin ----
  if (working.pulse.some((p) => p.insightBundles.length > 0)) {
    const pulse: MutablePulseContext[] = working.pulse.map((p) => ({
      datasourceLuid: p.datasourceLuid,
      metricDefinitions: p.metricDefinitions,
      insightBundles: [...p.insightBundles],
      feedback: p.feedback,
      hasMetrics: p.hasMetrics,
    }));
    let loopSafety = 10_000;
    while (loopSafety-- > 0) {
      const probe: CopilotContext = { ...working, pulse };
      if (estimateContextChars(probe) <= target) break;
      let dropped = false;
      for (const p of pulse) {
        if (p.insightBundles.length > 0) {
          p.insightBundles.shift(); // FIFO — oldest first
          truncated = true;
          dropped = true;
        }
      }
      if (!dropped) break; // no more bundles to drop anywhere
    }
    log.info(
      {
        step: 'drop-pulse-bundles',
        remaining: pulse.reduce((s, p) => s + p.insightBundles.length, 0),
      },
      'truncation dropped pulse bundles',
    );
    working = { ...working, pulse };
  }

  if (estimateContextChars(working) <= target) {
    return finalize(working, truncated);
  }

  // ---- Step 3: trim schema fields ----
  // 3a: drop descriptions
  const datasources: Record<string, SchemaField[]> = {};
  for (const [luid, fields] of Object.entries(working.schema.datasources)) {
    datasources[luid] = fields.map((f) => ({
      ...f,
      upstreamLineage: [...f.upstreamLineage],
    }));
  }
  for (const luid of Object.keys(datasources)) {
    datasources[luid] = datasources[luid]!.map((f) => ({ ...f, description: '' }));
  }
  truncated = true;
  log.info({ step: 'trim-schema-descriptions' }, 'truncation dropped schema descriptions');

  const schemaAfterDesc: SchemaContext = { ...working.schema, datasources: cloneMap(datasources) };
  if (estimateContextChars({ ...working, schema: schemaAfterDesc }) <= target) {
    return finalize({ ...working, schema: schemaAfterDesc }, truncated);
  }

  // 3b: drop lineage
  for (const luid of Object.keys(datasources)) {
    datasources[luid] = datasources[luid]!.map((f) => ({
      ...f,
      upstreamLineage: [] as readonly string[],
    }));
  }
  log.info({ step: 'trim-schema-lineage' }, 'truncation dropped schema lineage');

  const schemaAfterLineage: SchemaContext = { ...working.schema, datasources: cloneMap(datasources) };
  if (estimateContextChars({ ...working, schema: schemaAfterLineage }) <= target) {
    return finalize({ ...working, schema: schemaAfterLineage }, truncated);
  }

  // 3c: drop whole fields, halve-per-datasource, keep ≥1 per datasource
  let safety = 200;
  while (safety-- > 0) {
    const probe: CopilotContext = {
      ...working,
      schema: { ...working.schema, datasources: cloneMap(datasources) },
    };
    if (estimateContextChars(probe) <= target) break;
    let dropped = false;
    for (const luid of Object.keys(datasources)) {
      const current = datasources[luid]!;
      if (current.length > 1) {
        const keep = Math.max(1, Math.floor(current.length / 2));
        datasources[luid] = current.slice(0, keep);
        dropped = true;
      }
    }
    if (!dropped) break; // everyone is down to 1 field, cannot trim further
  }
  log.info(
    {
      step: 'trim-schema-fields-whole',
      totals: Object.fromEntries(
        Object.entries(datasources).map(([k, v]) => [k, v.length]),
      ),
    },
    'truncation trimmed whole schema fields',
  );

  return finalize(
    { ...working, schema: { ...working.schema, datasources: cloneMap(datasources) } },
    truncated,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneMap(
  src: Record<string, readonly SchemaField[]>,
): Record<string, readonly SchemaField[]> {
  const out: Record<string, readonly SchemaField[]> = {};
  for (const [k, v] of Object.entries(src)) out[k] = v;
  return out;
}

function finalize(ctx: CopilotContext, truncated: boolean): CopilotContext {
  if (!truncated) return ctx;
  return {
    ...ctx,
    servicesFired: { ...ctx.servicesFired, truncated: true },
  };
}
