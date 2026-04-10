/**
 * Smoke test: calls `authenticate()` against the real Tableau Cloud sandbox
 * using credentials from `.env` and prints a redacted summary.
 *
 * Run with: `pnpm --filter @aperture/backend smoke:auth`
 *
 * Prerequisites:
 *   - `.env` exists at the repo root with TABLEAU_SERVER_URL, TABLEAU_SITE_NAME,
 *     TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET populated with real values.
 *   - The PAT is not expired (Tableau Cloud PATs live for 4 hours per use and
 *     15 days of inactivity by default).
 *   - The Tableau Cloud sandbox is reachable over the network.
 *
 * Two acceptable outcomes for Phase 1 SCAF-05 verification:
 *   1. Credentials populated -> exit 0 with `token prefix : <8 chars>...`
 *   2. Credentials empty -> exit 0 with a clear "credentials not configured"
 *      message. This is the expected state on a cold checkout before the user
 *      drops in their PAT, and it proves the error-path wiring works.
 *
 * Any OTHER failure (network error, 401 from real Tableau, typecheck error,
 * crash) exits 1 so CI or a developer knows something real is broken.
 *
 * This script NEVER prints the full token or the PAT secret.
 */
import { authenticate, TableauAuthError } from '../tableauAuth.js';
import { tokenCache } from '../tokenCache.js';

const NOT_CONFIGURED_MARKER = 'Tableau credentials not configured';

async function main(): Promise<void> {
  console.log('[smoke] Authenticating against Tableau Cloud...');
  try {
    const cached = await authenticate();
    console.log('[smoke] Signin succeeded.');
    console.log(`[smoke]   token prefix : ${cached.token.slice(0, 8)}...`);
    console.log(`[smoke]   site id      : ${cached.siteId}`);
    console.log(`[smoke]   expires at   : ${new Date(cached.expiresAt).toISOString()}`);

    // Sanity-check that the cache was populated by the successful signin.
    const fromCache = tokenCache.get();
    if (!fromCache || fromCache.token !== cached.token) {
      throw new Error('tokenCache did not return the freshly-authenticated token');
    }
    console.log('[smoke] Token cache populated correctly.');

    process.exit(0);
  } catch (err) {
    if (err instanceof TableauAuthError && err.message.startsWith(NOT_CONFIGURED_MARKER)) {
      // Expected cold-boot path on a fresh checkout: .env has empty Tableau vars.
      // This is NOT a test failure — it proves the "env.tableau undefined" guard
      // in requireTableauEnv() fires correctly. SCAF-05 will be hard-verified by
      // the user running this same script again after populating .env.
      console.log(
        `[smoke] ${NOT_CONFIGURED_MARKER} — skipping live auth smoke test (SCAF-05 will verify once .env is populated)`,
      );
      process.exit(0);
    }
    if (err instanceof TableauAuthError) {
      console.error(`[smoke] TableauAuthError: ${err.message}`);
      if (err.status !== undefined) {
        console.error(`[smoke]   HTTP status: ${err.status}`);
      }
    } else {
      console.error('[smoke] Unexpected error:', err);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[smoke] Fatal:', err);
  process.exit(1);
});
