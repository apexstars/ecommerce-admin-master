import { config } from '../../config.js';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from '../../shared/crypto.js';
import { prisma } from '../../shared/db.js';
import { AppError, badRequest, unauthorized } from '../../shared/errors.js';
import { signJwt, verifyJwt } from '../../shared/jwt.js';
import { redis } from '../../shared/redis.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../../shared/totp.js';
import { SUPER_ADMIN_ROLE } from './permissions.js';
import { type AdminPrincipal, getRolePermissions } from './rbac.js';

/**
 * Admin auth is deliberately separate from customer auth:
 *  - different signing secret AND audience (`admin` vs `customer`)
 *  - short-lived access tokens (15 min default) held in memory by the SPA
 *  - server-side sessions in Redis (revocable) with a rotating refresh token
 *    delivered as an httpOnly cookie scoped to /api/admin/auth
 *  - optional TOTP second factor
 */

const ACCESS_AUD = 'admin';
const CHALLENGE_AUD = 'admin-2fa';
const sessionKey = (sid: string) => `admin:session:${sid}`;
const failKey = (email: string) => `admin:login-fail:${email}`;
const activeKey = (userId: string) => `admin:active:${userId}`;
const MAX_FAILED_LOGINS = 10;

interface SessionRecord {
  userId: string;
  refreshHash: string;
}

export interface IssuedSession {
  accessToken: string;
  expiresIn: number;
  refreshCookie: string;
}

// Used to keep login timing uniform when the email doesn't exist.
const DUMMY_HASH = await hashPassword(randomToken());

export async function loginWithPassword(
  email: string,
  password: string,
): Promise<{ kind: 'session'; session: IssuedSession } | { kind: '2fa_required'; challengeToken: string }> {
  const normalized = email.trim().toLowerCase();
  const failures = Number((await redis.get(failKey(normalized))) ?? 0);
  if (failures >= MAX_FAILED_LOGINS) {
    throw new AppError(429, 'too_many_attempts', 'Too many failed sign-in attempts. Try again in 15 minutes.');
  }

  const user = await prisma.user.findUnique({ where: { email: normalized } });
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !ok || user.status !== 'active') {
    await redis.multi().incr(failKey(normalized)).expire(failKey(normalized), 15 * 60).exec();
    throw unauthorized('Invalid email or password');
  }
  await redis.del(failKey(normalized));

  if (user.twoFactorEnabled) {
    const challengeToken = await signJwt(config.ADMIN_JWT_SECRET, CHALLENGE_AUD, user.id, 300);
    return { kind: '2fa_required', challengeToken };
  }
  return { kind: 'session', session: await createSession(user.id) };
}

export async function completeTwoFactorLogin(challengeToken: string, code: string): Promise<IssuedSession> {
  const claims = await verifyJwt(config.ADMIN_JWT_SECRET, CHALLENGE_AUD, challengeToken);
  if (!claims) throw unauthorized('Sign-in challenge expired. Please sign in again.');
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user?.twoFactorEnabled || !user.twoFactorSecret || user.status !== 'active') throw unauthorized();
  if (!verifyTotp(user.twoFactorSecret, code)) throw unauthorized('Invalid verification code');
  return createSession(user.id);
}

async function issueAccessToken(userId: string, sid: string) {
  return signJwt(config.ADMIN_JWT_SECRET, ACCESS_AUD, userId, config.ADMIN_ACCESS_TTL_SECONDS, { sid });
}

export async function createSession(userId: string): Promise<IssuedSession> {
  const sid = randomToken(16);
  const refresh = randomToken();
  const record: SessionRecord = { userId, refreshHash: sha256(refresh) };
  await redis.set(sessionKey(sid), JSON.stringify(record), 'EX', config.ADMIN_SESSION_TTL_SECONDS);
  return {
    accessToken: await issueAccessToken(userId, sid),
    expiresIn: config.ADMIN_ACCESS_TTL_SECONDS,
    refreshCookie: `${sid}.${refresh}`,
  };
}

