import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchers, qk } from '@/services/queries';
import { getSocket } from '@/services/socket';
import { recordServerTime } from '@/hooks/useNow';
import type { AuctionDetail, Bid, PlaceBidResult } from '@/types/api';
import type { AuctionEndingSoonEvent, AuctionStateEvent, BidPlacedEvent, JoinAck } from '@/types/events';
import { addBid, applyAuctionEvent, mergeLiveState } from './applyEvent';

type AuctionQueryData = Awaited<ReturnType<typeof fetchers.auction>>;

export interface ActivityItem {
  id: string;
  kind: 'bid' | 'started' | 'ended' | 'cancelled' | 'ending_soon' | 'resync';
  text: string;
  at: string;
  amount?: string;
}

/**
 * Everything the auction page needs to stay live:
 * - REST queries for the authoritative detail and bid history,
 * - a Socket.IO room subscription that applies events in version order,
 * - re-sync on (re)connect, because events may have been missed while disconnected,
 * - listener cleanup on unmount / auction change, so no duplicate handlers accumulate.
 */
export function useLiveAuction(auctionId: number) {
  const queryClient = useQueryClient();
  const [viewers, setViewers] = useState<number | null>(null);
  const [connected, setConnected] = useState(() => getSocket().connected);
  const [flash, setFlash] = useState(0);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [endingSoon, setEndingSoon] = useState(false);
  const seen = useRef(new Set<string>());
  const [forAuction, setForAuction] = useState(auctionId);
  if (forAuction !== auctionId) {
    // Navigated to a different lot: drop the previous lot's session state.
    setForAuction(auctionId);
    setActivity([]);
    setEndingSoon(false);
    setViewers(null);
  }

  const detail = useQuery({
    queryKey: qk.auction(auctionId),
    queryFn: async () => {
      const r = await fetchers.auction(auctionId);
      recordServerTime(r.serverTime, r.requestStartedAt, r.receivedAt);
      return r;
    },
    staleTime: 15_000,
  });
  const bids = useQuery({ queryKey: qk.bids(auctionId), queryFn: () => fetchers.bids(auctionId) });

  const resync = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: qk.auction(auctionId) });
  }, [queryClient, auctionId]);

  const log = useCallback((item: Omit<ActivityItem, 'id'> & { id?: string }) => {
    setActivity((prev) => [{ id: item.id ?? crypto.randomUUID(), ...item }, ...prev].slice(0, 30));
  }, []);

  /** Applies a state event to the query cache. Returns false when the event was stale. */
  const applyState = useCallback(
    (e: AuctionStateEvent) => {
      // Assigned inside the updater callback, which TypeScript cannot see — hence the widening cast.
      let outcome = 'stale' as 'applied' | 'stale' | 'gap';
      queryClient.setQueryData<AuctionQueryData>(qk.auction(auctionId), (old) => {
        if (!old) return old;
        const r = applyAuctionEvent(old.auction, e);
        outcome = r.kind;
        return r.kind === 'applied' ? { ...old, auction: r.next } : old;
      });
      if (outcome === 'gap') {
        log({ kind: 'resync', text: 'Missed an update — refreshing from the server', at: new Date().toISOString() });
        resync();
      }
      return outcome === 'applied';
    },
    [queryClient, auctionId, resync, log],
  );

  useEffect(() => {
    const socket = getSocket();
    seen.current = new Set();

    const join = () =>
      socket.emit('auction:join', auctionId, (ack: JoinAck) => {
        if (!ack.ok) return;
        setViewers(ack.viewers ?? null);
        // If the server is ahead of what we render, we missed events while offline → re-fetch.
        const current = queryClient.getQueryData<AuctionQueryData>(qk.auction(auctionId))?.auction.version;
        if (current !== undefined && ack.version !== undefined && ack.version > current) {
          resync();
          void queryClient.invalidateQueries({ queryKey: qk.bids(auctionId) });
        }
      });
    const onConnect = () => {
      setConnected(true);
      join();
    };
    const onDisconnect = () => setConnected(false);
    const dedupe = (eventId: string) => {
      if (seen.current.has(eventId)) return true;
      seen.current.add(eventId);
      return false;
    };
    const mine = (e: { auctionId: number | null }) => e.auctionId === auctionId;

    const onBid = (e: BidPlacedEvent) => {
      if (!mine(e) || dedupe(e.eventId)) return;
      // History is append-only and keyed by bid id, so it is safe to add even if the state is stale.
      queryClient.setQueryData<Bid[]>(qk.bids(auctionId), (old) => addBid(old, e.data.bid));
      if (applyState(e)) setFlash((n) => n + 1);
      log({ id: e.eventId, kind: 'bid', amount: e.data.bid.amount, text: `${e.data.bid.bidder.name} bid`, at: e.occurredAt });
      if (e.data.extended) log({ kind: 'ending_soon', text: 'Late bid — end time extended', at: e.occurredAt });
    };
    const onStarted = (e: AuctionStateEvent) => {
      if (!mine(e) || dedupe(e.eventId)) return;
      applyState(e);
      log({ id: e.eventId, kind: 'started', text: 'Bidding opened', at: e.occurredAt });
    };
    const onEnded = (e: AuctionStateEvent) => {
      if (!mine(e) || dedupe(e.eventId)) return;
      applyState(e);
      const winner = e.type === 'auction:ended' ? e.data.winner : null;
      log({ id: e.eventId, kind: 'ended', text: winner ? `Sold to ${winner.name}` : 'Closed without bids', at: e.occurredAt });
    };
    const onCancelled = (e: AuctionStateEvent) => {
      if (!mine(e) || dedupe(e.eventId)) return;
      applyState(e);
      log({ id: e.eventId, kind: 'cancelled', text: 'Auction cancelled', at: e.occurredAt });
    };
    const onEndingSoon = (e: AuctionEndingSoonEvent) => {
      if (!mine(e) || dedupe(e.eventId)) return;
      setEndingSoon(true);
      log({ id: e.eventId, kind: 'ending_soon', text: 'Ending soon', at: e.occurredAt });
    };
    const onViewers = (e: { auctionId: number; viewers: number }) => e.auctionId === auctionId && setViewers(e.viewers);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('auction:bid_placed', onBid);
    socket.on('auction:started', onStarted);
    socket.on('auction:ended', onEnded);
    socket.on('auction:cancelled', onCancelled);
    socket.on('auction:ending_soon', onEndingSoon);
    socket.on('auction:viewers', onViewers);
    if (socket.connected) join();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('auction:bid_placed', onBid);
      socket.off('auction:started', onStarted);
      socket.off('auction:ended', onEnded);
      socket.off('auction:cancelled', onCancelled);
      socket.off('auction:ending_soon', onEndingSoon);
      socket.off('auction:viewers', onViewers);
      socket.emit('auction:leave', auctionId);
    };
  }, [auctionId, queryClient, applyState, resync, log]);

  /** Applies my own accepted bid immediately from the REST response (the socket echo is then stale). */
  const applyMyBid = useCallback(
    (r: PlaceBidResult) => {
      queryClient.setQueryData<Bid[]>(qk.bids(auctionId), (old) => addBid(old, r.bid));
      queryClient.setQueryData<AuctionQueryData>(qk.auction(auctionId), (old) => {
        if (!old || r.version <= old.auction.version) return old;
        return { ...old, auction: mergeLiveState(old.auction, r.state, r.version) };
      });
      setFlash((n) => n + 1);
    },
    [queryClient, auctionId],
  );

  return {
    auction: detail.data?.auction as AuctionDetail | undefined,
    isLoading: detail.isLoading,
    error: detail.error,
    bids: bids.data ?? [],
    bidsLoading: bids.isLoading,
    viewers,
    connected,
    flash,
    activity,
    endingSoon,
    applyMyBid,
    refetch: resync,
  };
}
