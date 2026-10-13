import { useState } from 'react';
import { Link } from 'react-router-dom';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, errorMessage } from '@/services/api';
import { BarChartCard, formatDay } from '@/components/BarChartCard';
import { TabPanel, Tabs } from '@/components/ui/Tabs';
import { ErrorState, Skeleton, StatusBadge } from '@/components/ui/Status';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { formatDateTime, formatINR, lotNumber } from '@/utils/format';
import type { AuctionSummary, PageMeta, User } from '@/types/api';

interface Dashboard {
  totals: Record<string, number | string>;
  dailyBids: { day: string; bids: number }[];
  byCategory: { name: string; auctions: number; bids: number }[];
  hottestAuctions: AuctionSummary[];
}

function Overview() {
  const q = useQuery({ queryKey: ['admin', 'dashboard'], queryFn: async () => (await api.get<Dashboard>('/admin/dashboard')).data, refetchInterval: 15_000 });
  const diag = useQuery({ queryKey: ['admin', 'diagnostics'], queryFn: async () => (await api.get<{ health: { status: string }; cache: { hitRate: number | null; hits: number; misses: number }; outbox: { pending: number; dispatched: number } }>('/admin/diagnostics')).data, refetchInterval: 15_000 });
  if (q.error) return <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96" />;
  const t = q.data.totals;
  const tiles: [string, string][] = [
    ['Users', String(t.users)],
    ['Auctions', String(t.auctions)],
    ['Live', String(t.activeAuctions)],
    ['Completed', String(t.completedAuctions)],
    ['Total bids', String(t.bids)],
    ['Sold value', formatINR(String(t.grossMerchandiseValue))],
  ];
  return (
    <div className="flex flex-col gap-6">
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
        {tiles.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-line bg-paper p-4">
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="tabular mt-1 font-serif text-2xl">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="grid gap-6 lg:grid-cols-2">
        <BarChartCard title="Bids per day, last 14 days" data={q.data.dailyBids} xKey="day" yKey="bids" yLabel="Bids" formatX={formatDay} />
        <BarChartCard title="Bids by department" layout="vertical" data={q.data.byCategory.map((c) => ({ name: c.name, bids: c.bids }))} xKey="name" yKey="bids" yLabel="Bids" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="rounded-lg border border-line bg-paper p-5">
          <h2 className="text-xl">Most active live lots</h2>
          <ol className="mt-3 divide-y divide-line">
            {q.data.hottestAuctions.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <Link to={`/auctions/${a.id}`} className="truncate hover:underline"><span className="text-muted">{lotNumber(a.id)}</span> {a.title}</Link>
                <span className="tabular shrink-0 text-ink-soft">{a.bidCount} bids, {formatINR(a.currentHighestBid)}</span>
              </li>
            ))}
          </ol>
        </section>
        <section className="rounded-lg border border-line bg-paper p-5 text-sm">
          <h2 className="text-xl">System</h2>
          {diag.data ? (
            <dl className="mt-3 flex flex-col gap-2">
              <div className="flex justify-between"><dt className="text-muted">Dependencies</dt><dd>{diag.data.health.status === 'ok' ? 'MySQL and Redis healthy' : diag.data.health.status}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Cache hit rate</dt><dd className="tabular">{diag.data.cache.hitRate === null ? '—' : `${Math.round(diag.data.cache.hitRate * 100)}%`} <span className="text-muted">({diag.data.cache.hits}/{diag.data.cache.hits + diag.data.cache.misses})</span></dd></div>
              <div className="flex justify-between"><dt className="text-muted">Events delivered</dt><dd className="tabular">{diag.data.outbox.dispatched}</dd></div>
              <div className="flex justify-between"><dt className="text-muted">Events waiting</dt><dd className="tabular">{diag.data.outbox.pending}</dd></div>
            </dl>
          ) : (
            <Skeleton className="mt-3 h-24" />
          )}
        </section>
      </div>
    </div>
  );
}

