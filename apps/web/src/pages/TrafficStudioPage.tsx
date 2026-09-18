import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { StudioLayout, StudioToolGroup } from '../components/StudioLayout.js';
import { Alert } from '../components/ui.js';

/**
 * Studio for the Wings paid-traffic agent.
 *
 * Phase 0 puts the room in place: the conversation pane is a placeholder and
 * the tools panel links to what already works — the approvals gate and the
 * campaign report. No agent logic lives here.
 */
export function TrafficStudioPage() {
  const { data: user } = useSession();
  const canApprove = hasPermission(user, 'ads.approve');

  return (
    <StudioLayout
      title="Agente de Tráfego Pago — Wings"
      subtitle="Conta Fly High · toda alteração de orçamento passa por aprovação humana"
      notice={
        <Alert kind="info">
          O agente ainda não conversa. As ferramentas ao lado já operam sobre a conta real.
        </Alert>
      }
      tools={
        <>
          <StudioToolGroup title="Orçamento">
            <Link
              to="/marketing/trafego-pago-wings/aprovacoes"
              className="btn btn-ghost btn-inline"
            >
              Aprovações de orçamento
            </Link>
            <p className="field-hint">
              {canApprove
                ? 'Você pode aprovar ou recusar alterações.'
                : 'Somente Admin Master ou Diretoria decidem sobre orçamento.'}
            </p>
          </StudioToolGroup>

          <StudioToolGroup title="Desempenho">
            <Link to="/dashboard/marketing" className="btn btn-ghost btn-inline">
              Relatório de campanhas
            </Link>
            <p className="field-hint">
              Gasto, CTR, CPL e alertas ficam no Dashboard — é relatório, não studio.
            </p>
          </StudioToolGroup>

          <StudioToolGroup title="Em breve">
            <ul className="muted studio-soon-list">
              <li>Briefing e estratégia por conversa</li>
              <li>Propostas de criativo</li>
              <li>Simulação de cenários direto no chat</li>
            </ul>
          </StudioToolGroup>
        </>
      }
    />
  );
}
