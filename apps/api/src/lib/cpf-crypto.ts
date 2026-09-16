import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { isValidCpf, normalizeCpf } from '@wings/shared';

/**
 * CPF protection (LGPD).
 *
 * Storage format: base64( iv[12] || authTag[16] || ciphertext ) using
 * AES-256-GCM. Lookups never decrypt: they compare an HMAC-SHA256 blind index
 * built with a separate key, so the same CPF always maps to the same index
 * without the index revealing the number.
 *
 * Losing CPF_ENCRYPTION_KEY makes every stored CPF unrecoverable — back the
 * key up outside the server.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CpfCrypto {
  encrypt(cpf: string): string;
  decrypt(payload: string): string;
  index(cpf: string): string;
  matchesIndex(cpf: string, storedIndex: string): boolean;
}

export function createCpfCrypto(encryptionKeyB64: string, indexKeyB64: string): CpfCrypto {
  const encryptionKey = Buffer.from(encryptionKeyB64, 'base64');
  const indexKey = Buffer.from(indexKeyB64, 'base64');
  if (encryptionKey.length !== 32) throw new Error('CPF encryption key must be 32 bytes');
  if (indexKey.length !== 32) throw new Error('CPF index key must be 32 bytes');
  if (encryptionKey.equals(indexKey)) throw new Error('CPF keys must differ');

  function requireValid(cpf: string): string {
    const normalized = normalizeCpf(cpf);
    if (!isValidCpf(normalized)) throw new Error('Invalid CPF');
    return normalized;
  }

  return {
    encrypt(cpf) {
      const normalized = requireValid(cpf);
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },

    decrypt(payload) {
      const raw = Buffer.from(payload, 'base64');
      if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('Malformed CPF ciphertext');
      const iv = raw.subarray(0, IV_BYTES);
      const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = raw.subarray(IV_BYTES + TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    },

    index(cpf) {
      const normalized = requireValid(cpf);
      return createHmac('sha256', indexKey).update(normalized).digest('hex');
    },

    matchesIndex(cpf, storedIndex) {
      const computed = Buffer.from(this.index(cpf), 'hex');
      let stored: Buffer;
      try {
        stored = Buffer.from(storedIndex, 'hex');
      } catch {
        return false;
      }
      return computed.length === stored.length && timingSafeEqual(computed, stored);
    },
  };
}
