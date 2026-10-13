import type { RequestHandler } from 'express';
import { z, type ZodType } from 'zod';
import { AppError } from '../utils/errors.js';

interface Schemas {
  body?: ZodType;
  query?: ZodType;
  params?: ZodType;
}

/**
 * Validates and coerces request parts with Zod. Parsed values replace the raw ones, so controllers
 * only ever see typed, validated input. Unknown body keys are stripped (Zod default).
 */
export function validateRequest(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { location: string; path: string; message: string }[] = [];
    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location] ?? {});
      if (!result.success) {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      } else if (location === 'query') {
        // Express 5 makes req.query a getter; store the parsed copy separately.
        Object.defineProperty(req, 'query', { value: result.data, writable: true, configurable: true });
      } else {
        (req as unknown as Record<string, unknown>)[location] = result.data;
      }
    }
    if (issues.length) return next(new AppError('VALIDATION_ERROR', 'Request validation failed', issues));
    next();
  };
}

export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});
