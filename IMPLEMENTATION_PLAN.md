# Auctra — Implementation Plan

Living document. Updated as work progresses. Status markers: `[x]` done and verified, `[~]` implemented but not fully verified, `[ ]` outstanding.

## 1. Starting point

The repository contained only a one-line `README.md`. Everything else is new.

## 2. Execution environment notes

The build was done in a Linux sandbox (Ubuntu 24.04, Node 22, 2 vCPU, 7 GB RAM).

- The Docker **daemon is not available** in that sandbox, so `docker compose up` could not be executed there.
  MySQL 8.0 was installed natively from apt and Redis 7.0 was run natively instead, so **every test
  and demo was run against real MySQL and real Redis** — nothing was mocked or swapped for SQLite.
- `docker-compose.yml` is provided for your machine (Windows + Docker Desktop). Its correctness was
  reviewed but it was not executed in the sandbox.
- npm 10.9 hit an internal arborist bug while *adding* Vitest 4; packages were added with npm 11.
  A clean `npm install` / `npm ci` from the committed lockfile was verified with npm 10.9.4.
- Outbound access to stock-photo hosts was blocked, so seed imagery is a set of original SVG
  illustrations stored in the repo (`backend/assets/seed`). They are stable offline and carry no
  licensing risk. Real photos can be uploaded through the Create Auction page.

## 3. Architecture (modular monolith)

```
frontend (React + Vite)  ──REST /api/v1──▶  backend (Express)  ──▶ MySQL 8 (source of truth)
          ▲                                     │   │
          └──── Socket.IO (live updates) ◀──────┘   └──▶ Redis (cache-aside, never authoritative)
                                                │
                     in-process workers: lifecycle scheduler, outbox dispatcher
```

## 4. Version choices

| Package | Version | Why not the newest major |
|---|---|---|
| TypeScript | 5.9 | `typescript-eslint` supports `<6.1`; TS 7 (native port) is too new |
| Data access | Kysely 0.28 + mysql2 3 | **Replaced Prisma.** Prisma's Rust engines download from `binaries.prisma.sh` at install/run time, which was blocked, so Prisma code could not be executed or tested here. Kysely is pure TypeScript and every query was run against real MySQL. |
| ioredis | 5.x | 6.0 is a fresh major; 5.x is battle-tested |
| Vite / Vitest | 7.3 / 4.1 | Pinned to one Vite major across both workspaces (Vitest otherwise pulled Vite 8 and plugin types clashed) |
| ESLint | 9 | Flat config, stable |
| Express | 5 | Native async error propagation |
| React | 19 | Current stable |
| Tailwind | 4 | Current stable, Vite plugin |

## 5. Key design decisions

1. **Pessimistic locking for bids.** `SELECT … FOR UPDATE` on the auction row inside an explicit
   `READ COMMITTED` transaction. All mutable state (status, highest bid, end time) is re-read and
   re-validated while holding the lock.
2. **Database clock.** Bid-window checks use `UTC_TIMESTAMP(3)` read in the same locked statement,
   so app-server clock drift cannot admit a late bid.
3. **Idempotency before business validation.** Unique key `(bidderId, clientRequestId)`. The lookup
   runs right after the lock, because a replay of an *accepted* bid would otherwise fail the
   "must exceed current highest" rule and return a misleading error.
4. **Closing uses the same lock.** The lifecycle worker locks the same auction row, so a bid and a
   close are strictly serialized. The bid path additionally checks `now < endTime`, so even a late
   scheduler can never let a bid in after the end time.
5. **Transactional outbox.** Bid/lifecycle transactions write `OutboxEvent` rows atomically with
   the state change. A dispatcher emits Socket.IO events and invalidates cache after commit.
   Delivery is at-least-once; events carry `eventId` and monotonically increasing `version`
   so clients deduplicate and ignore stale events.
6. **Versioned cache-aside.** Redis snapshots carry the auction `version`. Invalidation records a
   minimum acceptable version, and a Lua script refuses to repopulate the cache with an older
   snapshot — closing the classic "slow reader repopulates stale data" race.
7. **Auth.** Short-lived JWT access token held in memory by the SPA; rotating refresh token in an
   `HttpOnly; SameSite=Strict` cookie, hashed server-side, with reuse detection per token family.

## 6. Checklist

See the bottom of this file (updated at the end of the build) for verified status.

---

## 7. Final verification (build environment)

Run against native MySQL 8.0.46 and Redis 7.0.15 (Docker daemon unavailable in the sandbox).

| Check | Status | Evidence |
|---|---|---|
| Frontend starts | [x] | `npm run dev` → Vite :5173, proxies `/api`, `/socket.io` |
| Backend starts | [x] | `npm run dev` → API :4000; compiled build also boots with `NODE_ENV=production` |
| MySQL connects / migrations succeed | [x] | `npm run db:migrate`, `/health/ready` |
| Redis connects | [x] | `/health/ready` → `"status":"ok"` |
| Seed succeeds (repeatable) | [x] | `npm run db:seed` → 8 users, 5 categories, 25 auctions, 140 bids |
| Login works | [x] | auth integration tests, E2E |
| Role enforcement works | [x] | RBAC unit + integration tests, E2E route guard, Demo 5 |
| Seller can create / publish an auction | [x] | `auctions.test.ts` |
| User can submit a bid | [x] | `bids.test.ts`, E2E |
| Another user sees the bid live | [x] | `websocket.test.ts`, E2E two-session test, screenshot |
| Outbid notification works | [x] | `websocket.test.ts`, E2E |
| Concurrent requests preserve consistent state | [x] | `tests/concurrency/*` (17 tests), `npm run demo:race`, mutation check |
| Duplicate bid requests are idempotent | [x] | REST + concurrent duplicate tests |
| Redis cache is actually used | [x] | `cache.test.ts` (HIT with 0 SQL queries), `npm run demo:cache`, benchmark |
| Cache invalidates after a bid | [x] | `cache.test.ts`, demo |
| Auction completion works / winner persisted | [x] | `lifecycle.test.ts`, `npm run demo:lifecycle` |
| Completed auctions reject bids | [x] | `bids.test.ts`, `lifecycle.test.ts`, demo |
| User / seller / admin dashboards work | [x] | rendered with real data in Chromium (screenshots) |
| TypeScript build passes | [x] | `npm run typecheck`, `npm run build` |
| Lint | [x] | 0 errors (7 react-refresh warnings for context modules that also export hooks) |
| Automated tests pass | [x] | 50 unit + 75 integration + 17 concurrency + 16 frontend + 3 E2E |
| README / interview docs match the code | [x] | written after implementation, referencing real files and functions |

### Not verified in the build environment

- `docker compose up` itself (no Docker daemon). The compose file uses official images, health checks
  and an init script; on Windows it should work as documented, but it was not executed here.
- The GitHub Actions workflow has not run yet (it will on the first push/PR).
- E2E ran with a Chromium binary from the `@sparticuz/chromium` npm package because Playwright's
  browser CDN was blocked; on your machine `npx playwright install chromium` is the normal route.

### Deferred / not implemented

Socket.IO Redis adapter (multi-instance rooms), Redis-backed rate limiting, email/password reset/MFA,
proxy bidding, payments, object storage for uploads, Prometheus metrics, CSP for the built SPA,
listing-approval queue (listings are auto-approved on publish; admins can reject afterwards).
