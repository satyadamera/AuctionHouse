import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';

/**
 * Minimal, transparent migration runner.
 *
 * - Migrations are plain .sql files in database/migrations, applied in filename order.
 * - Applied names are recorded in `schema_migrations`, so `migrate` is idempotent.
 * - MySQL DDL statements commit implicitly, so a migration is not atomic: keep each file small and
 *   additive. A failed migration stops the run and is not recorded.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = path.resolve(here, '../../database/migrations');

export async function runMigrations(databaseUrl: string, log: (m: string) => void = () => {}) {
  const conn = await createConnection({ uri: databaseUrl, multipleStatements: true, timezone: 'Z' });
  try {
    await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(191) NOT NULL PRIMARY KEY,
      applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
    ) ENGINE=InnoDB`);
    const [rows] = await conn.query('SELECT name FROM schema_migrations');
    const applied = new Set((rows as { name: string }[]).map((r) => r.name));
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    let count = 0;
    for (const file of files) {
      if (applied.has(file)) continue;
      const body = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log(`applying ${file}`);
      await conn.query(body);
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      count++;
    }
    log(count ? `applied ${count} migration(s)` : 'database is up to date');
    return count;
  } finally {
    await conn.end();
  }
}

/** Drops every table in the target database. Used by db:reset and the test suites only. */
export async function dropAllTables(databaseUrl: string) {
  const conn = await createConnection({ uri: databaseUrl, multipleStatements: true });
  try {
    const [rows] = await conn.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()',
    );
    const tables = (rows as { t: string }[]).map((r) => r.t);
    if (tables.length) {
      await conn.query(
        `SET FOREIGN_KEY_CHECKS=0; DROP TABLE ${tables.map((t) => `\`${t}\``).join(', ')}; SET FOREIGN_KEY_CHECKS=1;`,
      );
    }
  } finally {
    await conn.end();
  }
}
