import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { requestContextMiddleware } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { ok } from './utils/http.js';
import { readiness } from './services/health.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { auctionRouter } from './modules/auctions/auction.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { watchlistRouter } from './modules/watchlist/watchlist.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { categoriesRouter, statsRouter } from './modules/categories/categories.routes.js';
import { uploadsRouter, UPLOAD_DIR } from './modules/uploads/uploads.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';
import { devRouter } from './modules/dev/dev.routes.js';
import { openApiSpec } from './docs/openapi.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SEED_ASSETS = path.resolve(here, '../assets/seed');

/**
 * Middleware order (each request flows top to bottom):
 *  1. request context (request id, query counter)   2. structured access log
 *  3. security headers (helmet)                      4. CORS allow-list
 *  5. body/cookie parsing with size limits           6. global rate limit
 *  7. routers (each route: authenticate → requireRole → validateRequest → handler → service)
 *  8. 404                                            9. central error handler
 */
export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback'); // the Vite dev proxy forwards from localhost

  app.use(requestContextMiddleware);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? 'unknown',
      autoLogging: { ignore: (req) => req.url?.startsWith('/health') === true || req.url?.startsWith('/static') === true },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: { req: (req) => ({ method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
    }),
  );
  app.use(
    helmet({
      // The API serves JSON plus images; the SPA sets its own CSP. Swagger UI needs inline styles.
      contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(cors({ origin: env.corsOrigins, credentials: true, exposedHeaders: ['X-Request-Id', 'X-Cache', 'X-DB-Queries'] }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // Static images: uploaded files and bundled seed artwork. nosniff stops browsers from guessing types.
  const staticOpts = { maxAge: '7d', immutable: true, setHeaders: (res: express.Response) => res.setHeader('X-Content-Type-Options', 'nosniff') };
  app.use('/uploads', express.static(UPLOAD_DIR, staticOpts));
  app.use('/static/seed', express.static(SEED_ASSETS, staticOpts));

  app.get('/health/live', (_req, res) => ok(res, { status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
    const r = await readiness();
    res.status(r.status === 'unavailable' ? 503 : 200).json({ success: r.status !== 'unavailable', data: r });
  });

  app.get('/api/openapi.json', (_req, res) => res.json(openApiSpec));
  app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec as unknown as swaggerUi.JsonObject, { customSiteTitle: 'Auctra API' }));

  const api = express.Router();
  api.use(apiLimiter);
  api.use('/auth', authRouter);
  api.use('/auctions', auctionRouter);
  api.use('/users', usersRouter);
  api.use('/watchlist', watchlistRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/categories', categoriesRouter);
  api.use('/stats', statsRouter);
  api.use('/uploads', uploadsRouter);
  api.use('/admin', adminRouter);
  if (env.ENABLE_DEV_ROUTES) api.use('/dev', devRouter);
  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
