import {
  APPROVAL_STATUS_LABEL,
  APPROVAL_TRIGGER_LABEL,
  CHANGE_KIND_LABEL,
  type ApprovalDetail,
} from '@wings/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { useApproval, useDecideApproval } from '../api/ads.js';
import { ApiError } from '../api/client.js';
import { Alert, Button, Field, Input } from '../components/ui.js';

function formatBrl(cents: number | null): string {
  if (cents === null) return '—';
  return (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

const AUDIT_LABEL: Record<string, string> = {
  'ads.approval_requested': 'Solicitação registrada',
  'ads.approval_escalated': 'Escalada para a Diretoria',
  'ads.approval_granted': 'Aprovada',
  'ads.approval_rejected': 'Recusada',
  'ads.approval_denied_to_actor': 'Tentativa de decisão sem permissão',
};

function Summary({ approval }: { approval: ApprovalDetail }) {
  const budgetChange =
    approval.changeKind === 'set_daily_budget'
      ? `${formatBrl(approval.fromValueCents)} → ${formatBrl(approval.toValueCents)} por dia`
      : (CHANGE_KIND_LABEL[approval.changeKind] ?? approval.changeKind);

  return (
    <section className="block">
      <legend>O que está sendo decidido</legend>
      <div className="grid-3 readonly">
        <div>
          <span className="field-label">Alteração</span>
          <p>{budgetChange}</p>
        </div>
        <div>
          <span className="field-label">Exposição até o fim do mês</span>
          <p className="mono">{formatBrl(approval.amountCents)}</p>
        </div>
        <div>
          <span className="field-label">Motivo da aprovação</span>
          <p>{APPROVAL_TRIGGER_LABEL[approval.trigger]}</p>
        </div>
        <div>
          <span className="field-label">Conta</span>
          <p>
            {approval.platform.toUpperCase()} — {approval.accountName}
          </p>
          <span className="cell-sub">{approval.accountExternalId}</span>
        </div>
        <div>
          <span className="field-label">Campanha</span>
          <p>{approval.campaignName}</p>
          <span className="cell-sub">
            orçamento{' '}
            {approval.budgetLevel === 'ad_set'
              ? 'no conjunto de anúncios (ABO)'
              : approval.budgetLevel === 'campaign'
                ? 'na campanha (CBO)'
                : 'não definido'}
          </span>
        </div>
        <div>
          <span className="field-label">Solicitado por</span>
          <p>
            {approval.requestedByAgent
              ? 'Agente de tráfego pago'
              : (approval.requestedByName ?? '—')}
          </p>
          <span className="cell-sub">{formatDateTime(approval.requestedAt)}</span>
        </div>
      </div>
      {approval.requestReason && (
        <p className="field-hint">Justificativa: {approval.requestReason}</p>
      )}
    </section>
  );
}

function PeriodContext({ approval }: { approval: ApprovalDetail }) {
  const remaining = Math.max(
    0,
    Math.min(
      approval.periodUsableCents - approval.periodCommittedCents,
      approval.periodCapCents - approval.periodSpentCents - approval.periodCommittedCents,
    ),
  );
  return (
    <section className="block">
      <legend>Orçamento do mês nesta conta</legend>
      <div className="grid-3 readonly">
        <div>
          <span className="field-label">Teto</span>
          <p className="mono">{formatBrl(approval.periodCapCents)}</p>
        </div>
        <div>
          <span className="field-label">Utilizável (70%)</span>
          <p className="mono">{formatBrl(approval.periodUsableCents)}</p>
        </div>
        <div>
          <span className="field-label">Já gasto</span>
          <p className="mono">{formatBrl(approval.periodSpentCents)}</p>
        </div>
        <div>
          <span className="field-label">Comprometido</span>
          <p className="mono">{formatBrl(approval.periodCommittedCents)}</p>
        </div>
        <div>
          <span className="field-label">Ainda disponível</span>
          <p className="mono">{formatBrl(remaining)}</p>
        </div>
      </div>
    </section>
  );
}

export function ApprovalDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: user } = useSession();
  const query = useApproval(id);
  const decide = useDecideApproval(id ?? '');
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);

  const approval = query.data?.approval;
  const canDecide = hasPermission(user, 'ads.approve');
  const open = approval?.status === 'pending' || approval?.status === 'escalated';

  if (query.isLoading) return <div className="page-loading">Carregando…</div>;
  if (query.isError || !approval) {
    return (
      <>
        <header className="page-header">
          <h1>Aprovação</h1>
        </header>
        <Alert kind="error">Solicitação não encontrada.</Alert>
        <p>
          <Link to="/trafego-pago/aprovacoes">Voltar às aprovações</Link>
        </p>
      </>
    );
  }

  const submit = async (decision: 'approved' | 'rejected') => {
    setReasonError(null);
    // Rejecting requires a reason; approving does not.
    if (decision === 'rejected' && reason.trim().length < 3) {
      setReasonError('Informe o motivo da recusa');
      return;
    }
    await decide.mutateAsync({ decision, reason: reason.trim() || undefined });
  };

  const failure = decide.error instanceof ApiError ? decide.error : null;

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>Aprovação de orçamento</h1>
          <p>
            {APPROVAL_STATUS_LABEL[approval.status]}
            {approval.escalatedAt && ` · escalada em ${formatDateTime(approval.escalatedAt)}`}
          </p>
        </div>
        <Link to="/trafego-pago/aprovacoes" className="btn btn-ghost btn-inline">
          Voltar
        </Link>
      </header>

      {approval.notificationError && (
        <Alert kind="error">
          A notificação por WhatsApp falhou ({approval.notificationError}). A solicitação continua
          aguardando decisão.
        </Alert>
      )}

      <Summary approval={approval} />
      <PeriodContext approval={approval} />

      {open && canDecide && (
        <section className="block">
          <legend>Sua decisão</legend>
          <Field
            label="Motivo"
            error={reasonError ?? undefined}
            hint="Obrigatório para recusar; opcional para aprovar."
          >
            <Input
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: dentro do plano do mês"
            />
          </Field>

          {failure && <Alert kind="error">{failure.message}</Alert>}

          <div className="form-actions">
            <Button
              type="button"
              disabled={decide.isPending}
              onClick={() => void submit('approved')}
            >
              {decide.isPending ? 'Enviando…' : 'Aprovar'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={decide.isPending}
              onClick={() => void submit('rejected')}
            >
              Recusar
            </Button>
          </div>
        </section>
      )}

      {open && !canDecide && (
        <Alert kind="info">
          Apenas Admin Master ou Diretoria podem decidir sobre alterações de orçamento.
        </Alert>
      )}

      {!open && (
        <Alert kind={approval.status === 'approved' ? 'success' : 'info'}>
          {APPROVAL_STATUS_LABEL[approval.status]}
          {approval.decidedByName && ` por ${approval.decidedByName}`}
          {approval.decidedAt && ` em ${formatDateTime(approval.decidedAt)}`}
          {approval.decisionReason && ` — “${approval.decisionReason}”`}
        </Alert>
      )}

      <section className="block">
        <legend>Trilha de auditoria</legend>
        {approval.auditTrail.length === 0 ? (
          <p className="muted">Sem registros.</p>
        ) : (
          <ol className="audit-trail">
            {approval.auditTrail.map((entry, index) => (
              <li key={`${entry.at}-${index}`}>
                <strong>{AUDIT_LABEL[entry.action] ?? entry.action}</strong>
                <span className="cell-sub">
                  {formatDateTime(entry.at)}
                  {entry.actorName ? ` · ${entry.actorName}` : ''}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
