import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createCpfCrypto } from './cpf-crypto.js';

const keyA = randomBytes(32).toString('base64');
const keyB = randomBytes(32).toString('base64');
const crypto = createCpfCrypto(keyA, keyB);

const CPF = '529.982.247-25';
const CPF_DIGITS = '52998224725';

describe('cpf-crypto', () => {
  it('round-trips a CPF and normalizes formatting', () => {
    expect(crypto.decrypt(crypto.encrypt(CPF))).toBe(CPF_DIGITS);
    expect(crypto.decrypt(crypto.encrypt(CPF_DIGITS))).toBe(CPF_DIGITS);
  });

  it('produces a different ciphertext every time (random IV)', () => {
    expect(crypto.encrypt(CPF)).not.toBe(crypto.encrypt(CPF));
  });

  it('never stores the digits in the ciphertext', () => {
    expect(crypto.encrypt(CPF)).not.toContain(CPF_DIGITS);
  });

  it('gives a stable blind index for lookups', () => {
    expect(crypto.index(CPF)).toBe(crypto.index(CPF_DIGITS));
    expect(crypto.matchesIndex(CPF, crypto.index(CPF_DIGITS))).toBe(true);
    expect(crypto.matchesIndex('111.444.777-35', crypto.index(CPF))).toBe(false);
  });

  it('derives the index from a key, not from the CPF alone', () => {
    const other = createCpfCrypto(keyB, keyA);
    expect(other.index(CPF)).not.toBe(crypto.index(CPF));
  });

  it('rejects tampered ciphertext (GCM auth tag)', () => {
    const payload = Buffer.from(crypto.encrypt(CPF), 'base64');
    const lastIndex = payload.length - 1;
    payload.writeUInt8(payload.readUInt8(lastIndex) ^ 0xff, lastIndex);
    expect(() => crypto.decrypt(payload.toString('base64'))).toThrow();
  });

  it('refuses invalid CPFs and bad keys', () => {
    expect(() => crypto.encrypt('111.111.111-11')).toThrow('Invalid CPF');
    expect(() => createCpfCrypto(keyA, keyA)).toThrow('must differ');
    expect(() => createCpfCrypto(randomBytes(16).toString('base64'), keyB)).toThrow('32 bytes');
  });
});
