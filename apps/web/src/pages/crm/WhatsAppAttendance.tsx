import {
  SECTOR_SLUGS,
  SECTORS,
  WA_CONVERSATION_EVENT_LABELS,
  type WaAttendanceView,
  type WaConversationEvent,
} from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useAttendanceAction, type AttendanceAction } from '../../api/whatsapp.js';
import { formatDateTime } from './format.js';

/**
 * Who answers a WhatsApp conversation, on the Central and on the deal's WhatsApp tab
 * (docs/whatsapp/central.md, "Atendimento"). The API decides who may do what (`can`); these only
 * show it.
 */

/** Someone else answers it: the reader takes it first (the API refuses a send otherwise). */
export function heldByOf(view: WaAttendanceView | undefined, me: string | undefined) {
  const holder = view?.attendance.holderId;
  return view && holder && holder !== me ? (view.attendance.holderName ?? 'outra pessoa') : null;
}

/**
 * Who answers the conversation and what the reader may do (docs/whatsapp/central.md,
 * "Atendimento"): take it, pass it to a person or a department's queue, resolve or reopen it, and
 * Sofia here. Each action goes with the version on screen: if the conversation changed hands
 * meanwhile, the API refuses and says with whom it is.
 */
export function AttendanceBar({
  id,
  view,
  me,
}: {
  id: string;
  view: WaAttendanceView;
  me: string | null;
}) {
  const act = useAttendanceAction(id);
  const [target, setTarget] = useState('');
  const { attendance: a, people } = view;
  const run = (action: AttendanceAction, ask?: string) => {
    if (ask && !window.confirm(ask)) return;
    act.mutate({ version: a.version, action }, { onSuccess: () => setTarget('') });
  };
  const queueName = a.queue ? SECTORS[a.queue].name : null;
  return (
    <div className="crm-wa-window crm-wa-attendance" aria-label="Atendimento">
      <span>
        {a.holderName ? (
          <>
            Com <b>{a.holderName}</b>
            {a.assigned ? '' : ' (dono da negociação ou do número)'}
          </>
        ) : (
          <>Sem responsável{queueName ? ` · na fila ${queueName}` : ''}</>
        )}
        {a.sofiaPaused ? ' · Sofia pausada nesta conversa' : ''}
      </span>
      {a.replyingName && (
        <span className="crm-chip" role="status">
          {a.replyingName} está respondendo…
        </span>
      )}
      {a.can.take && me && (
        <button
          type="button"
          className="crm-btn is-small is-primary"
          disabled={act.isPending}
          onClick={() => run({ kind: 'assign', employeeId: me })}
        >
          Assumir
        </button>
      )}
      {a.can.transfer && (
        <>
          <select
            className="crm-select"
            aria-label="Passar para"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">Passar para…</option>
            <optgroup label="Pessoa">
              {people
                .filter((person) => person.id !== a.holderId)
                .map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
            </optgroup>
            <optgroup label="Fila do departamento">
              {SECTOR_SLUGS.map((slug) => (
                <option key={slug} value={`fila:${slug}`}>
                  {SECTORS[slug].name}
                </option>
              ))}
            </optgroup>
          </select>
          <button
            type="button"
            className="crm-btn is-small"
            disabled={!target || act.isPending}
            onClick={() =>
              run(
                target.startsWith('fila:')
                  ? { kind: 'assign', employeeId: null, queue: target.slice(5) }
                  : { kind: 'assign', employeeId: target },
              )
            }
          >
            Passar
          </button>
        </>
      )}
      {a.can.resolve && (
        <button
          type="button"
          className="crm-btn is-small"
          disabled={act.isPending}
          onClick={() => run({ kind: 'resolve' })}
        >
          Resolver
        </button>
      )}
      {a.can.reopen && (
        <button
          type="button"
          className="crm-btn is-small"
          disabled={act.isPending}
          onClick={() => run({ kind: 'reopen' })}
        >
          Reabrir
        </button>
      )}
      {a.can.pauseSofia && (
        <button
          type="button"
          className="crm-btn is-small"
          disabled={act.isPending}
          onClick={() =>
            run(
              { kind: 'sofia', action: 'pause' },
              'Pausar a Sofia nesta conversa? Ela não volta a atender aqui até alguém ligá-la de novo.',
            )
          }
        >
          Pausar a Sofia
        </button>
      )}
      {a.can.resumeSofia && (
        <button
          type="button"
          className="crm-btn is-small"
          disabled={act.isPending}
          onClick={() =>
            run(
              { kind: 'sofia', action: 'resume' },
              'Ligar a Sofia nesta conversa? Ela responde a próxima mensagem da pessoa.',
            )
          }
        >
          Ligar a Sofia
        </button>
      )}
      {act.isError && (
        <span className="crm-error" role="alert">
          {act.error instanceof ApiError ? act.error.message : 'Não foi possível agora.'}
        </span>
      )}
    </div>
  );
}

const whoDid = (event: WaConversationEvent) =>
  event.actorName ?? (event.kind.startsWith('sofia_') ? 'Sofia' : 'Sistema');

/** The panel's "Atendimento": what Sofia left when she passed it on, and who had it when. */
export function AttendanceHistory({ view }: { view: WaAttendanceView }) {
  const { sofia } = view.attendance;
  return (
    <section className="crm-panel" aria-label="Histórico do atendimento">
      <h2>Atendimento</h2>
      {sofia && (
        <>
          <h3>O que a Sofia deixou</h3>
          {sofia.reason && <p className="crm-sub">Motivo: {sofia.reason}</p>}
          {sofia.facts.length > 0 ? (
            <dl className="crm-kv sofia-kv">
              {sofia.facts.map((fact) => (
                <div key={fact.key} style={{ display: 'contents' }}>
                  <dt>{fact.label}</dt>
                  <dd>{fact.answer}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="crm-sub">Ela ainda não tinha descoberto nada.</p>
          )}
        </>
      )}
      <h3>Histórico</h3>
      {view.events.length === 0 ? (
        <p className="crm-sub">Ninguém assumiu nem passou esta conversa ainda.</p>
      ) : (
        <ol className="crm-wa-history">
          {view.events.map((event) => (
            <li key={event.id}>
              <b>{whoDid(event)}</b>: {WA_CONVERSATION_EVENT_LABELS[event.kind]}
              {event.toName && event.kind !== 'taken' ? ` para ${event.toName}` : ''}
              {event.queue ? ` (fila ${SECTORS[event.queue].name})` : ''}
              {event.reason ? ` · ${event.reason}` : ''}{' '}
              <time className="crm-sub" dateTime={event.at}>
                {formatDateTime(event.at)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
