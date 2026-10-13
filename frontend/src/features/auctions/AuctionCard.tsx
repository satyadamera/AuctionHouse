import { Link } from 'react-router-dom';
import type { AuctionSummary } from '@/types/api';
import { useFeedEntry } from '@/context/LiveFeedContext';
import { formatINR, lotNumber } from '@/utils/format';
import { cn } from '@/utils/cn';
import { Countdown } from './Countdown';
import { StatusBadge } from '@/components/ui/Status';
import { WatchButton } from './WatchButton';

/** Listing card. Live prices from the feed room overlay cached list data when newer. */
export function AuctionCard({ auction, className, size = 'md' }: { auction: AuctionSummary; className?: string; size?: 'md' | 'lg' }) {
  const live = useFeedEntry(auction.id, auction.version);
  const highest = live?.currentHighestBid ?? auction.currentHighestBid;
  const bidCount = live?.bidCount ?? auction.bidCount;
  const endTime = live?.endTime ?? auction.endTime;
  const label = auction.status === 'COMPLETED' ? (highest ? 'Sold for' : 'Unsold') : highest ? 'Current bid' : 'Starting at';

  return (
    <Link to={`/auctions/${auction.id}`} className={cn('group flex flex-col', className)}>
      <div className="relative aspect-square overflow-hidden rounded-md bg-line/50">
        {auction.coverImage && (
          <img src={auction.coverImage} alt="" loading="lazy" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]" />
        )}
        <div className="absolute left-3 top-3">{auction.status !== 'ACTIVE' && <StatusBadge status={auction.status} noBids={bidCount === 0} />}</div>
        {(auction.status === 'ACTIVE' || auction.status === 'SCHEDULED') && <WatchButton auctionId={auction.id} className="absolute right-3 top-3" />}
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3 text-xs text-muted">
        <span>{lotNumber(auction.id)}</span>
        <span>{auction.category.name}</span>
      </div>
      <h3 className={cn('mt-1 line-clamp-2 text-ink group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4', size === 'lg' ? 'text-2xl' : 'text-lg')}>
        {auction.title}
      </h3>
      <div className="mt-3 flex items-end justify-between gap-3 border-t border-line pt-3">
        <div>
          <div className="text-xs text-muted">{label}</div>
          <div key={live?.version} className={cn('tabular rounded font-medium', size === 'lg' ? 'text-xl' : 'text-base', live && 'animate-flash')}>
            {auction.status === 'COMPLETED' && !highest ? '—' : formatINR(highest ?? auction.startingPrice)}
          </div>
        </div>
        <div className="text-right text-sm">
          <div className="text-xs text-muted">{bidCount === 1 ? '1 bid' : `${bidCount} bids`}</div>
          <Countdown status={auction.status} startTime={auction.startTime} endTime={endTime} compact />
        </div>
      </div>
    </Link>
  );
}

export function AuctionCardSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      <div className="aspect-square animate-pulse rounded-md bg-ink/[0.06]" />
      <div className="h-3 w-1/3 animate-pulse rounded bg-ink/[0.06]" />
      <div className="h-5 w-4/5 animate-pulse rounded bg-ink/[0.06]" />
      <div className="h-10 animate-pulse rounded bg-ink/[0.06]" />
    </div>
  );
}

export function AuctionGrid({ items, loading, columns = 4 }: { items?: AuctionSummary[]; loading?: boolean; columns?: 3 | 4 }) {
  const cols = columns === 3 ? 'sm:grid-cols-2 lg:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-4';
  return (
    <div className={cn('grid grid-cols-1 gap-x-6 gap-y-10', cols)}>
      {loading ? Array.from({ length: columns * 2 }, (_, i) => <AuctionCardSkeleton key={i} />) : items?.map((a) => <AuctionCard key={a.id} auction={a} />)}
    </div>
  );
}
