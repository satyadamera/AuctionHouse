import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database } from '../database/types.js';
import type { ServerEventType } from '../shared/events.js';

export interface OutboxInput {
  type: ServerEventType;
  auctionId: number | null;
  userId?: number | null;
  version: number | null;
  occurredAt: Date;
  data: unknown;
}

/**
 * Records an event in the outbox. MUST be called with the same transaction that performs the state
 * change: the event then exists if and only if the change committed. The dispatcher publishes it
 * afterwards. Returns the event id (useful for tests and logs).
 */
export async function enqueueEvent(trx: Kysely<Database>, e: OutboxInput): Promise<string> {
  const eventId = randomUUID();
  const envelope = {
    eventId,
    type: e.type,
    auctionId: e.auctionId,
    version: e.version,
    occurredAt: e.occurredAt.toISOString(),
    data: e.data,
  };
  await trx
    .insertInto('outbox_events')
    .values({
      event_id: eventId,
      type: e.type,
      auction_id: e.auctionId,
      user_id: e.userId ?? null,
      version: e.version,
      payload: JSON.stringify(envelope),
    })
    .execute();
  return eventId;
}
