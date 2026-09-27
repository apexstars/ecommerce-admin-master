import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/db.js';
import { notFound } from '../../shared/errors.js';

const customerSelect = { id: true, name: true, email: true, createdAt: true } as const;

export async function listCustomers(q: { search?: string; page: number; pageSize: number }) {
  const where: Prisma.CustomerWhereInput = q.search
    ? {
        OR: [
          { name: { contains: q.search, mode: 'insensitive' } },
          { email: { contains: q.search, mode: 'insensitive' } },
        ],
      }
    : {};
  const [items, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      select: customerSelect,
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.customer.count({ where }),
  ]);
  return { items, total, page: q.page, pageSize: q.pageSize };
}

export async function getCustomer(id: string) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    select: { ...customerSelect, addresses: { orderBy: { isDefault: 'desc' } } },
  });
  if (!customer) throw notFound('Customer');
  return customer;
}

export async function updateCustomer(id: string, data: { name?: string; email?: string }) {
  return prisma.customer.update({
    where: { id },
    data: { name: data.name?.trim(), email: data.email?.trim().toLowerCase() },
    select: customerSelect,
  });
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
  const rows = await prisma.customer.findMany({
    where: {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ],
    },
    select: { id: true },
    take: limit,
  });
  return rows.map((r) => r.id);
}

export async function getAddress(customerId: string, addressId: string) {
  const address = await prisma.address.findFirst({ where: { id: addressId, customerId } });
  if (!address) throw notFound('Address');
  return address;
}
