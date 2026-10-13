# Security

## Role–permission matrix

Enforced on the server (`middleware/auth.ts` for roles, services for ownership). Frontend route
guards only hide screens that would fail anyway.

| Action | Anonymous | USER | SELLER | ADMIN |
|---|:-:|:-:|:-:|:-:|
| Browse, search, view public auctions and bid history | ✓ | ✓ | ✓ | ✓ |
| Watch a live auction room (socket) | ✓ | ✓ | ✓ | ✓ |
| View a DRAFT auction | — | — | own only | ✓ |
| Place a bid | — | ✓ | ✓ (not on own lots) | — |
| Watchlist, notifications, own dashboard | — | ✓ | ✓ | ✓ |
| Upload an image | — | ✓ | ✓ | ✓ |
| Create a listing | — | — | ✓ | ✓ |
| Edit a DRAFT/SCHEDULED listing | — | — | own only | ✓ |
| Publish | — | — | own only | ✓ |
| Cancel DRAFT/SCHEDULED, or ACTIVE with no bids | — | — | own only | ✓ |
| Cancel ACTIVE with bids, reject (moderate), feature | — | — | — | ✓ |
| Platform dashboard, user list, audit log, diagnostics | — | — | — | ✓ |
| Suspend/reactivate users, change USER↔SELLER | — | — | — | ✓ (not admins, not self) |

Ownership is checked against the row read under lock (`a.seller_id !== actor.id`), never against an
ID in the request. Per-user resources (`/users/me/*`, notifications, watchlist) have no user ID in the
URL at all; notification updates include `user_id = me` in the `WHERE`, so another user's ID behaves
exactly like a missing one (404).

## Threat model (short)

| Asset | Threat | Mitigation |
|---|---|---|
| Auction integrity | Concurrent bids, late bids, double submission | Row lock + DB-clock window + idempotency key + constraints ([BIDDING_CONCURRENCY.md](BIDDING_CONCURRENCY.md)) |
| Accounts | Credential stuffing / brute force | bcrypt (cost 12), auth rate limit per IP, identical errors & timing for unknown emails |
| Sessions | XSS token theft | Access token only in memory; refresh token HttpOnly; React escapes output; HTML stripped on input |
| Sessions | Stolen refresh token replay | Rotation on every use; reuse of a rotated token revokes the family; audit entry |
| Sessions | CSRF on cookie endpoints | `SameSite=Strict` + required `X-Auctra-CSRF` header (forces CORS preflight) + origin allow-list |
| Authorization | Privilege escalation, IDOR | Server-side `requireRole`; live role/status lookup per request; ownership checks; self-registration cannot pick ADMIN |
| Database | SQL injection | Kysely parameterises everything; the few raw `sql` templates bind values; LIKE wildcards escaped |
| Users | Stored XSS in titles/descriptions | `plainText()` strips tags/control chars; no `dangerouslySetInnerHTML`; CSP via helmet on the API |
| Server | Malicious uploads | 5 MB cap while streaming, one file, type from magic bytes (JPEG/PNG/WebP), SVG refused, random filenames, `nosniff` |
| Server | Abuse / DoS | Global, auth and per-user bid rate limits; 100 kB JSON limit; bounded page sizes |
| Logs | Secret leakage | Pino redaction of auth headers, cookies, passwords, tokens; generic 500 messages with request IDs |
| Config | Dev features in prod | `ENABLE_DEV_ROUTES=true` refuses to start in production; seed refuses in production |

## Implemented controls

- **Passwords:** bcrypt cost 12, 8–72 chars with a letter and a digit (bcrypt ignores bytes past 72).
- **JWT:** HS256 with pinned algorithm, issuer, audience, 15 min expiry; `TOKEN_EXPIRED` distinguished
  from invalid. Secret must be ≥ 32 chars (validated at startup).
- **Refresh tokens:** 32 random bytes, SHA-256 at rest, 7-day expiry, rotation, family revocation,
  30 s multi-tab grace window, cookie `HttpOnly; SameSite=Strict; Path=/api/v1/auth; Secure` (prod).
- **Suspension:** revokes all refresh sessions and blocks the very next request.
- **Validation:** Zod on params, query and body for every route; unknown body keys stripped.
- **Headers:** helmet (CSP, HSTS in HTTPS deployments, frame-ancestors, nosniff, referrer policy).
- **CORS:** explicit origin list from `CORS_ORIGINS`, credentials allowed only for those.
- **Errors:** consistent codes; stack traces and SQL never sent to clients.
- **Audit log:** registrations, token reuse, listing creation/edit/publish, bids, cancellations,
  rejections, featuring, suspensions, role changes, completions.

## Not hardened for public deployment

Be explicit about these in an interview — they're the honest edges of a portfolio project.

- **TLS** is assumed to be terminated by a proxy; there is no HTTPS config in the app.
- **Rate limits are in memory**, per instance; behind a load balancer they need a Redis store, and
  `trust proxy` must be set to the real proxy hop count.
- **No email verification, password reset, MFA, or account lockout** — only rate limiting.
- **Uploads** are stored on local disk and served by the API; production should use object storage
  with a CDN, virus scanning and image re-encoding (stripping metadata).
- **No payment, KYC or fraud checks** (shill bidding, bid shielding) — a real marketplace needs them.
- **JWT secret rotation** (key IDs) is not implemented; changing the secret logs everyone out.
- **CSP for the SPA** is not set by the Vite dev server; production should serve the SPA with a strict CSP.
- **Audit logs** are not tamper-evident and have no retention policy.
- **Dependency audit:** `npm audit` reports a moderate advisory in `uuid@8` pulled in by `autocannon`
  (benchmark tool, dev dependency only; the affected API is not used). Accepted for now.
- **Demo accounts** share a public password; seeding is blocked in production.
