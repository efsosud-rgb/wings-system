import {
  SOFIA_DEFAULT_SETTINGS,
  SOFIA_FIELD_TARGET_LABELS,
  SOFIA_FIELD_TARGETS,
  SOFIA_OPTION_MAX,
  SOFIA_OPTIONS_MAX,
  SOFIA_QUESTION_KIND_LABELS,
  SOFIA_QUESTION_KINDS,
  sofiaSettingsSchema,
  type SofiaFieldTarget,
  type SofiaQuestion,
  type SofiaQuestionKind,
  type SofiaSettings,
  type SofiaTexts,
} from '@wings/shared';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError } from '../../api/client.js';
import { useSaveSofiaSettings, useSofiaSettings } from '../../api/sofia.js';
import { formatDateTime } from './format.js';

/**
 * Sofia's settings: on/off, everything she says that is not a question, and
 * the questions of each funnel. Everyone who sees the screen reads them; only
 * `sofia.manage` edits (the server checks it, and validates the whole form
 * again with the same schema used here).
 */

const TEXT_FIELDS: Record<keyof SofiaTexts, { label: string; hint: string; max: number }> = {
  greeting: {
    label: 'Apresentação',
    hint: 'Primeira mensagem de toda conversa: precisa dizer "atendente virtual" e ter {quem}.',
    max: 400,
  },
  objective: {
    label: 'Objetivo',
    hint: 'Vai com três botões: Franquear negócio · Abrir uma franquia · Outro assunto.',
    max: 300,
  },
  otherSubject: {
    label: 'Outro assunto',
    hint: 'Depois de "Outro assunto": pede que a pessoa conte do que se trata.',
    max: 300,
  },
  brandConfirm: {
    label: 'Confirmar a marca',
    hint: 'Quando o link ou o anúncio já traz a marca; {marca} vira o nome dela.',
    max: 300,
  },
  brandQuestion: {
    label: 'Perguntar a marca',
    hint: 'Expansão sem marca conhecida.',
    max: 300,
  },
  handoffSeller: {
    label: 'Passagem ao vendedor',
    hint: 'A negociação foi criada e já tem vendedor.',
    max: 400,
  },
  handoffHuman: {
    label: 'Passagem a uma pessoa',
    hint: 'Para alguém da equipe, sem negociação.',
    max: 400,
  },
  outOfHours: {
    label: 'Fora do horário',
    hint: 'Somado à passagem fora de segunda a sexta, 9h às 18h (horário de Brasília).',
    max: 400,
  },
  values: {
    label: 'Valores',
    hint: 'Quando a pessoa pergunta preço ou condições.',
    max: 300,
  },
  notUnderstood: {
    label: 'Não entendeu',
    hint: 'Antes de perguntar a mesma coisa de novo.',
    max: 200,
  },
  media: {
    label: 'Áudio ou arquivo',
    hint: 'Áudio, imagem ou arquivo enquanto a pessoa fala com a Sofia.',
    max: 300,
  },
  optOut: {
    label: 'Pedido para sair',
    hint: 'Depois de SAIR ou PARAR.',
    max: 300,
  },
  aiDown: {
    label: 'IA fora do ar',
    hint: 'A IA falhou ou o teto diário acabou: uma pessoa assume.',
    max: 300,
  },
};

type ListKey = 'formatacao' | 'expansao';

const LIST_LABELS: Record<ListKey, string> = {
  formatacao: 'Perguntas de Formatação',
  expansao: 'Perguntas de Expansão',
};

/** A question being edited; `fresh` ones (never saved) take their key from the label. */
interface Row {
  uid: string;
  fresh: boolean;
  question: SofiaQuestion;
}

interface Draft {
  enabled: boolean;
  texts: SofiaTexts;
  formatacao: Row[];
  expansao: Row[];
}

let nextUid = 0;
const uid = () => `q${++nextUid}`;

const toDraft = (settings: SofiaSettings): Draft => ({
  enabled: settings.enabled,
  texts: { ...settings.texts },
  formatacao: settings.formatacao.map((question) => ({ uid: uid(), fresh: false, question })),
  expansao: settings.expansao.map((question) => ({ uid: uid(), fresh: false, question })),
});

/** Options are edited one per line: blank lines go, and only a choice keeps them. */
const cleanQuestion = (question: SofiaQuestion): SofiaQuestion => ({
  ...question,
  options: question.kind === 'choice' ? question.options.map((o) => o.trim()).filter(Boolean) : [],
});

