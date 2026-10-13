import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useNotifications } from '@/context/NotificationsContext';
import { api, errorMessage } from '@/services/api';
import { fetchers, qk } from '@/services/queries';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/Status';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { AuctionGrid } from '@/features/auctions/AuctionCard';
import { Countdown } from '@/features/auctions/Countdown';
import { formatDateTime, formatINR, lotNumber, timeAgo } from '@/utils/format';
import type { MyBid, User } from '@/types/api';
import { cn } from '@/utils/cn';

const POSITION: Record<MyBid['position'], { label: string; className: string }> = {
  WINNING: { label: 'Winning', className: 'bg-brass-tint text-[#7a5c1c]' },
  OUTBID: { label: 'Outbid', className: 'bg-outbid-tint text-outbid' },
  WON: { label: 'Won', className: 'bg-baize text-porcelain' },
  LOST: { label: 'Lost', className: 'bg-ink/5 text-ink-soft' },
  CANCELLED: { label: 'Withdrawn', className: 'bg-ink/5 text-muted' },
};

function BidRows({ rows }: { rows: MyBid[] }) {
  return (
    <ul className="divide-y divide-line border-y border-line">
      {rows.map((r) => (
        <li key={r.auction.id}>
          <Link to={`/auctions/${r.auction.id}`} className="grid grid-cols-[4rem_1fr] gap-4 py-4 hover:bg-ink/[0.02] sm:grid-cols-[4rem_1fr_auto_auto] sm:items-center">
            <span className="size-16 overflow-hidden rounded-md bg-line/50">{r.auction.coverImage && <img src={r.auction.coverImage} alt="" className="size-full object-cover" />}</span>
            <span className="min-w-0">
              <span className="block text-xs text-muted">{lotNumber(r.auction.id)}</span>
              <span className="block truncate font-serif text-lg">{r.auction.title}</span>
              <span className={cn('mt-1 inline-block rounded-sm px-2 py-0.5 text-xs font-medium', POSITION[r.position].className)}>{POSITION[r.position].label}</span>
            </span>
            <span className="col-start-2 text-sm sm:col-start-auto sm:text-right">
              <span className="block text-muted">Your highest</span>
              <span className="tabular">{formatINR(r.myHighestBid, true)}</span>
            </span>
            <span className="col-start-2 text-sm sm:col-start-auto sm:w-36 sm:text-right">
              <span className="block text-muted">{r.auction.status === 'COMPLETED' ? 'Final price' : 'Current bid'}</span>
              <span className="tabular">{formatINR(r.finalPrice ?? r.auction.currentHighestBid, true)}</span>
              {r.auction.status === 'ACTIVE' && <span className="block text-xs"><Countdown status={r.auction.status} startTime={r.auction.startTime} endTime={r.auction.endTime} compact /></span>}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function BiddingTab() {
  const q = useQuery({ queryKey: qk.myBids, queryFn: fetchers.myBids });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  const rows = q.data ?? [];
  if (!rows.length) return <EmptyState title="You haven’t bid yet" action={<Link to="/auctions" className="text-sm font-medium text-baize underline underline-offset-4">Browse live lots</Link>}>Lots you bid on will appear here with whether you’re winning.</EmptyState>;
  const groups: [string, MyBid[]][] = [
    ['Winning now', rows.filter((r) => r.position === 'WINNING')],
    ['Outbid, still live', rows.filter((r) => r.position === 'OUTBID')],
    ['Won', rows.filter((r) => r.position === 'WON')],
    ['Lost or withdrawn', rows.filter((r) => r.position === 'LOST' || r.position === 'CANCELLED')],
  ];
  return (
    <div className="flex flex-col gap-10">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {groups.map(([label, list]) => (
          <div key={label} className="rounded-lg border border-line bg-paper p-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="tabular mt-1 font-serif text-3xl">{list.length}</dd>
          </div>
        ))}
      </dl>
      {groups.map(([label, list]) =>
        list.length ? (
          <section key={label}>
            <h2 className="mb-3 text-2xl">{label}</h2>
            <BidRows rows={list} />
          </section>
        ) : null,
      )}
    </div>
  );
}

function WatchlistTab() {
  const q = useQuery({ queryKey: qk.watchlist, queryFn: fetchers.watchlist });
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (q.data && !q.data.length) return <EmptyState title="Nothing on your watchlist">Tap the heart on any lot to follow it. You’ll get an alert before it closes.</EmptyState>;
  return <AuctionGrid items={q.data} loading={q.isLoading} columns={3} />;
}

function NotificationsTab() {
  const { items, unreadCount, loading } = useNotifications();
  const qc = useQueryClient();
  if (loading) return <Skeleton className="h-64" />;
  if (!items.length) return <EmptyState title="No notifications yet">Bid confirmations, outbid alerts and results will show up here.</EmptyState>;
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">{unreadCount} unread</p>
        {unreadCount > 0 && <Button variant="secondary" size="sm" onClick={async () => { await api.patch('/notifications/read-all'); void qc.invalidateQueries({ queryKey: qk.notifications }); }}>Mark all read</Button>}
      </div>
      <ul className="divide-y divide-line border-y border-line">
        {items.map((n) => (
          <li key={n.id} className={cn('flex gap-4 py-4', !n.isRead && 'bg-baize-tint/30')}>
            <span className={cn('mt-2 size-2 shrink-0 rounded-full', n.isRead ? 'bg-line' : n.type === 'OUTBID' ? 'bg-outbid' : 'bg-baize')} aria-hidden />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-medium">{n.title}</span>
                <time className="text-xs text-muted" dateTime={n.createdAt} title={formatDateTime(n.createdAt)}>{timeAgo(n.createdAt)}</time>
              </div>
              <p className="text-sm text-ink-soft">{n.message}</p>
              {n.auctionId && <Link to={`/auctions/${n.auctionId}`} className="mt-1 inline-block text-sm text-baize underline underline-offset-4">Open lot</Link>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SettingsTab() {
  const { user, updateUser } = useAuth();
  const { register, handleSubmit, formState } = useForm<{ name: string }>({ defaultValues: { name: user?.name ?? '' } });
  const save = handleSubmit(async (v) => {
    try {
      const { data } = await api.patch<User>('/users/me', { name: v.name });
      updateUser(data);
      toast.success('Profile saved');
    } catch (err) {
      toast.error('Profile not saved', { description: errorMessage(err) });
    }
  });
  if (!user) return null;
  return (
    <form onSubmit={save} className="flex max-w-md flex-col gap-5">
      <Field label="Display name" hint="Other bidders see your first name and last initial.">
        {({ id, describedBy }) => <Input id={id} aria-describedby={describedBy} {...register('name', { required: true, minLength: 2 })} />}
      </Field>
      <Field label="Email">{({ id }) => <Input id={id} value={user.email} disabled readOnly />}</Field>
      <Field label="Account type">{({ id }) => <Input id={id} value={user.role === 'USER' ? 'Bidder' : user.role === 'SELLER' ? 'Bidder and seller' : 'Administrator'} disabled readOnly />}</Field>
      <Button type="submit" loading={formState.isSubmitting} className="self-start">Save changes</Button>
    </form>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'bidding';
  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-4xl">Hello, {user?.name.split(' ')[0]}</h1>
      <p className="mt-2 text-ink-soft">Your bids, watched lots and alerts, updated live.</p>
      <div className="mt-8">
        <Tabs
          value={tab}
          onValueChange={(v) => setParams({ tab: v })}
          tabs={[{ value: 'bidding', label: 'My bids' }, { value: 'watchlist', label: 'Watchlist' }, { value: 'notifications', label: 'Notifications' }, { value: 'settings', label: 'Settings' }]}
        >
          <TabPanel value="bidding"><BiddingTab /></TabPanel>
          <TabPanel value="watchlist"><WatchlistTab /></TabPanel>
          <TabPanel value="notifications"><NotificationsTab /></TabPanel>
          <TabPanel value="settings"><SettingsTab /></TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
