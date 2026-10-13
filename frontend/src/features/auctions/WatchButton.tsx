import { Heart } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { api, errorMessage } from '@/services/api';
import { fetchers, qk } from '@/services/queries';
import { cn } from '@/utils/cn';

export function useWatchIds() {
  const { user } = useAuth();
  return useQuery({ queryKey: qk.watchIds, queryFn: fetchers.watchIds, enabled: Boolean(user), staleTime: 60_000 });
}

export function WatchButton({ auctionId, variant = 'icon', className }: { auctionId: number; variant?: 'icon' | 'full'; className?: string }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const ids = useWatchIds();
  const watching = ids.data?.includes(auctionId) ?? false;

  const m = useMutation({
    mutationFn: (next: boolean) => (next ? api.post(`/watchlist/${auctionId}`) : api.del(`/watchlist/${auctionId}`)),
    // Optimistic toggle; rolled back if the request fails.
    onMutate: async (next) => {
      await qc.cancelQueries({ queryKey: qk.watchIds });
      const prev = qc.getQueryData<number[]>(qk.watchIds);
      qc.setQueryData<number[]>(qk.watchIds, (old = []) => (next ? [...old, auctionId] : old.filter((x) => x !== auctionId)));
      return { prev };
    },
    onError: (err, _n, ctx) => {
      qc.setQueryData(qk.watchIds, ctx?.prev);
      toast.error('Watchlist not updated', { description: errorMessage(err) });
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: qk.watchlist }),
  });

  const toggle = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!user) return navigate('/login', { state: { from: `/auctions/${auctionId}` } });
    m.mutate(!watching);
  };

  if (variant === 'full') {
    return (
      <button onClick={toggle} aria-pressed={watching} className={cn('inline-flex h-10 items-center gap-2 rounded-md border border-line-strong bg-paper px-4 text-sm font-medium hover:border-ink-soft', className)}>
        <Heart className={cn('size-4', watching && 'fill-outbid text-outbid')} aria-hidden />
        {watching ? 'Watching' : 'Watch'}
      </button>
    );
  }
  return (
    <button
      onClick={toggle}
      aria-pressed={watching}
      aria-label={watching ? 'Remove from watchlist' : 'Add to watchlist'}
      className={cn('grid size-9 place-items-center rounded-full bg-paper/90 text-ink-soft shadow-sm backdrop-blur hover:text-outbid', className)}
    >
      <Heart className={cn('size-4', watching && 'fill-outbid text-outbid')} />
    </button>
  );
}
