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
  MAX_VARIATIONS,
  MIN_DAILY_BUDGET_CENTS,
  MIN_VARIATIONS,
  PAID_PLATFORMS,
  PRIMARY_TEXT_RECOMMENDED,
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
  matchesFormat,
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
import { AdPreview, ApproximatePreviewNote, creativeUrl } from './AdPreview.js';
import { formatBrl, formatDate, parseBrlToCents, todayInSaoPaulo } from './format.js';

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
  return (
    <div className="alert alert-warning" role="alert">
      <strong>Este texto não pode ir ao ar.</strong> A conta já teve anúncios reprovados por
      "práticas de negócios inaceitáveis".
      <ul>
        {findings.map((finding) => (
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
    resolver: zodResolver(campaignDraftSchema) as Resolver<CampaignDraftInput>,
    defaultValues: {
      platform: 'meta',
      name: '',
      objective: 'lead',
      idealCustomerProfile: '',
      reach: { states: [], cities: [] },
      formatKey: 'feed_square',
      destinationUrl: '',
      variations: Array.from({ length: MIN_VARIATIONS }, () => ({
        creativeId: '',
        headline: '',
        primaryText: '',
        callToAction: 'LEARN_MORE' as const,
      })),
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
  }, [
    savedAudience,
    audienceLoaded,
    dirtyFields.idealCustomerProfile,
    dirtyFields.reach,
    setValue,
    replaceCities,
  ]);

  const values = watch();
  const days = campaignDays(values.startDate, values.endDate);
  // The estimate reads what is in the box, as typed. It must never wait on
  // the form library's copy of the value to show a number the operator is
  // about to commit money against.
  const [budgetText, setBudgetText] = useState('');
  const typedBudgetCents = parseBrlToCents(budgetText);
  const dailyBudgetCents = Number.isFinite(typedBudgetCents) ? typedBudgetCents : 0;
  const totalCostCents = days ? estimateCostCents(dailyBudgetCents, days) : null;
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
  const costThisMonthCents = estimateCostCents(dailyBudgetCents, daysThisMonth);
  const overCeiling =
    pacing != null && dailyBudgetCents > 0 && costThisMonthCents > pacing.availableCents;

  // UTMs follow the form until the operator edits one; an edited value is theirs.
  const { name, objective } = values;
  useEffect(() => {
    const generated = buildUtms({ platform: 'meta', objective, campaignName: name });
    for (const key of UTM_KEYS) {
      if (!dirtyFields.utms?.[key]) setValue(`utms.${key}`, generated[key]);
    }
  }, [name, objective, dirtyFields.utms, setValue]);

  const format = CREATIVE_FORMATS.meta.find((item) => item.key === values.formatKey);
  const findingsByVariation = values.variations.map((variation) => [
    ...checkCopyCompliance(variation.headline ?? ''),
    ...checkCopyCompliance(variation.primaryText ?? ''),
  ]);
  const hasComplianceProblem = findingsByVariation.some((findings) => findings.length > 0);

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
        hint={`${(values.variations[index]?.headline ?? '').length}/${HEADLINE_MAX}`}
      >
        <Input maxLength={HEADLINE_MAX} {...register(`variations.${index}.headline`)} />
      </Field>
      <Field
        label="Texto"
        error={errors.variations?.[index]?.primaryText?.message}
        hint={`${(values.variations[index]?.primaryText ?? '').length} caracteres — a Meta corta perto de ${PRIMARY_TEXT_RECOMMENDED}`}
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
        step={1}
        title="Plataforma"
        why="Onde o anúncio aparece. O nome é como você vai achar esta campanha no Gerenciador de Anúncios e nos relatórios — capriche nele."
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
        <Field label="Nome da campanha" error={errors.name?.message}>
          <Input placeholder="Ex.: Expansão SP — outubro" {...register('name')} />
        </Field>
      </BuilderSection>

      <BuilderSection
        step={2}
        title="Objetivo"
        why="Define como a Meta cobra e para quem mostra: dentro do seu público, ela procura quem tem mais chance de fazer exatamente isto."
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
        step={3}
        title="Perfil do cliente ideal"
        why="É o retrato de quem você quer atrair. Guia a copy e o criativo agora e vira a segmentação quando o conjunto de anúncios for criado."
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
        step={4}
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

      <BuilderSection
        step={5}
        title="Criativo"
        why="A imagem é o que faz a pessoa parar de rolar o feed. Uma por variação, para a Meta descobrir qual segura mais gente."
      >
        <div className="form-actions">
          <Button type="button" variant="ghost" disabled title="Integração com o Drive em breve">
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
            creativeId={values.variations[index]?.creativeId ?? ''}
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
        step={6}
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
        step={7}
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
        step={8}
        title="Variações"
        why="A Meta testa as versões entre si e entrega mais a que dá mais resultado. Com uma só, não há o que comparar."
      >
        <p className="field-hint">
          De {MIN_VARIATIONS} a {MAX_VARIATIONS} por campanha, para a plataforma ter o que comparar.
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

      <BuilderSection
        step={9}
        title="Duração"
        why="Por quanto tempo o anúncio roda. Nos primeiros dias a Meta ainda está aprendendo quem responde; campanha muito curta termina antes disso."
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
        step={10}
        title="Verba diária"
        why="É quanto você autoriza por dia. A Meta pode gastar até 25% a mais num dia, então o custo real é o estimado abaixo — e ele precisa caber no teto da conta."
      >
        <div className="builder-budget">
          <div>
            <Field
              label="Verba por dia (R$)"
              error={errors.dailyBudgetCents?.message}
              hint="A Meta pode gastar até 25% acima disto num dia."
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
                  {formatBrl(dailyBudgetCents)} × {days} dias × 1,25 de margem da plataforma
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
          <input type="checkbox" {...register('startPaused')} />
          <span>
            Criar a campanha <strong>pausada</strong>
            <small className="muted">
              {' '}
              — nasce sem entregar e sem reservar verba; ativar depois é outro pedido, com outra
              aprovação.
            </small>
          </span>
        </label>
      </BuilderSection>

      <BuilderSection
        step={11}
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
        step={12}
        title="Pré-visualização"
        why="O anúncio como a pessoa vai ver, com o corte do formato. É a última chance de pegar texto cortado ou imagem mal enquadrada."
      >
        <div className="ad-preview-row">
          {values.variations.map((variation, index) => (
            <AdPreview
              key={variations.fields[index]?.id ?? index}
              label={`Variação ${index + 1}`}
              creativeId={variation.creativeId}
              headline={variation.headline ?? ''}
              primaryText={variation.primaryText ?? ''}
              callToAction={variation.callToAction}
              destinationUrl={values.destinationUrl ?? ''}
              format={format}
            />
          ))}
        </div>
        <ApproximatePreviewNote />
      </BuilderSection>

      <BuilderSection
        step={13}
        title="Resumo — confira tudo"
        why="É exatamente o que o aprovador vai ler. Depois de lançado o pedido não pode ser editado — para mudar, faz-se outro."
      >
        <dl className="builder-summary">
          <dt>Plataforma</dt>
          <dd>Meta (Facebook + Instagram)</dd>
          <dt>Campanha</dt>
          <dd>{values.name || '—'}</dd>
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[values.objective]}</dd>
          <dt>Cliente ideal</dt>
          <dd className="builder-summary-clamp">{values.idealCustomerProfile || '—'}</dd>
          <dt>Alcance</dt>
          <dd>{describeReach(values.reach)}</dd>
          <dt>Formato</dt>
          <dd>{format ? `${format.label} (${format.ratio})` : '—'}</dd>
          <dt>Variações</dt>
          <dd>
            {values.variations.map((variation, index) => (
              <span key={index} className="builder-summary-line">
                {index + 1}. {variation.headline || '(sem título)'} ·{' '}
                {CALL_TO_ACTION_LABEL[variation.callToAction]}
              </span>
            ))}
          </dd>
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
            Há texto bloqueado pelo compliance. Corrija as variações acima.
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
            Pedido criado. Nada foi publicado: a campanha só existe na Meta depois que alguém
            aprovar e executar.{' '}
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
