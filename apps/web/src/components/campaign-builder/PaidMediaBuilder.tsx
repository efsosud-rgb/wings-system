import { zodResolver } from '@hookform/resolvers/zod';
import {
  CALLS_TO_ACTION,
  CALL_TO_ACTION_LABEL,
  CAMPAIGN_OBJECTIVES,
  CAMPAIGN_OBJECTIVE_HINT,
  CAMPAIGN_OBJECTIVE_LABEL,
  COMPLIANCE_RULE_ADVICE,
  COMPLIANCE_RULE_LABEL,
  CREATIVE_FORMATS,
  HEADLINE_MAX,
  MAX_VARIATIONS,
  MIN_VARIATIONS,
  PAID_PLATFORMS,
  PRIMARY_TEXT_RECOMMENDED,
  UTM_KEYS,
  applyUtms,
  buildUtms,
  campaignDays,
  campaignDaysInMonth,
  campaignDraftSchema,
  checkCopyCompliance,
  estimateCostCents,
  type CampaignDraft,
  type CampaignDraftInput,
  type ComplianceFinding,
  type PacingSummary,
} from '@wings/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { useFieldArray, useForm, type Resolver } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { useCockpit, useRequestCampaign } from '../../api/ads.js';
import { Alert, Button, Field, Input, Select } from '../ui.js';
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
  children,
}: {
  step: number;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="builder-section" aria-labelledby={`builder-step-${step}`}>
      <h2 id={`builder-step-${step}`}>
        <span className="builder-step">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function PendingInThisWave({ children }: { children: ReactNode }) {
  return <p className="builder-pending muted">🚧 {children}</p>;
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
      formatKey: 'feed_square',
      destinationUrl: '',
      variations: Array.from({ length: MIN_VARIATIONS }, () => ({
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
  const [checked, setChecked] = useState<CampaignDraft | null>(null);

  const values = watch();
  const days = campaignDays(values.startDate, values.endDate);
  const dailyBudgetCents = Number.isFinite(values.dailyBudgetCents) ? values.dailyBudgetCents : 0;
  const totalCostCents = days ? estimateCostCents(dailyBudgetCents, days) : null;
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
      <BuilderSection step={1} title="Plataforma">
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

      <BuilderSection step={2} title="Objetivo">
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

      <BuilderSection step={3} title="Perfil do cliente ideal">
        <PendingInThisWave>
          Texto editável salvo para a Wings — entra na etapa 4 desta onda.
        </PendingInThisWave>
      </BuilderSection>

      <BuilderSection step={4} title="Área de alcance">
        <PendingInThisWave>Cidades e estados — entra na etapa 4 desta onda.</PendingInThisWave>
      </BuilderSection>

      <BuilderSection step={5} title="Criativo">
        <div className="form-actions">
          <Button type="button" variant="ghost" disabled title="Integração com o Drive em breve">
            Escolher do Drive (em breve)
          </Button>
        </div>
        <PendingInThisWave>
          Upload direto da imagem — entra junto com a pré-visualização, na etapa 3 desta onda.
        </PendingInThisWave>
      </BuilderSection>

      <BuilderSection step={6} title="Formato e dimensão">
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

      <BuilderSection step={7} title="Copy">
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

      <BuilderSection step={8} title="Variações">
        <p className="field-hint">
          De {MIN_VARIATIONS} a {MAX_VARIATIONS} por campanha, para a plataforma ter o que comparar.
        </p>
        {variations.fields.slice(1).map((_, offset) => copyFields(offset + 1))}
        {variations.fields.length < MAX_VARIATIONS && (
          <Button
            type="button"
            variant="ghost"
            onClick={() =>
              variations.append({ headline: '', primaryText: '', callToAction: 'LEARN_MORE' })
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

      <BuilderSection step={9} title="Duração">
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

      <BuilderSection step={10} title="Verba diária">
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
                {...register('dailyBudgetCents', { setValueAs: parseBrlToCents })}
              />
            </Field>
            <div className="builder-cost">
              <span className="field-label">Custo total estimado</span>
              <p className="mono builder-ceiling-figure">
                {totalCostCents && dailyBudgetCents > 0 ? formatBrl(totalCostCents) : '—'}
              </p>
              {days !== null && dailyBudgetCents > 0 && (
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

      <BuilderSection step={11} title="UTMs">
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

      <BuilderSection step={12} title="Pré-visualização">
        <PendingInThisWave>
          Prévia do anúncio gerada pela Meta — entra na etapa 3 desta onda.
        </PendingInThisWave>
      </BuilderSection>

      <BuilderSection step={13} title="Resumo — confira tudo">
        <dl className="builder-summary">
          <dt>Plataforma</dt>
          <dd>Meta (Facebook + Instagram)</dd>
          <dt>Campanha</dt>
          <dd>{values.name || '—'}</dd>
          <dt>Objetivo</dt>
          <dd>{CAMPAIGN_OBJECTIVE_LABEL[values.objective]}</dd>
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
          <dd className="mono">
            {totalCostCents && dailyBudgetCents > 0 ? formatBrl(totalCostCents) : '—'}
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