const fromDraft = (draft: Draft): SofiaSettings => ({
  enabled: draft.enabled,
  texts: draft.texts,
  formatacao: draft.formatacao.map((row) => cleanQuestion(row.question)),
  expansao: draft.expansao.map((row) => cleanQuestion(row.question)),
});

/** "Faturamento anual" → `faturamento_anual`: ascii, unique in its list, within the schema's pattern. */
export function keyFromLabel(label: string, taken: readonly string[]): string {
  let base = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 31)
    .replace(/_+$/, '');
  if (base.length < 2) base = 'pergunta';
  let key = base;
  for (let n = 2; taken.includes(key); n += 1) {
    const suffix = `_${n}`;
    key = `${base.slice(0, 31 - suffix.length).replace(/_+$/, '')}${suffix}`;
  }
  return key;
}

/** Where a schema issue is, in the words of the form ("Perguntas de Expansão, pergunta 3"). */
function whereOf(path: readonly unknown[]): string | null {
  const [section, index] = path;
  if (section === 'texts' && typeof index === 'string' && index in TEXT_FIELDS)
    return TEXT_FIELDS[index as keyof SofiaTexts].label;
  if (section === 'formatacao' || section === 'expansao')
    return typeof index === 'number'
      ? `${LIST_LABELS[section]}, pergunta ${index + 1}`
      : LIST_LABELS[section];
  return null;
}

const located = (message: string, path: readonly unknown[]) => {
  const where = whereOf(path);
  return where ? `${where}: ${message}` : message;
};

/** Portuguese for the length limits the schema leaves without words of its own. */
const lengthInPortuguese: z.core.$ZodErrorMap = (issue) => {
  if (issue.code === 'too_small' && issue.origin === 'string')
    return `Escreva ao menos ${String(issue.minimum)} caracteres.`;
  if (issue.code === 'too_big' && issue.origin === 'string')
    return `Até ${String(issue.maximum)} caracteres.`;
  return undefined;
};

/** The field the server pointed at, when its refusal says. */
const pathOf = (error: ApiError): unknown[] => {
  const path = (error.body as { path?: unknown }).path;
  return Array.isArray(path) ? path : [];
};

export function SofiaSettingsForm({ canManage }: { canManage: boolean }) {
  const loaded = useSofiaSettings();
  if (loaded.isLoading) return <p className="crm-muted">Carregando a configuração…</p>;
  if (loaded.isError || !loaded.data)
    return <p className="crm-error">Não foi possível carregar a configuração da Sofia.</p>;
  return (
    <SettingsEditor
      initial={loaded.data.settings}
      updatedAt={loaded.data.updatedAt}
      updatedBy={loaded.data.updatedBy}
      canManage={canManage}
    />
  );
}

