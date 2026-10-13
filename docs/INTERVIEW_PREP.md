# Interview preparation — Auctra

A study guide for explaining Auctra from scratch in an SDE interview. Every answer refers to code
that exists in this repository. Where something is *not* implemented, the answer says so — interviewers
respect "here's what I'd do next" far more than an overclaim.

Reading tip: learn sections A and D first. They cover 80% of what you'll be asked.

---

## Section A — Explaining the project

### 30 seconds

> Auctra is a real-time online auction platform I built with React, Node.js, MySQL, Redis and
> Socket.IO. Sellers list items, bidders compete live, and everyone watching a lot sees each new bid
> instantly. The interesting part is correctness: when two people bid at the same moment, the backend
> uses a MySQL transaction with a row lock so the auction can never end up in an inconsistent state.
> I proved that with concurrency tests that fire up to a hundred simultaneous bids.

### 60 seconds

> Auctra is a full-stack auction house. The frontend is a React and TypeScript single-page app; the
> backend is a Node.js and Express REST API backed by MySQL, with Redis for caching and Socket.IO for
> live updates.
>
> The core problem is concurrent bidding. If two bids read the same "current highest" and both
> write, the lower one can overwrite the higher one. I solved it by placing each bid inside a
> transaction that starts with `SELECT … FOR UPDATE` on the auction row, so bids on the same auction
> are processed one at a time and each one re-validates against the latest committed price. The
> auction-closing job takes the same lock, so a bid can't sneak in after a winner is declared.
>
> On top of that, Redis caches auction pages with a versioned cache-aside strategy, and after a bid
> commits, an outbox table drives Socket.IO events to everyone in that auction's room. I have unit,
> integration, concurrency and end-to-end tests, and a benchmark showing the cache roughly doubles
> read throughput on my machine.

### 2 minutes

> Auctra lets people list items for auction and bid on them live. I built the entire stack.
>
> **Frontend:** React with TypeScript, TanStack Query for server state, Tailwind for styling. The
> auction page subscribes to a Socket.IO room and patches its cached data when events arrive. Events
> carry a version number, so if one arrives late or twice it's ignored, and if one was missed the
> page refetches from the API.
>
> **Backend:** Express, organised as a modular monolith — auth, auctions, bids, notifications and
> admin modules, each with routes, services and queries. Authentication uses a short-lived JWT kept in
> memory plus a rotating refresh token in an HttpOnly cookie. Roles are USER, SELLER and ADMIN, enforced
> by middleware on the server.
>
> **The hard part** is concurrent bids. The bid service opens a transaction, locks the auction row with
> `SELECT … FOR UPDATE`, reads the current state and the database clock, checks an idempotency key,
> validates the bid, inserts it, updates the auction summary and version, and writes notifications and
> events into an outbox table — all in one transaction. Only after commit does it invalidate Redis and
> trigger the dispatcher that emits Socket.IO events. Deadlocks are retried a bounded number of times.
>
> **Lifecycle:** a background worker activates scheduled auctions and closes ended ones using the same
> row lock, so bidding and closing never interleave. Bids check the end time with the database clock,
> so even if the worker is late, nothing gets in after the end.
>
> **Testing:** about 160 automated tests, including concurrency tests with real MySQL that force both
> orderings of a race, a test that creates a real deadlock, and a Playwright test with two browser
> sessions bidding on the same lot. When I removed the row lock, seven of the race tests failed —
> so the tests genuinely detect the bug.

### 5-minute technical walkthrough

1. **Architecture (45 s).** Draw: Browser → Express API → MySQL; API ↔ Redis; API ↔ Socket.IO ↔
   Browser; two in-process workers (lifecycle, outbox). MySQL is the only source of truth.
2. **Data model (45 s).** `auctions` has a denormalised summary — `current_highest_bid`, leader,
   `bid_count`, `version`. `bids` is append-only. `UNIQUE(bidder_id, client_request_id)` for
   idempotency. CHECK constraints for positive money and a valid time window. `DECIMAL(12,2)` for money.
3. **Bid flow (1 min 30 s).** Open `bid.service.ts`. Steps: validate format → BEGIN → `lockAuction`
   (`FOR UPDATE` + `UTC_TIMESTAMP`) → idempotency lookup → rules on locked row → insert → update with
   `WHERE version = ?` → notifications/outbox/audit → COMMIT → invalidate cache → wake dispatcher.
   Explain why idempotency comes before the minimum-bid rule.
4. **Closing (30 s).** `closeAuction` locks the same row, re-checks, picks the winner, notifies.
   Idempotent, safe with multiple workers, restart-safe.
5. **Cache (30 s).** Cache-aside with TTL; invalidate after commit; version marker + Lua stops a slow
   reader writing an old snapshot back. Redis down → MySQL fallback.
6. **Realtime (30 s).** Outbox → rooms; events have `eventId` and `version`; client ignores stale
   versions and refetches on gaps; bids never go over the socket.
7. **Proof (30 s).** `npm run demo:race`, test counts, the mutation check, benchmark numbers.

---

## Section B — Architecture questions

**1. What problem does the project solve?**
Running online auctions where many people bid on the same item at once, while keeping the result
correct (one valid winner, no lost bids) and showing everyone updates in real time.

**2. What does the application do?**
Sellers list items with photos, prices and a schedule. Bidders browse, watch, bid, and get live
updates and alerts. Auctions open and close automatically and the highest valid bid wins. Admins
moderate listings and users.

**3. What is the frontend responsible for?**
Rendering, navigation, forms with client-side validation for fast feedback, keeping server data in a
cache (TanStack Query), subscribing to live events and merging them in version order, and showing a
countdown. It is **not** responsible for any rule that matters — the server re-validates everything.

**4. What does the backend handle?**
Authentication and sessions, authorization, validation, all business rules (bidding, lifecycle,
cancellation), persistence, caching, event publication, notifications, audit logging, rate limiting.

