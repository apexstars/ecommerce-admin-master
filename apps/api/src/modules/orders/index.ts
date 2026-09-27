import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { subscribe } from '../../shared/events/outbox.js';
import { IdParams, PageQuery, parse } from '../../shared/http.js';
import { adminOf, requireCustomer } from '../identity/index.js';
import { getCustomerOrder, placeOrder } from './checkout.service.js';
import * as orders from './orders.service.js';

export { getOrderLines, lockOrderStatus, recentOrders, salesBetween } from './orders.service.js';

export function registerOrderHandlers() {
  subscribe('inventory.reservation_failed', 'orders.cancel_out_of_stock', (e) =>
    orders.cancelBySystem(e.orderId, 'Out of stock'),
  );
  subscribe('payment.failed', 'orders.cancel_payment_failed', (e) =>
    orders.cancelBySystem(e.orderId, `Payment failed (${e.reason})`),
  );
  subscribe('payment.succeeded', 'orders.mark_paid', (e) => orders.markPaid(e.orderId));
  subscribe('order.paid', 'orders.send_confirmation', (e) => orders.sendConfirmation(e.orderId));
}

const Reason = z.object({ reason: z.string().trim().min(1, 'Please give a reason').max(500) });

export async function ordersAdminRoutes(app: FastifyInstance) {
  app.get('/orders', { config: { permission: 'orders:view' } }, async (req) =>
    orders.listOrders(
      parse(
        PageQuery.extend({
          filter: z.enum(orders.ORDER_FILTERS).default('all'),
          search: z.string().trim().optional(),
          customerId: z.string().uuid().optional(),
        }),
        req.query,
      ),
    ),
  );

  // Order history per customer, for the customer screens. Gated on orders:view so a
  // customers-only role sees contact details but not purchase history.
  app.get('/orders/customer-stats', { config: { permission: 'orders:view' } }, async (req) => {
    const { customerIds } = parse(
      z.object({
        customerIds: z
          .string()
          .transform((v) => v.split(',').filter(Boolean))
          .pipe(z.array(z.string().uuid()).min(1).max(100)),
      }),
      req.query,
    );
    return orders.customerOrderStats(customerIds);
  });

  app.get('/orders/:id', { config: { permission: 'orders:view' } }, async (req) => orders.getOrder(parse(IdParams, req.params).id));

  app.post('/orders/:id/fulfillment', { config: { permission: 'orders:edit' } }, async (req) => {
    const { status } = parse(z.object({ status: z.enum(['preparing', 'shipped', 'delivered']) }), req.body);
    return orders.advanceFulfillment(adminOf(req), parse(IdParams, req.params).id, status);
  });

  // Cancelling a *paid* order also refunds it; the service additionally checks orders:refund then.
  app.post('/orders/:id/cancel', { config: { permission: 'orders:edit' } }, async (req) =>
    orders.cancelOrder(adminOf(req), parse(IdParams, req.params).id, parse(Reason, req.body).reason),
  );

  app.post('/orders/:id/refund', { config: { permission: 'orders:refund' } }, async (req) =>
    orders.refundOrder(adminOf(req), parse(IdParams, req.params).id, parse(Reason, req.body).reason),
  );
}

export async function ordersStoreRoutes(app: FastifyInstance) {
  const Address = z.object({
    name: z.string().trim().min(1).max(100),
    line1: z.string().trim().min(1).max(200),
    line2: z.string().trim().max(200).nullish(),
    city: z.string().trim().min(1).max(100),
    region: z.string().trim().min(1).max(100),
    postalCode: z.string().trim().min(1).max(20),
    country: z.string().trim().length(2),
  });

  app.post('/checkout', async (req, reply) => {
    const customer = await requireCustomer(req);
    const body = parse(
      z
        .object({
          addressId: z.string().uuid().optional(),
          address: Address.optional(),
          discountCode: z.string().trim().min(1).optional(),
          paymentMethodToken: z.string().min(3).max(255),
        })
        .refine((b) => b.addressId || b.address, 'addressId or address is required'),
      req.body,
    );
    const idempotencyKey = req.headers['idempotency-key'];
    const order = await placeOrder(customer, {
      ...body,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey.slice(0, 100) : undefined,
    });
    // 202: accepted — the saga finishes asynchronously; poll GET /orders/:id.
    return reply.code(202).send(order);
  });

  app.get('/orders/:id', async (req) => {
    const customer = await requireCustomer(req);
    return getCustomerOrder(customer.customerId, parse(IdParams, req.params).id);
  });

  app.get('/orders', async (req) => {
    const customer = await requireCustomer(req);
    const q = parse(PageQuery, req.query);
    return orders.listOrders({ filter: 'all', customerId: customer.customerId, ...q });
  });
}
