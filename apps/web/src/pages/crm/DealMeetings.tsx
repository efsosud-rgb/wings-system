import {
  MEETING_RECORDING_MAX_BYTES,
  MEETING_RECORDING_TYPES,
  MEETING_STATUS_LABELS,
  leadHidesWings,
  meetingCreateSchema,
  meetingTitleOf,
  meetingUpdateSchema,
  type Lead,
  type LeadActivity,
  type Meeting,
  type MeetingSummary,
  type MeetingTranscript,
  type SummarySendChannel,
} from '@wings/shared';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { hasPermission, useSession } from '../../api/auth.js';
import { ApiError } from '../../api/client.js';
import { useGoogleStatus } from '../../api/google.js';
import {
  fetchRecordingLink,
  useCreateMeeting,
  useMeeting,
  useMeetings,
  useMeetingStep,
  useMeetingTranscript,
  useNameSpeakers,
  useNextStepTask,
  useRequestAnalysis,
  useSummarySend,
  useUpdateMeeting,
  useUploadRecording,
} from '../../api/crm.js';
import type { LoadedLead } from '../../api/leads.js';
import { ConfirmDialog } from '../../components/agenda/ConfirmDialog.js';
import { Icon } from '../../components/Icon.js';
import { failureReason } from '../../lib/failure.js';
import { openMeetBeside } from '../../lib/meet.js';
import { formatDateTime, formatDay, toLocalInput } from './format.js';

/**
 * The Reunião section of the deal, on the Opus's meetings API
 * (docs/crm/reunioes-api.md). Scheduling takes a pasted Meet/Zoom/Teams link
 * today; "criar o Meet pelo Google" asks the API and shows its 503 until the
 * Workspace is authorised. "Iniciar" opens the next meeting's link beside the
 * Wings. A meeting that happened takes its recording (straight to storage, by a
 * signed address), shows the transcription with voices a person can name, the
 * analysis (each next step a task on a click) and, on Expansão, the summary to
 * the franchisor's owner: drafted, edited, approved by `meetings.approve_send`
 * with the exact text the approver read, sent once. Any field without data
 * shows "—" and why.
 */

const FIT_LABELS = { bom: 'bom', medio: 'médio', fraco: 'fraco' } as const;
const OWNER_LABELS = { vendedor: 'vendedor', cliente: 'cliente', wings: 'Wings', outro: 'outro' };

const messageOf = (error: unknown, fallback: string) =>
  error instanceof ApiError
    ? error.status === 404
      ? 'A API de reuniões ainda não está ligada.'
      : error.message
    : error instanceof Error
      ? error.message
      : fallback;

export { openMeetBeside };

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

function Problem({ error, fallback }: { error: unknown; fallback: string }) {
  if (!error) return null;
  return <p className="crm-error">{messageOf(error, fallback)}</p>;
}

const ANALYSIS_REASONS: Record<Meeting['analysis']['state'], string> = {
  nenhuma: 'Sem análise ainda: ela é feita quando a transcrição fica pronta.',
  na_fila: 'Análise na fila.',
  analisando: 'Analisando a transcrição…',
  pronta: '',
  falhou: 'A análise falhou.',
  sem_verba: 'A análise passou do teto diário; fica para amanhã.',
};

const RECORDING_REASONS: Record<Meeting['recording']['state'], string> = {
  nenhuma: 'Nenhuma gravação enviada.',
  enviando: 'Gravação a caminho do armazenamento…',
  guardada: '',
  falhou: 'A gravação não chegou inteira; envie de novo.',
};

const TRANSCRIPT_REASONS: Record<Meeting['transcript']['state'], string> = {
  nenhuma: 'Sem transcrição: ela começa quando a gravação é guardada.',
  na_fila: 'Transcrição na fila do worker.',
  transcrevendo: 'Transcrevendo…',
  pronta: '',
  falhou: 'A transcrição falhou.',
};

const SEND_LABELS: Record<NonNullable<Meeting['summarySend']>['state'], string> = {
  nenhum: 'Nenhum envio',
  rascunho: 'Rascunho — aguarda aprovação',
  aprovado: 'Aprovado — pronto para enviar',
  enviando: 'Enviando…',
  enviado: 'Enviado',
  recusado: 'Recusado',
  falhou: 'O envio falhou',
};

