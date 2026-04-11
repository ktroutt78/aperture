/**
 * Tableau Pulse REST service — TAPI-07 / TAPI-08 / TAPI-09 / TAPI-10.
 *
 * Produces a typed `PulseContext` for a single datasource LUID by fanning out
 * to three Pulse REST endpoints:
 *   1. GET  /api/-/pulse/definitions?datasource_luid=<LUID>     (metric definitions — TAPI-07)
 *   2. POST /api/-/pulse/insights:generate  per metric           (insight bundles — TAPI-08)
 *   3. GET  /api/-/pulse/user/preferences                        (insight feedback metadata — TAPI-09)
 *
 * TAPI-10 — THE LOAD-BEARING GROUND RULE (CLAUDE.md: "degrade gracefully if any
 * Tableau API returns empty — never crash the panel"):
 *
 *   A datasource with no Pulse metrics MUST return an empty-but-valid
 *   PulseContext with `hasMetrics: false`. This service MUST NOT throw in the
 *   no-metrics path. Three degraded-path triggers are handled:
 *
 *     (a) HTTP 404 on /definitions    → tenant has Pulse disabled or no metrics
 *     (b) HTTP 403 on /definitions    → caller lacks Pulse read scope
 *     (c) HTTP 200 with empty array   → datasource simply has no configured metrics
 *
 *   In all three cases the service short-circuits to `emptyPulseContext(luid)`
 *   and does NOT call insights:generate. The offline unit test
 *   `pulseService.empty.test.ts` enforces this contract without network access.
 *
 * Partial failures during bundle fetch are handled with `Promise.allSettled` —
 * one metric's bundle fetch failing must not take down the other N-1 metrics.
 *
 * All HTTP calls route through `tableauFetch` (the single chokepoint for Tableau
 * auth) — this module must NEVER construct Tableau session headers directly and
 * must NEVER call native `fetch` for a Tableau URL.
 */
import { tableauFetch } from './tableauFetch.js';
import { loadEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import type {
  PulseContext,
  PulseMetricDefinition,
  PulseInsightBundle,
  InsightFeedbackMetadata,
} from '../types/tableau.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'pulseService',
});

/**
 * SSRF guard: Pulse REST takes a datasource LUID in the query string. We
 * validate it as a 36-char UUID-shaped string before building the URL so a
 * malicious caller cannot smuggle path segments or host components into the
 * request.
 */
const LUID_PATTERN = /^[a-f0-9-]{36}$/i;

/**
 * Typed error thrown by `fetchPulseContext` on non-graceful failures.
 * Graceful-degradation paths (empty metrics, 404, 403) do NOT throw — they
 * return an empty `PulseContext` instead.
 */
export class PulseServiceError extends Error {
  override readonly cause: unknown;
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = 'PulseServiceError';
    this.cause = opts.cause;
  }
}

/**
 * Canonical empty-but-valid PulseContext. This is the return value for every
 * TAPI-10 graceful-degradation path. `hasMetrics: false` is the UI signal.
 */
function emptyPulseContext(datasourceLuid: string): PulseContext {
  return {
    datasourceLuid,
    metricDefinitions: [],
    insightBundles: [],
    feedback: [],
    hasMetrics: false,
  };
}

interface PulseDefinitionsResponse {
  definitions?: Array<{
    id?: string;
    metadata?: { name?: string; description?: string };
    name?: string;
    description?: string;
  }>;
}

interface PulseInsightsGenerateResponse {
  bundles?: Array<{
    id?: string;
    bundle_id?: string;
    insight_types?: string[];
    summary?: string;
    // Some Pulse API shapes nest the textual summary under result.markup
    result?: { markup?: string };
  }>;
}

interface PulseFeedbackResponse {
  insight_feedback?: Array<{
    insight_type: string;
    thumbs_up?: number;
    thumbs_down?: number;
  }>;
}

/**
 * Fetch a `PulseContext` for a single datasource LUID.
 *
 * Happy path: returns `{ ..., hasMetrics: true }` with non-empty arrays.
 * Graceful-empty path: returns `{ ..., hasMetrics: false }` with empty arrays.
 * Hard failure (misconfigured env, network error, unexpected 5xx on definitions):
 *   throws `PulseServiceError`.
 */
