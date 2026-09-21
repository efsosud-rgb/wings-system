import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import { AgentChat } from '../components/agent-chat/AgentChat.js';
import { OwnedChannelsPanel } from '../components/campaign-builder/OwnedChannelsPanel.js';
import {
  PaidMediaBuilder,
  type BuilderBridge,
} from '../components/campaign-builder/PaidMediaBuilder.js';
import { StudioLayout, StudioToolGroup } from '../components/StudioLayout.js';

/**
 * Studio for the Wings paid-traffic agent.
 *
 * The large pane is the campaign builder, in two tabs that share no fields:
 * paid media and owned channels. The conversation sits beside both and stays
 * the same one when the tab changes. Nothing built here reaches an ad platform
 * directly — launching a campaign creates a request for the approvals gate, and
 * what the agent proposes fills the builder only when a person clicks.
 */

const TABS = [
  { key: 'paid', label: 'Mídia paga' },
  { key: 'owned', label: 'Canais próprios' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

export function TrafficStudioPage() {
  const { data: user } = useSession();
  const canApprove = hasPermission(user, 'ads.approve');
  const canRequest = hasPermission(user, 'ads.request');
  const canPublish = hasPermission(user, 'site.publish');
  const [tab, setTab] = useState<TabKey>('paid');
  // Points at the builder while it is on screen, and at nothing otherwise.
  const builder = useRef<BuilderBridge | null>(null);

  return (
    <StudioLayout
      title="Agente de Tráfego — Wings"
      subtitle="Conta Fly High · toda campanha e toda alteração de orçamento passam por aprovação humana"
      conversation={
        <AgentChat
          canRequest={canRequest}
          tab={tab}
          getBuilderDraft={() => builder.current?.getDraft()}
          onApplyCampaign={
            tab === 'paid' ? (proposal) => builder.current?.applyProposal(proposal) : undefined
          }
        />
      }
      workspace={
        <>
          <div className="studio-tabs" role="tablist" aria-label="Tipo de canal">
            {TABS.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                id={`studio-tab-${item.key}`}
                aria-selected={tab === item.key}
                aria-controls={`studio-panel-${item.key}`}
                className={`studio-tab ${tab === item.key ? 'studio-tab-active' : ''}`}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`studio-panel-${tab}`} aria-labelledby={`studio-tab-${tab}`}>
            {tab === 'paid' ? (
              <PaidMediaBuilder canRequest={canRequest} applyRef={builder} />
            ) : (
              <OwnedChannelsPanel canPublish={canPublish} />
            )}
          </div>
        </>
      }
      tools={
        <>
          <StudioToolGroup title="Aprovações">
            <Link
              to="/marketing/trafego-pago-wings/aprovacoes"
              className="btn btn-ghost btn-inline"
            >
              Aprovações
            </Link>
            <p className="field-hint">
              {canApprove
                ? 'Você pode aprovar ou recusar pedidos.'
                : 'Somente Admin Master ou Diretoria decidem.'}
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
        </>
      }
    />
  );
}
