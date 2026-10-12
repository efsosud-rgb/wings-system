import {
  LEAD_CAPTURE_LABEL,
  LEAD_FORM_QUALIFIER_MAX_OPTIONS,
  LEAD_FORM_QUALIFIER_QUESTION_MAX,
  LEAD_FORM_QUALIFIER_SUGGESTION,
  LEAD_FORM_QUESTIONS,
  LEAD_FORM_THANK_YOU_BODY_MAX,
  LEAD_FORM_THANK_YOU_BUTTON_MAX,
  LEAD_FORM_THANK_YOU_TITLE_MAX,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  siteFormSpecSchema,
  type CampaignDraftInput,
  type LeadCapture,
  type SiteFormSpec,
} from '@wings/shared';
import { useEffect, useMemo, useState } from 'react';
import type { FieldErrors, UseFormRegister, UseFormSetValue } from 'react-hook-form';
import { useClients } from '../../api/clients.js';
import {
  useApproveSiteForm,
  useMetaLeadFormReadiness,
  useProposeSiteForm,
  useRejectSiteForm,
  useSiteFormPages,
  type SiteFormPage,
} from '../../api/lead-forms.js';
import { LoadFailure } from '../LoadFailure.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
import { SiteFormPreview } from './LeadFormPreview.js';

/**
 * Section "Formulário" of the builder, for a lead campaign.
 *
 * On Meta the person chooses where the lead is captured: the destination page
 * (as before) or Wings' standard form inside the ad. On YouTube the ad leads
 * to a site page `/lp/<slug>` with the same form (Google's Demand Gen takes no
 * lead form, 2026-10-06). Either way the form is the standard one: the five
 * questions are fixed; what is edited is the optional multiple-choice
 * question, the policy link, the thank-you and the funnel.
 *
 * Nothing here writes to Meta. A change to a site page's form is a proposal,
 * live only when someone with `ads.approve` clicks it — never the proposer.
 */

export type LeadFormValues = NonNullable<CampaignDraftInput['leadForm']>;

const DEFAULT_PRIVACY_URL = 'https://wingscompany.com.br/politica-de-privacidade/';

/** The brand's site: where a thank-you button goes when nothing else was said. */
export const WINGS_SITE_URL = 'https://wingscompany.com.br/';

/**
 * The form as the preview and the site proposal need it, or null while it is
 * not valid yet. The thank-you button falls back to `buttonUrl` (the
 * campaign's destination on Meta, the Wings site on a page).
 */
export function siteFormOf(
  values: LeadFormValues | undefined,
  buttonUrl = WINGS_SITE_URL,
): SiteFormSpec | null {
  if (!values) return null;
  const parsed = siteFormSpecSchema.safeParse({
    qualifier: values.qualifier ?? null,
    privacyPolicyUrl: values.privacyPolicyUrl,
    thankYou: { ...values.thankYou, buttonUrl: values.thankYou?.buttonUrl || buttonUrl },
  });
  return parsed.success ? parsed.data : null;
}

