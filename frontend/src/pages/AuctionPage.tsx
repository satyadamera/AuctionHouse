import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useLiveAuction } from '@/features/bidding/useLiveAuction';
import { BidPanel } from '@/features/bidding/BidPanel';
import { BidHistory } from '@/features/bidding/BidHistory';
import { ActivityFeed } from '@/features/bidding/ActivityFeed';
import { ImageGallery } from '@/features/auctions/ImageGallery';
import { WatchButton } from '@/features/auctions/WatchButton';
import { ErrorState, Skeleton } from '@/components/ui/Status';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Textarea } from '@/components/ui/Field';
import { api, ApiError, errorMessage } from '@/services/api';
import { formatDate, formatDateTime, formatINR, lotNumber } from '@/utils/format';
import type { AuctionDetail } from '@/types/api';

function CancelDialog({ auction, asAdmin, open, onOpenChange }: { auction: AuctionDetail; asAdmin: boolean; open: boolean; onOpenChange: (o: boolean) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(asAdmin ? `/admin/auctions/${auction.id}/cancel` : `/auctions/${auction.id}/cancel`, { reason });
      toast.success('Auction cancelled');
      void qc.invalidateQueries();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Cancel this auction?" description={`Bidders and watchers will be notified. ${auction.bidCount ? `${auction.bidCount} bids will be voided.` : ''}`}>
      <Field label="Reason (shown to bidders)" error={error ?? undefined}>
        {({ id, describedBy }) => <Textarea id={id} aria-describedby={describedBy} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-24" />}
      </Field>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => onOpenChange(false)}>Keep auction</Button>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 5} onClick={submit}>Cancel auction</Button>
      </div>
    </Dialog>
  );
}

export function AuctionPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const { user } = useAuth();
  const navigate = useNavigate();
  const live = useLiveAuction(id);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const qc = useQueryClient();
  const a = live.auction;

  if (!Number.isInteger(id) || id <= 0 || (live.error instanceof ApiError && live.error.status === 404)) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-20">
        <ErrorState title="Lot not found" message="It may have been a draft that isn’t public, or the link is wrong." />
      </div>
    );
  }
  if (live.error) return <div className="mx-auto max-w-3xl px-4 py-20"><ErrorState message={errorMessage(live.error)} onRetry={live.refetch} /></div>;
  if (live.isLoading || !a) {
    return (
      <div className="mx-auto grid max-w-7xl gap-10 px-4 py-10 sm:px-6 lg:grid-cols-[1.2fr_1fr]">
        <Skeleton className="aspect-square" />
        <div className="flex flex-col gap-4"><Skeleton className="h-10 w-3/4" /><Skeleton className="h-80" /></div>
      </div>
    );
  }

  const isOwner = user?.id === a.seller.id;
  const isAdmin = user?.role === 'ADMIN';
  const sellerCanCancel = isOwner && (a.status === 'DRAFT' || a.status === 'SCHEDULED' || (a.status === 'ACTIVE' && a.bidCount === 0));
  const adminCanCancel = isAdmin && (a.status === 'ACTIVE' || a.status === 'SCHEDULED');

  const publish = async () => {
    setPublishing(true);
    try {
      await api.post(`/auctions/${a.id}/publish`);
      toast.success('Published');
      void qc.invalidateQueries();
    } catch (err) {
      toast.error('Not published', { description: errorMessage(err) });
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-6 flex items-center gap-1 text-sm text-muted">
        <ChevronLeft className="size-4" aria-hidden />
        <Link to={`/auctions?category=${a.category.slug}`} className="hover:text-ink hover:underline">{a.category.name}</Link>
      </nav>
      {/* Mobile order: gallery → title & bidding → description. Desktop: two columns, bidding sticky on the right. */}
      <div className="grid gap-10 lg:grid-cols-[1.2fr_1fr] lg:gap-x-14">
        <div className="min-w-0 lg:col-start-1 lg:row-start-1">
          <ImageGallery images={a.images} title={a.title} />
        </div>

        <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
          <div>
            <div className="flex items-center justify-between gap-3 text-sm text-muted">
              <span>{lotNumber(a.id)}</span>
              {(a.status === 'ACTIVE' || a.status === 'SCHEDULED') && <WatchButton auctionId={a.id} variant="full" />}
            </div>
            <h1 className="mt-2 text-3xl sm:text-4xl">{a.title}</h1>
            <p className="mt-2 text-sm text-ink-soft">
              Offered by <span className="font-medium text-ink">{a.seller.name}</span>, selling on Auctra since {formatDate(a.seller.memberSince)}
            </p>
          </div>

          <BidPanel
            auction={a}
            flash={live.flash}
            viewers={live.viewers}
            connected={live.connected}
            endingSoon={live.endingSoon}
            onBidAccepted={live.applyMyBid}
            onStale={live.refetch}
          />

          {(isOwner || isAdmin) && (
            <div className="flex flex-wrap gap-2 rounded-lg border border-dashed border-line-strong p-4">
              <span className="w-full text-sm text-muted">{isOwner ? 'Seller tools' : 'Administrator tools'}</span>
              {isOwner && a.status === 'DRAFT' && <Button onClick={publish} loading={publishing}>Publish</Button>}
              {isOwner && (a.status === 'DRAFT' || a.status === 'SCHEDULED') && <Button variant="secondary" onClick={() => navigate(`/sell/${a.id}/edit`)}>Edit listing</Button>}
              {(sellerCanCancel || adminCanCancel) && <Button variant="secondary" onClick={() => setCancelOpen(true)}>Cancel auction</Button>}
              {isOwner && a.status === 'ACTIVE' && a.bidCount > 0 && <p className="text-xs text-muted">Live auctions with bids can only be cancelled by an administrator.</p>}
            </div>
          )}

          <section aria-labelledby="activity" className="rounded-lg border border-line bg-paper p-5">
            <h2 id="activity" className="text-xl">Live activity</h2>
            <div className="mt-3"><ActivityFeed items={live.activity} connected={live.connected} /></div>
          </section>
        </div>
        <section className="min-w-0 lg:col-start-1 lg:row-start-2" aria-labelledby="about">
          <h2 id="about" className="text-2xl">About this lot</h2>
          <p className="mt-4 max-w-[68ch] whitespace-pre-line font-serif text-lg leading-relaxed text-ink-soft">{a.description}</p>
          <dl className="mt-8 grid max-w-xl grid-cols-2 gap-x-6 gap-y-4 border-t border-line pt-6 text-sm">
            <div><dt className="text-muted">Starting price</dt><dd className="tabular">{formatINR(a.startingPrice, true)}</dd></div>
            <div><dt className="text-muted">Bid increment</dt><dd className="tabular">{formatINR(a.minimumBidIncrement, true)}</dd></div>
            <div><dt className="text-muted">Opened</dt><dd>{formatDateTime(a.startTime)}</dd></div>
            <div><dt className="text-muted">Scheduled close</dt><dd>{formatDateTime(a.originalEndTime)}</dd></div>
          </dl>
        </section>
      </div>

      <section aria-labelledby="history" className="mt-14 max-w-3xl">
        <h2 id="history" className="text-2xl">Bid history</h2>
        <div className="mt-4"><BidHistory bids={live.bids} loading={live.bidsLoading} totalCount={a.bidCount} /></div>
      </section>

      <CancelDialog auction={a} asAdmin={!isOwner && isAdmin} open={cancelOpen} onOpenChange={setCancelOpen} />
    </div>
  );
}
