import type { Kysely } from 'kysely';
import type { Database, NotificationType } from '../database/types.js';
import { enqueueEvent } from './outbox.js';

export interface NewNotification {
  userId: number;
  type: NotificationType;
  title: string;
  message: string;
  auctionId?: number | null;
}

/**
 * Persists a notification and enqueues its real-time `notification:new` event in the SAME
 * transaction. The notification is durable even if the user is offline or the socket push fails;
 * the bell icon reads from MySQL on page load.
 */
export async function notify(trx: Kysely<Database>, n: NewNotification, occurredAt: Date) {
  const res = await trx
    .insertInto('notifications')
    .values({ user_id: n.userId, type: n.type, title: n.title, message: n.message, auction_id: n.auctionId ?? null, created_at: occurredAt })
    .executeTakeFirstOrThrow();
  const id = Number(res.insertId);
  await enqueueEvent(trx, {
    type: 'notification:new',
    auctionId: n.auctionId ?? null,
    userId: n.userId,
    version: null,
    occurredAt,
    data: {
      id,
      type: n.type,
      title: n.title,
      message: n.message,
      auctionId: n.auctionId ?? null,
      isRead: false,
      createdAt: occurredAt.toISOString(),
    },
  });
  return id;
}

export async function notifyMany(trx: Kysely<Database>, userIds: Iterable<number>, n: Omit<NewNotification, 'userId'>, occurredAt: Date) {
  for (const userId of new Set(userIds)) await notify(trx, { ...n, userId }, occurredAt);
}

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 });
export const formatInr = (amount: string) => inr.format(Number(amount));
