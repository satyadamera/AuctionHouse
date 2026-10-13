# Demo guide

Everything below was run in the build environment; the output shown is real (colour codes removed,
long lines trimmed). Your IDs, times and the A/B ordering counts will differ.

## Setup (once)

```powershell
copy .env.example backend\.env
docker compose up -d
npm install
npm run db:migrate
npm run db:seed          # resets demo data; run again before an interview
npm run dev              # API http://localhost:4000, web http://localhost:5173
```

Check: http://localhost:4000/health/ready → `"status":"ok"`. Demo password for all accounts: `Auctra@2026`.

Tip: the race demo deliberately leaves one auction inconsistent and creates extra lots. Run
`npm run db:seed` afterwards to get a clean marketplace.

---

## Demo 1 — live bidding in two browsers

1. Chrome: http://localhost:5173 → **Sign in** → click the `aarav` demo button → Sign in.
2. Open the lot in the hero ("On the block now") — note its URL.
3. Incognito window (separate cookies = separate person): sign in as `diya`, open the same URL.
4. Both panels show **Live** and the viewer count reads 2.
5. Aarav: the bid box is pre-filled with the next minimum → **Place bid** → confirm.
   - Aarav: "You're the highest bidder", the price rolls, success toast.
   - Diya, without refreshing: the price rolls with a brief brass flash, "Leading: Aarav M.", a new
     row in Bid history and a line in Live activity.
6. Diya: choose a quick amount → Place bid → confirm.
   - Aarav: "You've been outbid" in the panel, a red toast with **Bid again**, the bell count increases.
7. Both windows show the same price. Bid history lists both bids; reload either page — still there
   (persisted in MySQL).

Talking points: the bid went over REST and committed before any socket event was sent; Diya's screen
was updated by an outbox event carrying version *n+1*; Aarav's own echo of that event was ignored
because his UI had already applied the REST response.

Automated version: `PLAYWRIGHT_CHROMIUM_EXECUTABLE=… npm run test:e2e` (or plain `npm run test:e2e`
after `npx playwright install chromium`).

## Demo 2 — the concurrent bid race

```bash
npm run demo:race          # ROUNDS=20 npm run demo:race for more rounds
```

```
Part 1 — A bids ₹10,500 and B bids ₹11,000 at the same instant (10 rounds)
round  1  A: 201 accepted  B: 201 accepted  bids=[₹10,000.00, ₹10,500.00, ₹11,000.00]  highest=₹11,000.00 v4  ✓ consistent  A committed first → both accepted
round  3  A: 409 BID_TOO_LOW  B: 201 accepted  bids=[₹10,000.00, ₹11,000.00]  highest=₹11,000.00 v3  ✓ consistent  B committed first → A re-validated and rejected
…
Orderings seen: A-first 6, B-first 4. Inconsistent rounds: 0

Part 2 — equal bids and a retried request
A ₹10,000 → 409 BID_TOO_LOW   B ₹10,000 → 201 accepted   (exactly one may win)
Same clientRequestId sent 5× concurrently → statuses [201, 200, 200, 200, 200], bid ids [169], rows in MySQL: 1

Part 3 — 50 bidders at once
50 requests in 538 ms → {"accepted":6,"BID_TOO_LOW":44}
MySQL: 6 bid rows, bid_count=6, highest=₹14,900.00, version=7  ✓ consistent, strictly increasing

Part 4 — the same race WITHOUT a row lock (deliberately broken, script-only)
A accepted: true, B accepted: true
bid rows: [Rohan Das ₹10,000.00, Diya Sharma ₹11,000.00, Aarav Mehta ₹10,500.00]
auction summary says highest = ₹10,500.00  but MAX(bids) = ₹11,000.00  ✗ LOST UPDATE — B's higher bid was overwritten
```

What to point at: the "version" column (one increment per accepted bid), that both orderings occur
and both are correct, and Part 4 as the failure the lock prevents. Then open
`backend/src/modules/auctions/auction.repository.ts → lockAuction()` and
`backend/src/modules/bids/bid.service.ts → attemptBid()`. For a deterministic proof, run
`npm run test:concurrency` and show the "A locks first / B locks first" tests.

## Demo 3 — Redis caching

```bash
npm run demo:cache
```

