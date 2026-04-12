/**
 * Tableau Cloud PAT signin and session-token management.
 *
 * This module is the SINGLE place in the backend that knows how to obtain an
 * `X-Tableau-Auth` token. All three Phase 2 Tableau services (Metadata,
 * VizQL Data Service, Pulse) must route their HTTP calls through
 * `tableauFetch.ts`, which in turn calls `getOrRefreshToken()` here.
 *
 * Locked decisions from 01-04-PLAN:
 *   - D-26: Tableau REST API version 3.19
 *   - D-27: JSON body with personalAccessTokenName / personalAccessTokenSecret / site.contentUrl
 *   - D-28: Proactive expiry at now + 3h45m (15-min safety margin under 4h PAT hard expiry)
 *   - D-31: Signin POST itself does NOT carry X-Tableau-Auth
 *   - D-32: `TableauAuthError` thrown on any non-200
 *   - D-33: Log only siteId + token prefix; never the full token or PAT secret
 */
import { loadEnv, type TableauEnv } from '../config/env.js';
import { createLogger } from '../lib/logger.js';
import { tokenCache, type CachedToken } from './tokenCache.js';

const log = createLogger({ pretty: process.env.NODE_ENV !== 'production' }).child({
  module: 'tableauAuth',
});

/** Per CLAUDE.md: PAT tokens expire after 4 hours. We refresh proactively at 3h45m. */
const TOKEN_LIFETIME_MS = (3 * 60 + 45) * 60_000;

/**
 * Tableau REST API version (locked per D-26).
 * The full signin endpoint is: POST {serverUrl}/api/3.19/auth/signin
 */
const TABLEAU_API_VERSION = '3.19';

/**
 * Typed error thrown by `authenticate()` on any non-200 response, non-JSON body,
 * missing credentials fields, or network-level failure. Callers can catch and
 * introspect `status` (HTTP code if available) and `cause` (underlying error).
 */
export class TableauAuthError extends Error {
  readonly status: number | undefined;
  override readonly cause: unknown;
  constructor(message: string, opts: { status?: number; cause?: unknown } = {}) {
    super(message);
    this.name = 'TableauAuthError';
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

interface SigninResponse {
  credentials?: {
    token?: string;
    site?: { id?: string; contentUrl?: string };
    user?: { id?: string };
  };
}

function requireTableauEnv(): TableauEnv {
  const env = loadEnv();
  if (!env.tableau) {
    throw new TableauAuthError(
      'Tableau credentials not configured — set TABLEAU_SERVER_URL, TABLEAU_SITE_NAME, TABLEAU_PAT_NAME, TABLEAU_PAT_SECRET in .env',
    );
  }
  return env.tableau;
}

/**
 * Truncate + strip token-like substrings before surfacing response bodies to
 * logs or error messages. Defense-in-depth on top of pino's redact paths.
 */
function redactBody(body: string): string {
  const truncated = body.length > 200 ? `${body.slice(0, 200)}...` : body;
  return truncated
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"[REDACTED]"')
    .replace(
      /"personalAccessTokenSecret"\s*:\s*"[^"]+"/g,
      '"personalAccessTokenSecret":"[REDACTED]"',
    );
}

/**
 * Sign in to Tableau Cloud with PAT credentials and return the session token.
 *
 * On success: also writes the result to `tokenCache` so subsequent
 * `getOrRefreshToken()` calls are no-ops until expiry.
 *
 * On failure: throws `TableauAuthError`. Never leaks the PAT secret or token.
 */
export async function authenticate(): Promise<CachedToken> {
  const tableau = requireTableauEnv();
  const baseUrl = tableau.serverUrl.replace(/\/$/, '');
  const url = `${baseUrl}/api/${TABLEAU_API_VERSION}/auth/signin`;
  const payload = {
    credentials: {
      personalAccessTokenName: tableau.patName,
      personalAccessTokenSecret: tableau.patSecret,
      site: { contentUrl: tableau.siteName },
    },
  };

  log.debug({ url, siteName: tableau.siteName }, 'Calling Tableau signin');

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    throw new TableauAuthError('Network error calling Tableau signin', { cause: err });
  }

  const rawBody = await res.text();

  if (!res.ok) {
    throw new TableauAuthError(
      `Tableau signin failed: HTTP ${res.status} — ${redactBody(rawBody)}`,
      { status: res.status },
    );
  }

  let parsed: SigninResponse;
  try {
    parsed = JSON.parse(rawBody) as SigninResponse;
  } catch (err) {
    throw new TableauAuthError('Tableau signin returned non-JSON response', {
      status: res.status,
      cause: err,
    });
  }

  const token = parsed.credentials?.token;
  const siteId = parsed.credentials?.site?.id;
  if (!token || !siteId) {
    throw new TableauAuthError(
      `Tableau signin response missing credentials.token or credentials.site.id: ${redactBody(rawBody)}`,
      { status: res.status },
    );
  }

  const cached: CachedToken = {
    token,
    siteId,
    expiresAt: Date.now() + TOKEN_LIFETIME_MS,
  };

  log.info(
    {
      siteId,
      tokenPrefix: `${token.slice(0, 8)}...`,
      expiresAt: new Date(cached.expiresAt).toISOString(),
    },
    'Tableau signin succeeded',
  );

  tokenCache.set(cached);
  return cached;
}

/**
 * Return a cached token if still valid, otherwise authenticate and cache.
 *
 * This is the entry point `tableauFetch` uses on every request, so it must be
 * cheap when a valid token is already cached (one Map lookup + epoch compare).
 */
export async function getOrRefreshToken(): Promise<CachedToken> {
  const cached = tokenCache.get();
  if (cached) return cached;
  return authenticate();
}

/**
 * Force a re-authentication (wipes cache first).
 *
 * Called by `tableauFetch` on a 401 response from any downstream Tableau API —
 * this is the "reactive" half of D-28's proactive+reactive refresh strategy.
 * Per D-29, `tableauFetch` retries the failed request EXACTLY ONCE after this.
 */
export async function forceRefreshToken(): Promise<CachedToken> {
  tokenCache.clear();
  return authenticate();
}

/**
 * Return the Tableau Cloud siteId for the currently-cached token, refreshing
 * the token first if expired or absent. Consumers (Phase 3 PDF export route)
 * use this to interpolate `{siteId}` into REST URLs that take the form
 * `/api/{ver}/sites/{siteId}/...`.
 *
 * Reuses `getOrRefreshToken()` so the token-cache and proactive-refresh
 * semantics from D-28 + D-30 continue to apply — no new state machine.
 */
export async function getCachedSiteId(): Promise<string> {
  const token = await getOrRefreshToken();
  return token.siteId;
}
