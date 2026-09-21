import { GENERATION_STATUS_LABEL, isGenerationOver } from '@wings/shared';
import { useEffect, useState } from 'react';
import { useGeneration } from '../../api/media.js';

/**
 * One generation being followed. The server polls Kairogen; this card asks our
 * own route how it stands. A generation that ended badly is shown with its
 * reason and left alone: nothing here ever sends it again.
 */

function elapsed(from: string, to: number): string {
  const seconds = Math.max(0, Math.round((to - new Date(from).getTime()) / 1000));
  return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export function GenerationProgress({ id, onDismiss }: { id: string; onDismiss: () => void }) {
  const query = useGeneration(id);
  const generation = query.data?.generation;
  const over = generation ? isGenerationOver(generation.status) : false;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (over) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [over]);

  if (!generation) {
    return (
      <div className="media-progress" role="status">
        Acompanhando a geração…
      </div>
    );
  }

  const bad = over && generation.status !== 'succeeded';
  return (
    <div className={`media-progress ${bad ? 'media-progress-bad' : ''}`} role="status">
      <div className="media-progress-head">
        <strong>{GENERATION_STATUS_LABEL[generation.status]}</strong>
        <span className="muted">
          {generation.kind === 'video' ? 'Vídeo' : 'Imagem'}
          {generation.model && ` · ${generation.model}`} ·{' '}
          {over && generation.finishedAt
            ? elapsed(generation.createdAt, new Date(generation.finishedAt).getTime())
            : elapsed(generation.createdAt, now)}
        </span>
      </div>
      {!over && <progress className="media-progress-bar" aria-label="Geração em andamento" />}
      {generation.detail && <p>{generation.detail}</p>}
      {generation.status === 'succeeded' && (
        <p>
          {generation.assetIds.length === 1
            ? 'A mídia já está na biblioteca.'
            : `${generation.assetIds.length} mídias já estão na biblioteca.`}
        </p>
      )}
      {generation.status === 'unknown' && <p>Confira no Kairogen antes de gerar de novo.</p>}
      {over && (
        <button type="button" className="link-button" onClick={onDismiss}>
          Dispensar
        </button>
      )}
    </div>
  );
}
