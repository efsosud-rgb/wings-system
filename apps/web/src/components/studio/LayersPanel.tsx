import { Button } from '../ui.js';
import { clipTypeLabel } from './clips.js';
import type { StudioSession } from './session.js';

/**
 * Image mode's stand-in for the timeline: one row per item, the top of the
 * list on top of the picture. Up and down move the item across tracks; the
 * core keeps the rest.
 */

const ICON: Record<string, string> = {
  image: 'I',
  video: 'V',
  audio: 'A',
  'rich-text': 'T',
  text: 'T',
  title: 'T',
  svg: 'F',
  caption: 'L',
  'rich-caption': 'L',
};

export function LayersPanel({ session }: { session: StudioSession }) {
  const { layers } = session;
  if (layers.length === 0) {
    return (
      <div className="studio-layers studio-layers-empty">
        <p className="muted">
          Abra uma imagem da biblioteca ou gere uma com IA; texto e logo entram como camadas por
          cima.
        </p>
      </div>
    );
  }
  return (
    <div className="studio-layers">
      <ul className="studio-layer-list" aria-label="Camadas">
        {layers.map((layer) => (
          <li
            key={layer.clipId}
            className={layer.selected ? 'studio-layer studio-layer-selected' : 'studio-layer'}
          >
            <button
              type="button"
              className="studio-layer-pick"
              aria-pressed={layer.selected}
              onClick={() => session.selectClip(layer.clipId)}
            >
              <span className="studio-layer-icon" aria-hidden="true">
                {ICON[layer.assetType] ?? '·'}
              </span>
              <span className="studio-layer-label">
                {layer.label}
                <span className="cell-sub">{clipTypeLabel(layer.assetType)}</span>
              </span>
            </button>
            {layer.selected && (
              <span className="studio-layer-actions">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={layer.trackIndex === 0}
                  onClick={() => void session.moveSelected('up')}
                >
                  Subir
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => void session.moveSelected('down')}
                >
                  Descer
                </Button>
                <Button type="button" variant="ghost" onClick={() => void session.deleteSelected()}>
                  Remover
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
