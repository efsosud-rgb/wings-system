import '../fale-com-a-wings/style.css';
import './embed.css';
import { loadSiteForm } from '../../lib/api.js';
import {
  LEAD_MESSAGE,
  embedOptionsOf,
  heightMessageOf,
  parentTargetsOf,
  withHomeSource,
} from '../../lib/embed.js';
import { primeInlineFonts } from '../../lib/fonts.js';
import { installGtm, pushEvent } from '../../lib/gtm.js';
import { readRuntimeConfig } from '../../lib/runtime-config.js';
import { captureOrigin, dataLayerOriginOf, trackingPayloadOf } from '../../lib/tracking.js';
import { setupForm } from '../fale-com-a-wings/form.js';

/**
 * The form of "Fale com a Wings" inside an iframe on wingscompany.com.br
 * (`/embed/formulario`): the same markup, rules, robot check and POST as the
 * page (`fale-com-a-wings/form.ts`), on a transparent background with white
 * letters. The lead goes to the Wings System, `/public/site-forms/fale-com-a-wings`.
 *
 * Tags, as on the page: it loads the same Google Tag Manager container, which brings the RD
 * Station script that sends the form to RD (identifier `lead-form`, the form's id), GA4,
 * Google Ads and Meta. So the Wings site must NOT fire a conversion of its own on the
 * `wings-lead` message below: the container in here already counts it.
 */

export const SLUG = 'fale-com-a-wings';

primeInlineFonts(['Limelight', 'Nunito']);

const config = readRuntimeConfig(document, import.meta.env.VITE_LANDING_API_BASE || '/api');
installGtm(config.gtmId);
const options = embedOptionsOf(location.search);
const framed = window.parent !== window;

// before the first frame (the module blocks rendering), so nothing shifts
const doc = document.documentElement;
doc.classList.toggle('with-title', options.title);
doc.classList.toggle('standalone', !framed);

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
// the UTMs and click ids come in the iframe's address, put there by the site; the referrer is the visitor's (`ref`)
const origin = captureOrigin(location.search, options.referrer, storage);

/** Tells the site that frames the form; to its origins only, and nothing when opened on its own. */
const targets = parentTargetsOf(location.ancestorOrigins?.[0], document.referrer);
function tell(message: Record<string, unknown>) {
  if (!framed) return;
  for (const target of targets) window.parent.postMessage(message, target);
}

let whatsappUrl: string | null = null;
const form = setupForm({
  slug: SLUG,
  apiBase: config.apiBase,
  reduce: matchMedia('(prefers-reduced-motion: reduce)').matches,
  embedded: true,
  turnstileTheme: 'dark',
  href: options.page ?? location.href,
  tracking: () => withHomeSource(trackingPayloadOf(origin)),
  whatsappUrl: () => whatsappUrl,
  onSent: (answer) => {
    pushEvent({ event: 'lead_submit', interesse: answer, origem: dataLayerOriginOf(origin) });
    tell(LEAD_MESSAGE);
  },
});

void loadSiteForm(config.apiBase, SLUG).then((result) => {
  whatsappUrl = result.kind === 'ok' ? result.info.whatsappUrl : null;
  form.configure(result);
});

// the site sizes the iframe to the form, which grows with an error line and shrinks to the thank-you
let lastHeight = -1;
new ResizeObserver(() => {
  const height = Math.ceil(document.body.getBoundingClientRect().height);
  if (height === lastHeight) return;
  lastHeight = height;
  tell(heightMessageOf(height));
}).observe(document.body);
