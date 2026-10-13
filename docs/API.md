# REST API

Base URL `http://localhost:4000/api/v1` (or `/api/v1` through the Vite proxy). Interactive docs:
`http://localhost:4000/api/docs`. Spec source: [`backend/src/docs/openapi.ts`](../backend/src/docs/openapi.ts).

## Conventions

- **Success:** `{ "success": true, "data": …, "meta"?: { page, pageSize, total, totalPages, serverTime, … } }`
- **Error:** `{ "success": false, "error": { "code", "message", "details"?, "requestId" } }` — branch on `code`.
- **Money:** decimal strings in INR with 2 dp (`"10500.00"`). Requests accept strings or numbers.
- **Time:** ISO-8601 UTC.
- **Auth:** `Authorization: Bearer <accessToken>`. Refresh/logout use the `auctra_rt` cookie and the
  `X-Auctra-CSRF: 1` header.
- **Diagnostics headers:** `X-Request-Id` (send your own to correlate), `X-DB-Queries`, `X-Cache`, `Server-Timing`.
- **Rate limits:** auth routes per IP, bids per user, plus a global per-IP limit. `429 RATE_LIMITED`
  with `RateLimit*` headers.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/auth/register` | — | `{ name, email, password, role?: USER\|SELLER }` → 201 session |
| POST | `/auth/login` | — | → session; sets refresh cookie |
| POST | `/auth/refresh` | cookie + CSRF header | rotates cookie, new access token |
| POST | `/auth/logout` | cookie + CSRF header | revokes this login's token family |
| GET | `/auth/me` | user | current user |
| GET | `/auctions` | — | `q, category, status (ACTIVE\|SCHEDULED\|COMPLETED\|ALL), minPrice, maxPrice, sort (ending_soon\|newest\|price_asc\|price_desc\|most_bids), featured, sellerId, page, pageSize` |
| GET | `/auctions/featured` | — | featured live/scheduled lots |
| GET | `/auctions/:id` | optional | detail; drafts only for owner/admin (else 404) |
| POST | `/auctions` | seller | create (DRAFT, or publish with `publish: true`) |
| PATCH | `/auctions/:id` | seller (owner) / admin | DRAFT or SCHEDULED only |
| POST | `/auctions/:id/publish` | seller (owner) / admin | → SCHEDULED or ACTIVE |
| POST | `/auctions/:id/cancel` | seller (owner) | `{ reason }`; DRAFT/SCHEDULED, or ACTIVE with no bids |
| GET | `/auctions/:id/bids` | — | newest first, `limit`, `before=<bidId>` |
| POST | `/auctions/:id/bids` | user/seller | `{ amount, clientRequestId }` → 201 new / 200 replay |
| GET / PATCH | `/users/me` | user | profile; PATCH `{ name?, avatarUrl? }` |
| GET | `/users/me/bids` | user | lots I bid on + `position` |
| GET | `/users/me/won-auctions` | user | |
| GET | `/users/me/listings` | seller | `status?` |
| GET | `/users/me/seller-stats` | seller | counts, revenue, daily bids |
| GET | `/watchlist`, `/watchlist/ids` | user | |
| POST / DELETE | `/watchlist/:auctionId` | user | idempotent |
| GET | `/notifications` | user | `page, pageSize, unreadOnly`; `meta.unreadCount` |
| PATCH | `/notifications/:id/read`, `/notifications/read-all` | user | 404 for others' ids |
| GET | `/categories` | — | with live counts |
| GET | `/stats/public` | — | live lots, bids in 24 h, sold, members |
| POST | `/uploads/images` | user | multipart `image`, JPEG/PNG/WebP ≤ 5 MB → `{ url }` |
| GET | `/admin/dashboard`, `/admin/users`, `/admin/auctions`, `/admin/audit-logs`, `/admin/diagnostics` | admin | |
| PATCH | `/admin/users/:id/status`, `/admin/users/:id/role` | admin | suspend/reactivate; USER↔SELLER |
| POST | `/admin/auctions/:id/cancel`, `/admin/auctions/:id/reject` | admin | `{ reason }` |
| PATCH | `/admin/auctions/:id/feature` | admin | `{ isFeatured }` |
| * | `/dev/*` | varies | **development only** (`ENABLE_DEV_ROUTES=true`): demo auction, end-now, lifecycle run, cache metrics/clear, diagnostics |

Health (outside `/api/v1`): `GET /health/live`, `GET /health/ready` (MySQL required, Redis optional → `degraded`).

## Example: placing a bid

```http
POST /api/v1/auctions/5/bids
Authorization: Bearer eyJhbGciOi…
Content-Type: application/json

{ "amount": "32000.00", "clientRequestId": "3f1c2a8e-6c7b-4f0e-9d1a-0b6f0c5e9a11" }
```

```json
HTTP/1.1 201 Created
{
  "success": true,
  "data": {
    "bid": { "id": 141, "amount": "32000.00", "bidder": { "id": 4, "name": "Aarav M." }, "createdAt": "2026-10-13T07:27:08.052Z" },
    "state": { "status": "ACTIVE", "currentHighestBid": "32000.00", "currentHighestBidder": { "id": 4, "name": "Aarav M." },
               "minimumNextBid": "32500.00", "bidCount": 10, "endTime": "2026-10-13T08:31:00.000Z" },
    "version": 11,
    "replayed": false,
    "extended": false
  }
}
```

Retrying the same request returns **200** with `"replayed": true` and the same `bid.id`.

## Bid errors

| Case | Status | `code` | `details` |
|---|---|---|---|
| Not a number / ≤ 0 / > 2 dp / too large | 400 | `INVALID_BID_AMOUNT` | |
| Malformed body or `clientRequestId` | 400 | `VALIDATION_ERROR` | `[{ location, path, message }]` |
| No/invalid token | 401 | `UNAUTHENTICATED` / `TOKEN_EXPIRED` | |
| Own auction | 403 | `SELF_BIDDING_NOT_ALLOWED` | |
| Admin bidding | 403 | `FORBIDDEN` | |
| Suspended account | 403 | `ACCOUNT_SUSPENDED` | |
| Auction missing | 404 | `AUCTION_NOT_FOUND` | |
| Below minimum | 409 | `BID_TOO_LOW` | `{ minimumNextBid, currentHighestBid, version }` |
| Not yet open | 409 | `AUCTION_NOT_STARTED` | `{ startTime }` |
| At/after end, or completed | 409 | `AUCTION_ENDED` | `{ endTime }` |
| Draft or cancelled | 409 | `AUCTION_NOT_ACTIVE` | |
| Key reused for a different bid | 422 | `IDEMPOTENCY_KEY_REUSED` | `{ originalAuctionId, originalAmount }` |
| Too many bids | 429 | `RATE_LIMITED` | |
| Deadlock retries exhausted | 503 | `CONFLICT_RETRY_EXHAUSTED` | safe to retry with the same key |

```json
HTTP/1.1 409 Conflict
{ "success": false, "error": { "code": "BID_TOO_LOW", "message": "Bid must be at least ₹1,16,000.00",
  "details": { "minimumNextBid": "116000.00", "currentHighestBid": "115000.00", "version": 13 },
  "requestId": "25df61ef-61b8-4ddc-90df-2bb1b9248884" } }
```

## Other error codes

`EMAIL_IN_USE` (409), `INVALID_CREDENTIALS` (401), `INVALID_REFRESH_TOKEN` (401), `CSRF_CHECK_FAILED`
(403), `FORBIDDEN` (403), `NOT_FOUND` (404), `INVALID_STATE_TRANSITION` (409),
`UNSUPPORTED_MEDIA_TYPE` (415), `PAYLOAD_TOO_LARGE` (413), `INTERNAL_ERROR` (500 — message is generic
in production; details are in the server log under the same `requestId`).
