import type { AuctionStatus } from '../../database/types.js';
import { AppError } from '../../utils/errors.js';

/**
 * Auction lifecycle state machine.
 *
 *   DRAFT ──publish──▶ SCHEDULED ──start time reached──▶ ACTIVE ──end time reached──▶ COMPLETED
 *     │      (start in future)         │                      │
 *     │                                │                      │
 *     └──publish (start ≤ now)─────────┼──────────────────────┘
 *     │                                │                      │
 *     └──────────cancel────────────────┴──────cancel──────────┴──▶ CANCELLED
 *
 * COMPLETED and CANCELLED are terminal. Transitions are only ever applied while holding the
 * auction row lock, after re-reading the current status, so concurrent actors cannot both win.
 */
export const TRANSITIONS: Record<AuctionStatus, readonly AuctionStatus[]> = {
  DRAFT: ['SCHEDULED', 'ACTIVE', 'CANCELLED'],
  SCHEDULED: ['ACTIVE', 'COMPLETED', 'CANCELLED'], // SCHEDULED→COMPLETED only if both start and end passed while the worker was down
  ACTIVE: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransition(from: AuctionStatus, to: AuctionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AuctionStatus, to: AuctionStatus): void {
  if (!canTransition(from, to)) {
    throw new AppError('INVALID_STATE_TRANSITION', `Cannot move an auction from ${from} to ${to}`);
  }
}

export const isTerminal = (s: AuctionStatus) => s === 'COMPLETED' || s === 'CANCELLED';
export const PUBLIC_STATUSES: readonly AuctionStatus[] = ['SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'];

/**
 * Cancellation rules (documented in docs/SECURITY.md role matrix):
 * - Admin: any non-terminal auction, with a reason.
 * - Seller (own auction): DRAFT or SCHEDULED at any time; ACTIVE only while it has zero bids —
 *   cancelling under active bidders would let a seller back out of a price they dislike.
 */
export function canSellerCancel(status: AuctionStatus, bidCount: number): boolean {
  if (status === 'DRAFT' || status === 'SCHEDULED') return true;
  return status === 'ACTIVE' && bidCount === 0;
}

/** Status a just-published auction should enter, decided with the database clock. */
export function statusOnPublish(startTime: Date, dbNow: Date): 'SCHEDULED' | 'ACTIVE' {
  return startTime.getTime() <= dbNow.getTime() ? 'ACTIVE' : 'SCHEDULED';
}

/**
 * Is a bid inside the bidding window? Start is inclusive, end is EXCLUSIVE: a bid stamped exactly
 * at end_time is too late. Both instants come from the database clock.
 */
export function isWithinBiddingWindow(startTime: Date, endTime: Date, now: Date): boolean {
  return now.getTime() >= startTime.getTime() && now.getTime() < endTime.getTime();
}
