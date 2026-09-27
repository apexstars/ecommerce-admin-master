export interface PricingRules {
  taxRateBps: number;
  flatShippingCents: number;
  freeShippingOverCents: number;
}

/** All money is integer cents; tax is applied to the discounted subtotal. */
export function computeTotals(subtotalCents: number, discountCents: number, rules: PricingRules) {
  const discounted = Math.max(0, subtotalCents - discountCents);
  const shippingCents = discounted >= rules.freeShippingOverCents || discounted === 0 ? 0 : rules.flatShippingCents;
  const taxCents = Math.round((discounted * rules.taxRateBps) / 10_000);
  return {
    subtotalCents,
    discountCents: subtotalCents - discounted,
    shippingCents,
    taxCents,
    totalCents: discounted + shippingCents + taxCents,
  };
}
