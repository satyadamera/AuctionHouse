import { describe, expect, it } from 'vitest';
import { assertTransition, canSellerCancel, canTransition, isWithinBiddingWindow, statusOnPublish } from '../../src/modules/auctions/stateMachine.js';
import type { AuctionStatus } from '../../src/database/types.js';

const all: AuctionStatus[] = ['DRAFT', 'SCHEDULED', 'ACTIVE', 'COMPLETED', 'CANCELLED'];

describe('auction state machine', () => {
  it('allows the documented forward path', () => {
    expect(canTransition('DRAFT', 'SCHEDULED')).toBe(true);
    expect(canTransition('SCHEDULED', 'ACTIVE')).toBe(true);
    expect(canTransition('ACTIVE', 'COMPLETED')).toBe(true);
    expect(canTransition('DRAFT', 'ACTIVE')).toBe(true);
  });
  it('treats COMPLETED and CANCELLED as terminal', () => {
    for (const to of all) {
      expect(canTransition('COMPLETED', to)).toBe(false);
      expect(canTransition('CANCELLED', to)).toBe(false);
    }
  });
  it('never goes backwards', () => {
    expect(canTransition('ACTIVE', 'SCHEDULED')).toBe(false);
    expect(canTransition('ACTIVE', 'DRAFT')).toBe(false);
    expect(canTransition('SCHEDULED', 'DRAFT')).toBe(false);
  });
  it('throws a typed error on illegal transitions', () => {
    expect(() => assertTransition('COMPLETED', 'ACTIVE')).toThrowError(/Cannot move/);
  });
});

describe('seller cancellation rule', () => {
  it('allows drafts and scheduled auctions', () => {
    expect(canSellerCancel('DRAFT', 0)).toBe(true);
    expect(canSellerCancel('SCHEDULED', 0)).toBe(true);
  });
  it('allows live auctions only without bids', () => {
    expect(canSellerCancel('ACTIVE', 0)).toBe(true);
    expect(canSellerCancel('ACTIVE', 1)).toBe(false);
  });
  it('never allows terminal auctions', () => {
    expect(canSellerCancel('COMPLETED', 0)).toBe(false);
  });
});

describe('bidding window (start inclusive, end exclusive)', () => {
  const start = new Date('2026-01-01T10:00:00.000Z');
  const end = new Date('2026-01-01T11:00:00.000Z');
  it('rejects 1 ms before start', () => expect(isWithinBiddingWindow(start, end, new Date(start.getTime() - 1))).toBe(false));
  it('accepts exactly at start', () => expect(isWithinBiddingWindow(start, end, start)).toBe(true));
  it('accepts 1 ms before end', () => expect(isWithinBiddingWindow(start, end, new Date(end.getTime() - 1))).toBe(true));
  it('rejects exactly at end', () => expect(isWithinBiddingWindow(start, end, end)).toBe(false));
  it('rejects after end', () => expect(isWithinBiddingWindow(start, end, new Date(end.getTime() + 1))).toBe(false));
});

describe('statusOnPublish', () => {
  const now = new Date('2026-01-01T10:00:00.000Z');
  it('goes ACTIVE when start has passed', () => expect(statusOnPublish(new Date(now.getTime() - 1), now)).toBe('ACTIVE'));
  it('goes ACTIVE when start is exactly now', () => expect(statusOnPublish(now, now)).toBe('ACTIVE'));
  it('goes SCHEDULED when start is in the future', () => expect(statusOnPublish(new Date(now.getTime() + 1), now)).toBe('SCHEDULED'));
});
