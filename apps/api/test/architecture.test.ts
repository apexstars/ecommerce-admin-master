import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { installAdminGuard } from '../src/modules/identity/index.js';
import { prisma } from '../src/shared/db.js';
import { redis } from '../src/shared/redis.js';

const MODULES_DIR = join(import.meta.dirname, '../src/modules');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

afterAll(async () => {
  redis.disconnect();
  await prisma.$disconnect();
});

describe('modular monolith boundaries', () => {
  it("modules only import other modules through their public index", () => {
    const violations: string[] = [];
    for (const file of files(MODULES_DIR)) {
      const [owner] = relative(MODULES_DIR, file).split(sep);
      const source = readFileSync(file, 'utf8');
      for (const [, spec] of source.matchAll(/from '(\.\.\/[^']+)'/g)) {
        const m = spec!.match(/^\.\.\/([^/.]+)\/(.+)$/);
        if (!m || m[1] === owner) continue;
        if (m[2] !== 'index.js') violations.push(`${relative(MODULES_DIR, file)} → ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });
});

describe('admin route guard', () => {
  it('refuses to boot if an admin route declares no permission', async () => {
    const app = Fastify();
    const boot = async () => {
      await app.register(async (admin) => {
        installAdminGuard(admin);
        admin.get('/oops', async () => 'unguarded');
      });
      await app.ready();
    };
    await expect(boot()).rejects.toThrow(/must declare exactly one of/);
  });

  it('rejects unauthenticated requests before the handler runs', async () => {
    const app = Fastify();
    let ran = false;
    await app.register(async (admin) => {
      installAdminGuard(admin);
      admin.get('/orders', { config: { permission: 'orders:view' } }, async () => {
        ran = true;
        return [];
      });
    });
    app.setErrorHandler((err: { statusCode?: number }, _req, reply) => reply.code(err.statusCode ?? 500).send());
    const res = await app.inject({ method: 'GET', url: '/orders' });
    expect(res.statusCode).toBe(401);
    expect(ran).toBe(false);
  });
});
