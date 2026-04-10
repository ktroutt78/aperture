// dotenv must load before any other import that reads process.env.
// Importing env.ts triggers `import 'dotenv/config'` which runs config()
// at module evaluation time — hence we import it first.
import './config/env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';
import { healthRoutes } from './routes/health.js';

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

  // Routes
  await app.register(healthRoutes);

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