const formatBytes = (bytes: number | null) =>
  bytes === null ? '' : `${(bytes / 1024 / 1024).toFixed(bytes > 100 * 1024 * 1024 ? 0 : 1)} MB`;

const formatSeconds = (seconds: number | null) => {
  if (seconds === null) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
};

// --- scheduling ------------------------------------------------------------------------------

const GOOGLE_HINT: Record<string, string> = {
  google_not_configured: 'O Google ainda não foi configurado no sistema (passo do Eric).',
  google_not_connected: 'Conecte a sua conta Google em Minha conta para criar o evento e o Meet.',
  google_needs_reconnect: 'A sua conexão com o Google expirou: conecte de novo em Minha conta.',
};

const splitEmails = (value: string) =>
  value
    .split(/[,;\s]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

function ScheduleForm({
  lead,
  ownerName,
  onDone,
}: {
  lead: Pick<Lead, 'id' | 'name' | 'email' | 'pipeline' | 'brand' | 'fields'>;
  ownerName: string | null;
  onDone: () => void;
}) {
  const leadId = lead.id;
  const leadEmail = lead.email;
  const named = { name: lead.name, brand: lead.brand, companyName: lead.fields.companyName };
  // Expansão with a brand: the lead must not see the Wings — no invitation, no e-mail.
  const hidden = leadHidesWings(lead);
  const create = useCreateMeeting(leadId);
  const google = useGoogleStatus();
  const connected = google.data?.status.state === 'connected';
  const wings = google.data?.status.calendars.wings ?? null;
  const start = new Date(Date.now() + 60 * 60_000);
  start.setMinutes(0, 0, 0);
  const [title, setTitle] = useState(() => meetingTitleOf(lead.pipeline, named));
  const [inviteLead, setInviteLead] = useState(false);
  const [startsAt, setStartsAt] = useState(toLocalInput(start));
  const [endsAt, setEndsAt] = useState(toLocalInput(new Date(start.getTime() + 60 * 60_000)));
  const [calendar, setCalendar] = useState<'vendedor' | 'wings'>('vendedor');
  const [meetUrl, setMeetUrl] = useState('');
  const [guests, setGuests] = useState('');
  const [createMeet, setCreateMeet] = useState<boolean | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  // Google-made by default for whoever is connected; the pasted link for everyone else.
  const onGoogle = createMeet ?? connected;
  const wingsBlocked = onGoogle && wings !== null && wings.access !== 'writer';

  const submit = () => {
    const parsed = meetingCreateSchema.safeParse({
      title,
      startsAt: startsAt ? new Date(startsAt).toISOString() : '',
      endsAt: endsAt ? new Date(endsAt).toISOString() : '',
      calendar,
      attendees: hidden ? [] : splitEmails(guests).map((email) => ({ email })),
      meetUrl: meetUrl.trim() || null,
      createMeet: onGoogle,
      inviteLead: !hidden && inviteLead,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Confira os campos');
      return;
    }
    setProblem(null);
    create.mutate(parsed.data, {
      onSuccess: onDone,
      onError: (error) => {
        if (error instanceof ApiError && error.status === 503) {
          setProblem(
            `${GOOGLE_HINT[error.code] ?? error.message} Ou cole o link da reunião para marcar mesmo assim.`,
          );
          setCreateMeet(false);
        } else setProblem(messageOf(error, 'Não foi possível marcar a reunião.'));
      },
    });
  };

  return (
    <div className="crm-meeting-form">
      <label className="crm-field">
        <span>Título</span>
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
      </label>
      <div className="crm-meeting-form-row">
        <label className="crm-field">
          <span>Início</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </label>
        <label className="crm-field">
          <span>Fim</span>
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
        <label className="crm-field">
          <span>Agenda</span>
          <select
            value={calendar}
            onChange={(e) => setCalendar(e.target.value as 'vendedor' | 'wings')}
          >
            <option value="vendedor">Minha agenda</option>
            <option value="wings">Wings Company</option>
          </select>
        </label>
      </div>
      {wingsBlocked && (
        <p className="crm-error">
          {wings.access === 'reader'
            ? 'Você só lê a agenda Wings Company: peça à Thais "Fazer alterações nos eventos".'
            : 'A agenda Wings Company não está compartilhada com você: peça à Thais.'}
        </p>
      )}
      <label className="crm-checkbox">
        <input
          type="checkbox"
          checked={onGoogle}
          disabled={!connected}
          onChange={(e) => setCreateMeet(e.target.checked)}
        />
        Criar o evento e o Meet no Google Agenda{' '}
        {connected ? (
          <small>(convida o lead e o dono da negociação)</small>
        ) : google.isError ? (
          // Not knowing is not "not connected": asking to connect would be a made-up answer.
          <small>
            — não foi possível conferir a conexão com o Google: {failureReason(google.error)}
          </small>
        ) : google.isLoading ? (
          <small>(conferindo a conexão com o Google…)</small>
        ) : (
          <small>
            (<a href="/minha-conta">conecte a sua conta Google</a> para ligar)
          </small>
        )}
      </label>
      {onGoogle ? (
        hidden ? (
          <p className="crm-sub" data-testid="brand-rule">
            Expansão com marca: o lead não recebe convite do Google nem e-mail (não pode ver a
            Wings). Mande o link do Meet pelo{' '}
            <a href={`/crm-vendas/negociacoes/${leadId}/whatsapp`}>WhatsApp</a> com o modelo{' '}
            <code>expansao_lembrete_reuniao</code>.
            {ownerName ? ` O dono (${ownerName}) é avisado.` : ''}
          </p>
        ) : (
          <>
            <label className="crm-checkbox">
              <input
                type="checkbox"
                checked={inviteLead}
                disabled={!leadEmail}
                onChange={(e) => setInviteLead(e.target.checked)}
              />
              Convidar o lead por e-mail{' '}
              <small>
                {leadEmail ? `(${leadEmail}; a equipe costuma não convidar)` : '(lead sem e-mail)'}
              </small>
            </label>
            <label className="crm-field">
              <span>Outros convidados (e-mails separados por vírgula)</span>
              <input
                value={guests}
                placeholder="socio@empresa.com.br, contador@empresa.com.br"
                onChange={(e) => setGuests(e.target.value)}
              />
            </label>
            {ownerName && <p className="crm-sub">O dono ({ownerName}) é avisado.</p>}
          </>
        )
      ) : (
        <label className="crm-field">
          <span>Link da reunião (Google Meet, Zoom ou Teams)</span>
          <input
            type="url"
            placeholder="https://meet.google.com/…"
            value={meetUrl}
            onChange={(e) => setMeetUrl(e.target.value)}
          />
        </label>
      )}
      <p className="crm-sub">
        {onGoogle
          ? 'Título, cor e Meet seguem o padrão da agenda da equipe; a tela avisa que a reunião é gravada.'
          : 'A tela avisa que a reunião é gravada.'}
      </p>
      {problem && <p className="crm-error">{problem}</p>}
      <div className="crm-quick-row">
        <button
          type="button"
          className="crm-btn is-small is-primary"
          disabled={create.isPending || wingsBlocked}
          onClick={submit}
        >
          {create.isPending ? 'Marcando…' : 'Marcar reunião'}
        </button>
        <button type="button" className="crm-btn is-small is-quiet" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

/** Moves a scheduled meeting; on Google Agenda too when the event lives there (guests are told). */
function RescheduleForm({
  meeting,
  onDone,
}: {
  meeting: { id: string; startsAt: string; endsAt: string; googleEventId: string | null };
  onDone: () => void;
}) {
  const update = useUpdateMeeting(meeting.id);
  const [startsAt, setStartsAt] = useState(toLocalInput(new Date(meeting.startsAt)));
  const [endsAt, setEndsAt] = useState(toLocalInput(new Date(meeting.endsAt)));
  const [problem, setProblem] = useState<string | null>(null);
  const [googleRefused, setGoogleRefused] = useState(false);
  const submit = (skipGoogle: boolean) => {
    const parsed = meetingUpdateSchema.safeParse({
      startsAt: startsAt ? new Date(startsAt).toISOString() : undefined,
      endsAt: endsAt ? new Date(endsAt).toISOString() : undefined,
      skipGoogle,
    });
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? 'Confira as datas');
      return;
    }
    setProblem(null);
    update.mutate(parsed.data, {
      onSuccess: onDone,
      onError: (error) => {
        setProblem(messageOf(error, 'Não foi possível remarcar.'));
        setGoogleRefused(error instanceof ApiError && error.status === 502);
      },
    });
  };
  return (
    <div className="crm-meeting-form">
      <div className="crm-meeting-form-row">
        <label className="crm-field">
          <span>Novo início</span>
          <input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
          />
        </label>
        <label className="crm-field">
          <span>Novo fim</span>
          <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
        </label>
      </div>
      {meeting.googleEventId && (
        <p className="crm-sub">A mudança vai para o Google Agenda e os convidados são avisados.</p>
      )}
      {problem && <p className="crm-error">{problem}</p>}
      <div className="crm-quick-row">
        <button
          type="button"
          className="crm-btn is-small is-primary"
          disabled={update.isPending}
          onClick={() => submit(false)}
        >
          {update.isPending ? 'Remarcando…' : 'Remarcar'}
        </button>
        {googleRefused && (
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            disabled={update.isPending}
            onClick={() => submit(true)}
          >
            Mudar só no sistema
          </button>
        )}
        <button type="button" className="crm-btn is-small is-quiet" onClick={onDone}>
          Cancelar
        </button>
      </div>
    </div>
  );
}

// --- recording and transcript --------------------------------------------------------------

function RecordingBlock({ meeting, canWrite }: { meeting: Meeting; canWrite: boolean }) {
  const upload = useUploadRecording(meeting.id);
  const fileInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const { recording } = meeting;
  const canSend = canWrite && (recording.state === 'nenhuma' || recording.state === 'falhou');
  const listen = async () => {
    try {
      const link = await fetchRecordingLink(meeting.id);
      window.open(link.url, '_blank', 'noopener,noreferrer');
    } catch (error) {
      setProblem(messageOf(error, 'Não foi possível abrir a gravação.'));
    }
  };
  return (
    <Block title="Gravação">
      {recording.state === 'guardada' ? (
        <p>
          Guardada
          {recording.durationSeconds !== null && ` · ${formatSeconds(recording.durationSeconds)}`}
          {recording.sizeBytes !== null && ` · ${formatBytes(recording.sizeBytes)}`}{' '}
          <button type="button" className="crm-link-btn" onClick={() => void listen()}>
            Ouvir (link de 5 minutos)
          </button>
        </p>
      ) : (
        <Dash reason={RECORDING_REASONS[recording.state]} />
      )}
      {canSend && (
        <p>
          <input
            ref={fileInput}
            type="file"
            accept={MEETING_RECORDING_TYPES.join(',')}
            className="crm-file-input"
            aria-label="Arquivo da gravação"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (!(MEETING_RECORDING_TYPES as readonly string[]).includes(file.type)) {
                setProblem('Tipo de arquivo não aceito: use áudio ou vídeo do Meet.');
                return;
              }
              if (file.size > MEETING_RECORDING_MAX_BYTES) {
                setProblem('A gravação passa de 1,5 GB.');
                return;
              }
              setProblem(null);
              upload.mutate(file);
            }}
          />
          <button
            type="button"
            className="crm-btn is-small"
            disabled={upload.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {upload.isPending ? 'Enviando…' : 'Enviar gravação'}
          </button>{' '}
          <span className="crm-sub">
            Vai direto ao armazenamento; a transcrição começa sozinha.
          </span>
        </p>
      )}
      <Problem error={upload.error} fallback="Não foi possível enviar a gravação." />
      {problem && <p className="crm-error">{problem}</p>}
    </Block>
  );
}

function SpeakerName({
  speaker,
  canWrite,
  onName,
}: {
  speaker: MeetingTranscript['speakers'][number];
  canWrite: boolean;
  onName: (label: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(speaker.label ?? '');
  if (!editing) {
    return (
      <li>
        <b>{speaker.key}</b> · {speaker.label ?? speaker.attendeeEmail ?? '—'}
        {canWrite && (
          <>
            {' '}
            <button type="button" className="crm-link-btn" onClick={() => setEditing(true)}>
              {speaker.label ? 'renomear' : 'dizer quem é'}
            </button>
          </>
        )}
      </li>
    );
  }
  return (
    <li className="crm-quick-row">
      <b>{speaker.key}</b>
      <input
        value={label}
        maxLength={60}
        placeholder="Quem fala aqui"
        onChange={(e) => setLabel(e.target.value)}
        aria-label={`Nome da voz ${speaker.key}`}
      />
      <button
        type="button"
        className="crm-btn is-small"
        disabled={!label.trim()}
        onClick={() => {
          onName(label.trim());
          setEditing(false);
        }}
      >
        Salvar
      </button>
    </li>
  );
}

function TranscriptBlock({ meeting, canWrite }: { meeting: Meeting; canWrite: boolean }) {
  const ready = meeting.transcript.state === 'pronta';
  const [open, setOpen] = useState(false);
  const transcript = useMeetingTranscript(meeting.id, ready && open);
  const name = useNameSpeakers(meeting.id);
  if (!ready) {
    return (
      <Block title="Transcrição">
        <Dash reason={meeting.transcript.error ?? TRANSCRIPT_REASONS[meeting.transcript.state]} />
      </Block>
    );
  }
  return (
    <Block title="Transcrição">
      <p>
        {meeting.transcript.segments} trechos{' '}
        <button type="button" className="crm-link-btn" onClick={() => setOpen((v) => !v)}>
          {open ? 'ocultar' : 'ler'}
        </button>
      </p>
      {open && transcript.isLoading && <p className="crm-muted">Carregando…</p>}
      {open && transcript.isError && (
        <Dash reason={messageOf(transcript.error, 'Não foi possível ler a transcrição.')} />
      )}
      {open && transcript.data && (
        <div className="crm-transcript">
          <div className="crm-sub">
            {transcript.data.language ? `Idioma ${transcript.data.language}` : ''}
            {transcript.data.durationSeconds !== null &&
              ` · ${formatSeconds(transcript.data.durationSeconds)}`}
          </div>
          {transcript.data.speakers.length > 0 ? (
            <ul className="crm-plain-list">
              {transcript.data.speakers.map((speaker) => (
                <SpeakerName
                  key={speaker.key}
                  speaker={speaker}
                  canWrite={canWrite}
                  onName={(label) => name.mutate({ [speaker.key]: { label } })}
                />
              ))}
            </ul>
          ) : (
            <Dash
              reason={
                transcript.data.speakersReason ?? 'A separação de quem falou ainda não está ligada.'
              }
            />
          )}
          <Problem error={name.error} fallback="Não foi possível nomear a voz." />
          <ol className="crm-transcript-segments">
            {transcript.data.segments.map((segment, index) => (
              <li key={index}>
                <span className="crm-sub">
                  {formatSeconds(segment.start)}
                  {segment.speaker ? ` · ${segment.speaker}` : ''}
                </span>{' '}
                {segment.text}
              </li>
            ))}
          </ol>
        </div>
      )}
    </Block>
  );
}

// --- the summary to the franchisor -----------------------------------------------------------

function SummarySendCard({
  meeting,
  canWrite,
  canApprove,
}: {
  meeting: Meeting;
  canWrite: boolean;
  canApprove: boolean;
}) {
  const actions = useSummarySend(meeting.id);
  const send = meeting.summarySend;
  const state = send?.state ?? 'nenhum';
  const [channel, setChannel] = useState<SummarySendChannel>('email');
  const [draft, setDraft] = useState(send?.text ?? '');
  const [editing, setEditing] = useState(false);
  // The text on screen is the server's: what the approver reads is what is approved.
  useEffect(() => {
    if (!editing) setDraft(send?.text ?? '');
  }, [send?.text, editing]);
  const analysisReady = meeting.analysis.state === 'pronta';
  const error =
    actions.create.error ??
    actions.edit.error ??
    actions.approve.error ??
    actions.refuse.error ??
    actions.send.error;
  const busy =
    actions.create.isPending ||
    actions.edit.isPending ||
    actions.approve.isPending ||
    actions.refuse.isPending ||
    actions.send.isPending;

  return (
    <Block title="Resumo para o dono da franqueadora">
      <p className="crm-sub">
        Só sai depois de lido e aprovado por quem tem a permissão; vai uma vez, ao contato principal
        da marca, sem dados do candidato além do primeiro nome.
      </p>
      <p>
        <b>{SEND_LABELS[state]}</b>
        {send?.channel && ` · ${send.channel === 'whatsapp' ? 'WhatsApp' : 'e-mail'}`}
        {send?.to && ` · para ${send.to}`}
        {send?.approvedAt && ` · aprovado em ${formatDateTime(send.approvedAt)}`}
        {send?.sentAt && ` · enviado em ${formatDateTime(send.sentAt)}`}
      </p>
      {send?.error && <p className="crm-error">{send.error}</p>}

      {(state === 'nenhum' || state === 'recusado' || state === 'falhou') && canWrite && (
        <div className="crm-quick-row">
          <select
            value={channel}
            aria-label="Canal do envio"
            onChange={(e) => setChannel(e.target.value as SummarySendChannel)}
          >
            <option value="email">por e-mail</option>
            <option value="whatsapp">por WhatsApp</option>
          </select>
          <button
            type="button"
            className="crm-btn is-small"
            disabled={busy || !analysisReady}
            title={analysisReady ? undefined : 'Precisa da análise pronta'}
            onClick={() => actions.create.mutate(channel)}
          >
            Gerar rascunho do resumo
          </button>
        </div>
      )}

      {send?.text && (state === 'rascunho' || state === 'aprovado') && (
        <>
          {editing ? (
            <textarea
              className="crm-summary-text"
              value={draft}
              rows={10}
              maxLength={4000}
              aria-label="Texto do resumo"
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <pre className="crm-summary-text" aria-label="Texto do resumo">
              {send.text}
            </pre>
          )}
          <div className="crm-quick-row">
            {state === 'rascunho' && canWrite && !editing && (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                onClick={() => setEditing(true)}
              >
                Editar texto
              </button>
            )}
            {editing && (
              <>
                <button
                  type="button"
                  className="crm-btn is-small"
                  disabled={busy || draft.trim().length < 20}
                  onClick={() =>
                    actions.edit.mutate(draft.trim(), { onSuccess: () => setEditing(false) })
                  }
                >
                  Salvar texto
                </button>
                <button
                  type="button"
                  className="crm-btn is-small is-quiet"
                  onClick={() => {
                    setEditing(false);
                    setDraft(send.text ?? '');
                  }}
                >
                  Descartar
                </button>
              </>
            )}
            {state === 'rascunho' && canApprove && !editing && (
              <button
                type="button"
                className="crm-btn is-small is-primary"
                disabled={busy}
                // Exactly the text rendered above, as the server gave it.
                onClick={() => actions.approve.mutate(send.text as string)}
              >
                Li e aprovo este texto
              </button>
            )}
            {state === 'aprovado' && canApprove && (
              <button
                type="button"
                className="crm-btn is-small is-primary"
                disabled={busy}
                onClick={() => actions.send.mutate()}
              >
                Enviar agora (uma vez)
              </button>
            )}
            {canApprove && !editing && (
              <button
                type="button"
                className="crm-btn is-small is-quiet"
                disabled={busy}
                onClick={() => actions.refuse.mutate()}
              >
                Recusar
              </button>
            )}
          </div>
          {state === 'rascunho' && !canApprove && (
            <p className="crm-sub">A aprovação é de quem tem a permissão de aprovar o envio.</p>
          )}
        </>
      )}
      <Problem error={error} fallback="Não foi possível concluir." />
    </Block>
  );
}

// --- one meeting --------------------------------------------------------------------------

function MeetingDetail({
  id,
  canWrite,
  canApprove,
  expansion,
}: {
  id: string;
  canWrite: boolean;
  canApprove: boolean;
  expansion: boolean;
}) {
  const meeting = useMeeting(id);
  const toTask = useNextStepTask(id);
  const analyze = useRequestAnalysis(id);
  const update = useUpdateMeeting(id);
  const [rescheduling, setRescheduling] = useState(false);
  const [askingCancel, setAskingCancel] = useState(false);
  if (meeting.isLoading) return <p className="crm-muted">Carregando…</p>;
  if (meeting.isError || !meeting.data) {
    return <Dash reason={messageOf(meeting.error, 'Não foi possível ler a reunião.')} />;
  }
  const data = meeting.data;
  const { analysis, attendees } = data;
  const ready = analysis.state === 'pronta';
  const reason = analysis.reason ?? ANALYSIS_REASONS[analysis.state];
  const canAnalyze =
    canWrite &&
    data.transcript.state === 'pronta' &&
    analysis.state !== 'na_fila' &&
    analysis.state !== 'analisando';
  return (
    <div className="crm-meeting-detail">
      {data.googleEventId && (
        <p className="crm-sub">
          Criada no Google Agenda
          {data.googleHtmlLink && (
            <>
              {' · '}
              <a href={data.googleHtmlLink} target="_blank" rel="noreferrer">
                Abrir no Google Agenda
              </a>
            </>
          )}
          {data.googleSync?.state === 'falhou' && (
            <>
              {' · '}
              <span className="crm-error">
                {data.googleSync.error === 'skipped'
                  ? 'a última mudança ficou só no sistema'
                  : 'a última mudança não chegou ao Google'}
              </span>
            </>
          )}
        </p>
      )}
      {canWrite && data.status === 'agendada' && (
        <div className="crm-quick-row">
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            onClick={() => setRescheduling((v) => !v)}
            aria-expanded={rescheduling}
          >
            Remarcar
          </button>
          <button
            type="button"
            className="crm-btn is-small is-quiet"
            disabled={update.isPending}
            onClick={() => setAskingCancel(true)}
          >
            Cancelar reunião
          </button>
          {askingCancel && (
            // Asked inside the page: window.confirm is drawn by the browser and some block it.
            <ConfirmDialog
              title="Cancelar esta reunião?"
              confirmLabel="Cancelar reunião"
              cancelLabel="Voltar"
              onCancel={() => setAskingCancel(false)}
              onConfirm={() => {
                setAskingCancel(false);
                update.mutate({ status: 'cancelada' });
              }}
            >
              {data.googleEventId && <p>Ela sai do Google Agenda e os convidados são avisados.</p>}
            </ConfirmDialog>
          )}
          <Problem error={update.error} fallback="Não foi possível cancelar." />
          {update.error instanceof ApiError && update.error.status === 502 && (
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              disabled={update.isPending}
              onClick={() => update.mutate({ status: 'cancelada', skipGoogle: true })}
            >
              Cancelar só no sistema
            </button>
          )}
        </div>
      )}
      {rescheduling && data.status === 'agendada' && (
        <RescheduleForm meeting={data} onDone={() => setRescheduling(false)} />
      )}
      <RecordingBlock meeting={data} canWrite={canWrite} />
      <TranscriptBlock meeting={data} canWrite={canWrite} />
      <Block title="Resumo">
        {ready && analysis.summary ? <p>{analysis.summary}</p> : <Dash reason={reason} />}
        {canAnalyze && (
          <p>
            <button
              type="button"
              className="crm-btn is-small is-quiet"
              disabled={analyze.isPending}
              onClick={() => analyze.mutate()}
            >
              {ready ? 'Analisar de novo' : 'Analisar agora'}
            </button>{' '}
            <span className="crm-sub">Conta no teto diário da IA.</span>
          </p>
        )}
        <Problem error={analyze.error} fallback="Não foi possível pedir a análise." />
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
        <Problem error={toTask.error} fallback="Não foi possível criar a tarefa." />
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
      {expansion && <SummarySendCard meeting={data} canWrite={canWrite} canApprove={canApprove} />}
    </div>
  );
}

function MeetingRow({
  meeting,
  open,
  onToggle,
  canWrite,
  canApprove,
  expansion,
}: {
  meeting: MeetingSummary;
  open: boolean;
  onToggle: () => void;
  canWrite: boolean;
  canApprove: boolean;
  expansion: boolean;
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
          {meeting.recordingState === 'guardada' && ' · gravada'}
          {meeting.status === 'encerrada' && meeting.recordingState === 'nenhuma' && (
            <span className="crm-chip">falta a gravação</span>
          )}
          {meeting.analysisState === 'pronta' && ' · analisada'}
          {meeting.summarySendState === 'enviado' && ' · resumo enviado'}
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
      {open && (
        <MeetingDetail
          id={meeting.id}
          canWrite={canWrite}
          canApprove={canApprove}
          expansion={expansion}
        />
      )}
    </li>
  );
}

/** The meeting "Iniciar" opens: the one in progress, else the next one scheduled, with a link. */
export function meetingToStart(
  meetings: MeetingSummary[],
  now = Date.now(),
): MeetingSummary | null {
  const live = meetings.filter(
    (m) => m.meetUrl && m.status !== 'cancelada' && m.status !== 'encerrada',
  );
  const running = live.find((m) => m.status === 'em_andamento');
  if (running) return running;
  return (
    live
      .filter((m) => Date.parse(m.endsAt) >= now)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null
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
  const session = useSession();
  const canApprove = hasPermission(session.data, 'meetings.approve_send');
  const meetings = useMeetings(lead.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const step = useMeetingStep();
  const [justEnded, setJustEnded] = useState<string | null>(null);
  const next = meetings.data ? meetingToStart(meetings.data) : null;
  const running = next?.status === 'em_andamento' ? next : null;
  const expansion = lead.pipeline === 'expansao';
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
          {canWrite && (
            <button
              type="button"
              className="crm-btn is-small"
              onClick={() => setScheduling((v) => !v)}
              aria-expanded={scheduling}
            >
              Agendar reunião
            </button>
          )}
          <button
            type="button"
            className="crm-btn is-small is-primary"
            disabled={!next}
            title={
              next ? `Abre ${next.title} ao lado do Wings` : 'Nenhuma reunião com link para iniciar'
            }
            onClick={() => {
              if (!next?.meetUrl) return;
              // The window first, inside the click, or the browser blocks it.
              openMeetBeside(next.meetUrl);
              if (canWrite && next.status === 'agendada')
                step.mutate({ id: next.id, step: 'start' });
            }}
          >
            {running ? 'Voltar ao Meet' : 'Iniciar reunião'}
          </button>
          {canWrite && running && (
            <button
              type="button"
              className="crm-btn is-small"
              disabled={step.isPending}
              onClick={() =>
                step.mutate(
                  { id: running.id, step: 'end' },
                  {
                    onSuccess: (meeting) => {
                      setJustEnded(meeting.id);
                      setOpenId(meeting.id);
                    },
                  },
                )
              }
            >
              Encerrar reunião
            </button>
          )}
        </span>
      </div>
      <p className="crm-sub">
        Agendar cria o evento e o Meet no Google Agenda com a sua conta (ou marca com um link
        colado); Iniciar abre o Meet numa janela ao lado do Wings e registra o início na negociação;
        Encerrar registra o fim.
      </p>
      <Problem error={step.error} fallback="Não foi possível registrar na negociação." />
      {justEnded && (
        <p className="crm-wa-window is-open" role="status">
          Reunião encerrada e registrada na negociação. Envie a gravação abaixo para transcrever e
          analisar.
        </p>
      )}
      {scheduling && (
        <ScheduleForm
          lead={lead}
          ownerName={lead.work?.ownerName ?? null}
          onDone={() => setScheduling(false)}
        />
      )}
      {expansion && client && (
        <div className="crm-meeting-client">
          <span className="crm-sub">Cliente (marca franqueadora)</span>
          {client}
        </div>
      )}
      {meetings.isError && (
        <Dash reason={messageOf(meetings.error, 'Não foi possível ler as reuniões.')} />
      )}
      {meetings.data && meetings.data.length > 0 && (
        <ul className="crm-meeting-list">
          {meetings.data.map((meeting) => (
            <MeetingRow
              key={meeting.id}
              meeting={meeting}
              open={openId === meeting.id}
              onToggle={() => setOpenId(openId === meeting.id ? null : meeting.id)}
              canWrite={canWrite}
              canApprove={canApprove}
              expansion={expansion}
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