/** Rotates the refresh token. Presenting an already-used token revokes the session. */
export async function refreshSession(cookie: string | undefined): Promise<IssuedSession> {
  const [sid, refresh] = (cookie ?? '').split('.');
  if (!sid || !refresh) throw unauthorized('No session');
  const raw = await redis.get(sessionKey(sid));
  if (!raw) throw unauthorized('Session expired');
  const record = JSON.parse(raw) as SessionRecord;

  if (!safeEqual(record.refreshHash, sha256(refresh))) {
    await redis.del(sessionKey(sid)); // token reuse → assume theft, kill the session
    throw unauthorized('Session revoked');
  }
  const user = await prisma.user.findUnique({ where: { id: record.userId }, select: { status: true } });
  if (user?.status !== 'active') {
    await redis.del(sessionKey(sid));
    throw unauthorized('Account is not active');
  }

  const nextRefresh = randomToken();
  await redis.set(sessionKey(sid), JSON.stringify({ ...record, refreshHash: sha256(nextRefresh) }), 'KEEPTTL');
  return {
    accessToken: await issueAccessToken(record.userId, sid),
    expiresIn: config.ADMIN_ACCESS_TTL_SECONDS,
    refreshCookie: `${sid}.${nextRefresh}`,
  };
}

export async function revokeSession(sid: string) {
  await redis.del(sessionKey(sid));
}

/** Validates an access token and loads the caller's current role + permissions. */
export async function resolveAdminPrincipal(authorization: string | undefined): Promise<AdminPrincipal> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : undefined;
  if (!token) throw unauthorized();
  const claims = await verifyJwt<{ sid?: string }>(config.ADMIN_JWT_SECRET, ACCESS_AUD, token);
  if (!claims?.sid) throw unauthorized('Invalid or expired token');
  if (!(await redis.exists(sessionKey(claims.sid)))) throw unauthorized('Session expired');

  const user = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: { id: true, name: true, email: true, status: true, roleId: true, role: { select: { name: true, isSystem: true } } },
  });
  if (!user || user.status !== 'active') throw unauthorized('Account is not active');

  // Throttled "last active" tracking: at most one write per user per 5 minutes.
  if (await redis.set(activeKey(user.id), '1', 'EX', 300, 'NX')) {
    await prisma.user.update({ where: { id: user.id }, data: { lastActiveAt: new Date() } });
  }

  return {
    userId: user.id,
    sessionId: claims.sid,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    roleName: user.role?.name ?? null,
    isSuperAdmin: Boolean(user.role?.isSystem && user.role.name === SUPER_ADMIN_ROLE),
    permissions: await getRolePermissions(user.roleId),
  };
}

// ── 2FA enrollment ───────────────────────────────────────────────────────────

export async function beginTwoFactorSetup(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.twoFactorEnabled) throw badRequest('Two-factor authentication is already enabled');
  const secret = generateTotpSecret();
  await prisma.user.update({ where: { id: userId }, data: { twoFactorSecret: secret } });
  return { secret, otpauthUrl: otpauthUrl(secret, user.email) };
}

export async function confirmTwoFactorSetup(userId: string, code: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (!user.twoFactorSecret) throw badRequest('Start two-factor setup first');
  if (!verifyTotp(user.twoFactorSecret, code)) throw badRequest('Invalid verification code');
  await prisma.user.update({ where: { id: userId }, data: { twoFactorEnabled: true } });
}

// ── Invitations ──────────────────────────────────────────────────────────────

export async function acceptInvite(token: string, name: string, password: string) {
  const user = await prisma.user.findUnique({ where: { inviteTokenHash: sha256(token) } });
  if (!user || user.status !== 'invited' || !user.inviteExpiresAt || user.inviteExpiresAt < new Date()) {
    throw badRequest('This invitation is invalid or has expired');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: {
      name,
      passwordHash: await hashPassword(password),
      status: 'active',
      inviteTokenHash: null,
      inviteExpiresAt: null,
    },
  });
  return createSession(user.id);
}
