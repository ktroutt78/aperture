import type { FastifyInstance } from 'fastify';

/**
 * Version reported by GET /health. Bumped as part of the backend workspace
 * package version. Kept as a local const (rather than JSON-importing
 * package.json) to avoid adding `resolveJsonModule` side effects and to keep
 * the health handler free of filesystem lookups.
 */
const VERSION = '0.1.0';

/**
 * Public health endpoint per D-14 and T-01-06. Returns HTTP 200 with a JSON
 * body shaped `{ status, uptime, version }`. Must NEVER touch Tableau, the DB,
 * or any external dependency — health must succeed even if Tableau is down.
 */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return {
      status: 'ok' as const,
      uptime: process.uptime(),
      version: VERSION,
    };
  });
}
