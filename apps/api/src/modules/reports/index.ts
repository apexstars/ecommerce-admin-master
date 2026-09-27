import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parse } from '../../shared/http.js';
import { listLowStock } from '../inventory/index.js';
import { recentOrders, salesBetween } from '../orders/index.js';

/** UTC offset (ms) of `timeZone` at instant `at`. */
function tzOffsetMs(timeZone: string, at: Date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(at)
      .map((p) => [p.type, Number(p.value)]),
  );
  const asUtc = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

export function startOfDay(timeZone: string, at: Date): Date {
  const local = new Date(at.getTime() + tzOffsetMs(timeZone, at));
  const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  // Re-evaluate the offset at midnight itself (DST changes happen overnight).
  return new Date(midnightLocal - tzOffsetMs(timeZone, new Date(midnightLocal - tzOffsetMs(timeZone, at))));
}

const pctChange = (now: number, before: number) => (before === 0 ? null : (now - before) / before);

export async function dashboard(timeZone: string, now = new Date()) {
  const todayStart = startOfDay(timeZone, now);
  const yesterdayStart = startOfDay(timeZone, new Date(todayStart.getTime() - 12 * 3600 * 1000));
  // Day-over-day compares like with like: today so far vs. yesterday up to the same time.
  const yesterdaySameTime = new Date(yesterdayStart.getTime() + (now.getTime() - todayStart.getTime()));

  const [today, yesterday, recent, lowStock] = await Promise.all([
    salesBetween(todayStart, now),
    salesBetween(yesterdayStart, yesterdaySameTime),
    recentOrders(8),
    listLowStock(8),
  ]);

  const stat = (key: 'revenueCents' | 'orders' | 'aovCents') => ({
    value: today[key],
    previous: yesterday[key],
    change: pctChange(today[key], yesterday[key]),
  });

  return {
    timeZone,
    asOf: now,
    stats: { revenue: stat('revenueCents'), orders: stat('orders'), aov: stat('aovCents') },
    recentOrders: recent,
    lowStock,
  };
}

const TimeZone = z
  .string()
  .default('UTC')
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown time zone');

export async function reportsAdminRoutes(app: FastifyInstance) {
  // The dashboard composes data from orders + inventory; gate it on reports:view
  // and ALSO the underlying resources so it can't leak data a role can't see directly.
  app.get('/reports/dashboard', { config: { permission: ['reports:view', 'orders:view', 'inventory:view'] } }, async (req) => {
    const { tz } = parse(z.object({ tz: TimeZone }), req.query);
    return dashboard(tz);
  });
}
