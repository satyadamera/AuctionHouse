import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Search } from 'lucide-react';
import { fetchers, qk } from '@/services/queries';
import { AuctionCard, AuctionGrid } from '@/features/auctions/AuctionCard';
import { Countdown } from '@/features/auctions/Countdown';
import { PriceRoll } from '@/features/auctions/PriceRoll';
import { useFeedEntry } from '@/context/LiveFeedContext';
import { useAuth } from '@/context/AuthContext';
import { ErrorState, Skeleton } from '@/components/ui/Status';
import { formatINR, lotNumber } from '@/utils/format';
import type { AuctionSummary } from '@/types/api';

/** The hero shows a real live lot whose price ticks as bids land, rather than a stats banner. */
function HeroLot({ auction }: { auction: AuctionSummary }) {
  const live = useFeedEntry(auction.id, auction.version);
  const price = live?.currentHighestBid ?? auction.currentHighestBid ?? auction.startingPrice;
  const bids = live?.bidCount ?? auction.bidCount;
  return (
    <Link to={`/auctions/${auction.id}`} className="group grid overflow-hidden rounded-lg border border-line bg-paper sm:grid-cols-[1.1fr_1fr] lg:grid-cols-1 xl:grid-cols-[1.1fr_1fr]">
      <div className="aspect-square bg-line/40">{auction.coverImage && <img src={auction.coverImage} alt="" className="size-full object-cover" />}</div>
      <div className="flex flex-col justify-between gap-6 p-6">
        <div>
          <div className="flex items-center justify-between text-xs text-muted">
            <span>{lotNumber(auction.id)}</span>
            <span className="inline-flex items-center gap-1.5 text-baize">
              <span className="size-1.5 rounded-full bg-baize motion-safe:animate-pulse" aria-hidden /> On the block now
            </span>
          </div>
          <h2 className="mt-2 text-2xl group-hover:underline group-hover:decoration-line-strong group-hover:underline-offset-4">{auction.title}</h2>
          <p className="mt-1 text-sm text-muted">Offered by {auction.seller.name}</p>
        </div>
        <div>
          <div className="text-sm text-muted">{auction.currentHighestBid || live ? 'Current bid' : 'Starting bid'}</div>
          <PriceRoll amount={price} className="font-serif text-4xl" />
          <div className="mt-4 flex justify-between border-t border-line pt-3 text-sm">
            <span className="text-ink-soft">{bids} bids</span>
            <Countdown status={auction.status} startTime={auction.startTime} endTime={live?.endTime ?? auction.endTime} />
          </div>
        </div>
      </div>
    </Link>
  );
}

function SectionHeader({ title, to, linkLabel }: { title: string; to?: string; linkLabel?: string }) {
  return (
    <div className="mb-6 flex items-end justify-between gap-4">
      <h2 className="text-3xl">{title}</h2>
      {to && (
        <Link to={to} className="shrink-0 text-sm font-medium text-baize underline decoration-baize/30 underline-offset-4 hover:decoration-baize">
          {linkLabel}
        </Link>
      )}
    </div>
  );
}

