import { KAIROGEN_PLAN_LABEL, formatBrl, isGenerationOver } from '@wings/shared';
import { Suspense, lazy, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { hasPermission, useSession } from '../api/auth.js';
import {
  BUILDER_DRAFT_KEY,
  useGenerations,
  useMediaProviders,
  useMediaStudio,
} from '../api/media.js';
import { AgentChat } from '../components/agent-chat/AgentChat.js';
import { GenerationForm } from '../components/media-studio/GenerationForm.js';
import { GenerationProgress } from '../components/media-studio/GenerationProgress.js';
import { MediaLibrary } from '../components/media-studio/MediaLibrary.js';
import { ProviderStrip } from '../components/media-studio/ProviderStrip.js';
import { StudioLayout, StudioToolGroup } from '../components/StudioLayout.js';
import { Alert } from '../components/ui.js';

// The editor core is a megabyte the agent tab never needs.
const StudioEditor = lazy(() =>
  import('../components/studio/StudioEditor.js').then((m) => ({ default: m.StudioEditor })),
);

const TABS = [
  { key: 'agent', label: 'Agente e biblioteca' },
  { key: 'studio', label: 'Studio' },
] as const;
type TabKey = (typeof TABS)[number]['key'];

/**
 * Marketing → Edição de Fotos e Vídeos. The operator's form and the library in
 * the large pane, the editing agent on the side. Every generation costs credits,
 * so every generation is a click on a button that names its cost.
 */

/** What the campaign builder last had on screen, so the agent can propose media that fits it. */
function campaignDraft(): Record<string, unknown> | undefined {
  try {
    const stored = sessionStorage.getItem(BUILDER_DRAFT_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const count = (value: number) => value.toLocaleString('pt-BR');

export function MediaStudioPage() {
  const { data: user } = useSession();
  const canGenerate = hasPermission(user, 'marketing.media.generate');
  const canUseInBuilder = hasPermission(user, 'ads.request');
  const canConnect = hasPermission(user, 'integrations.manage');
  const canEdit = hasPermission(user, 'marketing.media.edit');
  const [tab, setTab] = useState<TabKey>('agent');
  const studio = useMediaStudio();
  const recent = useGenerations();
  const [following, setFollowing] = useState<string[]>([]);

  // Generations still running when the page opens are followed too.
  const running = recent.data?.generations;
  useEffect(() => {
    const ids = (running ?? [])
      .filter((generation) => !isGenerationOver(generation.status))
      .map((generation) => generation.id);
    if (ids.length > 0) setFollowing((current) => [...new Set([...ids, ...current])]);
  }, [running]);

  const follow = (id: string) =>
    setFollowing((current) => [id, ...current.filter((item) => item !== id)]);
  const state = studio.data;
  const usage = state?.usage ?? null;
  const connected = state?.connected ?? false;
  // Older answers say only whether Kairogen is connected; with providers, any one of them will do.
  const anyAvailable = state?.anyAvailable ?? connected;
  const providers = useMediaProviders(Boolean(state));

  return (
    <StudioLayout
      title="Agente de Edição — Wings"
      subtitle="Imagens e vídeos para os anúncios. Cada geração tem um custo, mesmo quando é R$ 0, e só acontece no seu clique, com o custo antes."
      notice={
        <>
          {state && !anyAvailable && (
            <Alert kind="info">
              Nenhum provedor de mídia está disponível. O Kairogen não está conectado e os outros
              provedores não têm chave neste ambiente ou esgotaram a cota. Peça a um Admin Master
              para ver em Administração → Integrações.{' '}
              {canConnect && <Link to="/administracao/integracoes">Abrir Integrações</Link>}
            </Alert>
          )}
          {state && anyAvailable && !connected && (
            <Alert kind="info">
              O Kairogen não está conectado; os outros provedores continuam disponíveis.{' '}
              {canConnect && <Link to="/administracao/integracoes">Abrir Integrações</Link>}
            </Alert>
          )}
          {state && !state.storageAvailable && (
            <Alert kind="error">
              O armazenamento de mídia não está configurado neste ambiente. Nada pode ser salvo na
              biblioteca.
            </Alert>
          )}
        </>
      }
      workspace={
        <>
          <div className="studio-tabs" role="tablist" aria-label="Edição">
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
            {tab === 'studio' ? (
              canEdit ? (
                <Suspense fallback={<p className="muted">Abrindo o editor…</p>}>
                  <StudioEditor />
                </Suspense>
              ) : (
                <Alert kind="info">
                  O Studio é de quem edita vídeo no Marketing. Peça a permissão "Editar vídeos no
                  Studio" a um Admin Master.
                </Alert>
              )
            ) : (
              <div className="media-studio">
                <dl className="media-usage" aria-label="Créditos">
                  <div>
                    <dt>Saldo no Kairogen</dt>
                    <dd className="mono">
                      {usage?.balance != null
                        ? `${count(usage.balance)} créditos`
                        : 'não informado'}
                    </dd>
                  </div>
                  <div>
                    <dt>Plano</dt>
                    <dd>{usage ? KAIROGEN_PLAN_LABEL[usage.plan] : '—'}</dd>
                  </div>
                  <div>
                    <dt>Você hoje</dt>
                    <dd className="mono">
                      {usage
                        ? `${count(usage.usedTodayByYou)} de ${count(usage.dailyLimitPerUser)} créditos`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Wings no mês</dt>
                    <dd className="mono">
                      {usage
                        ? `${count(usage.usedThisMonth)} de ${count(usage.monthlyLimit)} créditos`
                        : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Todos os provedores no mês</dt>
                    <dd className="mono">
                      {usage
                        ? `${formatBrl(usage.usedThisMonthBrlCents ?? 0)} de ${formatBrl(usage.monthlyLimitBrlCents ?? 0)}`
                        : '—'}
                    </dd>
                  </div>
                </dl>
                {providers.data && <ProviderStrip providers={providers.data.providers} />}

                <GenerationForm
                  canGenerate={canGenerate}
                  connected={anyAvailable}
                  onStarted={follow}
                />

                {following.length > 0 && (
                  <section className="media-progress-list" aria-label="Gerações em andamento">
                    {following.map((id) => (
                      <GenerationProgress
                        key={id}
                        id={id}
                        onDismiss={() =>
                          setFollowing((current) => current.filter((item) => item !== id))
                        }
                      />
                    ))}
                  </section>
                )}

                <MediaLibrary
                  canGenerate={canGenerate && anyAvailable}
                  canUseInBuilder={canUseInBuilder}
                  onStarted={follow}
                />
              </div>
            )}
          </div>
        </>
      }
      conversation={
        <AgentChat
          scope="media"
          tab="media"
          title="Agente de Edição Wings"
          canRequest={false}
          canGenerate={canGenerate}
          getBuilderDraft={campaignDraft}
          emptyHint="Peça uma imagem ou um vídeo para uma campanha, pergunte quanto custa um modelo ou o que já existe na biblioteca."
          standingHint="O agente lê, estima e propõe no provedor mais barato que atende. Nada é gerado daqui sem o seu clique, e o custo aparece antes."
        />
      }
      tools={
        <StudioToolGroup title="Campanhas">
          <Link to="/marketing/trafego-pago-wings" className="btn btn-ghost btn-inline">
            Construtor de campanha
          </Link>
          <p className="field-hint">
            A mídia da biblioteca entra no construtor pelo botão "Escolher da biblioteca".
          </p>
        </StudioToolGroup>
      }
    />
  );
}
