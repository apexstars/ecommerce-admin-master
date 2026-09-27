import type { Prisma } from '@prisma/client';
import { config, isProd } from '../../config.js';
import { randomToken, sha256 } from '../../shared/crypto.js';
import { prisma } from '../../shared/db.js';
import { conflict, forbidden, notFound } from '../../shared/errors.js';
import { mailer } from '../../shared/mailer.js';
import { recordAudit } from '../audit/index.js';
import { type AdminPrincipal, getRolePermissions } from './rbac.js';

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

export async function listStaff(q: { search?: string; page: number; pageSize: number }) {
  const where: Prisma.UserWhereInput = q.search
    ? {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { email: { contains: q.search, mode: 'insensitive' } },
        ],
      }
    : {};
  const [items, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        name: true,
        email: true,
        avatarUrl: true,
        status: true,
        lastActiveAt: true,
        createdAt: true,
        role: { select: { id: true, name: true, isSystem: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function inviteStaff(actor: AdminPrincipal, input: { name: string; email: string; roleId: string }) {
  const email = input.email.trim().toLowerCase();
  const role = await prisma.role.findUnique({ where: { id: input.roleId } });
  if (!role) throw notFound('Role');
  if (role.isSystem && !actor.isSuperAdmin) throw forbidden('Only a Super Admin can invite Super Admins');
  if (!actor.isSuperAdmin) {
    const beyond = [...(await getRolePermissions(role.id))].filter((k) => !actor.permissions.has(k));
    if (beyond.length) throw forbidden(`You can't invite someone with permissions you don't have: ${beyond.join(', ')}`);
  }
  if (await prisma.user.findUnique({ where: { email } })) throw conflict('A staff member with this email already exists');

  const token = randomToken();
  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        name: input.name.trim(),
        email,
        roleId: role.id,
        status: 'invited',
        inviteTokenHash: sha256(token),
        inviteExpiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      select: { id: true, name: true, email: true, status: true, role: { select: { id: true, name: true } } },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'staff.invited',
      resourceType: 'user',
      resourceId: user.id,
      before: null,
      after: { email, roleId: role.id, roleName: role.name, status: 'invited' },
    });
    return user;
  });

  const inviteUrl = `${config.WEB_ORIGIN}/accept-invite?token=${encodeURIComponent(token)}`;
  await mailer.send({
    to: email,
    subject: `${actor.name} invited you to the store admin`,
    text: `You've been invited as ${role.name}. Accept within 7 days: ${inviteUrl}`,
  });
  // Surfacing the link is a dev convenience only; in production it goes by email.
  return { user, inviteUrl: isProd ? undefined : inviteUrl };
}
