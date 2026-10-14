import { describe, expect, it } from 'vitest';
import { httpsOnly } from './format.js';

describe('httpsOnly: links from Google open only when plain https', () => {
  it('keeps https and drops anything else', () => {
    expect(httpsOnly('https://meet.google.com/abc-defg-hij')).toBe(
      'https://meet.google.com/abc-defg-hij',
    );
    expect(httpsOnly('http://exemplo.com')).toBeNull();
    expect(httpsOnly('javascript:alert(1)')).toBeNull();
    expect(httpsOnly('ms-settings:privacy')).toBeNull();
    expect(httpsOnly('não é endereço')).toBeNull();
    expect(httpsOnly(null)).toBeNull();
  });
});
