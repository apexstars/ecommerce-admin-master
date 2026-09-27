/**
 * Event contracts between modules. Payloads carry ids only; handlers re-read
 * current state so a delayed/retried event never acts on stale data.
 *
 * Checkout saga:
 *   order.placed ─▶ [inventory] reserve ─▶ inventory.reserved ─▶ [payments] charge
 *        │                         └─▶ inventory.reservation_failed ─▶ [orders] cancel
 *        │
 *   payment.succeeded ─▶ [orders] mark paid ─▶ order.paid ─▶ [inventory] commit reservations
 *                                                     └──▶ [orders] send confirmation
 *   payment.failed ─▶ [orders] cancel ─▶ order.cancelled ─▶ [inventory] release stock
 */
export interface EventMap {
  'order.placed': { orderId: string };
  'inventory.reserved': { orderId: string };
  'inventory.reservation_failed': { orderId: string; reason: string };
  'payment.succeeded': { orderId: string; paymentId: string };
  'payment.failed': { orderId: string; paymentId: string; reason: string };
  /** A charge landed for an order that is no longer payable (e.g. cancelled mid-flight). */
  'payment.compensation_required': { orderId: string; reason: string };
  'order.paid': { orderId: string };
  'order.cancelled': { orderId: string; reason: string };
  'order.refunded': { orderId: string; restock: boolean };
}

export type Topic = keyof EventMap;
