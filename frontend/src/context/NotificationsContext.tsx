import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { getSocket } from '@/services/socket';
import { fetchers, qk } from '@/services/queries';
import { useAuth } from './AuthContext';
import type { Notification } from '@/types/api';
import type { NotificationNewEvent } from '@/types/events';

interface NotificationsState {
  items: Notification[];
  unreadCount: number;
  loading: boolean;
}

const Ctx = createContext<NotificationsState>({ items: [], unreadCount: 0, loading: false });

/** Types worth interrupting the user for; the rest just update the bell. */
const TOAST_TYPES = new Set(['OUTBID', 'AUCTION_WON', 'AUCTION_LOST', 'AUCTION_SOLD', 'AUCTION_ENDING_SOON', 'AUCTION_CANCELLED', 'LISTING_REJECTED']);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: qk.notifications, queryFn: fetchers.notifications, enabled: Boolean(user), refetchInterval: 60_000 });

  useEffect(() => {
    if (!user) return;
    const socket = getSocket();
    const seen = new Set<string>();
    const onNew = (e: NotificationNewEvent) => {
      if (seen.has(e.eventId)) return; // at-least-once delivery → dedupe
      seen.add(e.eventId);
      // The notification is already persisted in MySQL; refetch the authoritative list.
      void queryClient.invalidateQueries({ queryKey: qk.notifications });
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      if (TOAST_TYPES.has(e.data.type)) {
        const auctionId = e.data.auctionId;
        const opts = {
          description: e.data.message,
          duration: e.data.type === 'OUTBID' ? 8000 : 6000,
          action: auctionId ? { label: e.data.type === 'OUTBID' ? 'Bid again' : 'View', onClick: () => navigate(`/auctions/${auctionId}`) } : undefined,
        };
        if (e.data.type === 'OUTBID' || e.data.type === 'AUCTION_CANCELLED' || e.data.type === 'LISTING_REJECTED') toast.error(e.data.title, opts);
        else if (e.data.type === 'AUCTION_WON' || e.data.type === 'AUCTION_SOLD') toast.success(e.data.title, opts);
        else toast(e.data.title, opts);
      }
    };
    socket.on('notification:new', onNew);
    // After a reconnect, notifications may have been missed: re-read from the API.
    const resync = () => void queryClient.invalidateQueries({ queryKey: qk.notifications });
    socket.on('connect', resync);
    return () => {
      socket.off('notification:new', onNew);
      socket.off('connect', resync);
    };
  }, [user, queryClient, navigate]);

  return (
    <Ctx.Provider value={{ items: q.data?.items ?? [], unreadCount: q.data?.unreadCount ?? 0, loading: q.isLoading }}>{children}</Ctx.Provider>
  );
}

export const useNotifications = () => useContext(Ctx);
