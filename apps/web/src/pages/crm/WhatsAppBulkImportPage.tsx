import type { WaBulkImport, WaBulkItem, WaBulkMatch } from '@wings/shared';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { hasPermission, useSession } from '../../api/auth.js';
import { bulkImports, conversationFilesOf, exportTextOf } from '../../api/whatsapp.js';
import { LoadFailure } from '../../components/LoadFailure.js';
import { failureReason } from '../../lib/failure.js';
import { formatDate } from './format.js';

/**
 * WhatsApp → Importar em lote (docs/whatsapp/importar-conversa.md), Admin Master only: dozens of
 * phone exports at once. Each conversation is read here, paired with a deal by the API, shown in a
 * preview the Admin confirms, corrects or skips, then written one by one as an ordinary import
 * (no notice, no Sofia, no task, no unread). The lote can be undone whole or one conversation.
 */

const MATCH_LABELS: Record<WaBulkMatch, string> = {
  telefone: 'telefone na conversa',
  mapa: 'mapa nome→telefone',
  nome: 'nome do contato',
  manual: 'corrigido',
};

const STATE_LABELS: Record<WaBulkItem['state'], string> = {
  pendente: 'a gravar',
  pulada: 'pulada',
  gravada: 'gravada',
  sem_novas: 'nada novo',
  falhou: 'falhou',
  desfeita: 'desfeita',
};

