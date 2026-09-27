import { Prisma } from '@prisma/client';
import { config } from '../../config.js';
import { prisma, type Tx } from '../../shared/db.js';
import { conflict, notFound } from '../../shared/errors.js';
import { publish } from '../../shared/events/outbox.js';
import { logger } from '../../shared/logger.js';
import { getVariants, stockLevel } from '../catalog/index.js';
import { lockOrderStatus } from '../orders/index.js';

/**
 * Inventory owns ProductVariant.stockQty. Reservation model: stock is
 * decremented at reservation time (so it can never be oversold), and the
 * InventoryReservation row remembers what to give back if the order fails.
 */

class InsufficientStock extends Error {
  constructor(public readonly variantId: string) {
    super(`Insufficient stock for variant ${variantId}`);
  }
}

/** Atomic check-and-decrement. Returns false if there isn't enough stock. */
async function tryDecrement(tx: Tx, variantId: string, qty: number) {
  const affected = await tx.$executeRaw`
    UPDATE "ProductVariant" SET "stockQty" = "stockQty" - ${qty}, "updatedAt" = now()
    WHERE id = ${variantId} AND "stockQty" >= ${qty}`;
  return affected === 1;
}

async function increment(tx: Tx, variantId: string, qty: number) {
  // Variant may have been deleted from the catalog since; nothing to return stock to then.
  await tx.$executeRaw`
    UPDATE "ProductVariant" SET "stockQty" = "stockQty" + ${qty}, "updatedAt" = now() WHERE id = ${variantId}`;
}

export async function reserveForOrder(orderId: string, items: { variantId: string; qty: number }[]) {
  // Merge duplicate lines and lock rows in a stable order to avoid deadlocks.
  const wanted = new Map<string, number>();
  for (const i of items) wanted.set(i.variantId, (wanted.get(i.variantId) ?? 0) + i.qty);
  const lines = [...wanted.entries()].sort(([a], [b]) => a.localeCompare(b));

  try {
    await prisma.$transaction(async (tx) => {
      // Holding a share lock on the order blocks a concurrent cancel until we
      // commit, so the cancel's release event always sees our reservations.
      const status = await lockOrderStatus(tx, orderId);
      if (status !== 'pending') {
        logger.info('inventory.reserve_skipped', { orderId, status });
        return;
      }
      if (await tx.inventoryReservation.count({ where: { orderId } })) return; // retry of a committed attempt

      for (const [variantId, qty] of lines) {
        if (!(await tryDecrement(tx, variantId, qty))) throw new InsufficientStock(variantId);
      }
      await tx.inventoryReservation.createMany({ data: lines.map(([variantId, qty]) => ({ orderId, variantId, qty })) });
      await tx.stockMovement.createMany({
        data: lines.map(([variantId, qty]) => ({ variantId, delta: -qty, reason: 'reservation' as const, orderId })),
      });
      await publish(tx, 'inventory.reserved', { orderId });
    });
  } catch (err) {
    if (!(err instanceof InsufficientStock)) throw err;
    // The reservation transaction rolled back entirely; report the failure.
    await prisma.$transaction((tx) =>
      publish(tx, 'inventory.reservation_failed', { orderId, reason: `out_of_stock:${err.variantId}` }),
    );
  }
}

export async function commitForOrder(orderId: string) {
  await prisma.inventoryReservation.updateMany({ where: { orderId, status: 'active' }, data: { status: 'committed' } });
}

/**
 * Returns reserved stock to the shelf. `includeCommitted` is for refunds and
 * post-payment cancellations of goods that never shipped. Idempotent.
 */
export async function releaseForOrder(orderId: string, { includeCommitted }: { includeCommitted: boolean }) {
  await prisma.$transaction(async (tx) => {
    const statuses = includeCommitted ? ['active', 'committed'] : ['active'];
    const rows = await tx.$queryRaw<{ id: string; variantId: string; qty: number }[]>`
      SELECT id, "variantId", qty FROM "InventoryReservation"
      WHERE "orderId" = ${orderId} AND status::text IN (${Prisma.join(statuses)})
      FOR UPDATE`;
    for (const r of rows) {
      await increment(tx, r.variantId, r.qty);
      await tx.inventoryReservation.update({ where: { id: r.id }, data: { status: 'released' } });
    }
    if (rows.length) {
      await tx.stockMovement.createMany({
        data: rows.map((r) => ({ variantId: r.variantId, delta: r.qty, reason: 'release' as const, orderId })),
      });
    }
  });
}

export async function adjustStock(actorUserId: string, variantId: string, delta: number, note?: string) {
  return prisma.$transaction(async (tx) => {
    const variant = await tx.productVariant.findUnique({ where: { id: variantId }, select: { stockQty: true } });
    if (!variant) throw notFound('Variant');
    if (delta < 0 && !(await tryDecrement(tx, variantId, -delta))) {
      throw conflict(`Only ${variant.stockQty} in stock; can't remove ${-delta}`);
    }
    if (delta > 0) await increment(tx, variantId, delta);
    await tx.stockMovement.create({ data: { variantId, delta, reason: 'adjustment', note, actorUserId } });
    const stockQty = variant.stockQty + delta;
    return { variantId, stockQty, stockLevel: stockLevel(stockQty) };
  });
}

export async function listLowStock(limit = 10, threshold = config.LOW_STOCK_THRESHOLD) {
  const rows = await prisma.productVariant.findMany({
    where: { stockQty: { lt: threshold }, product: { status: 'active' } },
    orderBy: [{ stockQty: 'asc' }, { sku: 'asc' }],
    take: limit,
    select: { id: true },
  });
  const variants = await getVariants(rows.map((r) => r.id));
  return {
    threshold,
    items: rows.flatMap((r) => {
      const v = variants.get(r.id);
      return v
        ? [{ variantId: v.variantId, productId: v.productId, productName: v.productName, label: v.label, sku: v.sku, stockQty: v.stockQty, stockLevel: stockLevel(v.stockQty, threshold) }]
        : [];
    }),
  };
}

export async function listMovements(variantId: string, limit = 50) {
  return prisma.stockMovement.findMany({ where: { variantId }, orderBy: { createdAt: 'desc' }, take: limit });
}
