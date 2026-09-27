import { describe, expect, it } from 'vitest';
import { computeDiscountCents, discountProblem } from '../src/modules/discounts/index.js';
import { computeTotals } from '../src/modules/orders/pricing.js';

const rules = { taxRateBps: 800, flatShippingCents: 800, freeShippingOverCents: 10_000 };

describe('computeTotals', () => {
  it('charges flat shipping below the free-shipping threshold and taxes the goods', () => {
    expect(computeTotals(5000, 0, rules)).toEqual({ subtotalCents: 5000, discountCents: 0, shippingCents: 800, taxCents: 400, totalCents: 6200 });
  });

  it('applies the threshold and tax after the discount', () => {
    const t = computeTotals(10_500, 1050, rules);
    expect(t.shippingCents).toBe(800); // 9450 after discount → below threshold
    expect(t.taxCents).toBe(756);
    expect(t.totalCents).toBe(9450 + 800 + 756);
  });

  it('never lets a discount exceed the subtotal', () => {
    const t = computeTotals(1000, 5000, rules);
    expect(t.discountCents).toBe(1000);
    expect(t.totalCents).toBe(0);
  });
});

describe('discounts', () => {
  const base = { id: 'd', code: 'X', startsAt: new Date(Date.now() - 1000), endsAt: null, usageLimit: null, timesUsed: 0, createdAt: new Date(), updatedAt: new Date() };

  it('computes percent and fixed amounts, capped at the subtotal', () => {
    expect(computeDiscountCents({ type: 'percent', value: 25 }, 4000)).toBe(1000);
    expect(computeDiscountCents({ type: 'fixed', value: 5000 }, 4000)).toBe(4000);
  });

  it('rejects codes that are not yet active, expired or used up', () => {
    expect(discountProblem({ ...base, type: 'percent', value: 10 })).toBeNull();
    expect(discountProblem({ ...base, type: 'percent', value: 10, startsAt: new Date(Date.now() + 60_000) })).toMatch(/not active/);
    expect(discountProblem({ ...base, type: 'percent', value: 10, endsAt: new Date(Date.now() - 1) })).toMatch(/expired/);
    expect(discountProblem({ ...base, type: 'fixed', value: 100, usageLimit: 3, timesUsed: 3 })).toMatch(/fully redeemed/);
  });
});
