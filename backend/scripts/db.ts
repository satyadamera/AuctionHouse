/**
 * CLI: npm run db:migrate | db:reset (reset = drop all tables, migrate, seed).
 * Refuses to reset in production.
 */
import { env } from '../src/config/env.js';
import { dropAllTables, runMigrations } from '../src/database/migrate.js';

const cmd = process.argv[2];
const url = env.databaseUrl;
const redacted = url.replace(/\/\/([^:]+):[^@]+@/, '//$1:***@');

async function main() {
  if (cmd === 'migrate') {
    console.log(`[db] migrating ${redacted}`);
    await runMigrations(url, (m) => console.log(`[db] ${m}`));
  } else if (cmd === 'reset') {
    if (env.isProduction) throw new Error('db:reset is disabled in production');
    console.log(`[db] dropping all tables in ${redacted}`);
    await dropAllTables(url);
    await runMigrations(url, (m) => console.log(`[db] ${m}`));
  } else {
    throw new Error(`unknown command: ${cmd}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
