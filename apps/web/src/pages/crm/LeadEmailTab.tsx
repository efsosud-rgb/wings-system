import {
  EMAIL_ATTACHMENTS_MAX_BYTES,
  emailAttachmentRefusal,
  type LeadEmailAttachment,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useLeadFiles, useSendLeadFile } from '../../api/crm.js';
import { useEmailPreview, useLeadEmails, useSendEmail } from '../../api/lead-email.js';
import { formatBytes } from '../../components/drive/DriveParts.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDateTime } from './format.js';

const STATUS_LABELS = {
  recorded: 'Registrado (modo de teste, nada foi enviado)',
  sent: 'Enviado',
  failed: 'Não enviado (falhou)',
} as const;

const errorText = (error: unknown, fallback: string) =>
  error instanceof ApiError || error instanceof Error ? error.message : fallback;

const attachmentsText = (files: { name: string; byteSize: number }[]) =>
  files.map((f) => `${f.name} (${formatBytes(f.byteSize)})`).join(', ');

/**
 * The "E-mail" tab of the deal's page: "Escrever e-mail" opens at once (the
 * action bar's "E-mail" lands here). To the deal's e-mail or another of its
 * contacts, a subject, a text (or a template filled in, then edited) and the
 * deal's files as attachments; a file from the computer goes to the deal's
 * files first. In test mode the message is only recorded.
 */
