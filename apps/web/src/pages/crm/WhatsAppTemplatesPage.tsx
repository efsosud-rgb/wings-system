import {
  templateParamCount,
  waFieldFallback,
  WA_COMPANY_FALLBACK,
  WA_FIELD_LABELS,
  WA_FIELD_ROLES,
  WA_TEMPLATE_CATEGORIES,
  WA_TEMPLATE_CATEGORY_LABELS,
  WA_TEMPLATE_STATUS_LABELS,
  type WaFieldRole,
  type WaFieldSpec,
  type WaManagedTemplate,
  type WaNameForm,
  type WaTemplateCategory,
} from '@wings/shared';
import { Fragment, useState, type FormEvent } from 'react';
import { ApiError } from '../../api/client.js';
import {
  useCreateTemplate,
  useEditTemplate,
  useManagedTemplates,
  useSaveTemplateFields,
} from '../../api/whatsapp.js';
import { LoadFailure } from '../../components/LoadFailure.js';

/**
 * CRM Vendas → WhatsApp → Modelos (docs/whatsapp/modelos.md): every template with Meta's status, a
 * new one sent to Meta's review, the words of one edited (back to review), and what fills each
 * {{n}} with the text that goes when the CRM has nothing. Admin Master and Diretoria.
 */

/** Meta lets these be edited; the others wait for its answer. */
const EDITABLE = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

const reasonOf = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Não foi possível falar com o sistema agora.';

const categoryLabel = (category: string | null) =>
  category ? ((WA_TEMPLATE_CATEGORY_LABELS as Record<string, string>)[category] ?? category) : '—';

const fieldName = (field: WaFieldSpec) =>
  field.role === 'free' ? field.label || WA_FIELD_LABELS.free : WA_FIELD_LABELS[field.role];

interface FieldDraft {
  role: WaFieldRole;
  label: string;
  fallback: string;
  example: string;
  form?: WaNameForm;
}

const NEW_ROW: FieldDraft = { role: 'free', label: '', fallback: '', example: '' };

const draftOf = (field: WaFieldSpec): FieldDraft => ({
  role: field.role,
  label: field.label ?? '',
  fallback: waFieldFallback(field),
  example: '',
  ...(field.form ? { form: field.form } : {}),
});

const specOf = ({ role, label, fallback, form }: FieldDraft): WaFieldSpec => ({
  role,
  ...(form ? { form } : {}),
  ...(role === 'free' && label.trim() ? { label: label.trim() } : {}),
  // An empty one would replace the role's own ("sua empresa").
  ...(fallback.trim() ? { fallback: fallback.trim() } : {}),
});

type Open = { kind: 'new' } | { kind: 'text' | 'fields'; id: string };

