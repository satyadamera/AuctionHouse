import { useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Crown, Eye, Radio, TrendingDown, WifiOff } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { api, ApiError, errorMessage } from '@/services/api';
import type { AuctionDetail, PlaceBidResult } from '@/types/api';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { StatusBadge } from '@/components/ui/Status';
import { Countdown } from '@/features/auctions/Countdown';
import { PriceRoll } from '@/features/auctions/PriceRoll';
import { formatDateTime, formatINR } from '@/utils/format';
import { addIncrements, gte, isValidAmount } from '@/utils/money';
import { cn } from '@/utils/cn';

interface Props {
  auction: AuctionDetail;
  flash: number;
  viewers: number | null;
  connected: boolean;
  endingSoon: boolean;
  onBidAccepted: (r: PlaceBidResult) => void;
  onStale: () => void;
}

const BID_ERRORS: Record<string, string> = {
  AUCTION_ENDED: 'Bidding has closed on this lot.',
  AUCTION_NOT_STARTED: 'Bidding has not opened yet.',
  AUCTION_NOT_ACTIVE: 'This lot is not accepting bids.',
  SELF_BIDDING_NOT_ALLOWED: 'You cannot bid on your own listing.',
  RATE_LIMITED: 'You are bidding very fast — wait a few seconds and try again.',
  CONFLICT_RETRY_EXHAUSTED: 'This lot is very busy right now. Try again in a moment.',
};

