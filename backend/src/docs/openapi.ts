/**
 * OpenAPI 3.1 description of the REST API, served at /api/docs (Swagger UI) and /api/openapi.json.
 * Kept next to the code and checked by tests/integration/openapi.test.ts, which asserts that every
 * documented path is actually routed.
 */
const money = { type: 'string', pattern: '^\\d+\\.\\d{2}$', example: '10500.00', description: 'INR, 2 decimal places' };
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const okEnvelope = (data: object, meta = false) => ({
  type: 'object',
  properties: { success: { const: true }, data, ...(meta ? { meta: { type: 'object' } } : {}) },
});
const json = (schema: object) => ({ content: { 'application/json': { schema } } });
const err = (description: string) => ({ description, ...json(ref('Error')) });
const auth = [{ bearer: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } };

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Auctra API',
    version: '1.0.0',
    description:
      'Real-time auction platform API. All responses use `{ success, data, meta? }` or `{ success: false, error: { code, message, details?, requestId } }`. ' +
      'Money is a decimal string in INR. Timestamps are ISO-8601 UTC. Live updates are delivered over Socket.IO (see docs/REDIS_WEBSOCKETS.md).',
  },
  servers: [{ url: '/api/v1' }],
  components: {
    securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          success: { const: false },
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: {
                type: 'string',
                enum: [
                  'VALIDATION_ERROR', 'INVALID_BID_AMOUNT', 'UNAUTHENTICATED', 'INVALID_CREDENTIALS', 'TOKEN_EXPIRED', 'INVALID_REFRESH_TOKEN',
                  'FORBIDDEN', 'CSRF_CHECK_FAILED', 'ACCOUNT_SUSPENDED', 'NOT_FOUND', 'AUCTION_NOT_FOUND', 'EMAIL_IN_USE',
                  'INVALID_STATE_TRANSITION', 'AUCTION_NOT_ACTIVE', 'AUCTION_NOT_STARTED', 'AUCTION_ENDED', 'BID_TOO_LOW',
                  'SELF_BIDDING_NOT_ALLOWED', 'IDEMPOTENCY_KEY_REUSED', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED',
                  'CONFLICT_RETRY_EXHAUSTED', 'SERVICE_UNAVAILABLE', 'INTERNAL_ERROR',
                ],
              },
              message: { type: 'string' },
              details: {},
              requestId: { type: 'string' },
            },
          },
        },
      },
      User: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, name: { type: 'string' }, email: { type: 'string' },
          role: { enum: ['USER', 'SELLER', 'ADMIN'] }, avatarUrl: { type: ['string', 'null'] },
          status: { enum: ['ACTIVE', 'SUSPENDED'] }, createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Session: {
        type: 'object',
        properties: { user: ref('User'), accessToken: { type: 'string' }, expiresIn: { type: 'integer', description: 'seconds' } },
        description: 'The refresh token is set as an HttpOnly cookie `auctra_rt` (path /api/v1/auth), never returned in the body.',
      },
      AuctionStatus: { enum: ['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] },
      AuctionSummary: {
        type: 'object',
        properties: {
          id: { type: 'integer' }, title: { type: 'string' }, status: ref('AuctionStatus'),
          category: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, slug: { type: 'string' } } },
          seller: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } },
          coverImage: { type: ['string', 'null'] }, startingPrice: money, currentHighestBid: { ...money, type: ['string', 'null'] },
          minimumNextBid: money, bidCount: { type: 'integer' }, startTime: { type: 'string', format: 'date-time' },
          endTime: { type: 'string', format: 'date-time' }, isFeatured: { type: 'boolean' }, version: { type: 'integer' },
        },
      },
      AuctionDetail: {
        allOf: [
          ref('AuctionSummary'),
          {
            type: 'object',
            properties: {
              description: { type: 'string' }, minimumBidIncrement: money, originalEndTime: { type: 'string', format: 'date-time' },
              images: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, url: { type: 'string' }, alt: { type: ['string', 'null'] } } } },
              currentHighestBidder: { type: ['object', 'null'] }, winner: { type: ['object', 'null'] },
              finalPrice: { type: ['string', 'null'] }, cancelReason: { type: ['string', 'null'] }, completedAt: { type: ['string', 'null'] },
            },
          },
        ],
      },
      Bid: {
        type: 'object',
        properties: { id: { type: 'integer' }, amount: money, bidder: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } }, createdAt: { type: 'string', format: 'date-time' } },
      },
      PlaceBidRequest: {
        type: 'object',
        required: ['amount', 'clientRequestId'],
        properties: {
          amount: { type: 'string', example: '10500.00', description: 'Positive, at most 2 decimal places' },
          clientRequestId: { type: 'string', example: '3f1c2a8e-6c7b-4f0e-9d1a-0b6f0c5e9a11', description: 'Idempotency key; reuse it when retrying the same bid' },
        },
      },
      PlaceBidResult: {
        type: 'object',
        properties: {
          bid: ref('Bid'),
          state: { type: 'object', properties: { status: ref('AuctionStatus'), currentHighestBid: money, minimumNextBid: money, bidCount: { type: 'integer' }, endTime: { type: 'string' } } },
          version: { type: 'integer' }, replayed: { type: 'boolean' }, extended: { type: 'boolean' },
        },
      },
      CreateAuction: {
        type: 'object',
        required: ['title', 'description', 'categoryId', 'startingPrice', 'minimumBidIncrement', 'startTime', 'endTime'],
        properties: {
          title: { type: 'string', minLength: 3, maxLength: 120 }, description: { type: 'string', minLength: 10, maxLength: 5000 },
          categoryId: { type: 'integer' }, startingPrice: { type: 'string' }, minimumBidIncrement: { type: 'string' },
          startTime: { type: 'string', format: 'date-time' }, endTime: { type: 'string', format: 'date-time' },
          imageUrls: { type: 'array', items: { type: 'string' }, maxItems: 8 }, publish: { type: 'boolean', default: false },
        },
      },
      Notification: {
        type: 'object',
        properties: { id: { type: 'integer' }, type: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' }, auctionId: { type: ['integer', 'null'] }, isRead: { type: 'boolean' }, createdAt: { type: 'string' } },
      },
    },
  },
  paths: {
    '/auth/register': {
      post: {
        tags: ['Auth'], summary: 'Create an account (role USER or SELLER)',
        requestBody: json({ type: 'object', required: ['name', 'email', 'password'], properties: { name: { type: 'string' }, email: { type: 'string' }, password: { type: 'string', minLength: 8 }, role: { enum: ['USER', 'SELLER'] } } }),
        responses: { 201: { description: 'Registered and signed in', ...json(okEnvelope(ref('Session'))) }, 400: err('Validation error'), 409: err('EMAIL_IN_USE'), 429: err('RATE_LIMITED') },
      },
    },
    '/auth/login': {
      post: {
        tags: ['Auth'], summary: 'Sign in',
        requestBody: json({ type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } }),
        responses: { 200: { description: 'Signed in', ...json(okEnvelope(ref('Session'))) }, 401: err('INVALID_CREDENTIALS'), 403: err('ACCOUNT_SUSPENDED'), 429: err('RATE_LIMITED') },
      },
    },
    '/auth/refresh': {
      post: {
        tags: ['Auth'], summary: 'Rotate the refresh cookie and get a new access token',
        parameters: [{ name: 'X-Auctra-CSRF', in: 'header', required: true, schema: { const: '1' } }],
        responses: { 200: { description: 'New session', ...json(okEnvelope(ref('Session'))) }, 401: err('INVALID_REFRESH_TOKEN'), 403: err('CSRF_CHECK_FAILED') },
      },
    },
    '/auth/logout': {
      post: { tags: ['Auth'], summary: 'Revoke this login (token family) and clear the cookie', parameters: [{ name: 'X-Auctra-CSRF', in: 'header', required: true, schema: { const: '1' } }], responses: { 200: { description: 'Logged out' } } },
    },
    '/auth/me': { get: { tags: ['Auth'], security: auth, summary: 'Current user', responses: { 200: { description: 'User', ...json(okEnvelope(ref('User'))) }, 401: err('UNAUTHENTICATED') } } },
    '/auctions': {
      get: {
        tags: ['Auctions'], summary: 'Browse auctions (cached briefly in Redis)',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' }, description: 'category slug' },
          { name: 'status', in: 'query', schema: { enum: ['ACTIVE', 'SCHEDULED', 'COMPLETED', 'ALL'], default: 'ACTIVE' } },
          { name: 'minPrice', in: 'query', schema: { type: 'number' } },
          { name: 'maxPrice', in: 'query', schema: { type: 'number' } },
          { name: 'sort', in: 'query', schema: { enum: ['ending_soon', 'newest', 'price_asc', 'price_desc', 'most_bids'], default: 'ending_soon' } },
          { name: 'featured', in: 'query', schema: { enum: ['true', 'false'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 12, maximum: 48 } },
        ],
        responses: { 200: { description: 'Page of auctions; meta has page, pageSize, total, totalPages, serverTime', ...json(okEnvelope({ type: 'array', items: ref('AuctionSummary') }, true)) } },
      },
      post: {
        tags: ['Auctions'], security: auth, summary: 'Create an auction (SELLER). Saved as DRAFT unless publish=true',
        requestBody: json(ref('CreateAuction')),
        responses: { 201: { description: 'Created', ...json(okEnvelope(ref('AuctionDetail'))) }, 400: err('Validation error'), 403: err('FORBIDDEN (not a seller)') },
      },
    },
    '/auctions/featured': { get: { tags: ['Auctions'], summary: 'Featured live/scheduled auctions (cached)', responses: { 200: { description: 'Auctions', ...json(okEnvelope({ type: 'array', items: ref('AuctionSummary') })) } } } },
    '/auctions/{id}': {
      get: {
        tags: ['Auctions'], summary: 'Auction detail (versioned cache-aside). Response headers: X-Cache, X-DB-Queries', parameters: [idParam],
        responses: { 200: { description: 'Detail; meta.serverTime lets the client correct its countdown', ...json(okEnvelope(ref('AuctionDetail'), true)) }, 404: err('AUCTION_NOT_FOUND') },
      },
      patch: {
        tags: ['Auctions'], security: auth, summary: 'Edit own DRAFT/SCHEDULED auction', parameters: [idParam], requestBody: json(ref('CreateAuction')),
        responses: { 200: { description: 'Updated' }, 403: err('FORBIDDEN (not owner)'), 409: err('INVALID_STATE_TRANSITION') },
      },
    },
    '/auctions/{id}/publish': { post: { tags: ['Auctions'], security: auth, summary: 'DRAFT → SCHEDULED or ACTIVE', parameters: [idParam], responses: { 200: { description: 'Published' }, 403: err('FORBIDDEN'), 409: err('INVALID_STATE_TRANSITION') } } },
    '/auctions/{id}/cancel': {
      post: {
        tags: ['Auctions'], security: auth, summary: 'Seller cancels own auction (DRAFT/SCHEDULED, or ACTIVE with no bids)', parameters: [idParam],
        requestBody: json({ type: 'object', required: ['reason'], properties: { reason: { type: 'string', minLength: 5 } } }),
        responses: { 200: { description: 'Cancelled' }, 403: err('FORBIDDEN'), 409: err('INVALID_STATE_TRANSITION') },
      },
    },
    '/auctions/{id}/bids': {
      get: {
        tags: ['Bidding'], summary: 'Bid history, newest first (cursor: before=<bidId>)',
        parameters: [idParam, { name: 'limit', in: 'query', schema: { type: 'integer', default: 30 } }, { name: 'before', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'Bids', ...json(okEnvelope({ type: 'array', items: ref('Bid') }, true)) } },
      },
      post: {
        tags: ['Bidding'], security: auth, summary: 'Place a bid (transaction + SELECT … FOR UPDATE). Idempotent per clientRequestId', parameters: [idParam],
        requestBody: json(ref('PlaceBidRequest')),
        responses: {
          201: { description: 'Bid accepted', ...json(okEnvelope(ref('PlaceBidResult'))) },
          200: { description: 'Idempotent replay of an already-accepted bid (replayed=true)', ...json(okEnvelope(ref('PlaceBidResult'))) },
          400: err('INVALID_BID_AMOUNT / VALIDATION_ERROR'), 401: err('UNAUTHENTICATED'), 403: err('SELF_BIDDING_NOT_ALLOWED'),
          404: err('AUCTION_NOT_FOUND'), 409: err('BID_TOO_LOW (details.minimumNextBid) / AUCTION_ENDED / AUCTION_NOT_STARTED / AUCTION_NOT_ACTIVE'),
          422: err('IDEMPOTENCY_KEY_REUSED'), 429: err('RATE_LIMITED'), 503: err('CONFLICT_RETRY_EXHAUSTED'),
        },
      },
    },
    '/users/me': {
      get: { tags: ['Users'], security: auth, summary: 'My profile', responses: { 200: { description: 'User' } } },
      patch: { tags: ['Users'], security: auth, summary: 'Update name/avatar', requestBody: json({ type: 'object', properties: { name: { type: 'string' }, avatarUrl: { type: ['string', 'null'] } } }), responses: { 200: { description: 'User' } } },
    },
    '/users/me/bids': { get: { tags: ['Users'], security: auth, summary: 'Auctions I bid on, with position WINNING/OUTBID/WON/LOST/CANCELLED', responses: { 200: { description: 'List' } } } },
    '/users/me/won-auctions': { get: { tags: ['Users'], security: auth, summary: 'Auctions I won', responses: { 200: { description: 'List' } } } },
    '/users/me/listings': { get: { tags: ['Users'], security: auth, summary: 'My listings (SELLER)', parameters: [{ name: 'status', in: 'query', schema: ref('AuctionStatus') }], responses: { 200: { description: 'List' } } } },
    '/users/me/seller-stats': { get: { tags: ['Users'], security: auth, summary: 'Seller dashboard statistics (SELLER)', responses: { 200: { description: 'Stats' } } } },
    '/watchlist': { get: { tags: ['Watchlist'], security: auth, summary: 'My watchlist', responses: { 200: { description: 'List' } } } },
    '/watchlist/ids': { get: { tags: ['Watchlist'], security: auth, summary: 'Ids of watched auctions', responses: { 200: { description: 'Ids' } } } },
    '/watchlist/{auctionId}': {
      post: { tags: ['Watchlist'], security: auth, summary: 'Watch (idempotent)', parameters: [{ ...idParam, name: 'auctionId' }], responses: { 200: { description: 'Watching' } } },
      delete: { tags: ['Watchlist'], security: auth, summary: 'Unwatch (idempotent)', parameters: [{ ...idParam, name: 'auctionId' }], responses: { 200: { description: 'Not watching' } } },
    },
    '/notifications': {
      get: {
        tags: ['Notifications'], security: auth, summary: 'My notifications (meta.unreadCount)',
        parameters: [{ name: 'unreadOnly', in: 'query', schema: { enum: ['true', 'false'] } }, { name: 'page', in: 'query', schema: { type: 'integer' } }],
        responses: { 200: { description: 'List', ...json(okEnvelope({ type: 'array', items: ref('Notification') }, true)) } },
      },
    },
    '/notifications/{id}/read': { patch: { tags: ['Notifications'], security: auth, summary: 'Mark one read (404 if not mine)', parameters: [idParam], responses: { 200: { description: 'OK' }, 404: err('NOT_FOUND') } } },
    '/notifications/read-all': { patch: { tags: ['Notifications'], security: auth, summary: 'Mark all read', responses: { 200: { description: 'OK' } } } },
    '/categories': { get: { tags: ['Catalog'], summary: 'Categories with live counts (cached)', responses: { 200: { description: 'List' } } } },
    '/stats/public': { get: { tags: ['Catalog'], summary: 'Public marketplace stats (cached)', responses: { 200: { description: 'Stats' } } } },
    '/uploads/images': {
      post: {
        tags: ['Uploads'], security: auth, summary: 'Upload a JPEG/PNG/WebP (≤5 MB). Returns a URL usable in imageUrls',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { image: { type: 'string', format: 'binary' } } } } } },
        responses: { 201: { description: 'Uploaded' }, 413: err('PAYLOAD_TOO_LARGE'), 415: err('UNSUPPORTED_MEDIA_TYPE') },
      },
    },
    '/admin/dashboard': { get: { tags: ['Admin'], security: auth, summary: 'Platform statistics (ADMIN)', responses: { 200: { description: 'Stats' }, 403: err('FORBIDDEN') } } },
    '/admin/users': { get: { tags: ['Admin'], security: auth, summary: 'Search users (ADMIN)', responses: { 200: { description: 'Users' } } } },
    '/admin/users/{id}/status': {
      patch: { tags: ['Admin'], security: auth, summary: 'Suspend / reactivate a user (revokes sessions)', parameters: [idParam], requestBody: json({ type: 'object', properties: { status: { enum: ['ACTIVE', 'SUSPENDED'] }, reason: { type: 'string' } } }), responses: { 200: { description: 'Updated' } } },
    },
    '/admin/users/{id}/role': { patch: { tags: ['Admin'], security: auth, summary: 'Change role USER ↔ SELLER', parameters: [idParam], responses: { 200: { description: 'Updated' } } } },
    '/admin/auctions': { get: { tags: ['Admin'], security: auth, summary: 'All auctions incl. drafts (ADMIN)', responses: { 200: { description: 'Auctions' } } } },
    '/admin/auctions/{id}/cancel': { post: { tags: ['Admin'], security: auth, summary: 'Cancel any non-terminal auction with a reason', parameters: [idParam], responses: { 200: { description: 'Cancelled' } } } },
    '/admin/auctions/{id}/reject': { post: { tags: ['Admin'], security: auth, summary: 'Moderation: reject a listing (cancels it, notifies seller)', parameters: [idParam], responses: { 200: { description: 'Rejected' } } } },
    '/admin/auctions/{id}/feature': { patch: { tags: ['Admin'], security: auth, summary: 'Feature / unfeature', parameters: [idParam], responses: { 200: { description: 'Updated' } } } },
    '/admin/audit-logs': { get: { tags: ['Admin'], security: auth, summary: 'Audit trail', responses: { 200: { description: 'Entries' } } } },
    '/admin/diagnostics': { get: { tags: ['Admin'], security: auth, summary: 'Cache hit rate, outbox backlog, dependency health', responses: { 200: { description: 'Diagnostics' } } } },
  },
} as const;
