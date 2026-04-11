/**
 * Phase 2 shared context types.
 *
 * These three interfaces — SchemaContext, LiveDataContext, PulseContext — are
 * produced by the three Tableau services (metadataService, vizqlService,
 * pulseService) and consumed by the Phase 3 Context Assembler, which merges
 * them into a single CopilotContext.
 *
 * Per CLAUDE.md ground rules that Phase 2 services must honor (and therefore
 * these types must enable):
 *   - VizQL caps rows at 500 (LiveDataContext.rows.length <= 500)
 *   - VizQL always requests that field captions be interpreted as field names
 *     (runtime flag belongs in 02-03 vizqlService, not in this types file)
 *   - Pulse degrades gracefully on empty metrics (PulseContext can be empty)
 */

/** One logical field inside a Tableau datasource, per Metadata API GraphQL shape. */
export interface SchemaField {
  readonly name: string;
  readonly caption: string;
  readonly dataType: string;
  readonly description: string;
  /** Upstream lineage — fully-qualified table/column path(s) if known. */
  readonly upstreamLineage: readonly string[];
}

/** Worksheet + its connected datasource LUIDs, per Metadata API workbook query. */
export interface WorksheetMetadata {
  readonly name: string;
  readonly luid: string;
  readonly connectedDatasourceLuids: readonly string[];
}

/** Workbook-level metadata returned when querying by workbook LUID. */
export interface WorkbookMetadata {
  readonly luid: string;
  readonly name: string;
  readonly worksheets: readonly WorksheetMetadata[];
}

/**
 * Output of metadataService. Covers both query modes:
 *  - byDatasource: populates `datasources`
 *  - byWorkbook:   populates `workbook` AND `datasources` for each connected one
 */
export interface SchemaContext {
  /** Keyed by datasource LUID. Empty object if only a workbook query was run with no resolved datasources. */
  readonly datasources: Readonly<Record<string, readonly SchemaField[]>>;
  /** Present only when the service was called with a workbook LUID. */
  readonly workbook?: WorkbookMetadata;
}

/** One filter applied to a VizQL Data Service query. Shape matches VDS request body. */
export interface VizqlFilter {
  readonly field: string;
  /** VDS supports quantitative/categorical/set/etc. — we keep it open but typed as a string literal union at call sites. */
  readonly filterType: 'SET' | 'QUANTITATIVE_DATE' | 'QUANTITATIVE_NUMERICAL' | 'MATCH' | 'TOP';
  readonly values: readonly (string | number | boolean)[];
}

/**
 * Output of vizqlService. TAPI-06: typed LiveDataContext.
 * TAPI-03 enforcement: rows.length MUST be <= 500. Enforce at service boundary.
 */
export interface LiveDataContext {
  readonly datasourceLuid: string;
  readonly fields: readonly string[];
  readonly filters: readonly VizqlFilter[];
  /** Row records — keys are field captions (vizqlService always requests caption-as-name interpretation). */
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  /** Which transport the service actually used for this query. */
  readonly transport: 'sse' | 'json';
  /** Server-side total row count if known (before the 500 cap). Undefined if the API didn't return it. */
  readonly totalRows?: number;
}

/** One Pulse metric definition, as returned by Pulse REST /metric-definitions. */
export interface PulseMetricDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly datasourceLuid: string;
}

/** One Pulse AI insight bundle associated with a metric. */
export interface PulseInsightBundle {
  readonly metricId: string;
  readonly bundleId: string;
  /** The insight types inside the bundle — e.g. 'ban', 'trend', 'current-period'. */
  readonly insightTypes: readonly string[];
  /** Short summary text suitable for context assembly. Full detail is dropped to keep tokens low. */
  readonly summary: string;
}

/** Per-insight-type thumbs up / thumbs down, used to weight Claude's emphasis. */
export interface InsightFeedbackMetadata {
  readonly insightType: string;
  readonly thumbsUp: number;
  readonly thumbsDown: number;
}

/**
 * Output of pulseService. TAPI-10 graceful degradation requires that a valid
 * PulseContext can be constructed with empty arrays and hasMetrics=false when
 * the datasource has no Pulse metrics — do NOT throw in that case.
 */
export interface PulseContext {
  readonly datasourceLuid: string;
  readonly metricDefinitions: readonly PulseMetricDefinition[];
  readonly insightBundles: readonly PulseInsightBundle[];
  readonly feedback: readonly InsightFeedbackMetadata[];
  /** False when no Pulse metrics exist for the datasource — consumers use this to render a skip note. */
  readonly hasMetrics: boolean;
}
