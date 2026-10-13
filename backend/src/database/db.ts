import { Kysely, MysqlDialect, type Transaction } from 'kysely';
import { createPool, type Pool, type PoolOptions } from 'mysql2';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { requestContext } from '../utils/requestContext.js';
import type { Database } from './types.js';

export type DB = Kysely<Database>;
export type Tx = Transaction<Database>;

function poolOptions(url: string): PoolOptions {
  return {
    uri: url,
    connectionLimit: env.DB_POOL_SIZE,
    // Interpret and write DATETIME values as UTC regardless of the host's timezone.
    timezone: 'Z',
    // Keep DECIMAL as strings — converting money to JS numbers would introduce float error.
    decimalNumbers: false,
    supportBigNumbers: true,
    dateStrings: false,
    waitForConnections: true,
    queueLimit: 0,
  };
}

let pool: Pool | undefined;
let instance: DB | undefined;

/** Number of SQL statements executed since process start (all requests). */
export const dbStats = { queries: 0 };

export function getDb(): DB {
  if (instance) return instance;
  pool = createPool(poolOptions(env.databaseUrl));
  // Force every pooled connection's session clock to UTC so NOW()/UTC_TIMESTAMP agree, and use
  // READ COMMITTED as the session default (bidding sets it explicitly anyway).
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });
  instance = new Kysely<Database>({
    dialect: new MysqlDialect({ pool }),
    log(event) {
      dbStats.queries++;
      const ctx = requestContext.getStore();
      if (ctx) ctx.dbQueries++;
      if (event.level === 'error') {
        logger.debug({ err: event.error, sql: event.query.sql }, 'sql error');
      }
    },
  });
  return instance;
}

export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.destroy();
    instance = undefined;
    pool = undefined;
  }
}

/**
 * Waits for MySQL to accept connections. Docker's MySQL container reports "started" several seconds
 * before it accepts queries, so the API retries with backoff instead of crashing on boot.
 */
export async function waitForDatabase(maxAttempts = 30): Promise<void> {
  const { sql } = await import('kysely');
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`SELECT 1`.execute(getDb());
      return;
    } catch (err) {
      if (attempt >= maxAttempts) throw err;
      const delay = Math.min(500 * attempt, 3000);
      logger.warn({ attempt, delay, err: (err as Error).message }, 'MySQL not ready, retrying');
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** MySQL error numbers worth retrying: the whole transaction can safely be replayed. */
export const RETRYABLE_MYSQL_ERRORS = new Set([
  1213, // ER_LOCK_DEADLOCK — InnoDB chose this transaction as the deadlock victim and rolled it back
  1205, // ER_LOCK_WAIT_TIMEOUT — waited longer than innodb_lock_wait_timeout for a row lock
]);

export function mysqlErrno(err: unknown): number | undefined {
  const e = err as { errno?: number } | null;
  return typeof e?.errno === 'number' ? e.errno : undefined;
}

export function isDuplicateKey(err: unknown, keyName?: string): boolean {
  const e = err as { errno?: number; message?: string } | null;
  if (e?.errno !== 1062) return false; // ER_DUP_ENTRY
  return keyName ? Boolean(e.message?.includes(keyName)) : true;
}