**5. Why React?**
Component model and declarative rendering suit a page that changes on every event; mature ecosystem
(TanStack Query, Radix, Testing Library); TypeScript support; it's what most teams use.

**6. Why Node.js?**
Same language as the frontend (shared event types), and its event loop handles many concurrent I/O-
bound connections — HTTP requests and long-lived WebSockets — efficiently. CPU-heavy work is minimal.

**7. Why Express?**
Small, well-known, middleware-based. Express 5 forwards rejected promises from async handlers to the
error handler, which removes a class of bugs. I didn't need the structure of a heavier framework.

**8. Why MySQL?**
Bidding needs ACID transactions and row-level locks; InnoDB has both. The data is relational and I
wanted the database to enforce invariants with foreign keys, unique keys and CHECK constraints.

**9. Why not MongoDB?**
MongoDB supports transactions, but my core operation is "lock this auction, validate, write a bid and
update the auction together", with relational integrity around it. In MySQL that's one transaction
with a row lock and declarative constraints; in a document store I'd be re-implementing constraints
in code. Nothing in the data model benefits from schemaless documents.

**10. What is a REST API?**
An HTTP interface where URLs name resources (`/auctions/42/bids`) and methods say what to do (GET
reads, POST creates, PATCH updates). Each request is self-contained (stateless) — identity comes from
the token. Responses use status codes (201 created, 409 conflict…) and a consistent JSON shape.

**11. How does frontend–backend communication work?**
Two channels. REST for reads and all writes (fetch with a Bearer token; the refresh cookie is sent
only to `/auth`). Socket.IO for server-to-client push of committed events. In development Vite proxies
both, so the browser sees one origin.

**12. What happens when a user opens an auction?**
The page requests `GET /auctions/:id` (served from Redis if cached, otherwise two MySQL queries, then
cached) and `GET /auctions/:id/bids`. It records the server time to correct the countdown. It emits
`auction:join`; the server checks the auction is viewable, adds the socket to `auction:{id}`,
broadcasts the viewer count and acks with the current version. If the server's version is newer than
the page's, the page refetches.

**13. What happens when a user places a bid?**
The bid panel checks the amount locally, shows a confirm dialog, then POSTs `{ amount,
clientRequestId }`. The server authenticates, rate-limits, validates, runs the locked transaction,
commits, invalidates the cache and wakes the outbox dispatcher, then returns 201. The page applies
the response immediately. Everyone else in the room receives `auction:bid_placed`; the previous leader
also gets a private `notification:new` (OUTBID).

**14. How is the backend code organised?**
`src/modules/<area>/` with `*.routes.ts` (HTTP), `*.service.ts` (rules and transactions), and a
repository for reusable queries. Cross-cutting pieces in `middleware/`, `cache/`, `sockets/`,
`workers/`, `services/` (outbox, notifications, audit).

**15. What is a modular monolith?**
One deployable application internally divided into modules with clear boundaries. You get simple
deployment, local transactions and easy debugging, while keeping the option to extract a module into
a service later.

**16. Why not microservices?**
The key invariant — bid row and auction summary change together — would span services and need a
distributed transaction or a saga. Microservices also add network failure modes, deployment overhead
and observability work that this scale doesn't justify.

---

## Section C — MySQL and database questions

**1. Primary keys.** Unique, non-null identifier of a row; in InnoDB the table is physically stored
ordered by it (clustered index). Auctra uses auto-increment `INT UNSIGNED`: compact and inserts append.

**2. Foreign keys.** A column that must match a primary key in another table, e.g.
`bids.auction_id → auctions.id`. MySQL rejects a bid for a nonexistent auction.

**3. Referential integrity.** The guarantee that references are valid. FKs plus `ON DELETE` rules:
bids `RESTRICT` deleting a user (history is preserved), images `CASCADE` with their auction,
`winner_id` `SET NULL`.

**4. Normalization.** Store each fact once to avoid update anomalies: bids separate from auctions,
categories separate. I deliberately **denormalise** the current highest bid onto the auction row for
fast reads — safe because it's written in the same locked transaction as the bid.

**5. Indexing.** A B-tree that lets MySQL find rows without scanning the table. Example:
`(status, end_time)` lets the closing worker find "ACTIVE and ended" auctions directly.

**6. Composite indexes.** Index on several columns, ordered left to right. `(auction_id, created_at)`
serves "bids for auction X, newest first" as one range scan. It can't serve a query that filters only
on `created_at` (leftmost-prefix rule).

**7. Transactions.** A group of statements that succeed or fail together. The bid transaction
inserts a bid, updates the auction, and inserts notifications/outbox/audit rows — never some of them.

**8. ACID.**
- *Atomicity:* all or nothing (a failure after inserting the bid rolls it back).
- *Consistency:* constraints hold before and after (CHECKs, FKs, unique keys).
- *Isolation:* concurrent transactions don't see each other's partial work; the row lock serialises bids.
- *Durability:* after COMMIT the bid survives a crash (InnoDB redo log).

**9. Isolation levels.** READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ (MySQL default),
SERIALIZABLE — each prevents more anomalies at more cost. Bidding uses READ COMMITTED: the decision is
made on a locked row (locking reads always see the latest commit), and the plain idempotency lookup
should see data committed by a transaction we just waited for.

**10. Row-level locking.** InnoDB locks individual index records rather than whole tables, so
different auctions can be bid on in parallel.

**11. `SELECT … FOR UPDATE`.** A locking read: it reads the row and takes an exclusive lock held until
the transaction ends. Other `FOR UPDATE`/`UPDATE`s on that row wait. Plain `SELECT`s don't wait — they
read a snapshot.

**12. Deadlocks.** T1 holds A and wants B while T2 holds B and wants A. InnoDB detects the cycle,
rolls one back with error 1213. Auctra retries the whole transaction up to 3 times with jitter; a test
creates a real deadlock and shows recovery.

**13. Lost updates.** Two transactions read the same value, both modify, the second write silently
erases the first. The bid race is exactly this. Prevented by the row lock (and the `version` guard as
a backstop).

