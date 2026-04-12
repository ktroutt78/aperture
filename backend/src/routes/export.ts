/**
 * POST /export/slack — CTX-16 (D-19, D-21)
 * POST /export/pdf   — CTX-17 (D-20)
 *
 * Both routes share a single FastifyPluginAsync so they register together.
 * SSRF defenses:
 *   - /export/slack: webhook URL is ONLY read from env.slackWebhookUrl. No
 *     user-supplied URL — no SSRF surface by construction (D-21).
 *   - /export/pdf:   workbookLuid is validated with LUID_REGEX BEFORE any
 *     URL construction. The validated LUID + the cached siteId (via
 *     getCachedSiteId from tableauAuth.ts) are the ONLY inputs to the URL
 *     template. The validated URL is passed to tableauFetch, the Phase 1
 *     chokepoint (D-20, hard Phase 1 invariant).
 *
 * Blocker 1 fix: the PDF URL uses a real JS template interpolation of the
 * resolved siteId, NOT a literal placeholder string — `tableauFetch` does NOT
 * perform site-id substitution, so the URL must be fully materialized before
 * the call.
 */
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { tableauFetch } from '../services/tableauFetch.js';
import { getCachedSiteId } from '../services/tableauAuth.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';

const LUID_REGEX = /^[a-f0-9-]{36}$/i;

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'exportRoutes',
});

// ---------- Slack ----------

interface SlackRequestBody {
  narrative: string;
  anomalies: readonly { fieldName: string; value: string }[];
  workbookName: string;
  worksheetName: string;
}

function validateSlackBody(body: unknown): SlackRequestBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.narrative !== 'string' || b.narrative.length === 0) {
    return { error: 'narrative must be a non-empty string' };
  }
  if (!Array.isArray(b.anomalies)) return { error: 'anomalies must be an array' };
  for (const a of b.anomalies) {
    if (!a || typeof a !== 'object') return { error: 'anomaly must be an object' };
    const ao = a as Record<string, unknown>;
    if (typeof ao.fieldName !== 'string' || typeof ao.value !== 'string') {
      return { error: 'anomaly must have string fieldName and value' };
    }
  }
  if (typeof b.workbookName !== 'string') return { error: 'workbookName must be a string' };
  if (typeof b.worksheetName !== 'string') return { error: 'worksheetName must be a string' };
  return b as unknown as SlackRequestBody;
}

function buildBlockKitPayload(body: SlackRequestBody): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `${body.workbookName} / ${body.worksheetName}` },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: body.narrative },
    },
  ];
  if (body.anomalies.length > 0) {
    blocks.push({
      type: 'context',
      elements: body.anomalies.map((a) => ({
        type: 'mrkdwn',
        text: `:warning: ${a.fieldName} = ${a.value}`,
      })),
    });
  }
  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: 'Posted from Aperture' }],
  });
  return { blocks };
}

// ---------- PDF ----------

interface PdfRequestBody {
  workbookLuid: string;
}

function validatePdfBody(body: unknown): PdfRequestBody | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.workbookLuid !== 'string') return { error: 'workbookLuid must be a string' };
  if (!LUID_REGEX.test(b.workbookLuid)) return { error: 'workbookLuid must be a valid LUID' };
  return { workbookLuid: b.workbookLuid };
}

// ---------- Route plugin ----------

export interface ExportRouteDeps {
  /** Override the Slack webhook POST for testing. Defaults to global fetch. */
  slackFetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Override tableauFetch for testing. Defaults to the real one. */
  tableauFetchImpl?: typeof tableauFetch;
  /** Override getCachedSiteId for testing. Defaults to the real helper from tableauAuth. */
  getSiteId?: () => Promise<string>;
}

