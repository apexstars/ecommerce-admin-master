import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PageQuery, parse } from '../../shared/http.js';
import { listAudit } from './audit.service.js';

export { recordAudit, type AuditRecord } from './audit.service.js';

export async function auditAdminRoutes(app: FastifyInstance) {
  const Query = PageQuery.extend({
    resourceType: z.string().optional(),
    resourceId: z.string().optional(),
    actorUserId: z.string().uuid().optional(),
  });

  app.get('/audit', { config: { permission: 'settings:view' } }, async (req) => listAudit(parse(Query, req.query)));
}
