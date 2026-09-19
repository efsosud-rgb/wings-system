import { zodResolver } from '@hookform/resolvers/zod';
import {
  BRAZIL_STATES,
  CALLS_TO_ACTION,
  CALL_TO_ACTION_LABEL,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_HINT,
  CAMPAIGN_OBJECTIVE_LABEL,
  COMPLIANCE_RULE_ADVICE,
  COMPLIANCE_RULE_LABEL,
  CREATIVE_FORMATS,
  HEADLINE_MAX,
  ICP_MAX,
  MAX_KEYWORDS,
  MAX_NEGATIVE_KEYWORDS,
  MAX_SEARCH_DESCRIPTIONS,
  MAX_SEARCH_HEADLINES,
  MAX_VARIATIONS,
  MIN_DAILY_BUDGET_CENTS,
  MIN_VARIATIONS,
  PAID_PLATFORMS,
  PRIMARY_TEXT_RECOMMENDED,
  SEARCH_DESCRIPTION_MAX,
  SEARCH_HEADLINE_MAX,
  UTM_KEYS,
  applyUtms,
  audienceProfileSchema,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  describeReach,
  estimateCostCents,
  isGooglePlatform,
  matchesFormat,
  overdeliveryFactor,
  type CampaignDraft,
  type CampaignDraftInput,
  type BrazilState,
  type ComplianceFinding,
  type CreativeFormat,
  type CreativeUpload,
  type PacingSummary,
} from '@wings/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useFieldArray, useForm, type Resolver } from 'react-hook-form';
import { Link } from 'react-router-dom';
import {
  useAudienceProfile,
  useCockpit,
  useRequestCampaign,
  useSaveAudienceProfile,
  useUploadCreative,
} from '../../api/ads.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
import { AdPreviewGallery, creativeUrl } from './AdPreview.js';
import { formatBrl, formatDate, parseBrlToCents, todayInSaoPaulo } from './format.js';
import { SearchAdPreview, YoutubePreview } from './GooglePreview.js';
import { RadiusMap } from './RadiusMap.js';

/**
 * The paid-media tab of the campaign builder.
 *
 * Sections follow the order the operator fills them in. Nothing here writes to
 * an ad platform: the form's only output is a draft that becomes a
 * `create_campaign` request in front of the approvals gate.
 */

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** A textarea as a list: one item per line, trimmed, empty lines dropped. */
function linesOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
}

/**
 * What is validated and sent: only the parts that belong to the chosen
 * platform. The form keeps every platform's fields in its state, so switching
 * back and forth loses nothing; the schema refuses foreign parts, so they are
 * dropped here — once, for the check and for the request alike.
 */
function shapeDraft(values: CampaignDraftInput): CampaignDraftInput {
  const { youtube, search, formatKey, variations, ...common } = values;
  if (!isGooglePlatform(values.platform)) return { ...common, formatKey, variations };

  const google = {
    ...common,
    startPaused: true,
    reach: { ...common.reach, customLocations: [] },
  };
  if (values.platform === 'youtube') return { ...google, youtube };
  return {
    ...google,
    search: search && {
      ...search,
      // Boxes left empty are not headlines.
      headlines: search.headlines.filter((item) => item.trim() !== ''),
      descriptions: search.descriptions.filter((item) => item.trim() !== ''),
    },
  };
}

const schemaResolver = zodResolver(campaignDraftSchema) as Resolver<CampaignDraftInput>;
const draftResolver: Resolver<CampaignDraftInput> = (values, context, options) =>
  schemaResolver(shapeDraft(values), context, options);

/** The builder's sections, in the order they appear for each platform. */
const META_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'creative',
  'format',
  'copy',
  'variations',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
const YOUTUBE_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'video',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
const SEARCH_SECTIONS = [
  'platform',
  'objective',
  'icp',
  'reach',
  'keywords',
  'searchAd',
  'duration',
  'budget',
  'utms',
  'preview',
  'summary',
] as const;
type SectionKey =
  | (typeof META_SECTIONS)[number]
  | (typeof YOUTUBE_SECTIONS)[number]
  | (typeof SEARCH_SECTIONS)[number];

function BuilderSection({
  step,
  title,
  why,
  children,
}: {
  step: number;
  title: string;
  /**
   * What this choice changes in practice, in a media buyer's words. The hints
   * under the fields say how to fill them in; this says why it matters.
   */
  why: string;
  children: ReactNode;
}) {
  return (
    <section className="builder-section" aria-labelledby={`builder-step-${step}`}>
      <h2 id={`builder-step-${step}`}>
        <span className="builder-step">{step}</span>
        {title}
      </h2>
      <p className="builder-why">{why}</p>
      {children}
    </section>
  );
}