export function BidPanel({ auction, flash, viewers, connected, endingSoon, onBidAccepted, onStale }: Props) {
  const { user } = useAuth();
  const location = useLocation();
  const [amount, setAmount] = useState(auction.minimumNextBid);
  const [edited, setEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One idempotency key per bid attempt. A retry after a network error reuses it, so a request
  // that actually reached the server cannot create a second bid.
  const requestKey = useRef<string>(crypto.randomUUID());

  const isLeader = Boolean(user && auction.currentHighestBidder?.id === user.id);
  // "Outbid" = I was leading and now I'm not. Derived from the previous render's value
  // (React's recommended pattern for adjusting state when props change, without an effect).
  const [prevLeader, setPrevLeader] = useState(isLeader);
  const [outbid, setOutbid] = useState(false);
  if (prevLeader !== isLeader) {
    setPrevLeader(isLeader);
    setOutbid(prevLeader && !isLeader);
  }

  // Keep the suggested amount at or above the live minimum unless the user typed something higher.
  const [prevMin, setPrevMin] = useState(auction.minimumNextBid);
  if (prevMin !== auction.minimumNextBid) {
    setPrevMin(auction.minimumNextBid);
    if (!edited || !isValidAmount(amount) || !gte(amount, auction.minimumNextBid)) {
      setAmount(auction.minimumNextBid);
      setEdited(false);
    }
  }

  const quickAdds = useMemo(() => [1, 2, 5].map((n) => addIncrements(auction.currentHighestBid ?? auction.startingPrice, auction.minimumBidIncrement, auction.currentHighestBid ? n : n - 1)), [auction]);

  const isOwner = user?.id === auction.seller.id;
  const canBid = auction.status === 'ACTIVE' && user && !isOwner && user.role !== 'ADMIN';

  const validate = (): string | null => {
    if (!isValidAmount(amount)) return 'Enter an amount in rupees, with up to 2 decimal places.';
    if (!gte(amount, auction.minimumNextBid)) return `Bid at least ${formatINR(auction.minimumNextBid, true)}.`;
    return null;
  };

  const openConfirm = (e: FormEvent) => {
    e.preventDefault();
    const v = validate();
    setError(v);
    if (v) return;
    requestKey.current = crypto.randomUUID();
    setConfirming(true);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const { data } = await api.post<PlaceBidResult>(`/auctions/${auction.id}/bids`, { amount: amount.trim(), clientRequestId: requestKey.current });
      onBidAccepted(data);
      setConfirming(false);
      setEdited(false);
      setOutbid(false);
      toast.success(data.replayed ? 'Bid already placed' : 'Bid placed', { description: `You are leading at ${formatINR(data.bid.amount, true)}.` });
      requestKey.current = crypto.randomUUID();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'BID_TOO_LOW') {
          const d = err.details as { minimumNextBid?: string } | undefined;
          setError(`Someone bid first. The minimum is now ${formatINR(d?.minimumNextBid ?? auction.minimumNextBid, true)}.`);
          if (d?.minimumNextBid) setAmount(d.minimumNextBid);
          setEdited(false);
          setConfirming(false);
          onStale();
        } else if (err.code === 'NETWORK_ERROR') {
          setError('Connection lost before we heard back. Retrying is safe — it will not place a second bid.');
        } else {
          setError(BID_ERRORS[err.code] ?? err.message);
          setConfirming(false);
          onStale();
        }
      } else setError(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };

  const ended = auction.status === 'COMPLETED';
  const iWon = ended && user && auction.winner?.id === user.id;

  return (
    <section aria-labelledby="bid-panel-title" className="rounded-lg border border-line bg-paper">
      <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 text-sm">
        <StatusBadge status={auction.status} noBids={auction.bidCount === 0} />
        <div className="flex items-center gap-4 text-muted">
          {viewers !== null && viewers > 0 && (
            <span className="inline-flex items-center gap-1.5" title="People viewing this lot now">
              <Eye className="size-4" aria-hidden />
              <span className="tabular">{viewers}</span>
              <span className="sr-only">watching now</span>
            </span>
          )}
          <span className={cn('inline-flex items-center gap-1.5', connected ? 'text-baize' : 'text-outbid')}>
            {connected ? <Radio className="size-4" aria-hidden /> : <WifiOff className="size-4" aria-hidden />}
            {connected ? 'Live' : 'Reconnecting'}
          </span>
        </div>
      </div>

      <div className="px-5 pb-5 pt-5">
        <h2 id="bid-panel-title" className="sr-only">Bidding</h2>
        <div className="text-sm text-muted">{ended ? (auction.finalPrice ? 'Hammer price' : 'Result') : auction.currentHighestBid ? 'Current bid' : 'Starting bid'}</div>
        <div key={flash} className={cn('-mx-2 mt-1 rounded-md px-2 py-1', flash > 0 && 'animate-flash')}>
          {ended && !auction.finalPrice ? (
            <span className="font-serif text-4xl">No sale</span>
          ) : (
            <PriceRoll amount={ended ? auction.finalPrice : (auction.currentHighestBid ?? auction.startingPrice)} className="font-serif text-5xl font-medium" />
          )}
        </div>

        <div className="mt-3 min-h-6 text-sm" aria-live="polite">
          {iWon && (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-brass-tint px-2 py-1 font-medium text-[#7a5c1c]">
              <Crown className="size-4" aria-hidden /> You won this lot
            </span>
          )}
          {ended && !iWon && auction.winner && <span className="text-ink-soft">Sold to {auction.winner.name}</span>}
          {!ended && isLeader && (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-brass-tint px-2 py-1 font-medium text-[#7a5c1c]">
              <Crown className="size-4" aria-hidden /> You’re the highest bidder
            </span>
          )}
          {!ended && !isLeader && outbid && (
            <span className="inline-flex items-center gap-1.5 rounded-sm bg-outbid-tint px-2 py-1 font-medium text-outbid">
              <TrendingDown className="size-4" aria-hidden /> You’ve been outbid
            </span>
          )}
          {!ended && !isLeader && !outbid && auction.currentHighestBidder && <span className="text-ink-soft">Leading: {auction.currentHighestBidder.name}</span>}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-line pt-5 text-sm">
          <div>
            <dt className="text-muted">{auction.status === 'SCHEDULED' ? 'Opens' : ended ? 'Closed' : 'Time left'}</dt>
            <dd className={cn('mt-0.5 text-base', endingSoon && !ended && 'font-medium')}>
              {auction.status === 'SCHEDULED' ? formatDateTime(auction.startTime) : ended ? formatDateTime(auction.completedAt ?? auction.endTime) : <Countdown status={auction.status} startTime={auction.startTime} endTime={auction.endTime} compact />}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Bids</dt>
            <dd className="tabular mt-0.5 text-base">{auction.bidCount}</dd>
          </div>
          {!ended && auction.status !== 'CANCELLED' && (
            <>
              <div>
                <dt className="text-muted">Next minimum</dt>
                <dd className="tabular mt-0.5 text-base">{formatINR(auction.minimumNextBid, true)}</dd>
              </div>
              <div>
                <dt className="text-muted">Closes</dt>
                <dd className="mt-0.5 text-base">{formatDateTime(auction.endTime)}</dd>
              </div>
            </>
          )}
        </dl>
        {auction.endTime !== auction.originalEndTime && !ended && <p className="mt-3 text-xs text-muted">End time extended by late bidding.</p>}

        {auction.status === 'CANCELLED' && <p className="mt-5 rounded-md bg-outbid-tint/60 p-3 text-sm text-ink-soft">This auction was withdrawn{auction.cancelReason ? `: ${auction.cancelReason}` : '.'}</p>}

        {canBid && (
          <form onSubmit={openConfirm} className="mt-6 border-t border-line pt-5" noValidate>
            <label htmlFor="bid-amount" className="text-sm font-medium">
              Your bid
            </label>
            <div className="mt-2 flex gap-2">
              <div className="relative flex-1">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft">₹</span>
                <input
                  id="bid-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  value={amount}
                  onChange={(e) => {
                    setAmount(e.target.value);
                    setEdited(true);
                    setError(null);
                  }}
                  aria-invalid={Boolean(error)}
                  aria-describedby="bid-help"
                  className="tabular h-12 w-full rounded-md border border-line-strong bg-paper pl-8 pr-3 text-lg focus:border-baize focus:outline-none focus:ring-2 focus:ring-baize/15 aria-[invalid=true]:border-outbid"
                />
              </div>
              <Button type="submit" size="lg">
                Place bid
              </Button>
            </div>
            <div className="mt-2 flex flex-wrap gap-2" aria-label="Quick amounts">
              {quickAdds.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => {
                    setAmount(q);
                    setEdited(true);
                    setError(null);
                  }}
                  className="tabular rounded-sm border border-line px-2 py-1 text-xs text-ink-soft hover:border-ink-soft"
                >
                  {formatINR(q)}
                </button>
              ))}
            </div>
            <p id="bid-help" className={cn('mt-2 text-xs', error ? 'text-outbid' : 'text-muted')} role={error ? 'alert' : undefined}>
              {error ?? `Increments of ${formatINR(auction.minimumBidIncrement, true)}. The server checks every bid against the live price.`}
            </p>
          </form>
        )}

        {!user && auction.status === 'ACTIVE' && (
          <div className="mt-6 border-t border-line pt-5">
            <Link to="/login" state={{ from: location.pathname }} className="flex h-12 w-full items-center justify-center rounded-md bg-baize font-medium text-porcelain hover:bg-baize-deep">
              Sign in to bid
            </Link>
          </div>
        )}
        {isOwner && !ended && auction.status !== 'CANCELLED' && <p className="mt-6 border-t border-line pt-5 text-sm text-muted">This is your listing. You can follow bids live, but you can’t bid on it.</p>}
        {user?.role === 'ADMIN' && !isOwner && auction.status === 'ACTIVE' && <p className="mt-6 border-t border-line pt-5 text-sm text-muted">Administrators can’t bid.</p>}
      </div>

      <Dialog open={confirming} onOpenChange={(o) => !submitting && setConfirming(o)} title="Confirm your bid" description="Bids are binding. If you win, you agree to buy at your bid price.">
        <div className="rounded-md bg-porcelain p-4">
          <div className="text-sm text-muted">{auction.title}</div>
          <div className="tabular mt-1 font-serif text-3xl">{formatINR(amount, true)}</div>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-outbid">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirming(false)} disabled={submitting}>
            Change amount
          </Button>
          <Button onClick={submit} loading={submitting} autoFocus>
            {error && error.startsWith('Connection') ? 'Retry bid' : `Bid ${formatINR(amount, true)}`}
          </Button>
        </div>
      </Dialog>
    </section>
  );
}
