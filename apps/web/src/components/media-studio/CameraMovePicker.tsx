import {
  CAMERA_GOAL_LABEL,
  CAMERA_MOVES,
  cameraMoveById,
  cameraMoveSuffix,
  type CameraMoveId,
} from '@wings/shared';
import { Button } from '../ui.js';

/**
 * "Movimento de câmera": one card per move, each with a short looping preview
 * drawn in SVG and moved by CSS (nothing is generated to show it). Choosing a
 * card adds the move's English term to the end of the prompt at estimate time;
 * the person's own text is never touched, and "Remover" takes the move away.
 */

/** A tiny storefront scene the preview moves the camera over. */
function Scene() {
  return (
    <svg viewBox="0 0 120 72" className="camera-scene" aria-hidden="true" focusable="false">
      <rect className="camera-sky" x="-60" y="-40" width="240" height="96" />
      <rect className="camera-ground" x="-60" y="56" width="240" height="60" />
      <g className="camera-back">
        <rect x="-40" y="34" width="22" height="22" rx="1" />
        <rect x="138" y="30" width="26" height="26" rx="1" />
      </g>
      <g className="camera-subject">
        <rect x="38" y="20" width="44" height="36" rx="1" />
        <rect className="camera-sign" x="42" y="24" width="36" height="6" rx="1" />
        <rect className="camera-door" x="54" y="40" width="12" height="16" />
      </g>
      <g className="camera-front">
        <circle cx="22" cy="54" r="5" />
        <rect x="20" y="58" width="4" height="10" />
      </g>
    </svg>
  );
}

export function CameraMovePicker({
  value,
  onChange,
  disabled = false,
}: {
  value: CameraMoveId | null;
  onChange: (next: CameraMoveId | null) => void;
  disabled?: boolean;
}) {
  const chosen = value ? cameraMoveById(value) : undefined;
  return (
    <div className="camera-moves" role="group" aria-labelledby="camera-moves-title">
      <div className="camera-moves-head">
        <span id="camera-moves-title" className="field-label">
          Movimento de câmera (opcional)
        </span>
        {chosen && (
          <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange(null)}>
            Remover movimento
          </Button>
        )}
      </div>
      {chosen && (
        <p className="field-hint" role="status">
          Entra no fim do prompt: <span className="mono">{cameraMoveSuffix(chosen)}</span>
        </p>
      )}
      <div className="camera-move-grid">
        {CAMERA_MOVES.map((move) => (
          <label key={move.id} className="camera-move-card">
            <input
              type="radio"
              className="sr-only"
              name="camera-move"
              value={move.id}
              checked={value === move.id}
              disabled={disabled}
              onChange={() => onChange(move.id)}
            />
            <span className={`camera-preview camera-preview--${move.id}`}>
              <Scene />
            </span>
            <span className="camera-move-name">{move.name}</span>
            <span className="camera-move-term mono" lang="en">
              {move.term}
            </span>
            <span className="camera-move-when">{move.whenToUse}</span>
            <span className="camera-move-goals">
              Bom para: {move.goals.map((goal) => CAMERA_GOAL_LABEL[goal]).join(', ')}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}
