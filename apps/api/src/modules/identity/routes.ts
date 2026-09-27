import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { config, isProd } from '../../config.js';
import { IdParams, PageQuery, parse } from '../../shared/http.js';
import * as auth from './admin-auth.service.js';
import { adminOf } from './admin-guard.js';
import { loginCustomer, registerCustomer } from './customer-auth.service.js';
import * as customers from './customers.service.js';
import { isPermissionKey, PERMISSION_CATALOG, RESOURCES, ACTIONS } from './permissions.js';
import * as roles from './roles.service.js';
import * as staff from './staff.service.js';

const REFRESH_COOKIE = 'admin_refresh';
const REFRESH_PATH = '/api/admin/auth';

function sendSession(reply: FastifyReply, session: auth.IssuedSession) {
  reply.setCookie(REFRESH_COOKIE, session.refreshCookie, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'strict',
    path: REFRESH_PATH,
    maxAge: config.ADMIN_SESSION_TTL_SECONDS,
  });
  return { accessToken: session.accessToken, expiresIn: session.expiresIn };
}

const Password = z.string().min(10, 'Use at least 10 characters').max(200);
const PermissionList = z.array(z.string().refine(isPermissionKey, 'Unknown permission'));

/** /api/admin/auth/* and /api/admin/me */
export async function adminAuthRoutes(app: FastifyInstance) {
  app.post('/auth/login', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const result = await auth.loginWithPassword(body.email, body.password);
    if (result.kind === '2fa_required') return { status: '2fa_required', challengeToken: result.challengeToken };
    return { status: 'ok', ...sendSession(reply, result.session) };
  });

  app.post('/auth/2fa/verify', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ challengeToken: z.string(), code: z.string() }), req.body);
    return { status: 'ok', ...sendSession(reply, await auth.completeTwoFactorLogin(body.challengeToken, body.code)) };
  });

  app.post('/auth/refresh', { config: { public: true } }, async (req, reply) => {
    try {
      return sendSession(reply, await auth.refreshSession(req.cookies[REFRESH_COOKIE]));
    } catch (err) {
      reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
      throw err;
    }
  });

  app.post('/auth/logout', { config: { public: true } }, async (req, reply) => {
    const sid = req.cookies[REFRESH_COOKIE]?.split('.')[0];
    if (sid) await auth.revokeSession(sid);
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_PATH });
    return reply.code(204).send();
  });

  app.post('/auth/accept-invite', { config: { public: true } }, async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(1), name: z.string().trim().min(1).max(100), password: Password }), req.body);
    return sendSession(reply, await auth.acceptInvite(body.token, body.name, body.password));
  });

  app.get('/me', { config: { authenticated: true } }, async (req) => {
    const me = adminOf(req);
    return {
      id: me.userId,
      name: me.name,
      email: me.email,
      role: me.roleId ? { id: me.roleId, name: me.roleName, isSystem: me.isSuperAdmin } : null,
      permissions: [...me.permissions].sort(),
    };
  });

  app.post('/me/2fa/setup', { config: { authenticated: true } }, async (req) => auth.beginTwoFactorSetup(adminOf(req).userId));

  app.post('/me/2fa/enable', { config: { authenticated: true } }, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string() }), req.body);
    await auth.confirmTwoFactorSetup(adminOf(req).userId, code);
    return reply.code(204).send();
  });
}

