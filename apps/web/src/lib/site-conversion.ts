/**
 * The ad platforms' conversion tags on the site form page (`/lp/<slug>`,
 * 2026-10-07): Meta's pixel and Google Ads' conversion tag. Each one is loaded
 * only when the API hands the page its public id (`SiteFormInfo.tracking`),
 * so a page with no id loads no third-party script. A sent form fires Meta's
 * `Lead` and Google Ads' `conversion`; nothing typed in the form is sent to
 * either, only the event.
 */

type Fbq = ((...args: unknown[]) => void) & {
  queue?: unknown[];
  loaded?: boolean;
  version?: string;
};
type Gtag = (...args: unknown[]) => void;

declare global {
  interface Window {
    fbq?: Fbq;
    _fbq?: Fbq;
    gtag?: Gtag;
    dataLayer?: unknown[];
  }
}

export interface ConversionTags {
  metaPixelId: string | null;
  googleAdsConversion: string | null;
}

const META_PIXEL_SCRIPT = 'https://connect.facebook.net/en_US/fbevents.js';
const GTAG_SCRIPT = 'https://www.googletagmanager.com/gtag/js';

function appendScript(doc: Document, src: string): void {
  if (doc.querySelector(`script[src="${src}"]`)) return;
  const script = doc.createElement('script');
  script.async = true;
  script.src = src;
  doc.head.appendChild(script);
}

/** Meta's standard snippet, without the inline script: a queue until fbevents.js arrives. */
function ensureFbq(win: Window): Fbq {
  if (win.fbq) return win.fbq;
  const fbq: Fbq = (...args: unknown[]) => {
    fbq.queue!.push(args);
  };
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = '2.0';
  win.fbq = fbq;
  win._fbq = fbq;
  return fbq;
}

function ensureGtag(win: Window): Gtag {
  if (win.gtag) return win.gtag;
  win.dataLayer = win.dataLayer ?? [];
  const gtag: Gtag = function () {
    // gtag.js reads `arguments`, not an array: keep the call as the browser made it.
    // eslint-disable-next-line prefer-rest-params
    win.dataLayer!.push(arguments);
  };
  win.gtag = gtag;
  return gtag;
}

/** Loads the tags the page has ids for; Meta also counts the page view. Idempotent. */
export function loadConversionTags(win: Window, doc: Document, tags: ConversionTags): void {
  if (tags.metaPixelId) {
    const fbq = ensureFbq(win);
    appendScript(doc, META_PIXEL_SCRIPT);
    fbq('init', tags.metaPixelId);
    fbq('track', 'PageView');
  }
  if (tags.googleAdsConversion) {
    const account = tags.googleAdsConversion.split('/')[0]!;
    const gtag = ensureGtag(win);
    appendScript(doc, `${GTAG_SCRIPT}?id=${encodeURIComponent(account)}`);
    gtag('js', new Date());
    gtag('config', account);
  }
}

/** The lead was saved: one conversion on each platform the page has a tag for. */
export function fireLeadConversion(win: Window, tags: ConversionTags): void {
  if (tags.metaPixelId && win.fbq) win.fbq('track', 'Lead');
  if (tags.googleAdsConversion && win.gtag) {
    win.gtag('event', 'conversion', { send_to: tags.googleAdsConversion });
  }
}
