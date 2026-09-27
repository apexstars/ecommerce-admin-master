// Standalone outbox worker. Run one or more of these alongside the API with
// RUN_WORKER_IN_PROCESS=false; SKIP LOCKED makes concurrent workers safe.
import './config.js';
import { registerEventHandlers } from './modules/index.js';
import { prisma } from './shared/db.js';
import { startOutboxDispatcher } from './shared/events/outbox.js';
import { logger } from './shared/logger.js';
import { redis } from './shared/redis.js';

registerEventHandlers();
const stop = startOutboxDispatcher();
logger.info('worker.started');

async function shutdown() {
  await stop();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
