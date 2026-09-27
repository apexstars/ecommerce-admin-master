import type { Payment } from '@prisma/client';
import { prisma, type Tx } from '../../shared/db.js';
import { conflict, notFound } from '../../shared/errors.js';
import { publish } from '../../shared/events/outbox.js';
import { logger } from '../../shared/logger.js';
import { paymentProvider } from './provider.js';

/** Display-safe view of a payment. Never includes the payment-method token. */
export function toPublicPayment(p: Payment) {
  return {
    id: p.id,
    provider: p.provider,
    providerPaymentId: p.providerPaymentId,
    status: p.status,
    amountCents: p.amountCents,
    refundedCents: p.refundedCents,
    currency: p.currency,
    cardBrand: p.cardBrand,
    cardLast4: p.cardLast4,
    failureReason: p.failureReason,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
}
export type PublicPayment = ReturnType<typeof toPublicPayment>;

export async function createPendingPayment(
  tx: Tx,
  input: { orderId: string; amountCents: number; currency: string; paymentMethodToken: string },
) {
  return tx.payment.create({ data: { ...input, provider: paymentProvider.name } });
}

/** Handler for inventory.reserved. Safe to retry: the provider call is idempotent per payment. */
export async function chargeForOrder(orderId: string) {
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment || payment.status !== 'pending') return;

  const result = await paymentProvider.charge({
    amountCents: payment.amountCents,
    currency: payment.currency,
    paymentMethodToken: payment.paymentMethodToken,
    idempotencyKey: `charge:${payment.id}`,
    metadata: { orderId, paymentId: payment.id },
  });

  if (result.status === 'requires_action') {
    // e.g. 3-D Secure: the provider webhook finishes the job.
    await prisma.payment.updateMany({
      where: { id: payment.id, status: 'pending' },
      data: { status: 'requires_action', providerPaymentId: result.providerPaymentId },
    });
    return;
  }

  if (result.status === 'failed') {
    await prisma.$transaction(async (tx) => {
      const { count } = await tx.payment.updateMany({
        where: { id: payment.id, status: 'pending' },
        data: { status: 'failed', failureReason: result.reason, providerPaymentId: result.providerPaymentId },
      });
      if (count) await publish(tx, 'payment.failed', { orderId, paymentId: payment.id, reason: result.reason });
    });
    return;
  }

  await markSucceeded(payment.id, orderId, result);
}

async function markSucceeded(
  paymentId: string,
  orderId: string,
  result: { providerPaymentId: string; cardBrand?: string; cardLast4?: string },
) {
  const moved = await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: paymentId, status: { in: ['pending', 'requires_action'] } },
      data: {
        status: 'succeeded',
        providerPaymentId: result.providerPaymentId,
        cardBrand: result.cardBrand,
        cardLast4: result.cardLast4,
      },
    });
    if (count) await publish(tx, 'payment.succeeded', { orderId, paymentId });
    return count > 0;
  });
  if (moved) return;

  // The payment was voided (order cancelled) while the charge was in flight.
  const current = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
  if (current.status === 'failed' && current.refundedCents === 0) {
    logger.warn('payments.charge_after_void', { orderId, paymentId });
    await paymentProvider.refund({
      providerPaymentId: result.providerPaymentId,
      amountCents: current.amountCents,
      idempotencyKey: `refund:${paymentId}`,
    });
    await prisma.payment.update({
      where: { id: paymentId },
      data: { status: 'refunded', refundedCents: current.amountCents, providerPaymentId: result.providerPaymentId },
    });
  }
}

/** Full refund of whatever is still captured. Idempotent. */
export async function refundForOrder(orderId: string) {
  const payment = await prisma.payment.findUnique({ where: { orderId } });
  if (!payment) throw notFound('Payment');
  if (payment.status === 'refunded') return toPublicPayment(payment);
  if (payment.status !== 'succeeded' || !payment.providerPaymentId) {
    throw conflict('There is no captured payment to refund');
  }
  const amountCents = payment.amountCents - payment.refundedCents;
  await paymentProvider.refund({
    providerPaymentId: payment.providerPaymentId,
    amountCents,
    idempotencyKey: `refund:${payment.id}`,
  });
  const updated = await prisma.payment.update({
    where: { id: payment.id },
    data: { status: 'refunded', refundedCents: payment.amountCents },
  });
  return toPublicPayment(updated);
}

/** Called inside an order-cancel transaction so a later charge attempt is skipped. */
export async function voidPendingPayment(tx: Tx, orderId: string) {
  await tx.payment.updateMany({
    where: { orderId, status: { in: ['pending', 'requires_action'] } },
    data: { status: 'failed', failureReason: 'order_cancelled' },
  });
}

export async function getPaymentsForOrders(orderIds: string[]) {
  const rows = await prisma.payment.findMany({ where: { orderId: { in: orderIds } } });
  return new Map(rows.map((p) => [p.orderId, toPublicPayment(p)]));
}

// ── Provider webhooks (async outcomes such as 3-D Secure) ────────────────────

export async function handleIntentSucceeded(providerPaymentId: string, card?: { brand?: string; last4?: string }) {
  const payment = await prisma.payment.findUnique({ where: { providerPaymentId } });
  if (!payment) return;
  await markSucceeded(payment.id, payment.orderId, { providerPaymentId, cardBrand: card?.brand, cardLast4: card?.last4 });
}

export async function handleIntentFailed(providerPaymentId: string, reason: string) {
  const payment = await prisma.payment.findUnique({ where: { providerPaymentId } });
  if (!payment) return;
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.payment.updateMany({
      where: { id: payment.id, status: 'requires_action' },
      data: { status: 'failed', failureReason: reason },
    });
    if (count) await publish(tx, 'payment.failed', { orderId: payment.orderId, paymentId: payment.id, reason });
  });
}
