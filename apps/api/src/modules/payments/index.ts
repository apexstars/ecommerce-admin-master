import type { FastifyInstance } from 'fastify';
import type Stripe from 'stripe';
import { config } from '../../config.js';
import { badRequest } from '../../shared/errors.js';
import { subscribe } from '../../shared/events/outbox.js';
import { logger } from '../../shared/logger.js';
import { redis } from '../../shared/redis.js';
import * as payments from './payments.service.js';
import { stripeProvider } from './provider.js';

export {
  createPendingPayment,
  getPaymentsForOrders,
  refundForOrder,
  voidPendingPayment,
  type PublicPayment,
} from './payments.service.js';

export function registerPaymentHandlers() {
  subscribe('inventory.reserved', 'payments.charge', (e) => payments.chargeForOrder(e.orderId));
  subscribe('payment.compensation_required', 'payments.refund', async (e) => {
    await payments.refundForOrder(e.orderId);
  });
}

/** POST /api/webhooks/stripe — signature-verified, deduplicated by event id. */
export async function paymentWebhookRoutes(app: FastifyInstance) {
  // Signature verification needs the exact raw bytes (this parser is scoped to this plugin).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

  app.post('/stripe', async (req, reply) => {
    if (!stripeProvider || !config.STRIPE_WEBHOOK_SECRET) return reply.code(404).send();
    const signature = req.headers['stripe-signature'];
    if (typeof signature !== 'string') throw badRequest('Missing signature');

    let event: Stripe.Event;
    try {
      event = stripeProvider.constructWebhookEvent(req.body as Buffer, signature, config.STRIPE_WEBHOOK_SECRET);
    } catch {
      throw badRequest('Invalid signature');
    }
    if (!(await redis.set(`stripe:event:${event.id}`, '1', 'EX', 7 * 24 * 3600, 'NX'))) {
      return { received: true, duplicate: true };
    }

    try {
      if (event.type === 'payment_intent.succeeded') {
        await payments.handleIntentSucceeded(event.data.object.id);
      } else if (event.type === 'payment_intent.payment_failed') {
        const intent = event.data.object;
        await payments.handleIntentFailed(intent.id, intent.last_payment_error?.code ?? 'payment_failed');
      }
    } catch (err) {
      await redis.del(`stripe:event:${event.id}`); // let Stripe's retry reprocess it
      logger.error('stripe.webhook_failed', { eventId: event.id, error: String(err) });
      throw err;
    }
    return { received: true };
  });
}
