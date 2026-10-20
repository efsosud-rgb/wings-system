import { MEETING_STATUS_LABELS } from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { permissionScope, useSession } from '../api/auth.js';
import { useMeetingList } from '../api/crm.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { formatDateTime } from './crm/format.js';

/**
 * Produtividade → Reuniões (Eric, 19/10): read-only. A seller sees the meetings of their own deals,
 * whoever reads every lead sees them all (the API decides); scheduling stays on the lead's page.
 */
export function MeetingsPage() {
  const session = useSession();
  const everyone = permissionScope(session.data, 'leads.read') === 'all';
  const [when, setWhen] = useState<'upcoming' | 'past'>('upcoming');
  const meetings = useMeetingList(when);

  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Reuniões</h1>
        <span className="crm-head-spacer" />
        <div className="crm-segment" role="group" aria-label="Quando">
          <button
            type="button"
            className={when === 'upcoming' ? 'is-active' : ''}
            onClick={() => setWhen('upcoming')}
          >
            Próximas
          </button>
          <button
            type="button"
            className={when === 'past' ? 'is-active' : ''}
            onClick={() => setWhen('past')}
          >
            Anteriores
          </button>
        </div>
      </header>
      <p className="crm-sub">Para marcar, remarcar ou iniciar, abra a negociação.</p>
      <div className="crm-page-scroll">
        {meetings.isLoading && <p className="crm-muted">Carregando…</p>}
        {meetings.isError && (
          <LoadFailure
            what="as reuniões"
            error={meetings.error}
            onRetry={() => void meetings.refetch()}
          />
        )}
        {meetings.isSuccess && meetings.data.length === 0 && (
          <p className="crm-muted">
            {when === 'upcoming' ? 'Nenhuma reunião marcada.' : 'Nenhuma reunião anterior.'}
          </p>
        )}
        {meetings.data?.map((meeting) => (
          <div key={meeting.id} className="crm-task-row">
            <span />
            <div>
              <div>
                <Link to={`/crm-vendas/negociacoes/${meeting.leadId}`}>{meeting.title}</Link>
              </div>
              <div className="crm-sub">
                {MEETING_STATUS_LABELS[meeting.status]}
                {meeting.recordingState === 'guardada' && ' · gravada'}
                {everyone && ` · ${meeting.dealOwnerName ?? 'sem dono'}`}
              </div>
            </div>
            <span className="crm-task-when">{formatDateTime(meeting.startsAt)}</span>
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
