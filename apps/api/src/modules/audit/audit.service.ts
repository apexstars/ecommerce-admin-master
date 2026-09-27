import type { Prisma } from '@prisma/client';
import { prisma, type Db } from '../../shared/db.js';
import type { Page } from '../../shared/http.js';

export interface AuditRecord {
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

const json = (v: unknown) => (v === undefined ? undefined : (v as Prisma.InputJsonValue));

/**
 * Pass the transaction client of the change being audited so the log entry
 * commits (or rolls back) atomically with it.
 */
export async function recordAudit(db: Db, entry: AuditRecord) {
  await db.auditLogEntry.create({
    data: {
      actorUserId: entry.actorUserId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      before: json(entry.before),
      after: json(entry.after),
      metadata: json(entry.metadata),
    },
  });
}

export async function listAudit(filter: {
  resourceType?: string;
  resourceId?: string;
  actorUserId?: string;
  page: number;
  pageSize: number;
}): Promise<Page<unknown>> {
  const where: Prisma.AuditLogEntryWhereInput = {
    resourceType: filter.resourceType,
    resourceId: filter.resourceId,
    actorUserId: filter.actorUserId,
  };
  const [items, total] = await Promise.all([
    prisma.auditLogEntry.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      skip: (filter.page - 1) * filter.pageSize,
      take: filter.pageSize,
      include: { actor: { select: { id: true, name: true, email: true } } },
    }),
    prisma.auditLogEntry.count({ where }),
  ]);
  return { items, total, page: filter.page, pageSize: filter.pageSize };
}
