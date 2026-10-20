import { afterEach, describe, expect, it, vi } from 'vitest';
import { COEXISTENCE_FINISH, runEmbeddedSignup, signupEventOf } from './embedded-signup.js';

const WABA = '3100000000000001';
const meta = (event: string, data: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', event, data, version: 3 });

describe('signupEventOf', () => {
  it('reads Meta’s session event, as a string or an object', () => {
    expect(
      signupEventOf('https://www.facebook.com', meta(COEXISTENCE_FINISH, { waba_id: WABA })),
    ).toEqual({ event: COEXISTENCE_FINISH, wabaId: WABA, phoneNumberId: null, detail: null });
    expect(
      signupEventOf('https://web.facebook.com', {
        type: 'WA_EMBEDDED_SIGNUP',
        event: 'CANCEL',
        data: { current_step: 'PHONE_NUMBER_SETUP' },
      }),
    ).toMatchObject({ event: 'CANCEL', detail: 'PHONE_NUMBER_SETUP' });
  });

  it('ignores any other origin, plain http, other messages and bad ids', () => {
    const body = meta(COEXISTENCE_FINISH, { waba_id: WABA });
    expect(signupEventOf('https://evil.example', body)).toBeNull();
    expect(signupEventOf('https://facebook.com.evil.example', body)).toBeNull();
    expect(signupEventOf('https://notfacebook.com', body)).toBeNull();
    expect(signupEventOf('http://www.facebook.com', body)).toBeNull();
    expect(signupEventOf('https://www.facebook.com', '{not json')).toBeNull();
    expect(
      signupEventOf('https://www.facebook.com', { type: 'OTHER', event: 'FINISH' }),
    ).toBeNull();
    expect(
      signupEventOf('https://www.facebook.com', meta(COEXISTENCE_FINISH, { waba_id: '12/../x' })),
    ).toMatchObject({ wabaId: null });
  });
});

describe('runEmbeddedSignup', () => {
  afterEach(() => vi.useRealTimers());

  const post = (data: string, origin = 'https://www.facebook.com') =>
    window.dispatchEvent(new MessageEvent('message', { data, origin }));

  it('opens Meta’s window at once and joins the code with the WABA of the session event', async () => {
    const login = vi.fn(
      (callback: (r: { authResponse?: { code?: string } }) => void, _options?: unknown) => {
        post(meta(COEXISTENCE_FINISH, { waba_id: WABA }));
        callback({ authResponse: { code: 'the-code' } });
      },
    );
    const outcome = await runEmbeddedSignup({ init: vi.fn(), login }, '987654321');
    expect(login).toHaveBeenCalledTimes(1);
    expect(login.mock.calls[0]![1]).toMatchObject({
      config_id: '987654321',
      response_type: 'code',
      override_default_response_type: true,
      extras: { featureType: 'whatsapp_business_app_onboarding' },
    });
    expect(outcome).toEqual({ ok: true, code: 'the-code', wabaId: WABA, phoneNumberId: null });
  });

  it('waits for a session event that comes after the code', async () => {
    let answer: ((r: { authResponse?: { code?: string } }) => void) | undefined;
    const pending = runEmbeddedSignup(
      { init: vi.fn(), login: (callback) => void (answer = callback) },
      '1',
    );
    answer!({ authResponse: { code: 'c' } });
    post(meta(COEXISTENCE_FINISH, { waba_id: WABA, phone_number_id: '42' }));
    await expect(pending).resolves.toEqual({
      ok: true,
      code: 'c',
      wabaId: WABA,
      phoneNumberId: '42',
    });
  });

  it('refuses a cancel, another flow, and a code with no session event', async () => {
    const cancelled = runEmbeddedSignup(
      { init: vi.fn(), login: () => post(meta('CANCEL', { current_step: 'QR' })) },
      '1',
    );
    await expect(cancelled).resolves.toEqual({ ok: false, reason: 'cancelled', detail: 'QR' });

    const other = runEmbeddedSignup(
      {
        init: vi.fn(),
        login: (callback) => {
          post(meta('FINISH', { waba_id: WABA, phone_number_id: '42' }));
          callback({ authResponse: { code: 'c' } });
        },
      },
      '1',
    );
    await expect(other).resolves.toMatchObject({ ok: false, reason: 'other_flow' });

    vi.useFakeTimers();
    const lonely = runEmbeddedSignup(
      { init: vi.fn(), login: (callback) => callback({ authResponse: { code: 'c' } }) },
      '1',
    );
    vi.advanceTimersByTime(5_000);
    await expect(lonely).resolves.toMatchObject({ ok: false, reason: 'no_account' });

    const closed = runEmbeddedSignup(
      { init: vi.fn(), login: (callback) => callback({ authResponse: null }) },
      '1',
    );
    vi.advanceTimersByTime(1_000);
    await expect(closed).resolves.toMatchObject({ ok: false, reason: 'no_code' });
  });

  it('a message from another origin does not finish anything', async () => {
    vi.useFakeTimers();
    const pending = runEmbeddedSignup(
      {
        init: vi.fn(),
        login: (callback) => {
          post(meta(COEXISTENCE_FINISH, { waba_id: WABA }), 'https://evil.example');
          callback({ authResponse: { code: 'c' } });
        },
      },
      '1',
    );
    vi.advanceTimersByTime(5_000);
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'no_account' });
  });
});
