// dotenv must load before any other import that reads process.env.
// Importing env.ts triggers `import 'dotenv/config'` which runs config()
// at module evaluation time — hence we import it first.
import './config/env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyRateLimit from '@fastify/rate-limit';
import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';
import { contextRoutes } from './routes/context.js';
import { chatRoutes } from './routes/chat.js';
import { exportRoutes } from './routes/export.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger({ pretty: env.nodeEnv !== 'production' });

  const app = Fastify({
    loggerInstance: logger,
    disableRequestLogging: false,
  });

  // CORS — locked to EXTENSION_ORIGIN (D-09). Mitigates T-01-03 by preventing
  // wildcard origin and requiring a single explicit allowlisted origin from
  // the environment.
  //
  // We pass a function instead of a string so the plugin only emits the
  // `Access-Control-Allow-Origin` header when the request's Origin header
  // actually matches EXTENSION_ORIGIN. Passing a plain string causes
  // @fastify/cors to echo the configured origin to every preflight regardless
  // of the incoming Origin header — the browser would still enforce the match
  // client-side, but defense-in-depth is to not advertise the allowed origin
  // to unrelated callers. Requests with no Origin header (same-origin, curl,
  // server-to-server health probes) are allowed through so `/health` works
  // for uptime checks.
  // CORS allowlist derives from a single env var: origin: env.extensionOrigin
  const allowedOrigin = env.extensionOrigin;
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || origin === allowedOrigin) {
        cb(null, true);
        return;
      }
      cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });

  // D-22: rate limiting. Global default is permissive (1000/min) — individual
  // routes apply tighter overrides via the onRoute hook below. /health uses
  // the global default (no override = effectively unlimited for uptime probes).
  //
  // `global: false` means the plugin does NOT auto-apply to every route; each
  // route opts in via its own `config.rateLimit` block. Our onRoute hook sets
  // that config programmatically based on the URL, so routes we don't touch
  // (e.g. /health) remain unlimited. `addHeaders: { 'retry-after': true }`
  // ensures a 429 response always carries a `Retry-After` header so clients
  // can back off correctly — this is part of the D-22 contract.
  await app.register(fastifyRateLimit, {
    global: false, // opt-in per route via onRoute hook
    max: 1000,
    timeWindow: '1 minute',
    skipOnError: true,
    addHeaders: { 'retry-after': true },
  });

  // Install the onRoute hook BEFORE any route plugin is registered, so
  // Fastify applies it to every subsequent route registration (including
  // healthRoutes, which is moved below this line — Warning 5 fix). Because
  // the hook runs at the top-level app scope BEFORE any `register()` call,
  // Fastify propagates it into every child plugin's encapsulation scope.
  //
  // D-22 per-URL overrides:
  //   - /chat, /context           → 60/min  (T-03-08-01 mitigation)
  //   - /export/slack, /export/pdf → 10/min (T-03-08-02 mitigation)
  //   - /health                   → no override (global default = unlimited,
  //                                  T-03-08-03 mitigation)
  app.addHook('onRoute', (routeOpts) => {
    if (!routeOpts.config) routeOpts.config = {};
    const cfg = routeOpts.config as Record<string, unknown>;
    if (cfg.rateLimit !== undefined) return; // already set by route author
    const url = routeOpts.url ?? '';
    let max: number | undefined;
    if (url === '/chat' || url === '/context') max = 60;
    else if (url === '/export/slack' || url === '/export/pdf') max = 10;
    // /health and any other unlisted route: no override → global default applies
    if (max !== undefined) {
      cfg.rateLimit = { max, timeWindow: '1 minute' };
    }
  });

  // Route registration — MUST be after the onRoute hook above so every
  // registered route inherits the D-22 rate-limit config via the hook.
  // healthRoutes was previously registered at ~line 48, ABOVE the CORS
  // block — it is MOVED here so the onRoute hook covers it (Warning 5 fix).
  await app.register(healthRoutes);
  await app.register(contextRoutes);
  await app.register(chatRoutes);
  await app.register(exportRoutes);

  try {
    // D-15: bind to 0.0.0.0 so hosted runtimes (Docker, Render, etc.) can
    // reach the server in later phases, not just localhost.
    const address = await app.listen({ port: env.port, host: '0.0.0.0' });
    app.log.info({ address, extensionOrigin: env.extensionOrigin }, 'Aperture backend listening');
  } catch (err) {
    app.log.error(err, 'Failed to start server');
    process.exit(1);
  }

  // Graceful shutdown — ensures in-flight requests finish before exit.
  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'Shutdown signal received, closing server');
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'Error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
