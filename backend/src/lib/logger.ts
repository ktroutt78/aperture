import pino, { type Logger, type LoggerOptions } from 'pino';

/**
 * Redact paths for pino's log output. Mitigates T-01-01 (Information Disclosure
 * via logger). Any field matching these paths is replaced with `[REDACTED]`
 * before being written to stdout or transports.
 *
 * See D-08 in the Plan 01-02 locked decisions and the project CLAUDE.md rule
 * "Never hardcode secrets — everything through `.env`".
 */
const redactPaths = [
  'authorization',
  '*.authorization',
  'req.headers.authorization',
  'req.headers["x-tableau-auth"]',
  'headers["x-tableau-auth"]',
  '*.patSecret',
  '*.pat_secret',
  '*.pat_name',
  '*.patName',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.token',
  '*.password',
];

export function createLogger(opts: { level?: string; pretty?: boolean } = {}): Logger {
  const base: LoggerOptions = {
    level: opts.level ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
    redact: {
      paths: redactPaths,
      censor: '[REDACTED]',
    },
  };

  if (opts.pretty) {
    return pino({
      ...base,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', singleLine: false },
      },
    });
  }

  return pino(base);
}
