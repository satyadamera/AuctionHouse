import { createServer } from 'node:http';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';
import { closeDb, waitForDatabase } from './database/db.js';
import { runMigrations } from './database/migrate.js';
import { closeRedis, getRedis, waitForRedis } from './cache/redis.js';
import { closeSocketServer, createSocketServer } from './sockets/io.js';
import { pruneOutbox, startOutboxDispatcher, stopOutboxDispatcher } from './workers/outboxDispatcher.js';
import { startLifecycleWorker, stopLifecycleWorker } from './workers/lifecycleWorker.js';

async function main() {
  logger.info({ env: env.NODE_ENV }, 'starting Auctra API');
  await waitForDatabase();
  // Apply pending migrations on boot in development so `npm run dev` "just works".
  if (!env.isProduction) await runMigrations(env.databaseUrl, (m) => logger.info(`[migrate] ${m}`));

  getRedis();
  if (!(await waitForRedis(3000))) logger.warn('Redis not reachable at startup — continuing without cache');

  const app = createApp();
  const server = createServer(app);
  createSocketServer(server);

  if (!env.DISABLE_WORKERS) {
    startOutboxDispatcher();
    startLifecycleWorker();
  }
  const pruneTimer = setInterval(() => void pruneOutbox().catch(() => undefined), 3_600_000);

  server.listen(env.PORT, () => {
    logger.info(`API listening on http://localhost:${env.PORT}  (docs: /api/docs, health: /health/ready)`);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(pruneTimer);
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    await stopLifecycleWorker();
    await stopOutboxDispatcher();
    await closeSocketServer(); // also closes the HTTP server
    await closeRedis();
    await closeDb();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
