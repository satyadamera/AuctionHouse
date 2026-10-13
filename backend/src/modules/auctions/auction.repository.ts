import { sql, type Kysely } from 'kysely';
import type { AuctionStatus, Database } from '../../database/types.js';
import { formatMoney, minimumNextBid } from '../../utils/money.js';
import type { AuctionLiveState, PublicBid } from '../../shared/events.js';

/**
 * Read-side queries and the JSON shapes the API returns for auctions.
 * Write-side logic (publish, bid, close, cancel) lives in the services because it needs locks.
 */

export interface AuctionSummary {
  id: number;
  title: string;
  status: AuctionStatus;
  category: { id: number; name: string; slug: string };
  seller: { id: number; name: string };
  coverImage: string | null;
  startingPrice: string;
  currentHighestBid: string | null;
  minimumNextBid: string;
  bidCount: number;
  startTime: string;
  endTime: string;
  isFeatured: boolean;
  version: number;
}

export interface AuctionDetail extends AuctionSummary {
  description: string;
  minimumBidIncrement: string;
  originalEndTime: string;
  images: { id: number; url: string; alt: string | null }[];
  seller: { id: number; name: string; avatarUrl: string | null; memberSince: string };
  currentHighestBidder: { id: number; name: string } | null;
  winner: { id: number; name: string } | null;
  finalPrice: string | null;
  cancelReason: string | null;
  moderationStatus: string;
  completedAt: string | null;
  createdAt: string;
}

/** "Aarav Mehta" → "Aarav M." — enough to follow the bidding without exposing full identities. */
export function publicName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return parts[0] ?? 'Bidder';
  return `${parts[0]} ${parts[parts.length - 1]![0]}.`;
}

/** Shared SELECT for list views. Callers add WHERE / ORDER BY / LIMIT and map rows with toSummary. */
export function summaryQuery(db: Kysely<Database>) {
  return db
    .selectFrom('auctions as a')
    .innerJoin('categories as c', 'c.id', 'a.category_id')
    .innerJoin('users as s', 's.id', 'a.seller_id')
    .select([
      'a.id',
      'a.title',
      'a.status',
      'a.starting_price',
      'a.current_highest_bid',
      'a.minimum_bid_increment',
      'a.bid_count',
      'a.start_time',
      'a.end_time',
      'a.is_featured',
      'a.version',
      'c.id as category_id',
      'c.name as category_name',
      'c.slug as category_slug',
      's.id as seller_id',
      's.name as seller_name',
      (eb) =>
        eb
          .selectFrom('auction_images as i')
          .select('i.image_url')
          .whereRef('i.auction_id', '=', 'a.id')
          .orderBy('i.display_order')
          .limit(1)
          .as('cover_image'),
    ]);
}

type SummaryRow = Awaited<ReturnType<ReturnType<typeof summaryQuery>['executeTakeFirstOrThrow']>>;

export function toSummary(r: SummaryRow): AuctionSummary {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    category: { id: r.category_id, name: r.category_name, slug: r.category_slug },
    seller: { id: r.seller_id, name: r.seller_name },
    coverImage: r.cover_image ?? null,
    startingPrice: formatMoney(r.starting_price),
    currentHighestBid: r.current_highest_bid === null ? null : formatMoney(r.current_highest_bid),
    minimumNextBid: formatMoney(minimumNextBid(r.starting_price, r.current_highest_bid, r.minimum_bid_increment)),
    bidCount: r.bid_count,
    startTime: r.start_time.toISOString(),
    endTime: r.end_time.toISOString(),
    isFeatured: Boolean(r.is_featured),
    version: r.version,
  };
}

