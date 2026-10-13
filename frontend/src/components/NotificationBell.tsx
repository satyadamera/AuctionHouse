import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { Bell } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useNotifications } from '@/context/NotificationsContext';
import { api } from '@/services/api';
import { qk } from '@/services/queries';
import { timeAgo } from '@/utils/format';
import { cn } from '@/utils/cn';

export function NotificationBell() {
  const { items, unreadCount } = useNotifications();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const markAll = async () => {
    await api.patch('/notifications/read-all');
    void qc.invalidateQueries({ queryKey: qk.notifications });
  };
  const open = async (id: number, auctionId: number | null, isRead: boolean) => {
    if (!isRead) {
      await api.patch(`/notifications/${id}/read`).catch(() => undefined);
      void qc.invalidateQueries({ queryKey: qk.notifications });
    }
    if (auctionId) navigate(`/auctions/${auctionId}`);
  };
  return (
    <Dropdown.Root>
      <Dropdown.Trigger
        className="relative grid size-10 place-items-center rounded-md text-ink-soft hover:bg-ink/5"
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : 'Notifications'}
      >
        <Bell className="size-5" />
        {unreadCount > 0 && (
          <span className="tabular absolute right-1 top-1 grid min-w-4.5 place-items-center rounded-full bg-outbid px-1 text-[0.65rem] font-semibold leading-4.5 text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={8} className="z-50 w-[min(92vw,24rem)] rounded-lg border border-line bg-paper shadow-xl">
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="font-serif text-lg">Notifications</span>
            {unreadCount > 0 && (
              <button onClick={markAll} className="text-xs font-medium text-baize hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">Bids, outbids and results will appear here.</p>}
            {items.slice(0, 12).map((n) => (
              <Dropdown.Item
                key={n.id}
                onSelect={() => void open(n.id, n.auctionId, n.isRead)}
                className={cn('flex cursor-pointer gap-3 border-b border-line/60 px-4 py-3 outline-none last:border-0 data-[highlighted]:bg-ink/[0.03]', !n.isRead && 'bg-baize-tint/40')}
              >
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.isRead ? 'bg-transparent' : n.type === 'OUTBID' ? 'bg-outbid' : 'bg-baize')} aria-hidden />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm font-medium">{n.title}</span>
                  <span className="text-sm text-ink-soft">{n.message}</span>
                  <span className="text-xs text-muted">{timeAgo(n.createdAt)}</span>
                </span>
              </Dropdown.Item>
            ))}
          </div>
          <Dropdown.Item onSelect={() => navigate('/dashboard?tab=notifications')} className="block cursor-pointer px-4 py-3 text-center text-sm font-medium text-baize outline-none data-[highlighted]:bg-ink/[0.03]">
            See all notifications
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
