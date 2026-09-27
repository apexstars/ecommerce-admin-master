/**
 * Order lifecycle rules, kept pure so they're trivially testable and shared by
 * the API (enforcement) and the order-detail response (which actions to offer).
 *
 * Payment status:     pending ─▶ paid ─▶ refunded
 *                        │         │
 *                        └────────▶┴─▶ cancelled   (paid→cancelled only before shipping, with refund)
 *
 * Fulfillment (only once paid): unfulfilled ─▶ preparing ─▶ shipped ─▶ delivered
 */

export type OrderStatus = 'pending' | 'paid' | 'refunded' | 'cancelled';
export type FulfillmentStatus = 'unfulfilled' | 'preparing' | 'shipped' | 'delivered';

export const FULFILLMENT_ORDER: FulfillmentStatus[] = ['unfulfilled', 'preparing', 'shipped', 'delivered'];

interface OrderState {
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
}

const notShipped = (o: OrderState) => o.fulfillmentStatus === 'unfulfilled' || o.fulfillmentStatus === 'preparing';

export type Decision = { ok: true } | { ok: false; reason: string };

export function cancelDecision(o: OrderState): Decision & { requiresRefund: boolean } {
  if (o.status === 'pending') return { ok: true, requiresRefund: false };
  if (o.status === 'paid' && notShipped(o)) return { ok: true, requiresRefund: true };
  if (o.status === 'paid') return { ok: false, reason: 'Shipped orders can be refunded but not cancelled', requiresRefund: false };
  return { ok: false, reason: `A ${o.status} order can't be cancelled`, requiresRefund: false };
}

export function refundDecision(o: OrderState): Decision & { restock: boolean } {
  if (o.status !== 'paid') return { ok: false, reason: `Only paid orders can be refunded (this one is ${o.status})`, restock: false };
  return { ok: true, restock: notShipped(o) };
}

/** Fulfillment may move forward (skipping steps is allowed), never backward. */
export function fulfillmentDecision(o: OrderState, to: FulfillmentStatus): Decision {
  if (o.status !== 'paid') return { ok: false, reason: 'Only paid orders can be fulfilled' };
  if (FULFILLMENT_ORDER.indexOf(to) <= FULFILLMENT_ORDER.indexOf(o.fulfillmentStatus)) {
    return { ok: false, reason: `Order is already ${o.fulfillmentStatus}` };
  }
  return { ok: true };
}

export function nextFulfillment(o: OrderState): FulfillmentStatus | null {
  if (o.status !== 'paid') return null;
  return FULFILLMENT_ORDER[FULFILLMENT_ORDER.indexOf(o.fulfillmentStatus) + 1] ?? null;
}

/** Timestamp columns to fill when moving to `to` (including any skipped steps). */
export function fulfillmentTimestamps(from: FulfillmentStatus, to: FulfillmentStatus, now = new Date()) {
  const columns = { preparing: 'preparingAt', shipped: 'shippedAt', delivered: 'deliveredAt' } as const;
  const out: Partial<Record<(typeof columns)[keyof typeof columns], Date>> = {};
  for (const step of FULFILLMENT_ORDER.slice(FULFILLMENT_ORDER.indexOf(from) + 1, FULFILLMENT_ORDER.indexOf(to) + 1)) {
    if (step !== 'unfulfilled') out[columns[step]] = now;
  }
  return out;
}

export interface TimelineStep {
  key: 'placed' | 'paid' | 'preparing' | 'shipped' | 'delivered';
  label: string;
  at: Date | null;
  state: 'done' | 'current' | 'upcoming' | 'skipped';
}

export function buildTimeline(o: OrderState & {
  placedAt: Date;
  paidAt: Date | null;
  preparingAt: Date | null;
  shippedAt: Date | null;
  deliveredAt: Date | null;
}): TimelineStep[] {
  const steps: Omit<TimelineStep, 'state'>[] = [
    { key: 'placed', label: 'Order placed', at: o.placedAt },
    { key: 'paid', label: 'Payment confirmed', at: o.paidAt },
    { key: 'preparing', label: 'Preparing', at: o.preparingAt },
    { key: 'shipped', label: 'Shipped', at: o.shippedAt },
    { key: 'delivered', label: 'Delivered', at: o.deliveredAt },
  ];
  const terminated = o.status === 'cancelled' || o.status === 'refunded';
  const firstOpen = steps.findIndex((s) => !s.at);
  return steps.map((s, i) => ({
    ...s,
    state: s.at ? 'done' : terminated ? 'skipped' : i === firstOpen ? 'current' : 'upcoming',
  }));
}
