import type { DriveFile, DriveFolder } from '@wings/shared';
import { useState } from 'react';
import { MediaPicker } from '../media-studio/MediaLibrary.js';
import { Button } from '../ui.js';
import { DriveFilePicker } from './DriveFilePicker.js';
import type { StudioSession } from './session.js';

/**
 * What can be done to the picture selected on the canvas: take it off, put
 * another in its place (same place, size, layer and timing, one undoable
 * step), and move it up or down among the layers of an image. "Editar com IA"
 * lives in the Gerar com IA panel, whose result lands here the same way.
 */

export function ImageActions({
  session,
  canGenerate,
}: {
  session: StudioSession;
  canGenerate: boolean;
}) {
  const [picking, setPicking] = useState<'library' | 'drive' | null>(null);
  const [choosing, setChoosing] = useState(false);
  const { selected } = session;
  if (!selected || selected.assetType !== 'image') return null;
  const clipId = selected.clipId;
  const ready = session.busy === null;

  const replaceWith = (item: Parameters<StudioSession['replaceImage']>[1]) => {
    setPicking(null);
    setChoosing(false);
    void session.replaceImage(clipId, item);
  };

  return (
    <div className="studio-image-actions">
      <div className="studio-image-buttons" role="group" aria-label="Imagem selecionada">
        <Button
          type="button"
          variant="ghost"
          disabled={!ready}
          onClick={() => void session.deleteSelected()}
        >
          Remover
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={!ready}
          aria-expanded={choosing}
          onClick={() => setChoosing((value) => !value)}
        >
          Substituir
        </Button>
        {session.mode === 'image' && (
          <>
            <Button
              type="button"
              variant="ghost"
              disabled={!ready || selected.trackIndex === 0}
              onClick={() => void session.moveSelected('up')}
            >
              Trazer para frente
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={!ready}
              onClick={() => void session.moveSelected('down')}
            >
              Enviar para trás
            </Button>
          </>
        )}
      </div>
      {choosing && (
        <div className="studio-image-buttons" role="group" aria-label="Substituir por">
          <Button type="button" variant="ghost" onClick={() => setPicking('library')}>
            Da biblioteca
          </Button>
          <Button type="button" variant="ghost" onClick={() => setPicking('drive')}>
            Do Drive
          </Button>
        </div>
      )}
      {canGenerate && (
        <p className="field-hint">
          Editar com IA: no painel Gerar com IA, com esta imagem selecionada. O resultado entra no
          lugar dela, e Ctrl+Z volta a anterior.
        </p>
      )}
      {picking === 'library' && (
        <MediaPicker
          title="Substituir por uma imagem da biblioteca"
          kind="image"
          onClose={() => setPicking(null)}
          onPick={(asset) => replaceWith({ kind: 'media-asset', asset })}
        />
      )}
      {picking === 'drive' && (
        <DriveFilePicker
          label="Substituir por uma imagem do Drive"
          accept={['image']}
          initialFolderId={session.lastFolder?.id ?? null}
          onClose={() => setPicking(null)}
          onPick={(file: DriveFile, folder: DriveFolder) =>
            replaceWith({ kind: 'drive-file', file, folder })
          }
        />
      )}
    </div>
  );
}
