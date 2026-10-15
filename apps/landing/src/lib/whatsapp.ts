/**
 * The WhatsApp address the API hands the page (GET for the buttons, POST for
 * the thank-you), with the tracking code and the lead's ref in the text. The
 * page never holds a number of its own: no address, no WhatsApp link.
 */
const WHATSAPP_HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'web.whatsapp.com', 'whatsapp.com']);

/** The address when it is an https WhatsApp link; null for anything else. */
export function whatsappUrlOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' && WHATSAPP_HOSTS.has(host) ? url.href : null;
  } catch {
    return null;
  }
}

/** Turns a `[data-wa]` button into a real link, or back into a button that leads to the form. */
export function applyWhatsappUrl(anchor: HTMLAnchorElement, url: string | null): void {
  if (url) {
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
  } else {
    anchor.setAttribute('href', '#formulario');
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
  }
}
