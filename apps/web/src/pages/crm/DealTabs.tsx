import {
  LEAD_CALL_OUTCOME_LABELS,
  LEAD_TASK_KIND_LABELS,
  type Lead,
  type LeadActivity,
  type LeadEvent,
  type LeadFile,
  type LeadNote,
  type LeadTask,
} from '@wings/shared';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { ApiError } from '../../api/client.js';
import { useLeadFiles, useRemoveLeadFile, useSendLeadFile } from '../../api/crm.js';
import { driveLink } from '../../api/drive.js';
import { useUpdateTask, type LoadedLead } from '../../api/leads.js';
import { formatBytes } from '../../components/drive/DriveParts.js';
import { Icon, type IconName } from '../../components/Icon.js';
import { MeetingsTab } from './DealMeetings.js';
import { dueLabel, formatDateTime, isPast } from './format.js';
import { LeadEmailTab } from './LeadEmailTab.js';

/**
 * The centre of the deal's page (ficha do cliente, Etapa 3): one strip of
 * tabs — Histórico (the timeline, filtered by kind), E-mail, Tarefas,
 * Questionários (the form answers) and Arquivos (files in the system's
 * Drive); Propostas waits, "em breve".
 */

export type View = 'history' | 'email' | 'tasks' | 'meetings' | 'answers' | 'files' | 'proposals';

const VIEWS: { key: View; label: string; soon?: string }[] = [
  { key: 'history', label: 'Histórico' },
  { key: 'email', label: 'E-mail' },
  { key: 'tasks', label: 'Tarefas' },
  { key: 'meetings', label: 'Reunião' },
  { key: 'answers', label: 'Questionários' },
  { key: 'files', label: 'Arquivos' },
  { key: 'proposals', label: 'Propostas', soon: 'Em breve: propostas feitas e enviadas daqui' },
];

export const EVENT_LABELS: Record<string, string> = {
  'lead.received.rd_station': 'Chegou pela landing page',
  'lead.received.whatsapp': 'Chegou pelo WhatsApp',
  'lead.received.meta_lead_ads': 'Chegou pelo Meta Lead Ads',
  'lead.received.tiktok_lead_ads': 'Chegou pelo TikTok Lead Ads',
  'lead.received.google_lead_form': 'Chegou pelo formulário do Google Ads',
  'lead.received.site_form': 'Chegou pelo formulário do site',
  'lead.created_manually': 'Negociação criada',
  'lead.imported.rd_crm': 'Trazida do RD CRM',
  'lead.imported.csv': 'Importada de planilha',
  'lead.duplicates_merged': 'Negociação repetida juntada a esta',
  'lead.duplicates_merge_undone': 'Junção de repetidas desfeita',
  'rd.deal_linked': 'Ligada ao negócio do RD CRM',
  'rd.deal_created': 'Cópia criada no RD CRM',
  'lead.email_sent': 'E-mail ao lead',
  'research.queued': 'Pesquisa pedida',
  'research.done': 'Pesquisa concluída',
  'research.failed': 'Pesquisa não concluída',
  'lead.stage_changed': 'Etapa alterada',
  'lead.outcome_changed': 'Resultado alterado',
  'lead.owner_changed': 'Dono alterado',
  'lead.pipeline_changed': 'Funil alterado',
  'lead.value_changed': 'Valor alterado',
  'lead.expected_close_changed': 'Previsão de fechamento alterada',
  'lead.brand_changed': 'Marca de interesse alterada',
  'lead.company_changed': 'Empresa alterada',
  'lead.contact_linked': 'Contato adicionado',
  'lead.contact_unlinked': 'Contato removido',
  'lead.task_done': 'Tarefa concluída',
  'lead.task_updated': 'Tarefa alterada',
  'lead.renamed': 'Nome alterado',
  'lead.file_added': 'Arquivo adicionado',
  'lead.file_removed': 'Arquivo removido',
  'lead.summary_generated': 'Resumo gerado pela IA',
};

/** What the timeline can be narrowed to; `event` is everything the system did on its own. */
export type Tone = 'note' | 'call' | 'meeting' | 'task' | 'stage' | 'email' | 'file' | 'event';

const TONE_LABELS: Record<Tone, string> = {
  note: 'Anotações',
  call: 'Ligações',
  meeting: 'Reuniões',
  task: 'Tarefas',
  stage: 'Etapas',
  email: 'E-mails',
  file: 'Arquivos',
  event: 'Sistema',
};

const EMAIL_EVENTS = new Set(['lead.email_sent']);
const FILE_EVENTS = new Set(['lead.file_added', 'lead.file_removed']);

