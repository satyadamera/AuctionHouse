/** Mirror of backend/src/shared/events.ts — keep the two in sync. */
import type { Bid, LiveState, Notification } from './api';

export interface EventEnvelope<TType extends string, TData> {
  eventId: string;
  type: TType;
  auctionId: number | null;
  version: number | null;
  occurredAt: string;
  data: TData;
}

export type BidPlacedEvent = EventEnvelope<'auction:bid_placed', { bid: Bid; state: LiveState; extended: boolean }>;
export type PriceUpdatedEvent = EventEnvelope<'auction:price_updated', { currentHighestBid: string; bidCount: number; endTime: string }>;
export type AuctionStartedEvent = EventEnvelope<'auction:started', { state: LiveState }>;
export type AuctionEndingSoonEvent = EventEnvelope<'auction:ending_soon', { endTime: string; secondsRemaining: number }>;
export type AuctionEndedEvent = EventEnvelope<'auction:ended', { state: LiveState; winner: { id: number; name: string } | null; finalPrice: string | null }>;
export type AuctionCancelledEvent = EventEnvelope<'auction:cancelled', { state: LiveState; reason: string }>;
export type NotificationNewEvent = EventEnvelope<'notification:new', Notification>;

export type AuctionStateEvent = BidPlacedEvent | AuctionStartedEvent | AuctionEndedEvent | AuctionCancelledEvent;

export interface JoinAck {
  ok: boolean;
  error?: string;
  viewers?: number;
  version?: number;
}

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

export interface ClientToServerEvents {
  'auction:join': (auctionId: number, ack: (r: JoinAck) => void) => void;
  'auction:leave': (auctionId: number) => void;
  'feed:join': () => void;
  'feed:leave': () => void;
}
