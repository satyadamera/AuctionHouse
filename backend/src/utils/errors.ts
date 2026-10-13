/**
 * Every error the API returns has a stable machine-readable `code`. Clients branch on the code,
 * never on the human message (which may change or be localised).
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 400,
  INVALID_BID_AMOUNT: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  TOKEN_EXPIRED: 401,
  INVALID_REFRESH_TOKEN: 401,
  FORBIDDEN: 403,
  CSRF_CHECK_FAILED: 403,
  ACCOUNT_SUSPENDED: 403,
  NOT_FOUND: 404,
  AUCTION_NOT_FOUND: 404,
  EMAIL_IN_USE: 409,
  INVALID_STATE_TRANSITION: 409,
  AUCTION_NOT_ACTIVE: 409,
  AUCTION_NOT_STARTED: 409,
  AUCTION_ENDED: 409,
  BID_TOO_LOW: 409,
  SELF_BIDDING_NOT_ALLOWED: 403,
  IDEMPOTENCY_KEY_REUSED: 422,
  UNSUPPORTED_MEDIA_TYPE: 415,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  CONFLICT_RETRY_EXHAUSTED: 503,
  SERVICE_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ErrorCodes[code];
  }
}

export const notFound = (what = 'Resource') => new AppError('NOT_FOUND', `${what} not found`);
export const forbidden = (msg = 'You do not have permission to perform this action') =>
  new AppError('FORBIDDEN', msg);
