import { useAuth } from '@/context/AuthContext';
import { Skeleton } from '@/components/ui/Status';
import type { Bid } from '@/types/api';
import { formatDateTime, formatINR, timeAgo } from '@/utils/format';
import { cn } from '@/utils/cn';

export function BidHistory({ bids, loading, totalCount }: { bids: Bid[]; loading: boolean; totalCount: number }) {
  const { user } = useAuth();
  if (loading) return <Skeleton className="h-40" />;
  if (!bids.length) return <p className="py-6 text-sm text-muted">No bids yet. The first bid can match the starting price.</p>;
  return (
    <div>
      <ol className="divide-y divide-line">
        {bids.map((b, i) => {
          const mine = user?.id === b.bidder.id;
          return (
            <li key={b.id} className={cn('flex items-center justify-between gap-4 py-3', i === 0 && 'font-medium')}>
              <div className="flex items-center gap-3">
                <span className={cn('grid size-8 place-items-center rounded-full text-xs', mine ? 'bg-baize text-porcelain' : 'bg-ink/5 text-ink-soft')} aria-hidden>
                  {b.bidder.name[0]}
                </span>
                <div>
                  <div className="text-sm">
                    {mine ? 'You' : b.bidder.name}
                    {i === 0 && <span className="ml-2 rounded-sm bg-baize-tint px-1.5 py-0.5 text-xs font-medium text-baize">Highest</span>}
                  </div>
                  <time className="text-xs font-normal text-muted" dateTime={b.createdAt} title={formatDateTime(b.createdAt)}>
                    {timeAgo(b.createdAt)}
                  </time>
                </div>
              </div>
              <span className="tabular text-base">{formatINR(b.amount, true)}</span>
            </li>
          );
        })}
      </ol>
      {totalCount > bids.length && <p className="pt-3 text-xs text-muted">Showing the latest {bids.length} of {totalCount} bids.</p>}
    </div>
  );
}
