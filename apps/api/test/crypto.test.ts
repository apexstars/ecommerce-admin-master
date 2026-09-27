import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/shared/crypto.js';
import { base32Decode, base32Encode, totp, verifyTotp } from '../src/shared/totp.js';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await verifyPassword('anything', null)).toBe(false);
  });
});

describe('TOTP (RFC 6238)', () => {
  // RFC 6238 appendix B test secret "12345678901234567890", SHA-1, truncated to 6 digits.
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('round-trips base32', () => {
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('matches the RFC test vectors', () => {
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(totp(secret, 2_000_000_000_000)).toBe('279037');
  });

  it('accepts ±1 step of clock drift but not more', () => {
    const t = 1_111_111_109_000;
    expect(verifyTotp(secret, totp(secret, t - 30_000), 1, t)).toBe(true);
    expect(verifyTotp(secret, totp(secret, t - 90_000), 1, t)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', 1, t)).toBe(false);
  });
});
