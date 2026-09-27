import type { Prisma } from '@prisma/client';
import { prisma, type Tx } from '../db.js';
import { logger } from '../logger.js';
import type { EventMap, Topic } from './topics.js';

/**
 * Transactional outbox.
 *
 * `publish(tx, topic, payload)` inserts one OutboxEvent row per subscriber *inside
 * the caller's transaction*, so an event exists if and only if the state change
 * that produced it committed. The dispatcher later claims rows with
 * `FOR UPDATE SKIP LOCKED`, runs the handler, and retries with backoff.
 * Delivery is at-least-once: every handler must be idempotent.
 */

type Handler<T extends Topic> = (payload: EventMap[T], meta: { eventId: string; attempt: number }) => Promise<void>;

const registry = new Map<Topic, Map<string, Handler<any>>>();

export function subscribe<T extends Topic>(topic: T, handlerName: string, handler: Handler<T>) {
  let handlers = registry.get(topic);
  if (!handlers) registry.set(topic, (handlers = new Map()));
  if (handlers.has(handlerName)) throw new Error(`Duplicate outbox handler ${topic}/${handlerName}`);
  handlers.set(handlerName, handler);
}

export async function publish<T extends Topic>(tx: Tx, topic: T, payload: EventMap[T]) {
  const handlers = registry.get(topic);
  if (!handlers?.size) {
    logger.warn('outbox.no_subscribers', { topic });
    return;
  }
  await tx.outboxEvent.createMany({
    data: [...handlers.keys()].map((handler) => ({
      topic,
      handler,
      payload: payload as unknown as Prisma.InputJsonValue,
    })),
  });
}

const MAX_ATTEMPTS = 8;
const LOCK_SECONDS = 60;
const backoffMs = (attempt: number) => Math.min(1000 * 2 ** attempt, 5 * 60_000);

interface ClaimedRow {
  id: string;
  topic: Topic;
  handler: string;
  payload: unknown;
  attempts: number;
}

/** Claims and processes up to `limit` due events. Returns how many were processed. */
export async function processOutboxBatch(limit = 25): Promise<number> {
  // Single atomic statement: concurrent workers never claim the same row, and a
  // crashed worker's rows become claimable again once lockedUntil passes.
  const rows = await prisma.$queryRaw<ClaimedRow[]>`
    UPDATE "OutboxEvent"
    SET status = 'processing',
        attempts = attempts + 1,
        "lockedUntil" = now() + make_interval(secs => ${LOCK_SECONDS})
    WHERE id IN (
      SELECT id FROM "OutboxEvent"
      WHERE (status = 'pending' AND "availableAt" <= now())
         OR (status = 'processing' AND "lockedUntil" < now())
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, topic, handler, payload, attempts`;

  for (const row of rows) {
    const handler = registry.get(row.topic)?.get(row.handler);
    try {
      if (!handler) throw new Error(`No handler registered for ${row.topic}/${row.handler}`);
      await handler(row.payload as never, { eventId: row.id, attempt: row.attempts });
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: { status: 'done', processedAt: new Date(), lockedUntil: null, lastError: null },
      });
    } catch (err) {
      const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      const dead = row.attempts >= MAX_ATTEMPTS;
      logger.error('outbox.handler_failed', {
        id: row.id,
        topic: row.topic,
        handler: row.handler,
        attempt: row.attempts,
        dead,
        error: err instanceof Error ? err.message : String(err),
      });
      await prisma.outboxEvent.update({
        where: { id: row.id },
        data: {
          status: dead ? 'dead' : 'pending',
          lastError: message.slice(0, 4000),
          lockedUntil: null,
          availableAt: new Date(Date.now() + backoffMs(row.attempts)),
        },
      });
    }
  }
  return rows.length;
}

/** Polls the outbox until stopped. Drains eagerly while there is work. */
export function startOutboxDispatcher({ idleMs = 500 } = {}) {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const tick = async () => {
    if (stopped) return;
    let processed = 0;
    try {
      processed = await processOutboxBatch();
    } catch (err) {
      logger.error('outbox.poll_failed', { error: err instanceof Error ? err.message : String(err) });
    }
    if (!stopped) timer = setTimeout(() => (running = tick()), processed > 0 ? 0 : idleMs);
  };
  running = tick();

  return async function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    await running;
  };
}
