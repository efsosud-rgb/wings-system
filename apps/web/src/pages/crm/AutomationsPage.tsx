import {
  AUTOMATION_RULE_KIND_LABELS,
  AUTOMATION_RULE_KINDS,
  EMAIL_TEMPLATE_VARIABLES,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  LEAD_TASK_KIND_LABELS,
  LEAD_TASK_KINDS,
  SEQUENCE_STEP_KINDS,
  type AutomationRule,
  type AutomationRuleKind,
  type AutomationSequence,
  type CrmStage,
  type EmailTemplate,
  type LeadPipeline,
  type Seller,
  type SequenceStepKind,
} from '@wings/shared';
import { useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import {
  useAutomationRules,
  useCreateRule,
  useDeleteRule,
  useEmailTemplates,
  useSaveSequence,
  useSaveTemplate,
  useSequences,
  useSetStageLimit,
  useStageLimits,
  useUpdateRule,
} from '../../api/automations.js';
import { useSellers, useStages } from '../../api/leads.js';
import { LoadFailure, Unavailable } from '../../components/LoadFailure.js';
import { stageTone } from './format.js';

/**
 * CRM Vendas → Configurações → Regras de automação (the Bitrix24 model): per
 * stage of a funnel, what happens when a deal enters it. Rules, e-mail
 * templates and sequences; `crm.manage` only. E-mails are recorded, not sent,
 * while the system runs in test mode (CRM_EMAIL_MODE).
 */

type Config = Record<string, unknown>;
type Tab = 'rules' | 'templates' | 'sequences';

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

const UNITS = [
  { key: 'min', label: 'minutos', factor: 1 },
  { key: 'h', label: 'horas', factor: 60 },
  { key: 'd', label: 'dias', factor: 1440 },
] as const;

/** 90 minutes reads "90 min", 120 reads "2 h", 2880 reads "2 dias". */
export function delayText(minutes: number): string {
  if (minutes === 0) return 'ao entrar na etapa';
  if (minutes % 1440 === 0) return `${minutes / 1440} ${minutes === 1440 ? 'dia' : 'dias'} depois`;
  if (minutes % 60 === 0) return `${minutes / 60} h depois`;
  return `${minutes} min depois`;
}

/** What a screen needs of a query to tell "nothing there" from "could not load". */
interface ListQuery {
  isLoading: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: unknown;
  refetch: () => unknown;
}

interface Refs {
  sellers: Seller[];
  templates: EmailTemplate[];
  sequences: AutomationSequence[];
}

const personName = (id: string, sellers: Seller[]) =>
  id === 'owner'
    ? 'o responsável'
    : (sellers.find((s) => s.id === id)?.name.split(' ')[0] ?? 'alguém');

export function describeRule(kind: string, config: Config, refs: Refs): string {
  switch (kind as AutomationRuleKind) {
    case 'create_task':
      return `Criar tarefa “${String(config.title ?? '')}” para ${personName(
        String(config.assignee ?? 'owner'),
        refs.sellers,
      )}, prazo de ${String(config.dueInHours ?? 0)} h${config.businessHours === false ? '' : ' úteis'}`;
    case 'change_owner':
      return config.to === 'rotation'
        ? 'Passar para o próximo do rodízio'
        : `Passar para ${personName(String(config.to ?? ''), refs.sellers)}`;
    case 'notify':
      return `Avisar ${((config.recipients as string[] | undefined) ?? [])
        .map((r) => personName(r, refs.sellers))
        .join(', ')}: “${String(config.message ?? '')}”`;
    case 'start_sequence':
      return `Iniciar a sequência “${
        refs.sequences.find((s) => s.id === config.sequenceId)?.name ?? '—'
      }”`;
    case 'send_email':
      return `Enviar o modelo “${
        refs.templates.find((t) => t.id === config.templateId)?.name ?? '—'
      }”`;
    default:
      return kind;
  }
}

// --- the editor of one action's settings (shared by rules and sequence steps) ----------------

function ConfigEditor({
  kind,
  config,
  onChange,
  refs,
}: {
  kind: AutomationRuleKind | SequenceStepKind;
  config: Config;
  onChange: (next: Config) => void;
  refs: Refs;
}) {
  const set = (patch: Config) => onChange({ ...config, ...patch });
  const people = (
    <>
      <option value="owner">Responsável pela negociação</option>
      {refs.sellers
        .filter((s) => s.active)
        .map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
    </>
  );
  if (kind === 'create_task')
    return (
      <>
        <label className="crm-field is-wide">
          <span>Título da tarefa</span>
          <input
            className="crm-input"
            value={String(config.title ?? '')}
            maxLength={160}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label className="crm-field">
          <span>Tipo</span>
          <select
            className="crm-select"
            value={String(config.taskKind ?? 'follow_up')}
            onChange={(e) => set({ taskKind: e.target.value })}
          >
            {LEAD_TASK_KINDS.map((k) => (
              <option key={k} value={k}>
                {LEAD_TASK_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="crm-field">
          <span>Prazo (horas)</span>
          <input
            className="crm-input"
            type="number"
            min={0}
            max={2160}
            value={Number(config.dueInHours ?? 0)}
            onChange={(e) => set({ dueInHours: Number(e.target.value) })}
          />
        </label>
        <label className="crm-field">
          <span>Contar</span>
          <select
            className="crm-select"
            value={config.businessHours === false ? 'clock' : 'business'}
            onChange={(e) => set({ businessHours: e.target.value === 'business' })}
          >
            <option value="business">Horas úteis (seg–sex, 9h–18h)</option>
            <option value="clock">Horas corridas</option>
          </select>
        </label>
        <label className="crm-field">
          <span>Para</span>
          <select
            className="crm-select"
            value={String(config.assignee ?? 'owner')}
            onChange={(e) => set({ assignee: e.target.value })}
          >
            {people}
          </select>
        </label>
      </>
    );
  if (kind === 'change_owner')
    return (
      <label className="crm-field is-wide">
        <span>Passar a negociação para</span>
        <select
          className="crm-select"
          value={String(config.to ?? 'rotation')}
          onChange={(e) => set({ to: e.target.value })}
        >
          <option value="rotation">Próximo do rodízio do funil</option>
          {refs.sellers
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
    );
  if (kind === 'notify') {
    const chosen = (config.recipients as string[] | undefined) ?? ['owner'];
    const toggle = (id: string) =>
      set({ recipients: chosen.includes(id) ? chosen.filter((c) => c !== id) : [...chosen, id] });
    return (
      <>
        <fieldset className="crm-field is-wide" style={{ border: 0, padding: 0 }}>
          <span>Avisar</span>
          <span className="crm-quick-row" style={{ justifyContent: 'flex-start' }}>
            {[{ id: 'owner', name: 'Responsável' }, ...refs.sellers.filter((s) => s.active)].map(
              (p) => (
                <label key={p.id}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.id)}
                    onChange={() => toggle(p.id)}
                  />{' '}
                  {p.name.split(' ')[0]}
                </label>
              ),
            )}
          </span>
        </fieldset>
        <label className="crm-field is-wide">
          <span>Mensagem do aviso (sem dados pessoais)</span>
          <input
            className="crm-input"
            value={String(config.message ?? '')}
            maxLength={240}
            onChange={(e) => set({ message: e.target.value })}
          />
        </label>
      </>
    );
  }
  if (kind === 'start_sequence')
    return (
      <label className="crm-field is-wide">
        <span>Sequência</span>
        <select
          className="crm-select"
          value={String(config.sequenceId ?? '')}
          onChange={(e) => set({ sequenceId: e.target.value })}
        >
          <option value="">Escolha…</option>
          {refs.sequences
            .filter((s) => s.active)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
      </label>
    );
  return (
    <label className="crm-field is-wide">
      <span>Modelo de e-mail</span>
      <select
        className="crm-select"
        value={String(config.templateId ?? '')}
        onChange={(e) => set({ templateId: e.target.value })}
      >
        <option value="">Escolha…</option>
        {refs.templates
          .filter((t) => t.active)
          .map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
      </select>
    </label>
  );
}

const DEFAULT_CONFIG: Record<AutomationRuleKind, Config> = {
  create_task: {
    title: '',
    taskKind: 'follow_up',
    dueInHours: 4,
    businessHours: true,
    assignee: 'owner',
  },
  change_owner: { to: 'rotation' },
  notify: { recipients: ['owner'], message: '' },
  start_sequence: { sequenceId: '' },
  send_email: { templateId: '' },
};

// --- rules, per stage ----------------------------------------------------------------------

function AddRule({
  stage,
  pipeline,
  refs,
  onDone,
}: {
  stage: CrmStage;
  pipeline: LeadPipeline;
  refs: Refs;
  onDone: () => void;
}) {
  const create = useCreateRule();
  const [kind, setKind] = useState<AutomationRuleKind>('create_task');
  const [config, setConfig] = useState<Config>(DEFAULT_CONFIG.create_task);
  const [amount, setAmount] = useState(0);
  const [unit, setUnit] = useState<(typeof UNITS)[number]['key']>('h');
  const factor = UNITS.find((u) => u.key === unit)!.factor;
  return (
    <form
      className="crm-panel"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate(
          {
            pipeline,
            stageId: stage.id,
            kind,
            config,
            delayMinutes: amount * factor,
          } as never,
          { onSuccess: onDone },
        );
      }}
    >
      {create.error ? (
        <p className="crm-error">{errorText(create.error, 'Não foi possível criar a regra.')}</p>
      ) : null}
      <div className="crm-two">
        <label className="crm-field">
          <span>Ação</span>
          <select
            className="crm-select"
            value={kind}
            onChange={(e) => {
              const next = e.target.value as AutomationRuleKind;
              setKind(next);
              setConfig(DEFAULT_CONFIG[next]);
            }}
          >
            {AUTOMATION_RULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {AUTOMATION_RULE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="crm-field">
          <span>Quando (depois de entrar; 0 = na hora)</span>
          <span className="crm-quick-row" style={{ justifyContent: 'flex-start' }}>
            <input
              className="crm-input"
              type="number"
              min={0}
              style={{ width: 80 }}
              value={amount}
              onChange={(e) => setAmount(Math.max(0, Number(e.target.value)))}
            />
            <select
              className="crm-select"
              value={unit}
              onChange={(e) => setUnit(e.target.value as typeof unit)}
            >
              {UNITS.map((u) => (
                <option key={u.key} value={u.key}>
                  {u.label}
                </option>
              ))}
            </select>
          </span>
        </label>
        <ConfigEditor kind={kind} config={config} onChange={setConfig} refs={refs} />
      </div>
      <div className="crm-form-actions">
        <button type="button" className="crm-btn is-small is-quiet" onClick={onDone}>
          Cancelar
        </button>
        <button type="submit" className="crm-btn is-small is-primary" disabled={create.isPending}>
          Adicionar regra
        </button>
      </div>
    </form>
  );
}

function StageRules({
  stage,
  rules,
  pipeline,
  refs,
}: {
  stage: CrmStage;
  rules: AutomationRule[];
  pipeline: LeadPipeline;
  refs: Refs;
}) {
  const update = useUpdateRule();
  const remove = useDeleteRule();
  const limits = useStageLimits();
  const setLimit = useSetStageLimit();
  const [adding, setAdding] = useState(false);
  const limit = limits.data?.limits.find((l) => l.stageId === stage.id)?.maxDays;
  return (
    <section className="crm-panel">
      <h2>
        <span className="crm-stage-dot" style={stageTone(stage.position) as React.CSSProperties} />{' '}
        {stage.position}. {stage.name}
      </h2>
      {(update.error ?? remove.error) ? (
        <p className="crm-error">
          {errorText(update.error ?? remove.error, 'Não foi possível alterar a regra.')}
        </p>
      ) : null}
      {rules.length === 0 ? (
        <p className="crm-sub">Nenhuma regra: nada acontece sozinho nesta etapa.</p>
      ) : (
        <div className="crm-stage-list">
          {rules.map((rule) => (
            <div key={rule.id} className="crm-stage-row" style={{ opacity: rule.active ? 1 : 0.6 }}>
              <span>
                <b>{AUTOMATION_RULE_KIND_LABELS[rule.kind]}</b>
                <span className="crm-sub"> · {delayText(rule.delayMinutes)}</span>
                <br />
                <span className="crm-sub">{describeRule(rule.kind, rule.config, refs)}</span>
              </span>
              <span className="crm-quick-row">
                <button
                  type="button"
                  className="crm-btn is-small is-quiet"
                  disabled={update.isPending}
                  onClick={() => update.mutate({ id: rule.id, active: !rule.active })}
                >
                  {rule.active ? 'Desligar' : 'Ligar'}
                </button>
                <button
                  type="button"
                  className="crm-btn is-small is-quiet"
                  disabled={remove.isPending}
                  onClick={() => {
                    if (window.confirm('Remover esta regra?')) remove.mutate(rule.id);
                  }}
                >
                  Remover
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {limits.isError && !limits.data ? (
        // A blank field means "the system default": it must not stand for a limit nobody could read.
        <p className="crm-sub">
          Avisar negociação parada após quantos dias: <Unavailable error={limits.error} />
        </p>
      ) : (
        <label className="crm-sub" title="Dias parada na etapa antes de o painel avisar; 0 desliga">
          Avisar negociação parada após{' '}
          <input
            className="crm-input"
            type="number"
            min={0}
            max={365}
            placeholder="7"
            defaultValue={limit}
            key={limit ?? 'padrao'}
            disabled={!limits.data}
            style={{ width: 64, padding: '2px 6px' }}
            onBlur={(e) => {
              if (e.target.value === '') return;
              const value = Number(e.target.value);
              if (Number.isInteger(value) && value >= 0 && value <= 365 && value !== limit)
                setLimit.mutate({ stageId: stage.id, maxDays: value });
            }}
          />{' '}
          dias (em branco: padrão do sistema)
        </label>
      )}
      {adding ? (
        <AddRule stage={stage} pipeline={pipeline} refs={refs} onDone={() => setAdding(false)} />
      ) : (
        <button type="button" className="crm-btn is-small" onClick={() => setAdding(true)}>
          + Adicionar regra
        </button>
      )}
    </section>
  );
}

// --- e-mail templates ---------------------------------------------------------------------------

function Templates({ templates, query }: { templates: EmailTemplate[]; query: ListQuery }) {
  const save = useSaveTemplate();
  const empty = {
    id: undefined as string | undefined,
    name: '',
    subject: '',
    body: '',
    active: true,
  };
  const [form, setForm] = useState(empty);
  return (
    <div className="crm-stack">
      <section className="crm-panel">
        <h2>Modelos de e-mail</h2>
        <p className="crm-sub">
          Variáveis: {EMAIL_TEMPLATE_VARIABLES.map((v) => `{{${v}}}`).join(' · ')}. Em modo de teste
          o e-mail só é gravado na ficha do lead; nada sai do servidor.
        </p>
        <div className="crm-stage-list">
          {templates.map((t) => (
            <div key={t.id} className="crm-stage-row" style={{ opacity: t.active ? 1 : 0.6 }}>
              <span>
                <b>{t.name}</b>
                <span className="crm-sub"> · {t.subject}</span>
              </span>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setForm({ ...t })}
              >
                Editar
              </button>
            </div>
          ))}
          {query.isLoading ? <p className="crm-sub">Carregando…</p> : null}
          {query.isError ? (
            <LoadFailure
              what="os modelos de e-mail"
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          ) : null}
          {query.isSuccess && templates.length === 0 ? (
            <p className="crm-sub">Nenhum modelo ainda.</p>
          ) : null}
        </div>
      </section>
      <form
        className="crm-panel"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form, { onSuccess: () => setForm(empty) });
        }}
      >
        <h2>{form.id ? 'Editar modelo' : 'Novo modelo'}</h2>
        {save.error ? (
          <p className="crm-error">{errorText(save.error, 'Não foi possível salvar o modelo.')}</p>
        ) : null}
        <label className="crm-field">
          <span>Nome</span>
          <input
            className="crm-input"
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        <label className="crm-field">
          <span>Assunto</span>
          <input
            className="crm-input"
            value={form.subject}
            maxLength={160}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          />
        </label>
        <label className="crm-field">
          <span>Mensagem</span>
          <textarea
            className="crm-textarea"
            rows={8}
            value={form.body}
            maxLength={8000}
            onChange={(e) => setForm({ ...form, body: e.target.value })}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />{' '}
          Modelo ativo
        </label>
        <div className="crm-form-actions">
          {form.id ? (
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() => setForm(empty)}
            >
              Cancelar
            </button>
          ) : null}
          <button type="submit" className="crm-btn is-small is-primary" disabled={save.isPending}>
            Salvar modelo
          </button>
        </div>
      </form>
    </div>
  );
}

// --- sequences ------------------------------------------------------------------------------------

interface StepDraft {
  kind: SequenceStepKind;
  afterHours: number;
  config: Config;
}

function Sequences({
  sequences,
  query,
  refs,
}: {
  sequences: AutomationSequence[];
  query: ListQuery;
  refs: Refs;
}) {
  const save = useSaveSequence();
  const empty = {
    id: undefined as string | undefined,
    name: '',
    active: true,
    steps: [
      { kind: 'create_task', afterHours: 0, config: DEFAULT_CONFIG.create_task },
    ] as StepDraft[],
  };
  const [form, setForm] = useState(empty);
  const setStep = (index: number, patch: Partial<StepDraft>) =>
    setForm({
      ...form,
      steps: form.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)),
    });
  return (
    <div className="crm-stack">
      <section className="crm-panel">
        <h2>Sequências de follow-up</h2>
        <p className="crm-sub">
          Uma sequência é uma lista de passos com intervalo. Ela para sozinha quando a negociação
          sai da etapa que a iniciou ou é encerrada.
        </p>
        <div className="crm-stage-list">
          {sequences.map((s) => (
            <div key={s.id} className="crm-stage-row" style={{ opacity: s.active ? 1 : 0.6 }}>
              <span>
                <b>{s.name}</b>
                <span className="crm-sub"> · {s.steps.length} passos</span>
              </span>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() =>
                  setForm({
                    id: s.id,
                    name: s.name,
                    active: s.active,
                    steps: s.steps.map((st) => ({
                      kind: st.kind,
                      afterHours: st.afterHours,
                      config: st.config,
                    })),
                  })
                }
              >
                Editar
              </button>
            </div>
          ))}
          {query.isLoading ? <p className="crm-sub">Carregando…</p> : null}
          {query.isError ? (
            <LoadFailure
              what="as sequências"
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          ) : null}
          {query.isSuccess && sequences.length === 0 ? (
            <p className="crm-sub">Nenhuma sequência ainda.</p>
          ) : null}
        </div>
      </section>
      <form
        className="crm-panel"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(form as never, { onSuccess: () => setForm(empty) });
        }}
      >
        <h2>{form.id ? 'Editar sequência' : 'Nova sequência'}</h2>
        {save.error ? (
          <p className="crm-error">
            {errorText(save.error, 'Não foi possível salvar a sequência.')}
          </p>
        ) : null}
        <label className="crm-field">
          <span>Nome</span>
          <input
            className="crm-input"
            value={form.name}
            maxLength={80}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        </label>
        {form.steps.map((step, index) => (
          <div key={index} className="crm-two">
            <label className="crm-field">
              <span>
                Passo {index + 1} · depois de (horas
                {index === 0 ? ', desde o início' : ', do passo anterior'})
              </span>
              <input
                className="crm-input"
                type="number"
                min={0}
                value={step.afterHours}
                onChange={(e) =>
                  setStep(index, { afterHours: Math.max(0, Number(e.target.value)) })
                }
              />
            </label>
            <label className="crm-field">
              <span>Ação</span>
              <select
                className="crm-select"
                value={step.kind}
                onChange={(e) => {
                  const kind = e.target.value as SequenceStepKind;
                  setStep(index, { kind, config: DEFAULT_CONFIG[kind] });
                }}
              >
                {SEQUENCE_STEP_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {AUTOMATION_RULE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </label>
            <ConfigEditor
              kind={step.kind}
              config={step.config}
              refs={refs}
              onChange={(config) => setStep(index, { config })}
            />
            {form.steps.length > 1 ? (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() =>
                  setForm({ ...form, steps: form.steps.filter((_, i) => i !== index) })
                }
              >
                Remover passo {index + 1}
              </button>
            ) : null}
          </div>
        ))}
        <button
          type="button"
          className="crm-btn is-small"
          disabled={form.steps.length >= 20}
          onClick={() =>
            setForm({
              ...form,
              steps: [
                ...form.steps,
                { kind: 'create_task', afterHours: 24, config: DEFAULT_CONFIG.create_task },
              ],
            })
          }
        >
          + Passo
        </button>
        <label>
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => setForm({ ...form, active: e.target.checked })}
          />{' '}
          Sequência ativa
        </label>
        <div className="crm-form-actions">
          {form.id ? (
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              onClick={() => setForm(empty)}
            >
              Cancelar
            </button>
          ) : null}
          <button type="submit" className="crm-btn is-small is-primary" disabled={save.isPending}>
            Salvar sequência
          </button>
        </div>
      </form>
    </div>
  );
}

// --- the page ---------------------------------------------------------------------------------------

export function AutomationsPage() {
  const params = useParams();
  const pipeline = LEAD_PIPELINES.find((p) => p === params.pipeline);
  if (!pipeline) return <Navigate to="/crm-vendas/configuracoes" replace />;
  return <AutomationsScreen pipeline={pipeline} />;
}

function AutomationsScreen({ pipeline }: { pipeline: LeadPipeline }) {
  const [tab, setTab] = useState<Tab>('rules');
  const stages = useStages(pipeline);
  const rules = useAutomationRules(pipeline);
  const templates = useEmailTemplates();
  const sequences = useSequences();
  const sellers = useSellers();
  const refs: Refs = {
    sellers: sellers.data?.sellers ?? [],
    templates: templates.data?.templates ?? [],
    sequences: sequences.data?.sequences ?? [],
  };
  const active = (stages.data?.stages ?? []).filter((s) => s.active);
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Regras de automação · {LEAD_PIPELINE_LABELS[pipeline]}</h1>
        <span className="crm-head-spacer" />
        <div className="crm-segment" role="group" aria-label="Funil">
          {LEAD_PIPELINES.map((p) => (
            <Link
              key={p}
              to={`/crm-vendas/configuracoes/automacoes/${p}`}
              className={p === pipeline ? 'is-active' : ''}
            >
              {LEAD_PIPELINE_LABELS[p]}
            </Link>
          ))}
        </div>
        <div className="crm-segment" role="group">
          {(
            [
              ['rules', 'Regras'],
              ['templates', 'Modelos de e-mail'],
              ['sequences', 'Sequências'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? 'is-active' : ''}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>
      <div className="crm-page-scroll crm-stack">
        <Link className="crm-sub" to="/crm-vendas/configuracoes">
          ← Configurações do CRM
        </Link>
        {tab === 'rules' && (
          <>
            {stages.isError && (
              <LoadFailure
                what="as etapas"
                error={stages.error}
                onRetry={() => void stages.refetch()}
              />
            )}
            {rules.isError && (
              <LoadFailure
                what="as regras"
                error={rules.error}
                onRetry={() => void rules.refetch()}
              />
            )}
            {/* The rules read their names from these; without them a rule shows "alguém" or "—". */}
            {templates.isError && (
              <LoadFailure
                what="os modelos de e-mail"
                error={templates.error}
                onRetry={() => void templates.refetch()}
              />
            )}
            {sequences.isError && (
              <LoadFailure
                what="as sequências"
                error={sequences.error}
                onRetry={() => void sequences.refetch()}
              />
            )}
            {sellers.isError && (
              <LoadFailure
                what="os vendedores"
                error={sellers.error}
                onRetry={() => void sellers.refetch()}
              />
            )}
            {stages.isLoading || rules.isLoading ? (
              <p className="crm-sub">Carregando…</p>
            ) : (
              // Without the rules, "Nenhuma regra" under every stage would be a made-up answer.
              stages.data &&
              rules.data &&
              active.map((stage) => (
                <StageRules
                  key={stage.id}
                  stage={stage}
                  pipeline={pipeline}
                  refs={refs}
                  rules={rules.data.rules.filter((r) => r.stageId === stage.id)}
                />
              ))
            )}
          </>
        )}
        {tab === 'templates' && <Templates templates={refs.templates} query={templates} />}
        {tab === 'sequences' && (
          <Sequences sequences={refs.sequences} query={sequences} refs={refs} />
        )}
      </div>
    </div>
  );
}
