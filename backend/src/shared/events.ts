/**
 * Socket.IO event contracts. The frontend keeps an identical copy in src/types/events.ts.
 *
 * Every server→client event uses the same envelope:
 *   eventId    — unique per event (outbox event_id). Clients drop duplicates (at-least-once delivery).
 *   version    — the auction's version AFTER this change. Clients ignore state events whose version
 *                is not newer than what they already show, and re-fetch from the REST API when they
 *                detect a gap (version jumped by more than 1 → an event was missed).
 *   occurredAt — ISO timestamp from the database clock.
 */
export interface EventEnvelope<TType extends string, TData> {
  eventId: string;
  type: TType;
  auctionId: number | null;
  version: number | null;
  occurredAt: string;
  data: TData;
}

export interface AuctionLiveState {
  status: 'DRAFT' | 'SCHEDULED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
  currentHighestBid: string | null;
  currentHighestBidder: { id: number; name: string } | null;
  minimumNextBid: string;
  bidCount: number;
  endTime: string;
}

export interface PublicBid {
  id: number;
  amount: string;
  bidder: { id: number; name: string };
  createdAt: string;
}

export type BidPlacedEvent = EventEnvelope<'auction:bid_placed', { bid: PublicBid; state: AuctionLiveState; extended: boolean }>;
export type PriceUpdatedEvent = EventEnvelope<'auction:price_updated', { currentHighestBid: string; bidCount: number; endTime: string }>;
export type AuctionStartedEvent = EventEnvelope<'auction:started', { state: AuctionLiveState }>;
export type AuctionEndingSoonEvent = EventEnvelope<'auction:ending_soon', { endTime: string; secondsRemaining: number }>;
export type AuctionEndedEvent = EventEnvelope<
  'auction:ended',
  { state: AuctionLiveState; winner: { id: number; name: string } | null; finalPrice: string | null }
>;
export type AuctionCancelledEvent = EventEnvelope<'auction:cancelled', { state: AuctionLiveState; reason: string }>;
export type NotificationNewEvent = EventEnvelope<
  'notification:new',
  { id: number; type: string; title: string; message: string; auctionId: number | null; isRead: boolean; createdAt: string }
>;

export type ServerEvent =
  | BidPlacedEvent
  | PriceUpdatedEvent
  | AuctionStartedEvent
  | AuctionEndingSoonEvent
  | AuctionEndedEvent
  | AuctionCancelledEvent
  | NotificationNewEvent;

export type ServerEventType = ServerEvent['type'];

/** Room naming. Auction rooms carry auction events; user rooms carry private notifications. */
export const Rooms = {
  auction: (id: number) => `auction:${id}`,
  user: (id: number) => `user:${id}`,
  feed: 'feed',
} as const;

export interface ServerToClientEvents {
  'auction:bid_placed': (e: BidPlacedEvent) => void;
  'auction:price_updated': (e: PriceUpdatedEvent) => void;
  'auction:started': (e: AuctionStartedEvent) => void;
  'auction:ending_soon': (e: AuctionEndingSoonEvent) => void;
  'auction:ended': (e: AuctionEndedEvent) => void;
  'auction:cancelled': (e: AuctionCancelledEvent) => void;
  'notification:new': (e: NotificationNewEvent) => void;
  'auction:viewers': (e: { auctionId: number; viewers: number }) => void;
}

export interface JoinAck {
  ok: boolean;
  error?: string;
  viewers?: number;
  version?: number;
}

export interface ClientToServerEvents {
  'auction:join': (auctionId: number, ack: (r: JoinAck) => void) => void;
  'auction:leave': (auctionId: number) => void;
  'feed:join': () => void;
  'feed:leave': () => void;
}
