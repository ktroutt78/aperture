---
phase: 03-context-assembler-claude
plan: 01
type: execute
wave: 1
depends_on: []
files_modified:
  - backend/src/types/copilot.ts
  - backend/src/services/errors.ts
autonomous: true
requirements: [CTX-02]
tags: [phase-3, types, foundation, copilot-context]

must_haves:
  truths:
    - "A single typed CopilotContext exists that merges SchemaContext + LiveDataContext[] + PulseContext[] into one envelope"
    - "servicesFired is a per-service discriminated union consumable by Phase 4 ContextBadge with no lossy mapping"
    - "CopilotContextRequest type mirrors the /context POST body shape (workbookName, worksheetName, datasourceLuids, selectedMarks, activeFilters)"
    - "ContextAssemblerError and ClaudeServiceError classes exist following the Phase 2 service error pattern"
  artifacts:
    - path: "backend/src/types/copilot.ts"
      provides: "CopilotContext, CopilotContextRequest, ServicesFired discriminated union, ChatMessage, DashboardState"
      contains: "interface CopilotContext"
    - path: "backend/src/services/errors.ts"
      provides: "ContextAssemblerError, ClaudeServiceError"
      contains: "export class ContextAssemblerError"
  key_links:
    - from: "backend/src/types/copilot.ts"
      to: "backend/src/types/tableau.ts"
      via: "import SchemaContext, LiveDataContext, PulseContext"
      pattern: "import type \\{[^}]*SchemaContext"
---

<objective>
Define the foundational type surface for Phase 3: `CopilotContext` (the merge of the three Phase 2 context envelopes), its per-service `servicesFired` discriminated union (D-05), the `/context` request shape, the `ChatMessage` / `DashboardState` types consumed by `/chat`, and the two new service error classes. Every downstream Phase 3 plan imports from these two files — this plan is Wave 1 and has zero runtime dependencies.

Purpose: Eliminate the scavenger hunt. Downstream plans (ContextAssembler, ClaudeService, routes) should receive these types as contracts and never invent ad-hoc shapes.

Output: Two new TypeScript files with no behavior, only types and empty error classes.
</objective>

<execution_context>
@$HOME/.claude/get-shit-done/workflows/execute-plan.md
@$HOME/.claude/get-shit-done/templates/summary.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@.planning/phases/03-context-assembler-claude/03-CONTEXT.md
@backend/src/types/tableau.ts
@backend/src/services/metadataService.ts
@backend/src/services/pulseService.ts

<interfaces>
<!-- Phase 2 types that CopilotContext merges. Executor should import these directly. -->

From backend/src/types/tableau.ts:
```typescript
export interface SchemaField {
  readonly name: string;
  readonly caption: string;
  readonly dataType: string;
  readonly description: string;
  readonly upstreamLineage: readonly string[];
}

export interface WorksheetMetadata {
  readonly name: string;
  readonly luid: string;
  readonly connectedDatasourceLuids: readonly string[];
}

export interface WorkbookMetadata {
  readonly luid: string;
  readonly name: string;
  readonly worksheets: readonly WorksheetMetadata[];
}

export interface SchemaContext {
  readonly datasources: Readonly<Record<string, readonly SchemaField[]>>;
  readonly workbook?: WorkbookMetadata;
}

export interface VizqlFilter {
  readonly field: string;
  readonly filterType: 'SET' | 'QUANTITATIVE_DATE' | 'QUANTITATIVE_NUMERICAL' | 'MATCH' | 'TOP';
  readonly values: readonly (string | number | boolean)[];
}

export interface LiveDataContext {
  readonly datasourceLuid: string;
  readonly fields: readonly string[];
  readonly filters: readonly VizqlFilter[];
  readonly rows: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly transport: 'sse' | 'json';
  readonly totalRows?: number;
}

export interface PulseContext {
  readonly datasourceLuid: string;
  readonly metricDefinitions: readonly PulseMetricDefinition[];
  readonly insightBundles: readonly PulseInsightBundle[];
  readonly feedback: readonly InsightFeedbackMetadata[];
  readonly hasMetrics: boolean;
}
```

Phase 2 service-error pattern (follow verbatim in errors.ts):
```typescript
// From backend/src/services/metadataService.ts:62
export class MetadataServiceError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'MetadataServiceError';
    this.cause = cause;
  }
}
```
</interfaces>
</context>

<tasks>

<task type="auto">
  <name>Task 1: Create backend/src/types/copilot.ts with CopilotContext + supporting types</name>
  <files>backend/src/types/copilot.ts</files>
  <read_first>
    - backend/src/types/tableau.ts (to see the exact SchemaContext, LiveDataContext, PulseContext, WorkbookMetadata shapes we are importing)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (D-05 ServicesFired shape is LOCKED — transcribe it verbatim)
  </read_first>
  <action>
Create `backend/src/types/copilot.ts` with the following contents exactly (do not simplify, do not rename — Phase 4 consumes `servicesFired` verbatim):