function UsersTab() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  const users = useQuery({
    queryKey: ['admin', 'users', q, page],
    queryFn: async () => api.get<(User & { bidCount: number; listingCount: number })[]>('/admin/users', { q: q || undefined, page, pageSize: 20 }),
    placeholderData: keepPreviousData,
  });
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      void qc.invalidateQueries({ queryKey: ['admin'] });
    } catch (err) {
      toast.error('Not changed', { description: errorMessage(err) });
    }
  };
  const meta = users.data?.meta as PageMeta | undefined;
  return (
    <div>
      <Input placeholder="Search by name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="max-w-sm" aria-label="Search users" />
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="border-b border-line text-muted"><tr><th className="py-2 font-normal">Name</th><th className="py-2 font-normal">Role</th><th className="py-2 text-right font-normal">Bids</th><th className="py-2 text-right font-normal">Listings</th><th className="py-2 font-normal">Status</th><th className="py-2" /></tr></thead>
          <tbody className="divide-y divide-line">
            {users.data?.data.map((u) => (
              <tr key={u.id}>
                <td className="py-2.5"><div className="font-medium">{u.name}</div><div className="text-xs text-muted">{u.email}</div></td>
                <td className="py-2.5">
                  {u.role === 'ADMIN' ? 'Admin' : (
                    <Select aria-label={`Role for ${u.name}`} value={u.role} className="h-8 w-28 text-sm" onChange={(e) => void act(() => api.patch(`/admin/users/${u.id}/role`, { role: e.target.value }), 'Role updated')}>
                      <option value="USER">Bidder</option>
                      <option value="SELLER">Seller</option>
                    </Select>
                  )}
                </td>
                <td className="tabular py-2.5 text-right">{u.bidCount}</td>
                <td className="tabular py-2.5 text-right">{u.listingCount}</td>
                <td className="py-2.5">{u.status === 'ACTIVE' ? 'Active' : <span className="text-outbid">Suspended</span>}</td>
                <td className="py-2.5 text-right">
                  {u.role !== 'ADMIN' && (
                    <Button size="sm" variant="secondary" onClick={() => void act(() => api.patch(`/admin/users/${u.id}/status`, { status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' }), u.status === 'ACTIVE' ? 'User suspended' : 'User reactivated')}>
                      {u.status === 'ACTIVE' ? 'Suspend' : 'Reactivate'}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {meta && meta.totalPages > 1 && (
        <div className="mt-4 flex items-center gap-3 text-sm">
          <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
          <span className="tabular text-muted">Page {meta.page} of {meta.totalPages}</span>
          <Button size="sm" variant="secondary" disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)}>Next</Button>
        </div>
      )}
    </div>
  );
}

function ModerationTab() {
  const [status, setStatus] = useState('ACTIVE');
  const [target, setTarget] = useState<{ auction: AuctionSummary; mode: 'cancel' | 'reject' } | null>(null);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['admin', 'auctions', status], queryFn: async () => (await api.get<(AuctionSummary & { moderationStatus: string })[]>('/admin/auctions', { status: status || undefined, pageSize: 50 })).data });
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      void qc.invalidateQueries();
      setTarget(null);
      setReason('');
    } catch (err) {
      toast.error('Action failed', { description: errorMessage(err) });
    }
  };
  return (
    <div>
      <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-48" aria-label="Filter by status">
        <option value="ACTIVE">Live</option>
        <option value="SCHEDULED">Scheduled</option>
        <option value="DRAFT">Drafts</option>
        <option value="COMPLETED">Completed</option>
        <option value="CANCELLED">Withdrawn</option>
        <option value="">All</option>
      </Select>
      <ul className="mt-4 divide-y divide-line border-y border-line">
        {list.data?.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
            <div className="flex items-center gap-3">
              <span className="size-12 overflow-hidden rounded bg-line/50">{a.coverImage && <img src={a.coverImage} alt="" className="size-full object-cover" />}</span>
              <div>
                <Link to={`/auctions/${a.id}`} className="font-serif text-base hover:underline">{a.title}</Link>
                <div className="text-xs text-muted">{lotNumber(a.id)}, {a.seller.name}, ends {formatDateTime(a.endTime)}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <StatusBadge status={a.status} noBids={a.bidCount === 0} />
              {(a.status === 'ACTIVE' || a.status === 'SCHEDULED') && (
                <>
                  <Button size="sm" variant="ghost" onClick={() => void run(() => api.patch(`/admin/auctions/${a.id}/feature`, { isFeatured: !a.isFeatured }), a.isFeatured ? 'Removed from featured' : 'Featured')}>
                    {a.isFeatured ? 'Unfeature' : 'Feature'}
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setTarget({ auction: a, mode: 'reject' })}>Reject</Button>
                  <Button size="sm" variant="secondary" onClick={() => setTarget({ auction: a, mode: 'cancel' })}>Cancel</Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={Boolean(target)} onOpenChange={(o) => !o && setTarget(null)} title={target?.mode === 'reject' ? 'Reject listing' : 'Cancel auction'} description={target ? `${target.auction.title}. The seller, bidders and watchers are notified.` : undefined}>
        <Field label="Reason">{({ id }) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} className="min-h-24" />}</Field>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setTarget(null)}>Back</Button>
          <Button variant="danger" disabled={reason.trim().length < 5} onClick={() => target && void run(() => api.post(`/admin/auctions/${target.auction.id}/${target.mode}`, { reason }), target.mode === 'reject' ? 'Listing rejected' : 'Auction cancelled')}>
            {target?.mode === 'reject' ? 'Reject listing' : 'Cancel auction'}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function AuditTab() {
  const q = useQuery({ queryKey: ['admin', 'audit'], queryFn: async () => (await api.get<{ id: number; action: string; entityType: string; entityId: number | null; actor: { name: string } | null; createdAt: string; metadata: unknown }[]>('/admin/audit-logs', { pageSize: 50 })).data });
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-line text-muted"><tr><th className="py-2 font-normal">When</th><th className="py-2 font-normal">Actor</th><th className="py-2 font-normal">Action</th><th className="py-2 font-normal">Target</th></tr></thead>
        <tbody className="divide-y divide-line">
          {q.data?.map((r) => (
            <tr key={r.id}>
              <td className="py-2 text-muted">{formatDateTime(r.createdAt)}</td>
              <td className="py-2">{r.actor?.name ?? 'System'}</td>
              <td className="py-2"><code className="rounded bg-ink/5 px-1 text-xs">{r.action}</code></td>
              <td className="py-2 text-ink-soft">{r.entityType}{r.entityId ? ` #${r.entityId}` : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState('overview');
  return (
    <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6">
      <h1 className="text-4xl">Administration</h1>
      <p className="mt-2 text-ink-soft">Platform health, users and listing moderation.</p>
      <div className="mt-8">
        <Tabs value={tab} onValueChange={setTab} tabs={[{ value: 'overview', label: 'Overview' }, { value: 'users', label: 'Users' }, { value: 'moderation', label: 'Listings' }, { value: 'audit', label: 'Audit log' }]}>
          <TabPanel value="overview"><Overview /></TabPanel>
          <TabPanel value="users"><UsersTab /></TabPanel>
          <TabPanel value="moderation"><ModerationTab /></TabPanel>
          <TabPanel value="audit"><AuditTab /></TabPanel>
        </Tabs>
      </div>
    </div>
  );
}