export function LeadEmailTab({ leadId }: { leadId: string }) {
  const emails = useLeadEmails(leadId);
  const preview = useEmailPreview(leadId);
  const send = useSendEmail(leadId);
  const files = useLeadFiles(leadId);
  const upload = useSendLeadFile(leadId);
  const [templateId, setTemplateId] = useState('');
  const [to, setTo] = useState('');
  const [subject, setSubject] = useState('');
  const [text, setText] = useState('');
  const [attached, setAttached] = useState<LeadEmailAttachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const pick = useRef<HTMLInputElement>(null);
  const ready = Boolean(emails.data && !emails.data.hidden && emails.data.addresses.length > 0);

  // The writing opens at once: the cursor waits in the subject.
  useEffect(() => {
    if (ready) subjectRef.current?.focus({ preventScroll: true });
  }, [ready]);

  if (emails.isPending) return <p className="crm-muted">Carregando…</p>;
  if (!emails.data)
    return emails.isError ? (
      <LoadFailure what="os e-mails" error={emails.error} onRetry={() => void emails.refetch()} />
    ) : (
      <p className="crm-muted">Carregando…</p>
    );
  const { addresses, hidden, blocked, mode, from, templates, sent } = emails.data;
  // A refresh failed: what was loaded stays on screen, with the reason above it.
  const stale = emails.isError ? (
    <LoadFailure what="os e-mails" error={emails.error} onRetry={() => void emails.refetch()} />
  ) : null;
  if (hidden)
    return (
      <div className="crm-record-form">
        {stale}
        <p className="crm-sub" data-testid="brand-rule">
          Expansão com marca: o lead não recebe e-mail da Wings (não pode ver a Wings). Fale pelo{' '}
          <a href={`/crm-vendas/negociacoes/${leadId}/whatsapp`}>WhatsApp</a> em nome da marca.
        </p>
      </div>
    );

  if (addresses.length === 0)
    return (
      <div className="crm-record-form">
        {stale}
        <p className="crm-sub">
          Esta negociação não tem e-mail. Cadastre um no contato para enviar.
        </p>
      </div>
    );

  const recipient = to || addresses[0]!.email;
  const total = attached.reduce((sum, f) => sum + f.byteSize, 0);

  const startFrom = (id: string) => {
    setTemplateId(id);
    send.reset();
    if (!id) return preview.reset();
    preview.mutate(id, {
      onSuccess: (filled) => {
        setSubject(filled.subject);
        setText(filled.body);
      },
    });
  };

  /** Adds one of the deal's files, or says why it cannot go. */
  const attach = (file: LeadEmailAttachment & { mimeType?: string | null }) => {
    send.reset();
    const refusal = emailAttachmentRefusal(file.name, file.mimeType ?? null);
    if (refusal) return setAttachError(`${file.name}: ${refusal}`);
    if (attached.some((f) => f.fileId === file.fileId)) return setAttachError(null);
    if (total + file.byteSize > EMAIL_ATTACHMENTS_MAX_BYTES)
      return setAttachError(
        `${file.name} não cabe: os anexos de um e-mail somam até ${formatBytes(EMAIL_ATTACHMENTS_MAX_BYTES)}.`,
      );
    setAttachError(null);
    setAttached((list) => [
      ...list,
      { fileId: file.fileId, name: file.name, byteSize: file.byteSize },
    ]);
  };

  const fromComputer = async (list: FileList | null) => {
    let sum = total;
    for (const file of list ? Array.from(list) : []) {
      // Checked here first, so a file that cannot go is not stored in the deal for nothing.
      const refusal = emailAttachmentRefusal(file.name, file.type || null);
      if (refusal) return setAttachError(`${file.name}: ${refusal}`);
      if (sum + file.size > EMAIL_ATTACHMENTS_MAX_BYTES)
        return setAttachError(
          `${file.name} não cabe: os anexos de um e-mail somam até ${formatBytes(EMAIL_ATTACHMENTS_MAX_BYTES)}.`,
        );
      setUploading(file.name);
      try {
        const stored = await upload.mutateAsync({ file, onProgress: () => undefined });
        sum += stored.byteSize;
        attach({ ...stored, mimeType: stored.mimeType });
      } catch (err) {
        setAttachError(errorText(err, 'Não foi possível anexar o arquivo.'));
        break;
      } finally {
        setUploading(null);
      }
    }
  };

  const others = (files.data ?? []).filter((f) => !attached.some((a) => a.fileId === f.fileId));

  return (
    <div className="crm-record-form">
      {stale}
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
      <form
        aria-label="Escrever e-mail"
        onSubmit={(e) => {
          e.preventDefault();
          send.mutate(
            {
              to: recipient,
              subject,
              text,
              templateId: templateId || null,
              fileIds: attached.map((f) => f.fileId),
            },
            {
              onSuccess: () => {
                setSubject('');
                setText('');
                setTemplateId('');
                setAttached([]);
                preview.reset();
              },
            },
          );
        }}
      >
        <h3 className="crm-sub" style={{ margin: '0 0 8px' }}>
          Escrever e-mail
        </h3>
        <label className="crm-field">
          <span>Para</span>
          <select className="crm-select" value={recipient} onChange={(e) => setTo(e.target.value)}>
            {addresses.map((a) => (
              <option key={a.email} value={a.email}>
                {a.name ? `${a.name} <${a.email}>` : a.email}
                {a.primary ? ' (contato principal)' : ''}
              </option>
            ))}
          </select>
        </label>
        {templates.length > 0 && (
          <label className="crm-field">
            <span>Começar de um modelo</span>
            <select
              className="crm-select"
              value={templateId}
              onChange={(e) => startFrom(e.target.value)}
            >
              <option value="">Sem modelo</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {preview.isError && (
          <p className="crm-error">
            {errorText(preview.error, 'Não foi possível preencher o modelo.')}
          </p>
        )}
        <label className="crm-field">
          <span>Assunto</span>
          <input
            ref={subjectRef}
            className="crm-input"
            value={subject}
            maxLength={200}
            onChange={(e) => setSubject(e.target.value)}
          />
        </label>
        <label className="crm-field">
          <span>Texto</span>
          <textarea
            className="crm-input"
            rows={8}
            value={text}
            maxLength={20_000}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <fieldset className="crm-field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend>Anexos</legend>
          {attached.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '4px 0' }} aria-label="Anexos">
              {attached.map((f) => (
                <li key={f.fileId}>
                  {f.name} · {formatBytes(f.byteSize)}{' '}
                  <button
                    type="button"
                    className="crm-btn is-small"
                    aria-label={`Tirar ${f.name}`}
                    onClick={() => setAttached((list) => list.filter((a) => a.fileId !== f.fileId))}
                  >
                    Tirar
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="crm-muted" style={{ margin: '4px 0' }}>
            {formatBytes(total)} de {formatBytes(EMAIL_ATTACHMENTS_MAX_BYTES)}. Programas e scripts
            não vão como anexo.
          </p>
          <div className="crm-quick-row">
            <input
              ref={pick}
              type="file"
              multiple
              hidden
              aria-label="Anexar do computador"
              onChange={(e) => {
                void fromComputer(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              className="crm-btn is-small"
              disabled={uploading !== null}
              onClick={() => pick.current?.click()}
            >
              Do computador
            </button>
            <select
              className="crm-select"
              aria-label="Anexar dos Arquivos da negociação"
              value=""
              disabled={others.length === 0}
              onChange={(e) => {
                const file = others.find((f) => f.fileId === e.target.value);
                if (file) attach(file);
              }}
            >
              <option value="">
                {files.isError
                  ? 'Arquivos da negociação: — (não carregaram)'
                  : others.length === 0
                    ? 'Arquivos da negociação: nenhum a anexar'
                    : 'Dos Arquivos da negociação…'}
              </option>
              {others.map((f) => (
                <option key={f.fileId} value={f.fileId}>
                  {f.name} ({formatBytes(f.byteSize)})
                </option>
              ))}
            </select>
          </div>
          {uploading && (
            <p className="crm-muted" role="status">
              Anexando {uploading}… (fica também nos Arquivos da negociação)
            </p>
          )}
          {attachError && <p className="crm-error">{attachError}</p>}
        </fieldset>
        <div className="crm-quick-row">
          <button
            type="submit"
            className="crm-btn is-primary"
            disabled={
              !subject.trim() ||
              !text.trim() ||
              send.isPending ||
              uploading !== null ||
              blocked !== null
            }
            aria-describedby={blocked ? 'lead-email-blocked' : undefined}
          >
            {mode === 'test' ? 'Registrar e-mail (teste)' : 'Enviar e-mail'}
          </button>
        </div>
        {blocked && (
          <p className="crm-error" id="lead-email-blocked">
            Não me contate: {blocked}
          </p>
        )}
        {send.isSuccess && (
          <p className="crm-sub" role="status">
            {send.data.mode === 'test' ? 'E-mail registrado (teste).' : 'E-mail enviado.'}
          </p>
        )}
        {send.isError && (
          <p className="crm-error">{errorText(send.error, 'Não foi possível enviar.')}</p>
        )}
      </form>
      {sent.length > 0 && (
        <ul className="crm-sub" style={{ listStyle: 'none', padding: 0, marginTop: 12 }}>
          {sent.map((m) => (
            <li key={m.id}>
              <details>
                <summary>
                  {m.subject} · {formatDateTime(m.at)}
                  {m.sentByName ? ` · ${m.sentByName}` : ''} · {STATUS_LABELS[m.status]}
                  {m.attachments.length > 0 ? ` · ${m.attachments.length} anexo(s)` : ''}
                </summary>
                {m.toEmail && <div>Para: {m.toEmail}</div>}
                {m.attachments.length > 0 && <div>Anexos: {attachmentsText(m.attachments)}</div>}
                <div style={{ whiteSpace: 'pre-wrap' }}>{m.body}</div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