function SettingsEditor({
  initial,
  updatedAt,
  updatedBy,
  canManage,
}: {
  initial: SofiaSettings;
  updatedAt: string | null;
  updatedBy: string | null;
  canManage: boolean;
}) {
  const save = useSaveSofiaSettings();
  const [draft, setDraft] = useState(() => toDraft(initial));
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const change = (fn: (current: Draft) => Draft) => {
    setDraft(fn);
    setSaved(false);
  };
  const setText = (key: keyof SofiaTexts, value: string) =>
    change((d) => ({ ...d, texts: { ...d.texts, [key]: value } }));
  const setRows = (list: ListKey, rows: Row[]) => change((d) => ({ ...d, [list]: rows }));

  const restore = () => {
    if (!window.confirm('Trocar textos e perguntas pelos padrões? Nada muda até você salvar.'))
      return;
    change((d) => toDraft({ ...SOFIA_DEFAULT_SETTINGS, enabled: d.enabled }));
    setProblem(null);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    setProblem(null);
    save.reset();
    const parsed = sofiaSettingsSchema.safeParse(fromDraft(draft), { error: lengthInPortuguese });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setProblem(issue ? located(issue.message, issue.path) : 'Configuração inválida.');
      return;
    }
    save.mutate(parsed.data, {
      onSuccess: (result) => {
        setDraft(toDraft(result.settings));
        setSaved(true);
      },
    });
  };

  const serverProblem =
    save.error instanceof ApiError
      ? located(save.error.message, pathOf(save.error))
      : save.error
        ? 'Não foi possível salvar. Tente de novo.'
        : null;
  const message = problem ?? serverProblem;

  return (
    <form className="sofia-form" onSubmit={submit} noValidate>
      {!canManage && (
        <p className="sofia-note">
          Você pode ler a configuração; só quem tem a permissão de configurar a Sofia altera.
        </p>
      )}
      <fieldset className="sofia-fieldset" disabled={!canManage}>
        <section className="crm-panel" aria-label="Ligar e desligar">
          <h2>Ligar e desligar</h2>
          <label className="sofia-switch">
            <input
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              onChange={(e) => change((d) => ({ ...d, enabled: e.target.checked }))}
            />
            <span className="sofia-switch-track" aria-hidden="true" />
            <span>Sofia ligada</span>
          </label>
          <p className="crm-sub">
            Ligada, a Sofia responde toda conversa nova do WhatsApp. Desligada, as conversas novas
            esperam um atendente.
          </p>
          <p className="crm-muted">
            {updatedAt
              ? `Última alteração: ${formatDateTime(updatedAt)}${updatedBy ? ` por ${updatedBy}` : ''}`
              : 'Ainda não foi salva: valem os textos e perguntas padrão.'}
          </p>
        </section>

        <section className="crm-panel" aria-label="Mensagens">
          <h2>Mensagens</h2>
          <p className="sofia-note">
            Use {'{quem}'} (vira &quot;da Wings Company&quot; ou &quot;do time de expansão da
            &lt;marca&gt;&quot;), {'{empresa}'} e {'{marca}'}. Não escreva Wings: lead de franquia
            nunca ouve falar da Wings.
          </p>
          <div className="sofia-texts">
            {(Object.keys(TEXT_FIELDS) as (keyof SofiaTexts)[]).map((key) => {
              const field = TEXT_FIELDS[key];
              const id = `sofia-text-${key}`;
              return (
                <div key={key} className="crm-field">
                  <label htmlFor={id}>{field.label}</label>
                  <textarea
                    id={id}
                    className="crm-textarea"
                    rows={3}
                    maxLength={field.max}
                    aria-describedby={`${id}-hint`}
                    value={draft.texts[key]}
                    onChange={(e) => setText(key, e.target.value)}
                  />
                  <small id={`${id}-hint`} className="crm-muted">
                    {field.hint}
                  </small>
                </div>
              );
            })}
          </div>
        </section>

        {(['formatacao', 'expansao'] as const).map((list) => (
          <QuestionList
            key={list}
            list={list}
            rows={draft[list]}
            canManage={canManage}
            onChange={(rows) => setRows(list, rows)}
          />
        ))}
      </fieldset>

      {canManage && (
        <div className="sofia-form-actions">
          {message && (
            <p className="crm-error" role="alert">
              {message}
            </p>
          )}
          {saved && !message && (
            <p className="crm-ok" role="status">
              Salvo.
            </p>
          )}
          <span className="crm-head-spacer" />
          <button type="button" className="crm-btn" onClick={restore}>
            Restaurar padrão
          </button>
          <button type="submit" className="crm-btn is-primary" disabled={save.isPending}>
            {save.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      )}
    </form>
  );
}

function QuestionList({
  list,
  rows,
  canManage,
  onChange,
}: {
  list: ListKey;
  rows: Row[];
  canManage: boolean;
  onChange: (rows: Row[]) => void;
}) {
  const keysBut = (uidOf: string) => rows.filter((r) => r.uid !== uidOf).map((r) => r.question.key);
  const update = (row: Row, patch: Partial<SofiaQuestion>) =>
    onChange(
      rows.map((r) => {
        if (r.uid !== row.uid) return r;
        const question = { ...r.question, ...patch };
        // A question never saved follows its label; a saved key never changes (answers use it).
        if (r.fresh && patch.label !== undefined)
          question.key = keyFromLabel(patch.label, keysBut(r.uid));
        return { ...r, question };
      }),
    );
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const add = () =>
    onChange([
      ...rows,
      {
        uid: uid(),
        fresh: true,
        question: {
          key: keyFromLabel(
            '',
            rows.map((r) => r.question.key),
          ),
          label: '',
          text: '',
          kind: 'text',
          options: [],
          optional: false,
          field: null,
        },
      },
    ]);

  return (
    <section className="crm-panel" aria-label={LIST_LABELS[list]}>
      <h2>{LIST_LABELS[list]}</h2>
      {list === 'expansao' && (
        <p className="crm-sub">
          Vão em nome da marca: sem a palavra Wings no nome, na pergunta e nas opções.
        </p>
      )}
      <ol className="sofia-questions">
        {rows.map((row, index) => (
          <QuestionRow
            key={row.uid}
            row={row}
            index={index}
            last={index === rows.length - 1}
            canManage={canManage}
            onPatch={(patch) => update(row, patch)}
            onMove={(delta) => move(index, delta)}
            onRemove={() => onChange(rows.filter((r) => r.uid !== row.uid))}
          />
        ))}
      </ol>
      {canManage && (
        <div>
          <button type="button" className="crm-btn is-small" onClick={add}>
            Adicionar pergunta
          </button>
        </div>
      )}
    </section>
  );
}

