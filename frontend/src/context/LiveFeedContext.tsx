import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getSocket } from '@/services/socket';
import type { PriceUpdatedEvent } from '@/types/events';

/**
 * Lightweight live prices for listing cards across the site. Cards join the shared `feed` room and
 * overlay any newer price on top of the (possibly cached) list data. Versions guarantee an older
 * event can never overwrite a newer price.
 */
export interface FeedEntry {
  currentHighestBid: string;
  bidCount: number;
  endTime: string;
  version: number;
  at: number;
}

const FeedContext = createContext<Map<number, FeedEntry>>(new Map());

export function LiveFeedProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<Map<number, FeedEntry>>(new Map());

  useEffect(() => {
    const socket = getSocket();
    const join = () => socket.emit('feed:join');
    const onPrice = (e: PriceUpdatedEvent) => {
      if (e.auctionId === null || e.version === null) return;
      const id = e.auctionId;
      const version = e.version;
      setEntries((prev) => {
        const old = prev.get(id);
        if (old && old.version >= version) return prev; // stale or duplicate
        const next = new Map(prev);
        next.set(id, { ...e.data, version, at: Date.now() });
        return next;
      });
    };
    if (socket.connected) join();
    socket.on('connect', join);
    socket.on('auction:price_updated', onPrice);
    return () => {
      socket.off('connect', join);
      socket.off('auction:price_updated', onPrice);
      socket.emit('feed:leave');
    };
  }, []);

  return <FeedContext.Provider value={entries}>{children}</FeedContext.Provider>;
}

export function useFeedEntry(auctionId: number, cardVersion: number): FeedEntry | undefined {
  const e = useContext(FeedContext).get(auctionId);
  return e && e.version > cardVersion ? e : undefined;
}
