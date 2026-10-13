import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/**
 * Kysely table types. These mirror database/migrations/*.sql exactly; Kysely uses them to type-check
 * every query at compile time (wrong column names or types fail `npm run typecheck`).
 *
 * DECIMAL columns are `string` (mysql2 returns them as strings to avoid float rounding).
 * DATETIME columns are `Date` (connection timezone is UTC).
 */
type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type Money = string;

export type Role = 'USER' | 'SELLER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED';
export type AuctionStatus = 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type ModerationStatus = 'PENDING' | 'APPROVED' | 'REJECTED';
export type NotificationType =
  | 'BID_ACCEPTED'
  | 'OUTBID'
  | 'AUCTION_ENDING_SOON'
  | 'AUCTION_WON'
  | 'AUCTION_LOST'
  | 'AUCTION_SOLD'
  | 'AUCTION_ENDED_NO_BIDS'
  | 'LISTING_APPROVED'
  | 'LISTING_REJECTED'
  | 'AUCTION_CANCELLED';

export interface UsersTable {
  id: Generated<number>;
  name: string;
  email: string;
  password_hash: string;
  role: ColumnType<Role, Role | undefined, Role>;
  avatar_url: string | null;
  status: ColumnType<UserStatus, UserStatus | undefined, UserStatus>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface CategoriesTable {
  id: Generated<number>;
  name: string;
  slug: string;
  description: string | null;
  image_url: string | null;
}

export interface AuctionsTable {
  id: Generated<number>;
  seller_id: number;
  category_id: number;
  title: string;
  description: string;
  starting_price: Money;
  current_highest_bid: Money | null;
  current_highest_bidder_id: number | null;
  minimum_bid_increment: Money;
  bid_count: Generated<number>;
  start_time: Timestamp;
  end_time: Timestamp;
  original_end_time: Timestamp;
  status: ColumnType<AuctionStatus, AuctionStatus | undefined, AuctionStatus>;
  moderation_status: ColumnType<ModerationStatus, ModerationStatus | undefined, ModerationStatus>;
  is_featured: ColumnType<number, number | boolean | undefined, number | boolean>;
  winner_id: number | null;
  final_price: Money | null;
  cancel_reason: string | null;
  ending_soon_notified_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  completed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  version: Generated<number>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface AuctionImagesTable {
  id: Generated<number>;
  auction_id: number;
  image_url: string;
  alt_text: string | null;
  display_order: number;
}

export interface BidsTable {
  id: Generated<number>;
  auction_id: number;
  bidder_id: number;
  amount: Money;
  client_request_id: string;
  created_at: ColumnType<Date, Date | string | undefined, never>;
}

export interface WatchlistTable {
  user_id: number;
  auction_id: number;
  created_at: Generated<Date>;
}

export interface NotificationsTable {
  id: Generated<number>;
  user_id: number;
  type: NotificationType;
  title: string;
  message: string;
  auction_id: number | null;
  is_read: ColumnType<number, number | boolean | undefined, number | boolean>;
  created_at: Generated<Date>;
}

export interface RefreshSessionsTable {
  id: Generated<number>;
  user_id: number;
  token_hash: string;
  family_id: string;
  expires_at: Timestamp;
  rotated_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  revoked_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
  user_agent: string | null;
  created_at: Generated<Date>;
}

export interface AuditLogsTable {
  id: Generated<number>;
  actor_id: number | null;
  action: string;
  entity_type: string;
  entity_id: number | null;
  metadata: ColumnType<unknown, string | null, string | null>;
  created_at: Generated<Date>;
}

export interface OutboxEventsTable {
  id: Generated<number>;
  event_id: string;
  type: string;
  auction_id: number | null;
  user_id: number | null;
  version: number | null;
  payload: ColumnType<unknown, string, string>;
  attempts: Generated<number>;
  last_error: string | null;
  created_at: Generated<Date>;
  processed_at: ColumnType<Date | null, Date | null | undefined, Date | null>;
}

export interface SchemaMigrationsTable {
  name: string;
  applied_at: Generated<Date>;
}

export interface Database {
  users: UsersTable;
  categories: CategoriesTable;
  auctions: AuctionsTable;
  auction_images: AuctionImagesTable;
  bids: BidsTable;
  watchlist: WatchlistTable;
  notifications: NotificationsTable;
  refresh_sessions: RefreshSessionsTable;
  audit_logs: AuditLogsTable;
  outbox_events: OutboxEventsTable;
  schema_migrations: SchemaMigrationsTable;
}

export type UserRow = Selectable<UsersTable>;
export type AuctionRow = Selectable<AuctionsTable>;
export type NewAuction = Insertable<AuctionsTable>;
export type AuctionUpdate = Updateable<AuctionsTable>;
export type BidRow = Selectable<BidsTable>;
export type NotificationRow = Selectable<NotificationsTable>;
