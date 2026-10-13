import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, errorMessage } from '@/services/api';
import { fetchers, qk } from '@/services/queries';
import { EmptyState, ErrorState, Skeleton, StatusBadge } from '@/components/ui/Status';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { BarChartCard, formatDay } from '@/components/BarChartCard';
import { Countdown } from '@/features/auctions/Countdown';
import { formatINR, lotNumber } from '@/utils/format';
import type { AuctionStatus, Listing } from '@/types/api';

interface SellerStats {
  countsByStatus: Record<AuctionStatus, number>;
  revenue: string;
  totalBids: number;
  averageBidsPerListing: number;
  highestBid: string | null;
  dailyBids: { day: string; bids: number; volume: string }[];
}

function ListingTable({ rows }: { rows: Listing[] }) {
  if (!rows.length) return <EmptyState title="Nothing here yet">Listings in this state will appear here.</EmptyState>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            <th className="py-2 font-normal">Lot</th>
            <th className="py-2 font-normal">Status</th>
            <th className="py-2 text-right font-normal">Highest bid</th>
            <th className="py-2 text-right font-normal">Bids</th>
            <th className="py-2 text-right font-normal">Timing</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((l) => (
            <tr key={l.id}>
              <td className="py-3 pr-4">
                <Link to={`/auctions/${l.id}`} className="flex items-center gap-3 hover:underline">
                  <span className="size-12 shrink-0 overflow-hidden rounded bg-line/50">{l.coverImage && <img src={l.coverImage} alt="" className="size-full object-cover" />}</span>
                  <span>
                    <span className="block text-xs text-muted">{lotNumber(l.id)}</span>
                    <span className="font-serif text-base">{l.title}</span>
                  </span>
                </Link>
              </td>
              <td className="py-3"><StatusBadge status={l.status} noBids={l.bidCount === 0} /></td>
              <td className="tabular py-3 text-right">{formatINR(l.finalPrice ?? l.currentHighestBid)}</td>
              <td className="tabular py-3 text-right">{l.bidCount}</td>
              <td className="py-3 text-right"><Countdown status={l.status} startTime={l.startTime} endTime={l.endTime} compact /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SellerPage() {
  const stats = useQuery({ queryKey: qk.sellerStats, queryFn: async () => (await api.get<SellerStats>('/users/me/seller-stats')).data });
  const listings = useQuery({ queryKey: qk.listings, queryFn: fetchers.listings, refetchInterval: 30_000 });
  const [tab, setTab] = useState<AuctionStatus>('ACTIVE');

  if (stats.error || listings.error) return <div className="mx-auto max-w-3xl px-4 py-16"><ErrorState message={errorMessage(stats.error ?? listings.error)} /></div>;
  const s = stats.data;
  const by = (st: AuctionStatus) => (listings.data ?? []).filter((l) => l.status === st);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl">Your saleroom</h1>
          <p className="mt-2 text-ink-soft">Listings, bidding activity and sales.</p>
        </div>
        <Link to="/sell" className="inline-flex h-10 items-center gap-2 rounded-md bg-baize px-4 text-sm font-medium text-porcelain hover:bg-baize-deep">
          <Plus className="size-4" aria-hidden /> List an item
        </Link>
      </div>

      {!s ? (
        <Skeleton className="mt-8 h-28" />
      ) : (
        <dl className="mt-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[
            ['Live now', String(s.countsByStatus.ACTIVE)],
            ['Bids received', String(s.totalBids)],
            ['Sold value', formatINR(s.revenue)],
            ['Highest current bid', formatINR(s.highestBid)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-paper p-4">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="tabular mt-1 font-serif text-3xl">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <BarChartCard title="Bids on your lots, last 14 days" data={s?.dailyBids ?? []} xKey="day" yKey="bids" yLabel="Bids" formatX={formatDay} emptyText="No bids in the last two weeks." />
        <BarChartCard
          title="Listings by status"
          layout="vertical"
          data={s ? (['ACTIVE', 'SCHEDULED', 'DRAFT', 'COMPLETED', 'CANCELLED'] as const).map((k) => ({ status: { ACTIVE: 'Live', SCHEDULED: 'Scheduled', DRAFT: 'Drafts', COMPLETED: 'Completed', CANCELLED: 'Withdrawn' }[k], count: s.countsByStatus[k] })) : []}
          xKey="status"
          yKey="count"
          yLabel="Listings"
        />
      </div>

      <div className="mt-10">
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as AuctionStatus)}
          tabs={(['ACTIVE', 'SCHEDULED', 'DRAFT', 'COMPLETED', 'CANCELLED'] as const).map((st) => ({
            value: st,
            label: `${{ ACTIVE: 'Live', SCHEDULED: 'Scheduled', DRAFT: 'Drafts', COMPLETED: 'Completed', CANCELLED: 'Withdrawn' }[st]} (${by(st).length})`,
          }))}
        >
          {(['ACTIVE', 'SCHEDULED', 'DRAFT', 'COMPLETED', 'CANCELLED'] as const).map((st) => (
            <TabPanel key={st} value={st}>{listings.isLoading ? <Skeleton className="h-40" /> : <ListingTable rows={by(st)} />}</TabPanel>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
