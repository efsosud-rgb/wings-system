import type { MediaAsset, MediaImageUse } from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../../api/client.js';
import { useGeneration, useGenerations } from '../../../../api/media.js';
import { GenerationForm, type AiTarget } from '../../../media-studio/GenerationForm.js';
import { GenerationProgress } from '../../../media-studio/GenerationProgress.js';
import { Button } from '../../../ui.js';
import type { StudioSession } from '../../session.js';

/**
 * The generation form, folded to what a person needs while editing. The
 * price still comes first: "Estimar" and then "Gerar (custo)". A picture
 * selected on the canvas can be the reference of a variation or of an edit;
 * an edit, once done, takes the picture's place on the canvas.
 */

/**
 * Follows an edit of a picture on the canvas and, when it is done, puts the
 * result in that picture's clip: same place, size, layer and timing, one
 * undoable step (`replaceImage`). Only once, and only on success.
 */
function ReplaceWhenDone({
  session,
  generationId,
  clipId,
}: {
  session: StudioSession;
  generationId: string;
  clipId: string;
}) {
  const generation = useGeneration(generationId).data?.generation;
  const done = useRef(false);
  const assetId = generation?.status === 'succeeded' ? generation.assetIds[0] : undefined;

  useEffect(() => {
    if (!assetId || done.current) return;
    done.current = true;
    void (async () => {
      const { assets } = await api.get<{ assets: MediaAsset[] }>('/media/assets?kind=image');
      const made = assets.find((asset) => asset.id === assetId);
      if (!made) {
        session.setNotice({
          kind: 'info',
          text: 'A imagem editada está na Biblioteca; traga-a para a tela por lá.',
        });
        return;
      }
      if (await session.replaceImage(clipId, { kind: 'media-asset', asset: made })) {
        session.setNotice({
          kind: 'success',
          text: 'A imagem editada entrou no lugar da original. Ctrl+Z volta a anterior.',
        });
      }
    })();
  }, [assetId, clipId, session]);
  return null;
}

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
  /** The clip an "Editar com IA" was aimed at: its next generation lands there. */
  const [editing, setEditing] = useState<string | null>(null);
  /** Generation id → the clip its result replaces. */
  const [landing, setLanding] = useState<Record<string, string>>({});
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
    setEditing(use === 'edit' ? (session.selected?.clipId ?? null) : null);
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
      {editing && (
        <p className="field-hint">
          Editando a imagem selecionada: o resultado entra no lugar dela na tela, e Ctrl+Z volta a
          anterior.
        </p>
      )}
      <GenerationForm
        compact
        canGenerate={canGenerate}
        connected={anyAvailable}
        defaultClientId={session.clientId}
        aiTarget={target}
        onStarted={(id) => {
          setFollowing((current) => [id, ...current]);
          if (editing) {
            setLanding((current) => ({ ...current, [id]: editing }));
            setEditing(null);
          }
        }}
      />
      {Object.entries(landing).map(([generationId, clipId]) => (
        <ReplaceWhenDone
          key={generationId}
          session={session}
          generationId={generationId}
          clipId={clipId}
        />
      ))}
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
