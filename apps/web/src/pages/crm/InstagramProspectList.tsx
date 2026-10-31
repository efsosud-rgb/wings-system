import {
  approximateAgoText,
  BUY_SIGNAL_LABELS,
  BUY_SIGNALS,
  DO_NOT_CONTACT_REASON,
  instagramLeadSchema,
  instagramProspectingSettingsSchema,
  LEAD_PIPELINE_LABELS,
  LEAD_PIPELINES,
  pipelineOfCategory,
  PROSPECT_REVIEW_REASON_LABELS,
  PROSPECT_STATE_LABELS,
  type BuySignal,
  type InstagramProspect,
  type InstagramProspectingSettings,
  type InstagramProspectList,
  type LeadPipeline,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ApiError } from '../../api/client.js';
import {
  fetchFirstMessage,
  useCreateInstagramLead,
  useInstagramBatches,
  useInstagramOwners,
  useInstagramProspects,
  useProspectAction,
  useSaveInstagramSettings,
  type InstagramAction,
} from '../../api/prospect-ai.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { failureReason } from '../../lib/failure.js';
import { Modal } from './CreateDealModal.js';
import { formatDate } from './format.js';

/** The three lists of §1.2 step 4, and the manual approach of step 5. */

/** A refusal's own message (the API's, which carries no personal data), else the reason. */
export const actionFailure = (error: unknown) =>
  error instanceof ApiError && error.status < 500 && error.body.message
    ? error.body.message
    : `— ${failureReason(error)}`;

const signalText = (signal: BuySignal | null) => (signal ? BUY_SIGNAL_LABELS[signal] : '—');

const LISTS: [InstagramProspectList, string][] = [
  ['quer_comprar', 'Quer comprar'],
  ['revisar', 'Revisar'],
  ['outros', 'Outros e descartados'],
];

export function InstagramLists({
  canManage,
  canWrite,
  batch,
  setBatch,
}: {
  canManage: boolean;
  canWrite: boolean;
  batch: string | null;
  setBatch: (id: string | null) => void;
}) {
  const prospects = useInstagramProspects(batch, true);
  const batches = useInstagramBatches(true);
  const owners = useInstagramOwners(canManage && canWrite);

  return (
    <div className="crm-stack">
      <label className="crm-field">
        <span>Colagem</span>
        <select
          className="crm-select"
          value={batch ?? ''}
          onChange={(e) => setBatch(e.target.value || null)}
        >
          <option value="">Todas</option>
          {(batches.data?.batches ?? []).map((b) => (
            <option key={b.id} value={b.id}>
              {formatDate(b.createdAt)} · {b.postOwner ? `@${b.postOwner}` : b.postUrl} ·{' '}
              {b.prospects} prospects{canManage && b.createdByName ? ` · ${b.createdByName}` : ''}
            </option>
          ))}
        </select>
      </label>
      {batches.isError && <LoadFailure what="as colagens" error={batches.error} />}
      {prospects.isError ? (
        <LoadFailure
          what="os prospects"
          error={prospects.error}
          onRetry={() => void prospects.refetch()}
        />
      ) : !prospects.data ? (
        <p className="muted">Carregando…</p>
      ) : (
        LISTS.map(([list, title]) => {
          const items = prospects.data.prospects.filter((p) => p.list === list);
          const body = items.length ? (
            items.map((p) => (
              <ProspectCard
                key={p.id}
                prospect={p}
                canManage={canManage}
                canWrite={canWrite}
                owners={owners.data?.owners ?? []}
              />
            ))
          ) : (
            <p className="muted">Nenhum prospect nesta lista.</p>
          );
          if (list !== 'outros')
            return (
              <section key={list} className="crm-stack" aria-label={title}>
                <h3>
                  {title} ({items.length})
                </h3>
                {body}
              </section>
            );
          const bySignal = BUY_SIGNALS.map(
            (s) => [s, items.filter((p) => p.signal === s).length] as const,
          ).filter(([, n]) => n > 0);
          return (
            <details key={list}>
              <summary>
                {title} ({items.length})
                {bySignal.length > 0 &&
                  `: ${bySignal.map(([s, n]) => `${n} ${BUY_SIGNAL_LABELS[s].toLowerCase()}`).join(', ')}`}
              </summary>
              <div className="crm-stack">{body}</div>
            </details>
          );
        })
      )}
    </div>
  );
}

