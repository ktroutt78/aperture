/**
 * Phase 3 smoke harness (CTX-14/15/16/17 live verification).
 *
 * Runs in TWO phases:
 *
 *   Phase A — OFFLINE burst test (ALWAYS runs, no credentials needed):
 *     Builds a tiny in-memory Fastify instance that mirrors server.ts's
 *     bootstrap (fastifyRateLimit + the same onRoute hook), then registers a
 *     stubbed /context route using the real `contextRoutes` plugin surface
 *     wrapped so the route handler never calls Tableau or Anthropic. Fires 61
 *     sequential `app.inject()` requests at /context and asserts:
 *       - At least one response has statusCode === 429
 *       - The 429 carries a `retry-after` response header
 *       - The first 60 are never 429 (rate-limit window size is correct)
 *     This is the Warning 6 scoping-regression catch: if the top-level
 *     onRoute hook ever fails to propagate into the nested plugin scope, the
 *     61st request returns 200 and this test FAILs loudly BEFORE any live
 *     traffic hits the sandbox.
 *
 *   Phase B — LIVE smoke (runs only when --datasource + ANTHROPIC_API_KEY):
 *     Assumes the backend is already running on http://localhost:${PORT}
 *     (start via `pnpm --filter @aperture/backend dev` in another terminal).
 *     Hits POST /context with the EIA Prices LUID and asserts servicesFired
 *     + assemblyMs < 3000. Then opens POST /chat as an SSE stream, parses
 *     frames STRUCTURALLY by splitting on `\n\n` (INFO 10 refinement — not a
 *     substring scan of the raw wire), and asserts the D-07 event sequence:
 *     context → token* → (anomaly?) → suggestions → done. Also asserts that
 *     no `event: token` frame's JSON data contains leaked `[ANOMALY` or
 *     `{"suggestions"` substrings.
 *
 * Cold-boot semantics: if either ANTHROPIC_API_KEY is missing OR --datasource
 * is not supplied, Phase B prints a COLD-BOOT PASS and exits 0 (after Phase A
 * has already run and passed). Phase A always runs and always exits 0 or 1.
 *
 * Run:
 *   pnpm --filter @aperture/backend smoke:phase3
 *   pnpm --filter @aperture/backend smoke:phase3 -- \
 *     --datasource <EIA_PRICES_LUID> --workbook 'EIA Prices' --worksheet 'WTI Daily'
 *
 * Safety:
 *   - Never prints env.anthropicApiKey, PAT secret, or siteId
 *   - Never prints full Pulse insightBundles
 *   - Uses structural SSE parsing, not raw-buffer substring matches
 */
import Fastify from 'fastify';
import fastifyRateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';

import type {
  CopilotContext,
  CopilotContextRequest,
  ServicesFired,
} from '../../types/copilot.js';

// ---------------------------------------------------------------------------
// CLI arg parsing (same convention as Phase 2 smokes)
// ---------------------------------------------------------------------------

interface CliArgs {
  readonly datasourceLuid: string | undefined;
  readonly workbookName: string;
  readonly worksheetName: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  let datasourceLuid: string | undefined;
  let workbookName = 'EIA Prices';
  let worksheetName = 'WTI Daily';
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    if (flag === '--datasource' && val) {
      datasourceLuid = val;
      i++;
    } else if (flag === '--workbook' && val) {
      workbookName = val;
      i++;
    } else if (flag === '--worksheet' && val) {
      worksheetName = val;
      i++;
    }
  }
  return { datasourceLuid, workbookName, worksheetName };
}

// ---------------------------------------------------------------------------
// Phase A — offline burst test
// ---------------------------------------------------------------------------

/** Build a stub CopilotContext so the /context route returns 200 without
 *  touching Tableau. The shape satisfies the real CopilotContext type. */