export interface Entry {
  id: string;
  at: string;
  icon: IconName;
  tone: Tone;
  title: string;
  by: string | null;
  body?: string | null;
  link?: { href: string; label: string };
}

export function entriesOf(data: LoadedLead): Entry[] {
  const entries: Entry[] = [];
  for (const note of data.notes as LeadNote[])
    entries.push({
      id: `n${note.id}`,
      at: note.at,
      icon: 'edit',
      tone: 'note',
      title: 'Anotação',
      by: note.authorName,
      body: note.body,
    });
  for (const activity of data.activities as LeadActivity[]) {
    const call = activity.kind === 'call';
    entries.push({
      id: `a${activity.id}`,
      at: activity.at,
      icon: call ? 'phone' : 'calendar',
      tone: call ? 'call' : 'meeting',
      title: call
        ? `Ligação · ${activity.outcome ? LEAD_CALL_OUTCOME_LABELS[activity.outcome] : ''}${activity.durationSeconds ? ` · ${Math.round(activity.durationSeconds / 60)} min` : ''}`
        : `Reunião${activity.participants ? ` · ${activity.participants}` : ''}`,
      by: activity.actorName,
      body: activity.note,
      link: activity.meetUrl ? { href: activity.meetUrl, label: 'Abrir o Meet' } : undefined,
    });
  }
  for (const task of data.tasks as LeadTask[]) {
    if (task.doneAt)
      entries.push({
        id: `td${task.id}`,
        at: task.doneAt,
        icon: 'check',
        tone: 'task',
        title: `Tarefa concluída · ${task.title}`,
        by: task.doneByName,
      });
    entries.push({
      id: `tc${task.id}`,
      at: task.createdAt,
      icon: 'check-square',
      tone: 'task',
      title: `Tarefa criada · ${task.title} · para ${dueLabel(task.dueAt)}`,
      by: task.auto ? 'Sistema' : task.assigneeName,
    });
  }
  for (const item of data.history)
    entries.push({
      id: `h${item.id}`,
      at: item.at,
      icon: 'arrow-right',
      tone: 'stage',
      title:
        item.won === true
          ? 'Marcada como venda'
          : item.won === false
            ? `Marcada como perda${item.lostReason ? ` · ${item.lostReason}` : ''}`
            : `${item.fromStage ?? '—'} → ${item.toStage ?? '—'}`,
      by:
        item.actorName ??
        (item.source === 'rd'
          ? 'RD CRM'
          : item.source === 'import'
            ? 'Importação'
            : item.source === 'sofia'
              ? 'Sofia'
              : null),
    });
  const skip = new Set([
    'lead.note_added',
    'lead.task_created',
    'lead.task_done',
    'lead.stage_changed',
    'lead.outcome_changed',
    'lead.call_logged',
    'lead.meeting_logged',
  ]);
  for (const event of data.events as LeadEvent[]) {
    if (skip.has(event.kind)) continue;
    const tone: Tone = EMAIL_EVENTS.has(event.kind)
      ? 'email'
      : FILE_EVENTS.has(event.kind)
        ? 'file'
        : 'event';
    entries.push({
      id: `e${event.id}`,
      at: event.at,
      icon: tone === 'email' ? 'mail' : tone === 'file' ? 'download' : 'more',
      tone,
      title: EVENT_LABELS[event.kind] ?? 'Atualização',
      by: null,
    });
  }
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

export function Timeline({ data }: { data: LoadedLead }) {
  const [only, setOnly] = useState<Tone | null>(null);
  const all = entriesOf(data);
  const present = new Set(all.map((entry) => entry.tone));
  const entries = only ? all.filter((entry) => entry.tone === only) : all;
  return (
    <div className="crm-history">
      {all.length > 0 && (
        <div className="crm-filter-chips" role="group" aria-label="Filtrar histórico">
          <button
            type="button"
            className={`crm-chip${only === null ? ' is-on' : ''}`}
            aria-pressed={only === null}
            onClick={() => setOnly(null)}
          >
            Tudo
          </button>
          {(Object.keys(TONE_LABELS) as Tone[])
            .filter((tone) => present.has(tone))
            .map((tone) => (
              <button
                key={tone}
                type="button"
                className={`crm-chip${only === tone ? ' is-on' : ''}`}
                aria-pressed={only === tone}
                onClick={() => setOnly(only === tone ? null : tone)}
              >
                {TONE_LABELS[tone]}
              </button>
            ))}
        </div>
      )}
      {all.length === 0 && <p className="crm-muted">Nada registrado ainda.</p>}
      {all.length > 0 && entries.length === 0 && (
        <p className="crm-muted">Nada deste tipo ainda.</p>
      )}
      <ol className="crm-timeline">
        {entries.map((entry) => (
          <li key={entry.id}>
            <span className={`crm-tl-icon is-${entry.tone}`} aria-hidden="true">
              <Icon name={entry.icon} size={13} />
            </span>
            <div>
              <div className="crm-tl-head">
                <b>{entry.title}</b>
                <span>
                  {formatDateTime(entry.at)}
                  {entry.by ? ` · ${entry.by}` : ''}
                </span>
              </div>
              {entry.body && <div className="crm-tl-body">{entry.body}</div>}
              {entry.link && (
                <a href={entry.link.href} target="_blank" rel="noopener noreferrer">
                  {entry.link.label}
                </a>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Every task of the deal: the open ones first (with the checkbox), then the done ones. */
function TasksTab({
  data,
  canWrite,
  onCreate,
}: {
  data: LoadedLead;
  canWrite: boolean;
  onCreate: () => void;
}) {
  const update = useUpdateTask(data.lead.id);
  const open = data.tasks
    .filter((task) => !task.doneAt)
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const done = data.tasks
    .filter((task) => task.doneAt)
    .sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
  return (
    <div className="crm-tasks-tab">
      <div className="crm-quick-row">
        <span className="crm-muted">
          {open.length === 0
            ? 'Nenhuma tarefa aberta.'
            : `${open.length} ${open.length === 1 ? 'aberta' : 'abertas'}`}
          {done.length > 0 ? ` · ${done.length} ${done.length === 1 ? 'concluída' : 'concluídas'}` : ''}
        </span>
        {canWrite && (
          <button type="button" className="crm-btn is-small" onClick={onCreate}>
            Criar tarefa
          </button>
        )}
      </div>
      {open.map((task) => (
        <label key={task.id} className={`crm-task-line${isPast(task.dueAt) ? ' is-late' : ''}`}>
          {canWrite && (
            <input
              type="checkbox"
              checked={false}
              disabled={update.isPending}
              onChange={() => update.mutate({ taskId: task.id, done: true })}
              aria-label={`Concluir ${task.title}`}
            />
          )}
          <span>
            {task.title}
            <div className="crm-task-when">
              {LEAD_TASK_KIND_LABELS[task.kind]} · {dueLabel(task.dueAt)}
              {isPast(task.dueAt) ? ' · atrasada' : ''} · {task.assigneeName ?? '—'}
            </div>
          </span>
        </label>
      ))}
      {done.map((task) => (
        <div key={task.id} className="crm-task-line is-done">
          <Icon name="check" size={14} />
          <span>
            {task.title}
            <div className="crm-task-when">
              concluída {task.doneAt ? formatDateTime(task.doneAt) : ''}
              {task.doneByName ? ` · ${task.doneByName}` : ''}
            </div>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The answers the person gave in a form, as they came, plus the first message when there was one. */
function AnswersTab({ lead }: { lead: Lead }) {
  const answers = Object.entries(lead.formAnswers ?? {}).filter(
    ([, value]) => value !== null && value !== undefined && String(value).trim() !== '',
  );
  if (answers.length === 0 && !lead.firstMessage)
    return <p className="crm-muted">Nenhum questionário respondido por esta pessoa.</p>;
  return (
    <div className="crm-answers">
      {answers.length > 0 && (
        <dl className="crm-kv crm-about" aria-label="Respostas do formulário">
          {answers.map(([question, value]) => (
            <div key={question} style={{ display: 'contents' }}>
              <dt>{question}</dt>
              <dd>{String(value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {lead.firstMessage && (
        <div className="crm-first-message">
          <b>Primeira mensagem</b>
          <p className="crm-tl-body">{lead.firstMessage}</p>
        </div>
      )}
    </div>
  );
}

const fileIcon = (mimeType: string): IconName =>
  mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'download';

/** The deal's files in the system's Drive: send, open and remove; the file itself stays in the Drive. */
export function FilesTab({
  lead,
  canWrite,
  pickRef,
}: {
  lead: Lead;
  canWrite: boolean;
  pickRef?: RefObject<HTMLInputElement | null>;
}) {
  const files = useLeadFiles(lead.id);
  const remove = useRemoveLeadFile(lead.id);
  const send = useSendLeadFile(lead.id);
  const ownRef = useRef<HTMLInputElement>(null);
  const input = pickRef ?? ownRef;
  const [sending, setSending] = useState<{ name: string; fraction: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const sendAll = async (list: FileList | null) => {
    const picked = list ? Array.from(list) : [];
    if (picked.length === 0) return;
    setError(null);
    for (const file of picked) {
      setSending({ name: file.name, fraction: 0 });
      try {
        await send.mutateAsync({
          file,
          onProgress: (fraction) => setSending({ name: file.name, fraction }),
        });
      } catch (err) {
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : 'Não foi possível enviar o arquivo.',
        );
        break;
      }
    }
    setSending(null);
  };

  const open = async (file: LeadFile) => {
    try {
      const link = await driveLink(file.fileId, 'inline');
      window.open(link.url, '_blank', 'noopener');
    } catch {
      setError('Não foi possível abrir o arquivo agora.');
    }
  };

  return (
    <div className="crm-files">
      <div className="crm-quick-row">
        <span className="crm-muted">
          {files.data
            ? files.data.length === 0
              ? 'Nenhum arquivo nesta negociação.'
              : `${files.data.length} ${files.data.length === 1 ? 'arquivo' : 'arquivos'} · na pasta Comercial › Negociações do Drive`
            : files.isError
              ? 'Não foi possível ler os arquivos.'
              : 'Carregando…'}
        </span>
        {canWrite && (
          <>
            <input
              ref={input}
              type="file"
              multiple
              hidden
              aria-label="Escolher arquivos"
              onChange={(event) => {
                void sendAll(event.target.files);
                event.target.value = '';
              }}
            />
            <button
              type="button"
              className="crm-btn is-small is-primary"
              disabled={sending !== null}
              onClick={() => input.current?.click()}
            >
              Enviar arquivo
            </button>
          </>
        )}
      </div>
      {sending && (
        <p className="crm-muted" role="status">
          Enviando {sending.name}… {Math.round(sending.fraction * 100)}%
        </p>
      )}
      {error && <p className="crm-error">{error}</p>}
      <ul className="crm-file-list">
        {(files.data ?? []).map((file) => (
          <li key={file.id} className="crm-file-row">
            <Icon name={fileIcon(file.mimeType)} size={16} />
            <span className="crm-file-name">
              <button type="button" className="crm-link-btn" onClick={() => void open(file)}>
                {file.name}
              </button>
              <span className="crm-sub">
                {formatBytes(file.byteSize)} · {formatDateTime(file.createdAt)}
                {file.addedByName ? ` · ${file.addedByName}` : ''}
              </span>
            </span>
            {canWrite && (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                aria-label={`Remover ${file.name} da negociação`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(file.fileId)}
              >
                Remover
              </button>
            )}
          </li>
        ))}
      </ul>
      {canWrite && files.data && files.data.length > 0 && (
        <p className="crm-muted">Remover tira o arquivo da negociação; ele continua no Drive.</p>
      )}
    </div>
  );
}

export function DealTabs({
  data,
  view,
  onView,
  canWrite,
  onCreateTask,
  onRegisterMeeting,
  client,
  pickRef,
  ref,
}: {
  data: LoadedLead;
  view: View;
  onView: (view: View) => void;
  canWrite: boolean;
  onCreateTask: () => void;
  onRegisterMeeting: () => void;
  /** The "Cliente" (franchisor brand) field for Expansão deals, rendered by the page. */
  client?: ReactNode;
  pickRef: RefObject<HTMLInputElement | null>;
  ref: RefObject<HTMLElement | null>;
}) {
  return (
    <section className="crm-panel crm-deal-tabs" ref={ref} id="secoes">
      <div className="crm-record-tabs" role="tablist" aria-label="Seções da negociação">
        {VIEWS.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={view === item.key}
            className={view === item.key ? 'is-active' : ''}
            disabled={item.soon !== undefined}
            title={item.soon}
            aria-label={item.soon ? `${item.label} (em breve)` : undefined}
            onClick={() => onView(item.key)}
          >
            {item.label}
            {item.soon && <small> em breve</small>}
          </button>
        ))}
      </div>
      <div className="crm-deal-tab-body">
        {view === 'history' && <Timeline data={data} />}
        {view === 'email' && <LeadEmailTab leadId={data.lead.id} />}
        {view === 'tasks' && <TasksTab data={data} canWrite={canWrite} onCreate={onCreateTask} />}
        {view === 'meetings' && (
          <MeetingsTab
            data={data}
            canWrite={canWrite}
            client={client}
            onRegisterHeld={onRegisterMeeting}
          />
        )}
        {view === 'answers' && <AnswersTab lead={data.lead} />}
        {view === 'files' && <FilesTab lead={data.lead} canWrite={canWrite} pickRef={pickRef} />}
      </div>
    </section>
  );
}
