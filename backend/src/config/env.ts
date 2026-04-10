import 'dotenv/config';

export interface TableauEnv {
  serverUrl: string;
  siteName: string;
  patName: string;
  patSecret: string;
}

export interface Env {
  readonly port: number;
  readonly extensionOrigin: string;
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly tableau: TableauEnv | undefined;
  readonly anthropicApiKey: string | undefined;
  readonly slackWebhookUrl: string | undefined;
}

let cached: Env | undefined;

export function loadEnv(): Env {
  if (cached) return cached;

  const portRaw = process.env.PORT;
  if (!portRaw) {
    throw new Error('PORT env var is required. Copy .env.example to .env and set PORT=3001.');
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`PORT env var must be a positive number, got: ${portRaw}`);
  }

  const extensionOrigin = process.env.EXTENSION_ORIGIN;
  if (!extensionOrigin) {
    throw new Error('EXTENSION_ORIGIN env var is required (e.g. http://localhost:5173).');
  }

  // Tableau vars are optional at boot — Plan 04 validates them inside tableauAuth.
  // TABLEAU_SITE_NAME may legitimately be empty string for default Tableau Cloud sites,
  // so we use `!== undefined` for it while requiring the other three to be truthy.
  const tableauVars = {
    serverUrl: process.env.TABLEAU_SERVER_URL,
    siteName: process.env.TABLEAU_SITE_NAME,
    patName: process.env.TABLEAU_PAT_NAME,
    patSecret: process.env.TABLEAU_PAT_SECRET,
  };
  const tableau: TableauEnv | undefined =
    tableauVars.serverUrl && tableauVars.siteName !== undefined && tableauVars.patName && tableauVars.patSecret
      ? {
          serverUrl: tableauVars.serverUrl,
          siteName: tableauVars.siteName,
          patName: tableauVars.patName,
          patSecret: tableauVars.patSecret,
        }
      : undefined;

  const nodeEnvRaw = process.env.NODE_ENV ?? 'development';
  const nodeEnv: Env['nodeEnv'] =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

  cached = Object.freeze({
    port,
    extensionOrigin,
    nodeEnv,
    tableau,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || undefined,
  });

  return cached;
}

/** Test-only: clears the cached env. */
export function __resetEnvCacheForTests(): void {
  cached = undefined;
}
