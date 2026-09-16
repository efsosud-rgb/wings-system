import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Opaque session token handed to the browser (never stored as-is). */
export function generateToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Sessions and invite links are stored as SHA-256 digests, so a database leak
 * does not hand out usable credentials. SHA-256 is right here (not Argon2):
 * the input is already 256 bits of entropy, and lookups must stay fast.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
