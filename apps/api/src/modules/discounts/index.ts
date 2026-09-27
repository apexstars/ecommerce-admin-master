import type { Discount, Prisma } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma, type Tx } from '../../shared/db.js';
import { badRequest, conflict, notFound } from '../../shared/errors.js';
import { IdParams, PageQuery, parse } from '../../shared/http.js';

// ── Pricing rules (pure) ─────────────────────────────────────────────────────

export function computeDiscountCents(d: Pick<Discount, 'type' | 'value'>, subtotalCents: number) {
  const raw = d.type === 'percent' ? Math.round((subtotalCents * d.value) / 100) : d.value;
  return Math.max(0, Math.min(raw, subtotalCents));
}

export function discountProblem(d: Discount, now = new Date()): string | null {
  if (d.startsAt > now) return 'This code is not active yet';
  if (d.endsAt && d.endsAt <= now) return 'This code has expired';
  if (d.usageLimit !== null && d.timesUsed >= d.usageLimit) return 'This code has been fully redeemed';
  return null;
}

// ── Public API for other modules ─────────────────────────────────────────────

const normalize = (code: string) => code.trim().toUpperCase();

export async function evaluateDiscount(code: string, subtotalCents: number) {
  const d = await prisma.discount.findUnique({ where: { code: normalize(code) } });
  if (!d) throw badRequest('Unknown discount code');
  const problem = discountProblem(d);
  if (problem) throw badRequest(problem);
  return { code: d.code, discountCents: computeDiscountCents(d, subtotalCents) };
}

/** Atomically consumes one use inside the checkout transaction. */
export async function redeemDiscount(tx: Tx, code: string) {
  const affected = await tx.$executeRaw`
    UPDATE "Discount" SET "timesUsed" = "timesUsed" + 1, "updatedAt" = now()
    WHERE code = ${normalize(code)}
      AND "startsAt" <= now() AND ("endsAt" IS NULL OR "endsAt" > now())
      AND ("usageLimit" IS NULL OR "timesUsed" < "usageLimit")`;
  if (affected !== 1) throw conflict('This discount code is no longer available');
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────

const DiscountBody = z
  .object({
    code: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9_-]+$/, 'Letters, numbers, - and _ only').transform(normalize),
    type: z.enum(['percent', 'fixed']),
    value: z.number().int().positive(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date().nullable().default(null),
    usageLimit: z.number().int().positive().nullable().default(null),
  })
  .refine((d) => d.type !== 'percent' || d.value <= 100, { message: 'Percent must be 1–100', path: ['value'] })
  .refine((d) => !d.endsAt || d.endsAt > d.startsAt, { message: 'End must be after start', path: ['endsAt'] });

function withState(d: Discount) {
  const now = new Date();
  const state = d.startsAt > now ? 'scheduled' : discountProblem(d, now) ? 'expired' : 'active';
  return { ...d, state };
}

export async function discountsAdminRoutes(app: FastifyInstance) {
  app.get('/discounts', { config: { permission: 'discounts:view' } }, async (req) => {
    const q = parse(PageQuery.extend({ search: z.string().trim().optional() }), req.query);
    const where: Prisma.DiscountWhereInput = q.search ? { code: { contains: q.search, mode: 'insensitive' } } : {};
    const [items, total] = await Promise.all([
      prisma.discount.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
      prisma.discount.count({ where }),
    ]);
    return { items: items.map(withState), total, page: q.page, pageSize: q.pageSize };
  });

  app.get('/discounts/:id', { config: { permission: 'discounts:view' } }, async (req) => {
    const d = await prisma.discount.findUnique({ where: { id: parse(IdParams, req.params).id } });
    if (!d) throw notFound('Discount');
    return withState(d);
  });

  app.post('/discounts', { config: { permission: 'discounts:create' } }, async (req, reply) => {
    const d = await prisma.discount.create({ data: parse(DiscountBody, req.body) });
    return reply.code(201).send(withState(d));
  });

  app.patch('/discounts/:id', { config: { permission: 'discounts:edit' } }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const existing = await prisma.discount.findUnique({ where: { id } });
    if (!existing) throw notFound('Discount');
    // Validate the merged result so cross-field rules still hold.
    const merged = parse(DiscountBody, { ...existing, ...(req.body as object) });
    return withState(await prisma.discount.update({ where: { id }, data: merged }));
  });

  app.delete('/discounts/:id', { config: { permission: 'discounts:delete' } }, async (req, reply) => {
    await prisma.discount.delete({ where: { id: parse(IdParams, req.params).id } });
    return reply.code(204).send();
  });
}
