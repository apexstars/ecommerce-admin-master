import type { FulfillmentStatus, Order, Prisma } from '@prisma/client';
import { prisma, type Tx } from '../../shared/db.js';
import { conflict, notFound } from '../../shared/errors.js';
import { publish } from '../../shared/events/outbox.js';
import { mailer } from '../../shared/mailer.js';
import { recordAudit } from '../audit/index.js';
import { type AdminPrincipal, assertCan, getCustomerSummaries, searchCustomerIds } from '../identity/index.js';
import { getPaymentsForOrders, refundForOrder, voidPendingPayment } from '../payments/index.js';
import {
  buildTimeline,
  cancelDecision,
  fulfillmentDecision,
  fulfillmentTimestamps,
  nextFulfillment,
  refundDecision,
} from './state-machine.js';

// ── Queries ──────────────────────────────────────────────────────────────────

export const ORDER_FILTERS = ['all', 'pending', 'paid', 'fulfilled', 'refunded', 'cancelled'] as const;
export type OrderFilter = (typeof ORDER_FILTERS)[number];

/**
 * List-screen buckets: "paid" = paid and awaiting fulfillment,
 * "fulfilled" = paid and shipped/delivered.
 */
function filterWhere(filter: OrderFilter): Prisma.OrderWhereInput {
  switch (filter) {
    case 'all':
      return {};
    case 'paid':
      return { status: 'paid', fulfillmentStatus: { in: ['unfulfilled', 'preparing'] } };
    case 'fulfilled':
      return { status: 'paid', fulfillmentStatus: { in: ['shipped', 'delivered'] } };
    default:
      return { status: filter };
  }
}

async function searchWhere(search?: string): Promise<Prisma.OrderWhereInput> {
  if (!search) return {};
  const asNumber = search.replace(/^#/, '');
  if (/^\d+$/.test(asNumber)) return { number: Number(asNumber) };
  return { customerId: { in: await searchCustomerIds(search) } };
}

export async function listOrders(q: { filter: OrderFilter; search?: string; customerId?: string; page: number; pageSize: number }) {
  const base: Prisma.OrderWhereInput = { ...(await searchWhere(q.search)), ...(q.customerId && { customerId: q.customerId }) };
  const where = { ...base, ...filterWhere(q.filter) };

  const [orders, total, groups] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { placedAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      include: { items: { select: { qty: true } } },
    }),
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ['status', 'fulfillmentStatus'], where: base, _count: { _all: true } }),
  ]);

  const counts = Object.fromEntries(ORDER_FILTERS.map((f) => [f, 0])) as Record<OrderFilter, number>;
  for (const g of groups) {
    const n = g._count._all;
    counts.all += n;
    if (g.status === 'paid') counts[g.fulfillmentStatus === 'shipped' || g.fulfillmentStatus === 'delivered' ? 'fulfilled' : 'paid'] += n;
    else counts[g.status] += n;
  }

  const customers = await getCustomerSummaries(orders.map((o) => o.customerId));
  return {
    items: orders.map((o) => ({
      id: o.id,
      number: o.number,
      customer: customers.get(o.customerId) ?? null,
      placedAt: o.placedAt,
      itemCount: o.items.reduce((n, i) => n + i.qty, 0),
      status: o.status,
      fulfillmentStatus: o.fulfillmentStatus,
      totalCents: o.totalCents,
      currency: o.currency,
    })),
    total,
    page: q.page,
    pageSize: q.pageSize,
    counts,
  };
}

export async function getOrder(id: string) {
  const order = await prisma.order.findUnique({ where: { id }, include: { items: true } });
  if (!order) throw notFound('Order');
  const [customers, payments] = await Promise.all([getCustomerSummaries([order.customerId]), getPaymentsForOrders([id])]);
  const cancel = cancelDecision(order);
  const refund = refundDecision(order);
  const { checkoutKey: _omit, ...rest } = order;
  return {
    ...rest,
    customer: customers.get(order.customerId) ?? null,
    payment: payments.get(id) ?? null,
    timeline: buildTimeline(order),
    actions: {
      nextFulfillment: nextFulfillment(order),
      canCancel: cancel.ok,
      cancelRequiresRefund: cancel.requiresRefund,
      canRefund: refund.ok,
    },
  };
}

