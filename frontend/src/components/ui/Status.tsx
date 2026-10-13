import type { ReactNode } from 'react';
import { AlertTriangle, PackageOpen } from 'lucide-react';
import type { AuctionStatus } from '@/types/api';
import { cn } from '@/utils/cn';

const statusStyle: Record<AuctionStatus, { label: string; className: string }> = {
  ACTIVE: { label: 'Live', className: 'bg-baize-tint text-baize' },
  SCHEDULED: { label: 'Opens soon', className: 'bg-ink/5 text-ink-soft' },
  COMPLETED: { label: 'Sold', className: 'bg-ink text-porcelain' },
  CANCELLED: { label: 'Withdrawn', className: 'bg-outbid-tint text-outbid' },
  DRAFT: { label: 'Draft', className: 'border border-dashed border-line-strong text-muted' },
};

export function StatusBadge({ status, noBids, className }: { status: AuctionStatus; noBids?: boolean; className?: string }) {
  const s = status === 'COMPLETED' && noBids ? { label: 'Unsold', className: 'bg-ink/10 text-ink-soft' } : statusStyle[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium', s.className, className)}>
      {status === 'ACTIVE' && <span className="size-1.5 rounded-full bg-baize motion-safe:animate-pulse" aria-hidden />}
      {s.label}
    </span>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-ink/[0.06]', className)} aria-hidden />;
}

export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line-strong px-6 py-14 text-center">
      <div className="text-muted">{icon ?? <PackageOpen className="size-8" aria-hidden />}</div>
      <h3 className="text-xl">{title}</h3>
      {children && <p className="max-w-md text-sm text-muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title = 'This didn’t load', message, onRetry }: { title?: string; message?: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-lg border border-outbid/30 bg-outbid-tint/40 px-6 py-12 text-center">
      <AlertTriangle className="size-7 text-outbid" aria-hidden />
      <h3 className="text-xl">{title}</h3>
      {message && <p className="max-w-md text-sm text-ink-soft">{message}</p>}
      {onRetry && (
        <button onClick={onRetry} className="text-sm font-medium text-baize underline underline-offset-4">
          Try again
        </button>
      )}
    </div>
  );
}