export function WhatsAppTemplatesPage() {
  const view = useManagedTemplates();
  const [open, setOpen] = useState<Open | null>(null);
  const close = () => setOpen(null);
  const templates = view.data?.templates ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Modelos de mensagem</h1>
        <span className="crm-sub">
          A Meta aprova cada modelo antes do uso. O texto aprovado é o que vai: só os campos{' '}
          {'{{n}}'} mudam.
        </span>
        <span className="crm-head-spacer" />
        <button
          type="button"
          className="crm-btn is-primary"
          onClick={() => setOpen({ kind: 'new' })}
        >
          Novo modelo
        </button>
      </header>
      <div className="crm-page-scroll crm-stack">
        {open?.kind === 'new' && <TemplateForm onDone={close} />}
        {view.isLoading && <p className="crm-sub">Carregando…</p>}
        {view.isError && (
          <LoadFailure what="os modelos" error={view.error} onRetry={() => void view.refetch()} />
        )}
        {view.data?.syncError && (
          <p className="crm-error" role="status">
            {view.data.syncError}
            {view.data.configured && ' A lista abaixo é a da última leitura.'}
          </p>
        )}
        {view.isSuccess && templates.length === 0 && (
          <p className="crm-sub">Nenhum modelo ainda.</p>
        )}
        {templates.map((template) => (
          <Fragment key={template.id}>
            <TemplateCard
              template={template}
              onOpen={(kind) => setOpen({ kind, id: template.id })}
            />
            {open?.kind === 'text' && open.id === template.id && (
              <TemplateForm template={template} onDone={close} />
            )}
            {open?.kind === 'fields' && open.id === template.id && (
              <FieldsForm template={template} onDone={close} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function MessageCard({
  text,
  footer,
  buttons,
  label,
}: {
  text: string;
  footer: string | null;
  buttons: string[];
  label: string;
}) {
  return (
    <div className="crm-wa-card" aria-label={label}>
      <p className="crm-wa-preview">{text || '—'}</p>
      {footer && <span className="crm-wa-card-footer">{footer}</span>}
      {buttons.length > 0 && (
        <div className="crm-wa-card-buttons">
          {buttons.map((title) => (
            <span key={title}>{title}</span>
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({
  template,
  onOpen,
}: {
  template: WaManagedTemplate;
  onOpen: (kind: 'text' | 'fields') => void;
}) {
  const about = [
    template.language,
    categoryLabel(template.category),
    template.header === 'IMAGE' && 'com arte',
    template.callPermission && 'pede permissão para ligar',
  ].filter(Boolean);
  return (
    <article className="crm-panel" aria-label={`Modelo ${template.name}`}>
      <h2>
        <span>{template.name}</span>
        <span className="crm-badge">
          {WA_TEMPLATE_STATUS_LABELS[template.status] ?? template.status}
        </span>
      </h2>
      <p className="crm-sub">{about.join(' · ')}</p>
      {template.status === 'REJECTED' && (
        <p className="crm-error">
          Motivo da Meta: {template.rejectedReason ?? '— a Meta não disse o motivo.'}
        </p>
      )}
      <MessageCard
        text={template.body ?? ''}
        footer={template.footer}
        buttons={template.buttons}
        label="Texto do modelo"
      />
      {template.fields.length > 0 && (
        <ul className="crm-sub">
          {template.fields.map((field, index) => (
            <li key={index}>
              {`{{${index + 1}}}`}: {fieldName(field)} · se faltar: {waFieldFallback(field) || '—'}
            </li>
          ))}
        </ul>
      )}
      <div className="crm-form-actions">
        {EDITABLE.has(template.status) ? (
          <button type="button" className="crm-btn is-small" onClick={() => onOpen('text')}>
            Editar texto
          </button>
        ) : (
          <span className="crm-sub">Em análise na Meta: espere a resposta para editar.</span>
        )}
        <button type="button" className="crm-btn is-small" onClick={() => onOpen('fields')}>
          Variáveis
        </button>
      </div>
    </article>
  );
}

function FieldRow({
  index,
  row,
  onChange,
  withExample,
}: {
  index: number;
  row: FieldDraft;
  onChange: (patch: Partial<FieldDraft>) => void;
  withExample: boolean;
}) {
  const setRole = (role: WaFieldRole) =>
    onChange(
      role === 'company' && !row.fallback ? { role, fallback: WA_COMPANY_FALLBACK } : { role },
    );
  return (
    <fieldset className="crm-wa-fields">
      <legend>{`Campo {{${index + 1}}}`}</legend>
      {withExample && (
        <label>
          Exemplo (a Meta analisa com ele)
          <input
            className="crm-input"
            required
            maxLength={200}
            value={row.example}
            onChange={(event) => onChange({ example: event.target.value })}
          />
        </label>
      )}
      <label>
        O que preenche
        <select
          className="crm-select"
          value={row.role}
          onChange={(event) => setRole(event.target.value as WaFieldRole)}
        >
          {WA_FIELD_ROLES.map((role) => (
            <option key={role} value={role}>
              {WA_FIELD_LABELS[role]}
            </option>
          ))}
        </select>
      </label>
      {row.role === 'free' && (
        <label>
          Nome do campo
          <input
            className="crm-input"
            maxLength={60}
            placeholder="Ex.: Dia, Link da reunião"
            value={row.label}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </label>
      )}
      <label>
        Texto se faltar
        <input
          className="crm-input"
          maxLength={60}
          value={row.fallback}
          onChange={(event) => onChange({ fallback: event.target.value })}
        />
      </label>
    </fieldset>
  );
}

/** "Novo modelo", or "Editar texto" of one (its words go back to Meta's review). */
function TemplateForm({ template, onDone }: { template?: WaManagedTemplate; onDone: () => void }) {
  const create = useCreateTemplate();
  const edit = useEditTemplate();
  const write = template ? edit : create;
  const [name, setName] = useState('');
  const [category, setCategory] = useState<WaTemplateCategory>('UTILITY');
  const [body, setBody] = useState(template?.body ?? '');
  const [rows, setRows] = useState(() => (template?.fields ?? []).map(draftOf));
  const [footer, setFooter] = useState(template?.footer ?? '');
  const [buttons, setButtons] = useState(() => [0, 1, 2].map((i) => template?.buttons[i] ?? ''));
  const [callPermission, setCallPermission] = useState(template?.callPermission ?? false);

  const shown = Array.from({ length: templateParamCount(body) }, (_, i) => rows[i] ?? NEW_ROW);
  const setRow = (index: number, patch: Partial<FieldDraft>) =>
    setRows(shown.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const preview = body.replace(
    /\{\{\s*(\d+)\s*\}\}/g,
    (match: string, n: string) => shown[Number(n) - 1]?.example || match,
  );
  const quickReplies = buttons.map((title) => title.trim()).filter(Boolean);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const words = {
      body,
      examples: shown.map((row) => row.example),
      fields: shown.map(specOf),
      footer,
      buttons: quickReplies,
      callPermission,
    };
    if (template) edit.mutate({ id: template.id, ...words }, { onSuccess: onDone });
    else create.mutate({ name, language: 'pt_BR', category, ...words }, { onSuccess: onDone });
  };

  return (
    <form
      className="crm-panel"
      onSubmit={submit}
      aria-label={template ? `Editar texto de ${template.name}` : 'Novo modelo'}
    >
      <h2>{template ? `Editar texto: ${template.name}` : 'Novo modelo'}</h2>
      {template ? (
        <>
          <p className="crm-sub">
            {template.language} · {categoryLabel(template.category)}. Nome, idioma e categoria não
            mudam.
          </p>
          <p className="crm-wa-notice">
            Regra da Meta: o texto aprovado é o que vai; editar manda o modelo de volta para a
            análise da Meta (pode levar até 24 h) e a Meta deixa editar no máximo 1 vez por dia e 10
            vezes em 30 dias. A arte do cabeçalho continua a mesma.
          </p>
        </>
      ) : (
        <div className="crm-form-grid">
          <label className="crm-field">
            <span>Nome (só letras minúsculas, números e _)</span>
            <input
              className="crm-input"
              required
              placeholder="ex.: boas_vindas_2"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="crm-field">
            <span>Categoria</span>
            <select
              className="crm-select"
              value={category}
              onChange={(event) => setCategory(event.target.value as WaTemplateCategory)}
            >
              {WA_TEMPLATE_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {WA_TEMPLATE_CATEGORY_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <label className="crm-field">
        <span>
          Texto da mensagem (onde entra um dado: {'{{1}}'}, {'{{2}}'}… em ordem, sem pular)
        </span>
        <textarea
          className="crm-textarea"
          required
          rows={5}
          maxLength={1024}
          value={body}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {shown.map((row, index) => (
        <FieldRow
          key={index}
          index={index}
          row={row}
          withExample
          onChange={(patch) => setRow(index, patch)}
        />
      ))}
      <label className="crm-field">
        <span>Rodapé (opcional)</span>
        <input
          className="crm-input"
          maxLength={60}
          value={footer}
          onChange={(event) => setFooter(event.target.value)}
        />
      </label>
      <div className="crm-form-grid">
        {buttons.map((title, index) => (
          <label key={index} className="crm-field">
            <span>Botão de resposta {index + 1} (opcional)</span>
            <input
              className="crm-input"
              maxLength={25}
              value={title}
              onChange={(event) =>
                setButtons(buttons.map((old, i) => (i === index ? event.target.value : old)))
              }
            />
          </label>
        ))}
      </div>
      <label className="crm-checkbox">
        <input
          type="checkbox"
          checked={callPermission}
          onChange={(event) => setCallPermission(event.target.checked)}
        />
        Pedir permissão para ligar (botão Permitir ligações da Meta)
      </label>
      <MessageCard
        text={preview}
        footer={footer.trim() || null}
        buttons={quickReplies}
        label="Prévia da mensagem"
      />
      <div className="crm-form-actions">
        <button type="button" className="crm-btn" onClick={onDone}>
          Cancelar
        </button>
        <button type="submit" className="crm-btn is-primary" disabled={write.isPending}>
          Mandar para a análise da Meta
        </button>
      </div>
      {write.isError && (
        <p className="crm-error" role="alert">
          {reasonOf(write.error)}
        </p>
      )}
    </form>
  );
}

/** Only what fills each {{n}}: stays in the system, Meta sees nothing. */
function FieldsForm({ template, onDone }: { template: WaManagedTemplate; onDone: () => void }) {
  const save = useSaveTemplateFields();
  const [rows, setRows] = useState(() => template.fields.map(draftOf));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate({ id: template.id, fields: rows.map(specOf) }, { onSuccess: onDone });
  };
  return (
    <form className="crm-panel" onSubmit={submit} aria-label={`Variáveis de ${template.name}`}>
      <h2>{`Variáveis: ${template.name}`}</h2>
      <p className="crm-sub">Fica só no sistema: não volta para a Meta.</p>
      {rows.length === 0 && <p className="crm-sub">Este texto não tem campos {'{{n}}'}.</p>}
      {rows.map((row, index) => (
        <FieldRow
          key={index}
          index={index}
          row={row}
          withExample={false}
          onChange={(patch) =>
            setRows(rows.map((old, i) => (i === index ? { ...old, ...patch } : old)))
          }
        />
      ))}
      <div className="crm-form-actions">
        <button type="button" className="crm-btn" onClick={onDone}>
          Cancelar
        </button>
        {rows.length > 0 && (
          <button type="submit" className="crm-btn is-primary" disabled={save.isPending}>
            Salvar variáveis
          </button>
        )}
      </div>
      {save.isError && (
        <p className="crm-error" role="alert">
          {reasonOf(save.error)}
        </p>
      )}
    </form>
  );
}
