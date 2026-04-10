/**
 * In-memory singleton cache for the Tableau REST session token.
 *
 * Per D-30 (01-04-PLAN): module-level singleton object with get/set/clear.
 * No external cache (Redis, etc.) — the Aperture backend is single-process for v1.
 *
 * Per D-28 (01-04-PLAN) + CLAUDE.md "PAT tokens expire after 4 hours":
 *   The cache stores a pre-computed `expiresAt` (Unix epoch ms). `get()` treats
 *   `expiresAt <= Date.now()` as expired and returns `null`, so callers never
 *   see a stale token even if the consumer forgets to call `forceRefreshToken()`.
 *
 * This module is intentionally side-effect free beyond the `current` closure.
 */

export interface CachedToken {
  /** Tableau REST `X-Tableau-Auth` token returned by POST /api/{ver}/auth/signin. */
  readonly token: string;
  /** Tableau site id (LUID) returned inside credentials.site.id. */
  readonly siteId: string;
  /** Unix epoch ms at which this token should be considered expired (proactive refresh). */
  readonly expiresAt: number;
}

let current: CachedToken | null = null;

export const tokenCache = {
  /** Return the cached token if present and not yet expired; otherwise `null`. */
  get(): CachedToken | null {
    if (!current) return null;
    if (current.expiresAt <= Date.now()) {
      current = null;
      return null;
    }
    return current;
  },

  /** Store a freshly-authenticated token. Overwrites any existing entry. */
  set(token: CachedToken): void {
    current = token;
  },

  /** Wipe the cache. Called by `forceRefreshToken()` on a 401 from downstream APIs. */
  clear(): void {
    current = null;
  },

  /**
   * Test-only: peek at the raw cache without expiry check.
   * Do NOT use in production code paths — it bypasses the expiry guard.
   */
  __peek(): CachedToken | null {
    return current;
  },
} as const;