**14. Dirty reads.** Reading another transaction's uncommitted changes. Prevented at READ COMMITTED and
above — we never see a bid that later rolls back.

**15. Non-repeatable reads.** Reading the same row twice in one transaction and getting different
values because someone committed in between. Possible at READ COMMITTED for *plain* reads, but the bid
logic only decides on the locked row, which can't change while we hold the lock.

**16. Phantom reads.** A repeated range query returns new rows. Not relevant to the bid decision; the
closer's "top bid" cross-check runs while holding the auction lock, and bids for that auction can only
be inserted by someone holding the same lock.

**17. Optimistic vs pessimistic locking.** Optimistic: read a version, write `WHERE version = v`,
retry on conflict — no waiting, but wasted work under contention. Pessimistic: lock first, others
wait — orderly under contention. I chose pessimistic for hot auctions and keep a version check as
defence in depth.

**18. DECIMAL vs floating point.** Floats are binary fractions: `0.1 + 0.2 = 0.30000000000000004`.
For money that breaks comparisons and totals. `DECIMAL(12,2)` is exact; I keep amounts as strings
from MySQL and use decimal.js (server) and integer paise with `BigInt` (UI).

**19. Why are Auction and Bid separate?** One-to-many; a bid has its own identity, time and bidder;
history must be queryable and auditable. The auction keeps a summary for fast reads.

**20. How is the highest bidder determined?** Each accepted bid must be ≥ previous + increment, so the
latest accepted bid is the highest; the summary columns are updated with each one under the lock. At
close, the winner is copied from the summary after cross-checking `MAX(amount)` in the bids table.

---

## Section D — Concurrency deep dive

**1. What is a race condition?**
When the result depends on the timing of concurrent operations. Two bids interleaving their read and
write is one: the outcome changes depending on which write lands last.

**2. How can simultaneous bidding cause one?**
A and B both read "highest ₹10,000", both validate, B writes ₹11,000, then A writes ₹10,500. The
higher bid is lost. `npm run demo:race` Part 4 reproduces this with a naive implementation.

**3. Why is checking the bid amount before the transaction unsafe?**
Because the value can change between your check and your write. The check and write must happen
while nobody else can modify the row — inside the transaction, after taking the lock.

**4. What is a critical section?**
Code that must not run concurrently for the same resource. Here: from reading the auction's state to
committing the new bid. The row lock makes it mutually exclusive *per auction*.

**5. What is a database transaction?**
An all-or-nothing unit of work with isolation from other transactions. In Kysely,
`db.transaction().setIsolationLevel('read committed').execute(async trx => …)` commits when the
callback returns and rolls back if it throws.

**6. How does `SELECT FOR UPDATE` work?**
It's a read that also takes an exclusive lock on the matched index records until COMMIT/ROLLBACK.
Code: `lockAuction()` in `auction.repository.ts`.

**7. Which exact row gets locked?**
The auction row, by primary key (`WHERE id = ?`). Because it's a unique-index equality lookup, InnoDB
locks just that one record, no gaps.

**8. What happens to the second transaction?**
It blocks at its own `SELECT … FOR UPDATE` until the first finishes. Then it reads the newly committed
row and runs every rule again. Test: "A locks first" proves B is still pending 400 ms into A holding the lock.

**9. Does locking block every user?**
No. Only writers to the same auction wait. Bids on other auctions and all plain reads proceed. Test:
"bids on different auctions do not block each other".

**10. Can two users bid on different auctions simultaneously?**
Yes, fully in parallel — different rows, different locks.

**11. What if two users submit the same amount?**
The first to get the lock wins; the second re-reads, finds amount < highest + increment, gets
`BID_TOO_LOW`. Test: "exactly one wins".

**12. What if a higher bid arrives before a lower one?**
The higher one commits first; the lower one, after waiting, is rejected. The lower can never overwrite
the higher. Test: "B locks first".

**13. What if the first transaction fails?**
It rolls back completely and releases the lock. The waiting transaction proceeds with the unchanged
state, as if the first never happened.

**14. What if the server crashes during a transaction?**
The connection drops; MySQL rolls back the uncommitted transaction and releases the lock. If the crash
happens after COMMIT, the bid is durable; the client may retry with the same key and receives the
original result; unsent events are still in the outbox and are emitted after restart.

**15. What if the client retries the same request?**
It reuses `clientRequestId`. Under the lock the server finds the existing bid for that bidder and key
and returns it with `replayed: true` (HTTP 200). Concurrent retries serialise on the lock; across
different auctions the unique index catches them.

**16. What is idempotency?**
Doing an operation twice has the same effect as once. Essential for "submit bid" because networks
fail after the server has already acted.

**17. What is a deadlock?**
A cycle of transactions each waiting on a lock the next holds; none can proceed. InnoDB picks a victim.

**18. How do you recover from deadlocks?**
`withTransactionRetry()` catches errno 1213 (deadlock) and 1205 (lock wait timeout) and replays the
entire transaction up to 3 times with jittered exponential backoff; then returns 503 so the client
retries. Safe because the failed attempt was rolled back and the idempotency key prevents duplicates.
Prevention: lock in a consistent order and keep transactions short — the bid path locks one row.

**19. Why not just use a JavaScript mutex?**
A mutex only coordinates code inside one Node process. Two API instances, or the worker in another
process, would each have their own. The database lock is shared by every process that talks to MySQL.

**20. Could you use optimistic locking instead?**
Yes: read `version`, `UPDATE … WHERE id = ? AND version = ?`, retry if 0 rows changed. It avoids
waiting but on a hot auction near its end most attempts would conflict and retry, adding latency and
load exactly when it matters. My `UPDATE` already includes `WHERE version = ?` as a safety net.

**21. How do you test concurrency?**
Against real MySQL, with real concurrent HTTP requests (`Promise.all`). Uncontrolled tests assert
invariants without assuming an order (summary = MAX(bids), strictly increasing bids, one row per 201,
version = 1 + accepted). Controlled tests use a hook that pauses a transaction while it holds the lock
to force each ordering deterministically and to prove the other request is blocked. A separate test
creates a real deadlock. And I verified the tests fail when I remove `FOR UPDATE`.

