import 'dotenv/config';
import { dropAllTables, runMigrations } from '../../src/database/migrate.js';

/** Runs once before the integration suites: a clean, fully migrated test database. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL is not set (see backend/.env.example)');
  if (!/test/i.test(url)) throw new Error(`Refusing to wipe a database whose URL does not contain "test": ${url}`);
  await dropAllTables(url);
  await runMigrations(url);
}
