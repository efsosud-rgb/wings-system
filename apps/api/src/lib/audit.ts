import type { Database } from '../db/client.js';
import { auditLog } from '../db/schema/index.js';

export interface AuditEntry {
  actorEmployeeId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  targetEmployeeId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  /**
   * Context only — never personal data. Field names, counts and reasons are
   * fine; CPF, full names, e-mails and phone numbers are not (LGPD).
   */
  metadata?: Record<string, unknown>;
}

export async function writeAudit(db: Database, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actorEmployeeId: entry.actorEmployeeId ?? null,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId ?? null,
    targetEmployeeId: entry.targetEmployeeId ?? null,
    ip: entry.ip ?? null,
    userAgent: entry.userAgent ?? null,
    metadata: entry.metadata ?? {},
  });
}
