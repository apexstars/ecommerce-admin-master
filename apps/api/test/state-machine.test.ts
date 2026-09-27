import { describe, expect, it } from 'vitest';
import {
  buildTimeline,
  cancelDecision,
  fulfillmentDecision,
  fulfillmentTimestamps,
  nextFulfillment,
  refundDecision,
} from '../src/modules/orders/state-machine.js';

const o = (status: any, fulfillmentStatus: any = 'unfulfilled') => ({ status, fulfillmentStatus });

describe('order state machine', () => {
  it('cancels pending orders without a refund', () => {
    expect(cancelDecision(o('pending'))).toEqual({ ok: true, requiresRefund: false });
  });

  it('cancels paid-but-unshipped orders with a refund', () => {
    expect(cancelDecision(o('paid', 'preparing'))).toEqual({ ok: true, requiresRefund: true });
  });

  it('refuses to cancel shipped or terminal orders', () => {
    expect(cancelDecision(o('paid', 'shipped')).ok).toBe(false);
    expect(cancelDecision(o('refunded')).ok).toBe(false);
    expect(cancelDecision(o('cancelled')).ok).toBe(false);
  });

  it('refunds only paid orders, restocking only unshipped goods', () => {
    expect(refundDecision(o('paid', 'unfulfilled'))).toEqual({ ok: true, restock: true });
    expect(refundDecision(o('paid', 'delivered'))).toEqual({ ok: true, restock: false });
    expect(refundDecision(o('pending')).ok).toBe(false);
  });

  it('moves fulfillment forward only, and only once paid', () => {
    expect(fulfillmentDecision(o('paid'), 'shipped').ok).toBe(true);
    expect(fulfillmentDecision(o('paid', 'shipped'), 'preparing').ok).toBe(false);
    expect(fulfillmentDecision(o('paid', 'shipped'), 'shipped').ok).toBe(false);
    expect(fulfillmentDecision(o('pending'), 'preparing').ok).toBe(false);
    expect(nextFulfillment(o('paid', 'preparing'))).toBe('shipped');
    expect(nextFulfillment(o('paid', 'delivered'))).toBeNull();
    expect(nextFulfillment(o('pending'))).toBeNull();
  });

  it('stamps skipped fulfillment steps', () => {
    const now = new Date('2026-01-01T00:00:00Z');
    expect(fulfillmentTimestamps('unfulfilled', 'shipped', now)).toEqual({ preparingAt: now, shippedAt: now });
  });

  it('builds a timeline with the next step marked current', () => {
    const t = buildTimeline({
      ...o('paid', 'preparing'),
      placedAt: new Date(),
      paidAt: new Date(),
      preparingAt: new Date(),
      shippedAt: null,
      deliveredAt: null,
    });
    expect(t.map((s) => s.state)).toEqual(['done', 'done', 'done', 'current', 'upcoming']);
  });

  it('marks unreached steps as skipped once an order is cancelled', () => {
    const t = buildTimeline({ ...o('cancelled'), placedAt: new Date(), paidAt: null, preparingAt: null, shippedAt: null, deliveredAt: null });
    expect(t.map((s) => s.state)).toEqual(['done', 'skipped', 'skipped', 'skipped', 'skipped']);
  });
});
