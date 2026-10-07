import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useEmailPreview, useLeadEmails, useSendEmail } from '../../api/lead-email.js';
import { formatDateTime } from './format.js';

const STATUS_LABELS = {
  recorded: 'Registrado (modo de teste, nada foi enviado)',
  sent: 'Enviado',
  failed: 'Não enviado (falhou)',
} as const;

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError ? error.message : fallback;

/**
 * The "E-mail" tab of the deal's page: pick one of the active templates, read
 * it filled in for this lead, send. In test mode the message is only recorded.
 */
export function LeadEmailTab({ leadId }: { leadId: string }) {
  const emails = useLeadEmails(leadId);
  const preview = useEmailPreview(leadId);
  const send = useSendEmail(leadId);
  const [templateId, setTemplateId] = useState('');

  if (emails.isPending) return <p className="crm-muted">Carregando…</p>;
  if (emails.isError || !emails.data)
    return <p className="crm-error">Não foi possível carregar os e-mails.</p>;
  const { to, hidden, mode, from, templates, sent } = emails.data;
  if (hidden)
    return (
      <div className="crm-record-form">
        <p className="crm-sub" data-testid="brand-rule">
          Expansão com marca: o lead não recebe e-mail da Wings (não pode ver a Wings). Fale pelo{' '}
          <a href={`/crm-vendas/negociacoes/${leadId}/whatsapp`}>WhatsApp</a> em nome da marca.
        </p>
      </div>
    );

  const choose = (id: string) => {
    setTemplateId(id);
    send.reset();
    if (id) preview.mutate(id);
    else preview.reset();
  };

  if (!to)
    return (
      <div className="crm-record-form">
        <p className="crm-sub">
          Esta negociação não tem e-mail. Cadastre um no contato para enviar.
        </p>
      </div>
    );

  return (
    <div className="crm-record-form">
      {mode === 'test' ? (
        <p className="crm-sub">
          Modo de teste: a mensagem fica registrada na negociação, mas nenhum e-mail sai de verdade.
        </p>
      ) : from ? (
        <p className="crm-sub">
          Sai de <b>{from}</b>
          {mode === 'gmail'
            ? ' (a sua conta Google; a resposta chega na sua caixa).'
            : ' (remetente da empresa).'}
        </p>
      ) : (
        <p className="crm-error">
          Ninguém pode enviar agora: conecte a sua conta Google em{' '}
          <a href="/minha-conta">Minha conta</a> ou peça ao Eric o remetente da empresa.
        </p>
      )}
      {templates.length === 0 ? (
        <p className="crm-sub">Não há modelos de e-mail ativos. Crie um em Regras de automação.</p>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (templateId) send.mutate(templateId);
          }}
        >
          <select
            className="crm-select"
            value={templateId}
            aria-label="Modelo de e-mail"
            onChange={(e) => choose(e.target.value)}
          >
            <option value="">Escolha um modelo…</option>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templateId && preview.data && (
            <div className="crm-tl-body" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
              <b>Para: {to}</b>
              {'\n'}
              <b>Assunto: {preview.data.subject}</b>
              {'\n\n'}
              {preview.data.body}
            </div>
          )}
          {preview.isError && (
            <p className="crm-error">
              {errorText(preview.error, 'Não foi possível montar a prévia.')}
            </p>
          )}
          <div className="crm-quick-row">
            <button
              type="submit"
              className="crm-btn is-primary"
              disabled={!templateId || !preview.data || send.isPending}
            >
              {mode === 'test' ? 'Registrar e-mail (teste)' : 'Enviar e-mail'}
            </button>
          </div>
          {send.isSuccess && (
            <p className="crm-sub">
              {send.data.mode === 'test' ? 'E-mail registrado (teste).' : 'E-mail enviado.'}
            </p>
          )}
          {send.isError && (
            <p className="crm-error">{errorText(send.error, 'Não foi possível enviar.')}</p>
          )}
        </form>
      )}
      {sent.length > 0 && (
        <ul className="crm-sub" style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {sent.map((m) => (
            <li key={m.id}>
              <details>
                <summary>
                  {m.subject} · {formatDateTime(m.at)}
                  {m.sentByName ? ` · ${m.sentByName}` : ''} · {STATUS_LABELS[m.status]}
                </summary>
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