const ERROR_LABELS: Record<string, string> = {
  not_an_export: 'não é uma conversa exportada',
  sem_par: 'sem negociação',
  unknown_side: 'o nome da Wings não aparece nesta conversa',
  lead_without_phone: 'a negociação não tem telefone',
  nothing_new: 'todas as mensagens já estavam',
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const fileKey = (name: string, size: number) => `${name}|${size}`;

export function WhatsAppBulkImportPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const [bulk, setBulk] = useState<WaBulkImport | null>(null);
  const [files, setFiles] = useState<Map<string, File>>(new Map());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ourName, setOurName] = useState('');
  const lote = params.get('lote');

  if (!hasPermission(session.data, 'whatsapp.import_bulk'))
    return (
      <div className="crm-page">
        <p className="crm-muted">Só o Admin Master importa conversas em lote.</p>
      </div>
    );

  const run = async (label: string, step: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await step();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(null);
    }
  };

  const remember = (picked: File[]) =>
    setFiles((old) => {
      const next = new Map(old);
      for (const file of picked) next.set(fileKey(file.name, file.size), file);
      return next;
    });

  /** Every picked file opened into conversations, each sent to the lote in turn. */
  const read = (picked: File[], map: File | null) =>
    run('Lendo as conversas…', async () => {
      const conversations = (await Promise.all(picked.map(conversationFilesOf))).flat();
      remember(conversations);
      let current = await bulkImports.create(map ? await map.text() : undefined);
      setParams({ lote: current.id }, { replace: true });
      for (const [index, file] of conversations.entries()) {
        setBusy(`Lendo ${index + 1} de ${conversations.length}…`);
        const item = await bulkImports.addItem(current.id, {
          fileName: file.name,
          byteSize: file.size,
          text: await exportTextOf(file),
        });
        current = { ...current, items: [...current.items, item] };
        setBulk(current);
      }
      current = await bulkImports.get(current.id);
      setBulk(current);
      setOurName(current.suggestedOurName ?? '');
    });

  const reopen = () =>
    run('Abrindo o lote…', async () => {
      const found = await bulkImports.get(lote!);
      setBulk(found);
      setOurName(found.ourName ?? found.suggestedOurName ?? '');
    });

  const replace = (item: WaBulkItem) =>
    setBulk((old) =>
      old ? { ...old, items: old.items.map((i) => (i.id === item.id ? item : i)) } : old,
    );

  /** Confirms, then writes each paired conversation: its file to the deal, then its messages. */
  const write = (current: WaBulkImport) =>
    run('Gravando…', async () => {
      let started =
        current.state === 'previa' ? await bulkImports.start(current.id, ourName) : current;
      setBulk(started);
      const pending = started.items.filter((item) => item.state === 'pendente' && item.leadId);
      for (const [index, item] of pending.entries()) {
        const file = files.get(fileKey(item.fileName, item.byteSize));
        if (!file) continue;
        setBusy(`Gravando ${index + 1} de ${pending.length}…`);
        replace(await bulkImports.applyItem(started.id, item, file));
      }
      started = await bulkImports.get(started.id);
      setBulk(started);
    });

  const undo = (current: WaBulkImport, itemId?: string) =>
    run('Desfazendo…', async () => setBulk(await bulkImports.undo(current.id, itemId)));

  if (!bulk)
    return (
      <div className="crm-page">
        <header className="crm-head">
          <h1>Importar em lote</h1>
          <span className="crm-head-spacer" />
          <Link to="/crm-vendas/whatsapp">Voltar ao WhatsApp</Link>
        </header>
        {lote ? (
          <p>
            <button type="button" className="crm-btn" disabled={busy !== null} onClick={reopen}>
              Abrir o lote {lote.slice(0, 8)}
            </button>
          </p>
        ) : (
          <PickForm busy={busy} onRead={read} />
        )}
        {busy && <p role="status">{busy}</p>}
        {error !== null && <LoadFailure what="o lote" error={error} />}
      </div>
    );

  const names = [...new Set(bulk.items.flatMap((item) => item.participants.map((p) => p.name)))];
  const waiting = bulk.items.filter((item) => item.state === 'pendente' && item.leadId);
  const missing = waiting.filter((item) => !files.has(fileKey(item.fileName, item.byteSize)));
  const written = bulk.items.filter((item) => item.state === 'gravada');
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Importar em lote</h1>
        <span className="crm-head-spacer" />
        <a className="crm-btn" href={bulkImports.reportUrl(bulk.id)}>
          Baixar relatório
        </a>
        <Link to="/crm-vendas/whatsapp">Voltar ao WhatsApp</Link>
      </header>
      <p className="crm-sub">
        Lote {bulk.id.slice(0, 8)} · {bulk.items.length} conversas · {waiting.length} a gravar ·{' '}
        {written.length} gravadas. Ninguém recebe aviso, a Sofia não responde e nada vira tarefa.
      </p>
      {bulk.state === 'previa' && (
        <p>
          <label>
            Qual nome é a Wings nas conversas?{' '}
            <select
              className="crm-select"
              value={ourName}
              onChange={(e) => setOurName(e.target.value)}
            >
              <option value="">Escolha</option>
              {names.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
        </p>
      )}
      {missing.length > 0 && bulk.state !== 'previa' && (
        <p className="crm-wa-window">
          {missing.length} conversa(s) esperam o arquivo: escolha de novo os mesmos arquivos para
          continuar.{' '}
          <input
            type="file"
            multiple
            accept=".txt,.zip"
            aria-label="Escolher de novo os arquivos"
            onChange={(e) =>
              void Promise.all([...(e.target.files ?? [])].map(conversationFilesOf)).then((f) =>
                remember(f.flat()),
              )
            }
          />
        </p>
      )}
      <table className="crm-table">
        <thead>
          <tr>
            <th>Arquivo</th>
            <th>Negociação</th>
            <th>Mensagens novas</th>
            <th>Já existentes</th>
            <th>Período</th>
            <th>Situação</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bulk.items.map((item) => (
            <Row
              key={item.id}
              item={item}
              preview={bulk.state === 'previa'}
              busy={busy !== null}
              onPatch={(patch) =>
                run('Salvando…', async () =>
                  replace(await bulkImports.patchItem(bulk.id, item.id, patch)),
                )
              }
              onUndo={() => undo(bulk, item.id)}
            />
          ))}
        </tbody>
      </table>
      <p>
        {(bulk.state === 'previa' || waiting.length > 0) && (
          <button
            type="button"
            className="crm-btn is-primary"
            disabled={busy !== null || !ourName || waiting.length === 0}
            onClick={() => write(bulk)}
          >
            Gravar {waiting.length} conversa(s)
          </button>
        )}{' '}
        {written.length > 0 && (
          <button
            type="button"
            className="crm-btn"
            disabled={busy !== null}
            onClick={() => {
              if (window.confirm(`Desfazer as ${written.length} conversas gravadas deste lote?`))
                undo(bulk);
            }}
          >
            Desfazer o lote
          </button>
        )}
      </p>
      {busy && <p role="status">{busy}</p>}
      {error !== null && (
        <p className="load-failure" role="alert">
          — {failureReason(error)}
        </p>
      )}
    </div>
  );
}

