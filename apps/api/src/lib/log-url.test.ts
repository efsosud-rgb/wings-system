import { describe, expect, it } from 'vitest';
import { loggedUrl } from './log-url.js';

describe('loggedUrl', () => {
  it('drops the query string, secret included', () => {
    expect(loggedUrl('/integrations/rd-station/webhook?secret=abc')).toBe(
      '/integrations/rd-station/webhook',
    );
    expect(loggedUrl('/leads?email=a@b.c&x=1')).toBe('/leads');
  });

  it('keeps a path without a query as it is', () => {
    expect(loggedUrl('/health')).toBe('/health');
    expect(loggedUrl('/')).toBe('/');
  });
});