// ── Admin actions ────────────────────────────────────────────────────────────

const snapshot = (o: Pick<Order, 'status' | 'fulfillmentStatus'>) => ({ status: o.status, fulfillmentStatus: o.fulfillmentStatus });

async function loadForUpdate(id: string) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw notFound('Order');
  return order;
}

export async function advanceFulfillment(actor: AdminPrincipal, id: string, to: FulfillmentStatus) {
  const order = await loadForUpdate(id);
  const decision = fulfillmentDecision(order, to);
  if (!decision.ok) throw conflict(decision.reason);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id, status: 'paid', fulfillmentStatus: order.fulfillmentStatus },
      data: { fulfillmentStatus: to, ...fulfillmentTimestamps(order.fulfillmentStatus, to) },
    });
    if (!count) throw conflict('This order was just updated by someone else. Reload and try again.');
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.fulfillment_updated',
      resourceType: 'order',
      resourceId: id,
      before: snapshot(order),
      after: { status: order.status, fulfillmentStatus: to },
    });
  });
  return getOrder(id);
}

export async function cancelOrder(actor: AdminPrincipal, id: string, reason: string) {
  const order = await loadForUpdate(id);
  const decision = cancelDecision(order);
  if (!decision.ok) throw conflict(decision.reason);

  if (decision.requiresRefund) {
    // Cancelling a paid order gives the money back, so it needs refund rights too.
    assertCan(actor, 'orders:refund');
    await refundForOrder(id); // idempotent; safe if the transaction below has to be retried
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id, status: order.status, fulfillmentStatus: order.fulfillmentStatus },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason, ...(decision.requiresRefund && { refundedAt: new Date() }) },
    });
    if (!count) throw conflict('This order was just updated by someone else. Reload and try again.');
    if (order.status === 'pending') await voidPendingPayment(tx, id);
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.cancelled',
      resourceType: 'order',
      resourceId: id,
      before: snapshot(order),
      after: { status: 'cancelled', fulfillmentStatus: order.fulfillmentStatus },
      metadata: { reason, refunded: decision.requiresRefund, totalCents: order.totalCents },
    });
    await publish(tx, 'order.cancelled', { orderId: id, reason });
  });
  return getOrder(id);
}

export async function refundOrder(actor: AdminPrincipal, id: string, reason: string) {
  const order = await loadForUpdate(id);
  const decision = refundDecision(order);
  if (!decision.ok) throw conflict(decision.reason);

  const payment = await refundForOrder(id);

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id, status: 'paid' },
      data: { status: 'refunded', refundedAt: new Date() },
    });
    if (!count) throw conflict('This order was just updated by someone else. Reload and try again.');
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'order.refunded',
      resourceType: 'order',
      resourceId: id,
      before: snapshot(order),
      after: { status: 'refunded', fulfillmentStatus: order.fulfillmentStatus },
      metadata: { reason, amountCents: payment.refundedCents, restocked: decision.restock },
    });
    await publish(tx, 'order.refunded', { orderId: id, restock: decision.restock });
  });
  return getOrder(id);
}

// ── Saga steps (called by outbox handlers; all idempotent) ───────────────────

export async function markPaid(orderId: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({ where: { id: orderId, status: 'pending' }, data: { status: 'paid', paidAt: new Date() } });
    if (count) return publish(tx, 'order.paid', { orderId });
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { status: true } });
    // Money arrived for an order that was cancelled in the meantime → give it back.
    if (order?.status === 'cancelled') {
      await publish(tx, 'payment.compensation_required', { orderId, reason: 'order_cancelled_before_payment' });
    }
  });
}

