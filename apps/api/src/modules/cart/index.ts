import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isProd } from '../../config.js';
import { randomToken } from '../../shared/crypto.js';
import { badRequest, notFound } from '../../shared/errors.js';
import { parse } from '../../shared/http.js';
import { redis } from '../../shared/redis.js';
import { getVariants } from '../catalog/index.js';
import { optionalCustomer } from '../identity/index.js';

/**
 * Session carts live in Redis as a hash of variantId → qty. Prices are never
 * stored in the cart; they're read from the catalog every time (and again at
 * checkout), so a tampered or stale cart can't change what's charged.
 */

const CART_TTL_SECONDS = 30 * 24 * 3600;
const MAX_QTY_PER_LINE = 99;
const MAX_LINES = 50;
const ANON_COOKIE = 'cart_id';

export type CartOwner = `c:${string}` | `a:${string}`;
const key = (owner: CartOwner) => `cart:${owner}`;

export async function getCartLines(owner: CartOwner): Promise<{ variantId: string; qty: number }[]> {
  const raw = await redis.hgetall(key(owner));
  return Object.entries(raw).map(([variantId, qty]) => ({ variantId, qty: Number(qty) }));
}

export async function getCart(owner: CartOwner) {
  const lines = await getCartLines(owner);
  const variants = await getVariants(lines.map((l) => l.variantId));
  const items = lines.flatMap((l) => {
    const v = variants.get(l.variantId);
    if (!v) return [];
    return [
      {
        variantId: v.variantId,
        productId: v.productId,
        productName: v.productName,
        label: v.label,
        sku: v.sku,
        imageUrl: v.imageUrl,
        qty: l.qty,
        unitPriceCents: v.priceCents,
        lineTotalCents: v.priceCents * l.qty,
        available: v.isActive && v.stockQty >= l.qty,
      },
    ];
  });
  return { items, subtotalCents: items.reduce((n, i) => n + i.lineTotalCents, 0) };
}

export async function setCartItem(owner: CartOwner, variantId: string, qty: number) {
  if (qty <= 0) {
    await redis.hdel(key(owner), variantId);
    return;
  }
  const v = (await getVariants([variantId])).get(variantId);
  if (!v || !v.isActive) throw notFound('Product');
  if (qty > MAX_QTY_PER_LINE) throw badRequest(`Maximum ${MAX_QTY_PER_LINE} per item`);
  if ((await redis.hlen(key(owner))) >= MAX_LINES && !(await redis.hexists(key(owner), variantId))) {
    throw badRequest('Cart is full');
  }
  await redis.multi().hset(key(owner), variantId, qty).expire(key(owner), CART_TTL_SECONDS).exec();
}

export async function clearCart(owner: CartOwner) {
  await redis.del(key(owner));
}

/** On sign-in, fold the anonymous cart into the customer's cart. */
export async function mergeCarts(from: CartOwner, into: CartOwner) {
  const lines = await getCartLines(from);
  if (!lines.length) return;
  const tx = redis.multi();
  for (const l of lines) tx.hincrby(key(into), l.variantId, l.qty);
  tx.expire(key(into), CART_TTL_SECONDS).del(key(from));
  await tx.exec();
}

async function resolveOwner(req: FastifyRequest, reply: FastifyReply): Promise<CartOwner> {
  const customer = await optionalCustomer(req);
  const anonId = req.cookies[ANON_COOKIE];
  if (customer) {
    if (anonId) {
      await mergeCarts(`a:${anonId}`, `c:${customer.customerId}`);
      reply.clearCookie(ANON_COOKIE, { path: '/api/store' });
    }
    return `c:${customer.customerId}`;
  }
  if (anonId && /^[\w-]{20,64}$/.test(anonId)) return `a:${anonId}`;
  const fresh = randomToken(24);
  reply.setCookie(ANON_COOKIE, fresh, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    path: '/api/store',
    maxAge: CART_TTL_SECONDS,
  });
  return `a:${fresh}`;
}

export async function cartStoreRoutes(app: FastifyInstance) {
  app.get('/cart', async (req, reply) => getCart(await resolveOwner(req, reply)));

  app.put('/cart/items/:variantId', async (req, reply) => {
    const { variantId } = parse(z.object({ variantId: z.string().uuid() }), req.params);
    const { qty } = parse(z.object({ qty: z.number().int().min(0) }), req.body);
    const owner = await resolveOwner(req, reply);
    await setCartItem(owner, variantId, qty);
    return getCart(owner);
  });

  app.delete('/cart', async (req, reply) => {
    await clearCart(await resolveOwner(req, reply));
    return reply.code(204).send();
  });
}
