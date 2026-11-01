/**
 * Meta's Embedded Signup in the browser (docs/whatsapp/conectar-numero.md). Meta's own JS SDK,
 * loaded only on the numbers screen, opens Meta's window. That window's session event says which
 * WABA was shared, and FB.login's answer carries a code valid for 30 seconds, which goes straight
 * to the API. Nothing here is secret: the app id and the config id are public by design.
 */

interface FacebookLoginResponse {
  authResponse?: { code?: string } | null;
  status?: string;
}

interface FacebookSdk {
  init(options: {
    appId: string;
    autoLogAppEvents: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FacebookLoginResponse) => void,
    options: Record<string, unknown>,
  ): void;
}

declare global {
  interface Window {
    FB?: FacebookSdk;
    fbAsyncInit?: () => void;
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js';
let loading: Promise<FacebookSdk> | null = null;

/** The SDK once per page; a failed load can be tried again. */
export function loadFacebookSdk(appId: string, version: string): Promise<FacebookSdk> {
  if (loading) return loading;
  loading = new Promise<FacebookSdk>((resolve, reject) => {
    window.fbAsyncInit = () => {
      const fb = window.FB;
      if (!fb) return reject(new Error('sdk_unavailable'));
      fb.init({ appId, autoLogAppEvents: true, xfbml: false, version });
      resolve(fb);
    };
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      loading = null;
      script.remove();
      reject(new Error('sdk_unavailable'));
    };
    document.body.appendChild(script);
  });
  return loading;
}

export interface SignupEvent {
  event: string;
  wabaId: string | null;
  phoneNumberId: string | null;
  /** CANCEL: the step where the person stopped, or Meta's error text. */
  detail: string | null;
  /** ERROR: Meta's error code (docs: "Embedded Signup Flow Errors"), for the message and support. */
  errorCode: string | null;
}

const digits = (value: unknown) =>
  typeof value === 'string' && /^\d{1,32}$/.test(value) ? value : null;

/** Meta's session event, read only from Meta's own origin. Anything else is null. */
export function signupEventOf(origin: string, raw: unknown): SignupEvent | null {
  let host: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:') return null;
    host = url.hostname;
  } catch {
    return null;
  }
  if (host !== 'facebook.com' && !host.endsWith('.facebook.com')) return null;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== 'object') return null;
  const message = data as { type?: unknown; event?: unknown; data?: unknown };
  if (message.type !== 'WA_EMBEDDED_SIGNUP' || typeof message.event !== 'string') return null;
  const body = (message.data && typeof message.data === 'object' ? message.data : {}) as Record<
    string,
    unknown
  >;
  const detail = body.current_step ?? body.error_message;
  const errorCode = typeof body.error_code === 'number' ? String(body.error_code) : body.error_code;
  return {
    event: message.event,
    wabaId: digits(body.waba_id),
    phoneNumberId: digits(body.phone_number_id),
    detail: typeof detail === 'string' ? detail.slice(0, 200) : null,
    errorCode: digits(errorCode),
  };
}

/** The coexistence flow: the number stays in the WhatsApp Business app. */
export const COEXISTENCE_FINISH = 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';

export type SignupOutcome =
  | { ok: true; code: string; wabaId: string; phoneNumberId: string | null }
  | {
      ok: false;
      reason: 'cancelled' | 'denied' | 'meta_error' | 'other_flow' | 'no_account' | 'no_code';
      detail: string | null;
      errorCode?: string | null;
    };

/** How long to wait for the session event after the code arrived (the code lives 30 s). */
const SESSION_WAIT_MS = 5_000;

/**
 * Opens Meta's window. Must be called straight from the click (browsers block a popup opened
 * later), so FB.login runs before anything is awaited.
 */
export function runEmbeddedSignup(fb: FacebookSdk, configId: string): Promise<SignupOutcome> {
  return new Promise((resolve) => {
    let session: SignupEvent | null = null;
    let code: string | null = null;
    let done = false;
    const finish = (outcome: SignupOutcome) => {
      if (done) return;
      done = true;
      window.removeEventListener('message', onMessage);
      resolve(outcome);
    };
    const settle = () => {
      if (!code || !session) return;
      if (session.event !== COEXISTENCE_FINISH)
        return finish({ ok: false, reason: 'other_flow', detail: session.event });
      if (!session.wabaId) return finish({ ok: false, reason: 'no_account', detail: null });
      finish({ ok: true, code, wabaId: session.wabaId, phoneNumberId: session.phoneNumberId });
    };
    const onMessage = (event: MessageEvent) => {
      const read = signupEventOf(event.origin, event.data);
      if (!read) return;
      if (read.event === 'CANCEL') finish({ ok: false, reason: 'cancelled', detail: read.detail });
      else if (read.event === 'ERROR')
        finish({ ok: false, reason: 'meta_error', detail: read.detail, errorCode: read.errorCode });
      else if (read.event.startsWith('FINISH')) {
        session = read;
        settle();
      }
    };
    window.addEventListener('message', onMessage);
    fb.login(
      (response) => {
        code = response.authResponse?.code ?? null;
        if (code) {
          settle();
          setTimeout(
            () => finish({ ok: false, reason: 'no_account', detail: null }),
            SESSION_WAIT_MS,
          );
        } else {
          // A cancel event may still be on its way; it wins if it comes.
          const reason = response.status === 'not_authorized' ? 'denied' : 'no_code';
          setTimeout(() => finish({ ok: false, reason, detail: null }), 1_000);
        }
      },
      {
        config_id: configId,
        response_type: 'code',
        override_default_response_type: true,
        // The coexistence flow, as Meta's onboarding page shows it. NOT verified live: whether
        // a v4 configuration still reads featureType here (Meta says v4's extras are empty).
        extras: {
          setup: {},
          featureType: 'whatsapp_business_app_onboarding',
          sessionInfoVersion: '3',
        },
      },
    );
  });
}
