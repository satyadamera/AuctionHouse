import { pino } from 'pino';
import { env } from '../config/env.js';

/**
 * Structured JSON logger. Secrets are redacted at the logger level so a careless
 * `logger.info({ req })` can never leak a token or password.
 */
export const logger = pino({
  level: env.isTest ? (process.env.LOG_LEVEL_TEST ?? 'silent') : env.LOG_LEVEL,
  base: { service: 'auctra-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.accessToken',
      'password',
      'token',
    ],
    censor: '[redacted]',
  },
  ...(env.isProduction || env.isTest
    ? {}
    : { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' } } }),
});
