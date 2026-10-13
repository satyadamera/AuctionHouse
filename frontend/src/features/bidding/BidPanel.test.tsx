import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/context/AuthContext';
import { BidPanel } from './BidPanel';
import type { AuctionDetail, User } from '@/types/api';

const auction: AuctionDetail = {
  id: 42, title: 'Test watch', status: 'ACTIVE', description: 'd', category: { id: 1, name: 'Watches', slug: 'watches' },
  seller: { id: 2, name: 'Meera K.', avatarUrl: null, memberSince: '2026-01-01T00:00:00Z' }, coverImage: null, images: [],
  startingPrice: '10000.00', currentHighestBid: '10000.00', currentHighestBidder: { id: 9, name: 'Diya S.' }, minimumNextBid: '10500.00',
  minimumBidIncrement: '500.00', bidCount: 1, startTime: new Date(Date.now() - 3600e3).toISOString(), endTime: new Date(Date.now() + 3600e3).toISOString(),
  originalEndTime: new Date(Date.now() + 3600e3).toISOString(), isFeatured: false, version: 2, winner: null, finalPrice: null, cancelReason: null,
  moderationStatus: 'APPROVED', completedAt: null, createdAt: '2026-01-01T00:00:00Z',
};
const me: User = { id: 5, name: 'Aarav Mehta', email: 'a@x.dev', role: 'USER', avatarUrl: null, status: 'ACTIVE', createdAt: '' };

/** fetch stub: the auth bootstrap (refresh) either returns a session or 401. */
function stubFetch(user: User | null, bidResponse?: { status: number; body: unknown }) {
  const calls: { url: string; body?: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body as string | undefined });
    if (url.includes('/auth/refresh')) {
      return user
        ? new Response(JSON.stringify({ success: true, data: { user, accessToken: 't', expiresIn: 900 } }), { status: 200 })
        : new Response(JSON.stringify({ success: false, error: { code: 'INVALID_REFRESH_TOKEN', message: 'x' } }), { status: 401 });
    }
    if (url.includes('/bids') && bidResponse) return new Response(JSON.stringify(bidResponse.body), { status: bidResponse.status });
    return new Response(JSON.stringify({ success: true, data: [] }), { status: 200 });
  }));
  return calls;
}

function renderPanel(a = auction, onBidAccepted = vi.fn()) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AuthProvider>
          <BidPanel auction={a} flash={0} viewers={3} connected endingSoon={false} onBidAccepted={onBidAccepted} onStale={vi.fn()} />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { onBidAccepted };
}

beforeEach(() => {
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '11111111-2222-3333-4444-555555555555' });
  localStorage.setItem('auctra.hasSession', '1'); // behave like a browser that has signed in before
});
afterEach(() => vi.unstubAllGlobals());

describe('BidPanel', () => {
  it('asks anonymous visitors to sign in instead of showing a bid form', async () => {
    stubFetch(null);
    renderPanel();
    expect(await screen.findByRole('link', { name: 'Sign in to bid' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Your bid')).not.toBeInTheDocument();
  });

  it('prefills the server minimum and blocks a lower amount before calling the API', async () => {
    const calls = stubFetch(me);
    renderPanel();
    const input = await screen.findByLabelText('Your bid');
    expect(input).toHaveValue('10500.00');
    await userEvent.clear(input);
    await userEvent.type(input, '10200');
    await userEvent.click(screen.getByRole('button', { name: 'Place bid' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bid at least ₹10,500.00');
    expect(calls.some((c) => c.url.includes('/bids'))).toBe(false);
  });

  it('confirms, submits with an idempotency key, and reports success', async () => {
    const result = { bid: { id: 7, amount: '10500.00', bidder: { id: 5, name: 'Aarav M.' }, createdAt: '' }, state: { ...auction, currentHighestBid: '10500.00' }, version: 3, replayed: false, extended: false };
    const calls = stubFetch(me, { status: 201, body: { success: true, data: result } });
    const { onBidAccepted } = renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Place bid' }));
    await userEvent.click(await screen.findByRole('button', { name: /Bid ₹10,500/ }));
    await waitFor(() => expect(onBidAccepted).toHaveBeenCalledWith(result));
    const sent = JSON.parse(calls.find((c) => c.url.includes('/bids'))!.body!);
    expect(sent).toEqual({ amount: '10500.00', clientRequestId: '11111111-2222-3333-4444-555555555555' });
  });

  it('explains BID_TOO_LOW using the minimum the server returned', async () => {
    stubFetch(me, { status: 409, body: { success: false, error: { code: 'BID_TOO_LOW', message: 'x', details: { minimumNextBid: '11500.00' } } } });
    renderPanel();
    await userEvent.click(await screen.findByRole('button', { name: 'Place bid' }));
    await userEvent.click(await screen.findByRole('button', { name: /Bid ₹10,500/ }));
    expect(await screen.findByText(/Someone bid first\. The minimum is now ₹11,500\.00/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your bid')).toHaveValue('11500.00');
  });

  it('shows the seller that they cannot bid on their own listing', async () => {
    stubFetch({ ...me, id: 2, role: 'SELLER' });
    renderPanel();
    expect(await screen.findByText(/This is your listing/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your bid')).not.toBeInTheDocument();
  });
});
