import { jwtVerify, SignJWT, type JWTPayload } from 'jose';

const ISSUER = 'shop-api';
const encoder = new TextEncoder();

export async function signJwt(
  secret: string,
  audience: string,
  subject: string,
  ttlSeconds: number,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(encoder.encode(secret));
}

/** Returns null for any invalid/expired/wrong-audience token. */
export async function verifyJwt<T extends JWTPayload = JWTPayload>(
  secret: string,
  audience: string,
  token: string,
): Promise<(T & { sub: string }) | null> {
  try {
    const { payload } = await jwtVerify(token, encoder.encode(secret), {
      issuer: ISSUER,
      audience,
      algorithms: ['HS256'],
    });
    if (!payload.sub) return null;
    return payload as T & { sub: string };
  } catch {
    return null;
  }
}
