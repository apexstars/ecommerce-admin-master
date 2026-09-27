import { buildApp } from './app.js';
import { config } from './config.js';
import { prisma } from './shared/db.js';
import { startOutboxDispatcher } from './shared/events/outbox.js';
import { redis } from './shared/redis.js';

const app = await buildApp();
const stopDispatcher = config.RUN_WORKER_IN_PROCESS ? startOutboxDispatcher() : undefined;

await app.listen({ port: config.PORT, host: '0.0.0.0' });
console.log(`API listening on http://localhost:${config.PORT}${stopDispatcher ? ' (outbox worker in-process)' : ''}`);

async function shutdown() {
  await app.close();
  await stopDispatcher?.();
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
