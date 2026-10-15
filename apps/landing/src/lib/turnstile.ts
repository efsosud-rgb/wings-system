/**
 * Cloudflare Turnstile, rendered explicitly into the form's robot-check slot
 * (`.bot-slot`), and only when the API gives a site key. The token goes with
 * the POST and the server checks it again; it is single use, so the widget is
 * reset after every failed send, when it expires and when it errors.
 */

export const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileOptions {
  sitekey: string;
  callback: (token: string) => void;
  'expired-callback': () => void;
  'error-callback': (code?: string) => boolean | void;
  'timeout-callback'?: () => void;
  language?: string;
  theme?: 'light' | 'dark' | 'auto';
  size?: 'normal' | 'flexible' | 'compact';
}

export interface TurnstileApi {
  render: (element: HTMLElement, options: TurnstileOptions) => string | undefined;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(d: Document = document): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;
  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = d.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')),
    );
    script.addEventListener('error', () => reject(new Error('turnstile')));
    d.head.appendChild(script);
  }).catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

export interface TurnstileWidget {
  reset(): void;
}

/** How many times an erroring widget is reset on its own before the page asks for a reload. */
const ERROR_RESETS = 3;

/**
 * Renders the widget into `box`. `onToken` gets the token, or null when there
 * is none (expired, errored, reset); `onFailure` gets a pt-BR message when the
 * widget cannot recover by itself.
 */
export async function renderTurnstile(
  box: HTMLElement,
  siteKey: string,
  onToken: (token: string | null) => void,
  onFailure: (message: string) => void,
): Promise<TurnstileWidget> {
  const api = await loadTurnstile();
  const widget: { id?: string } = {};
  let errors = 0;
  const reset = () => {
    onToken(null);
    try {
      api.reset(widget.id);
    } catch {
      // the widget is gone; nothing to reset
    }
  };
  widget.id = api.render(box, {
    sitekey: siteKey,
    language: 'pt-BR',
    theme: 'light',
    size: 'flexible',
    callback: (token) => {
      errors = 0;
      onToken(token);
    },
    'expired-callback': reset,
    'timeout-callback': reset,
    'error-callback': () => {
      errors += 1;
      if (errors <= ERROR_RESETS) setTimeout(reset, 1500);
      else {
        onToken(null);
        onFailure('A verificação antirrobô não carregou. Recarregue a página para tentar de novo.');
      }
      // handled here, so Turnstile does not log it
      return true;
    },
  });
  return { reset };
}
