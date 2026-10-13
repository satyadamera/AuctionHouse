/**
 * DEMO 4 — auction completion.  Run with the API up:  npm run demo:lifecycle
 * Creates a 20-second auction, places bids from three users, listens on Socket.IO as the eventual
 * winner, waits for the lifecycle worker to close it, then shows that a late bid is rejected.
 */
import 'dotenv/config';
import { io } from 'socket.io-client';
import { api, API, bid, c, demoAuction, heading, inr, login } from './lib.js';

const DURATION = Number(process.env.DURATION ?? 20);

async function main() {
  const seller = await login('arjun');
  const [a, b, k] = await Promise.all([login('aarav'), login('diya'), login('kabir')]);
  const id = await demoAuction(seller.token, { title: 'Lifecycle demo lot', startingPrice: '5000', increment: '250', endsInSeconds: DURATION, imageUrl: '/static/seed/turntable.svg' });
  heading(`Auction #${id} — ends in ${DURATION}s (closed by the server-side lifecycle worker, not the browser)`);

  // Winner listens for live events and private notifications.
  const sock = io(API, { path: '/socket.io', transports: ['websocket'], auth: { token: k.token } });
  await new Promise<void>((r) => sock.on('connect', () => r()));
  await new Promise((r) => sock.emit('auction:join', id, r));
  sock.on('auction:bid_placed', (e) => console.log(c.dim(`   socket  auction:bid_placed v${e.version} ${inr(e.data.bid.amount)} by ${e.data.bid.bidder.name}`)));
  sock.on('notification:new', (e) => console.log(c.cyan(`   socket  notification:new → ${e.data.type}: ${e.data.message}`)));
  const ended = new Promise<{ data: { winner: { name: string } | null; finalPrice: string | null }; version: number }>((r) => sock.on('auction:ended', r));

  for (const [u, amt] of [[a, '5000'], [b, '5500'], [k, '6000']] as const) {
    const r = await bid(u.token, id, amt);
    console.log(`${u.name.padEnd(13)} bids ${inr(amt).padEnd(10)} → HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 400));
  }

  const t0 = Date.now();
  const tick = setInterval(() => process.stdout.write(c.dim(`\r   waiting for end time… ${Math.round((Date.now() - t0) / 1000)}s`)), 1000);
  const e = await ended;
  clearInterval(tick);
  console.log(`\n${c.green('auction:ended')} v${e.version} — winner ${c.bold(e.data.winner?.name ?? 'none')} at ${inr(e.data.finalPrice)}`);

  const detail = await api<{ status: string; winner: { name: string }; finalPrice: string }>(`/auctions/${id}`);
  console.log(`GET /auctions/${id} → status ${detail.body.data.status}, winner ${detail.body.data.winner?.name}, final price ${inr(detail.body.data.finalPrice)}`);
  const late = await bid(a.token, id, '9000');
  console.log(`Late bid by ${a.name} → HTTP ${late.status} ${c.yellow(late.body.error?.code ?? '')}`);
  const won = await api<{ auction: { id: number } }[]>('/users/me/won-auctions', { token: k.token });
  console.log(`${k.name}'s “won auctions” dashboard now includes #${id}: ${won.body.data.some((w) => w.auction.id === id) ? c.green('yes') : c.red('no')}`);
  await new Promise((r) => setTimeout(r, 500));
  sock.disconnect();
}

main().catch((err) => {
  console.error(c.red(String(err?.message ?? err)));
  process.exit(1);
});
