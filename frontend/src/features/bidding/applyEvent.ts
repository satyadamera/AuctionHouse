/**
 * Pure reducer for live auction events. Kept free of React so it can be unit-tested directly.
 *
 * Socket.IO events can arrive late, twice, or out of order (at-least-once outbox delivery; several
 * producers). Each state event carries the auction version AFTER the change:
 *   version ≤ current        → stale or duplicate: ignore
 *   version = current + 1    → the next change: apply
 *   version > current + 1    → we missed something: re-fetch authoritative state over REST
 */
import type { AuctionDetail, Bid, LiveState } from '@/types/api';
import type { AuctionStateEvent } from '@/types/events';

export type ApplyResult = { kind: 'applied'; next: AuctionDetail } | { kind: 'stale' } | { kind: 'gap' };

export function mergeLiveState(current: AuctionDetail, state: LiveState, version: number): AuctionDetail {
  return {
    ...current,
    status: state.status,
    currentHighestBid: state.currentHighestBid,
    currentHighestBidder: state.currentHighestBidder,
    minimumNextBid: state.minimumNextBid,
    bidCount: state.bidCount,
    endTime: state.endTime,
    version,
  };
}

export function applyAuctionEvent(current: AuctionDetail, e: AuctionStateEvent): ApplyResult {
  if (e.version === null) return { kind: 'stale' };
  if (e.version <= current.version) return { kind: 'stale' };
  if (e.version > current.version + 1) return { kind: 'gap' };
  let next = mergeLiveState(current, e.data.state, e.version);
  if (e.type === 'auction:ended') next = { ...next, winner: e.data.winner, finalPrice: e.data.finalPrice, completedAt: e.occurredAt };
  if (e.type === 'auction:cancelled') next = { ...next, cancelReason: e.data.reason };
  return { kind: 'applied', next };
}

/** Inserts a bid into newest-first history without duplicates. */
export function addBid(history: Bid[] | undefined, bid: Bid): Bid[] {
  const list = history ?? [];
  if (list.some((b) => b.id === bid.id)) return list;
  return [bid, ...list].sort((a, b) => b.id - a.id);
}