/** Loads the full detail snapshot — what the auction page renders and what Redis caches. */
export async function loadAuctionDetail(db: Kysely<Database>, id: number): Promise<AuctionDetail | undefined> {
  const a = await db
    .selectFrom('auctions as a')
    .innerJoin('categories as c', 'c.id', 'a.category_id')
    .innerJoin('users as s', 's.id', 'a.seller_id')
    .leftJoin('users as hb', 'hb.id', 'a.current_highest_bidder_id')
    .leftJoin('users as w', 'w.id', 'a.winner_id')
    .selectAll('a')
    .select([
      'c.name as category_name',
      'c.slug as category_slug',
      's.name as seller_name',
      's.avatar_url as seller_avatar',
      's.created_at as seller_since',
      'hb.name as leader_name',
      'w.name as winner_name',
    ])
    .where('a.id', '=', id)
    .executeTakeFirst();
  if (!a) return undefined;

  const images = await db
    .selectFrom('auction_images')
    .select(['id', 'image_url', 'alt_text'])
    .where('auction_id', '=', id)
    .orderBy('display_order')
    .execute();

  return {
    id: a.id,
    title: a.title,
    description: a.description,
    status: a.status,
    category: { id: a.category_id, name: a.category_name, slug: a.category_slug },
    seller: { id: a.seller_id, name: a.seller_name, avatarUrl: a.seller_avatar, memberSince: a.seller_since.toISOString() },
    coverImage: images[0]?.image_url ?? null,
    images: images.map((i) => ({ id: i.id, url: i.image_url, alt: i.alt_text })),
    startingPrice: formatMoney(a.starting_price),
    minimumBidIncrement: formatMoney(a.minimum_bid_increment),
    currentHighestBid: a.current_highest_bid === null ? null : formatMoney(a.current_highest_bid),
    currentHighestBidder:
      a.current_highest_bidder_id && a.leader_name ? { id: a.current_highest_bidder_id, name: publicName(a.leader_name) } : null,
    minimumNextBid: formatMoney(minimumNextBid(a.starting_price, a.current_highest_bid, a.minimum_bid_increment)),
    bidCount: a.bid_count,
    startTime: a.start_time.toISOString(),
    endTime: a.end_time.toISOString(),
    originalEndTime: a.original_end_time.toISOString(),
    isFeatured: Boolean(a.is_featured),
    winner: a.winner_id && a.winner_name ? { id: a.winner_id, name: publicName(a.winner_name) } : null,
    finalPrice: a.final_price === null ? null : formatMoney(a.final_price),
    cancelReason: a.cancel_reason,
    moderationStatus: a.moderation_status,
    completedAt: a.completed_at?.toISOString() ?? null,
    createdAt: a.created_at.toISOString(),
    version: a.version,
  };
}

export async function loadBids(db: Kysely<Database>, auctionId: number, limit: number, beforeId?: number): Promise<PublicBid[]> {
  let q = db
    .selectFrom('bids as b')
    .innerJoin('users as u', 'u.id', 'b.bidder_id')
    .select(['b.id', 'b.amount', 'b.created_at', 'u.id as bidder_id', 'u.name as bidder_name'])
    .where('b.auction_id', '=', auctionId)
    .orderBy('b.id', 'desc')
    .limit(limit);
  if (beforeId) q = q.where('b.id', '<', beforeId);
  const rows = await q.execute();
  return rows.map((r) => ({
    id: r.id,
    amount: formatMoney(r.amount),
    bidder: { id: r.bidder_id, name: publicName(r.bidder_name) },
    createdAt: r.created_at.toISOString(),
  }));
}

/** Row shape read under `SELECT … FOR UPDATE` by the bid, lifecycle and cancel paths. */
export interface LockedAuction {
  id: number;
  seller_id: number;
  title: string;
  status: AuctionStatus;
  starting_price: string;
  current_highest_bid: string | null;
  current_highest_bidder_id: number | null;
  minimum_bid_increment: string;
  bid_count: number;
  start_time: Date;
  end_time: Date;
  ending_soon_notified_at: Date | null;
  version: number;
  db_now: Date;
}

/**
 * THE row lock. `SELECT … FOR UPDATE` takes an exclusive (X) lock on the single auction row
 * identified by its primary key. Any other transaction that tries to lock the same row — another
 * bid, the lifecycle worker closing it, an admin cancelling it — blocks here until this transaction
 * commits or rolls back, and then reads the row's NEW committed values.
 *
 * Because it is a primary-key equality lookup, InnoDB locks exactly one index record (no gap or
 * range locks), so bids on OTHER auctions are never blocked.
 *
 * `UTC_TIMESTAMP(3)` is read in the same statement so every time comparison in the transaction
 * uses the database clock, not the (possibly skewed) clock of whichever API server handled the request.
 *
 * Must be called inside a transaction; outside one the lock would be released immediately.
 */
export async function lockAuction(trx: Kysely<Database>, auctionId: number): Promise<LockedAuction | undefined> {
  const result = await sql<LockedAuction>`
    SELECT id, seller_id, title, status, starting_price, current_highest_bid, current_highest_bidder_id,
           minimum_bid_increment, bid_count, start_time, end_time, ending_soon_notified_at, version,
           UTC_TIMESTAMP(3) AS db_now
      FROM auctions
     WHERE id = ${auctionId}
       FOR UPDATE`.execute(trx);
  return result.rows[0];
}

/** Live-state slice broadcast in socket events. Leader name resolved by the caller. */
export function liveState(
  a: Pick<LockedAuction, 'status' | 'starting_price' | 'current_highest_bid' | 'minimum_bid_increment' | 'bid_count' | 'end_time'>,
  leader: { id: number; name: string } | null,
): AuctionLiveState {
  return {
    status: a.status,
    currentHighestBid: a.current_highest_bid === null ? null : formatMoney(a.current_highest_bid),
    currentHighestBidder: leader,
    minimumNextBid: formatMoney(minimumNextBid(a.starting_price, a.current_highest_bid, a.minimum_bid_increment)),
    bidCount: a.bid_count,
    endTime: a.end_time.toISOString(),
  };
}