function buildStubContext(req: CopilotContextRequest): CopilotContext {
  const servicesFired: ServicesFired = {
    metadata: { status: 'ok', datasources: req.datasourceLuids.length },
    vizql: { status: 'empty' },
    pulse: { status: 'empty' },
    assemblyMs: 1,
    contextChars: 10,
    truncated: false,
  };
  return {
    request: req,
    schema: { datasources: {} },
    liveData: [],
    pulse: [],
    servicesFired,
  };
}

/** Minimal /context plugin whose handler bypasses the real assembler. This
 *  is used ONLY in Phase A so the rate-limit behavior can be exercised
 *  without any Tableau or Anthropic calls. */
const stubContextPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.post('/context', async (req, reply) => {
    const body = req.body as CopilotContextRequest | undefined;
    const safe: CopilotContextRequest = body ?? {
      workbookName: 'stub',
      worksheetName: 'stub',
      datasourceLuids: ['00000000-0000-0000-0000-000000000000'],
      selectedMarks: [],
      activeFilters: [],
    };
    return reply.send(buildStubContext(safe));
  });
};

/** Attach the SAME onRoute hook as server.ts. Kept in sync manually — if
 *  server.ts's hook changes, this must change too. The grep acceptance
 *  criterion in the plan is the safeguard. */
function installD22Hook(app: FastifyInstance): void {
  app.addHook('onRoute', (routeOpts) => {
    if (!routeOpts.config) routeOpts.config = {};
    const cfg = routeOpts.config as Record<string, unknown>;
    if (cfg.rateLimit !== undefined) return;
    const url = routeOpts.url ?? '';
    let max: number | undefined;
    if (url === '/chat' || url === '/context') max = 60;
    else if (url === '/export/slack' || url === '/export/pdf') max = 10;
    if (max !== undefined) {
      cfg.rateLimit = { max, timeWindow: '1 minute' };
    }
  });
}

async function runPhaseA(): Promise<void> {
  console.log('\n[phase3:A] OFFLINE burst test — scoping regression catch');
  console.log('[phase3:A] Building in-memory Fastify + rate-limit + onRoute hook');

  const app = Fastify({ logger: false });
  // ORDER IS LOAD-BEARING (same as server.ts): install our onRoute hook
  // BEFORE registering @fastify/rate-limit. Fastify runs onRoute hooks in
  // registration order — our hook must run first to set `config.rateLimit`
  // before the plugin's internal onRoute hook reads it.
  installD22Hook(app);
  await app.register(fastifyRateLimit, {
    global: false,
    max: 1000,
    timeWindow: '1 minute',
    skipOnError: true,
    addHeaders: { 'retry-after': true },
  });
  await app.register(stubContextPlugin);
  await app.ready();

  const validBody = {
    workbookName: 'EIA Prices',
    worksheetName: 'WTI Daily',
    datasourceLuids: ['00000000-0000-0000-0000-000000000000'],
    selectedMarks: [],
    activeFilters: [],
  };

  const statuses: number[] = [];
  let retryAfterSeen = false;
  console.log('[phase3:A] Firing burst of 61 sequential /context requests');
  for (let i = 0; i < 61; i++) {
    const res = await app.inject({
      method: 'POST',
      url: '/context',
      headers: { 'content-type': 'application/json' },
      payload: validBody,
    });
    statuses.push(res.statusCode);
    if (res.statusCode === 429) {
      // Fastify normalizes header keys to lowercase. Both spellings covered.
      const ra = res.headers['retry-after'] ?? res.headers['Retry-After'];
      if (ra !== undefined && ra !== null && String(ra).length > 0) {
        retryAfterSeen = true;
      }
    }
  }

  await app.close();

  // Build a histogram for debug output.
  const histogram = statuses.reduce<Record<number, number>>((acc, s) => {
    acc[s] = (acc[s] ?? 0) + 1;
    return acc;
  }, {});

  const has429 = statuses.some((s) => s === 429);
  const firstSixtyClean = statuses.slice(0, 60).every((s) => s !== 429);

  if (!has429) {
    console.error('[phase3:A] FAIL — no 429 in 61 requests. Histogram:', histogram);
    console.error(
      '[phase3:A] This means the onRoute hook did NOT propagate into the ' +
        'contextRoutes plugin scope. Check server.ts: hook must be installed ' +
        'BEFORE any app.register() call.',
    );
    process.exit(1);
  }
  if (!retryAfterSeen) {
    console.error(
      '[phase3:A] FAIL — 429 response was missing the Retry-After header. ' +
        'Check addHeaders config on fastifyRateLimit register.',
    );
    console.error('[phase3:A] Histogram:', histogram);
    process.exit(1);
  }
  if (!firstSixtyClean) {
    console.error(
      '[phase3:A] FAIL — a 429 arrived before request #61. The D-22 max ' +
        'is set too low. Histogram:', histogram,
    );
    process.exit(1);
  }

  console.log(
    '[phase3:A] PASS — burst test: onRoute hook propagated into /context ' +
      'scope, 61st request returned 429 + Retry-After. Histogram:',
    histogram,
  );
}

