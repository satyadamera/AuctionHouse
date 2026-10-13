import { describe, expect, it } from 'vitest';
import { addBid, applyAuctionEvent } from './applyEvent';
import type { AuctionDetail, LiveState } from '@/types/api';
import type { AuctionEndedEvent, BidPlacedEvent } from '@/types/events';

const base = { id: 1, version: 5, status: 'ACTIVE', currentHighestBid: '1000.00', bidCount: 3 } as AuctionDetail;
const state = (amount: string, count: number): LiveState => ({
  status: 'ACTIVE', currentHighestBid: amount, currentHighestBidder: { id: 9, name: 'Diya S.' }, minimumNextBid: '1100.00', bidCount: count, endTime: '2026-01-01T00:00:00.000Z',
});
const bidEvent = (version: number, amount = '1100.00'): BidPlacedEvent => ({
  eventId: `e-${version}`, type: 'auction:bid_placed', auctionId: 1, version, occurredAt: '2026-01-01T00:00:00.000Z',
  data: { bid: { id: version, amount, bidder: { id: 9, name: 'Diya S.' }, createdAt: '' }, state: state(amount, 4), extended: false },
});

describe('applyAuctionEvent (version ordering)', () => {
  it('applies the next version', () => {
    const r = applyAuctionEvent(base, bidEvent(6));
    expect(r.kind).toBe('applied');
    if (r.kind === 'applied') expect(r.next).toMatchObject({ version: 6, currentHighestBid: '1100.00', bidCount: 4 });
  });
  it('ignores duplicates and stale events (they can never roll the price back)', () => {
    expect(applyAuctionEvent(base, bidEvent(5, '900.00')).kind).toBe('stale');
    expect(applyAuctionEvent(base, bidEvent(4, '800.00')).kind).toBe('stale');
  });
  it('detects a gap so the client re-fetches instead of guessing', () => {
    expect(applyAuctionEvent(base, bidEvent(8)).kind).toBe('gap');
  });
  it('records the winner when the auction ends', () => {
    const ended: AuctionEndedEvent = {
      eventId: 'x', type: 'auction:ended', auctionId: 1, version: 6, occurredAt: '2026-01-02T00:00:00.000Z',
      data: { state: { ...state('1000.00', 3), status: 'COMPLETED' }, winner: { id: 9, name: 'Diya S.' }, finalPrice: '1000.00' },
    };
    const r = applyAuctionEvent(base, ended);
    expect(r.kind === 'applied' && r.next).toMatchObject({ status: 'COMPLETED', winner: { id: 9 }, finalPrice: '1000.00' });
  });
});

describe('addBid', () => {
  it('keeps history newest-first and free of duplicates', () => {
    const b = (id: number) => ({ id, amount: '1', bidder: { id: 1, name: 'x' }, createdAt: '' });
    let h = addBid(undefined, b(1));
    h = addBid(h, b(3));
    h = addBid(h, b(2));
    h = addBid(h, b(3));
    expect(h.map((x) => x.id)).toEqual([3, 2, 1]);
  });
});
