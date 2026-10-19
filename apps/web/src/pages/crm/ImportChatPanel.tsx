import { WA_KIND_LABELS, type WaImportLine, type WaImportPreview } from '@wings/shared';
import { useEffect, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import {
  exportTextOf,
  previewWhatsAppImport,
  useImportWhatsAppConversation,
  useUndoWhatsAppImport,
  useWhatsAppImports,
} from '../../api/whatsapp.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { formatDate, formatDateTime } from './format.js';

/**
 * "Importar conversa do celular" (docs/whatsapp/importar-conversa.md): the chat exported on the
 * phone (Mais › Exportar conversa) comes into this deal as history. The person picks the .txt or
 * .zip, sees what it holds and which name is Wings, and imports; the file is kept among the deal's
 * files (its photos and audios stay inside it) and each import can be undone. Nobody receives
 * anything: no message goes out, Sofia does not answer, no task, and the 24-hour window stays.
 * Drawn in a portal and stopping its events, like the call panel.
 */

const errorText = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const stop = (event: SyntheticEvent) => event.stopPropagation();

const PLATFORM = { android: 'Android', ios: 'iPhone' } as const;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Line({ label, line }: { label: string; line: WaImportLine }) {
  return (
    <div style={{ display: 'contents' }}>
      <dt>{label}</dt>
      <dd>
        {formatDateTime(line.at)} · {line.author}:{' '}
        {line.text ? line.text.slice(0, 140) : WA_KIND_LABELS[line.kind]}
      </dd>
    </div>
  );
}

export function ImportChatPanel({ leadId, onClose }: { leadId: string; onClose: () => void }) {
  const run = useImportWhatsAppConversation(leadId);
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [preview, setPreview] = useState<WaImportPreview | null>(null);
  const [ourName, setOurName] = useState('');
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const choose = async (picked: File | undefined) => {
    run.reset();
    setPreview(null);
    setText(null);
    setProblem(null);
    setProgress(0);
    setFile(picked ?? null);
    if (!picked) return;
    setReading(true);
    try {
      const body = await exportTextOf(picked);
      const seen = await previewWhatsAppImport(leadId, body);
      setText(body);
      setPreview(seen);
      setOurName(seen.ourName ?? '');
    } catch (error) {
      setProblem(errorText(error, 'Não deu para ler o arquivo.'));
    } finally {
      setReading(false);
    }
  };

  const done = run.data;
  return createPortal(
    <div
      className="crm-modal-backdrop"
      onClick={stop}
      onKeyDown={stop}
      onMouseDown={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="crm-modal" role="dialog" aria-modal="true" aria-label="Importar conversa">
        <h2>Importar conversa do celular</h2>
        <p className="crm-sub">
          No WhatsApp do celular, abra a conversa e toque em ⋮ › Mais › Exportar conversa (no
          iPhone: nome do contato › Exportar conversa). Escolha aqui o .txt ou o .zip. As mensagens
          entram nesta negociação como histórico: ninguém recebe nada, a Sofia não responde e a
          janela de 24 h não muda.
        </p>
        <label className="crm-field">
          <span>Arquivo exportado</span>
          <input
            type="file"
            accept=".txt,.zip,text/plain,application/zip"
            disabled={reading || run.isPending}
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {reading && <p className="crm-sub">Lendo o arquivo…</p>}
        {problem && (
          <p className="crm-error" role="alert">
            {problem}
          </p>
        )}
        {preview && text && file && !done && (
          <>
            <dl className="crm-kv">
              <div style={{ display: 'contents' }}>
                <dt>Celular</dt>
                <dd>{PLATFORM[preview.platform]}</dd>
              </div>
              <div style={{ display: 'contents' }}>
                <dt>Mensagens</dt>
                <dd>
                  {preview.messages}
                  {preview.newMessages < preview.messages &&
                    ` · ${preview.messages - preview.newMessages} já estão na conversa e não entram de novo`}
                </dd>
              </div>
              {preview.media > 0 && (
                <div style={{ display: 'contents' }}>
                  <dt>Mídia</dt>
                  <dd>
                    {plural(preview.media, 'foto, áudio ou arquivo', 'fotos, áudios ou arquivos')}:
                    ficam dentro do arquivo exportado, em Arquivos
                  </dd>
                </div>
              )}
              {preview.skipped > 0 && (
                <div style={{ display: 'contents' }}>
                  <dt>Avisos do app</dt>
                  <dd>{plural(preview.skipped, 'ignorado', 'ignorados')}</dd>
                </div>
              )}
              <Line label="Primeira" line={preview.first} />
              <Line label="Última" line={preview.last} />
            </dl>
            <fieldset className="crm-field crm-import-sides">
              <legend>Qual nome é a Wings?</legend>
              {preview.participants.map((participant) => (
                <label key={participant.name}>
                  <input
                    type="radio"
                    name="import-our-side"
                    checked={ourName === participant.name}
                    onChange={() => setOurName(participant.name)}
                  />{' '}
                  {participant.name} · {plural(participant.messages, 'mensagem', 'mensagens')}
                </label>
              ))}
            </fieldset>
            {run.isError && (
              <p className="crm-error" role="alert">
                {errorText(run.error, 'A importação não foi concluída.')}
              </p>
            )}
            <div className="crm-form-actions">
              <button
                type="button"
                className="crm-btn is-primary"
                disabled={!ourName || preview.newMessages === 0 || run.isPending}
                onClick={() => run.mutate({ file, text, ourName, onProgress: setProgress })}
              >
                {run.isPending
                  ? progress < 1
                    ? `Guardando o arquivo… ${Math.round(progress * 100)}%`
                    : 'Gravando as mensagens…'
                  : preview.newMessages === 0
                    ? 'Nada novo para importar'
                    : `Importar ${plural(preview.newMessages, 'mensagem', 'mensagens')}`}
              </button>
            </div>
          </>
        )}
        {done && (
          <p className="crm-sub" role="status">
            {plural(done.messages, 'mensagem importada', 'mensagens importadas')}, de{' '}
            {formatDate(done.from)} a {formatDate(done.to)}. O arquivo ficou em Arquivos.
          </p>
        )}
        <ImportList leadId={leadId} />
        <div className="crm-form-actions">
          <button type="button" className="crm-btn" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ImportList({ leadId }: { leadId: string }) {
  const imports = useWhatsAppImports(leadId);
  const undo = useUndoWhatsAppImport(leadId);
  return (
    <section className="crm-import-list" aria-label="Importações desta negociação">
      <h3 className="crm-call-title">Importações desta negociação</h3>
      {imports.isError ? (
        <LoadFailure
          what="as importações"
          error={imports.error}
          onRetry={() => void imports.refetch()}
        />
      ) : !imports.data ? (
        <p className="crm-sub">Carregando…</p>
      ) : imports.data.length === 0 ? (
        <p className="crm-sub">Nenhuma ainda.</p>
      ) : (
        <ul>
          {imports.data.map((item) => (
            <li key={item.id}>
              <span>
                {formatDateTime(item.importedAt)} · {plural(item.messages, 'mensagem', 'mensagens')}{' '}
                de {formatDate(item.from)} a {formatDate(item.to)}
                {item.importedByName ? ` · ${item.importedByName}` : ''}
              </span>
              {item.undoneAt ? (
                <span className="crm-sub">
                  Desfeita em {formatDateTime(item.undoneAt)}
                  {item.undoneByName ? ` por ${item.undoneByName}` : ''}
                </span>
              ) : (
                <button
                  type="button"
                  className="crm-btn is-small"
                  disabled={undo.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Desfazer esta importação? As ${item.messages} mensagens dela saem da conversa. O arquivo continua em Arquivos.`,
                      )
                    )
                      undo.mutate(item.id);
                  }}
                >
                  Desfazer importação
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {undo.isError && (
        <p className="crm-error" role="alert">
          {errorText(undo.error, 'Não deu para desfazer.')}
        </p>
      )}
    </section>
  );
}