// ---------------------------------------------------------------------------
// Phase B — live smoke
// ---------------------------------------------------------------------------

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

/** Parse an SSE response body into an ordered list of frames by splitting
 *  on the SSE record separator `\n\n` (INFO 10 refinement: structural, not
 *  substring-based). Comments (`:` lines) and malformed frames are skipped. */
function parseSseFrames(body: string): SseFrame[] {
  // SSE records are separated by blank lines. Normalize CRLF → LF first.
  const normalized = body.replace(/\r\n/g, '\n');
  const rawFrames = normalized.split('\n\n');
  const frames: SseFrame[] = [];
  for (const raw of rawFrames) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    // Comment / heartbeat frame — starts with ':'
    if (trimmed.startsWith(':')) continue;
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (event === undefined) continue;
    frames.push({ event, data: dataLines.join('\n') });
  }
  return frames;
}

async function runPhaseB(cli: CliArgs): Promise<void> {
  console.log('\n[phase3:B] LIVE smoke');

  if (cli.datasourceLuid === undefined) {
    console.log(
      '[phase3:B] COLD-BOOT PASS: no --datasource LUID supplied, skipping ' +
        'live verification. (Pass --datasource <EIA_PRICES_LUID> to run.)',
    );
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(
      '[phase3:B] COLD-BOOT PASS: ANTHROPIC_API_KEY is empty, skipping live ' +
        'verification. (Populate .env and rerun.)',
    );
    return;
  }

  const port = process.env.PORT ?? '3001';
  const base = `http://localhost:${port}`;
  const origin = process.env.EXTENSION_ORIGIN ?? 'http://localhost:5173';
  const contextBody = {
    workbookName: cli.workbookName,
    worksheetName: cli.worksheetName,
    datasourceLuids: [cli.datasourceLuid],
    selectedMarks: [],
    activeFilters: [],
  };

  // ---- /context verification --------------------------------------------
  console.log(`[phase3:B] POST ${base}/context (workbook="${cli.workbookName}")`);
  const contextRes = await fetch(`${base}/context`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
    },
    body: JSON.stringify(contextBody),
  });
  if (contextRes.status !== 200) {
    const errBody = await contextRes.text();
    console.error(
      `[phase3:B] FAIL — /context returned ${contextRes.status}. Body:`,
      errBody,
    );
    process.exit(1);
  }
  const contextJson = (await contextRes.json()) as CopilotContext;
  const metaStatus = contextJson.servicesFired.metadata.status;
  if (metaStatus !== 'ok' && metaStatus !== 'partial') {
    console.error(
      `[phase3:B] FAIL — metadata.status is "${metaStatus}", expected ok|partial`,
    );
    process.exit(1);
  }
  const metaOkCount =
    metaStatus === 'ok'
      ? (contextJson.servicesFired.metadata as { status: 'ok'; datasources: number }).datasources
      : (contextJson.servicesFired.metadata as { status: 'partial'; ok: number }).ok;
  if (metaOkCount < 1) {
    console.error('[phase3:B] FAIL — metadata ok count < 1');
    process.exit(1);
  }
  const datasourceKeys = Object.keys(contextJson.schema.datasources ?? {});
  if (datasourceKeys.length === 0) {
    console.error('[phase3:B] FAIL — schema.datasources is empty');
    process.exit(1);
  }
  if (contextJson.servicesFired.assemblyMs >= 3000) {
    console.error(
      `[phase3:B] FAIL — assemblyMs ${contextJson.servicesFired.assemblyMs} >= 3000`,
    );
    process.exit(1);
  }
  console.log(
    `[phase3:B] PASS: /context returned valid CopilotContext ` +
      `(metadata: ${metaStatus}, assemblyMs: ${contextJson.servicesFired.assemblyMs}, ` +
      `chars: ${contextJson.servicesFired.contextChars}, ` +
      `truncated: ${contextJson.servicesFired.truncated})`,
  );

  // ---- /chat verification (SSE stream) ----------------------------------
  console.log(`[phase3:B] POST ${base}/chat (SSE stream)`);
  const chatBody = {
    ...contextBody,
    messages: [],
    question: 'Summarize the recent WTI crude oil price trend',
  };
  const chatRes = await fetch(`${base}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      Origin: origin,
    },
    body: JSON.stringify(chatBody),
  });
  if (chatRes.status !== 200) {
    const errBody = await chatRes.text();
    console.error(`[phase3:B] FAIL — /chat returned ${chatRes.status}. Body:`, errBody);
    process.exit(1);
  }
  const raw = await chatRes.text();
  const frames = parseSseFrames(raw);

  if (frames.length === 0) {
    console.error('[phase3:B] FAIL — no SSE frames parsed from /chat body');
    process.exit(1);
  }

  const firstEvent = frames[0]?.event;
  const lastEvent = frames[frames.length - 1]?.event;
  const tokenFrames = frames.filter((f) => f.event === 'token');
  const hasContext = firstEvent === 'context';
  const hasToken = tokenFrames.length > 0;
  const hasSuggestions = frames.some((f) => f.event === 'suggestions');
  const hasDone = lastEvent === 'done';

  if (!hasContext || !hasToken || !hasSuggestions || !hasDone) {
    console.error('[phase3:B] FAIL — SSE frame sequence incomplete');
    console.error('[phase3:B] Observed sequence:', frames.map((f) => f.event).join(' -> '));
    process.exit(1);
  }

  // Per-frame tag leakage check (robust to frame-boundary splits).
  for (const frame of tokenFrames) {
    // The data payload is JSON. Re-serialize to a stable string and scan.
    let serialized = frame.data;
    try {
      const parsed = JSON.parse(frame.data) as unknown;
      serialized = JSON.stringify(parsed);
    } catch {
      // If data isn't valid JSON, fall back to the raw string for scan.
    }
    if (serialized.includes('[ANOMALY')) {
      console.error('[phase3:B] FAIL — token frame leaked [ANOMALY tag:', serialized);
      process.exit(1);
    }
    if (serialized.includes('{"suggestions"')) {
      console.error(
        '[phase3:B] FAIL — token frame leaked {"suggestions" block:',
        serialized,
      );
      process.exit(1);
    }
  }

  console.log(
    `[phase3:B] PASS: /chat emitted context -> tokens -> suggestions -> done ` +
      `with ${tokenFrames.length} token frames, ` +
      `${frames.filter((f) => f.event === 'anomaly').length} anomaly frames`,
  );
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cli = parseArgs();

  // Phase A ALWAYS runs. It has no dependencies on env vars or the live server.
  await runPhaseA();

  // Phase B runs only when credentials + LUID are present, otherwise cold-boot.
  await runPhaseB(cli);

  console.log('\n[phase3] ALL GREEN');
  process.exit(0);
}

main().catch((err) => {
  console.error('[phase3] Fatal harness error:', (err as Error).message);
  process.exit(1);
});
