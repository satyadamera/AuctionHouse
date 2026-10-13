import { useNow } from '@/hooks/useNow';
import { formatRemaining } from '@/utils/format';
import type { AuctionStatus } from '@/types/api';
import { cn } from '@/utils/cn';

/**
 * Display-only countdown on the server-corrected clock. Reaching zero does NOT close the auction —
 * the server's lifecycle worker does that and announces it with `auction:ended`.
 */
export function Countdown({ status, startTime, endTime, className, compact }: { status: AuctionStatus; startTime: string; endTime: string; className?: string; compact?: boolean }) {
  const now = useNow();
  if (status === 'COMPLETED') return <span className={cn('text-muted', className)}>Ended</span>;
  if (status === 'CANCELLED') return <span className={cn('text-muted', className)}>Withdrawn</span>;
  if (status === 'DRAFT') return <span className={cn('text-muted', className)}>Not published</span>;
  const start = new Date(startTime).getTime();
  const end = new Date(endTime).getTime();
  if (now < start) {
    return (
      <span className={cn('tabular text-ink-soft', className)}>
        {compact ? 'Opens in ' : 'Bidding opens in '}
        {formatRemaining(start - now)}
      </span>
    );
  }
  const left = end - now;
  if (left <= 0) return <span className={cn('text-ink-soft', className)}>Closing…</span>;
  const urgent = left < 5 * 60_000;
  return (
    <span className={cn('tabular', urgent ? 'font-semibold text-outbid' : 'text-ink-soft', className)} aria-live={urgent ? 'polite' : undefined}>
      {formatRemaining(left)}
      {!compact && ' left'}
    </span>
  );
}
