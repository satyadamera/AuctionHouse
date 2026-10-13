/** Query keys and fetchers, kept in one place so invalidation is consistent across the app. */
import { api } from './api';
import type { AuctionDetail, AuctionSummary, Bid, Category, Listing, MyBid, Notification, PageMeta } from '@/types/api';

export const qk = {
  auction: (id: number) => ['auction', id] as const,
  bids: (id: number) => ['auction', id, 'bids'] as const,
  browse: (params: Record<string, unknown>) => ['auctions', 'browse', params] as const,
  featured: ['auctions', 'featured'] as const,
  categories: ['categories'] as const,
  stats: ['stats'] as const,
  myBids: ['me', 'bids'] as const,
  won: ['me', 'won'] as const,
  listings: ['me', 'listings'] as const,
  sellerStats: ['me', 'seller-stats'] as const,
  watchlist: ['watchlist'] as const,
  watchIds: ['watchlist', 'ids'] as const,
  notifications: ['notifications'] as const,
};

export interface BrowseParams {
  q?: string;
  category?: string;
  status?: 'ACTIVE' | 'SCHEDULED' | 'COMPLETED' | 'ALL';
  minPrice?: number;
  maxPrice?: number;
  sort?: 'ending_soon' | 'newest' | 'price_asc' | 'price_desc' | 'most_bids';
  page?: number;
  pageSize?: number;
  featured?: boolean;
}

export const fetchers = {
  browse: async (p: BrowseParams) => {
    const r = await api.get<AuctionSummary[]>('/auctions', { ...p, featured: p.featured ? 'true' : undefined });
    return { items: r.data, meta: r.meta as PageMeta };
  },
  featured: async () => (await api.get<AuctionSummary[]>('/auctions/featured')).data,
  auction: async (id: number) => {
    const t0 = Date.now();
    const r = await api.get<AuctionDetail>(`/auctions/${id}`);
    return { auction: r.data, serverTime: r.meta?.serverTime as string | undefined, requestStartedAt: t0, receivedAt: Date.now() };
  },
  bids: async (id: number) => (await api.get<Bid[]>(`/auctions/${id}/bids`, { limit: 50 })).data,
  categories: async () => (await api.get<Category[]>('/categories')).data,
  stats: async () =>
    (await api.get<{ liveAuctions: number; bidsLast24h: number; completedAuctions: number; members: number }>('/stats/public')).data,
  myBids: async () => (await api.get<MyBid[]>('/users/me/bids')).data,
  won: async () => (await api.get<{ auction: AuctionSummary; finalPrice: string; completedAt: string }[]>('/users/me/won-auctions')).data,
  listings: async () => (await api.get<Listing[]>('/users/me/listings')).data,
  watchlist: async () => (await api.get<AuctionSummary[]>('/watchlist')).data,
  watchIds: async () => (await api.get<number[]>('/watchlist/ids')).data,
  notifications: async () => {
    const r = await api.get<Notification[]>('/notifications', { pageSize: 30 });
    return { items: r.data, unreadCount: Number(r.meta?.unreadCount ?? 0) };
  },
};
