import {
  MEETING_STATUS_LABELS,
  type LeadActivity,
  type Meeting,
  type MeetingSummary,
} from '@wings/shared';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../../api/client.js';
import { useMeeting, useMeetings, useNextStepTask } from '../../api/crm.js';
import type { LoadedLead } from '../../api/leads.js';
import { Icon } from '../../components/Icon.js';
import { formatDateTime, formatDay } from './format.js';

/**
 * The Reunião section of the deal (docs/crm/reunioes-api.md, the Opus's
 * contract). "Agendar reunião" (the seller's and Wings' Google calendars) and
 * "Iniciar reunião" (the Meet in a window beside the Wings) wait, disabled,
 * "em breve", for the Google integration. What the API already answers is
 * shown as it comes: the list, and for a meeting that ended, the analysis —
 * summary, participants, topics, next steps (each one a task on a click) and
 * the lead's evaluation. Any field without data shows "—" and why. Expansão
 * deals carry the "Cliente" field (the franchisor brand), chosen before or
 * after the meeting.
 */

const GOOGLE_SOON = 'Em breve: depende da integração do Google (agenda e Meet)';

const FIT_LABELS = { bom: 'bom', medio: 'médio', fraco: 'fraco' } as const;
const OWNER_LABELS = { vendedor: 'vendedor', cliente: 'cliente', wings: 'Wings', outro: 'outro' };

const reasonOf = (error: unknown) =>
  error instanceof ApiError && error.status === 404
    ? 'A API de reuniões ainda não está ligada.'
    : error instanceof ApiError
      ? error.message
      : 'Não foi possível ler as reuniões.';

/** Opens the Meet in its own window beside the Wings, which stays on the deal. */
export function openMeetBeside(url: string) {
  const width = Math.min(1100, Math.round(window.screen.availWidth * 0.55));
  const height = Math.round(window.screen.availHeight * 0.9);
  const left = window.screen.availWidth - width;
  window.open(
    url,
    'wings-meet',
    `popup,width=${width},height=${height},left=${left},top=0,noopener,noreferrer`,
  );
}

