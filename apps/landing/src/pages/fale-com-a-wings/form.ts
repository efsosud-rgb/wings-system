import { instagramUsernameOf } from '@wings/shared/instagram';
import { submitSiteForm, type LoadResult, type SiteFormSpec } from '../../lib/api.js';
import {
  CONSENT_MESSAGE,
  FIELD_RULES,
  instagramOk,
  maskPhone,
  missingLineOf,
  missingOf,
} from '../../lib/form-rules.js';
import { submitBodyOf, type FormValues } from '../../lib/payload.js';
import type { Tracking } from '../../lib/tracking.js';
import { renderTurnstile, type TurnstileWidget } from '../../lib/turnstile.js';
import { applyWhatsappUrl } from '../../lib/whatsapp.js';

/**
 * The approved form, wired to the API: the button turns on only with every
 * field filled, the consent ticked and the robot check passed; the line under
 * it says what is still missing. A sent form gives way to the thank-you.
 */

export const SEND_LABEL = 'Enviar e falar com a Wings';
export const SENDING_LABEL = 'Enviando…';

export const MESSAGES = {
  captchaLoading: 'Carregando a verificação antirrobô…',
  captchaScriptFailed: 'Não foi possível carregar a verificação antirrobô. Recarregue a página.',
  captchaNotConfigured:
    'A verificação antirrobô está indisponível agora. Tente de novo em instantes.',
  formNotFound: 'Este formulário não está disponível no momento.',
  loadFailed: 'Não foi possível carregar o formulário. Recarregue a página.',
  captchaRefused: 'A verificação antirrobô não passou. Faça a verificação de novo e envie.',
  rateLimited: 'Muitas tentativas. Tente de novo em alguns minutos.',
  unavailable: 'Não foi possível enviar agora. Tente de novo em instantes.',
} as const;

export interface FormSetup {
  slug: string;
  apiBase: string;
  reduce: boolean;
  tracking: () => Tracking;
  /** The WhatsApp link the GET gave, for a thank-you whose POST gave none. */
  whatsappUrl: () => string | null;
  /** After a sent form: the chosen option's value, for the dataLayer. */
  onSent: (answer: string) => void;
}

export interface FormController {
  /** What the GET answered: the robot check's key and the page's form spec. */
  configure(result: LoadResult): void;
}

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

