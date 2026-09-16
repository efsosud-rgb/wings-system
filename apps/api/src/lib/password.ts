import argon2 from 'argon2';

/**
 * Argon2id with the OWASP-recommended baseline (19 MiB, 2 iterations,
 * parallelism 1). Only the resulting hash is ever stored.
 */
const OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTIONS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    // Malformed hash in the database must read as "wrong password", never as a crash.
    return false;
  }
}

/**
 * Burns roughly the same CPU as a real verification. Used when the e-mail does
 * not exist, so response timing cannot be used to enumerate accounts.
 */
export async function fakeVerify(): Promise<void> {
  await argon2.hash('timing-equalizer', OPTIONS);
}
