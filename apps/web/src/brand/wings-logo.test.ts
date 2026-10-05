import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { logoSvgString, type WingsLogoVariant } from './wings-logo.js';

/** The hashes of the official files sent with the brand manual extraction. */
const OFFICIAL: Record<WingsLogoVariant, string> = {
  principal: '79a132471af9cf6d3b9ceb1a5730b6a852f17e7e4091b2afafd28ac0de27772d',
  negativo: '7ca0567400696a7cbcba5fac617100c89f791228cbb06e1dd35612643df64476',
  laranja: '459b9b8171995c708e2d2130941cc4f6d4d26e138811de0135049747b39fe51e',
  simbolo: 'de3aeeb1ba9ad14db46532bbdf26472541d9acb16197c60382cff0d7515b4818',
};

describe('official Wings logo', () => {
  for (const variant of Object.keys(OFFICIAL) as WingsLogoVariant[]) {
    it(`${variant}: the markup is byte-identical to the official SVG`, () => {
      const hash = createHash('sha256').update(logoSvgString(variant)).digest('hex');
      expect(hash).toBe(OFFICIAL[variant]);
    });
  }
});
