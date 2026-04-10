/**
 * `tableauFetch` — the SINGLE chokepoint for every Tableau API call in Aperture.
 *
 * Phase 2's three services (Metadata GraphQL, VizQL Data Service, Pulse REST)
 * MUST call this wrapper instead of native `fetch`. It is the only place that
 * knows about `X-Tableau-Auth`, session caching, and the 401 auto-refresh
 * behavior mandated by CLAUDE.md ("PAT tokens expire after 4 hours — backend
 * must auto-refresh on any 401 from Metadata, VizQL, or Pulse").
 *
 * Locked decisions from 01-04-PLAN:
 *   - D-29: exactly ONE retry on 401. A second 401 bubbles the error to the
 *     caller. No exponential backoff. No retries on other 4xx or any 5xx.
 *   - D-31: every non-signin request carries the `X-Tableau-Auth` header;
 *     the signin itself (in `tableauAuth.ts`) does NOT.
 *   - D-28: proactive refresh at 3h45m lives inside `getOrRefreshToken()`;
 *     this wrapper adds the reactive half via `forceRefreshToken()` on 401.
 */
import { getOrRefreshToken, forceRefreshToken } from './tableauAuth.js';

/**
 * Wrap native fetch with Tableau auth: inject `X-Tableau-Auth` from the cached
 * token, and on a 401 wipe the cache, re-authenticate, and retry exactly once.
 *
 * Returns the first non-401 `Response` or, if the first attempt was 401, the
 * `Response` from the single retry (regardless of its status, including a
 * second 401 — the caller decides what to do with a persistent auth failure).
 *
 * Caller-supplied headers are preserved; `X-Tableau-Auth` is always overwritten
 * so the wrapper owns auth end-to-end.
 */
export async function tableauFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const firstToken = await getOrRefreshToken();
  const firstRes = await fetch(url, withAuthHeader(init, firstToken.token));

  if (firstRes.status !== 401) {
    return firstRes;
  }

  // 401 — cached token is stale or revoked. Drain the first response body so
  // the underlying connection can be reused, then wipe the cache, re-auth,
  // and retry ONCE (D-29). A second 401 bubbles to the caller.
  try {
    await firstRes.body?.cancel();
  } catch {
    // best-effort cleanup — a failure to cancel the drain is not fatal
  }

  const refreshed = await forceRefreshToken();
  return fetch(url, withAuthHeader(init, refreshed.token));
}

/**
 * Clone the caller's `RequestInit` and force `X-Tableau-Auth` to the given
 * token. Uses `Headers` to normalize whatever shape the caller passed
 * (plain object, array, or existing Headers instance).
 */
function withAuthHeader(init: RequestInit, token: string): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('X-Tableau-Auth', token);
  return { ...init, headers };
}
