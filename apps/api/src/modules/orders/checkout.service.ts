import type { Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { prisma } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { publish } from '../../shared/events/outbox.js';
import { clearCart, getCartLines } from '../cart/index.js';
import { getVariants } from '../catalog/index.js';
import { evaluateDiscount, redeemDiscount } from '../discounts/index.js';
import { type CustomerPrincipal, getAddress } from '../identity/index.js';
import { createPendingPayment } from '../payments/index.js';
import { computeTotals } from './pricing.js';

export interface ShippingAddress {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}

export interface CheckoutInput {
  addressId?: string;
  address?: ShippingAddress;
  discountCode?: string;
  /** Provider token from the browser (e.g. Stripe `pm_...`). Never raw card data. */
  paymentMethodToken: string;
  idempotencyKey?: string;
}

/**
 * Checkout does exactly one synchronous thing: atomically record the order,
 * its pending payment and an `order.placed` event. Reservation, charging and
 * confirmation happen asynchronously via the outbox (see shared/events/topics.ts).
 * The client polls the order status.
 */
export async function placeOrder(customer: CustomerPrincipal, input: CheckoutInput) {
  const checkoutKey = input.idempotencyKey ? `${customer.customerId}:${input.idempotencyKey}` : undefined;
  if (checkoutKey) {
    const existing = await prisma.order.findUnique({ where: { checkoutKey } });
    if (existing) return summary(existing);
  }

  const lines = await getCartLines(`c:${customer.customerId}`);
  if (!lines.length) throw badRequest('Your cart is empty');

  const variants = await getVariants(lines.map((l) => l.variantId));
  const items = lines.map((l) => {
    const v = variants.get(l.variantId);
    if (!v || !v.isActive) throw badRequest('An item in your cart is no longer available');
    // Early, friendly check only — the authoritative check is the atomic reservation.
    if (v.stockQty < l.qty) throw conflict(`Only ${v.stockQty} left of ${v.productName} (${v.label})`);
    return {
      variantId: v.variantId,
      productName: v.productName,
      variantLabel: v.label,
      sku: v.sku,
      imageUrl: v.imageUrl,
      qty: l.qty,
      unitPriceCents: v.priceCents, // server-side price, never the client's
    };
  });

  const subtotalCents = items.reduce((n, i) => n + i.unitPriceCents * i.qty, 0);
  const discount = input.discountCode ? await evaluateDiscount(input.discountCode, subtotalCents) : null;
  const totals = computeTotals(subtotalCents, discount?.discountCents ?? 0, {
    taxRateBps: config.TAX_RATE_BPS,
    flatShippingCents: config.FLAT_SHIPPING_CENTS,
    freeShippingOverCents: config.FREE_SHIPPING_OVER_CENTS,
  });

  const address: ShippingAddress = input.addressId
    ? await getAddress(customer.customerId, input.addressId)
    : input.address ?? (() => { throw badRequest('A shipping address is required'); })();
  const shippingAddress = {
    name: address.name,
    line1: address.line1,
    line2: address.line2 ?? null,
    city: address.city,
    region: address.region,
    postalCode: address.postalCode,
    country: address.country,
  } satisfies Prisma.InputJsonObject;

  const order = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        customerId: customer.customerId,
        ...totals,
        discountCode: discount?.code,
        shippingAddress,
        checkoutKey,
        items: { create: items },
      },
    });
    if (discount) await redeemDiscount(tx, discount.code);
    await createPendingPayment(tx, {
      orderId: order.id,
      amountCents: order.totalCents,
      currency: order.currency,
      paymentMethodToken: input.paymentMethodToken,
    });
    await publish(tx, 'order.placed', { orderId: order.id });
    return order;
  });

  await clearCart(`c:${customer.customerId}`);
  return summary(order);
}

const summary = (o: { id: string; number: number; status: string; totalCents: number; currency: string }) => ({
  id: o.id,
  number: o.number,
  status: o.status,
  totalCents: o.totalCents,
  currency: o.currency,
});

export async function getCustomerOrder(customerId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, customerId },
    select: {
      id: true,
      number: true,
      status: true,
      fulfillmentStatus: true,
      cancelReason: true,
      subtotalCents: true,
      discountCents: true,
      shippingCents: true,
      taxCents: true,
      totalCents: true,
      currency: true,
      placedAt: true,
      items: { select: { productName: true, variantLabel: true, qty: true, unitPriceCents: true, imageUrl: true } },
    },
  });
  if (!order) throw notFound('Order');
  return order;
}