```
Cache-aside on GET /api/v1/auctions/8  ("Retro game controller, first production run")
1. cleared auctra:v1:auction:detail:8  → exists in Redis: 0
2. first read (cold cache)         X-Cache: MISS  SQL queries: 2     9.3 ms  → highest ₹7,200.00, 12 bids, v13
   key now exists: 1, TTL 60s
3. second read (warm cache)        X-Cache: HIT   SQL queries: 0     7.6 ms  → highest ₹7,200.00, 12 bids, v13
4. Kabir Singh bids ₹7,300.00 → HTTP 201, new version v14
5. after commit the bid path invalidated the key → exists in Redis: 0, min-version marker = 14
6. read after bid                  X-Cache: MISS  SQL queries: 2    12.0 ms  → highest ₹7,300.00, 13 bids, v14
7. MySQL says highest ₹7,300.00, 13 bids, v14  → ✓ API matches MySQL
   next read (warm again)          X-Cache: HIT   SQL queries: 0     5.0 ms  → highest ₹7,300.00, 13 bids, v14
```

The point is the **SQL query count** (2 → 0), not the single-request milliseconds, which are
dominated by dev-mode logging. For throughput and latency under load, run `npm run bench` (~1 minute)
and see README §17. You can also watch it by hand: `curl -si localhost:4000/api/v1/auctions/8 | grep -i x-`.

## Demo 4 — auction completion

```bash
npm run demo:lifecycle      # DURATION=40 npm run demo:lifecycle for a longer countdown
```

```
Auction #40 — ends in 12s (closed by the server-side lifecycle worker, not the browser)
Aarav Mehta   bids ₹5,000.00  → HTTP 201
   socket  auction:bid_placed v2 ₹5,000.00 by Aarav M.
Diya Sharma   bids ₹5,500.00  → HTTP 201
Kabir Singh   bids ₹6,000.00  → HTTP 201
   socket  notification:new → BID_ACCEPTED: Your bid of ₹6,000.00 on "Lifecycle demo lot" is the highest.
   socket  notification:new → AUCTION_ENDING_SOON: "Lifecycle demo lot" ends in under a minute.
auction:ended v5 — winner Kabir S. at ₹6,000.00
   socket  notification:new → AUCTION_WON: You won "Lifecycle demo lot" for ₹6,000.00.
GET /auctions/40 → status COMPLETED, winner Kabir S., final price ₹6,000.00
Late bid by Aarav Mehta → HTTP 409 AUCTION_ENDED
Kabir Singh's "won auctions" dashboard now includes #40: yes
```

To show it in the browser: open the printed lot ID at `/auctions/<id>` while the script runs — the
countdown reaches zero, "Closing…" shows briefly, then the panel switches to the hammer price and
winner when `auction:ended` arrives. Log in as `kabir` and open **My bids → Won**.

## Demo 5 — authorization

1. Sign in as `rohan` (bidder). Go to http://localhost:5173/sell → "Seller accounts only".
   Server proof:
   ```bash
   TOKEN=$(curl -s -X POST localhost:4000/api/v1/auth/login -H 'content-type: application/json' \
     -d '{"email":"rohan@auctra.dev","password":"Auctra@2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.accessToken')
   curl -s -X POST localhost:4000/api/v1/auctions -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}'
   # {"success":false,"error":{"code":"FORBIDDEN","message":"This action requires role: SELLER", …}}
   ```
2. Sign in as `meera` (seller) → **Sell** → add a photo (any JPEG/PNG), fill the form → **Publish**.
   The lot opens; seller tools show Edit/Cancel; the bid form is replaced by "This is your listing".
3. Sign in as `admin` → **Administration**: totals, charts, System panel (cache hit rate, outbox).
   **Listings** → Reject Meera's new lot with a reason → Meera gets a "Listing rejected" notification.
   **Users** → Suspend `rohan` → his open session fails on the next request (403 ACCOUNT_SUSPENDED).
   **Audit log** shows every step.

## Five-minute script

| Minute | Show | Say |
|---|---|---|
| 0:00 | Home page | "React SPA, Node/Express API, MySQL as source of truth, Redis cache, Socket.IO." |
| 0:30 | Demo 1 in two windows | "Bids go over REST into a locked transaction; viewers get the committed result over a socket." |
| 1:45 | `npm run demo:race` | "Both orderings are legal; the naive version at the bottom loses an update — that's what `FOR UPDATE` prevents." |
| 3:00 | `lockAuction` + `attemptBid` in the editor | Walk steps 2–8; idempotency before rules; DB clock; outbox. |
| 3:45 | `npm run demo:cache` | "Hit served with zero SQL; invalidation after commit; versions stop stale write-backs." |
| 4:30 | Admin dashboard | RBAC, audit log, diagnostics. Close with the test counts. |
