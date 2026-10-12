import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearSessionExpired,
  forgetSignedIn,
  markSessionExpired,
  onUnauthorized,
  rememberSignedIn,
  reportUnauthorized,
  safeReturnPath,
  sessionExpiredInThisTab,
  wasSignedIn,
} from './session-expiry.js';

afterEach(() => {
  onUnauthorized(null);
  clearSessionExpired();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('safeReturnPath — where signing in may send the person back to', () => {
  it.each([
    ['/inicio', '/inicio'],
    ['/crm-vendas/negociacoes/abc-123', '/crm-vendas/negociacoes/abc-123'],
    ['/crm-vendas/tarefas?filtro=abertas#topo', '/crm-vendas/tarefas?filtro=abertas#topo'],
    ['/', '/'],
  ])('keeps %s', (input, expected) => {
    expect(safeReturnPath(input)).toBe(expected);
  });

  it.each([
    ['another site, scheme-relative', '//evil.example/x'],
    ['another site, absolute', 'https://evil.example/x'],
    ['backslash trick', '/\\evil.example'],
    ['not a path', 'inicio'],
    ['empty', ''],
    ['control character', '/inicio\n/x'],
    ['the login itself', '/login'],
    ['the login with a query', '/login?x=1'],
    ['a screen that needs no session', '/esqueci-senha'],
    ['the invite link page', '/definir-senha'],
    ['the reset link page', '/redefinir-senha'],
    ['a public landing page', '/lp/odin'],
  ])('refuses %s', (_name, input) => {
    expect(safeReturnPath(input)).toBeUndefined();
  });

  it('refuses what is not a string', () => {
    expect(safeReturnPath(undefined)).toBeUndefined();
    expect(safeReturnPath(null)).toBeUndefined();
    expect(safeReturnPath({ from: '/x' })).toBeUndefined();
  });
});

describe('the expired flag', () => {
  it('stays set until the next login clears it', () => {
    expect(sessionExpiredInThisTab()).toBe(false);
    markSessionExpired();
    expect(sessionExpiredInThisTab()).toBe(true);
    clearSessionExpired();
    expect(sessionExpiredInThisTab()).toBe(false);
  });
});

describe('the unauthorized listener', () => {
  it('is called for each report and can be removed', () => {
    const listener = vi.fn();
    onUnauthorized(listener);
    reportUnauthorized();
    reportUnauthorized();
    expect(listener).toHaveBeenCalledTimes(2);
    onUnauthorized(null);
    reportUnauthorized();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('the "this browser had a session" flag', () => {
  it('is set at sign-in and cleared at sign-out', () => {
    expect(wasSignedIn()).toBe(false);
    rememberSignedIn();
    expect(wasSignedIn()).toBe(true);
    forgetSignedIn();
    expect(wasSignedIn()).toBe(false);
  });

  it('survives blocked storage: nothing throws, the answer is no', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberSignedIn()).not.toThrow();
    expect(() => forgetSignedIn()).not.toThrow();
    expect(wasSignedIn()).toBe(false);
  });
});
