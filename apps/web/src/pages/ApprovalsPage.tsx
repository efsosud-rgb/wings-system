import {
  APPROVAL_STATUS_LABEL,
  CHANGE_KIND_LABEL,
  type ApprovalListItem,
  type ApprovalStatus,
  type PendingGroup,
} from '@wings/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useApprovalGroups, useApprovals } from '../api/ads.js';
import { Alert, Button } from '../components/ui.js';

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
                    <Link to={`/marketing/trafego-pago-wings/aprovacoes/${approval.id}`}>
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

/**
 * Waiting approvals gathered by campaign.
 *
 * A reading aid, not a shortcut: several requests on one campaign are shown
 * with their combined weight so nobody approves the fourth increase without
 * noticing the first three. Every decision is still taken on its own screen
 * and recorded on its own — there is no bulk approval, by design.
 */
function GroupedPending({ groups }: { groups: PendingGroup[] }) {
  if (groups.length === 0) {
    return (
      <section className="approvals-section">
        <h2>Por campanha</h2>
        <p className="muted">Nada aguardando no momento.</p>
      </section>
    );
  }

  return (
    <section className="approvals-section">
      <h2>
        Por campanha <span className="muted">({groups.length})</span>
      </h2>
      <p className="field-hint">
        Cada solicitação é decidida e registrada individualmente. O total abaixo é a exposição que
        estas solicitações já reservam no orçamento do mês.
      </p>

      <div className="group-list">
        {groups.map((group) => (
          <article key={group.campaignId} className="card approval-group">
            <header>
              <div>
                <strong>{group.campaignName}</strong>
                <div className="cell-sub">
                  {group.platform.toUpperCase()} — {group.accountName} · {group.campaignExternalId}
                </div>
              </div>
              <div className="group-total">
                <span className="field-label">Reservado por estas solicitações</span>
                <p className="mono">{formatBrl(group.totalExposureDeltaCents)}</p>
                <span className="cell-sub">
                  {group.shareOfUsablePercent}% do utilizável ({formatBrl(group.usableCents)})
                </span>
              </div>
            </header>

            {group.anyEscalated && (
              <p className="error-text">Há solicitação escalada para a Diretoria neste grupo.</p>
            )}

            <ol className="group-items">
              {group.items.map((item) => (
                <li key={item.approvalId}>
                  <Link to={`/marketing/trafego-pago-wings/aprovacoes/${item.approvalId}`}>
                    {CHANGE_KIND_LABEL[item.changeKind] ?? item.changeKind}
                    {item.changeKind === 'set_daily_budget' &&
                      ` · ${formatBrl(item.fromValueCents ?? 0)} → ${formatBrl(item.toValueCents ?? 0)}/dia`}
                  </Link>
                  <span className="cell-sub">
                    {formatBrl(item.amountCents)} · {waitingFor(item.requestedAt)} ·{' '}
                    {item.requestedByAgent ? 'agente' : (item.requestedByName ?? '—')}
                    {item.status === 'escalated' && ' · escalada'}
                  </span>
                </li>
              ))}
            </ol>

            <Link
              to={`/marketing/trafego-pago-wings/aprovacoes/${group.items[0]?.approvalId ?? ''}`}
              className="btn btn-ghost btn-inline"
            >
              Decidir uma a uma
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

export function ApprovalsPage() {
  const list = useApprovals();
  const groups = useApprovalGroups();
  const [byCampaign, setByCampaign] = useState(false);
  const approvals = list.data?.approvals ?? [];

  const pending = approvals.filter((a) => a.status === 'pending');
  const escalated = approvals.filter((a) => a.status === 'escalated');
  const resolved = approvals.filter((a) => a.status === 'approved' || a.status === 'rejected');

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Tráfego pago — aprovações</h1>
          <p>Nenhuma alteração de orçamento é executada sem uma decisão registrada aqui.</p>
        </div>
        <div className="window-picker">
          <Button variant={byCampaign ? 'ghost' : 'primary'} onClick={() => setByCampaign(false)}>
            Lista
          </Button>
          <Button variant={byCampaign ? 'primary' : 'ghost'} onClick={() => setByCampaign(true)}>
            Por campanha
          </Button>
          <Link to="/dashboard/marketing" className="btn btn-ghost btn-inline">
            Ver cockpit
          </Link>
        </div>
      </header>

      {list.isError && <Alert kind="error">Não foi possível carregar as solicitações.</Alert>}
      {list.isLoading && <p className="muted">Carregando…</p>}

      {byCampaign && !groups.isLoading && <GroupedPending groups={groups.data?.groups ?? []} />}

      {!byCampaign && !list.isLoading && (
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