function ProspectCard({
  prospect: p,
  canManage,
  canWrite,
  owners,
}: {
  prospect: InstagramProspect;
  canManage: boolean;
  canWrite: boolean;
  owners: { id: string; name: string }[];
}) {
  const act = useProspectAction();
  const [leadOpen, setLeadOpen] = useState(false);
  const [closing, setClosing] = useState<'discard' | 'do-not-contact' | null>(null);
  const [reason, setReason] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const open = ['nova', 'em_revisao', 'abordada'].includes(p.state);
  const run = (action: InstagramAction, body?: unknown) => act.mutate({ id: p.id, action, body });

  const copy = async () => {
    try {
      const { message, reason: why } = await fetchFirstMessage(p.id);
      if (!message) return setCopied(`— ${why ?? 'sem texto'}`);
      await navigator.clipboard.writeText(message);
      setCopied('Mensagem copiada. Cole no Direct da Wings.');
    } catch (error) {
      setCopied(actionFailure(error));
    }
  };

  return (
    <article className="crm-panel crm-stack">
      <p>
        <strong>@{p.username}</strong> · {PROSPECT_STATE_LABELS[p.state]} · {signalText(p.signal)}
        {p.confidence !== null && ` (${p.confidence}%)`}
        {canManage && p.ownerName && ` · ${p.ownerName}`}
      </p>
      <blockquote>{p.excerpt ?? '—'}</blockquote>
      <p className="crm-sub">
        Comentário {approximateAgoText(new Date(p.occurredAt), new Date())}
        {p.postUrl && (
          <>
            {' '}
            no{' '}
            <a href={p.postUrl} target="_blank" rel="noopener noreferrer">
              post{p.postOwner ? ` de @${p.postOwner}` : ''}
            </a>
          </>
        )}
        {p.moreComments > 0 && ` · mais ${p.moreComments} comentário(s)`}
        {p.justification && ` · por: "${p.justification}"`}
        {p.reviewReason && ` · ${PROSPECT_REVIEW_REASON_LABELS[p.reviewReason]}`}
        {p.decisionReason && ` · ${p.decisionReason}`}
        {p.approachedAt && ` · abordada em ${formatDate(p.approachedAt)}`}
        {p.purgeAt && ` · apagado em ${formatDate(p.purgeAt)} se não virar lead`}
      </p>
      {p.leadId && <Link to={`/crm-vendas/negociacoes/${p.leadId}`}>Abrir negociação</Link>}
      {canWrite && (
        <div className="crm-quick-row">
          <a
            className="crm-btn is-small"
            href={`https://www.instagram.com/${p.username}/`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir no Instagram
          </a>
          {open && (
            <>
              <button type="button" className="crm-btn is-small" onClick={() => void copy()}>
                Copiar mensagem
              </button>
              {p.state !== 'abordada' && (
                <button
                  type="button"
                  className="crm-btn is-small"
                  onClick={() => run('approached')}
                >
                  Abordei
                </button>
              )}
              <button
                type="button"
                className="crm-btn is-small is-primary"
                onClick={() => setLeadOpen(true)}
              >
                Criar lead
              </button>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setClosing('do-not-contact')}
              >
                Não contatar
              </button>
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setClosing('discard')}
              >
                Descartar
              </button>
            </>
          )}
          {(p.state === 'em_revisao' ||
            (p.state === 'rejeitada' && p.decisionReason !== DO_NOT_CONTACT_REASON)) && (
            <button type="button" className="crm-btn is-small" onClick={() => run('promote')}>
              Mover para "Quer comprar"
            </button>
          )}
          {canManage && open && owners.length > 0 && (
            <select
              className="crm-select"
              aria-label="Transferir para"
              value=""
              onChange={(e) =>
                e.target.value && run('transfer', { ownerEmployeeId: e.target.value })
              }
            >
              <option value="">Transferir para…</option>
              {owners
                .filter((o) => o.id !== p.ownerEmployeeId)
                .map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      )}
      {closing && (
        <form
          className="crm-quick-row"
          onSubmit={(e) => {
            e.preventDefault();
            run(closing, { reason });
            setClosing(null);
          }}
        >
          <input
            className="crm-input"
            aria-label={closing === 'discard' ? 'Motivo do descarte' : 'Motivo (opcional)'}
            placeholder={closing === 'discard' ? 'Motivo' : 'Motivo (opcional)'}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button
            type="submit"
            className="crm-btn is-small"
            disabled={closing === 'discard' && reason.trim().length < 3}
          >
            {closing === 'discard' ? 'Confirmar descarte' : 'Confirmar não contatar (não expira)'}
          </button>
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setClosing(null)}
          >
            Cancelar
          </button>
        </form>
      )}
      {copied && <p className="crm-sub">{copied}</p>}
      {act.isError && (
        <p className="crm-error" role="alert">
          {actionFailure(act.error)}
        </p>
      )}
      {leadOpen && <LeadModal prospect={p} onClose={() => setLeadOpen(false)} />}
    </article>
  );
}

function LeadModal({ prospect, onClose }: { prospect: InstagramProspect; onClose: () => void }) {
  const create = useCreateInstagramLead();
  const [form, setForm] = useState({
    contactName: '',
    companyName: '',
    phone: '',
    email: '',
    notes: '',
    pipeline: (pipelineOfCategory(prospect.category) ?? '') as LeadPipeline | '',
  });
  const [optIn, setOptIn] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [leadId, setLeadId] = useState<string | null>(null);
  const field = (name: 'contactName' | 'companyName' | 'phone' | 'email', label: string) => (
    <label className="crm-field">
      <span>{label}</span>
      <input
        className="crm-input"
        value={form[name]}
        onChange={(e) => setForm((c) => ({ ...c, [name]: e.target.value }))}
      />
    </label>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = instagramLeadSchema.safeParse({
      ...form,
      pipeline: form.pipeline || undefined,
      whatsappOptIn: optIn ?? undefined,
    });
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? 'Confira.');
    setProblem(null);
    create.mutate(
      { id: prospect.id, ...parsed.data },
      { onSuccess: (answer) => setLeadId(answer.leadId) },
    );
  };
  return (
    <Modal title={`Criar lead de @${prospect.username}`} onClose={onClose}>
      {leadId ? (
        <div className="crm-stack">
          <p>Lead criado.</p>
          <Link to={`/crm-vendas/negociacoes/${leadId}`}>Abrir negociação</Link>
        </div>
      ) : (
        <form className="crm-stack" onSubmit={submit}>
          <p className="crm-sub">
            Só o que a pessoa passou na conversa pelo Direct. Nada do comentário vira telefone ou
            e-mail.
          </p>
          <div className="crm-form-grid">
            {field('contactName', 'Nome')}
            {field('companyName', 'Empresa (se disse)')}
            {field('phone', 'Telefone')}
            {field('email', 'E-mail')}
            <label className="crm-field">
              <span>Funil</span>
              <select
                className="crm-select"
                value={form.pipeline}
                onChange={(e) =>
                  setForm((c) => ({ ...c, pipeline: e.target.value as LeadPipeline | '' }))
                }
              >
                <option value="">Escolha</option>
                {LEAD_PIPELINES.map((pipe) => (
                  <option key={pipe} value={pipe}>
                    {LEAD_PIPELINE_LABELS[pipe]}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="crm-field">
              <legend>A pessoa pediu contato por WhatsApp?</legend>
              {[true, false].map((value) => (
                <label key={String(value)} className="crm-checkbox">
                  <input
                    type="radio"
                    name="ig-opt-in"
                    checked={optIn === value}
                    onChange={() => setOptIn(value)}
                  />{' '}
                  {value ? 'Sim' : 'Não'}
                </label>
              ))}
            </fieldset>
            <label className="crm-field is-wide">
              <span>Observações</span>
              <textarea
                className="crm-input"
                rows={3}
                value={form.notes}
                onChange={(e) => setForm((c) => ({ ...c, notes: e.target.value }))}
              />
            </label>
          </div>
          {(problem || create.isError) && (
            <p className="crm-error" role="alert">
              {problem ?? actionFailure(create.error)}
            </p>
          )}
          <div className="crm-form-actions">
            <button type="button" className="crm-btn is-quiet" onClick={onClose}>
              Cancelar
            </button>
            <button type="submit" className="crm-btn is-primary" disabled={create.isPending}>
              {create.isPending ? 'Criando…' : 'Criar lead'}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Ajustes → Instagram (§2.5): limits, thresholds, retention, the first message and its link. */
export function InstagramSettings({ settings }: { settings: InstagramProspectingSettings }) {
  const save = useSaveInstagramSettings();
  const [form, setForm] = useState(settings);
  const [problem, setProblem] = useState<string | null>(null);
  const num = (label: string, value: number, set: (n: number) => void) => (
    <label className="crm-field">
      <span>{label}</span>
      <input
        className="crm-input"
        type="number"
        value={value}
        onChange={(e) => set(Number(e.target.value))}
      />
    </label>
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = instagramProspectingSettingsSchema.safeParse(form);
    if (!parsed.success) return setProblem(parsed.error.issues[0]?.message ?? 'Confira.');
    setProblem(null);
    save.mutate(parsed.data);
  };
  const paste = (k: keyof InstagramProspectingSettings['paste']) => (n: number) =>
    setForm((c) => ({ ...c, paste: { ...c.paste, [k]: n } }));
  return (
    <form className="crm-panel crm-stack" onSubmit={submit} aria-label="Ajustes do Instagram">
      <p className="crm-sub">Números propostos, para calibrar no piloto. Toda troca é auditada.</p>
      <div className="crm-form-grid">
        {num('Caracteres por colagem', form.paste.maxChars, paste('maxChars'))}
        {num('Comentários por colagem', form.paste.maxComments, paste('maxComments'))}
        {num(
          'Colagens por vendedora por dia',
          form.paste.perSellerPerDay,
          paste('perSellerPerDay'),
        )}
        {num('Confiança para "Quer comprar"', form.thresholds.listar, (n) =>
          setForm((c) => ({ ...c, thresholds: { ...c.thresholds, listar: n } })),
        )}
        {num('Confiança mínima para "Revisar"', form.thresholds.revisar, (n) =>
          setForm((c) => ({ ...c, thresholds: { ...c.thresholds, revisar: n } })),
        )}
        {num('Dias até apagar quem não virou lead', form.retention.instagramSemLeadDias, (n) =>
          setForm((c) => ({ ...c, retention: { instagramSemLeadDias: n } })),
        )}
        <label className="crm-field is-wide">
          <span>Link da política de privacidade (sem ele, "Copiar mensagem" não funciona)</span>
          <input
            className="crm-input"
            value={form.messages.linkPolitica ?? ''}
            onChange={(e) =>
              setForm((c) => ({
                ...c,
                messages: { ...c.messages, linkPolitica: e.target.value.trim() || null },
              }))
            }
          />
        </label>
        <label className="crm-field is-wide">
          <span>Primeira mensagem pelo Direct</span>
          <textarea
            className="crm-input"
            rows={5}
            value={form.messages.primeiraAbordagemDirect}
            onChange={(e) =>
              setForm((c) => ({
                ...c,
                messages: { ...c.messages, primeiraAbordagemDirect: e.target.value },
              }))
            }
          />
        </label>
      </div>
      {(problem || save.isError) && (
        <p className="crm-error" role="alert">
          {problem ?? actionFailure(save.error)}
        </p>
      )}
      {save.isSuccess && <p className="crm-sub">Salvo.</p>}
      <div className="crm-form-actions">
        <button type="submit" className="crm-btn is-primary" disabled={save.isPending}>
          {save.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </form>
  );
}
