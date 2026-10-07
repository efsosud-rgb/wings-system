import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { siteFormCopyOf, siteFormSubmitSchema } from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import { useSiteForm, useSubmitSiteForm } from '../api/leads.js';
import { Alert, AuthCard, Button, Field, Input } from '../components/ui.js';
import { fireLeadConversion, loadConversionTags } from '../lib/site-conversion.js';
import { captureFirstTouch, type Tracking } from '../lib/site-tracking.js';

/**
 * The page asks the standard form's five questions and nothing else (Nome,
 * WhatsApp, Nome da empresa, Instagram, Site — `lead-form.ts`, 2026-10-07):
 * the same the Meta instant form asks, so both land in the same lead fields.
 * The API still accepts an older page's e-mail and CNPJ. "Não tenho" is an answer.
 */
const askedField = (message: string) => z.string().trim().min(1, message).max(300);
const pageSchema = siteFormSubmitSchema.extend({
  companyName: askedField('Informe o nome da empresa'),
  instagram: askedField('Informe o Instagram (ou “não tenho”)'),
  siteUrl: askedField('Informe o site (ou “não tenho”)'),
});
type PageInput = z.infer<typeof pageSchema>;

/**
 * The site form (CRM phase 1, T5), public: `/lp/<slug>` for the pages CRM
 * Vendas → Landing pages turned the form on. The lead goes into the CRM with
 * the first touch this browser arrived by (UTMs, click ids, ad ids). A robot
 * is kept out by Cloudflare Turnstile (checked again on the server) and a
 * field people never see.
 */

const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

interface TurnstileApi {
  render: (
    element: HTMLElement,
    options: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
      language?: string;
    },
  ) => string;
  reset: (widgetId?: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${TURNSTILE_SCRIPT}"]`);
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () =>
      window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')),
    );
    script.addEventListener('error', () => reject(new Error('turnstile')));
    if (!existing) {
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      document.head.appendChild(script);
    }
  });
}

