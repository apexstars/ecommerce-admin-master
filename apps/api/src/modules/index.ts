import type { FastifyInstance } from 'fastify';
import { auditAdminRoutes } from './audit/index.js';
import { cartStoreRoutes } from './cart/index.js';
import { catalogAdminRoutes, catalogStoreRoutes } from './catalog/index.js';
import { discountsAdminRoutes } from './discounts/index.js';
import {
  adminAuthRoutes,
  customerAuthRoutes,
  customersAdminRoutes,
  installAdminGuard,
  rolesAdminRoutes,
} from './identity/index.js';
import { inventoryAdminRoutes, registerInventoryHandlers } from './inventory/index.js';
import { ordersAdminRoutes, ordersStoreRoutes, registerOrderHandlers } from './orders/index.js';
import { paymentWebhookRoutes, registerPaymentHandlers } from './payments/index.js';
import { reportsAdminRoutes } from './reports/index.js';

let handlersRegistered = false;

/** Must run in every process that publishes OR consumes events (API and worker). */
export function registerEventHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;
  registerInventoryHandlers();
  registerPaymentHandlers();
  registerOrderHandlers();
}

export async function registerRoutes(app: FastifyInstance) {
  // Admin scope: every route inside is RBAC-guarded (see installAdminGuard).
  await app.register(
    async (admin) => {
      installAdminGuard(admin);
      await admin.register(adminAuthRoutes);
      await admin.register(rolesAdminRoutes);
      await admin.register(customersAdminRoutes);
      await admin.register(auditAdminRoutes);
      await admin.register(catalogAdminRoutes);
      await admin.register(inventoryAdminRoutes);
      await admin.register(ordersAdminRoutes);
      await admin.register(discountsAdminRoutes);
      await admin.register(reportsAdminRoutes);
    },
    { prefix: '/api/admin' },
  );

  // Storefront scope: customer tokens only; admin tokens are rejected (different secret + audience).
  await app.register(
    async (store) => {
      await store.register(customerAuthRoutes);
      await store.register(catalogStoreRoutes);
      await store.register(cartStoreRoutes);
      await store.register(ordersStoreRoutes);
    },
    { prefix: '/api/store' },
  );

  await app.register(paymentWebhookRoutes, { prefix: '/api/webhooks' });
}
