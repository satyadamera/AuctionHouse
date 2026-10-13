# Bidding concurrency

This is the most important document in the repository. It explains, line by line, how Auctra keeps
an auction consistent when many people bid at the same moment, and how that is tested.

Code: [`backend/src/modules/bids/bid.service.ts`](../backend/src/modules/bids/bid.service.ts) and
[`lockAuction()` in auction.repository.ts](../backend/src/modules/auctions/auction.repository.ts).

---

## 1. The problem: a lost update

State: current highest bid ₹10,000, increment ₹100. Two requests arrive within a millisecond.

| Time | Request A (₹10,500) | Request B (₹11,000) |
|---|---|---|
| t1 | reads highest = 10,000 | |
| t2 | | reads highest = 10,000 |
| t3 | 10,500 ≥ 10,100 ✓ | 11,000 ≥ 10,100 ✓ |
| t4 | | writes highest = 11,000 |
| t5 | writes highest = 10,500 | |

Both requests "succeeded", both bid rows exist, but the auction says ₹10,500 and the leader is A.
B's higher bid has been silently overwritten. The final state depends on thread timing, not on the
bids — that is a **race condition**, and the read-then-write gap (t1–t5) is the **critical section**.

You can watch this happen: `npm run demo:race`, Part 4, runs exactly this naive algorithm (in the
script only — the application never does this) and prints:

```
bid rows: [Rohan Das ₹10,000.00, Diya Sharma ₹11,000.00, Aarav Mehta ₹10,500.00]
auction summary says highest = ₹10,500.00  but MAX(bids) = ₹11,000.00  ✗ LOST UPDATE
```

Checking the amount in JavaScript *before* starting a transaction doesn't help: the value you
checked can change before you write. The check and the write must happen while nobody else can
change the row.

## 2. The fix: serialise writers on the auction row

```sql
BEGIN;  -- READ COMMITTED
SELECT id, seller_id, status, starting_price, current_highest_bid, current_highest_bidder_id,
       minimum_bid_increment, bid_count, start_time, end_time, version,
       UTC_TIMESTAMP(3) AS db_now
  FROM auctions
 WHERE id = ?
   FOR UPDATE;      -- exclusive row lock until COMMIT/ROLLBACK
...validate, INSERT bid, UPDATE auction...
COMMIT;
```

`SELECT … FOR UPDATE` takes an **exclusive (X) record lock** on the auction's primary-key index
entry. Any other transaction that tries to lock the same row — another bid, the closing worker, an
admin cancel — **waits** at its own `SELECT … FOR UPDATE` until the first transaction commits or
rolls back. When it proceeds, it reads the **latest committed** row (locking reads always do, at any
isolation level), so its validation runs against the true current state.

Replay the table with the lock:

| Time | A | B |
|---|---|---|
| t1 | locks row, reads 10,000 | |
| t2 | | tries to lock → **blocked** |
| t3 | validates, inserts, updates to 10,500, **commits** | |
| t4 | | lock granted, reads **10,500** |
| t5 | | 11,000 ≥ 10,600 ✓, inserts, updates to 11,000, commits |

And if B wins the lock first, A wakes up, reads 11,000, and is rejected (`BID_TOO_LOW`, with the new
minimum in `details`). Either way the end state is legal and consistent.

### Which row, and who is blocked?

Exactly one row: the auction being bid on, found by primary key. Because it is an equality lookup on
a unique index, InnoDB takes a record lock without gap or next-key locks. **Bids on other auctions
proceed in parallel** — `tests/concurrency/bidding-race.test.ts › bids on different auctions do not
block each other` holds the lock on auction X and shows a bid on auction Y completes immediately.
Readers are not blocked either: a plain `SELECT` (e.g. the auction page) uses a consistent snapshot
and never waits for the lock.

## 3. The full algorithm, in order

`placeBid()` → `withTransactionRetry()` → `attemptBid()`:

| Step | Where | What and why |
|---|---|---|
| 0 | `placeBid` | `parseAmount`: `^\d{1,12}(\.\d{1,2})?$`, > 0, ≤ ₹10 crore. Depends only on the request, so it runs before taking any lock. |
| 1 | `withTransactionRetry` | `BEGIN` with `READ COMMITTED` (explained in §5). |
| 2 | `lockAuction` | `SELECT … FOR UPDATE` + `UTC_TIMESTAMP(3)`. Not found → `AUCTION_NOT_FOUND`. |
| 3 | `attemptBid` | Idempotency lookup on `(bidder_id, client_request_id)` — see §4. |
| 4a | `attemptBid` | Seller bidding on own lot → `SELF_BIDDING_NOT_ALLOWED`. |
| 4b | `attemptBid` | Status: DRAFT/CANCELLED → `AUCTION_NOT_ACTIVE`, COMPLETED → `AUCTION_ENDED`. |
| 4c | `attemptBid` | Window with the **DB clock**: `now < start_time` → `AUCTION_NOT_STARTED`; `now ≥ end_time` → `AUCTION_ENDED` (end is exclusive). |
| 4d | `attemptBid` | `amount ≥ minimumNextBid` (first bid may equal the starting price; later bids need highest + increment) → else `BID_TOO_LOW`. Computed from the locked row, never from the client. |
| 4e | `attemptBid` | SCHEDULED but start passed → lazy activation (status set to ACTIVE in the same update). Optional anti-sniping extends `end_time`. |
| 5 | `attemptBid` | `INSERT bid` with `created_at = db_now`. |
| 6 | `attemptBid` | `UPDATE auctions … WHERE id = ? AND version = ?`; must affect exactly 1 row, else throw (rolls back). |
| 7 | `attemptBid` | `BID_ACCEPTED` notification, `OUTBID` for the previous leader, `auction:bid_placed` + `auction:price_updated` outbox rows, audit row — all in this transaction. |
| 8 | Kysely | `COMMIT` when the callback returns; any throw → `ROLLBACK`. **Lock released.** |
| 9 | `placeBid` | `invalidateAuction(id, version)` in Redis, then `wakeOutboxDispatcher()`. |

Nothing between 1 and 8 talks to Redis, Socket.IO or the network. The lock is held for a handful of
indexed single-row statements.

### Why the `version = ?` guard if we already hold the lock?

Defence in depth. Under the lock it can never fail; if some future code path updated the row
*without* the lock, this turns a silent lost update into a loud rollback. (It is, in effect,
optimistic locking layered under the pessimistic lock: without the lock, a concurrent writer that
read the same version would have its update rejected rather than silently applied.)

## 4. Idempotency

Networks fail *after* the server commits: the client times out, retries, and without protection a
second identical bid would be stored. Each bid attempt carries a client-generated UUID
`clientRequestId`; retries of the same attempt reuse it (the UI does this when it gets a network
error — see `BidPanel.tsx`).

- **Database guarantee:** `UNIQUE KEY uq_bids_bidder_request (bidder_id, client_request_id)`. Scoped
  per bidder so two users can't collide.
- **Checked right after the lock, before business rules.** If it were checked after the minimum-bid
  rule, a retry of a *successful* ₹10,000 bid would be compared against highest = ₹10,000 and
  rejected as `BID_TOO_LOW` — the client would think its bid failed when it actually won.
- **Same key, same auction, same amount** → `200` with `replayed: true` and the original bid.
- **Same key, different amount or auction** → `422 IDEMPOTENCY_KEY_REUSED`.
- **Concurrent duplicates on the same auction** queue on the row lock; with READ COMMITTED the second
  one's lookup sees the first's committed bid.
- **Concurrent duplicates on different auctions** don't share a lock; the unique index rejects the
  second insert (`ER_DUP_ENTRY`), and `resolveDuplicate()` answers it like a replay (here: 422).

Tests: `the same request retried 10 times concurrently creates exactly one bid`, `the same key used
concurrently on two DIFFERENT auctions`, and the REST idempotency tests in `bids.test.ts`.

## 5. Isolation level

Bidding runs at **READ COMMITTED** explicitly (`setIsolationLevel('read committed')`):

- The lock read (`FOR UPDATE`) is a *locking read*, which always sees the latest committed version
  at any isolation level.
- The idempotency lookup is a *plain* read. Under MySQL's default REPEATABLE READ it could reuse a
  snapshot taken earlier in the transaction; under READ COMMITTED each statement sees the latest
  committed data, which is what we want after waiting for a lock.
- READ COMMITTED also avoids gap locks on secondary-index range scans, reducing deadlock surface.

Phantoms and non-repeatable reads are not a concern here because every decision is made on the one
locked row.

## 6. Deadlocks and retries

A deadlock is two transactions each waiting for a lock the other holds. InnoDB detects the cycle
immediately and rolls back one victim with error **1213**; a lock wait longer than
`innodb_lock_wait_timeout` gives **1205**. The bid path locks only one auction row, so it can't
deadlock with itself, but it could in principle with another path that locks rows in a different
order.

`withTransactionRetry()` retries the **entire** transaction up to 3 times with jittered exponential
backoff (≈ 30–55 ms, 60–85 ms). Safe because the failed attempt was fully rolled back and the
idempotency key prevents double insertion. After 3 attempts it returns `503
CONFLICT_RETRY_EXHAUSTED`, which tells the client "try again", never "your bid was lost".