export function createExportRoutes(deps: ExportRouteDeps = {}): FastifyPluginAsync {
  const doSlackFetch = deps.slackFetch ?? ((url, init) => fetch(url, init));
  const doTableauFetch = deps.tableauFetchImpl ?? tableauFetch;
  const doGetSiteId = deps.getSiteId ?? getCachedSiteId;

  return async (app: FastifyInstance) => {
    // ---------- POST /export/slack ----------
    app.post('/export/slack', async (req, reply) => {
      const validated = validateSlackBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      const env = loadEnv();
      // D-21: URL is server-side only. Never from the client.
      if (!env.slackWebhookUrl) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'SLACK_WEBHOOK_URL' });
      }

      const payload = buildBlockKitPayload(validated);
      try {
        const res = await doSlackFetch(env.slackWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          log.warn({ status: res.status }, 'slack webhook returned non-2xx');
          return reply.code(502).send({ error: 'SLACK_WEBHOOK_FAILED', status: res.status });
        }
        return reply.send({ status: 'ok' });
      } catch (err) {
        log.error({ err: (err as Error).message }, 'slack webhook fetch threw');
        return reply
          .code(502)
          .send({ error: 'SLACK_WEBHOOK_FAILED', message: 'network error' });
      }
    });

    // ---------- POST /export/pdf ----------
    app.post('/export/pdf', async (req, reply) => {
      const validated = validatePdfBody(req.body);
      if ('error' in validated) {
        return reply.code(400).send({ error: 'BAD_REQUEST', message: validated.error });
      }

      const env = loadEnv();
      if (!env.tableau) {
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'TABLEAU_*' });
      }

      // Blocker 1 fix: resolve the real siteId from the cached token BEFORE
      // URL construction. tableauFetch does NOT substitute any site-id token.
      let siteId: string;
      try {
        siteId = await doGetSiteId();
      } catch (err) {
        log.error({ err: (err as Error).message }, 'getCachedSiteId failed');
        return reply.code(503).send({ error: 'ENV_MISSING', key: 'TABLEAU_*' });
      }

      // D-20: build URL from the validated LUID + resolved siteId. Both are
      // under our control (regex-validated LUID; server-side siteId). No
      // literal placeholder reaches the wire.
      const baseUrl = env.tableau.serverUrl.replace(/\/$/, '');
      const url = `${baseUrl}/api/3.19/sites/${siteId}/workbooks/${validated.workbookLuid}/pdf?type=A4&orientation=Portrait`;

      try {
        const tableauRes = await doTableauFetch(url, { method: 'GET' });
        if (!tableauRes.ok) {
          log.warn(
            { status: tableauRes.status, luid: validated.workbookLuid },
            'tableau pdf returned non-2xx',
          );
          return reply
            .code(502)
            .send({ error: 'TABLEAU_PDF_FAILED', status: tableauRes.status });
        }

        // D-20: stream the body through, no backend buffering.
        reply.raw.setHeader('Content-Type', 'application/pdf');
        reply.raw.setHeader(
          'Content-Disposition',
          `attachment; filename="aperture-workbook-${validated.workbookLuid}.pdf"`,
        );
        reply.hijack();

        if (!tableauRes.body) {
          reply.raw.end();
          return;
        }
        // Node fetch Response body is a ReadableStream — pipe via Web Streams API.
        const reader = tableauRes.body.getReader();
        try {
          // eslint-disable-next-line no-constant-condition
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            reply.raw.write(Buffer.from(value));
          }
        } finally {
          reply.raw.end();
        }
      } catch (err) {
        log.error(
          { err: (err as Error).message, luid: validated.workbookLuid },
          'tableau pdf fetch threw',
        );
        if (!reply.sent && !reply.raw.headersSent) {
          return reply
            .code(502)
            .send({ error: 'TABLEAU_PDF_FAILED', message: 'network error' });
        }
        reply.raw.end();
      }
    });
  };
}

/** Default export for server.ts — Plan 03-08 will register this. */
export const exportRoutes: FastifyPluginAsync = createExportRoutes();