**22. What happens if a bid arrives exactly at the end time?**
The window is start-inclusive, end-exclusive: `start ≤ now < end`, with `now` from `UTC_TIMESTAMP(3)`
read under the lock. A bid stamped exactly at `end_time` is `AUCTION_ENDED`. Unit-tested at ±1 ms.

**23. What if the scheduler closes the auction during a bid?**
They take the same row lock, so one goes first. If the bid has it, it was valid when validated and
commits; the closer then names that bidder the winner. If the closer has it, the waiting bid sees
`COMPLETED` and is rejected. Both orderings are tested, plus a stress test of 30 bids around the end.

**24. How do you prevent a duplicate winning bid?**
Only one transaction can hold the lock; the strict increment rule means two bids can't both be "the
highest"; `closeAuction` is idempotent (a second run sees `COMPLETED` and does nothing) — tested with 8
concurrent closers producing exactly one `AUCTION_WON`.

**25. What does MySQL guarantee and what must the application provide?**
MySQL: atomic commit/rollback, durable commits, exclusive row locks with waiters seeing committed data,
deadlock detection, constraint enforcement. Application: putting check and write in one transaction,
locking *before* reading mutable state on every write path, retrying safely, choosing constraints,
never trusting client- or cache-derived values for decisions, and announcing only committed facts.

---

## Section E — Redis questions

**1. What is Redis?** An in-memory data-structure server (strings, hashes, sets, sorted sets,
streams) with optional persistence, often used as a cache, rate-limit store or message broker.

**2. Why is it fast?** Data lives in RAM, commands are simple, and it runs commands on a single thread
with an event loop — no locking overhead, microsecond operations, cheap network protocol.

**3. How does it differ from MySQL?** Redis: key-value, in memory, no joins or SQL, limited
durability guarantees by default. MySQL: relational, on disk, transactions with isolation, constraints,
rich queries. In Auctra MySQL is the truth; Redis holds disposable copies.

**4. What is cache-aside?** The application manages the cache: read the cache; on a miss load from
the DB and populate; on writes update the DB then invalidate. (`cached()`, `getAuctionDetail()`.)

**5. Cache hit?** The value was in the cache — served without touching MySQL (`X-Cache: HIT`,
`X-DB-Queries: 0`).

**6. Cache miss?** Not in the cache (expired, invalidated, never loaded) — load from MySQL and populate.

**7. TTL?** Time-to-live: Redis deletes the key after N seconds. A safety net bounding staleness even if
an invalidation is missed. Auction detail: 60 s; lists: 20 s; categories: 1 h.

**8. Cache invalidation?** Removing or updating cached data when the source changes. Auctra deletes the
detail key and bumps the list generation **after commit** (`invalidateAuction`).

**9. Stale data?** Cached data older than the database. Bounded by TTL and invalidation; the version
marker prevents re-caching an older snapshot.

**10. Why not store authoritative bids in Redis?** You'd need durability (fsync), replication and
failover handling, and you'd have two systems to keep consistent. Bids are money; one ACID store is
simpler and safer. Redis is purely an optimisation.

**11. What happens if Redis crashes?** Commands fail fast; requests read from MySQL; responses say
`X-Cache: BYPASS`; readiness reports `degraded`; the client reconnects in the background. Bidding is
unaffected. Tested.

**12. How do you measure the benefit?** Hit/miss counters and hit rate; SQL query count per request;
and a load benchmark comparing cached vs bypassed reads (`npm run bench`): ~2× throughput and about
half the median latency on my VM. I'm careful to say that's local, not production.

**13. Cache stampede?** Many requests miss the same key at once (e.g. it just expired) and all hit the
DB. Mitigations: single-flight/request coalescing, a short lock key, probabilistic early refresh,
stale-while-revalidate. Not implemented; here a miss costs two indexed queries.

**14. How do you handle simultaneous cache reads?** Reads are safe in parallel. The dangerous case is a
slow reader writing back an old value; the Lua `SET_IF_NEWER` script only writes if the snapshot's
version is ≥ the invalidation marker and ≥ what's cached — atomically inside Redis.

**15. How would you scale caching?** Redis replicas for read throughput and failover (Sentinel or a
managed service), Redis Cluster to shard keys, a small in-process cache for very hot keys, and a CDN for
images and public pages.

---

## Section F — WebSocket questions

**1. What is a WebSocket?** A full-duplex, long-lived connection over a single TCP socket, started with
an HTTP upgrade. Either side can send messages at any time.

**2. How is it different from HTTP?** HTTP is request/response — the server can't speak first. A
WebSocket stays open, so the server can push events with low overhead.

**3. What is Socket.IO?** A library on top of WebSockets adding automatic reconnection, rooms,
acknowledgements, and an HTTP long-polling fallback.

**4. Is Socket.IO the same as raw WebSocket?** No — it has its own protocol; a plain WebSocket client
can't talk to a Socket.IO server without the Socket.IO client.

**5. Why not polling?** Polling every second from thousands of viewers creates constant load mostly
returning "no change", and still adds up to a second of delay. Push sends one message only when
something happens.

**6. How are auction rooms implemented?** `socket.join('auction:42')` on `auction:join`, after checking
the auction exists and isn't a private draft. The dispatcher emits with `io.to('auction:42').emit(…)`.

**7. How does a new bid reach other users?** Bid transaction inserts outbox rows → COMMIT →
`wakeOutboxDispatcher()` → `dispatchOnce()` claims rows → emits to the room → marks processed.

**8. How is Socket.IO authenticated?** The client passes the access token in the handshake `auth`
payload; middleware verifies it and sets `socket.data.userId`, then the socket joins `user:{id}`.
Anonymous sockets are allowed for public rooms; invalid tokens are rejected so the client refreshes.

**9. What happens when a user disconnects?** Socket.IO removes it from its rooms; on `disconnecting`
we broadcast the new viewer count. Nothing about bids changes.

