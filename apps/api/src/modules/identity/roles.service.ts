import type { PermissionAction, PermissionResource } from '@prisma/client';
import { prisma, type Tx } from '../../shared/db.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { recordAudit } from '../audit/index.js';
import { ALL_PERMISSIONS, type PermissionKey, toKey } from './permissions.js';
import { type AdminPrincipal, getRolePermissions, invalidateRolePermissions } from './rbac.js';

const memberSelect = {
  id: true,
  name: true,
  email: true,
  avatarUrl: true,
  status: true,
  lastActiveAt: true,
} as const;

function permissionKeys(role: { isSystem: boolean; permissions: { permission: { resource: string; action: string } }[] }) {
  if (role.isSystem) return [...ALL_PERMISSIONS];
  return role.permissions.map(({ permission }) => toKey(permission.resource, permission.action)).sort();
}

export async function listRoles() {
  const roles = await prisma.role.findMany({
    orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
    include: {
      _count: { select: { users: true } },
      permissions: { select: { permission: { select: { resource: true, action: true } } } },
    },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystem: r.isSystem,
    memberCount: r._count.users,
    permissionCount: permissionKeys(r).length,
  }));
}

export async function getRole(id: string) {
  const role = await prisma.role.findUnique({
    where: { id },
    include: {
      users: { select: memberSelect, orderBy: { name: 'asc' } },
      permissions: { select: { permission: { select: { resource: true, action: true } } } },
    },
  });
  if (!role) throw notFound('Role');
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    isSystem: role.isSystem,
    permissions: permissionKeys(role),
    members: role.users,
    updatedAt: role.updatedAt,
  };
}

/**
 * Anti-escalation: a non-Super-Admin may only grant or revoke permissions they
 * hold themselves. Otherwise anyone with settings:edit could mint a super-role.
 */
function assertMayChange(actor: AdminPrincipal, changed: Iterable<PermissionKey>) {
  if (actor.isSuperAdmin) return;
  const beyond = [...changed].filter((k) => !actor.permissions.has(k));
  if (beyond.length) {
    throw forbidden(`You can't grant or revoke permissions you don't have: ${beyond.join(', ')}`);
  }
}

async function permissionIds(tx: Tx, keys: PermissionKey[]) {
  if (!keys.length) return [];
  const rows = await tx.permission.findMany({
    where: {
      OR: keys.map((k) => {
        const [resource, action] = k.split(':') as [PermissionResource, PermissionAction];
        return { resource, action };
      }),
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function createRole(
  actor: AdminPrincipal,
  input: { name: string; description: string; permissions: PermissionKey[] },
) {
  const permissions = [...new Set(input.permissions)].sort();
  assertMayChange(actor, permissions);
  const role = await prisma.$transaction(async (tx) => {
    const role = await tx.role.create({ data: { name: input.name.trim(), description: input.description.trim() } });
    await tx.rolePermission.createMany({
      data: (await permissionIds(tx, permissions)).map((permissionId) => ({ roleId: role.id, permissionId })),
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'role.created',
      resourceType: 'role',
      resourceId: role.id,
      before: null,
      after: { name: role.name, description: role.description, permissions },
    });
    return role;
  });
  return getRole(role.id);
}

export async function updateRole(
  actor: AdminPrincipal,
  id: string,
  input: { name?: string; description?: string; permissions?: PermissionKey[] },
) {
  const current = await getRole(id);
  if (current.isSystem) throw forbidden('The Super Admin role is built in and cannot be edited');

  const next = {
    name: input.name?.trim() ?? current.name,
    description: input.description?.trim() ?? current.description,
    permissions: input.permissions ? [...new Set(input.permissions)].sort() : current.permissions,
  };
  const before = new Set(current.permissions);
  const after = new Set(next.permissions);
  const added = next.permissions.filter((k) => !before.has(k));
  const removed = current.permissions.filter((k) => !after.has(k));
  assertMayChange(actor, [...added, ...removed]);

  await prisma.$transaction(async (tx) => {
    if (next.name !== current.name || next.description !== current.description) {
      await tx.role.update({ where: { id }, data: { name: next.name, description: next.description } });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'role.updated',
        resourceType: 'role',
        resourceId: id,
        before: { name: current.name, description: current.description },
        after: { name: next.name, description: next.description },
      });
    }
    if (added.length || removed.length) {
      if (removed.length) {
        await tx.rolePermission.deleteMany({
          where: { roleId: id, permissionId: { in: await permissionIds(tx, removed) } },
        });
      }
      if (added.length) {
        await tx.rolePermission.createMany({
          data: (await permissionIds(tx, added)).map((permissionId) => ({ roleId: id, permissionId })),
        });
      }
      await tx.role.update({ where: { id }, data: { updatedAt: new Date() } });
      await recordAudit(tx, {
        actorUserId: actor.userId,
        action: 'role.permissions_changed',
        resourceType: 'role',
        resourceId: id,
        before: { permissions: current.permissions },
        after: { permissions: next.permissions },
        metadata: { added, removed, roleName: next.name },
      });
    }
  });
  await invalidateRolePermissions(id);
  return getRole(id);
}

export async function deleteRole(actor: AdminPrincipal, id: string) {
  const current = await getRole(id);
  if (current.isSystem) throw forbidden('The Super Admin role is built in and cannot be deleted');
  if (current.members.length) {
    throw conflict(`Reassign this role's ${current.members.length} member(s) before deleting it`);
  }
  assertMayChange(actor, current.permissions);
  await prisma.$transaction(async (tx) => {
    await tx.role.delete({ where: { id } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'role.deleted',
      resourceType: 'role',
      resourceId: id,
      before: { name: current.name, description: current.description, permissions: current.permissions },
      after: null,
    });
  });
  await invalidateRolePermissions(id);
}

/**
 * The single entry point for changing a staff member's role (used by both the
 * role editor's member list and the staff table). Always audited.
 */
export async function assignStaffRole(actor: AdminPrincipal, userId: string, roleId: string | null) {
  if (userId === actor.userId) throw forbidden("You can't change your own role");

  const user = await prisma.user.findUnique({ where: { id: userId }, include: { role: true } });
  if (!user) throw notFound('Staff member');
  if (user.roleId === roleId) return;

  const target = roleId ? await prisma.role.findUnique({ where: { id: roleId } }) : null;
  if (roleId && !target) throw notFound('Role');

  if ((user.role?.isSystem || target?.isSystem) && !actor.isSuperAdmin) {
    throw forbidden('Only a Super Admin can grant or revoke Super Admin access');
  }
  // Moving someone onto a role you couldn't have created yourself is escalation too.
  if (target) assertMayChange(actor, await getRolePermissions(target.id));

  await prisma.$transaction(async (tx) => {
    if (user.role?.isSystem && user.status === 'active') {
      const remaining = await tx.user.count({
        where: { roleId: user.roleId, status: 'active', id: { not: user.id } },
      });
      if (remaining === 0) throw conflict('At least one active Super Admin is required');
    }
    await tx.user.update({ where: { id: userId }, data: { roleId } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'staff.role_changed',
      resourceType: 'user',
      resourceId: userId,
      before: { roleId: user.roleId, roleName: user.role?.name ?? null },
      after: { roleId, roleName: target?.name ?? null },
      metadata: { email: user.email },
    });
  });
}