export function setupForm(setup: FormSetup): FormController {
  const f = byId<HTMLFormElement>('lead-form'),
    tel = byId<HTMLInputElement>('f-tel'),
    ig = byId<HTMLInputElement>('f-ig'),
    send = byId<HTMLButtonElement>('f-send'),
    sendLabel = send.querySelector('span') ?? send,
    missing = byId('f-missing'),
    sendError = byId('f-error'),
    thanks = byId('thanks'),
    consent = byId<HTMLInputElement>('f-consent'),
    slot = byId('f-bot'),
    widgetBox = byId('f-bot-widget'),
    honeypot = byId<HTMLInputElement>('f-hp'),
    qualifier = byId<HTMLSelectElement>('f-int');

  let token: string | null = null;
  let widget: TurnstileWidget | null = null;
  let spec: SiteFormSpec | null = null;
  let sending = false;

  const slotMessage = (text: string | null) => {
    let line = slot.querySelector<HTMLElement>('.bot-msg');
    if (!text) {
      line?.remove();
      return;
    }
    if (!line) {
      line = document.createElement('span');
      line.className = 'bot-msg';
      slot.appendChild(line);
    }
    line.textContent = text;
  };

  tel.addEventListener('input', () => {
    tel.value = maskPhone(tel.value);
  });
  // accepts "@marca", "marca" or the profile address; keeps only the username
  ig.addEventListener('blur', () => {
    if (ig.value && instagramOk(ig.value)) ig.value = instagramUsernameOf(ig.value) ?? ig.value;
  });

  const valueOf = (id: string) => byId<HTMLInputElement | HTMLSelectElement>(id).value;
  const touched = new Set<string>();

  function check(showAll: boolean): boolean {
    const values: Record<string, string> = {};
    let allValid = true;
    for (const rule of FIELD_RULES) {
      const el = byId<HTMLInputElement | HTMLSelectElement>(rule.id),
        field = el.closest('.field'),
        value = el.value,
        good = rule.ok(value),
        filled = value.trim() !== '';
      values[rule.id] = value;
      if (!good) allValid = false;
      const show = showAll || touched.has(rule.id);
      const flagged = !good && show && (filled || showAll);
      byId(rule.errorId).textContent = flagged ? rule.message : '';
      if (flagged) {
        field?.setAttribute('data-error', '');
        el.setAttribute('aria-invalid', 'true');
      } else {
        field?.removeAttribute('data-error');
        el.removeAttribute('aria-invalid');
      }
      if (good && filled) field?.setAttribute('data-ok', '');
      else field?.removeAttribute('data-ok');
    }
    byId('e-consent').textContent = !consent.checked && showAll ? CONSENT_MESSAGE : '';
    const lacking = missingOf(values, consent.checked, token !== null);
    send.disabled = sending || lacking.length > 0;
    const line = missingLineOf(lacking);
    missing.classList.toggle('ready', line.ready);
    missing.textContent = line.text;
    return allValid && lacking.length === 0;
  }

  const touch = (e: Event) => {
    const target = e.target as HTMLElement | null;
    if (target?.id) touched.add(target.id);
    check(false);
  };
  f.addEventListener('input', touch);
  f.addEventListener('change', touch);
  f.addEventListener('focusout', (e) => {
    if ((e.target as HTMLElement | null)?.id) touch(e);
  });
  check(false);

  const setToken = (value: string | null) => {
    token = value;
    check(false);
  };

  function resetCaptcha() {
    token = null;
    widget?.reset();
    check(false);
  }

  function setSending(on: boolean) {
    sending = on;
    sendLabel.textContent = on ? SENDING_LABEL : SEND_LABEL;
    send.setAttribute('aria-busy', String(on));
    check(false);
  }

  function showThanks(url: string | null) {
    const button = thanks.querySelector<HTMLAnchorElement>('[data-wa]');
    if (button) {
      applyWhatsappUrl(button, url);
      button.hidden = !url;
    }
    f.hidden = true;
    thanks.hidden = false;
    thanks.scrollIntoView({ behavior: setup.reduce ? 'auto' : 'smooth', block: 'center' });
  }

  f.addEventListener('submit', (e) => {
    e.preventDefault();
    if (sending) return;
    sendError.textContent = '';
    if (!check(true)) {
      const bad =
        f.querySelector<HTMLElement>('[aria-invalid="true"]') ?? (consent.checked ? slot : consent);
      bad.focus();
      return;
    }
    const currentToken = token;
    if (!currentToken) return;
    const option = qualifier.selectedOptions[0];
    const values: FormValues = {
      name: valueOf('f-nome'),
      phone: valueOf('f-tel'),
      email: valueOf('f-email'),
      companyName: valueOf('f-empresa'),
      instagram: valueOf('f-ig'),
      siteUrl: valueOf('f-site'),
      qualifierValue: qualifier.value,
      qualifierText: option?.textContent?.trim() ?? '',
      website: honeypot.value,
    };
    const body = submitBodyOf({
      values,
      tracking: setup.tracking(),
      turnstileToken: currentToken,
      href: location.href,
      form: spec,
    });
    setSending(true);
    void submitSiteForm(setup.apiBase, setup.slug, body).then((result) => {
      if (result.kind === 'ok') {
        sending = false;
        setup.onSent(values.qualifierValue);
        showThanks(result.whatsappUrl ?? setup.whatsappUrl());
        return;
      }
      setSending(false);
      if (result.kind === 'invalid') {
        // checked before the robot check spends its token: the token still holds
        sendError.textContent = result.message;
        return;
      }
      resetCaptcha();
      sendError.textContent =
        result.kind === 'captcha_refused'
          ? MESSAGES.captchaRefused
          : result.kind === 'rate_limited'
            ? MESSAGES.rateLimited
            : MESSAGES.unavailable;
    });
  });

  return {
    configure(result) {
      if (result.kind !== 'ok') {
        slotMessage(result.kind === 'not_found' ? MESSAGES.formNotFound : MESSAGES.loadFailed);
        return;
      }
      spec = result.info.form;
      const siteKey = result.info.turnstileSiteKey;
      if (!siteKey) {
        slotMessage(MESSAGES.captchaNotConfigured);
        return;
      }
      renderTurnstile(widgetBox, siteKey, setToken, (message) => slotMessage(message))
        .then((rendered) => {
          widget = rendered;
          slotMessage(null);
        })
        .catch(() => slotMessage(MESSAGES.captchaScriptFailed));
    },
  };
}
