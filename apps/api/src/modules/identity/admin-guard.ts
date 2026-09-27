import type { FastifyInstance, FastifyRequest } from 'fastify';
import { unauthorized } from '../../shared/errors.js';
import { resolveAdminPrincipal } from './admin-auth.service.js';
import type { CustomerPrincipal } from './customer-auth.service.js';
import type { PermissionKey } from './permissions.js';
import { type AdminPrincipal, assertCan } from './rbac.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Permission(s) the caller must hold — all of them. */
    permission?: PermissionKey | PermissionKey[];
    /** Signed-in admin required, but no specific permission (e.g. GET /me). */
    authenticated?: true;
    /** No authentication (login, refresh, accept-invite). */
    public?: true;
  }
  interface FastifyRequest {
    admin?: AdminPrincipal;
    customer?: CustomerPrincipal;
  }
}

/**
 * Installs server-side RBAC on an encapsulated Fastify context (the /api/admin
 * scope). Two guarantees:
 *  1. At startup, every route registered in this scope MUST declare
 *     `config.permission`, `config.authenticated` or `config.public` — otherwise
 *     the server refuses to boot. Forgetting a check is not possible.
 *  2. On every request, the caller is authenticated and every declared
 *     permission is verified before the handler runs.
 */
export function installAdminGuard(app: FastifyInstance) {
  app.addHook('onRoute', (route) => {
    const cfg = route.config ?? {};
    const declared = [cfg.permission, cfg.authenticated, cfg.public].filter((v) => v !== undefined);
    if (declared.length !== 1) {
      throw new Error(
        `Admin route ${String(route.method)} ${route.url} must declare exactly one of ` +
          '`config.permission`, `config.authenticated` or `config.public`',
      );
    }
  });

  app.addHook('onRequest', async (request) => {
    const cfg = request.routeOptions.config;
    if (cfg.public) return;
    request.admin = await resolveAdminPrincipal(request.headers.authorization);
    if (cfg.permission) {
      assertCan(request.admin, ...(Array.isArray(cfg.permission) ? cfg.permission : [cfg.permission]));
    }
  });
}

/** The authenticated admin for this request (guaranteed by the guard). */
export function adminOf(request: FastifyRequest): AdminPrincipal {
  if (!request.admin) throw unauthorized();
  return request.admin;
}