/** The Turnstile widget; reports the token, or null when it expires or fails. */
function Turnstile({
  siteKey,
  onToken,
}: {
  siteKey: string;
  onToken: (token: string | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !box.current) return;
        api.render(box.current, {
          sitekey: siteKey,
          language: 'pt-BR',
          callback: (token) => onToken(token),
          'expired-callback': () => onToken(null),
          'error-callback': () => onToken(null),
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [siteKey, onToken]);
  return (
    <>
      <div ref={box} className="site-form-captcha" />
      {failed && (
        <Alert kind="error">
          Não foi possível carregar a verificação anti-robô. Recarregue a página.
        </Alert>
      )}
    </>
  );
}

export function SiteFormPage() {
  const { slug = '' } = useParams();
  const info = useSiteForm(slug);
  const submit = useSubmitSiteForm(slug);
  const [tracking, setTracking] = useState<Tracking>({});
  const [token, setToken] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<PageInput>({
    resolver: zodResolver(pageSchema),
    defaultValues: { turnstileToken: '', website: '' },
  });

  useEffect(() => {
    setTracking(captureFirstTouch(document, window.location.href));
  }, []);
  useEffect(() => {
    setValue('turnstileToken', token ?? '');
  }, [token, setValue]);
  // The ad platforms' tags, only for the ids the API handed over (none: no script).
  const tags = info.data?.tracking ?? null;
  useEffect(() => {
    if (tags) loadConversionTags(window, document, tags);
  }, [tags]);

  if (info.isLoading) return <AuthCard title="Carregando…">{null}</AuthCard>;
  if (!info.data) {
    return (
      <AuthCard title="Página não encontrada">
        <p className="muted">Este formulário não existe ou não está mais no ar.</p>
      </AuthCard>
    );
  }

  const onSubmit = handleSubmit((values) =>
    submit.mutate(
      { ...values, page: window.location.href, tracking },
      {
        onSuccess: () => {
          if (tags) fireLeadConversion(window, tags);
        },
      },
    ),
  );
  const failure = submit.error instanceof ApiError ? submit.error : null;
  const copy = siteFormCopyOf(info.data.pipeline, info.data.brand);

  return (
    <AuthCard title={copy.title} subtitle={copy.subtitle}>
      {info.data.instagram && (
        <p className="muted">
          Instagram:{' '}
          <a
            href={`https://www.instagram.com/${info.data.instagram.slice(1)}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {info.data.instagram}
          </a>
        </p>
      )}
      {submit.isSuccess ? (
        <>
          {/* The thank-you Diretoria approved for this page, or the plain one. */}
          {info.data.form ? (
            <Alert kind="success">
              <strong>{info.data.form.thankYou.title}</strong>
              <br />
              {info.data.form.thankYou.body}
            </Alert>
          ) : (
            <Alert kind="success">Recebemos seus dados. Em breve entraremos em contato.</Alert>
          )}
          {info.data.form && (
            <a
              className="btn btn-ghost"
              href={info.data.form.thankYou.buttonUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              {info.data.form.thankYou.buttonText}
            </a>
          )}
          {/* The Wings WhatsApp (Sofia), with the brand in the text; no link, just the thanks. */}
          {submit.data.whatsappUrl && (
            <a
              className="btn btn-primary"
              href={submit.data.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Falar sobre a franquia {info.data.brand} no WhatsApp
            </a>
          )}
        </>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          {/* The page's optional multiple-choice question comes first, as on the ad. */}
          {info.data.form?.qualifier && (
            <fieldset className="site-form-qualifier">
              <legend className="field-label">{info.data.form.qualifier.question}</legend>
              <div className="lead-sheet-options">
                {info.data.form.qualifier.options.map((option) => (
                  <label key={option} className="check lead-sheet-option">
                    <input type="radio" value={option} {...register('qualifierAnswer')} />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label="Nome" error={errors.name?.message} required>
            <Input autoComplete="name" {...register('name')} />
          </Field>
          <Field label="WhatsApp com DDD" error={errors.phone?.message} required>
            <Input type="tel" autoComplete="tel" inputMode="tel" {...register('phone')} />
          </Field>
          <Field label="Nome da empresa" error={errors.companyName?.message} required>
            <Input autoComplete="organization" {...register('companyName')} />
          </Field>
          <Field label="Instagram da empresa" error={errors.instagram?.message} required>
            <Input placeholder="@suaempresa" autoCapitalize="none" {...register('instagram')} />
          </Field>
          <Field label="Site da empresa" error={errors.siteUrl?.message} required>
            <Input
              placeholder="suaempresa.com.br"
              autoCapitalize="none"
              inputMode="url"
              {...register('siteUrl')}
            />
          </Field>
          {/* People never see this field; a robot that fills it is dropped by the server. */}
          <div className="sr-only" aria-hidden="true">
            <label>
              Site
              <input tabIndex={-1} autoComplete="off" {...register('website')} />
            </label>
          </div>
          <label className="field field-inline">
            <input type="checkbox" {...register('consent')} />
            <span>{copy.consentText}</span>
          </label>
          {errors.consent?.message && <p className="field-error">{errors.consent.message}</p>}
          {info.data.form?.privacyPolicyUrl && (
            <p className="muted site-form-privacy">
              <a href={info.data.form.privacyPolicyUrl} target="_blank" rel="noopener noreferrer">
                Política de Privacidade
              </a>
            </p>
          )}

          {info.data.turnstileSiteKey ? (
            <Turnstile siteKey={info.data.turnstileSiteKey} onToken={setToken} />
          ) : (
            <Alert kind="warning">O formulário ainda está em configuração.</Alert>
          )}
          {errors.turnstileToken?.message && !token && (
            <p className="field-error">{errors.turnstileToken.message}</p>
          )}

          {failure && <Alert kind="error">{failure.message}</Alert>}

          <Button
            type="submit"
            disabled={submit.isPending || !info.data.turnstileSiteKey || !token}
          >
            {submit.isPending ? 'Enviando…' : copy.button}
          </Button>
        </form>
      )}
    </AuthCard>
  );
}
