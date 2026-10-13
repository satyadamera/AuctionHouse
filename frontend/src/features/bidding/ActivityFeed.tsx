import type { ActivityItem } from './useLiveAuction';
import { formatINR } from '@/utils/format';
import { cn } from '@/utils/cn';

/** Session-local log of what arrived over the socket while this page has been open. */
export function ActivityFeed({ items, connected }: { items: ActivityItem[]; connected: boolean }) {
  return (
    <div aria-live="polite" aria-relevant="additions">
      {items.length === 0 ? (
        <p className="py-4 text-sm text-muted">{connected ? 'Connected. New bids will appear here the moment they’re accepted.' : 'Connecting to the live room…'}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((it) => (
            <li key={it.id} className="flex items-baseline justify-between gap-3 text-sm">
              <span className={cn(it.kind === 'ended' && 'font-medium', it.kind === 'cancelled' && 'text-outbid', it.kind === 'resync' && 'text-muted')}>
                {it.text}
                {it.amount && <span className="tabular font-medium"> {formatINR(it.amount, true)}</span>}
              </span>
              <time className="tabular shrink-0 text-xs text-muted" dateTime={it.at}>
                {new Date(it.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