export async function fetchPulseContext(datasourceLuid: string): Promise<PulseContext> {
  // 1) SSRF-guard the LUID BEFORE concatenating it into a URL.
  if (!LUID_PATTERN.test(datasourceLuid)) {
    throw new PulseServiceError(
      `Invalid datasource LUID: must match /^[a-f0-9-]{36}$/ — got ${JSON.stringify(datasourceLuid).slice(0, 80)}`,
    );
  }

  // 2) Require Tableau env (server URL, etc.). Consistent error shape with the
  //    other Phase 2 services.
  const env = loadEnv();
  if (!env.tableau) {
    throw new PulseServiceError(
      'Tableau credentials not configured — set TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET in .env',
    );
  }
  const base = env.tableau.serverUrl.replace(/\/$/, '');

  // --------------------------------------------------------------------------
  // Step A — fetch metric definitions (TAPI-07)
  // --------------------------------------------------------------------------
  const defsUrl = `${base}/api/-/pulse/definitions?datasource_luid=${encodeURIComponent(datasourceLuid)}`;
  log.debug({ datasourceLuid }, 'Pulse: fetching metric definitions');

  let defsRes: Response;
  try {
    defsRes = await tableauFetch(defsUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    throw new PulseServiceError('Pulse definitions fetch failed (network)', { cause: err });
  }

  // TAPI-10 path (a) + (b): 404 / 403 → degrade gracefully.
  if (defsRes.status === 404 || defsRes.status === 403) {
    log.info(
      { datasourceLuid, status: defsRes.status },
      'Pulse definitions unavailable — returning empty PulseContext (TAPI-10)',
    );
    try {
      await defsRes.body?.cancel();
    } catch {
      // best-effort cleanup of the drained body
    }
    return emptyPulseContext(datasourceLuid);
  }

  if (!defsRes.ok) {
    const text = (await defsRes.text()).slice(0, 500);
    throw new PulseServiceError(`Pulse definitions HTTP ${defsRes.status}: ${text}`);
  }

  let defsJson: PulseDefinitionsResponse;
  try {
    defsJson = (await defsRes.json()) as PulseDefinitionsResponse;
  } catch (err) {
    throw new PulseServiceError('Pulse definitions returned non-JSON body', { cause: err });
  }

  const metricDefinitions: PulseMetricDefinition[] = (defsJson.definitions ?? [])
    .filter((d): d is { id: string; metadata?: { name?: string; description?: string }; name?: string; description?: string } =>
      typeof d?.id === 'string' && d.id.length > 0,
    )
    .map((d) => ({
      id: d.id,
      // Pulse API has evolved field naming; prefer metadata.name if present, fall back to top-level name.
      name: d.metadata?.name ?? d.name ?? '',
      description: d.metadata?.description ?? d.description ?? '',
      datasourceLuid,
    }));

  // TAPI-10 path (c): HTTP 200 but no definitions → degrade gracefully.
  // Do NOT call insights:generate — there is literally nothing to generate
  // insights for, so a second round-trip would be wasteful and could confuse
  // the Pulse API with unknown metric ids.
  if (metricDefinitions.length === 0) {
    log.info(
      { datasourceLuid },
      'Datasource has no Pulse metrics — returning empty PulseContext (TAPI-10)',
    );
    return emptyPulseContext(datasourceLuid);
  }

  log.info(
    { datasourceLuid, metricCount: metricDefinitions.length },
    'Pulse: got metric definitions, fetching insight bundles',
  );

  // --------------------------------------------------------------------------
  // Step B — fetch insight bundles per metric in parallel (TAPI-08)
  //
  // `Promise.allSettled` + per-metric try/catch: any single metric failing
  // (timeout, 500, malformed payload) degrades to an empty bundle list for
  // that metric rather than taking down the entire PulseContext. This is the
  // DoS mitigation for T-02-04-04 — one slow metric cannot block the others.
  // --------------------------------------------------------------------------
  const bundleResults = await Promise.allSettled(
    metricDefinitions.map(async (m): Promise<PulseInsightBundle[]> => {
      const url = `${base}/api/-/pulse/insights:generate`;
      let res: Response;
      try {
        res = await tableauFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ metric_id: m.id }),
        });
      } catch (err) {
        log.warn(
          { metricId: m.id, err: (err as Error).message },
          'Pulse bundle fetch network error — continuing with empty bundles for this metric',
        );
        return [];
      }

      if (!res.ok) {
        log.warn(
          { metricId: m.id, status: res.status },
          'Pulse bundle fetch non-OK — continuing with empty bundles for this metric',
        );
        try {
          await res.body?.cancel();
        } catch {
          // best-effort
        }
        return [];
      }

      let json: PulseInsightsGenerateResponse;
      try {
        json = (await res.json()) as PulseInsightsGenerateResponse;
      } catch (err) {
        log.warn(
          { metricId: m.id, err: (err as Error).message },
          'Pulse bundle JSON parse failed — continuing with empty bundles for this metric',
        );
        return [];
      }

      return (json.bundles ?? [])
        .filter((b): b is NonNullable<typeof b> => b != null)
        .map((b) => ({
          metricId: m.id,
          bundleId: b.bundle_id ?? b.id ?? '',
          insightTypes: b.insight_types ?? [],
          // Some Pulse shapes return summary inline; others nest textual
          // content under result.markup. Prefer the inline field when present.
          summary: b.summary ?? b.result?.markup ?? '',
        }));
    }),
  );

  const insightBundles: PulseInsightBundle[] = bundleResults.flatMap((r) =>
    r.status === 'fulfilled' ? r.value : [],
  );

  // --------------------------------------------------------------------------
  // Step C — fetch feedback metadata (TAPI-09)
  //
  // Wrapped in its own try/catch: a feedback fetch failure logs a WARN and
  // continues with empty feedback. It cannot break the PulseContext (T-02-04-05).
  // --------------------------------------------------------------------------
  let feedback: InsightFeedbackMetadata[] = [];
  try {
    const fbUrl = `${base}/api/-/pulse/user/preferences`;
    const fbRes = await tableauFetch(fbUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (fbRes.ok) {
      const fbJson = (await fbRes.json()) as PulseFeedbackResponse;
      feedback = (fbJson.insight_feedback ?? []).map((f) => ({
        insightType: f.insight_type,
        thumbsUp: f.thumbs_up ?? 0,
        thumbsDown: f.thumbs_down ?? 0,
      }));
    } else {
      log.warn(
        { status: fbRes.status },
        'Pulse feedback fetch non-OK — continuing with empty feedback',
      );
      try {
        await fbRes.body?.cancel();
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    log.warn(
      { err: (err as Error).message },
      'Pulse feedback fetch failed — continuing with empty feedback',
    );
  }

  log.info(
    {
      datasourceLuid,
      metricCount: metricDefinitions.length,
      bundleCount: insightBundles.length,
      feedbackCount: feedback.length,
    },
    'Pulse: context assembled (counts only — no bundle content logged)',
  );

  // Happy path — populated context.
  return {
    datasourceLuid,
    metricDefinitions,
    insightBundles,
    feedback,
    hasMetrics: true,
  };
}