export function LeadFormSection({
  platform,
  leadCapture,
  leadForm,
  pageId,
  destinationUrl,
  register,
  setValue,
  errors,
  canApprove,
}: {
  platform: 'meta' | 'youtube' | 'google_search';
  leadCapture: LeadCapture | undefined;
  leadForm: LeadFormValues | undefined;
  pageId: string | undefined;
  destinationUrl: string;
  register: UseFormRegister<CampaignDraftInput>;
  setValue: UseFormSetValue<CampaignDraftInput>;
  errors: FieldErrors<CampaignDraftInput>;
  /** `ads.approve`: may approve a site page's pending form here. */
  canApprove: boolean;
}) {
  const meta = platform === 'meta';
  const instant = meta && leadCapture === 'instant_form';
  const readiness = useMetaLeadFormReadiness(meta ? pageId : undefined);
  const pages = useSiteFormPages(true);
  const clients = useClients();
  const propose = useProposeSiteForm();
  const approve = useApproveSiteForm();
  const reject = useRejectSiteForm();
  const filled = { shouldDirty: true, shouldValidate: false };

  // The site page the destination points at, when it is one of ours.
  const sitePage = useMemo(() => {
    const match = /\/lp\/([^/?#]+)/.exec(destinationUrl);
    return match ? (pages.data?.pages.find((page) => page.slug === match[1]) ?? null) : null;
  }, [destinationUrl, pages.data]);

  // The multiple-choice options are typed one per line.
  const [optionsText, setOptionsText] = useState((leadForm?.qualifier?.options ?? []).join('\n'));
  const qualifierOn = Boolean(leadForm?.qualifier);
  useEffect(() => {
    if (!qualifierOn) return;
    const options = optionsText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, LEAD_FORM_QUALIFIER_MAX_OPTIONS);
    setValue('leadForm.qualifier.options', options, filled);
    // `filled` is a constant object: listing it would re-run on every render.
  }, [optionsText, qualifierOn, setValue]);

  // The policy the Page's current forms use, offered once it is known.
  const suggestedPolicy = readiness.data?.privacyPolicyUrl ?? null;
  useEffect(() => {
    if (suggestedPolicy && !leadForm?.privacyPolicyUrl) {
      setValue('leadForm.privacyPolicyUrl', suggestedPolicy, filled);
    }
  }, [suggestedPolicy]);

  const toggleQualifier = (on: boolean) => {
    if (on) {
      setValue(
        'leadForm.qualifier',
        {
          question: LEAD_FORM_QUALIFIER_SUGGESTION.question,
          options: [...LEAD_FORM_QUALIFIER_SUGGESTION.options],
        },
        filled,
      );
      setOptionsText(LEAD_FORM_QUALIFIER_SUGGESTION.options.join('\n'));
    } else {
      setValue('leadForm.qualifier', null, filled);
    }
  };

  const choosePage = (page: SiteFormPage | null) => {
    if (!page) return;
    setValue('destinationUrl', `${window.location.origin}${page.path}`, filled);
    setValue('leadCapture', 'page', filled);
    // The page's funnel is the page's rule: shown, not edited here.
    setValue(
      'leadForm.funnel',
      {
        pipeline: (page.pipeline as LeadFormValues['funnel']['pipeline']) ?? 'formatacao',
        brand: page.pipeline === 'expansao' ? page.brand : null,
        clientId: page.clientId,
      },
      filled,
    );
    // Start the proposal from what the page shows today (or waits for).
    const current = page.pending?.form ?? page.form;
    if (current) {
      setValue('leadForm.qualifier', current.qualifier, filled);
      setOptionsText((current.qualifier?.options ?? []).join('\n'));
      setValue('leadForm.privacyPolicyUrl', current.privacyPolicyUrl, filled);
      setValue('leadForm.thankYou', current.thankYou, filled);
    }
  };

  const pipeline = leadForm?.funnel?.pipeline ?? 'formatacao';
  const activeClients = (clients.data?.clients ?? []).filter((client) => client.active);
  const formErrors = errors.leadForm;
  const proposal = siteFormOf(leadForm);
  // Drawn even before the policy link is typed; proposing waits for a valid form.
  const previewForm =
    proposal ??
    siteFormOf(
      leadForm && {
        ...leadForm,
        privacyPolicyUrl: leadForm.privacyPolicyUrl || DEFAULT_PRIVACY_URL,
      },
    );
  const sameAsLive =
    sitePage?.form && proposal ? JSON.stringify(sitePage.form) === JSON.stringify(proposal) : false;

  return (
    <>
      {meta && (
        <div className="field">
          <span className="field-label" id="builder-lead-capture">
            Onde o lead é captado
          </span>
          <div className="builder-match" role="radiogroup" aria-labelledby="builder-lead-capture">
            {(['page', 'instant_form'] as const).map((key) => (
              <label key={key} className="check">
                <input
                  type="radio"
                  value={key}
                  checked={(leadCapture ?? 'page') === key}
                  onChange={() => setValue('leadCapture', key, filled)}
                />
                {LEAD_CAPTURE_LABEL[key]}
              </label>
            ))}
          </div>
          <p className="field-hint">
            {instant
              ? 'A pessoa responde sem sair do Instagram ou do Facebook; o formulário é criado na Página junto com a campanha, só depois da aprovação.'
              : 'O botão leva à página de destino; o lead nasce no formulário dela.'}
          </p>
        </div>
      )}

      {instant && readiness.data && !readiness.data.access.canManage && (
        <Alert kind="warning">
          Neste ambiente o token não administra a Página ({readiness.data.access.reason}): a prévia
          funciona, mas a criação do formulário seria recusada na execução. Falta{' '}
          <code>pages_manage_ads</code> no usuário de sistema, com a Página como ativo.
        </Alert>
      )}
      {instant && readiness.isError && (
        <Alert kind="warning">
          Não foi possível ler a Página na Meta agora; a prévia continua.
        </Alert>
      )}

      {(!meta || leadCapture === 'page') && (
        <>
          <Field
            label={meta ? 'Página do site com o formulário padrão (opcional)' : 'Página do site'}
            hint={
              platform === 'youtube'
                ? 'O Google não aceita formulário de lead em campanhas Demand Gen (YouTube); o anúncio leva a uma página do Wings System com o formulário padrão.'
                : 'Escolher uma página troca o destino por ela; o funil é o da página.'
            }
          >
            <Select
              value={sitePage?.id ?? ''}
              onChange={(event) =>
                choosePage(pages.data?.pages.find((page) => page.id === event.target.value) ?? null)
              }
            >
              <option value="">{meta ? 'Manter a página de destino' : 'Escolha a página'}</option>
              {(pages.data?.pages ?? []).map((page) => (
                <option key={page.id} value={page.id}>
                  {page.brand} — {page.path}
                  {page.pending ? ' (alteração aguardando)' : ''}
                </option>
              ))}
            </Select>
          </Field>
          {/* Without the list the form below cannot tell whether the destination is one of our pages. */}
          {pages.isError && !pages.data && (
            <LoadFailure
              what="as páginas do site"
              error={pages.error}
              onRetry={() => void pages.refetch()}
            />
          )}
        </>
      )}

      {(instant || sitePage) && (
        <>
          <div className="field">
            <span className="field-label">Perguntas obrigatórias</span>
            <ol className="builder-lead-questions">
              {LEAD_FORM_QUESTIONS.map((question) => (
                <li key={question.field}>{question.label}</li>
              ))}
            </ol>
            <p className="field-hint">
              Fixas: são os campos que caem direto na ficha do lead (nome, WhatsApp, empresa,
              Instagram e site).
            </p>
          </div>

          <label className="check">
            <input
              type="checkbox"
              checked={qualifierOn}
              onChange={(event) => toggleQualifier(event.target.checked)}
            />
            Abrir com uma pergunta de múltipla escolha
          </label>
          {qualifierOn && (
            <div className="builder-lead-qualifier">
              <Field
                label="Pergunta"
                error={formErrors?.qualifier?.question?.message}
                hint={`${(leadForm?.qualifier?.question ?? '').length}/${LEAD_FORM_QUALIFIER_QUESTION_MAX}`}
              >
                <Input
                  maxLength={LEAD_FORM_QUALIFIER_QUESTION_MAX}
                  {...register('leadForm.qualifier.question')}
                />
              </Field>
              <Field
                label="Opções (uma por linha)"
                error={formErrors?.qualifier?.options?.message}
                hint={`De 2 a ${LEAD_FORM_QUALIFIER_MAX_OPTIONS} opções.`}
              >
                <textarea
                  className="control"
                  rows={4}
                  value={optionsText}
                  onChange={(event) => setOptionsText(event.target.value)}
                />
              </Field>
            </div>
          )}

          <Field
            label="Política de privacidade"
            error={formErrors?.privacyPolicyUrl?.message}
            hint={
              suggestedPolicy
                ? `A mesma dos formulários atuais da Página: ${suggestedPolicy}`
                : 'O link que os formulários atuais da Meta usam.'
            }
          >
            <Input
              type="url"
              placeholder={DEFAULT_PRIVACY_URL}
              {...register('leadForm.privacyPolicyUrl')}
            />
          </Field>

          <div className="builder-lead-thanks">
            <Field
              label="Agradecimento — título"
              error={formErrors?.thankYou?.title?.message}
              hint={`${(leadForm?.thankYou?.title ?? '').length}/${LEAD_FORM_THANK_YOU_TITLE_MAX}`}
            >
              <Input
                maxLength={LEAD_FORM_THANK_YOU_TITLE_MAX}
                {...register('leadForm.thankYou.title')}
              />
            </Field>
            <Field
              label="Agradecimento — texto"
              error={formErrors?.thankYou?.body?.message}
              hint={`${(leadForm?.thankYou?.body ?? '').length}/${LEAD_FORM_THANK_YOU_BODY_MAX}`}
            >
              <textarea
                className="control"
                rows={2}
                maxLength={LEAD_FORM_THANK_YOU_BODY_MAX}
                {...register('leadForm.thankYou.body')}
              />
            </Field>
            <Field
              label="Botão do agradecimento"
              error={formErrors?.thankYou?.buttonText?.message}
              hint={
                instant
                  ? 'Leva à página de destino (seção Destino).'
                  : 'Texto do botão na tela de agradecimento da página.'
              }
            >
              <Input
                maxLength={LEAD_FORM_THANK_YOU_BUTTON_MAX}
                {...register('leadForm.thankYou.buttonText')}
              />
            </Field>
          </div>

          <div className="builder-lead-funnel">
            <Field
              label="Funil dos leads"
              error={formErrors?.funnel?.pipeline?.message}
              hint={
                instant
                  ? 'A regra de origem nasce junto com o formulário: nenhum lead cai em Formatação por falta de regra.'
                  : 'O funil da página, pela regra dela em Landing pages.'
              }
            >
              <Select
                disabled={!instant}
                value={pipeline}
                onChange={(event) => {
                  const next = event.target.value as LeadFormValues['funnel']['pipeline'];
                  setValue(
                    'leadForm.funnel',
                    { pipeline: next, brand: null, clientId: null },
                    filled,
                  );
                }}
              >
                {LEAD_PIPELINES.map((item) => (
                  <option key={item} value={item}>
                    {LEAD_PIPELINE_LABELS[item]}
                  </option>
                ))}
              </Select>
            </Field>
            {pipeline === 'expansao' && (
              <>
                <Field label="Marca (cliente)" error={formErrors?.funnel?.brand?.message}>
                  <Select
                    disabled={!instant}
                    value={leadForm?.funnel?.clientId ?? ''}
                    onChange={(event) => {
                      const client = activeClients.find((item) => item.id === event.target.value);
                      setValue(
                        'leadForm.funnel',
                        {
                          pipeline: 'expansao',
                          brand: client?.name ?? null,
                          clientId: client?.id ?? null,
                        },
                        filled,
                      );
                    }}
                  >
                    <option value="">{leadForm?.funnel?.brand ?? 'Escolha a marca'}</option>
                    {activeClients.map((client) => (
                      <option key={client.id} value={client.id}>
                        {client.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                {clients.isError && !clients.data && (
                  <LoadFailure
                    what="as marcas"
                    error={clients.error}
                    onRetry={() => void clients.refetch()}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}

      {sitePage && (
        <div className="builder-lead-site">
          <div className="lead-preview-row">
            {previewForm && (
              <SiteFormPreview form={previewForm} brand={sitePage.brand} path={sitePage.path} />
            )}
          </div>
          <p className="field-hint">
            {sitePage.form
              ? 'A página mostra hoje um formulário padrão aprovado.'
              : 'A página mostra hoje o formulário simples (sem múltipla escolha nem agradecimento próprio).'}
            {sitePage.pending &&
              ` Há uma alteração aguardando aprovação${sitePage.pending.by ? ` (${sitePage.pending.by})` : ''}.`}
          </p>
          <div className="builder-lead-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={!proposal || sameAsLive || propose.isPending}
              onClick={() => proposal && propose.mutate({ id: sitePage.id, form: proposal })}
            >
              {propose.isPending ? 'Enviando…' : 'Propor este formulário para a página'}
            </Button>
            {sitePage.pending && canApprove && (
              <>
                <Button
                  type="button"
                  disabled={approve.isPending}
                  onClick={() => approve.mutate({ id: sitePage.id })}
                >
                  Aprovar e publicar na página
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={reject.isPending}
                  onClick={() => reject.mutate({ id: sitePage.id })}
                >
                  Recusar
                </Button>
              </>
            )}
          </div>
          {propose.isSuccess && (
            <Alert kind="success">
              Proposta enviada. A página só muda depois que a Diretoria aprovar.
            </Alert>
          )}
          {approve.isError && (
            <Alert kind="error">
              Não foi possível aprovar: quem propôs não aprova a própria alteração.
            </Alert>
          )}
          {!sitePage.form && !sitePage.pending && (
            <p className="field-hint">
              Mudança no site só vai ao ar com prévia e aprovação da Diretoria.
            </p>
          )}
        </div>
      )}
    </>
  );
}
