import type { Kysely } from 'kysely';
import type { Database } from '../database/types.js';

export interface AuditEntry {
  actorId: number | null;
  action: string;
  entityType: 'user' | 'auction' | 'bid' | 'system';
  entityId?: number | null;
  metadata?: Record<string, unknown>;
}

/**
 * Appends an audit record. Accepts a transaction so the audit row commits or rolls back together
 * with the action it describes (no "audit says cancelled but auction is still active").
 */
export async function recordAudit(db: Kysely<Database>, e: AuditEntry) {
  await db
    .insertInto('audit_logs')
    .values({
      actor_id: e.actorId,
      action: e.action,
      entity_type: e.entityType,
      entity_id: e.entityId ?? null,
      metadata: e.metadata ? JSON.stringify(e.metadata) : null,
    })
    .execute();
}
