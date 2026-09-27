import { prisma } from '../../shared/db.js';
import { forbidden } from '../../shared/errors.js';
import { redis } from '../../shared/redis.js';
import { ALL_PERMISSIONS, type PermissionKey, toKey } from './permissions.js';

export interface AdminPrincipal {
  userId: string;
  sessionId: string;
  name: string;
  email: string;
  roleId: string | null;
  roleName: string | null;
  isSuperAdmin: boolean;
  permissions: ReadonlySet<PermissionKey>;
}

const cacheKey = (roleId: string) => `rbac:role:${roleId}`;
const CACHE_TTL_SECONDS = 300;

/**
 * Effective permissions for a role. The system (Super Admin) role always gets
 * every permission, including ones added to the catalog after it was seeded.
 */
export async function getRolePermissions(roleId: string | null): Promise<Set<PermissionKey>> {
  if (!roleId) return new Set();

  const cached = await redis.get(cacheKey(roleId));
  if (cached) return new Set(JSON.parse(cached) as PermissionKey[]);

  const role = await prisma.role.findUnique({
    where: { id: roleId },
    select: { isSystem: true, permissions: { select: { permission: { select: { resource: true, action: true } } } } },
  });
  if (!role) return new Set();

  const keys = role.isSystem
    ? ALL_PERMISSIONS
    : role.permissions.map(({ permission }) => toKey(permission.resource, permission.action));
  await redis.set(cacheKey(roleId), JSON.stringify(keys), 'EX', CACHE_TTL_SECONDS);
  return new Set(keys);
}

/** Call after any change to a role's permissions so it takes effect on the next request. */
export async function invalidateRolePermissions(roleId: string) {
  await redis.del(cacheKey(roleId));
}

export const can = (principal: AdminPrincipal, key: PermissionKey) => principal.permissions.has(key);

export function assertCan(principal: AdminPrincipal, ...keys: PermissionKey[]) {
  const missing = keys.filter((k) => !principal.permissions.has(k));
  if (missing.length) throw forbidden(`Missing permission: ${missing.join(', ')}`);
}