`tests/concurrency/deadlock-retry.test.ts` creates a **real** InnoDB deadlock (T1 locks X then Y, T2
locks Y then X with a barrier so the cycle is guaranteed) and shows both transactions commit through
the retry wrapper.

## 7. Bidding versus closing

The closing worker (`closeAuction()` in `workers/lifecycleWorker.ts`) calls the **same**
`lockAuction()`. The two operations are therefore serialised:

- **Bid holds the lock first.** The bid validated `now < end_time` when it took the lock, so it is
  legitimate; it commits. The closer then gets the lock, sees the new leader, and declares them the
  winner. Test: *a bid holding the lock when the end time passes still commits, and the closer then
  declares it the winner* (the hook holds the bid in its transaction past the end time and proves the
  closer is blocked until it commits).
- **Closer holds the lock first.** It marks COMPLETED and commits. The waiting bid then reads
  `status = COMPLETED` → `AUCTION_ENDED`. Test: *once the closer holds the lock, a waiting bid is
  rejected and the winner is unchanged*.
- **The worker is late.** The bid path checks `now ≥ end_time → AUCTION_ENDED` on the DB clock
  regardless of status, so a bid arriving after the end is rejected even if the row still says ACTIVE.
  Test: `bids.test.ts › rejects bids after end_time even if the lifecycle worker has not closed the
  auction yet`.
- **Stress.** 30 bids spread across the end time while a closing loop runs every 20 ms: no accepted
  bid has `created_at ≥ end_time`, the winner is the highest accepted bid, nothing is inserted after
  completion.
- **Several closers at once** (multiple API instances): 8 concurrent `closeAuction` calls → exactly
  one returns true, exactly one `AUCTION_WON` notification and one `auction:ended` event.

`closeAuction` also cross-checks the summary against `SELECT … ORDER BY amount DESC LIMIT 1` on the
bids table. They can't disagree under the lock protocol; if they ever did (the race demo's corrupted
auction is an example), the bids table wins, the summary is repaired, and an error is logged.

## 8. Using the database clock

Every time comparison in a transaction uses `UTC_TIMESTAMP(3)` read in the locking statement. With
several API servers, each server's clock can drift; the database clock is one shared reference, so
"is this bid before the end?" has a single answer. The frontend countdown is display-only and
corrects for client clock skew using `meta.serverTime` from every auction response.

## 9. What MySQL guarantees vs what the application must do

| MySQL / InnoDB guarantees | The application is responsible for |
|---|---|
| Atomic commit/rollback of the whole transaction | Putting the check *and* the write in the same transaction |
| Exclusive row lock, waiters see the committed row | Actually taking the lock before reading mutable state, on every write path (bid, close, cancel, publish, edit) |
| Deadlock detection, rollback of the victim | Retrying the victim safely (bounded, idempotent) |
| Unique keys, foreign keys, CHECK constraints | Choosing the right constraints (idempotency scope, positive amounts, leader pair) |
| Durability after COMMIT | Not announcing anything before COMMIT (outbox), not trusting caches or clients |

## 10. Why not…

**A JavaScript mutex?** It only works inside one Node process. With two API instances (or the
worker in another process) each has its own mutex and the race is back. The database is the one
place every writer goes through.

**Optimistic locking (version check + retry) instead?** It works and avoids blocking, but on a hot
auction in its final seconds most attempts would fail and retry, wasting work exactly when it
matters most. Pessimistic locking turns contention into an orderly queue. Auctra keeps a version
guard as a safety net, and uses versions for cache and event ordering.

**Redis as the source of truth (e.g. `INCR`/Lua)?** Faster, but you then need durability, a second
consistency story between Redis and MySQL, and recovery after a Redis failover. For bids — money —
one ACID store is simpler and safer. Redis stays a cache.

**`SERIALIZABLE` isolation?** It would turn plain reads into shared locks across the transaction and
increase deadlocks. An explicit lock on the one row that matters is narrower and clearer.

## 11. Post-commit events

After commit the bid exists no matter what happens next. Delivery uses a transactional outbox:

1. Events are inserted into `outbox_events` **in the bid transaction** → they exist if and only if the
   bid committed (no "broadcast a bid that rolled back", no "committed but never announced").
2. `placeBid` calls `wakeOutboxDispatcher()`; the dispatcher also polls every 250 ms.
3. `dispatchOnce()` claims rows with `FOR UPDATE SKIP LOCKED`, invalidates cache, emits to the right
   room, marks `processed_at`.
4. If the process dies between emit and mark, rows are emitted again → **at-least-once**. Clients
   dedupe by `eventId` and ignore versions they've already applied.

If Redis or Socket.IO is down, the bid is still committed and returned to the bidder; the cache
expires or is invalidated later; viewers re-sync from REST when they reconnect.