**10. What happens when they reconnect?** The client reconnects automatically, re-joins the room, and
compares the server's version in the join ack with its own. If behind, it refetches detail and history
over REST. Notifications refetch too.

**11. Can messages be lost?** Yes (client offline, process crash before emit). The outbox guarantees
emission eventually (at-least-once), and clients recover from REST using version gaps. Sockets are a
fast path, not the record.

**12. How do you prevent stale updates?** Every state event has the auction version after the change;
the client applies only `current + 1`, ignores `≤ current`, refetches on a gap. Dedup by `eventId`.

**13. Why persist via REST and notify via WebSockets?** A bid needs authentication, validation,
idempotency, rate limiting and a definite committed answer — request/response semantics. Sockets fan
out facts that have already been committed.

**14. Multiple backend instances?** Rooms are per process, so a bid handled by instance 1 wouldn't
reach viewers on instance 2. Fix: `@socket.io/redis-adapter`. Not implemented yet.

**15. Role of Redis Pub/Sub?** The adapter publishes each room emit to a Redis channel; every instance
subscribes and delivers to its local sockets in that room.

---

## Section G — Authentication and security

**Authentication vs authorization.** Authentication = who are you (login, token verification in
`authenticate`). Authorization = what may you do (`requireRole`, ownership checks in services).

**RBAC.** Role-based access control: permissions attach to roles (USER < SELLER < ADMIN), users get
roles. Enforced server-side per route; the role is re-read from MySQL on each request so changes apply
immediately. Matrix in SECURITY.md.

**JWT.** A signed token `header.payload.signature`. The server verifies the HMAC signature with its
secret, so the payload (user id, role) can't be altered. Auctra pins `HS256`, issuer and audience —
a unit test shows tampered and `alg: none` tokens are rejected.

**Access tokens.** Short-lived (15 min) JWTs sent as `Authorization: Bearer`. Stateless to verify.
Kept only in JavaScript memory.

**Refresh tokens.** Long-lived (7 days), random, opaque, stored as a SHA-256 hash, sent only as an
HttpOnly cookie to `/api/v1/auth`. Each use rotates it; reusing an old one revokes the whole family
(likely theft). Code: `auth.service.ts → refresh()`.

**Password hashing.** bcrypt with cost 12: slow and salted, so leaked hashes resist brute force.
Login runs bcrypt even for unknown emails so timing doesn't reveal which accounts exist.

**Cookies vs localStorage.** Anything in localStorage is readable by any script on the page, so an
XSS bug could steal it. HttpOnly cookies are invisible to JavaScript. Cookies, however, are sent
automatically, which creates CSRF risk — handled below. Hence: refresh token in an HttpOnly cookie,
short-lived access token in memory.

**CORS.** Browser rule restricting which origins may read cross-origin responses. The API allows only
`CORS_ORIGINS`. In dev the Vite proxy makes everything same-origin anyway.

**CSRF.** A malicious site making the victim's browser send an authenticated request using its
cookies. Defences here: `SameSite=Strict` cookies (not sent cross-site), the cookie is scoped to
`/api/v1/auth`, those endpoints require a custom `X-Auctra-CSRF` header (cross-site forms can't set
headers; cross-origin fetch with it triggers a preflight we reject), and all other endpoints use Bearer
tokens, which browsers never attach automatically.

**XSS.** Injected script running in your page. React escapes text by default; we never use
`dangerouslySetInnerHTML`; the API strips HTML from titles/descriptions; uploads reject SVG and are
served with `nosniff`.

**SQL injection.** Untrusted input changing a query's structure. Kysely sends values as bound
parameters; raw `sql` templates also bind values. LIKE wildcards in search are escaped.

**Rate limiting.** Caps requests per window: auth per IP, bids per user, plus a global limit. In-memory
for one instance; needs a Redis store when scaled out.

**Input validation.** Zod schemas on params, query and body for every route — types, ranges, formats
(money with ≤ 2 decimals, UUID-like idempotency keys). Invalid → 400 with field details.

**Securing endpoints.** Authenticate, authorize by role, check ownership against the database row,
validate input, limit rate, return generic errors, log with request IDs, never trust the client's
numbers (the minimum bid is computed server-side).

---

## Section H — Scalability and system design

**1. 100 users bid simultaneously?** If on one auction, they queue on its row lock and are processed
one by one; each sees the latest price, so most get `BID_TOO_LOW` and the valid ones commit in order.
Tested with 100 concurrent requests: no lost updates. If spread over many auctions, they run in
parallel. Bounded by the connection pool (waiting requests queue in the pool).

**2. 10,000 users browse?** Mostly cache hits on Redis for lot pages and list pages; MySQL handles
misses. Add API instances behind a load balancer, a CDN for images and the SPA, and a read replica for
browse queries if needed.

**3. 1 million users?** Horizontal API tier, Socket.IO Redis adapter or a dedicated realtime gateway,
search engine for browse, queue-based fan-out for notifications/email, read replicas, possibly sharding
auctions by ID. Bids for one auction stay on one shard so the locking model doesn't change.

**4. First likely bottleneck?** The database: connection count (waiters hold connections) and the
work done inside the bid transaction. For a single hot auction, the serial lock is the ceiling
(measured ~76 accepted bids/s on one auction on a 2-vCPU VM). For sockets, CPU per broadcast.

**5. Scaling Node horizontally?** Run N stateless API instances behind a load balancer. State that is
per-process today must move out: socket rooms (Redis adapter), rate limits (Redis store), metrics
(Prometheus). Sessions are already stateless (JWT + DB-backed refresh).

**6. Load balancer?** Distributes requests across instances, health-checks them, terminates TLS. For
Socket.IO with polling fallback you need sticky sessions; pure WebSocket transport doesn't.

**7. Connection pooling?** Reusing a fixed set of open DB connections instead of opening one per
request. mysql2 pool, size `DB_POOL_SIZE` (20). Opening connections is slow; unbounded connections
would overload MySQL.

