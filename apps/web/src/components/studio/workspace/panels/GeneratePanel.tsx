import type { MediaImageUse } from '@wings/shared';
import { useState } from 'react';
import { useGenerations } from '../../../../api/media.js';
import { GenerationForm, type AiTarget } from '../../../media-studio/GenerationForm.js';
import { GenerationProgress } from '../../../media-studio/GenerationProgress.js';
import { Button } from '../../../ui.js';
import type { StudioSession } from '../../session.js';

/**
 * The generation form, folded to what a person needs while editing. The
 * price still comes first: "Estimar" and then "Gerar (custo)". A picture
 * selected on the canvas can be the reference of a variation or of an edit.
 */
export function GeneratePanel({
  session,
  canGenerate,
  anyAvailable,
}: {
  session: StudioSession;
  canGenerate: boolean;
  anyAvailable: boolean;
}) {
  const [following, setFollowing] = useState<string[]>([]);
  const [target, setTarget] = useState<AiTarget | null>(null);
  const recent = useGenerations();
  const picked = session.selectedImageForAi;

  const aim = (use: MediaImageUse) => {
    if (!picked) return;
    if (!picked.mediaAssetId) {
      session.setNotice({
        kind: 'info',
        text: 'Esta imagem não está na biblioteca de mídia; o provedor só recebe imagens da biblioteca. Envie o arquivo pela biblioteca e tente de novo.',
      });
      return;
    }
    setTarget({ mediaAssetId: picked.mediaAssetId, use, name: picked.name, nonce: Date.now() });
  };

  return (
    <>
      {picked && (
        <div className="ws-ai-target" role="group" aria-label="A imagem selecionada">
          <span className="muted">Selecionada: {picked.name}</span>
          <div className="ws-ai-actions">
            <Button
              type="button"
              variant="ghost"
              disabled={!canGenerate}
              onClick={() => aim('reference')}
            >
              Gerar variação
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!canGenerate}
              onClick={() => aim('edit')}
            >
              Editar com IA
            </Button>
          </div>
        </div>
      )}
      <GenerationForm
        compact
        canGenerate={canGenerate}
        connected={anyAvailable}
        defaultClientId={session.clientId}
        aiTarget={target}
        onStarted={(id) => setFollowing((current) => [id, ...current])}
      />
      {following.length > 0 && (
        <section className="media-progress-list" aria-label="Gerações em andamento">
          {following.map((id) => (
            <GenerationProgress
              key={id}
              id={id}
              onDismiss={() => setFollowing((current) => current.filter((item) => item !== id))}
            />
          ))}
        </section>
      )}
      {(recent.data?.generations ?? []).some((generation) => generation.status === 'succeeded') && (
        <p className="field-hint">
          O que ficou pronto está na Biblioteca, com o botão "Adicionar" para trazer à tela.
        </p>
      )}
    </>
  );
}
