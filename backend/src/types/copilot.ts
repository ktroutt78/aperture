/**
 * Phase 3 Context Assembler + Claude types.
 *
 * CopilotContext is the merge of the three Phase 2 typed context envelopes
 * (SchemaContext, LiveDataContext[], PulseContext[]) plus the per-service
 * observability shape that Phase 4's ContextBadge consumes.
 *
 * servicesFired is a discriminated union per service (D-05). Do NOT flatten
 * it to a string enum — Phase 4 reads each service's status shape directly.
 */
import type {
  SchemaContext,
  LiveDataContext,
  PulseContext,
  WorkbookMetadata,
} from './tableau.js';

/**
 * Per-service observability. Phase 4 renders ContextBadge from this shape.
 * Exact wording locked by D-05 — do not rename fields.
 */
export type ServicesFired = {
  metadata:
    | { status: 'ok'; datasources: number }
    | { status: 'partial'; ok: number; failed: number; failedLuids: readonly string[] }
    | { status: 'error'; reason: string };
  vizql:
    | { status: 'ok'; rows: number }
    | { status: 'empty' }
    | { status: 'error'; reason: string };
  pulse:
    | { status: 'ok'; metricCount: number }
    | { status: 'empty' }
    | { status: 'error'; reason: string };
  assemblyMs: number;
  contextChars: number; // pre-truncation char count
  truncated: boolean;
};

/**
 * Dashboard state the extension ships on every /chat turn. Per D-15 this is
 * NOT part of the system prompt — it is wrapped into the user-turn preamble as
 * <dashboard_state>...</dashboard_state>\n<question>...</question>.
 */
export interface SelectedMark {
  readonly field: string;
  readonly value: string;
}

export interface ActiveFilter {
  readonly field: string;
  readonly values: readonly string[];
}

export interface DashboardState {
  readonly workbookName: string;
  readonly worksheetName: string;
  readonly selectedMarks: readonly SelectedMark[];
  readonly activeFilters: readonly ActiveFilter[];
}

/**
 * POST /context and POST /chat both accept this body (chat adds `question` +
 * `messages`). datasourceLuids drives the fan-out.
 */
export interface CopilotContextRequest {
  readonly workbookName: string;
  readonly worksheetName: string;
  readonly datasourceLuids: readonly string[];
  readonly selectedMarks: readonly SelectedMark[];
  readonly activeFilters: readonly ActiveFilter[];
}

/** Anthropic Messages API turn, client-held (D-12). Roles locked to user/assistant. */
export interface ChatMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

/**
 * The merged envelope. schema is the single SchemaContext produced by the
 * parallel fan-out, while liveData and pulse are arrays keyed by datasource
 * LUID (one entry per LUID in the original request, possibly empty).
 */
export interface CopilotContext {
  readonly request: CopilotContextRequest;
  readonly schema: SchemaContext;
  readonly liveData: readonly LiveDataContext[];
  readonly pulse: readonly PulseContext[];
  readonly servicesFired: ServicesFired;
  /** Present when the request included a workbookLuid upstream. Optional. */
  readonly workbook?: WorkbookMetadata;
}

/** Stable error codes emitted on the SSE `error` event (D-07). Do not rename. */
export type ErrorCode =
  | 'ANTHROPIC_TIMEOUT'
  | 'ANTHROPIC_RATE_LIMITED'
  | 'ANTHROPIC_ERROR'
  | 'CONTEXT_ASSEMBLY_FAILED'
  | 'INTERNAL';
