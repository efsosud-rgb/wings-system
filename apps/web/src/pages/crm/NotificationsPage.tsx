import { Link } from 'react-router-dom';
import { useMarkNotificationsRead, useNotifications } from '../../api/automations.js';
import { ago } from './format.js';

/**
 * CRM Vendas → Avisos: the notices the automations and the deadline alerts
 * leave for the person (first contact overdue, task overdue, deal stuck in a
 * stage, a rule's own warning). The panel is the only place they show for now.
 * Each notice names the problem, never the person; the link opens the deal.
 */
const KIND_LABEL: Record<string, string> = {
  first_contact_overdue: 'Primeiro contato atrasado',
  task_overdue: 'Tarefa atrasada',
  stage_stuck: 'Negociação parada',
  new_lead: 'Novo lead',
  lead_unassigned: 'Lead sem dono',
  backfill_assigned: 'Leads antigos atribuídos',
  backfill_unassigned: 'Leads antigos sem dono',
  automation: 'Aviso da automação',
};

export function NotificationsPage() {
  const list = useNotifications();
  const mark = useMarkNotificationsRead();
  const items = list.data?.notifications ?? [];
  return (
    <div className="crm-page">
      <header className="crm-head">
        <h1>Avisos</h1>
        <span className="crm-sub">{list.data?.unread ?? 0} não lidos</span>
        <span className="crm-head-spacer" />
        <button
          type="button"
          className="crm-btn is-small"
          disabled={mark.isPending || (list.data?.unread ?? 0) === 0}
          onClick={() => mark.mutate('all')}
        >
          Marcar todos como lidos
        </button>
      </header>
      <div className="crm-page-scroll crm-stack">
        {list.isLoading ? <p className="crm-sub">Carregando…</p> : null}
        {!list.isLoading && items.length === 0 ? (
          <p className="crm-sub">
            Nenhum aviso. Prazos vencidos e negociações paradas aparecem aqui.
          </p>
        ) : null}
        {items.map((item) => (
          <article
            key={item.id}
            className="crm-panel"
            style={{ opacity: item.readAt ? 0.65 : 1 }}
            aria-label={KIND_LABEL[item.kind] ?? 'Aviso'}
          >
            <h2>{KIND_LABEL[item.kind] ?? 'Aviso'}</h2>
            <p>{item.message}</p>
            <p className="crm-sub">
              há {ago(item.createdAt)}
              {item.leadId ? (
                <>
                  {' · '}
                  <Link to={`/crm-vendas/negociacoes/${item.leadId}`}>Abrir a negociação</Link>
                </>
              ) : null}
              {item.readAt ? null : (
                <>
                  {' · '}
                  <button
                    type="button"
                    className="crm-btn is-small is-quiet"
                    onClick={() => mark.mutate([item.id])}
                  >
                    Marcar como lido
                  </button>
                </>
              )}
            </p>
          </article>
        ))}
      </div>
    </div>
  );
}
