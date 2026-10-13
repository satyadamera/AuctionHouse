/**
 * Repeatable demo seed: `npm run db:seed` (or `npm run db:reset` for drop + migrate + seed).
 *
 * - Wipes all data tables first, so running it twice gives the same marketplace.
 * - Auction times are relative to "now" so there are always live, ending-soon, scheduled and
 *   completed auctions whenever you seed.
 * - Bid histories come from a fixed-seed PRNG, so amounts and bidders are identical on every run.
 * - Refuses to run in production: the demo password below is public.
 */
import bcrypt from 'bcryptjs';
import { sql } from 'kysely';
import { env } from '../../src/config/env.js';
import { closeDb, getDb } from '../../src/database/db.js';
import { runMigrations } from '../../src/database/migrate.js';
import { closeRedis, getRedis, waitForRedis } from '../../src/cache/redis.js';
import { formatMoney } from '../../src/utils/money.js';
import { Decimal } from 'decimal.js';
import type { AuctionStatus, Role } from '../../src/database/types.js';

export const DEMO_PASSWORD = 'Auctra@2026';

if (env.isProduction) {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

// Mulberry32: tiny deterministic PRNG.
function prng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(20261013);

const users: { key: string; name: string; email: string; role: Role }[] = [
  { key: 'admin', name: 'Ira Sen', email: 'admin@auctra.dev', role: 'ADMIN' },
  { key: 'meera', name: 'Meera Kapoor', email: 'meera@auctra.dev', role: 'SELLER' },
  { key: 'arjun', name: 'Arjun Rao', email: 'arjun@auctra.dev', role: 'SELLER' },
  { key: 'aarav', name: 'Aarav Mehta', email: 'aarav@auctra.dev', role: 'USER' },
  { key: 'diya', name: 'Diya Sharma', email: 'diya@auctra.dev', role: 'USER' },
  { key: 'kabir', name: 'Kabir Singh', email: 'kabir@auctra.dev', role: 'USER' },
  { key: 'ananya', name: 'Ananya Iyer', email: 'ananya@auctra.dev', role: 'USER' },
  { key: 'rohan', name: 'Rohan Das', email: 'rohan@auctra.dev', role: 'USER' },
];
const bidderKeys = ['aarav', 'diya', 'kabir', 'ananya', 'rohan'];

const categories = [
  { slug: 'watches', name: 'Watches', description: 'Mechanical and quartz timepieces, from field watches to grand complications.', image: 'watch-chronograph' },
  { slug: 'electronics', name: 'Electronics', description: 'Audio, cameras and design-led hardware with a story.', image: 'headphones' },
  { slug: 'art', name: 'Art', description: 'Paintings, prints and sculpture from independent studios.', image: 'art-circles' },
  { slug: 'collectibles', name: 'Collectibles', description: 'Coins, cards, toys and objects worth keeping.', image: 'tin-robot' },
  { slug: 'sneakers', name: 'Sneakers', description: 'Deadstock and rare pairs, authenticated by the seller.', image: 'sneaker-high-red' },
];

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * Each lot: timing is relative to now. `start`/`end` are offsets in ms.
 * status is derived from timing except for drafts and cancelled lots.
 */
interface Lot {
  title: string;
  description: string;
  category: string;
  seller: 'meera' | 'arjun';
  art: string;
  start: number;
  end: number;
  price: number;
  increment: number;
  bids: number;
  featured?: boolean;
  draft?: boolean;
  cancel?: string;
}

const lots: Lot[] = [
  { title: 'Steel chronograph, 1972, panda dial', category: 'watches', seller: 'meera', art: 'watch-chronograph', start: -2 * DAY, end: 4 * MIN, price: 85000, increment: 1000, bids: 11, featured: true,
    description: 'Manual-wind column-wheel chronograph in a 38 mm steel case. Cream dial with three registers, original hands, recently serviced with service papers. Light hairlines on the case, crystal replaced in 2019. Comes with a period-correct leather strap and a spare steel bracelet.' },
  { title: 'Dive watch with blue aluminium bezel', category: 'watches', seller: 'meera', art: 'watch-diver', start: -1 * DAY, end: 22 * MIN, price: 42000, increment: 500, bids: 8,
    description: 'Automatic diver, 40 mm, 200 m water resistance. Unidirectional bezel with a faded blue insert and lume plots that have aged evenly. Keeps time within +6 s/day. Includes box and the original rubber strap.' },
  { title: 'Gold dress watch, hand-wound, 34 mm', category: 'watches', seller: 'meera', art: 'watch-dress', start: -3 * DAY, end: 2 * DAY, price: 120000, increment: 2000, bids: 6, featured: true,
    description: '18k yellow gold case with a sector-style champagne dial. Slim hand-wound movement, recently overhauled. Hallmarks crisp, no polishing to speak of. A quiet, classic watch for formal occasions.' },
  { title: 'Military field watch, olive dial', category: 'watches', seller: 'arjun', art: 'watch-field', start: -6 * HOUR, end: 3 * HOUR, price: 9500, increment: 250, bids: 5,
    description: 'Hand-wound field watch, 36 mm, with a matte olive dial and cream numerals. Issue markings on the caseback. Supplied on a canvas strap. A great first vintage watch.' },
  { title: 'Studio headphones, walnut and brass', category: 'electronics', seller: 'arjun', art: 'headphones', start: -1 * DAY, end: 7 * MIN, price: 18000, increment: 500, bids: 9, featured: true,
    description: 'Open-back studio headphones with walnut cups and brass yokes. Planar drivers, detachable cable, replacement pads included. Used in a home studio for six months, excellent condition.' },
  { title: 'Rangefinder camera with 50 mm lens', category: 'electronics', seller: 'arjun', art: 'camera-rangefinder', start: -2 * DAY, end: 26 * HOUR, price: 65000, increment: 1000, bids: 7,
    description: 'Black-paint film rangefinder with a 50 mm f/2 lens. Shutter speeds accurate on test, rangefinder patch bright and aligned. Brassing on the edges from honest use. Test roll scans available on request.' },
  { title: 'Belt-drive turntable, teak plinth', category: 'electronics', seller: 'arjun', art: 'turntable', start: -12 * HOUR, end: 5 * HOUR, price: 22000, increment: 500, bids: 4,
    description: 'Belt-drive turntable on a solid teak plinth with a new belt and a cartridge with low hours. Runs at speed on both 33 and 45. Dust cover has light scratches.' },
  { title: 'Retro game controller, first production run', category: 'electronics', seller: 'arjun', art: 'gamepad', start: -1 * DAY, end: 40 * MIN, price: 4500, increment: 100, bids: 12,
    description: 'Controller from the first production run, serial under 1,000. All buttons responsive, cable intact. Minor yellowing on the shell. A collector piece rather than a daily player.' },
  { title: 'Mechanical keyboard, brass knob edition', category: 'electronics', seller: 'meera', art: 'keyboard', start: 2 * HOUR, end: 2 * DAY, price: 15000, increment: 250, bids: 0,
    description: 'Limited 65% mechanical keyboard with an aluminium case, brass rotary knob and hand-lubed tactile switches. Comes with a spare keycap set and coiled cable. Bidding opens soon.' },
  { title: 'Engineering prototype phone, unreleased colour', category: 'electronics', seller: 'arjun', art: 'phone-prototype', start: -5 * DAY, end: -1 * DAY, price: 30000, increment: 500, bids: 9,
    description: 'Pre-production handset in a colour that never shipped. Powers on to a factory test menu. Sold as a display piece only; no warranty or network use.' },
  { title: 'Three bands, acrylic on canvas', category: 'art', seller: 'meera', art: 'art-color-fields', start: -1 * DAY, end: 90 * MIN, price: 55000, increment: 1000, bids: 6, featured: true,
    description: 'Colour-field study in red, green and ochre, 60 × 75 cm, signed and dated on the reverse. Unframed edges are painted. Shipped crated.' },
  { title: 'Orbits, oil on linen, framed', category: 'art', seller: 'meera', art: 'art-circles', start: -2 * DAY, end: 3 * DAY, price: 72000, increment: 1500, bids: 3,
    description: 'Three overlapping circles in deep green, ochre and vermilion over a cream ground. 50 × 60 cm in a gilt wood frame. From the artist’s 2021 studio series.' },
  { title: 'Valley at dusk, gouache', category: 'art', seller: 'arjun', art: 'art-landscape', start: -4 * DAY, end: -2 * DAY, price: 26000, increment: 500, bids: 7,
    description: 'Small gouache landscape with a low sun over layered hills, 30 × 40 cm, framed behind museum glass.' },
  { title: 'Cast bronze form on stone base', category: 'art', seller: 'meera', art: 'art-sculpture', start: 1 * DAY, end: 4 * DAY, price: 140000, increment: 2500, bids: 0, featured: true,
    description: 'Abstract cast bronze with a dark patina, 42 cm tall, on a limestone base. Edition 3 of 8, foundry-stamped. Preview available in the gallery before bidding opens.' },
  { title: '1888 gold sovereign, high grade', category: 'collectibles', seller: 'meera', art: 'coin-gold', start: -3 * DAY, end: 14 * HOUR, price: 48000, increment: 500, bids: 10,
    description: 'Gold sovereign dated 1888 with strong detail and original lustre. Graded and encapsulated. Weight and diameter verified.' },
  { title: 'Silver rupee, Bombay mint', category: 'collectibles', seller: 'arjun', art: 'coin-silver', start: -1 * DAY, end: 18 * MIN, price: 6500, increment: 100, bids: 9,
    description: 'Silver one-rupee coin from the Bombay mint, light toning and sharp rims. A clean example of a popular type.' },
  { title: 'First-edition trading card, holo', category: 'collectibles', seller: 'arjun', art: 'trading-card', start: -2 * DAY, end: 30 * HOUR, price: 35000, increment: 500, bids: 8, featured: true,
    description: 'First-edition holographic card in near-mint condition, centred well, sleeved since opening. Ships in a rigid case.' },
  { title: 'Wind-up tin robot, boxed', category: 'collectibles', seller: 'meera', art: 'tin-robot', start: -6 * DAY, end: -3 * DAY, price: 12000, increment: 250, bids: 6,
    description: 'Lithographed tin robot with working wind-up walking action and sparking chest. Original box with some edge wear.' },
  { title: 'Fountain pen, green resin, 18k nib', category: 'collectibles', seller: 'meera', art: 'fountain-pen', start: -1 * DAY, end: 8 * HOUR, price: 14000, increment: 250, bids: 5,
    description: 'Piston-filling fountain pen in deep green resin with gold trim and a medium 18k nib. Writes wet and smooth. Box and papers included.' },
  { title: 'Studio stoneware vase, cobalt glaze', category: 'collectibles', seller: 'arjun', art: 'studio-vase', start: -1 * DAY, end: 2 * DAY, price: 8000, increment: 200, bids: 2,
    description: 'Wheel-thrown stoneware vase, 34 cm, in cobalt glaze with two cream bands. Signed on the base. No chips or crazing.' },
  { title: 'Low-top leather sneakers, size UK 9', category: 'sneakers', seller: 'arjun', art: 'sneaker-low-white', start: -12 * HOUR, end: 12 * MIN, price: 11000, increment: 250, bids: 7,
    description: 'Deadstock low-top in white full-grain leather with a green heel tab. Size UK 9, original box and spare laces.' },
  { title: 'High-top, red suede, 2016 release', category: 'sneakers', seller: 'arjun', art: 'sneaker-high-red', start: -1 * DAY, end: 36 * HOUR, price: 24000, increment: 500, bids: 6, featured: true,
    description: 'Red suede high-top from a 2016 limited release, worn twice indoors. Size UK 10. Box included, receipt available.' },
  { title: 'Runner, slate and gold, sample pair', category: 'sneakers', seller: 'arjun', art: 'sneaker-runner', start: 6 * HOUR, end: 3 * DAY, price: 16000, increment: 250, bids: 0,
    description: 'Factory sample runner in slate mesh with a gold swoosh-free stripe. Size UK 8.5, sample tag inside the tongue.' },
  { title: 'Pocket watch movement, display case', category: 'watches', seller: 'meera', art: 'watch-dress', start: 1 * DAY, end: 5 * DAY, price: 20000, increment: 500, bids: 0, draft: true,
    description: 'Draft listing: a key-wound pocket watch movement in a glass display case. Photos still being prepared.' },
  { title: 'Signed concert poster (withdrawn)', category: 'collectibles', seller: 'arjun', art: 'art-color-fields', start: -1 * DAY, end: 1 * DAY, price: 5000, increment: 100, bids: 0, cancel: 'Seller could not verify the signature’s provenance.',
    description: 'Withdrawn listing kept for the demo of cancelled auctions.' },
];

async function main() {
  const db = getDb();
  await runMigrations(env.databaseUrl, (m) => console.log(`[seed] ${m}`));

  console.log('[seed] clearing existing data');
  await sql`SET FOREIGN_KEY_CHECKS = 0`.execute(db);
  for (const t of ['outbox_events', 'audit_logs', 'refresh_sessions', 'notifications', 'watchlist', 'bids', 'auction_images', 'auctions', 'categories', 'users']) {
    await sql`TRUNCATE TABLE ${sql.table(t)}`.execute(db);
  }
  await sql`SET FOREIGN_KEY_CHECKS = 1`.execute(db);

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const userIds: Record<string, number> = {};
  for (const u of users) {
    const r = await db.insertInto('users').values({ name: u.name, email: u.email, role: u.role, password_hash: hash }).executeTakeFirstOrThrow();
    userIds[u.key] = Number(r.insertId);
  }
  const catIds: Record<string, number> = {};
  for (const c of categories) {
    const r = await db
      .insertInto('categories')
      .values({ slug: c.slug, name: c.name, description: c.description, image_url: `/static/seed/${c.image}.svg` })
      .executeTakeFirstOrThrow();
    catIds[c.slug] = Number(r.insertId);
  }

  const { rows } = await sql<{ now: Date }>`SELECT UTC_TIMESTAMP(3) AS now`.execute(db);
  const now = rows[0]!.now.getTime();
  const counts: Record<string, number> = {};

  for (const lot of lots) {
    const start = new Date(now + lot.start);
    const end = new Date(now + lot.end);
    const status: AuctionStatus = lot.draft ? 'DRAFT' : lot.cancel ? 'CANCELLED' : lot.start > 0 ? 'SCHEDULED' : lot.end <= 0 ? 'COMPLETED' : 'ACTIVE';
    counts[status] = (counts[status] ?? 0) + 1;

    // Build a valid, strictly increasing bid ladder between start and min(now, end).
    const bidEnd = Math.min(now - 30_000, end.getTime() - 60_000);
    const ladder: { bidder: number; amount: string; at: Date }[] = [];
    let current: Decimal | null = null;
    let lastBidder = '';
    for (let i = 0; i < lot.bids; i++) {
      const min: Decimal = current === null ? new Decimal(lot.price) : current.plus(lot.increment);
      const steps = Math.floor(rand() * 4); // 0–3 extra increments
      const amount: Decimal = min.plus(new Decimal(lot.increment).times(steps));
      let bidderKey: string;
      do bidderKey = bidderKeys[Math.floor(rand() * bidderKeys.length)]!;
      while (bidderKey === lastBidder);
      const at = new Date(start.getTime() + ((bidEnd - start.getTime()) * (i + 1)) / (lot.bids + 1));
      ladder.push({ bidder: userIds[bidderKey]!, amount: formatMoney(amount), at });
      current = amount;
      lastBidder = bidderKey;
    }
    const top = ladder[ladder.length - 1];

    const r = await db
      .insertInto('auctions')
      .values({
        seller_id: userIds[lot.seller]!,
        category_id: catIds[lot.category]!,
        title: lot.title,
        description: lot.description,
        starting_price: formatMoney(lot.price),
        minimum_bid_increment: formatMoney(lot.increment),
        current_highest_bid: top?.amount ?? null,
        current_highest_bidder_id: top?.bidder ?? null,
        bid_count: ladder.length,
        start_time: start,
        end_time: end,
        original_end_time: end,
        status,
        is_featured: Boolean(lot.featured),
        winner_id: status === 'COMPLETED' ? (top?.bidder ?? null) : null,
        final_price: status === 'COMPLETED' ? (top?.amount ?? null) : null,
        completed_at: status === 'COMPLETED' ? end : null,
        cancel_reason: lot.cancel ?? null,
        version: 1 + ladder.length + (status === 'COMPLETED' ? 1 : 0),
        created_at: new Date(Math.min(start.getTime(), now) - 2 * HOUR),
      })
      .executeTakeFirstOrThrow();
    const auctionId = Number(r.insertId);
    await db
      .insertInto('auction_images')
      .values([
        { auction_id: auctionId, image_url: `/static/seed/${lot.art}.svg`, alt_text: lot.title, display_order: 0 },
        { auction_id: auctionId, image_url: `/static/seed/${lot.art}-alt.svg`, alt_text: `${lot.title} — studio view`, display_order: 1 },
      ])
      .execute();
    if (ladder.length) {
      await db
        .insertInto('bids')
        .values(ladder.map((b, i) => ({ auction_id: auctionId, bidder_id: b.bidder, amount: b.amount, client_request_id: `seed-${auctionId}-${i + 1}`, created_at: b.at })))
        .execute();
    }
    if (status === 'COMPLETED' && top) {
      await db
        .insertInto('notifications')
        .values({ user_id: top.bidder, type: 'AUCTION_WON', title: 'You won!', message: `You won “${lot.title}”.`, auction_id: auctionId, created_at: end })
        .execute();
    }
  }

  // A few watchlist entries and notifications so dashboards are not empty on first login.
  const firstAuctions = await db.selectFrom('auctions').select('id').where('status', '=', 'ACTIVE').orderBy('end_time').limit(4).execute();
  for (const a of firstAuctions) {
    await db.insertInto('watchlist').ignore().values({ user_id: userIds.aarav!, auction_id: a.id }).execute();
    await db.insertInto('watchlist').ignore().values({ user_id: userIds.diya!, auction_id: a.id }).execute();
  }
  await db.insertInto('audit_logs').values({ actor_id: userIds.admin!, action: 'DEMO_SEEDED', entity_type: 'system', entity_id: null, metadata: JSON.stringify({ lots: lots.length }) }).execute();

  // Drop any cached snapshots from a previous seed.
  if (await waitForRedis(2000)) {
    const keys = await getRedis().keys('auctra:v1:*');
    if (keys.length) await getRedis().del(...keys);
  }

  console.log(`[seed] ${users.length} users, ${categories.length} categories, ${lots.length} auctions`, counts);
  console.log(`[seed] demo password for every account: ${DEMO_PASSWORD}  (development only)`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeRedis();
    await closeDb();
  });