```typescript
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
```
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/types/copilot.ts`
    - `grep -q "export type ServicesFired" backend/src/types/copilot.ts`
    - `grep -q "status: 'partial'; ok: number; failed: number; failedLuids: readonly string\[\]" backend/src/types/copilot.ts`
    - `grep -q "status: 'ok'; metricCount: number" backend/src/types/copilot.ts`
    - `grep -q "export interface CopilotContext" backend/src/types/copilot.ts`
    - `grep -q "export interface CopilotContextRequest" backend/src/types/copilot.ts`
    - `grep -q "export interface ChatMessage" backend/src/types/copilot.ts`
    - `grep -q "export interface DashboardState" backend/src/types/copilot.ts`
    - `grep -q "export type ErrorCode" backend/src/types/copilot.ts`
    - `grep -q "ANTHROPIC_TIMEOUT" backend/src/types/copilot.ts`
    - `grep -q "CONTEXT_ASSEMBLY_FAILED" backend/src/types/copilot.ts`
    - `grep -q "from './tableau.js'" backend/src/types/copilot.ts`
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>copilot.ts compiles, every D-05/D-07 shape is present verbatim, no runtime code added.</done>
</task>

<task type="auto">
  <name>Task 2: Create backend/src/services/errors.ts with Phase 3 error classes</name>
  <files>backend/src/services/errors.ts</files>
  <read_first>
    - backend/src/services/metadataService.ts (lines 62–90 — to copy the MetadataServiceError pattern verbatim: name, cause, constructor signature)
    - .planning/phases/03-context-assembler-claude/03-CONTEXT.md (code_context section: "Typed service-specific Error subclass")
  </read_first>
  <action>
Create `backend/src/services/errors.ts` with exactly:

```typescript
/**
 * Phase 3 service error hierarchy. Follows the Phase 2 pattern
 * (MetadataServiceError / VizqlServiceError / PulseServiceError): named class,
 * optional `cause`, no side effects in the constructor.
 */
import type { ErrorCode } from '../types/copilot.js';

export class ContextAssemblerError extends Error {
  readonly cause?: unknown;
  readonly failedLuids: readonly string[];
  constructor(message: string, failedLuids: readonly string[] = [], cause?: unknown) {
    super(message);
    this.name = 'ContextAssemblerError';
    this.failedLuids = failedLuids;
    this.cause = cause;
  }
}

export class ClaudeServiceError extends Error {
  readonly cause?: unknown;
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message);
    this.name = 'ClaudeServiceError';
    this.code = code;
    this.cause = cause;
  }
}
```

Do NOT add logging, do NOT mutate the prototype chain beyond `super(message)`.
  </action>
  <verify>
    <automated>pnpm --filter @aperture/backend typecheck</automated>
  </verify>
  <acceptance_criteria>
    - File exists: `test -f backend/src/services/errors.ts`
    - `grep -q "export class ContextAssemblerError extends Error" backend/src/services/errors.ts`
    - `grep -q "export class ClaudeServiceError extends Error" backend/src/services/errors.ts`
    - `grep -q "readonly failedLuids: readonly string\[\]" backend/src/services/errors.ts`
    - `grep -q "readonly code: ErrorCode" backend/src/services/errors.ts`
    - `grep -q "from '../types/copilot.js'" backend/src/services/errors.ts`
    - `pnpm --filter @aperture/backend typecheck` exits 0
  </acceptance_criteria>
  <done>Two error classes exist and compile, importable from downstream plans as `import { ContextAssemblerError, ClaudeServiceError } from '../services/errors.js'`.</done>
</task>

</tasks>

<threat_model>
## Trust Boundaries

| Boundary | Description |
|----------|-------------|
| (none) | Types-only plan; no I/O, no user input, no network, no file system writes at runtime |

## STRIDE Threat Register

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-03-01-01 | Information Disclosure | copilot.ts type names | accept | Type names are not secrets; publishing them in a private repo has zero exposure. No runtime impact. |
| T-03-01-02 | Tampering | errors.ts constructor | accept | No mutable state, no prototype pollution vector; constructor only calls `super(message)` and assigns readonly fields. |

No HIGH threats — this is a pure-types plan. Real threats are handled in plans 03-04 (SSRF / rate limiting inputs) and 03-07 (SSRF export routes).
</threat_model>

<verification>
- `pnpm --filter @aperture/backend typecheck` exits 0
- `grep -r "from '../types/copilot.js'" backend/src/` returns no matches yet (downstream plans will add imports)
- No tests added (types-only plan)
</verification>

<success_criteria>
- CopilotContext type compiles and exports from `backend/src/types/copilot.ts`
- ServicesFired discriminated union matches D-05 verbatim
- ErrorCode union matches D-07 verbatim
- Two error classes exist in `backend/src/services/errors.ts` following the Phase 2 pattern
- Downstream plans (03-04, 03-05, 03-06, 03-07) can import from these files without additional type definitions
</success_criteria>

<output>
After completion, create `.planning/phases/03-context-assembler-claude/03-01-SUMMARY.md`
</output>
