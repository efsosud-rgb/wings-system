import {
  APPROVAL_STATUS_LABEL,
  CHANGE_KIND_LABEL,
  type ApprovalListItem,
  type ApprovalStatus,
} from '@wings/shared';
import { Link } from 'react-router-dom';
import { useApprovals } from '../api/ads.js';
import { Alert } from '../components/ui.js';

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

/** How long a request has been waiting, so urgency is visible at a glance. */
function waitingFor(iso: string): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 60) return `há ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${hours}h`;
  return `há ${Math.floor(hours / 24)} dia(s)`;
}

function StatusTag({ status }: { status: ApprovalStatus }) {
  return <span className={`status approval-${status}`}>{APPROVAL_STATUS_LABEL[status]}</span>;
}

function Section({
  title,
  items,
  empty,
}: {
  title: string;
  items: ApprovalListItem[];
  empty: string;
}) {
  return (
    <section className="approvals-section">
      <h2>
        {title} <span className="muted">({items.length})</span>
      </h2>
      {items.length === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Solicitação</th>
                <th>Valor</th>
                <th>Conta</th>
                <th>Solicitado</th>
                <th>Situação</th>
              </tr>
            </thead>
            <tbody>
              {items.map((approval) => (
                <tr key={approval.id}>
                  <td>
                    <Link to={`/trafego-pago/aprovacoes/${approval.id}`}>
                      {CHANGE_KIND_LABEL[approval.changeKind] ?? approval.changeKind}
                    </Link>
                    <div className="cell-sub">{approval.campaignName}</div>
                  </td>
                  <td className="mono">{formatBrl(approval.amountCents)}</td>
                  <td>
                    {approval.platform.toUpperCase()}
                    <div className="cell-sub">{approval.accountName}</div>
                  </td>
                  <td>
                    {formatDateTime(approval.requestedAt)}
                    <div className="cell-sub">
                      {approval.decidedAt
                        ? `decidida ${formatDateTime(approval.decidedAt)}`
                        : waitingFor(approval.requestedAt)}
                    </div>
                  </td>
                  <td>
                    <StatusTag status={approval.status} />
                    <div className="cell-sub">
                      {approval.requestedByAgent
                        ? 'solicitado pelo agente'
                        : (approval.requestedByName ?? '—')}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ApprovalsPage() {
  const list = useApprovals();
  const approvals = list.data?.approvals ?? [];

  const pending = approvals.filter((a) => a.status === 'pending');
  const escalated = approvals.filter((a) => a.status === 'escalated');
  const resolved = approvals.filter((a) => a.status === 'approved' || a.status === 'rejected');

  return (
    <>
      <header className="page-header">
        <h1>Tráfego pago — aprovações</h1>
        <p>Nenhuma alteração de orçamento é executada sem uma decisão registrada aqui.</p>
      </header>

      {list.isError && <Alert kind="error">Não foi possível carregar as solicitações.</Alert>}
      {list.isLoading && <p className="muted">Carregando…</p>}

      {!list.isLoading && (
        <>
          <Section title="Aguardando decisão" items={pending} empty="Nada aguardando no momento." />
          <Section
            title="Escaladas para a Diretoria"
            items={escalated}
            empty="Nenhuma solicitação escalada."
          />
          <Section title="Histórico" items={resolved} empty="Ainda sem decisões registradas." />
        </>
      )}
    </>
  );
}