**8. Redis Pub/Sub?** Publish a message to a channel; all subscribers receive it. Fire-and-forget (no
persistence). Used by the Socket.IO Redis adapter to fan out emits across instances.

**9. Socket.IO rooms across servers?** With the adapter, `io.to(room).emit` publishes to Redis; each
instance delivers to its local members of that room.

**10. Distributing background jobs?** Already safe to run on every instance: lifecycle transitions lock
and re-check; the outbox uses `FOR UPDATE SKIP LOCKED` so instances claim different rows. At higher
scale, move them to dedicated worker processes or a job queue.

**11. Message queue?** Durable buffer between producers and consumers (RabbitMQ, SQS, Redis Streams):
decouples, absorbs bursts, retries. The outbox table is a minimal database-backed queue.

**12. Would Kafka help?** Not at this size — one consumer, modest volume. It would make sense when many
independent consumers (search indexing, analytics, email, fraud detection) need a replayable stream of
auction events; the outbox would then publish to Kafka.

**13. Eventual consistency?** Replicas/caches converge to the latest state after some delay. Auctra's
caches, lists and socket views are eventually consistent.

**14. What consistency does bidding need?** Strong (linearizable per auction): every bid decision must
see the latest committed state, which the row lock gives.

**15. Changes for deployment?** TLS proxy, production env vars and secrets, migrations as a release
step, serve the built SPA from a CDN, JSON logs to a log store, health checks wired to the platform,
object storage for uploads, Redis-backed rate limits, Socket.IO adapter, backups.

**16. Changes for real payments?** A payment step after winning (payment intent via a provider like
Razorpay/Stripe), a payment-due state and deadline, second-chance offers on non-payment, refunds,
reconciliation, KYC for sellers, fraud checks — triggered from outbox events, never inside the bid
transaction.

**17. Monitoring production reliability?** Metrics: bid latency percentiles, 409/503 rates, lock waits,
pool queue, outbox backlog and oldest event age, lifecycle lag, cache hit rate, socket counts. Tracing
across request → transaction → emit. Alerts on outbox age and lifecycle lag. Logs keyed by request ID.

---

## Section I — Challenges and engineering decisions

These all happened while building this repository.

### 1. Serialising concurrent bids
- **Problem:** lost updates when bids interleave.
- **Why it matters:** a higher bid silently disappears; the wrong person wins.
- **Considered:** app-level mutex (fails with >1 process), optimistic versioning (retry storms on hot
  lots), Redis atomic scripts (second source of truth), SERIALIZABLE (broad locking).
- **Chosen:** `SELECT … FOR UPDATE` on the auction row in a READ COMMITTED transaction, all rules
  re-checked under the lock, DB clock, `WHERE version = ?` guard.
- **Code:** `lockAuction()`, `attemptBid()`.
- **Trade-off:** same-auction bids wait; mitigated by a short transaction.
- **Tested:** forced orderings, 100-way contention, mutation check (7 failures without the lock).

### 2. Where to check idempotency
- **Problem:** a retry of a *successful* bid would fail "amount ≥ highest + increment" → `BID_TOO_LOW`,
  so the client believes a winning bid failed.
- **Chosen:** check `(bidder_id, client_request_id)` immediately after taking the lock, before the
  business rules; DB unique key as backstop for cross-auction duplicates.
- **Code:** `attemptBid()` step 3, `resolveDuplicate()`.
- **Tested:** REST replay, 10 concurrent retries → 1 row, same key on two auctions.

