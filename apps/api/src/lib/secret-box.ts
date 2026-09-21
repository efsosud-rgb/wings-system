import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption at rest for credentials of external services (OAuth tokens).
 *
 * Same construction as the CPF (AES-256-GCM, base64 of iv || tag || ciphertext)
 * under a key of its own, INTEGRATIONS_ENCRYPTION_KEY. A separate key on
 * purpose: rotating it after a leak only costs reconnecting an integration,
 * while the CPF key can never be rotated casually — losing it loses every CPF.
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface SecretBox {
  seal(plaintext: string): string;
  open(payload: string): string;
}

export function createSecretBox(keyB64: string): SecretBox {
  const key = Buffer.from(keyB64, 'base64');
  if (key.length !== 32) throw new Error('integrations key must be 32 bytes');

  return {
    seal(plaintext) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
    },
    open(payload) {
      const raw = Buffer.from(payload, 'base64');
      if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('malformed ciphertext');
      const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, IV_BYTES));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    },
  };
}
