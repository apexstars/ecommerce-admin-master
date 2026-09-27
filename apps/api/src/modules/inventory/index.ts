import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { subscribe } from '../../shared/events/outbox.js';
import { parse } from '../../shared/http.js';
import { adminOf } from '../identity/index.js';
import { getOrderLines } from '../orders/index.js';
import * as inventory from './inventory.service.js';

export { listLowStock } from './inventory.service.js';

export function registerInventoryHandlers() {
  subscribe('order.placed', 'inventory.reserve', async (e) =>
    inventory.reserveForOrder(e.orderId, await getOrderLines(e.orderId)),
  );
  subscribe('order.paid', 'inventory.commit', (e) => inventory.commitForOrder(e.orderId));
  subscribe('order.cancelled', 'inventory.release', (e) =>
    inventory.releaseForOrder(e.orderId, { includeCommitted: true }),
  );
  subscribe('order.refunded', 'inventory.restock', async (e) => {
    if (e.restock) await inventory.releaseForOrder(e.orderId, { includeCommitted: true });
  });
}

export async function inventoryAdminRoutes(app: FastifyInstance) {
  app.get('/inventory/low-stock', { config: { permission: 'inventory:view' } }, async (req) => {
    const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
    return inventory.listLowStock(limit);
  });

  app.get('/inventory/variants/:variantId/movements', { config: { permission: 'inventory:view' } }, async (req) =>
    inventory.listMovements(parse(z.object({ variantId: z.string().uuid() }), req.params).variantId),
  );

  app.post('/inventory/variants/:variantId/adjust', { config: { permission: 'inventory:edit' } }, async (req) => {
    const { variantId } = parse(z.object({ variantId: z.string().uuid() }), req.params);
    const body = parse(
      z.object({ delta: z.number().int().refine((n) => n !== 0, 'Delta cannot be zero'), note: z.string().max(200).optional() }),
      req.body,
    );
    return inventory.adjustStock(adminOf(req).userId, variantId, body.delta, body.note);
  });
}
