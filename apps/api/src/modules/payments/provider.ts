import { randomUUID } from 'node:crypto';
import Stripe from 'stripe';
import { config } from '../../config.js';

/**
 * PCI scope reduction: the browser tokenizes the card directly with the
 * provider (Stripe Elements / Payment Element) and we only ever receive an
 * opaque payment-method token. No PAN/CVC/expiry ever reaches this server.
 */
export interface ChargeRequest {
  amountCents: number;
  currency: string;
  paymentMethodToken: string;
  idempotencyKey: string;
  metadata: Record<string, string>;
}

export type ChargeResult =
  | { status: 'succeeded'; providerPaymentId: string; cardBrand?: string; cardLast4?: string }
  | { status: 'requires_action'; providerPaymentId: string }
  | { status: 'failed'; providerPaymentId?: string; reason: string };

export interface PaymentProvider {
  readonly name: string;
  /** Must be safe to retry with the same idempotencyKey. Throws only on transient errors. */
  charge(req: ChargeRequest): Promise<ChargeResult>;
  refund(req: { providerPaymentId: string; amountCents: number; idempotencyKey: string }): Promise<{ refundId: string }>;
}

class StripeProvider implements PaymentProvider {
  readonly name = 'stripe';
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: req.amountCents,
          currency: req.currency,
          payment_method: req.paymentMethodToken,
          confirm: true,
          automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
          metadata: req.metadata,
          expand: ['latest_charge'],
        },
        { idempotencyKey: req.idempotencyKey },
      );
      if (intent.status === 'succeeded') {
        const charge = intent.latest_charge as Stripe.Charge | null;
        const card = charge?.payment_method_details?.card;
        return { status: 'succeeded', providerPaymentId: intent.id, cardBrand: card?.brand ?? undefined, cardLast4: card?.last4 ?? undefined };
      }
      if (intent.status === 'requires_action') return { status: 'requires_action', providerPaymentId: intent.id };
      return { status: 'failed', providerPaymentId: intent.id, reason: intent.status };
    } catch (err) {
      const e = err as { type?: string; code?: string; message?: string; payment_intent?: { id: string } };
      if (e.type === 'StripeCardError') {
        return { status: 'failed', providerPaymentId: e.payment_intent?.id, reason: e.code ?? e.message ?? 'card_error' };
      }
      throw err; // network/5xx/rate-limit → let the outbox retry
    }
  }

  async refund(req: { providerPaymentId: string; amountCents: number; idempotencyKey: string }) {
    const refund = await this.stripe.refunds.create(
      { payment_intent: req.providerPaymentId, amount: req.amountCents },
      { idempotencyKey: req.idempotencyKey },
    );
    return { refundId: refund.id };
  }

  constructWebhookEvent(rawBody: Buffer, signature: string, secret: string) {
    return this.stripe.webhooks.constructEvent(rawBody, signature, secret);
  }
}

/**
 * Offline stand-in that understands Stripe's test payment-method tokens, so the
 * whole checkout saga runs locally without network access.
 */
class FakeProvider implements PaymentProvider {
  readonly name = 'fake';
  private charges = new Map<string, ChargeResult>();

  async charge(req: ChargeRequest): Promise<ChargeResult> {
    const prior = this.charges.get(req.idempotencyKey);
    if (prior) return prior;
    const id = `pi_fake_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const result: ChargeResult = /declined|chargeDeclined|insufficient/i.test(req.paymentMethodToken)
      ? { status: 'failed', providerPaymentId: id, reason: 'card_declined' }
      : { status: 'succeeded', providerPaymentId: id, cardBrand: 'visa', cardLast4: '4242' };
    this.charges.set(req.idempotencyKey, result);
    return result;
  }

  async refund(req: { providerPaymentId: string }) {
    return { refundId: `re_fake_${req.providerPaymentId.slice(-12)}` };
  }
}

export const stripeProvider = config.STRIPE_SECRET_KEY ? new StripeProvider(config.STRIPE_SECRET_KEY) : null;
export const paymentProvider: PaymentProvider = stripeProvider ?? new FakeProvider();