export async function cancelBySystem(orderId: string, reason: string) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: { id: orderId, status: 'pending' },
      data: { status: 'cancelled', cancelledAt: new Date(), cancelReason: reason },
    });
    if (!count) return;
    await voidPendingPayment(tx, orderId);
    await recordAudit(tx, {
      actorUserId: null,
      action: 'order.cancelled',
      resourceType: 'order',
      resourceId: orderId,
      before: { status: 'pending' },
      after: { status: 'cancelled' },
      metadata: { reason, automatic: true },
    });
    await publish(tx, 'order.cancelled', { orderId, reason });
  });
}

export async function sendConfirmation(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || order.confirmationSentAt) return;
  const customer = (await getCustomerSummaries([order.customerId])).get(order.customerId);
  if (customer) {
    const lines = order.items.map((i) => `  ${i.qty} × ${i.productName} (${i.variantLabel})`).join('\n');
    await mailer.send({
      to: customer.email,
      subject: `Order #${order.number} confirmed`,
      text: `Thanks ${customer.name}! We've received your payment.\n\n${lines}\n\nTotal: ${(order.totalCents / 100).toFixed(2)} ${order.currency.toUpperCase()}`,
    });
  }
  await prisma.order.update({ where: { id: orderId }, data: { confirmationSentAt: new Date() } });
}

// ── Public API for other modules ─────────────────────────────────────────────

export async function getOrderLines(orderId: string) {
  return prisma.orderItem.findMany({ where: { orderId }, select: { variantId: true, qty: true } });
}

/** Share-locks the order row for the rest of `tx`, blocking concurrent status changes. */
export async function lockOrderStatus(tx: Tx, orderId: string) {
  const rows = await tx.$queryRaw<{ status: string }[]>`
    SELECT status::text AS status FROM "Order" WHERE id = ${orderId} FOR SHARE`;
  return rows[0]?.status ?? null;
}

/** Revenue metrics count paid orders only (refunded/cancelled/pending excluded). */
export async function salesBetween(from: Date, to: Date) {
  const agg = await prisma.order.aggregate({
    where: { status: 'paid', placedAt: { gte: from, lt: to } },
    _sum: { totalCents: true },
    _count: { _all: true },
  });
  const revenueCents = agg._sum.totalCents ?? 0;
  const orders = agg._count._all;
  return { revenueCents, orders, aovCents: orders ? Math.round(revenueCents / orders) : 0 };
}

export interface CustomerOrderStats {
  orderCount: number;
  paidOrderCount: number;
  /** Paid orders only — refunded, cancelled and pending orders don't count as spend. */
  totalSpentCents: number;
  lastOrderAt: Date | null;
}

export async function customerOrderStats(customerIds: string[]): Promise<Record<string, CustomerOrderStats>> {
  const ids = [...new Set(customerIds)];
  const [all, paid] = await Promise.all([
    prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: ids } }, _count: { _all: true }, _max: { placedAt: true } }),
    prisma.order.groupBy({ by: ['customerId'], where: { customerId: { in: ids }, status: 'paid' }, _count: { _all: true }, _sum: { totalCents: true } }),
  ]);
  const allBy = new Map(all.map((r) => [r.customerId, r]));
  const paidBy = new Map(paid.map((r) => [r.customerId, r]));
  return Object.fromEntries(
    ids.map((id) => [
      id,
      {
        orderCount: allBy.get(id)?._count._all ?? 0,
        paidOrderCount: paidBy.get(id)?._count._all ?? 0,
        totalSpentCents: paidBy.get(id)?._sum.totalCents ?? 0,
        lastOrderAt: allBy.get(id)?._max.placedAt ?? null,
      },
    ]),
  );
}

export async function recentOrders(limit: number) {
  return (await listOrders({ filter: 'all', page: 1, pageSize: limit })).items;
}
