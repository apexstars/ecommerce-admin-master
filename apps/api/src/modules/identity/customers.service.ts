import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { conflict, notFound } from '../../shared/errors.js';
import { recordAudit } from '../audit/index.js';
import type { AdminPrincipal } from './rbac.js';

const customerSelect = {
  id: true,
  name: true,
  email: true,
  createdAt: true,
  updatedAt: true,
  erasedAt: true,
  passwordHash: true,
} as const;

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof customerSelect }>;

/** Never expose the hash; expose whether they have a storefront login instead. */
function toPublic({ passwordHash, ...c }: CustomerRow) {
  return { ...c, hasAccount: passwordHash !== null };
}

export interface AddressInput {
  name: string;
  line1: string;
  line2?: string | null;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  isDefault?: boolean;
}

const searchWhere = (search: string): Prisma.CustomerWhereInput => ({
  OR: [
    { name: { contains: search, mode: 'insensitive' } },
    { email: { contains: search, mode: 'insensitive' } },
  ],
});

// ── Queries ──────────────────────────────────────────────────────────────────

export async function listCustomers(q: {
  search?: string;
  sort: 'newest' | 'oldest' | 'name';
  includeErased: boolean;
  page: number;
  pageSize: number;
}) {
  const where: Prisma.CustomerWhereInput = {
    ...(q.search && searchWhere(q.search)),
    ...(!q.includeErased && { erasedAt: null }),
  };
  const orderBy: Prisma.CustomerOrderByWithRelationInput =
    q.sort === 'name' ? { name: 'asc' } : { createdAt: q.sort === 'oldest' ? 'asc' : 'desc' };

  const [rows, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      orderBy: [orderBy, { id: 'asc' }],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        ...customerSelect,
        addresses: { where: { isDefault: true }, take: 1, select: { city: true, region: true, country: true } },
      },
    }),
    prisma.customer.count({ where }),
  ]);
  return {
    items: rows.map(({ addresses, ...c }) => ({ ...toPublic(c), location: addresses[0] ?? null })),
    total,
    page: q.page,
    pageSize: q.pageSize,
  };
}

export async function getCustomer(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: { ...customerSelect, addresses: { orderBy: [{ isDefault: 'desc' }, { line1: 'asc' }] } },
  });
  if (!customer) throw notFound('Customer');
  const { addresses, ...rest } = customer;
  return { ...toPublic(rest), addresses };
}

// ── Mutations ────────────────────────────────────────────────────────────────
// Audit entries record *which* fields changed, not their values, so the audit
// log never becomes a second copy of personal data that survives erasure.

async function loadActive(id: string) {
  const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true, erasedAt: true } });
  if (!customer) throw notFound('Customer');
  if (customer.erasedAt) throw conflict("This customer's data has been erased");
  return customer;
}

export async function createCustomer(actor: AdminPrincipal, input: { name: string; email: string; address?: AddressInput }) {
  const email = input.email.trim().toLowerCase();
  if (await prisma.customer.findUnique({ where: { email }, select: { id: true } })) {
    throw conflict('A customer with this email already exists');
  }
  // Created without a password: the person can claim it later by registering
  // on the storefront with the same email.
  const created = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        name: input.name.trim(),
        email,
        ...(input.address && { addresses: { create: { ...input.address, isDefault: true } } }),
      },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.created',
      resourceType: 'customer',
      resourceId: customer.id,
      metadata: { withAddress: Boolean(input.address) },
    });
    return customer;
  });
  return getCustomer(created.id);
}

export async function updateCustomer(actor: AdminPrincipal, id: string, data: { name?: string; email?: string }) {
  await loadActive(id);
  const current = await prisma.customer.findUniqueOrThrow({ where: { id }, select: { name: true, email: true } });
  const next = { name: data.name?.trim(), email: data.email?.trim().toLowerCase() };
  const changed = (['name', 'email'] as const).filter((k) => next[k] !== undefined && next[k] !== current[k]);
  if (!changed.length) return getCustomer(id);

  await prisma.$transaction(async (tx) => {
    await tx.customer.update({ where: { id }, data: next });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.updated',
      resourceType: 'customer',
      resourceId: id,
      metadata: { fields: changed },
    });
  });
  return getCustomer(id);
}

