/**
 * DEMO 2 — concurrent bidding race.  Run with the API up:  npm run demo:race
 *
 * Part 1  The safe path: A (₹10,500) and B (₹11,000) are fired at the same instant through the real
 *         REST API, many rounds. Shows each outcome, the persisted bid rows and invariant checks.
 * Part 2  Equal bids and a retried request (idempotency).
 * Part 3  50 users at once.
 * Part 4  What happens WITHOUT the row lock: a deliberately naive read-check-write implementation
 *         (in this script only — the app never does this) loses B's higher bid.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { createConnection, type Connection } from 'mysql2/promise';
import 'dotenv/config';
import { bid, c, demoAuction, heading, inr, login } from '../demo/lib.js';

const ROUNDS = Number(process.env.ROUNDS ?? 10);
const dbUrl = process.env.DATABASE_URL!;

async function dbState(conn: Connection, auctionId: number) {
  const [[a]] = (await conn.query(
    'SELECT current_highest_bid, current_highest_bidder_id, bid_count, version FROM auctions WHERE id = ?',
    [auctionId],
  )) as unknown as [[{ current_highest_bid: string; current_highest_bidder_id: number; bid_count: number; version: number }]];
  const [bids] = (await conn.query(
    'SELECT b.id, b.amount, u.name FROM bids b JOIN users u ON u.id = b.bidder_id WHERE auction_id = ? ORDER BY b.id',
    [auctionId],
  )) as unknown as [{ id: number; amount: string; name: string }[]];
  const max = bids.reduce((m, b) => Math.max(m, Number(b.amount)), 0);
  let increasing = true;
  for (let i = 1; i < bids.length; i++) if (Number(bids[i]!.amount) <= Number(bids[i - 1]!.amount)) increasing = false;
  const consistent = Number(a.current_highest_bid) === max && a.bid_count === bids.length && increasing;
  return { a, bids, consistent };
}

async function main() {
  const conn = await createConnection({ uri: dbUrl, timezone: 'Z' });
  const seller = await login('meera');
  const opener = await login('rohan');
  const A = await login('aarav');
  const B = await login('diya');

  heading(`Part 1 — A bids ₹10,500 and B bids ₹11,000 at the same instant (${ROUNDS} rounds)`);
  console.log(c.dim('Each round: fresh auction, opening bid ₹10,000 (increment ₹100), then both requests via Promise.all.\n'));
  const tally = { aFirst: 0, bFirst: 0, inconsistent: 0 };
  for (let round = 1; round <= ROUNDS; round++) {
    const id = await demoAuction(seller.token, { title: `Race demo round ${round}`, startingPrice: '10000', increment: '100', endsInSeconds: 600 });
    await bid(opener.token, id, '10000');
    const [ra, rb] = await Promise.all([bid(A.token, id, '10500'), bid(B.token, id, '11000')]);
    const { a, bids, consistent } = await dbState(conn, id);
    const order = ra.status === 201 ? 'A committed first → both accepted' : 'B committed first → A re-validated and rejected';
    if (ra.status === 201) tally.aFirst++;
    else tally.bFirst++;
    if (!consistent) tally.inconsistent++;
    console.log(
      `round ${String(round).padStart(2)}  A: ${ra.status === 201 ? c.green('201 accepted') : c.yellow(`${ra.status} ${ra.body.error?.code}`)}  ` +
        `B: ${rb.status === 201 ? c.green('201 accepted') : c.red(`${rb.status} ${rb.body.error?.code}`)}  ` +
        `bids=[${bids.map((b) => inr(b.amount)).join(', ')}]  highest=${inr(a.current_highest_bid)} v${a.version}  ` +
        `${consistent ? c.green('✓ consistent') : c.red('✗ INCONSISTENT')}  ${c.dim(order)}`,
    );
  }
  console.log(`\nOrderings seen: A-first ${tally.aFirst}, B-first ${tally.bFirst}. Inconsistent rounds: ${tally.inconsistent === 0 ? c.green('0') : c.red(String(tally.inconsistent))}`);
  console.log(c.dim('Both orderings are correct outcomes; which one happens depends on who acquires the row lock first.'));

  heading('Part 2 — equal bids and a retried request');
  const eq = await demoAuction(seller.token, { title: 'Equal bids demo', startingPrice: '10000', increment: '100', endsInSeconds: 600 });
  const [e1, e2] = await Promise.all([bid(A.token, eq, '10000'), bid(B.token, eq, '10000')]);
  console.log(`A ₹10,000 → ${e1.status} ${e1.body.error?.code ?? 'accepted'}   B ₹10,000 → ${e2.status} ${e2.body.error?.code ?? 'accepted'}   ${c.dim('(exactly one may win)')}`);
  const idem = await demoAuction(seller.token, { title: 'Idempotency demo', startingPrice: '10000', increment: '100', endsInSeconds: 600 });
  const key = randomUUID();
  const retries = await Promise.all(Array.from({ length: 5 }, () => bid(A.token, idem, '10000', key)));
  const { bids: idemBids } = await dbState(conn, idem);
  console.log(`Same clientRequestId sent 5× concurrently → statuses [${retries.map((r) => r.status).join(', ')}], bid ids [${[...new Set(retries.map((r) => r.body.data?.bid.id))].join(', ')}], rows in MySQL: ${c.bold(String(idemBids.length))}`);

  heading('Part 3 — 50 bidders at once');
  const many = await demoAuction(seller.token, { title: 'Contention demo', startingPrice: '10000', increment: '100', endsInSeconds: 600 });
  const bidders = [A, B, opener, await login('kabir'), await login('ananya')];
  const t0 = performance.now();
  const res = await Promise.all(Array.from({ length: 50 }, (_, i) => bid(bidders[i % bidders.length]!.token, many, (10000 + 100 * ((i * 7) % 50)).toFixed(2))));
  const elapsed = performance.now() - t0;
  const { a: m, bids: mb, consistent: mc } = await dbState(conn, many);
  const codes = res.reduce<Record<string, number>>((acc, r) => ((acc[r.status === 201 ? 'accepted' : r.body.error!.code] = (acc[r.status === 201 ? 'accepted' : r.body.error!.code] ?? 0) + 1), acc), {});
  console.log(`50 requests in ${elapsed.toFixed(0)} ms → ${JSON.stringify(codes)}`);
  console.log(`MySQL: ${mb.length} bid rows, bid_count=${m.bid_count}, highest=${inr(m.current_highest_bid)}, version=${m.version}  ${mc ? c.green('✓ consistent, strictly increasing') : c.red('✗ INCONSISTENT')}`);
  if (process.env.RATE_LIMIT_NOTE !== '0' && codes.RATE_LIMITED) console.log(c.yellow('Some requests hit the per-user bid rate limit (expected with 5 accounts sharing 50 requests).'));

  heading('Part 4 — the same race WITHOUT a row lock (deliberately broken, script-only)');
  console.log(c.dim('Naive algorithm: SELECT highest (no lock) → validate → [network/CPU delay] → INSERT bid → UPDATE highest.\n'));
  const naive = await demoAuction(seller.token, { title: 'Unsafe naive demo', startingPrice: '10000', increment: '100', endsInSeconds: 600 });
  await bid(opener.token, naive, '10000');
  const naiveBid = async (who: { id: number }, amount: string, delayBeforeWrite: number) => {
    const cx = await createConnection({ uri: dbUrl, timezone: 'Z' });
    await cx.beginTransaction();
    const [[row]] = (await cx.query('SELECT current_highest_bid, minimum_bid_increment FROM auctions WHERE id = ?', [naive])) as unknown as [[{ current_highest_bid: string; minimum_bid_increment: string }]];
    const ok = Number(amount) >= Number(row.current_highest_bid) + Number(row.minimum_bid_increment);
    await sleep(delayBeforeWrite);
    if (ok) {
      await cx.query('INSERT INTO bids (auction_id, bidder_id, amount, client_request_id) VALUES (?, ?, ?, ?)', [naive, who.id, amount, randomUUID()]);
      await cx.query('UPDATE auctions SET current_highest_bid = ?, current_highest_bidder_id = ?, bid_count = bid_count + 1 WHERE id = ?', [amount, who.id, naive]);
    }
    await cx.commit();
    await cx.end();
    return ok;
  };
  // Both read ₹10,000; B writes first, A writes last and overwrites the higher amount.
  const [okA, okB] = await Promise.all([naiveBid(A, '10500.00', 120), naiveBid(B, '11000.00', 20)]);
  const { a: n, bids: nb, consistent: nc } = await dbState(conn, naive);
  console.log(`A accepted: ${okA}, B accepted: ${okB}`);
  console.log(`bid rows: [${nb.map((b) => `${b.name} ${inr(b.amount)}`).join(', ')}]`);
  console.log(`auction summary says highest = ${c.bold(inr(n.current_highest_bid))}  but MAX(bids) = ${inr(Math.max(...nb.map((b) => Number(b.amount))))}  ${nc ? c.green('consistent') : c.red('✗ LOST UPDATE — B’s higher bid was overwritten')}`);
  console.log(c.dim('\nThe real service prevents this with SELECT … FOR UPDATE: B would block until A commits, then re-read the new highest.'));
  console.log(c.dim(`(The naive demo auction #${naive} is left inconsistent on purpose; run npm run db:seed to reset demo data.)`));
  await conn.end();
}

main().catch((err) => {
  console.error(c.red(String(err?.message ?? err)));
  process.exit(1);
});