/** Roles, permissions and staff — all gated on the `settings` resource. */
export async function rolesAdminRoutes(app: FastifyInstance) {
  app.get('/permissions', { config: { permission: 'settings:view' } }, async () => ({
    resources: RESOURCES,
    actions: ACTIONS,
    permissions: PERMISSION_CATALOG,
  }));

  app.get('/roles', { config: { permission: 'settings:view' } }, async () => roles.listRoles());

  app.get('/roles/:id', { config: { permission: 'settings:view' } }, async (req) => roles.getRole(parse(IdParams, req.params).id));

  app.post('/roles', { config: { permission: 'settings:create' } }, async (req, reply) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(60), description: z.string().max(300).default(''), permissions: PermissionList.default([]) }),
      req.body,
    );
    return reply.code(201).send(await roles.createRole(adminOf(req), body as never));
  });

  app.patch('/roles/:id', { config: { permission: 'settings:edit' } }, async (req) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().max(300).optional(), permissions: PermissionList.optional() }),
      req.body,
    );
    return roles.updateRole(adminOf(req), parse(IdParams, req.params).id, body as never);
  });

  app.delete('/roles/:id', { config: { permission: 'settings:delete' } }, async (req, reply) => {
    await roles.deleteRole(adminOf(req), parse(IdParams, req.params).id);
    return reply.code(204).send();
  });

  app.post('/roles/:id/members', { config: { permission: 'settings:edit' } }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { userId } = parse(z.object({ userId: z.string().uuid() }), req.body);
    await roles.assignStaffRole(adminOf(req), userId, id);
    return roles.getRole(id);
  });

  app.delete('/roles/:id/members/:userId', { config: { permission: 'settings:edit' } }, async (req) => {
    const { id, userId } = parse(z.object({ id: z.string().uuid(), userId: z.string().uuid() }), req.params);
    await roles.assignStaffRole(adminOf(req), userId, null);
    return roles.getRole(id);
  });

  app.get('/staff', { config: { permission: 'settings:view' } }, async (req) =>
    staff.listStaff(parse(PageQuery.extend({ search: z.string().trim().optional() }), req.query)),
  );

  app.post('/staff/invite', { config: { permission: 'settings:create' } }, async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100), email: z.string().email(), roleId: z.string().uuid() }), req.body);
    return reply.code(201).send(await staff.inviteStaff(adminOf(req), body));
  });

  app.patch('/staff/:id', { config: { permission: 'settings:edit' } }, async (req, reply) => {
    const { roleId } = parse(z.object({ roleId: z.string().uuid().nullable() }), req.body);
    await roles.assignStaffRole(adminOf(req), parse(IdParams, req.params).id, roleId);
    return reply.code(204).send();
  });
}

const Address = z.object({
  name: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200).nullish(),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(20),
  country: z.string().trim().length(2, 'Use a 2-letter country code').toUpperCase(),
  isDefault: z.boolean().optional(),
});
const AddressParams = z.object({ id: z.string().uuid(), addressId: z.string().uuid() });

export async function customersAdminRoutes(app: FastifyInstance) {
  app.get('/customers', { config: { permission: 'customers:view' } }, async (req) =>
    customers.listCustomers(
      parse(
        PageQuery.extend({
          search: z.string().trim().optional(),
          sort: z.enum(['newest', 'oldest', 'name']).default('newest'),
          includeErased: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
        }),
        req.query,
      ),
    ),
  );

  app.get('/customers/:id', { config: { permission: 'customers:view' } }, async (req) =>
    customers.getCustomer(parse(IdParams, req.params).id),
  );

  app.post('/customers', { config: { permission: 'customers:create' } }, async (req, reply) => {
    const body = parse(
      z.object({ name: z.string().trim().min(1).max(100), email: z.string().trim().email(), address: Address.omit({ isDefault: true }).optional() }),
      req.body,
    );
    return reply.code(201).send(await customers.createCustomer(adminOf(req), body));
  });

  app.patch('/customers/:id', { config: { permission: 'customers:edit' } }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(1).max(100).optional(), email: z.string().trim().email().optional() }), req.body);
    return customers.updateCustomer(adminOf(req), parse(IdParams, req.params).id, body);
  });

  // Erases personal data; order history is kept (see eraseCustomer).
  app.delete('/customers/:id', { config: { permission: 'customers:delete' } }, async (req, reply) => {
    await customers.eraseCustomer(adminOf(req), parse(IdParams, req.params).id);
    return reply.code(204).send();
  });

  app.post('/customers/:id/addresses', { config: { permission: 'customers:edit' } }, async (req, reply) =>
    reply.code(201).send(await customers.addAddress(adminOf(req), parse(IdParams, req.params).id, parse(Address, req.body))),
  );

  app.patch('/customers/:id/addresses/:addressId', { config: { permission: 'customers:edit' } }, async (req) => {
    const { id, addressId } = parse(AddressParams, req.params);
    return customers.updateAddress(adminOf(req), id, addressId, parse(Address.partial(), req.body));
  });

  app.delete('/customers/:id/addresses/:addressId', { config: { permission: 'customers:edit' } }, async (req) => {
    const { id, addressId } = parse(AddressParams, req.params);
    return customers.removeAddress(adminOf(req), id, addressId);
  });
}

/** Storefront customer auth: /api/store/auth/* */
export async function customerAuthRoutes(app: FastifyInstance) {
  app.post('/auth/register', async (req, reply) => {
    const body = parse(z.object({ name: z.string().trim().min(1), email: z.string().email(), password: Password }), req.body);
    return reply.code(201).send(await registerCustomer(body.name, body.email, body.password));
  });
  app.post('/auth/login', async (req) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    return loginCustomer(body.email, body.password);
  });
}