function QuestionRow({
  row,
  index,
  last,
  canManage,
  onPatch,
  onMove,
  onRemove,
}: {
  row: Row;
  index: number;
  last: boolean;
  canManage: boolean;
  onPatch: (patch: Partial<SofiaQuestion>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
}) {
  const q = row.question;
  const n = index + 1;
  return (
    <li className="sofia-q" aria-label={`Pergunta ${n}`}>
      <div className="sofia-q-head">
        <b>{n}.</b>
        <small className="sofia-q-key" title="A chave guarda a resposta e não muda depois de salva">
          chave: {q.key}
          {row.fresh ? ' (segue o nome até salvar)' : ''}
        </small>
        <span className="crm-head-spacer" />
        {canManage && (
          <>
            <button
              type="button"
              className="crm-btn is-quiet is-small"
              aria-label={`Subir a pergunta ${n}`}
              disabled={index === 0}
              onClick={() => onMove(-1)}
            >
              ↑
            </button>
            <button
              type="button"
              className="crm-btn is-quiet is-small"
              aria-label={`Descer a pergunta ${n}`}
              disabled={last}
              onClick={() => onMove(1)}
            >
              ↓
            </button>
            <button
              type="button"
              className="crm-btn is-quiet is-small sofia-remove"
              aria-label={`Remover a pergunta ${n}`}
              onClick={onRemove}
            >
              Remover
            </button>
          </>
        )}
      </div>
      <div className="sofia-q-grid">
        <label className="crm-field">
          <span>Nome na negociação</span>
          <input
            className="crm-input"
            value={q.label}
            maxLength={60}
            placeholder="Faturamento mensal"
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </label>
        <label className="crm-field">
          <span>Tipo</span>
          <select
            className="crm-select"
            value={q.kind}
            onChange={(e) => onPatch({ kind: e.target.value as SofiaQuestionKind })}
          >
            {SOFIA_QUESTION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {SOFIA_QUESTION_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>
        <label className="crm-field">
          <span>Vai também para</span>
          <select
            className="crm-select"
            value={q.field ?? ''}
            onChange={(e) =>
              onPatch({ field: e.target.value ? (e.target.value as SofiaFieldTarget) : null })
            }
          >
            <option value="">Só em Dados do formulário</option>
            {SOFIA_FIELD_TARGETS.map((target) => (
              <option key={target} value={target}>
                {SOFIA_FIELD_TARGET_LABELS[target]}
              </option>
            ))}
          </select>
        </label>
        <label className="crm-field is-wide">
          <span>Pergunta</span>
          <textarea
            className="crm-textarea"
            rows={2}
            maxLength={300}
            value={q.text}
            onChange={(e) => onPatch({ text: e.target.value })}
          />
        </label>
        {q.kind === 'choice' && (
          <div className="crm-field is-wide">
            <label htmlFor={`sofia-${row.uid}-options`}>Opções, uma por linha</label>
            <textarea
              id={`sofia-${row.uid}-options`}
              className="crm-textarea"
              rows={4}
              aria-describedby={`sofia-${row.uid}-options-hint`}
              value={q.options.join('\n')}
              onChange={(e) => onPatch({ options: e.target.value.split('\n') })}
            />
            <small id={`sofia-${row.uid}-options-hint`} className="crm-muted">
              até {SOFIA_OPTIONS_MAX} opções de até {SOFIA_OPTION_MAX} caracteres
            </small>
          </div>
        )}
        <label className="crm-checkbox is-wide">
          <input
            type="checkbox"
            checked={q.optional}
            onChange={(e) => onPatch({ optional: e.target.checked })}
          />
          A pessoa pode pular
        </label>
      </div>
    </li>
  );
}