/**
 * Right-to-erasure "delete": scrubs name, email, login and addresses but keeps
 * the row so orders and revenue history stay consistent. Irreversible.
 */
export async function eraseCustomer(actor: AdminPrincipal, id: string) {
  await loadActive(id);
  await prisma.$transaction(async (tx) => {
    await tx.address.deleteMany({ where: { customerId: id } });
    await tx.customer.update({
      where: { id },
      data: {
        name: 'Erased customer',
        email: `erased+${id}@invalid.local`,
        passwordHash: null,
        erasedAt: new Date(),
      },
    });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.erased',
      resourceType: 'customer',
      resourceId: id,
    });
  });
}

// ── Addresses ────────────────────────────────────────────────────────────────

export async function addAddress(actor: AdminPrincipal, customerId: string, input: AddressInput) {
  await loadActive(customerId);
  await prisma.$transaction(async (tx) => {
    const isFirst = (await tx.address.count({ where: { customerId } })) === 0;
    const isDefault = isFirst || Boolean(input.isDefault);
    if (isDefault) await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
    await tx.address.create({ data: { ...input, customerId, isDefault } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.address_added',
      resourceType: 'customer',
      resourceId: customerId,
    });
  });
  return getCustomer(customerId);
}

export async function updateAddress(actor: AdminPrincipal, customerId: string, addressId: string, input: Partial<AddressInput>) {
  await loadActive(customerId);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.address.findFirst({ where: { id: addressId, customerId } });
    if (!existing) throw notFound('Address');
    // The default can be moved to another address but not simply switched off.
    if (input.isDefault) await tx.address.updateMany({ where: { customerId }, data: { isDefault: false } });
    const { isDefault, ...fields } = input;
    await tx.address.update({ where: { id: addressId }, data: { ...fields, ...(isDefault && { isDefault: true }) } });
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.address_updated',
      resourceType: 'customer',
      resourceId: customerId,
      metadata: { fields: Object.keys(input) },
    });
  });
  return getCustomer(customerId);
}

export async function removeAddress(actor: AdminPrincipal, customerId: string, addressId: string) {
  await loadActive(customerId);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.address.findFirst({ where: { id: addressId, customerId } });
    if (!existing) throw notFound('Address');
    await tx.address.delete({ where: { id: addressId } });
    // Keep exactly one default while any address remains.
    if (existing.isDefault) {
      const next = await tx.address.findFirst({ where: { customerId }, orderBy: { line1: 'asc' } });
      if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
    }
    await recordAudit(tx, {
      actorUserId: actor.userId,
      action: 'customer.address_removed',
      resourceType: 'customer',
      resourceId: customerId,
    });
  });
  return getCustomer(customerId);
}

// ── Public API for other modules ─────────────────────────────────────────────

export type CustomerSummary = { id: string; name: string; email: string };

export async function getCustomerSummaries(ids: string[]): Promise<Map<string, CustomerSummary>> {
  const rows = await prisma.customer.findMany({
    where: { id: { in: [...new Set(ids)] } },
    select: { id: true, name: true, email: true },
  });
  return new Map(rows.map((r) => [r.id, r]));
}

export async function searchCustomerIds(search: string, limit = 500): Promise<string[]> {
  const rows = await prisma.customer.findMany({ where: searchWhere(search), select: { id: true }, take: limit });
  return rows.map((r) => r.id);
}

export async function getAddress(customerId: string, addressId: string) {
  const address = await prisma.address.findFirst({ where: { id: addressId, customerId } });
  if (!address) throw notFound('Address');
  return address;
}
