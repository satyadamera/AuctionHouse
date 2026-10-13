import 'dotenv/config';
import { z } from 'zod';

/**
 * Typed, validated configuration. The process refuses to start with an invalid environment instead
 * of failing later in a confusing way. Test runs swap in TEST_DATABASE_URL / TEST_REDIS_URL.
 */
const boolish = z
  .union([z.boolean(), z.string()])
  .transform((v) => v === true || v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(2).max(200).default(20),
  REDIS_URL: z.string().min(1),
  TEST_REDIS_URL: z.string().optional(),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  RATE_LIMIT_AUTH_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_WINDOW_SECONDS: z.coerce.number().int().positive().default(900),
  RATE_LIMIT_BID_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_BID_WINDOW_SECONDS: z.coerce.number().int().positive().default(10),
  LIFECYCLE_POLL_MS: z.coerce.number().int().positive().default(1000),
  OUTBOX_POLL_MS: z.coerce.number().int().positive().default(250),
  ENDING_SOON_SECONDS: z.coerce.number().int().positive().default(300),
  ANTI_SNIPE_WINDOW_SECONDS: z.coerce.number().int().min(0).default(0),
  ANTI_SNIPE_EXTENSION_SECONDS: z.coerce.number().int().min(0).default(60),
  ENABLE_DEV_ROUTES: boolish.default(false),
  DISABLE_WORKERS: boolish.default(false),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:\n', z.prettifyError(parsed.error));
  process.exit(1);
}

const raw = parsed.data;
const isTest = raw.NODE_ENV === 'test';

if (raw.NODE_ENV === 'production' && raw.ENABLE_DEV_ROUTES) {
  console.error('ENABLE_DEV_ROUTES must be false in production');
  process.exit(1);
}

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isTest,
  databaseUrl: isTest && raw.TEST_DATABASE_URL ? raw.TEST_DATABASE_URL : raw.DATABASE_URL,
  redisUrl: isTest && raw.TEST_REDIS_URL ? raw.TEST_REDIS_URL : raw.REDIS_URL,
  corsOrigins: raw.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
};

export type Env = typeof env;
