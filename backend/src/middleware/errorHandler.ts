import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';
import { currentRequestId } from '../utils/requestContext.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError('NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

/**
 * Central error handler. Known AppErrors become structured JSON with their code and status.
 * Anything unexpected is logged in full server-side but returned to the client as a generic
 * INTERNAL_ERROR, so stack traces and SQL never leak.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = currentRequestId() ?? (req as { id?: string }).id;
  let appError: AppError;

  if (err instanceof AppError) {
    appError = err;
  } else if (err?.type === 'entity.parse.failed') {
    appError = new AppError('VALIDATION_ERROR', 'Malformed JSON body');
  } else if (err?.type === 'entity.too.large') {
    appError = new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
  } else if (err?.code === 'LIMIT_FILE_SIZE') {
    appError = new AppError('PAYLOAD_TOO_LARGE', 'Image exceeds the 5 MB limit');
  } else if (err?.code === 'LIMIT_FILE_COUNT' || err?.code === 'LIMIT_UNEXPECTED_FILE') {
    appError = new AppError('VALIDATION_ERROR', 'Too many files or unexpected field');
  } else {
    logger.error({ err, requestId, method: req.method, path: req.path }, 'unhandled error');
    appError = new AppError(
      'INTERNAL_ERROR',
      env.isProduction ? 'Something went wrong' : `Internal error: ${(err as Error)?.message ?? 'unknown'}`,
    );
  }

  if (appError.status >= 500 && err instanceof AppError) {
    logger.error({ code: appError.code, requestId }, appError.message);
  }

  res.status(appError.status).json({
    success: false,
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
      requestId,
    },
  });
};
