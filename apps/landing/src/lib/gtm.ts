/**
 * Google Tag Manager, the standard snippet for the container the runtime
 * config names (LANDING_GTM_ID); no id, no tag. The dataLayer exists either
 * way, so the page's events (`whatsapp_click`, `lead_submit`) never break.
 */

declare global {
  interface Window {
    dataLayer?: unknown[];
  }
}

export const GTM_SCRIPT = 'https://www.googletagmanager.com/gtm.js';

export function initDataLayer(w: Window = window): unknown[] {
  w.dataLayer = w.dataLayer || [];
  return w.dataLayer;
}

export function installGtm(id: string | null, w: Window = window, d: Document = document): void {
  const dataLayer = initDataLayer(w);
  if (!id) return;
  dataLayer.push({ 'gtm.start': new Date().getTime(), event: 'gtm.js' });
  const script = d.createElement('script');
  script.async = true;
  script.src = `${GTM_SCRIPT}?id=${encodeURIComponent(id)}`;
  const first = d.getElementsByTagName('script')[0];
  if (first?.parentNode) first.parentNode.insertBefore(script, first);
  else d.head.appendChild(script);
}

export function pushEvent(event: Record<string, unknown>, w: Window = window): void {
  initDataLayer(w).push(event);
}
