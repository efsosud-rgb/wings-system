import type { MediaBridgeResponse } from '@wings/shared';
import { useState } from 'react';
import { ApiError } from '../../api/client.js';
import { useMediaInBuilder } from '../../api/media.js';
import { MediaPicker } from '../media-studio/MediaLibrary.js';
import { Button } from '../ui.js';

/**
 * "Escolher do Drive", beside an upload control. Picking an asset asks the
 * server to make it usable by the builder — the same checks an upload goes
 * through — and hands back the id the variation needs, plus the asset's own id.
 */
export function LibraryPick({
  kind,
  label,
  onPicked,
}: {
  kind: 'image' | 'video';
  label: string;
  onPicked: (picked: MediaBridgeResponse) => void;
}) {
  const bridge = useMediaInBuilder();
  const [open, setOpen] = useState(false);

  return (
    <div className="builder-library-pick">
      <Button
        type="button"
        variant="ghost"
        disabled={bridge.isPending}
        aria-label={`Escolher do Drive — ${label}`}
        onClick={() => setOpen(true)}
      >
        {bridge.isPending ? 'Trazendo da biblioteca…' : 'Escolher do Drive'}
      </Button>
      {bridge.error && (
        <p className="field-error" role="alert">
          {bridge.error instanceof ApiError
            ? bridge.error.message
            : 'Não foi possível usar esta mídia.'}
        </p>
      )}
      {open && (
        <MediaPicker
          title={
            kind === 'video'
              ? 'Escolher um vídeo da biblioteca'
              : 'Escolher uma imagem da biblioteca'
          }
          kind={kind}
          // Ads take PNG and JPEG. A WebP stays visible, so nobody wonders where it went.
          refusal={(asset) =>
            kind === 'image' && asset.mimeType === 'image/webp'
              ? 'WebP não vale para anúncio'
              : null
          }
          onClose={() => setOpen(false)}
          onPick={(asset) => {
            setOpen(false);
            bridge.mutate(asset.id, { onSuccess: onPicked });
          }}
        />
      )}
    </div>
  );
}
