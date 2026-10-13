import { afterAll, beforeEach } from 'vitest';
import { closeDb } from '../../src/database/db.js';
import { closeRedis } from '../../src/cache/redis.js';
import { resetState } from '../helpers/fixtures.js';

/** Shared per-file lifecycle: clean state before each test, close pools after the file. */
export function useCleanDatabase() {
  beforeEach(async () => {
    await resetState();
  });
  afterAll(async () => {
    await closeRedis();
    await closeDb();
  });
}