### 3. Bids racing the closing job
- **Problem:** declaring a winner and then accepting a later bid.
- **Chosen:** the closer uses the same lock and re-checks; bids check the end time with the DB clock
  independent of status (so a late worker can't admit a bid).
- **Code:** `closeAuction()`, `isWithinBiddingWindow()`.
- **Tested:** both orderings with a lock-held hook, 30 bids around the end with a closing loop, 8
  concurrent closers.

### 4. Announcing only committed bids
- **Problem:** emitting before commit could announce a rolled-back bid; emitting after commit can be
  lost if the process dies.
- **Chosen:** transactional outbox; dispatcher with `SKIP LOCKED`; at-least-once with `eventId` +
  `version` for client-side dedupe and ordering.
- **Code:** `services/outbox.ts`, `workers/outboxDispatcher.ts`, `frontend/.../applyEvent.ts`.
- **Tested:** WebSocket integration tests; the outbox rows are asserted in the bid tests.

### 5. Stale cache write-backs
- **Problem:** a slow reader can repopulate the cache with an old snapshot after an invalidation.
- **Chosen:** version marker + Lua compare-and-set.
- **Code:** `setAuctionSnapshot()`, `invalidateAuction()`.
- **Tested:** `cache.test.ts` simulates the interleaving.

### 6. A bug: revocation that rolled itself back
- **Problem:** on refresh-token reuse, the code revoked the token family and then **threw** an error
  inside the same transaction — which rolled the revocation back.
- **Fix:** return a sentinel from the transaction, commit, then throw outside it.
- **Code:** `auth.service.ts → refresh()`.
- **Tested:** "revokes the whole token family when a rotated token is reused".

### 7. A bug: two events with the same version
- **Problem:** lazy activation emitted `auction:started` and `auction:bid_placed` with the same
  version; a client applying them in order would drop the bid event as a duplicate.
- **Fix:** don't emit the redundant `started` event — the bid event carries `status: ACTIVE`.
- **Lesson:** version numbers must be unique per state change for the client protocol to work.

### 8. Testing races deterministically
- **Problem:** `Promise.all` tests can't force a specific interleaving.
- **Chosen:** `bidTestHooks.afterLock` (active only in `NODE_ENV=test`) pauses a transaction while it
  holds the lock; tests assert the other request is blocked, then release.
- **Trade-off:** a small test seam in production code, inert outside tests.

### 9. Toolchain constraints
- **Problem:** Prisma's engine binaries couldn't be downloaded in the build environment.
- **Chosen:** Kysely + mysql2 with plain SQL migrations — everything verifiable, locking SQL explicit.
- **Trade-off:** hand-maintained table types (`database/types.ts`) instead of generated ones.

### 10. Defensive closing
- **Found when:** the race demo intentionally corrupts one auction's summary; when it later closed,
  the closer's cross-check against the bids table caught the mismatch and chose the right winner — but
  left the summary stale, which the UI then displayed.
- **Fix:** the closer now repairs the summary too. **Tested:** "closing trusts the bids and repairs the
  summary".

---

## Section J — Code walkthrough

Recommended reading order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.

| # | File | Purpose | Inputs → outputs | Key functions | Concepts |
|---|---|---|---|---|---|
| 1 | `backend/database/migrations/001_init.sql` | Schema | — → tables | — | Keys, FKs, CHECKs, indexes, DECIMAL, UTC |
| 2 | `backend/src/modules/auctions/auction.repository.ts` | Queries, API shapes, the lock | DB → `AuctionDetail`, `LockedAuction` | `lockAuction`, `loadAuctionDetail`, `summaryQuery`, `liveState` | `FOR UPDATE`, DB clock, denormalised summary |
| 3 | `backend/src/modules/bids/bid.service.ts` | Bidding | `{auctionId, bidderId, amount, clientRequestId}` → `PlaceBidResult` / `AppError` | `placeBid`, `attemptBid`, `withTransactionRetry`, `replayResult` | Transactions, isolation, idempotency, retries |
| 4 | `backend/src/workers/lifecycleWorker.ts` | Start/ending-soon/close | time → state transitions + events | `activateAuction`, `closeAuction`, `runLifecycleOnce` | Idempotent jobs, shared lock, restart safety |
| 5 | `backend/src/workers/outboxDispatcher.ts` + `services/outbox.ts` | Post-commit delivery | outbox rows → socket emits, cache invalidation | `enqueueEvent`, `dispatchOnce`, `wakeOutboxDispatcher` | Transactional outbox, `SKIP LOCKED`, at-least-once |
| 6 | `backend/src/cache/cache.ts` | Cache-aside | key → value / MySQL fallback | `cached`, `setAuctionSnapshot`, `invalidateAuction` | TTL, invalidation, Lua atomicity, graceful degradation |
| 7 | `backend/src/sockets/io.ts` + `shared/events.ts` | Realtime | events → rooms | `createSocketServer` | Rooms, handshake auth, typed contracts |
| 8 | `backend/src/modules/auth/auth.service.ts` + `middleware/auth.ts` | Identity and RBAC | credentials/cookies → session; request → `req.user` | `login`, `refresh`, `authenticate`, `requireRole`, `requireCsrfHeader` | JWT, rotation, CSRF, RBAC |
| 9 | `frontend/src/features/bidding/useLiveAuction.ts` + `applyEvent.ts` | Client live state | socket events → query cache | `useLiveAuction`, `applyAuctionEvent` | Version ordering, dedupe, resync, listener cleanup |
| 10 | `backend/tests/concurrency/bidding-race.test.ts` | Proof | — → pass/fail | `assertAuctionConsistent` (fixtures) | Invariant-based testing, controlled interleavings |

Also worth a glance: `backend/src/app.ts` (middleware order), `modules/auctions/stateMachine.ts`
(legal transitions), `frontend/src/features/bidding/BidPanel.tsx` (idempotency key per attempt),
`scripts/concurrency-test/race-demo.ts` (the naive lost-update demo).

---

## Section K — Mock interview questions

### Easy

1. **What does `SELECT … FOR UPDATE` do?** Reads rows and locks them exclusively until the transaction ends; other lockers wait.
2. **Why `DECIMAL` for money?** Exact decimal representation; floats can't represent 0.10 exactly.
3. **What's the difference between 401 and 403?** 401: not authenticated (no/invalid token). 403: authenticated but not allowed.
4. **What does a 409 mean in your API?** The request conflicts with current state — e.g. `BID_TOO_LOW`, `AUCTION_ENDED`, an illegal state transition.
5. **Why use TypeScript?** Compile-time checks on API shapes, SQL columns (Kysely) and socket event contracts; safer refactors.
6. **What is middleware in Express?** Functions run in order on each request (logging, auth, validation) that can modify the request or end it.
7. **Where is the access token stored?** In memory in the SPA; never in localStorage.
8. **What is an index?** A sorted data structure (B-tree) that lets the DB find rows without a full scan.
9. **What does TanStack Query do?** Caches server data per key, handles loading/error states, refetches, and lets me patch the cache from socket events.
10. **Why Docker Compose?** One command gives everyone the same MySQL and Redis versions with health checks.
11. **What is a foreign key?** A column that must reference an existing primary key in another table.
12. **What's in a JWT?** Header (algorithm), payload (claims like `sub`, `role`, `exp`), signature.
13. **What does `bcrypt` add over SHA-256 for passwords?** A per-password salt and a tunable slow cost, making brute force expensive.
14. **What is CORS for?** Letting a server declare which other origins may read its responses in browsers.
15. **What is an auction's `version`?** A counter incremented on every state change; used to order events and guard the cache.

### Medium

16. **Walk me through placing a bid.** Validate format → BEGIN READ COMMITTED → lock auction row with DB time → idempotency lookup → rules on locked row → insert bid → update summary `WHERE version = ?` → notifications/outbox/audit → COMMIT → invalidate cache → wake dispatcher → 201.
17. **Why check idempotency before the minimum-bid rule?** A retry of an accepted bid would otherwise fail the rule and report failure for a bid that actually succeeded.
18. **How is the idempotency key scoped, and why?** Unique per `(bidder_id, client_request_id)`; one user's retries collapse, different users can't collide.
19. **Why use the database clock?** Multiple servers' clocks drift; MySQL's clock is a single reference for "before or after the end".
20. **How do you close auctions?** A worker polls `status='ACTIVE' AND end_time <= now` (indexed), locks each row, re-checks, sets COMPLETED with winner and final price, notifies, enqueues `auction:ended`.
21. **What if two workers close the same auction?** The second waits for the lock, then sees COMPLETED and does nothing. Tested with 8.
22. **What happens if Redis is down?** Reads go to MySQL, `X-Cache: BYPASS`, readiness `degraded`; bidding unaffected.
23. **How does the cache avoid serving stale data after a bid?** Invalidation after commit plus a version marker that blocks older snapshots from being written back.
24. **Why invalidate after commit, not before?** Before commit, a reader could re-cache the old row in the gap and it would survive the commit.
25. **How do you invalidate all list pages at once?** A generation counter embedded in list keys; `INCR` it and old pages become unreachable and expire.
26. **What's the outbox pattern?** Write events to a table in the same transaction as the change; a separate process publishes them. Guarantees "event exists iff change committed".
27. **What delivery guarantee do sockets have here?** At-least-once from the outbox; clients dedupe by `eventId` and order by `version`.
28. **How does the client handle an out-of-order event?** Ignores it if `version ≤ current`, refetches if `version > current + 1`.
29. **How does refresh-token rotation detect theft?** Each refresh token is single-use; if a rotated one is presented again later, both the thief and the user can't both be legitimate, so the family is revoked.
30. **Why is there a grace window in rotation?** Two tabs may refresh simultaneously with the same cookie; the second gets a retryable 401 instead of logging the user out everywhere.
31. **How do you prevent IDOR?** Ownership is checked against the database row (`seller_id`), and per-user resources take the user from the token, never from the URL.
32. **How are suspensions enforced immediately with stateless JWTs?** `authenticate` loads the user's current status on every request (one PK lookup) and refresh sessions are revoked.
33. **Why REST for bids instead of sockets?** Need auth, validation, idempotency, rate limiting and a committed response — request/response semantics.
34. **What's a composite index you used and why that column order?** `(status, end_time)`: equality on status first, then a range/sort on end time.
35. **What does `READ COMMITTED` change for you?** Plain reads after waiting for a lock see the newly committed data; fewer gap locks.
36. **How is anti-sniping implemented?** Optional: if a bid lands within N seconds of the end, extend `end_time` inside the same locked transaction; the closer re-checks and waits.
37. **How do you test the socket layer?** Real server on a random port, socket.io-client connections, real bids through REST, assertions on received events, cross-room isolation, targeting, reconnection.
38. **How do you keep tests independent?** Each test empties tables and the Redis test DB; the suite migrates a dedicated test database and refuses non-test URLs.

### Hard

39. **Prove the second bid sees the first's result.** It's blocked at `SELECT … FOR UPDATE`; locking reads return the latest committed version; the first has committed when the lock is released. The forced-ordering test shows the second request hasn't completed while the first holds the lock and then validates against 10,500.
40. **Could a bid be accepted after the winner is declared?** No: the closer holds the row lock while setting COMPLETED; a bid then reads COMPLETED. And independently, a bid at or after `end_time` is rejected by the DB-clock check.
41. **What if the server crashes after COMMIT but before responding?** The bid is durable. The client retries with the same key and gets `200 replayed`. The outbox emits after restart.
42. **What if it crashes after emitting but before marking the outbox row processed?** It emits again after restart; clients drop the duplicate by `eventId`/`version`.
43. **Where could your design still deadlock?** Any path locking two auction rows in different orders. The bid path locks one row; admin and lifecycle paths also lock one. If a future feature locked two, it should lock in ascending ID order. Deadlocks that do occur are retried.
44. **Why not optimistic locking with retries for everything?** Under contention on one hot auction, conflicts grow with concurrency and wasted work spikes at the end of the auction; pessimistic locking queues fairly. I keep `WHERE version = ?` as a guard.
45. **How would you raise single-auction throughput?** Shorten the critical section: move notifications and audit inserts out of the transaction into the outbox consumer, keep only bid insert + summary update + one outbox row under the lock. Batch outbox writes. Measure with the hot-auction benchmark.
46. **How would you run this on three API servers?** Load balancer; Socket.IO Redis adapter; Redis-backed rate limits; keep workers on all instances (they're lock-safe) or move them to one worker process; shared upload storage; same MySQL primary.
47. **Your cache stores a version — why not just shorter TTLs?** Short TTLs bound staleness but don't prevent a slow reader from overwriting a fresh invalidation with old data, and they increase DB load. Versions fix the race directly.
48. **What are the limits of your concurrency tests?** Single API process, single MySQL; they don't simulate network partitions or multi-instance socket delivery; the forced-ordering tests assume 400 ms is enough to observe blocking.
49. **Why does the auction have both `end_time` and `original_end_time`?** Anti-sniping may extend `end_time`; `original_end_time` records what the seller chose, for display and audit.
50. **How would you add proxy (automatic) bidding?** Store each bidder's hidden maximum; inside the same locked transaction, after accepting a bid, compute the competing maxima and generate the resulting bids (second-highest max + increment) atomically. The lock model is unchanged; it's more logic in the critical section.
51. **How would you detect shill bidding?** Signals: bidder–seller relationships (shared devices/IPs/payment), bidders who only bid on one seller's lots and never win, bid retractions. Run offline from the outbox/audit stream; flag for moderation.
52. **What would change for real money?** Payment step after winning with deadlines and second-chance offers, idempotent payment intents, refunds, reconciliation, KYC, and legal terms — all asynchronous from the bid transaction.
53. **Why keep the bid table append-only?** It's the audit trail; the summary can be rebuilt from it (the closer's cross-check relies on that).
54. **A user says their bid "disappeared". How do you investigate?** Ask for the time; search logs by user/auction for `bid accepted` / `bid rejected` with the request ID; check `bids` for their `client_request_id`; check `audit_logs`. A rejection log shows the code (e.g. `BID_TOO_LOW`) and the version they lost to.
55. **How do you know your tests would catch a regression in the lock?** I ran a mutation test: removed `FOR UPDATE` and 7 of 14 race tests failed.
