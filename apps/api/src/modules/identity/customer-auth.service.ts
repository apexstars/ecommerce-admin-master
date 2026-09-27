import type { FastifyRequest } from 'fastify';
import { config } from '../../config.js';
import { hashPassword, verifyPassword } from '../../shared/crypto.js';
import { prisma } from '../../shared/db.js';
import { conflict, unauthorized } from '../../shared/errors.js';
import { signJwt, verifyJwt } from '../../shared/jwt.js';

/** Customer (storefront) tokens: separate secret + audience from admin tokens. */
const CUSTOMER_AUD = 'customer';

export interface CustomerPrincipal {
  customerId: string;
  email: string;
}

const issue = (customerId: string) =>
  signJwt(config.CUSTOMER_JWT_SECRET, CUSTOMER_AUD, customerId, config.CUSTOMER_ACCESS_TTL_SECONDS);

export async function registerCustomer(name: string, email: string, password: string) {
  const normalized = email.trim().toLowerCase();
  const existing = await prisma.customer.findUnique({ where: { email: normalized } });
  if (existing?.passwordHash) throw conflict('An account with this email already exists');
  const passwordHash = await hashPassword(password);
  // Guest customers (no password yet) can claim their record by registering.
  const customer = existing
    ? await prisma.customer.update({ where: { id: existing.id }, data: { name, passwordHash } })
    : await prisma.customer.create({ data: { name, email: normalized, passwordHash } });
  return { customerId: customer.id, token: await issue(customer.id) };
}

export async function loginCustomer(email: string, password: string) {
  const customer = await prisma.customer.findUnique({ where: { email: email.trim().toLowerCase() } });
  if (!customer || !(await verifyPassword(password, customer.passwordHash))) {
    throw unauthorized('Invalid email or password');
  }
  return { customerId: customer.id, token: await issue(customer.id) };
}

/** Returns the customer principal if a valid customer token is present, else null. */
export async function optionalCustomer(request: FastifyRequest): Promise<CustomerPrincipal | null> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const claims = await verifyJwt(config.CUSTOMER_JWT_SECRET, CUSTOMER_AUD, header.slice(7));
  if (!claims) throw unauthorized('Invalid or expired token');
  const customer = await prisma.customer.findUnique({ where: { id: claims.sub }, select: { id: true, email: true, erasedAt: true } });
  // Erasure must cut off tokens issued before it, not just future logins.
  if (!customer || customer.erasedAt) throw unauthorized();
  return { customerId: customer.id, email: customer.email };
}

export async function requireCustomer(request: FastifyRequest): Promise<CustomerPrincipal> {
  const principal = await optionalCustomer(request);
  if (!principal) throw unauthorized();
  request.customer = principal;
  return principal;
}