function Dash({ reason }: { reason: string }) {
  return (
    <span className="crm-muted">
      — <small>{reason}</small>
    </span>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="crm-meeting-block">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

const ANALYSIS_REASONS: Record<Meeting['analysis']['state'], string> = {
  nenhuma: 'Sem análise ainda: ela é feita quando a transcrição fica pronta.',
  na_fila: 'Análise na fila.',
  analisando: 'Analisando a transcrição…',
  pronta: '',
  falhou: 'A análise falhou.',
  sem_verba: 'A análise passou do teto diário; fica para amanhã.',
};

/** What the deal learns from one meeting that ended. */
function MeetingDetail({ id, canWrite }: { id: string; canWrite: boolean }) {
  const meeting = useMeeting(id);
  const toTask = useNextStepTask(id);
  if (meeting.isLoading) return <p className="crm-muted">Carregando…</p>;
  if (meeting.isError || !meeting.data) return <Dash reason={reasonOf(meeting.error)} />;
  const { analysis, attendees } = meeting.data;
  const ready = analysis.state === 'pronta';
  const reason = analysis.reason ?? ANALYSIS_REASONS[analysis.state];
  return (
    <div className="crm-meeting-detail">
      <Block title="Resumo">
        {ready && analysis.summary ? <p>{analysis.summary}</p> : <Dash reason={reason} />}
      </Block>
      <Block title="Participantes">
        {attendees.length === 0 && analysis.participants.length === 0 ? (
          <Dash reason="Ninguém convidado nem identificado na gravação." />
        ) : (
          <ul className="crm-plain-list">
            {attendees.map((person) => (
              <li key={person.email}>
                {person.name ?? person.email}
                {person.responseStatus ? ` · ${person.responseStatus.replace('_', ' ')}` : ''}
              </li>
            ))}
            {analysis.participants.map((person, index) => (
              <li key={`p${index}`}>
                {person.suggestedName ?? person.speaker ?? '—'} · {person.role}
                <span className="crm-sub"> (sugerido pela IA)</span>
              </li>
            ))}
          </ul>
        )}
      </Block>
      <Block title="Assuntos">
        {ready && analysis.topics.length > 0 ? (
          <ul className="crm-plain-list">
            {analysis.topics.map((topic) => (
              <li key={topic}>{topic}</li>
            ))}
          </ul>
        ) : (
          <Dash reason={ready ? 'A análise não listou assuntos.' : reason} />
        )}
      </Block>
      <Block title="Próximos compromissos">
        {ready && analysis.nextSteps.length > 0 ? (
          <ul className="crm-plain-list">
            {analysis.nextSteps.map((step, index) => (
              <li key={`${index}-${step.what}`} className="crm-next-step">
                <span>
                  {step.what} · {OWNER_LABELS[step.owner]}
                  {step.dueAt ? ` · até ${formatDay(step.dueAt)}` : ''}
                </span>
                {step.taskId ? (
                  <span className="crm-sub">já é tarefa</span>
                ) : (
                  canWrite && (
                    <button
                      type="button"
                      className="crm-btn is-small is-quiet"
                      disabled={toTask.isPending}
                      onClick={() => toTask.mutate(index)}
                    >
                      Virar tarefa
                    </button>
                  )
                )}
              </li>
            ))}
          </ul>
        ) : (
          <Dash reason={ready ? 'A análise não apontou próximos passos.' : reason} />
        )}
      </Block>
      <Block title="Avaliação do lead">
        {ready && analysis.leadEvaluation ? (
          <div>
            <p>
              <b>{analysis.leadEvaluation.score}/100</b> · perfil{' '}
              {FIT_LABELS[analysis.leadEvaluation.fit]}
            </p>
            {analysis.leadEvaluation.reasons.length > 0 && (
              <p className="crm-sub">A favor: {analysis.leadEvaluation.reasons.join('; ')}</p>
            )}
            {analysis.leadEvaluation.risks.length > 0 && (
              <p className="crm-sub">Riscos: {analysis.leadEvaluation.risks.join('; ')}</p>
            )}
          </div>
        ) : (
          <Dash reason={ready ? 'A análise não avaliou o lead.' : reason} />
        )}
      </Block>
      {ready && analysis.analyzedAt && (
        <p className="crm-sub">
          Análise de {formatDateTime(analysis.analyzedAt)}
          {analysis.model ? ` · ${analysis.model}` : ''} · não muda etapa, valor nem tarefa sozinha
        </p>
      )}
      {toTask.error && (
        <p className="crm-error">
          {toTask.error instanceof ApiError
            ? toTask.error.message
            : 'Não foi possível criar a tarefa.'}
        </p>
      )}
    </div>
  );
}

function MeetingRow({
  meeting,
  open,
  onToggle,
  canWrite,
}: {
  meeting: MeetingSummary;
  open: boolean;
  onToggle: () => void;
  canWrite: boolean;
}) {
  return (
    <li className={`crm-meeting-row${open ? ' is-open' : ''}`}>
      <div className="crm-meeting-line">
        <button type="button" className="crm-link-btn" onClick={onToggle} aria-expanded={open}>
          {meeting.title}
        </button>
        <span className="crm-sub">
          {formatDateTime(meeting.startsAt)} · {MEETING_STATUS_LABELS[meeting.status]} · agenda{' '}
          {meeting.calendar === 'wings' ? 'da Wings' : 'do vendedor'}
        </span>
        {meeting.meetUrl && meeting.status !== 'cancelada' && (
          <button
            type="button"
            className="crm-btn is-small"
            onClick={() => openMeetBeside(meeting.meetUrl!)}
          >
            Abrir o Meet ao lado
          </button>
        )}
      </div>
      {open && <MeetingDetail id={meeting.id} canWrite={canWrite} />}
    </li>
  );
}

export function MeetingsTab({
  data,
  canWrite,
  client,
  onRegisterHeld,
}: {
  data: LoadedLead;
  canWrite: boolean;
  /** The "Cliente" field of an Expansão deal (the franchisor brand), rendered by the page. */
  client?: ReactNode;
  onRegisterHeld: () => void;
}) {
  const { lead } = data;
  const meetings = useMeetings(lead.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const held = (data.activities as LeadActivity[])
    .filter((activity) => activity.kind === 'meeting')
    .sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="crm-meetings">
      <div className="crm-quick-row crm-meetings-actions">
        <span className="crm-muted">
          {meetings.data
            ? meetings.data.length === 0
              ? 'Nenhuma reunião marcada.'
              : `${meetings.data.length} ${meetings.data.length === 1 ? 'reunião' : 'reuniões'}`
            : meetings.isError
              ? ''
              : 'Carregando…'}
        </span>
        <span className="crm-meetings-buttons">
          <button type="button" className="crm-btn is-small" disabled title={GOOGLE_SOON}>
            Agendar reunião <small>em breve</small>
          </button>
          <button type="button" className="crm-btn is-small is-primary" disabled title={GOOGLE_SOON}>
            Iniciar reunião <small>em breve</small>
          </button>
        </span>
      </div>
      <p className="crm-sub">
        Agendar usa a agenda do Google do vendedor ou da Wings; Iniciar abre o Meet numa janela
        ao lado do Wings. Os dois esperam a integração do Google.
      </p>
      {lead.pipeline === 'expansao' && client && (
        <div className="crm-meeting-client">
          <span className="crm-sub">Cliente (marca franqueadora)</span>
          {client}
        </div>
      )}
      {meetings.isError && <Dash reason={reasonOf(meetings.error)} />}
      {meetings.data && meetings.data.length > 0 && (
        <ul className="crm-meeting-list">
          {meetings.data.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              open={openId === meeting.id}
              onToggle={() => setOpenId(openId === meeting.id ? null : meeting.id)}
              canWrite={canWrite}
            />
          ))}
        </ul>
      )}
      <div className="crm-meeting-block">
        <h3>
          Reuniões registradas à mão
          {canWrite && (
            <button type="button" className="crm-btn is-small is-quiet" onClick={onRegisterHeld}>
              Registrar reunião feita
            </button>
          )}
        </h3>
        {held.length === 0 ? (
          <p className="crm-muted">Nenhuma.</p>
        ) : (
          <ul className="crm-plain-list">
            {held.map((activity) => (
              <li key={activity.id}>
                <Icon name="calendar" size={13} /> {formatDateTime(activity.at)}
                {activity.participants ? ` · ${activity.participants}` : ''}
                {activity.note ? ` — ${activity.note}` : ''}
                {activity.meetUrl && (
                  <>
                    {' '}
                    <button
                      type="button"
                      className="crm-link-btn"
                      onClick={() => openMeetBeside(activity.meetUrl!)}
                    >
                      Abrir o Meet ao lado
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
