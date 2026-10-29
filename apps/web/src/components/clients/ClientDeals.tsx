import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useClientDeals } from '../../api/clients.js';
import { useLead } from '../../api/leads.js';
import { MeetingsTab } from '../../pages/crm/DealMeetings.js';
import { FilesTab, Timeline } from '../../pages/crm/DealTabs.js';
import { RelatedDeals } from '../../pages/crm/ContactsPage.js';
import { LoadFailure } from '../LoadFailure.js';
import { Field, Select } from '../ui.js';

/**
 * The client record's "Negociações" tab: the deals of the CRM companies linked to this client and,
 * for the one picked, the deal page's own history, meetings and files. Read-only here; whoever
 * works the deal does it on the deal's page, where the write permissions already apply.
 */

type View = 'history' | 'meetings' | 'files';

const VIEWS: [View, string][] = [
  ['history', 'Linha do tempo'],
  ['meetings', 'Reuniões'],
  ['files', 'Arquivos'],
];

function DealDetail({ id }: { id: string }) {
  const lead = useLead(id);
  const [view, setView] = useState<View>('history');
  if (lead.isLoading) return <p className="crm-muted">Carregando…</p>;
  if (!lead.data)
    return (
      <LoadFailure what="a negociação" error={lead.error} onRetry={() => void lead.refetch()} />
    );
  return (
    <section className="crm-panel crm-deal-tabs">
      <div className="crm-record-tabs" role="tablist" aria-label="Seções da negociação">
        {VIEWS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={view === key}
            className={view === key ? 'is-active' : ''}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="crm-deal-tab-body">
        {view === 'history' && <Timeline data={lead.data} />}
        {view === 'meetings' && (
          <MeetingsTab data={lead.data} canWrite={false} onRegisterHeld={() => undefined} />
        )}
        {view === 'files' && <FilesTab lead={lead.data.lead} canWrite={false} />}
      </div>
    </section>
  );
}

export function ClientDeals({ clientId }: { clientId: string }) {
  const deals = useClientDeals(clientId);
  const [picked, setPicked] = useState<string | null>(null);
  if (deals.isLoading) return <p className="crm-muted">Carregando…</p>;
  if (!deals.data)
    return (
      <LoadFailure what="as negociações" error={deals.error} onRetry={() => void deals.refetch()} />
    );
  const list = deals.data.deals;
  if (list.length === 0)
    return (
      <p className="crm-muted">
        Nenhuma negociação ligada a este cliente. Uma empresa do CRM liga-se ao cliente em CRM
        Vendas → <Link to="/crm-vendas/empresas">Empresas</Link>, com "Virar cliente".
      </p>
    );
  const current = list.find((deal) => deal.id === picked) ?? list[0]!;
  return (
    <>
      <RelatedDeals leads={list} />
      <Field label="Ver a negociação">
        <Select value={current.id} onChange={(event) => setPicked(event.target.value)}>
          {list.map((deal) => (
            <option key={deal.id} value={deal.id}>
              {deal.name ?? 'Sem nome'}
              {deal.stage ? ` · ${deal.stage}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <DealDetail key={current.id} id={current.id} />
    </>
  );
}