function PickForm({
  busy,
  onRead,
}: {
  busy: string | null;
  onRead: (files: File[], map: File | null) => void;
}) {
  const [picked, setPicked] = useState<File[]>([]);
  const [map, setMap] = useState<File | null>(null);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onRead(picked, map);
      }}
    >
      <p className="crm-sub">
        Escolha as conversas exportadas do celular (.txt ou .zip, várias de uma vez) ou um .zip com
        todas dentro, até 1 GB. Cada conversa é pareada com a negociação pelo telefone que aparece
        nela, pelo mapa nome→telefone ou pelo nome; nada é gravado antes de você confirmar.
      </p>
      <p>
        <label>
          Conversas{' '}
          <input
            type="file"
            multiple
            accept=".txt,.zip"
            onChange={(e) => setPicked([...(e.target.files ?? [])])}
          />
        </label>
      </p>
      <p>
        <label>
          Mapa nome→telefone (opcional, .csv com "nome;telefone" por linha){' '}
          <input
            type="file"
            accept=".csv,.txt"
            onChange={(e) => setMap(e.target.files?.[0] ?? null)}
          />
        </label>
      </p>
      <button
        type="submit"
        className="crm-btn is-primary"
        disabled={busy !== null || picked.length === 0}
      >
        Ler conversas
      </button>
    </form>
  );
}

function Row({
  item,
  preview,
  busy,
  onPatch,
  onUndo,
}: {
  item: WaBulkItem;
  preview: boolean;
  busy: boolean;
  onPatch: (patch: { leadId: string } | { skip: boolean }) => void;
  onUndo: () => void;
}) {
  const [fixing, setFixing] = useState(false);
  const [target, setTarget] = useState('');
  const editable = preview && (item.state === 'pendente' || item.state === 'pulada');
  return (
    <tr>
      <td>{item.fileName}</td>
      <td>
        {item.leadId ? (
          <>
            <Link to={`/crm-vendas/negociacoes/${item.leadId}`}>
              {item.leadName ?? 'negociação'}
            </Link>
            <span className="crm-sub"> · {item.match ? MATCH_LABELS[item.match] : ''}</span>
          </>
        ) : (
          <span>sem par{item.candidates > 1 ? ` (${item.candidates} parecidas)` : ''}</span>
        )}
        {editable && fixing && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const id = UUID.exec(target)?.[0];
              if (id) onPatch({ leadId: id });
              setFixing(false);
            }}
          >
            <input
              className="crm-input"
              aria-label="Link ou id da negociação"
              placeholder="Cole o link ou o id da negociação"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button type="submit" className="crm-btn is-small" disabled={!UUID.test(target)}>
              Usar
            </button>
          </form>
        )}
      </td>
      <td>{item.state === 'falhou' ? '—' : item.newMessages}</td>
      <td>{item.state === 'falhou' ? '—' : item.existingMessages}</td>
      <td>
        {item.first && item.last ? `${formatDate(item.first)} a ${formatDate(item.last)}` : '—'}
      </td>
      <td>
        {STATE_LABELS[item.state]}
        {item.error ? ` · ${ERROR_LABELS[item.error] ?? item.error}` : ''}
      </td>
      <td>
        {editable && (
          <>
            <button
              type="button"
              className="crm-btn is-small"
              disabled={busy}
              onClick={() => setFixing(!fixing)}
            >
              Corrigir
            </button>{' '}
            <button
              type="button"
              className="crm-btn is-small"
              disabled={busy}
              onClick={() => onPatch({ skip: item.state !== 'pulada' })}
            >
              {item.state === 'pulada' ? 'Incluir' : 'Pular'}
            </button>
          </>
        )}
        {item.state === 'gravada' && (
          <button type="button" className="crm-btn is-small" disabled={busy} onClick={onUndo}>
            Desfazer
          </button>
        )}
      </td>
    </tr>
  );
}