/** Shown on screen, not just refused: the operator must see why copy is blocked. */
function ComplianceWarning({ findings }: { findings: ComplianceFinding[] }) {
  if (findings.length === 0) return null;
  // The same excerpt may be typed in two boxes; say it once.
  const unique = [...new Map(findings.map((f) => [`${f.rule}:${f.excerpt}`, f])).values()];
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Este texto não pode ir ao ar.</strong> A conta já teve anúncios reprovados por
      "práticas de negócios inaceitáveis".
      <ul>
        {unique.map((finding) => (
          <li key={`${finding.rule}:${finding.excerpt}`}>
            <strong>{COMPLIANCE_RULE_LABEL[finding.rule]}</strong> — “{finding.excerpt}”.{' '}
            {COMPLIANCE_RULE_ADVICE[finding.rule]}
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccountCeiling({ pacing }: { pacing: PacingSummary | null | undefined }) {
  if (pacing === undefined) return <p className="muted">Lendo o teto da conta…</p>;
  if (pacing === null) {
    return (
      <Alert kind="error">
        Não há período de orçamento aberto para esta conta neste mês. Sem teto, nenhum pedido é
        aceito.
      </Alert>
    );
  }
  return (
    <div className="builder-ceiling">
      <span className="field-label">Teto real da conta neste mês</span>
      <p className="mono builder-ceiling-figure">{formatBrl(pacing.availableCents)}</p>
      <p className="field-hint">ainda pode ser planejado</p>
      <dl>
        <dt>Teto do mês</dt>
        <dd className="mono">{formatBrl(pacing.capCents)}</dd>
        <dt>Utilizável (70%)</dt>
        <dd className="mono">{formatBrl(pacing.usableCents)}</dd>
        <dt>Já comprometido</dt>
        <dd className="mono">{formatBrl(pacing.committedCents)}</dd>
        <dt>Já gasto</dt>
        <dd className="mono">{formatBrl(pacing.spentCents)}</dd>
      </dl>
      {pacing.killSwitchEngaged && (
        <Alert kind="error">Trava de emergência acionada: a conta não aceita pedidos agora.</Alert>
      )}
    </div>
  );
}

const ACCEPTED_TYPES = ['image/png', 'image/jpeg'];

/**
 * One variation's image. Uploading happens on choosing the file, so the form
 * only ever holds the id of something the server has already accepted.
 */
function CreativeSlot({
  label,
  creativeId,
  format,
  error,
  onUploaded,
}: {
  label: string;
  creativeId: string;
  format: CreativeFormat | undefined;
  error: string | undefined;
  onUploaded: (creative: CreativeUpload) => void;
}) {
  const upload = useUploadCreative();
  const [problem, setProblem] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState<CreativeUpload | null>(null);
  const current = uploaded && uploaded.id === creativeId ? uploaded : null;

  return (
    <div className="builder-creative">
      <div className="builder-creative-thumb">
        {creativeId ? (
          <img src={creativeUrl(creativeId)} alt={`Criativo — ${label}`} />
        ) : (
          <span className="muted">Sem imagem</span>
        )}
      </div>
      <div>
        <Field label={`Imagem — ${label}`} error={problem ?? error} hint="PNG ou JPEG, até 8 MB.">
          <input
            type="file"
            className="control"
            accept={ACCEPTED_TYPES.join(',')}
            disabled={upload.isPending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (!file) return;
              setProblem(null);
              if (!ACCEPTED_TYPES.includes(file.type)) {
                setProblem('Use uma imagem PNG ou JPEG.');
                return;
              }
              upload.mutate(file, {
                onSuccess: ({ creative }) => {
                  setUploaded(creative);
                  onUploaded(creative);
                },
                onError: (failure) => setProblem(failure.message),
              });
            }}
          />
        </Field>
        {upload.isPending && <p className="field-hint">Enviando…</p>}
        {current && (
          <p className="field-hint">
            {current.width} × {current.height} px
            {format &&
              (matchesFormat(current, format)
                ? ` · ✓ proporção ${format.ratio}`
                : ` · ⚠️ proporção diferente de ${format.ratio}: a plataforma vai cortar a imagem`)}
          </p>
        )}
      </div>
    </div>
  );
}

export function PaidMediaBuilder({ canRequest }: { canRequest: boolean }) {
  const today = todayInSaoPaulo();
  const cockpit = useCockpit(7);
  const launch = useRequestCampaign();
  const pacing = cockpit.isLoading ? undefined : (cockpit.data?.cockpit.pacing ?? null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    formState: { errors, dirtyFields, submitCount, isSubmitSuccessful },
  } = useForm<CampaignDraftInput>({
    resolver: draftResolver,
    defaultValues: {
      platform: 'meta',
      name: '',
      objective: 'lead',
      idealCustomerProfile: '',
      reach: { states: [], cities: [], customLocations: [] },
      formatKey: 'feed_square',
      destinationUrl: '',
      variations: Array.from({ length: MIN_VARIATIONS }, () => ({
        creativeId: '',
        headline: '',
        primaryText: '',
        callToAction: 'LEARN_MORE' as const,
      })),
      youtube: { videoUrl: '', headline: '' },
      search: {
        keywords: [],
        negativeKeywords: [],
        headlines: Array.from({ length: MAX_SEARCH_HEADLINES }, () => ''),
        descriptions: Array.from({ length: MAX_SEARCH_DESCRIPTIONS }, () => ''),
      },
      startDate: today,
      endDate: addDays(today, 6),
      utms: buildUtms({ platform: 'meta', objective: 'lead', campaignName: '' }),
      startPaused: true,
    },
  });
  const variations = useFieldArray({ control, name: 'variations' });
  const cities = useFieldArray({ control, name: 'reach.cities' });
  const [checked, setChecked] = useState<CampaignDraft | null>(null);

  // The builder starts from what Wings saved as its standing audience. Once
  // loaded it is the operator's to edit: this campaign keeps its own copy.
  const audience = useAudienceProfile();
  const saveAudience = useSaveAudienceProfile();
  const savedAudience = audience.data?.profile;
  const [audienceLoaded, setAudienceLoaded] = useState(false);
  const [audienceProblem, setAudienceProblem] = useState<string | null>(null);
  const [newCity, setNewCity] = useState<{ name: string; state: BrazilState | '' }>({
    name: '',
    state: '',
  });
  const { replace: replaceCities } = cities;
  useEffect(() => {
    if (!savedAudience || audienceLoaded) return;
    setAudienceLoaded(true);
    if (dirtyFields.idealCustomerProfile || dirtyFields.reach) return;
    setValue('idealCustomerProfile', savedAudience.idealCustomerProfile);
    setValue('reach.states', savedAudience.reach.states);
    // A field array only follows its own methods, not setValue.
    replaceCities(savedAudience.reach.cities);
    setValue('reach.customLocations', savedAudience.reach.customLocations);
  }, [
    savedAudience,
    audienceLoaded,
    dirtyFields.idealCustomerProfile,
    dirtyFields.reach,
    setValue,
    replaceCities,
  ]);

  const values = watch();
  const { platform } = values;
  const google = isGooglePlatform(platform);
  const sections: readonly SectionKey[] =
    platform === 'youtube'
      ? YOUTUBE_SECTIONS
      : platform === 'google_search'
        ? SEARCH_SECTIONS
        : META_SECTIONS;
  const stepOf = (key: SectionKey) => sections.indexOf(key) + 1;
  const platformLabel = PAID_PLATFORMS.find((item) => item.key === platform)?.label ?? '—';

  // A Google campaign is always born paused, and takes no radius on the map.
  useEffect(() => {
    if (!google) return;
    setValue('startPaused', true);
    setValue('reach.customLocations', []);
  }, [google, setValue]);

  // Keywords are typed one per line; the form holds them as the list it sends.
  const [keywordsText, setKeywordsText] = useState('');
  const [negativeKeywordsText, setNegativeKeywordsText] = useState('');

  const days = campaignDays(values.startDate, values.endDate);
  // The estimate reads what is in the box, as typed. It must never wait on
  // the form library's copy of the value to show a number the operator is
  // about to commit money against.
  const [budgetText, setBudgetText] = useState('');
  const typedBudgetCents = parseBrlToCents(budgetText);
  const dailyBudgetCents = Number.isFinite(typedBudgetCents) ? typedBudgetCents : 0;
  const totalCostCents = days ? estimateCostCents(dailyBudgetCents, days, platform) : null;
  // Why there is no estimate yet, in the operator's terms — never a bare dash.
  const costMissing =
    budgetText.trim() === ''
      ? 'Falta a verba por dia.'
      : !Number.isFinite(typedBudgetCents)
        ? `Não entendi “${budgetText.trim()}”. Digite só o valor, como 20,00.`
        : dailyBudgetCents < MIN_DAILY_BUDGET_CENTS
          ? 'A verba por dia precisa ser de pelo menos R$ 1,00.'
          : !values.startDate || !values.endDate
            ? 'Falta escolher o início e o fim da campanha.'
            : days === null
              ? 'O fim da campanha está antes do início.'
              : null;
  const budgetField = register('dailyBudgetCents', { setValueAs: parseBrlToCents });
  const daysThisMonth = campaignDaysInMonth(values.startDate, values.endDate, today);
  const costThisMonthCents = estimateCostCents(dailyBudgetCents, daysThisMonth, platform);
  const overCeiling =
    pacing != null && dailyBudgetCents > 0 && costThisMonthCents > pacing.availableCents;

  // UTMs follow the form until the operator edits one; an edited value is theirs.
  const { name, objective } = values;
  useEffect(() => {
    const generated = buildUtms({ platform, objective, campaignName: name });
    for (const key of UTM_KEYS) {
      if (!dirtyFields.utms?.[key]) setValue(`utms.${key}`, generated[key]);
    }
  }, [platform, name, objective, dirtyFields.utms, setValue]);

  const format = CREATIVE_FORMATS.meta.find((item) => item.key === values.formatKey);
  const formVariations = values.variations ?? [];
  const findingsByVariation = formVariations.map((variation) => [
    ...checkCopyCompliance(variation.headline ?? ''),
    ...checkCopyCompliance(variation.primaryText ?? ''),
  ]);
  const searchHeadlines = values.search?.headlines ?? [];
  const searchDescriptions = values.search?.descriptions ?? [];
  const youtubeFindings = checkCopyCompliance(values.youtube?.headline ?? '');
  const searchFindings = [...searchHeadlines, ...searchDescriptions].flatMap((text) =>
    checkCopyCompliance(text ?? ''),
  );
  // Only the copy that will be sent counts: the other platforms' boxes are not.
  const hasComplianceProblem =
    platform === 'youtube'
      ? youtubeFindings.length > 0
      : platform === 'google_search'
        ? searchFindings.length > 0
        : findingsByVariation.some((findings) => findings.length > 0);
  /** Array fields report either on the list or on one of its items. */
  const listError = (
    error:
      | { message?: string; root?: { message?: string } }
      | ({ message?: string } | undefined)[]
      | undefined,
  ): string | undefined => {
    if (!error) return undefined;
    if (Array.isArray(error)) return error.find((item) => item?.message)?.message;
    return error.message ?? error.root?.message;
  };

  const copyFields = (index: number) => (
    <div className="builder-variation" key={variations.fields[index]?.id ?? index}>
      <div className="builder-variation-head">
        <strong>Variação {index + 1}</strong>
        {index >= MIN_VARIATIONS && (
          <button type="button" className="link-button" onClick={() => variations.remove(index)}>
            Remover
          </button>
        )}
      </div>
      <Field
        label="Título"
        error={errors.variations?.[index]?.headline?.message}
        hint={`${(formVariations[index]?.headline ?? '').length}/${HEADLINE_MAX}`}
      >
        <Input maxLength={HEADLINE_MAX} {...register(`variations.${index}.headline`)} />
      </Field>
      <Field
        label="Texto"
        error={errors.variations?.[index]?.primaryText?.message}
        hint={`${(formVariations[index]?.primaryText ?? '').length} caracteres — a Meta corta perto de ${PRIMARY_TEXT_RECOMMENDED}`}
      >
        <textarea className="control" rows={3} {...register(`variations.${index}.primaryText`)} />
      </Field>
      <Field label="Botão (CTA)">
        <Select {...register(`variations.${index}.callToAction`)}>
          {CALLS_TO_ACTION.map((cta) => (
            <option key={cta} value={cta}>
              {CALL_TO_ACTION_LABEL[cta]}
            </option>
          ))}
        </Select>
      </Field>
      <ComplianceWarning findings={findingsByVariation[index] ?? []} />
    </div>
  );

  return (
    <form
      className="builder"
      noValidate
      // Browsers restore typed values after a reload or a "back" without
      // telling the page, which would show filled boxes over an empty form
      // state — a budget on screen and no estimate. Off means: do not restore.
      autoComplete="off"
      onSubmit={(event) => {
        // Which button was pressed: checking never sends anything.
        const submitter = (event.nativeEvent as SubmitEvent).submitter;
        const launching = submitter instanceof HTMLButtonElement && submitter.value === 'launch';
        setChecked(null);
        launch.reset();
        void handleSubmit((values) => {
          const draft = values as CampaignDraft;
          if (launching && canRequest) launch.mutate(draft);
          else setChecked(draft);
        })(event);
      }}
    >
      <BuilderSection
        step={stepOf('platform')}
        title="Plataforma"
        why={`Onde o anúncio aparece. O nome é como você vai achar esta campanha no ${google ? 'Google Ads' : 'Gerenciador de Anúncios'} e nos relatórios — capriche nele.`}
      >
        <div className="builder-options" role="radiogroup" aria-label="Plataforma">
          {PAID_PLATFORMS.map((platform) => (
            <label
              key={platform.key}
              className={`builder-option ${platform.enabled ? '' : 'builder-option-disabled'}`}
            >
              <input
                type="radio"
                value={platform.key}
                disabled={!platform.enabled}
                {...register('platform')}
              />
              <span>
                {platform.label}
                {platform.disabledReason && (
                  <small className="muted"> — {platform.disabledReason}</small>
                )}
              </span>
            </label>
          ))}
        </div>
        {platform === 'youtube' && (
          <p className="field-hint">
            Criada como campanha Demand Gen restrita ao YouTube — a API do Google não cria campanhas
            do tipo Vídeo. O grupo de anúncios e o anúncio em vídeo entram na próxima etapa.
          </p>
        )}
        <Field label="Nome da campanha" error={errors.name?.message}>
          <Input placeholder="Ex.: Expansão SP — outubro" {...register('name')} />
        </Field>
      </BuilderSection>

      <BuilderSection
        step={stepOf('objective')}
        title="Objetivo"
        why={
          google
            ? 'Define como o Google cobra e para quem mostra: dentro do seu público, ele procura quem tem mais chance de fazer exatamente isto.'
            : 'Define como a Meta cobra e para quem mostra: dentro do seu público, ela procura quem tem mais chance de fazer exatamente isto.'
        }
      >
        <div className="builder-options" role="radiogroup" aria-label="Objetivo">
          {CAMPAIGN_OBJECTIVES.map((key) => (
            <label key={key} className="builder-option">
              <input type="radio" value={key} {...register('objective')} />
              <span>
                {CAMPAIGN_OBJECTIVE_LABEL[key]}
                <small className="muted"> — {CAMPAIGN_OBJECTIVE_HINT[key]}</small>
              </span>
            </label>
          ))}
        </div>
      </BuilderSection>

      <BuilderSection
        step={stepOf('icp')}
        title="Perfil do cliente ideal"
        why={`É o retrato de quem você quer atrair. Guia a copy e o criativo agora e vira a segmentação quando o ${google ? 'grupo' : 'conjunto'} de anúncios for criado.`}
      >
        <Field
          label="Quem é o cliente ideal desta campanha"
          error={errors.idealCustomerProfile?.message}
          hint={`${(values.idealCustomerProfile ?? '').length}/${ICP_MAX} · começa do perfil salvo para a Wings; o que você mudar aqui vale para esta campanha.`}
        >
          <textarea
            className="control"
            rows={5}
            maxLength={ICP_MAX}
            placeholder="Ex.: empreendedor de 30 a 50 anos, com experiência em gestão, que busca um negócio com suporte…"
            {...register('idealCustomerProfile')}
          />
        </Field>
      </BuilderSection>

      <BuilderSection
        step={stepOf('reach')}
        title="Área de alcance"
        why="Onde o anúncio pode aparecer. Área grande demais espalha a verba; pequena demais encarece o lead."
      >
        <fieldset className="builder-states">
          <legend className="field-label">Estados inteiros</legend>
          {BRAZIL_STATES.map((state) => (
            <label key={state} className="builder-state">
              <input type="checkbox" value={state} {...register('reach.states')} />
              <span>{state}</span>
            </label>
          ))}
        </fieldset>

        <div>
          <span className="field-label">Cidades</span>
          {cities.fields.length === 0 && <p className="field-hint">Nenhuma cidade adicionada.</p>}
          <ul className="builder-cities">
            {cities.fields.map((city, index) => (
              <li key={city.id}>
                {values.reach.cities[index]?.name}/{values.reach.cities[index]?.state}
                <button
                  type="button"
                  className="link-button"
                  aria-label={`Remover ${values.reach.cities[index]?.name ?? 'cidade'}`}
                  onClick={() => cities.remove(index)}
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
          <div className="builder-city-add">
            <Input
              aria-label="Cidade"
              placeholder="Cidade"
              value={newCity.name}
              onChange={(event) => setNewCity({ ...newCity, name: event.target.value })}
            />
            <Select
              aria-label="UF da cidade"
              value={newCity.state}
              onChange={(event) =>
                setNewCity({ ...newCity, state: event.target.value as BrazilState | '' })
              }
            >
              <option value="">UF</option>
              {BRAZIL_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </Select>
            <Button
              type="button"
              variant="ghost"
              disabled={newCity.name.trim().length < 2 || newCity.state === ''}
              onClick={() => {
                if (newCity.state === '') return;
                cities.append({ name: newCity.name.trim(), state: newCity.state });
                setNewCity({ name: '', state: '' });
              }}
            >
              Adicionar cidade
            </Button>
          </div>
        </div>
        {google ? (
          <p className="field-hint">
            O raio no mapa ainda não vale para o Google: use estados e cidades.
          </p>
        ) : (
          <RadiusMap
            value={values.reach.customLocations ?? []}
            onChange={(next) =>
              setValue('reach.customLocations', next, {
                shouldDirty: true,
                shouldValidate: submitCount > 0,
              })
            }
          />
        )}
        {(errors.reach?.message ?? errors.reach?.root?.message) && (
          <p className="field-error" role="alert">
            {errors.reach?.message ?? errors.reach?.root?.message}
          </p>
        )}

        <div className="builder-audience-save">
          <Button
            type="button"
            variant="ghost"
            disabled={!canRequest || saveAudience.isPending}
            onClick={() => {
              setAudienceProblem(null);
              const parsed = audienceProfileSchema.safeParse({
                idealCustomerProfile: values.idealCustomerProfile,
                reach: values.reach,
              });
              if (!parsed.success) {
                setAudienceProblem(parsed.error.issues[0]?.message ?? 'Dados inválidos');
                return;
              }
              saveAudience.mutate(parsed.data);
            }}
          >
            Salvar perfil e alcance como padrão da Wings
          </Button>
          <p className="field-hint">
            {savedAudience
              ? `Padrão atual salvo por ${savedAudience.updatedByName ?? '—'} em ${new Date(
                  savedAudience.updatedAt,
                ).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`
              : 'Ainda não há um padrão salvo para a Wings.'}{' '}
            As próximas campanhas começam dele.
          </p>
          {audienceProblem && <Alert kind="error">{audienceProblem}</Alert>}
          {saveAudience.isError && <Alert kind="error">{saveAudience.error.message}</Alert>}
          {saveAudience.isSuccess && <Alert kind="success">Padrão da Wings atualizado.</Alert>}
        </div>
      </BuilderSection>

      {!google && (
        <>
          <BuilderSection
            step={stepOf('creative')}
            title="Criativo"
            why="A imagem é o que faz a pessoa parar de rolar o feed. Uma por variação, para a Meta descobrir qual segura mais gente."
          >
            <div className="form-actions">
              <Button
                type="button"
                variant="ghost"
                disabled
                title="Integração com o Drive em breve"
              >
                Escolher do Drive (em breve)
              </Button>
            </div>
            <p className="field-hint">
              Uma imagem por variação. Ela fica guardada no Wings System — nada é enviado à Meta.
            </p>
            {variations.fields.map((field, index) => (
              <CreativeSlot
                key={field.id}
                label={`Variação ${index + 1}`}
                creativeId={formVariations[index]?.creativeId ?? ''}
                format={format}
                error={errors.variations?.[index]?.creativeId?.message}
                onUploaded={(creative) =>
                  setValue(`variations.${index}.creativeId`, creative.id, {
                    shouldDirty: true,
                    shouldValidate: submitCount > 0,
                  })
                }
              />
            ))}
          </BuilderSection>

          <BuilderSection
            step={stepOf('format')}
            title="Formato e dimensão"
            why="Cada posicionamento tem um corte. Imagem fora da proporção é cortada pela Meta — e pode perder o rosto ou o texto."
          >
            <Field
              label="Formato"
              error={errors.formatKey?.message}
              hint={
                format
                  ? `${format.width} × ${format.height} px (${format.ratio}) · ${format.placement}`
                  : undefined
              }
            >
              <Select {...register('formatKey')}>
                {CREATIVE_FORMATS.meta.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label} — {item.ratio}
                  </option>
                ))}
              </Select>
            </Field>
          </BuilderSection>

          <BuilderSection
            step={stepOf('copy')}
            title="Copy"
            why="É o que convence depois que a imagem chamou atenção. Promessa de ganho reprova o anúncio e pode restringir a conta — por isso o bloqueio."
          >
            <Field
              label="Página de destino"
              error={errors.destinationUrl?.message}
              hint="Para onde o botão do anúncio leva. Os UTMs são aplicados a este endereço."
            >
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/…"
                {...register('destinationUrl')}
              />
            </Field>
            {copyFields(0)}
          </BuilderSection>

          <BuilderSection
            step={stepOf('variations')}
            title="Variações"
            why="A Meta testa as versões entre si e entrega mais a que dá mais resultado. Com uma só, não há o que comparar."
          >
            <p className="field-hint">
              De {MIN_VARIATIONS} a {MAX_VARIATIONS} por campanha, para a plataforma ter o que
              comparar.
            </p>
            {variations.fields.slice(1).map((_, offset) => copyFields(offset + 1))}
            {variations.fields.length < MAX_VARIATIONS && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  variations.append({
                    creativeId: '',
                    headline: '',
                    primaryText: '',
                    callToAction: 'LEARN_MORE',
                  })
                }
              >
                + Adicionar variação
              </Button>
            )}
            {errors.variations?.root?.message && (
              <p className="field-error" role="alert">
                {errors.variations.root.message}
              </p>
            )}
          </BuilderSection>
        </>
      )}

      {platform === 'youtube' && (
        <BuilderSection
          step={stepOf('video')}
          title="Vídeo"
          why="O vídeo é o anúncio: os primeiros segundos decidem se a pessoa pula. Ele precisa estar publicado no YouTube — o link é o que o Google usa para achá-lo."
        >
          <Field
            label="Link do vídeo no YouTube"
            error={errors.youtube?.videoUrl?.message}
            hint="Ex.: https://www.youtube.com/watch?v=… ou https://youtu.be/…"
          >
            <Input
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              {...register('youtube.videoUrl')}
            />
          </Field>
          <Field
            label="Título"
            error={errors.youtube?.headline?.message}
            hint={`${(values.youtube?.headline ?? '').length}/${HEADLINE_MAX}`}
          >
            <Input maxLength={HEADLINE_MAX} {...register('youtube.headline')} />
          </Field>
          <Field
            label="Página de destino"
            error={errors.destinationUrl?.message}
            hint="Para onde o anúncio leva. Os UTMs são aplicados a este endereço."
          >
            <Input
              type="url"
              placeholder="https://wingscompany.com.br/…"
              {...register('destinationUrl')}
            />
          </Field>
          <ComplianceWarning findings={youtubeFindings} />
        </BuilderSection>
      )}

      {platform === 'google_search' && (
        <>
          <BuilderSection
            step={stepOf('keywords')}
            title="Palavras-chave"
            why="É o que a pessoa digita no Google para o anúncio aparecer. Poucas e específicas trazem quem já procura franquia; genéricas demais gastam a verba com curiosos."
          >
            <Field
              label="Palavras-chave"
              error={listError(errors.search?.keywords)}
              hint={`${linesOf(keywordsText).length}/${MAX_KEYWORDS} · uma por linha`}
            >
              <textarea
                className="control builder-keywords"
                rows={6}
                placeholder={'franquia de alimentação\nabrir franquia'}
                value={keywordsText}
                onChange={(event) => {
                  setKeywordsText(event.target.value);
                  setValue('search.keywords', linesOf(event.target.value), {
                    shouldDirty: true,
                    shouldValidate: submitCount > 0,
                  });
                }}
              />
            </Field>
            <Field
              label="Palavras-chave negativas"
              error={listError(errors.search?.negativeKeywords)}
              hint={`${linesOf(negativeKeywordsText).length}/${MAX_NEGATIVE_KEYWORDS} · uma por linha · buscas em que o anúncio NÃO deve aparecer`}
            >
              <textarea
                className="control builder-keywords"
                rows={4}
                placeholder={'grátis\nemprego'}
                value={negativeKeywordsText}
                onChange={(event) => {
                  setNegativeKeywordsText(event.target.value);
                  setValue('search.negativeKeywords', linesOf(event.target.value), {
                    shouldDirty: true,
                    shouldValidate: submitCount > 0,
                  });
                }}
              />
            </Field>
            <p className="field-hint">
              Ficam guardadas no pedido. O grupo de anúncios, onde elas passam a valer, entra na
              próxima etapa.
            </p>
          </BuilderSection>

          <BuilderSection
            step={stepOf('searchAd')}
            title="Texto do anúncio"
            why="Na Pesquisa não há imagem: o título é o que faz a pessoa clicar. Promessa de ganho reprova o anúncio e pode restringir a conta — por isso o bloqueio."
          >
            <Field
              label="Página de destino"
              error={errors.destinationUrl?.message}
              hint="Para onde o anúncio leva. Os UTMs são aplicados a este endereço."
            >
              <Input
                type="url"
                placeholder="https://wingscompany.com.br/…"
                {...register('destinationUrl')}
              />
            </Field>
            {searchHeadlines.map((_, index) => (
              <Field
                key={`headline-${index}`}
                label={`Título ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
                error={index === 0 ? listError(errors.search?.headlines) : undefined}
                hint={`${(searchHeadlines[index] ?? '').length}/${SEARCH_HEADLINE_MAX}`}
              >
                <Input maxLength={SEARCH_HEADLINE_MAX} {...register(`search.headlines.${index}`)} />
              </Field>
            ))}
            {searchDescriptions.map((_, index) => (
              <Field
                key={`description-${index}`}
                label={`Descrição ${index + 1}${index === 0 ? '' : ' (opcional)'}`}
                error={index === 0 ? listError(errors.search?.descriptions) : undefined}
                hint={`${(searchDescriptions[index] ?? '').length}/${SEARCH_DESCRIPTION_MAX}`}
              >
                <textarea
                  className="control"
                  rows={2}
                  maxLength={SEARCH_DESCRIPTION_MAX}
                  {...register(`search.descriptions.${index}`)}
                />
              </Field>
            ))}
            <ComplianceWarning findings={searchFindings} />
          </BuilderSection>
        </>
      )}

      <BuilderSection
        step={stepOf('duration')}
        title="Duração"
        why={`Por quanto tempo o anúncio roda. Nos primeiros dias ${google ? 'o Google' : 'a Meta'} ainda está aprendendo quem responde; campanha muito curta termina antes disso.`}
      >
        <div className="input-row">
          <Field label="Início" error={errors.startDate?.message}>
            <Input type="date" min={today} {...register('startDate')} />
          </Field>
          <Field label="Fim" error={errors.endDate?.message}>
            <Input type="date" min={values.startDate || today} {...register('endDate')} />
          </Field>
        </div>
        <p className="field-hint">
          {days ? `${days} dia${days === 1 ? '' : 's'} de campanha` : 'Escolha início e fim'}
        </p>
      </BuilderSection>

      <BuilderSection
        step={stepOf('budget')}
        title="Verba diária"
        why={
          google
            ? 'É quanto você autoriza por dia. O Google pode gastar até o dobro da verba diária num dia, então o custo real é o estimado abaixo — e ele precisa caber no teto da conta.'
            : 'É quanto você autoriza por dia. A Meta pode gastar até 25% a mais num dia, então o custo real é o estimado abaixo — e ele precisa caber no teto da conta.'
        }
      >
        <div className="builder-budget">
          <div>
            <Field
              label="Verba por dia (R$)"
              error={errors.dailyBudgetCents?.message}
              hint={
                google
                  ? 'O Google pode gastar até o dobro da verba diária num dia.'
                  : 'A Meta pode gastar até 25% acima disto num dia.'
              }
            >
              <Input
                inputMode="decimal"
                placeholder="20,00"
                {...budgetField}
                onChange={(event) => {
                  setBudgetText(event.target.value);
                  void budgetField.onChange(event);
                }}
              />
            </Field>
            <div className="builder-cost">
              <span className="field-label">Custo total estimado</span>
              {costMissing === null && totalCostCents !== null ? (
                <p className="mono builder-ceiling-figure">{formatBrl(totalCostCents)}</p>
              ) : (
                <p className="builder-cost-missing" role="status">
                  {costMissing}
                </p>
              )}
              {costMissing === null && days !== null && (
                <p className="field-hint">
                  {formatBrl(dailyBudgetCents)} × {days} dias ×{' '}
                  {overdeliveryFactor(platform).toLocaleString('pt-BR')} de margem da plataforma
                  {daysThisMonth !== days &&
                    ` · ${formatBrl(costThisMonthCents)} caem neste mês (${daysThisMonth} dias)`}
                </p>
              )}
            </div>
          </div>
          <AccountCeiling pacing={pacing} />
        </div>
        {overCeiling && pacing && (
          <div className="alert alert-warning" role="alert">
            O custo neste mês ({formatBrl(costThisMonthCents)}) passa do que a conta ainda permite
            planejar ({formatBrl(pacing.availableCents)}). Ativa, esta campanha seria recusada pelo
            guardião de orçamento.
          </div>
        )}
        <label className="checkbox-field">
          <input type="checkbox" {...register('startPaused')} disabled={google} />
          <span>
            Criar a campanha <strong>pausada</strong>
            <small className="muted">
              {' '}
              — nasce sem entregar e sem reservar verba; ativar depois é outro pedido, com outra
              aprovação.
            </small>
            {google && (
              <small className="field-hint">Campanhas do Google nascem sempre pausadas.</small>
            )}
          </span>
        </label>
      </BuilderSection>

      <BuilderSection
        step={stepOf('utms')}
        title="UTMs"
        why="É assim que o lead chega no CRM com a origem certa. Sem UTM ele aparece como “direto” e ninguém sabe qual campanha pagou por ele."
      >
        <p className="field-hint">Gerados a partir do nome e do objetivo. Edite se precisar.</p>
        <div className="builder-utms">
          {UTM_KEYS.map((key) => (
            <Field key={key} label={key} error={errors.utms?.[key]?.message}>
              <Input className="mono" {...register(`utms.${key}`)} />
            </Field>
          ))}
        </div>
        <p className="field-hint builder-url mono">
          {applyUtms(values.destinationUrl ?? '', values.utms, 0) ??
            'Informe a página de destino para ver o endereço final.'}
        </p>
      </BuilderSection>

      <BuilderSection
        step={stepOf('preview')}
        title="Pré-visualização"
        why={
          google
            ? 'O anúncio como a pessoa vai ver. É a última chance de pegar um título cortado, um link errado ou um texto que não convence.'
            : 'O anúncio como a pessoa vai ver, com o corte do formato. É a última chance de pegar texto cortado ou imagem mal enquadrada.'
        }
      >
        {platform === 'youtube' && (
          <YoutubePreview
            videoUrl={values.youtube?.videoUrl ?? ''}
            headline={values.youtube?.headline ?? ''}
            destinationUrl={values.destinationUrl ?? ''}
          />
        )}
        {platform === 'google_search' && (
          <SearchAdPreview
            headlines={searchHeadlines.map((item) => item ?? '')}
            descriptions={searchDescriptions.map((item) => item ?? '')}
            destinationUrl={values.destinationUrl ?? ''}
          />
        )}
        {!google && (
          <AdPreviewGallery
            variations={formVariations.map((variation) => ({
              creativeId: variation.creativeId,
              headline: variation.headline ?? '',
              primaryText: variation.primaryText ?? '',
              callToAction: variation.callToAction,
            }))}
            destinationUrl={values.destinationUrl ?? ''}
            format={format}
          />
        )}
      </BuilderSection>

      <BuilderSection
        step={stepOf('summary')}
        title="Resumo — confira tudo"
        why="É exatamente o que o aprovador vai ler. Depois de lançado o pedido não pode ser editado — para mudar, faz-se outro."
      >
        <dl className="builder-summary">
          <dt>Plataforma</dt>
          <dd>{platformLabel}</dd>
          <dt>Campanha</dt>
          <dd>{values.name || '—'}</dd>
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[values.objective]}</dd>
          <dt>Cliente ideal</dt>
          <dd className="builder-summary-clamp">{values.idealCustomerProfile || '—'}</dd>
          <dt>Alcance</dt>
          <dd>{describeReach(values.reach)}</dd>
          {!google && (
            <>
              <dt>Formato</dt>
              <dd>{format ? `${format.label} (${format.ratio})` : '—'}</dd>
              <dt>Variações</dt>
              <dd>
                {formVariations.map((variation, index) => (
                  <span key={index} className="builder-summary-line">
                    {index + 1}. {variation.headline || '(sem título)'} ·{' '}
                    {CALL_TO_ACTION_LABEL[variation.callToAction]}
                  </span>
                ))}
              </dd>
            </>
          )}
          {platform === 'youtube' && (
            <>
              <dt>Tipo no Google</dt>
              <dd>Demand Gen, restrita ao YouTube</dd>
              <dt>Vídeo</dt>
              <dd className="mono builder-url">{values.youtube?.videoUrl || '—'}</dd>
              <dt>Título</dt>
              <dd>{values.youtube?.headline || '—'}</dd>
            </>
          )}
          {platform === 'google_search' && (
            <>
              <dt>Palavras-chave</dt>
              <dd>{(values.search?.keywords ?? []).join(' · ') || '—'}</dd>
              <dt>Negativas</dt>
              <dd>{(values.search?.negativeKeywords ?? []).join(' · ') || '—'}</dd>
              <dt>Títulos</dt>
              <dd>{searchHeadlines.filter(Boolean).join(' | ') || '—'}</dd>
              <dt>Descrições</dt>
              <dd>{searchDescriptions.filter(Boolean).join(' ') || '—'}</dd>
            </>
          )}
          <dt>Duração</dt>
          <dd>
            {formatDate(values.startDate)} a {formatDate(values.endDate)}
            {days ? ` · ${days} dias` : ''}
          </dd>
          <dt>Verba diária</dt>
          <dd className="mono">{dailyBudgetCents > 0 ? formatBrl(dailyBudgetCents) : '—'}</dd>
          <dt>Custo total estimado</dt>
          <dd className={costMissing === null ? 'mono' : 'muted'}>
            {costMissing === null && totalCostCents !== null
              ? formatBrl(totalCostCents)
              : costMissing}
          </dd>
          <dt>Nasce</dt>
          <dd>{values.startPaused ? 'Pausada' : 'Ativa, assim que aprovada e executada'}</dd>
          <dt>Destino com UTMs</dt>
          <dd className="mono builder-url">
            {applyUtms(values.destinationUrl ?? '', values.utms, 0) ?? '—'}
          </dd>
        </dl>

        {hasComplianceProblem && (
          <Alert kind="error">
            Há texto bloqueado pelo compliance. Corrija {google ? 'os textos' : 'as variações'}{' '}
            acima.
          </Alert>
        )}
        {submitCount > 0 && !isSubmitSuccessful && !hasComplianceProblem && (
          <Alert kind="error">Há campos para corrigir acima.</Alert>
        )}
        {checked && (
          <Alert kind="success">
            Tudo conferido: a campanha “{checked.name}” está pronta para virar um pedido.
          </Alert>
        )}
        {launch.isError && <Alert kind="error">{launch.error.message}</Alert>}
        {launch.isSuccess && (
          <Alert kind="success">
            Pedido criado. Nada foi publicado: a campanha só existe{' '}
            {google ? 'no Google' : 'na Meta'} depois que alguém aprovar e executar.{' '}
            {launch.data.approvalId && (
              <Link to={`/marketing/trafego-pago-wings/aprovacoes/${launch.data.approvalId}`}>
                Abrir o pedido nas Aprovações
              </Link>
            )}
          </Alert>
        )}

        <div className="form-actions">
          <Button type="submit" variant="ghost" value="check">
            Conferir campanha
          </Button>
          <Button
            type="submit"
            value="launch"
            disabled={!canRequest || launch.isPending || launch.isSuccess}
            title={canRequest ? undefined : 'Seu perfil não pode pedir campanhas'}
          >
            {launch.isPending ? 'Enviando…' : 'Lançar campanha'}
          </Button>
        </div>
        <p className="field-hint">
          “Lançar campanha” não publica nada: cria um pedido que cai nas Aprovações, e só Admin
          Master ou Diretoria decidem.
          {!canRequest && ' Seu perfil pode montar a campanha, mas não enviar o pedido.'}
        </p>
      </BuilderSection>
    </form>
  );
}
