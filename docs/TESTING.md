# Testing

| Command | Suite | Needs |
|---|---|---|
| `npm run test` | backend unit + frontend component | nothing |
| `npm run test:integration` | backend API/cache/lifecycle/socket | MySQL + Redis (`TEST_DATABASE_URL`, `TEST_REDIS_URL`) |
| `npm run test:concurrency` | real-lock races and deadlocks | MySQL + Redis |
| `npm run test:all` | everything above | MySQL + Redis |
| `npm run test:e2e` | Playwright browser tests | `npm run dev` running, seeded DB, dev routes on |

The integration config ([`vitest.integration.config.ts`](../backend/vitest.integration.config.ts))
drops and re-migrates the **test** database once (refusing any URL without "test" in it), runs files
one at a time, and every test starts from empty tables and an empty Redis DB 15. Workers are disabled
so tests drive `runLifecycleOnce()` / `closeAuction()` / the dispatcher explicitly.

## Results from the build environment

| Suite | Files | Tests | Result |
|---|---:|---:|---|
| Backend unit | 4 | 50 | all pass |
| Backend integration | 8 | 75 | all pass |
| Concurrency | 2 | 17 | all pass |
| Frontend component | 3 | 16 | all pass |
| Playwright E2E | 1 | 3 | all pass (Chromium) |

Environment: Node 22.22, MySQL 8.0.46, Redis 7.0.15, Linux, 2 vCPU.

## What the important tests prove

**Concurrency** (`tests/concurrency/bidding-race.test.ts`)

- *A locks first / B locks first* — a test hook (`bidTestHooks.afterLock`, active only in
  `NODE_ENV=test`) pauses one transaction **while it holds the row lock**. The test asserts the other
  request has **not** completed after 400 ms (it's blocked on `FOR UPDATE`), releases the first, and
  checks the outcome: both succeed (10,500 → 11,000) or the lower is rejected. Both orderings are
  forced deterministically.
- *Uncontrolled, 25 repetitions* — the same pair fired with `Promise.all`; any legal ordering is
  accepted, invariants checked every time. The test never assumes who wins.
- *20 / 50 / 100 bidders* — every 201 matches exactly one stored row, rejected requests stored
  nothing, rejections are only `BID_TOO_LOW`, bids strictly increase, summary = MAX(bids),
  `version = 1 + accepted`.
- *Equal bids* — exactly one wins. *Ten concurrent retries of one key* — one bid row. *Same key on two
  auctions* — the unique index lets one through.
- *Different auctions don't block each other* — proves the lock is per row.
- *Bid vs close* — both orderings forced, plus 30 bids racing a closing loop across the end time.
- *DB clock boundary* — a bid after `end_time` is refused even though the API process's clock is not
  consulted.

**Deadlocks** (`deadlock-retry.test.ts`) — a genuine InnoDB deadlock (opposite lock order + barrier)
recovered by `withTransactionRetry`; bounded attempts return 503; business errors are not retried.

**The suite has teeth.** Removing `FOR UPDATE` from `lockAuction()` makes 7 of the 14 race tests fail
(both forced orderings, the uncontrolled race, all three contention sizes, bid-vs-close).

**Integration highlights** — refresh rotation and family revocation after reuse; CSRF header
required; suspended users blocked on existing tokens; self-registration as ADMIN refused; IDOR on
edit/publish/cancel; drafts hidden (404); seller cancel rules; admin-only routes return 403 for USER
and SELLER; bid validation matrix (amount formats, below minimum with server-computed threshold, own
auction, admin, ended-but-not-closed, completed, cancelled, not started, lazy activation);
idempotent replay and key reuse; per-bidder key scope; transactional notifications/outbox/audit on a
bid; lifecycle (activate, close with winner and notifications, no-bid close, restart recovery,
ending-soon once, eight concurrent closers, summary repair); cache MISS→HIT (0 SQL)→invalidation→fresh,
stale-write refusal, newer-snapshot protection, Redis outage fallback, list generation; upload
magic-byte and size checks; every OpenAPI path routed; request IDs on errors.

**WebSocket** (`websocket.test.ts`) — anonymous viewers receive committed bids with version and event
ID; no cross-room leakage; `OUTBID` reaches only the outbid user's room; `auction:ended` carries the
winner; bad tokens rejected; drafts private; viewer counts and duplicate joins; after reconnecting, the
join ack's version reveals missed events and REST returns the current state.

**Frontend** — the version reducer (apply / stale / duplicate / gap / ended), exact paise arithmetic,
INR formatting, countdown formatting, and the bid panel (anonymous state, client-side minimum check
without an API call, confirm → request carries the idempotency key, `BID_TOO_LOW` shows the server's
new minimum, sellers can't bid on their own lot).

**E2E** (`frontend/e2e/live-bidding.spec.ts`) — two separate browser contexts on one lot: A's bid
appears on B's screen without reload; B outbids; A sees the outbid state and toast; both show the same
price and two history rows; the REST API agrees. Plus server-side rejection of a low bid and the
seller-only route guard.

## What the tests do not prove

- Behaviour across **multiple API instances** (rooms are per process; the Redis adapter isn't built).
- Network partitions between the API and MySQL mid-transaction (MySQL rolls back on disconnect, but
  this is not simulated).
- Performance at production scale; the benchmark ran on one small VM.
- Exactly-once socket delivery — by design it's at-least-once.
- Cross-browser rendering (E2E ran on Chromium only) and screen-reader behaviour (semantic markup and
  aria attributes are in place but not audited with assistive technology).

## Interpreting failures

- `TEST_DATABASE_URL is not set` / connection refused → start Docker (`docker compose up -d`) and copy
  `.env.example` to `backend/.env`.
- `Access denied … to database 'auctra_test'` → the test DB user needs DDL rights (the Docker init
  script grants them; CI does it explicitly).
- A race test failing intermittently would indicate a real bug — they assert invariants, not timings.
  The forced-ordering tests use a 400 ms "is it still blocked?" window; on an extremely slow machine
  that window is the only timing assumption.
- E2E timeouts at sign-in → check the API is running with `ENABLE_DEV_ROUTES=true` and the auth rate
  limit hasn't been exhausted (restart the API to reset in-memory counters).
