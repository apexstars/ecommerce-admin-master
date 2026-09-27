import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { Prisma } from '@prisma/client';
import Fastify from 'fastify';
import { config, isProd } from './config.js';
import { registerEventHandlers, registerRoutes } from './modules/index.js';
import { AppError } from './shared/errors.js';

export async function buildApp({ logger = true }: { logger?: boolean } = {}) {
  const app = Fastify({
    logger: logger && { level: isProd ? 'info' : 'warn', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: isProd,
  });

  await app.register(cors, { origin: config.WEB_ORIGIN, credentials: true });
  await app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.code(err.statusCode).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      if (err.code === 'P2002') {
        const target = (err.meta?.target as string[] | undefined)?.join(', ');
        return reply.code(409).send({ error: { code: 'conflict', message: `That ${target ?? 'value'} is already in use` } });
      }
      if (err.code === 'P2025') return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      if (err.code === 'P2003') return reply.code(409).send({ error: { code: 'conflict', message: 'Referenced record is in use or missing' } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } });
  });

  app.get('/health', async () => ({ ok: true }));

  registerEventHandlers();
  await registerRoutes(app);
  return app;
}
