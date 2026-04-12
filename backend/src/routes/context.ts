/**
 * POST /context — CTX-14 debug endpoint.
 *
 * Returns the assembled CopilotContext as JSON. Primary use: Phase 4
 * development + judging-mode debugging. Phase 4 does NOT hit this in
 * production — it uses /chat directly.
 *
 * Request body: CopilotContextRequest (see backend/src/types/copilot.ts).
 * Response: CopilotContext JSON, OR 400 on validation, OR 502 on all-schemas-fail.
 *
 * Error contract (D-04):
 *   - `ContextAssemblerError` (from Plan 03-01) → 502 SCHEMA_UNAVAILABLE with
 *     { failedLuids, cause } so the Phase 4 UI can name the LUIDs that broke.
 *   - any other thrown error → 500 INTERNAL with a generic message; the real
 *     cause is left in the pino log via `app.log.error`.
 *
 * Validation contract (T-03-06-01 SSRF mitigation):
 *   - workbookName / worksheetName must be strings
 *   - datasourceLuids must be an array of RFC-ish UUIDs (LUID_REGEX)
 *   - selectedMarks / activeFilters must be arrays (shape is passed through;
 *     the assembler + downstream services do their own field-level checks)
 *   - Everything else → 400 BAD_REQUEST with a human-readable message.
 *
 * Registration: Phase 3 Plan 08 wires this into `server.ts`. This plan DOES
 * NOT modify server.ts — Wave 3 owns routes + tests only.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import { assembleContext } from '../services/contextAssembler.js';
import { ContextAssemblerError } from '../services/errors.js';
import type { CopilotContextRequest } from '../types/copilot.js';

/** Tableau LUIDs are UUID-shaped (8-4-4-4-12 hex). Case-insensitive. */
const LUID_REGEX = /^[a-f0-9-]{36}$/i;

function validateRequest(body: unknown): CopilotContextRequest | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.workbookName !== 'string') return { error: 'workbookName must be a string' };
  if (typeof b.worksheetName !== 'string') return { error: 'worksheetName must be a string' };
  if (!Array.isArray(b.datasourceLuids)) return { error: 'datasourceLuids must be an array' };
  for (const luid of b.datasourceLuids) {
    if (typeof luid !== 'string' || !LUID_REGEX.test(luid)) {
      return { error: `invalid datasource LUID: ${String(luid)}` };
    }
  }
  if (!Array.isArray(b.selectedMarks)) return { error: 'selectedMarks must be an array' };
  if (!Array.isArray(b.activeFilters)) return { error: 'activeFilters must be an array' };
  return {
    workbookName: b.workbookName,
    worksheetName: b.worksheetName,
    datasourceLuids: b.datasourceLuids as string[],
    selectedMarks: b.selectedMarks as CopilotContextRequest['selectedMarks'],
    activeFilters: b.activeFilters as CopilotContextRequest['activeFilters'],
  };
}

export const contextRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/context', async (req, reply) => {
    const validated = validateRequest(req.body);
    if ('error' in validated) {
      return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
    }
    try {
      const context = await assembleContext(validated);
      return reply.send(context);
    } catch (err) {
      if (err instanceof ContextAssemblerError) {
        // D-04: 100%-schema-failure → 502 SCHEMA_UNAVAILABLE. Surface the
        // failed LUIDs so the operator knows which datasources to fix.
        return reply.code(502).send({
          error: 'SCHEMA_UNAVAILABLE',
          failedLuids: err.failedLuids,
          cause: (err.cause as Error | undefined)?.message ?? err.message,
        });
      }
      app.log.error({ err }, 'context assembler unexpected error');
      return reply.code(500).send({ error: 'INTERNAL', message: 'unexpected error' });
    }
  });
};