export function HomePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [q, setQ] = useState('');
  const featured = useQuery({ queryKey: qk.featured, queryFn: fetchers.featured });
  const endingSoon = useQuery({ queryKey: qk.browse({ sort: 'ending_soon', pageSize: 4 }), queryFn: () => fetchers.browse({ sort: 'ending_soon', pageSize: 4 }) });
  const recent = useQuery({ queryKey: qk.browse({ sort: 'newest', pageSize: 4, status: 'ALL' }), queryFn: () => fetchers.browse({ sort: 'newest', pageSize: 4, status: 'ALL' }) });
  const categories = useQuery({ queryKey: qk.categories, queryFn: fetchers.categories });
  const stats = useQuery({ queryKey: qk.stats, queryFn: fetchers.stats });

  const liveFeatured = featured.data?.filter((a) => a.status === 'ACTIVE') ?? [];
  const heroLot = liveFeatured[0] ?? endingSoon.data?.items[0];
  const search = (e: FormEvent) => {
    e.preventDefault();
    navigate(`/auctions${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
  };

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6">
      <section className="grid gap-10 py-12 lg:grid-cols-[1.15fr_1fr] lg:items-center lg:py-20">
        <div>
          <h1 className="max-w-[16ch] text-4xl leading-[1.05] sm:text-5xl">Bid on things worth keeping, live.</h1>
          <p className="mt-5 max-w-[52ch] text-lg text-ink-soft">
            Watches, art, cameras, coins and rare pairs from independent sellers. Every bid is checked against the live price the moment it arrives, and everyone in the room sees it at once.
          </p>
          <form onSubmit={search} role="search" className="mt-8 flex max-w-lg gap-2">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 size-5 -translate-y-1/2 text-muted" aria-hidden />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Chronograph, gouache, first edition…"
                aria-label="Search lots"
                className="h-12 w-full rounded-md border border-line-strong bg-paper pl-11 pr-3 focus:border-baize focus:outline-none focus:ring-2 focus:ring-baize/15"
              />
            </div>
            <button className="h-12 rounded-md bg-baize px-6 font-medium text-porcelain hover:bg-baize-deep">Search</button>
          </form>
          {!user && (
            <p className="mt-4 text-sm text-muted">
              <Link to="/register" className="font-medium text-baize underline underline-offset-4">Create a free account</Link> to bid, or{' '}
              <Link to="/login" className="font-medium text-ink underline underline-offset-4">sign in</Link>.
            </p>
          )}
          {stats.data && (
            <dl className="mt-10 flex flex-wrap gap-x-10 gap-y-4 border-t border-line pt-6 text-sm">
              <div><dt className="text-muted">Live lots</dt><dd className="tabular font-serif text-2xl">{stats.data.liveAuctions}</dd></div>
              <div><dt className="text-muted">Bids in the last day</dt><dd className="tabular font-serif text-2xl">{stats.data.bidsLast24h}</dd></div>
              <div><dt className="text-muted">Lots sold</dt><dd className="tabular font-serif text-2xl">{stats.data.completedAuctions}</dd></div>
            </dl>
          )}
        </div>
        <div>{heroLot ? <HeroLot auction={heroLot} /> : featured.isLoading ? <Skeleton className="aspect-[4/3]" /> : null}</div>
      </section>

      {featured.error && <ErrorState message="Featured lots could not be loaded." onRetry={() => void featured.refetch()} />}

      <section className="py-10" aria-labelledby="closing">
        <SectionHeader title="Closing soon" to="/auctions?sort=ending_soon" linkLabel="All live lots" />
        <span id="closing" className="sr-only">Closing soon</span>
        <AuctionGrid items={endingSoon.data?.items} loading={endingSoon.isLoading} />
      </section>

      {liveFeatured.length > 1 && (
        <section className="py-10">
          <SectionHeader title="Featured this week" to="/auctions?featured=true" linkLabel="All featured" />
          <div className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
            {(featured.data ?? []).slice(1, 4).map((a) => (
              <AuctionCard key={a.id} auction={a} size="lg" />
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-10 py-10 lg:grid-cols-[1fr_2fr]">
        <div>
          <h2 className="text-3xl">Departments</h2>
          <p className="mt-3 max-w-[40ch] text-ink-soft">Browse by what you collect. Counts show lots taking bids right now.</p>
        </div>
        <ul className="divide-y divide-line border-y border-line">
          {(categories.data ?? []).map((c) => (
            <li key={c.id}>
              <Link to={`/auctions?category=${c.slug}`} className="group grid grid-cols-[4rem_1fr_auto] items-center gap-5 py-4">
                <span className="size-16 overflow-hidden rounded-md bg-line/50">{c.imageUrl && <img src={c.imageUrl} alt="" className="size-full object-cover" />}</span>
                <span>
                  <span className="block font-serif text-xl group-hover:underline group-hover:underline-offset-4">{c.name}</span>
                  <span className="block text-sm text-muted">{c.description}</span>
                </span>
                <span className="tabular text-sm text-ink-soft">{c.liveCount} live</span>
              </Link>
            </li>
          ))}
          {categories.isLoading && Array.from({ length: 5 }, (_, i) => <li key={i} className="py-4"><Skeleton className="h-16" /></li>)}
        </ul>
      </section>

      <section className="py-10">
        <SectionHeader title="Just listed" to="/auctions?sort=newest&status=ALL" linkLabel="Newest lots" />
        <AuctionGrid items={recent.data?.items} loading={recent.isLoading} />
      </section>

      <section id="how-bidding-works" className="scroll-mt-24 py-14">
        <h2 className="text-3xl">How bidding works</h2>
        <ol className="mt-8 grid gap-8 md:grid-cols-4">
          {[
            ['Find a lot', 'Every lot shows its current bid, the next minimum and a countdown that follows the server’s clock.'],
            ['Place a bid', 'Enter at least the next minimum and confirm. Your first bid on a fresh lot can match the starting price.'],
            ['Watch it live', 'New bids appear instantly for everyone in the room. If someone outbids you, you’ll get an alert straight away.'],
            ['Win at the close', 'When time runs out the highest bid wins. Bids that arrive after the closing time are refused.'],
          ].map(([title, body], i) => (
            <li key={title} className="border-t-2 border-ink pt-4">
              <span className="tabular font-serif text-4xl text-baize">{i + 1}</span>
              <h3 className="mt-2 text-xl">{title}</h3>
              <p className="mt-2 text-sm text-ink-soft">{body}</p>
            </li>
          ))}
        </ol>
        <p className="mt-8 text-sm text-muted">Minimum increments are set per lot by the seller, for example {formatINR('500')} on a {formatINR('40000')} watch.</p>
      </section>
    </div>
  );
}
