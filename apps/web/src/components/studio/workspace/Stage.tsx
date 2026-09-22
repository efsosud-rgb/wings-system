import { useState, type DragEvent, type ReactNode } from 'react';
import { Alert } from '../../ui.js';
import type { StudioSession } from '../session.js';
import { readDragItem, hasDragItem } from './drag.js';
import { GridIcon, PauseIcon, PlayIcon } from './icons.js';

/**
 * The stage: the core's canvas in the middle, zoom on one side, the guides
 * toggle on the other, and the transport under it when the piece is a video.
 * Anything dragged out of a rail panel lands here at the playhead.
 */

const ZOOM_STEPS = [0.1, 0.15, 0.2, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2];

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
};

function nextZoom(current: number, direction: 1 | -1): number {
  const sorted = ZOOM_STEPS;
  if (direction === 1) return sorted.find((step) => step > current + 0.001) ?? current;
  return [...sorted].reverse().find((step) => step < current - 0.001) ?? current;
}

export function Stage({
  session,
  emptyState,
}: {
  session: StudioSession;
  /** Shown over the canvas while nothing is on it. */
  emptyState: ReactNode;
}) {
  const [guides, setGuides] = useState(false);
  const [over, setOver] = useState(false);
  const ready = session.status === 'ready';
  const empty = ready && session.assets.length === 0 && session.layers.length === 0;

  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setOver(false);
    const item = readDragItem(event);
    if (!item) return;
    if (item.kind === 'drive-file') void session.addDriveFile(item.file, item.folder);
    else void session.addMediaAsset(item.asset);
  };

  return (
    <section className="ws-stage-wrap" aria-label="Tela">
      <div className="ws-stage-tools">
        <div className="ws-zoom" role="group" aria-label="Zoom">
          <button
            type="button"
            className="ws-icon-btn"
            aria-label="Diminuir zoom"
            disabled={!ready}
            onClick={() => session.setZoom(nextZoom(session.zoom, -1))}
          >
            −
          </button>
          <span className="mono ws-zoom-value">{Math.round(session.zoom * 100)}%</span>
          <button
            type="button"
            className="ws-icon-btn"
            aria-label="Aumentar zoom"
            disabled={!ready}
            onClick={() => session.setZoom(nextZoom(session.zoom, 1))}
          >
            +
          </button>
          <button
            type="button"
            className="link-button"
            disabled={!ready}
            onClick={() => session.zoomToFit()}
          >
            Ajustar
          </button>
        </div>
        <button
          type="button"
          className={`ws-icon-btn${guides ? ' ws-icon-on' : ''}`}
          aria-pressed={guides}
          aria-label="Guias de terços"
          title="Guias de terços"
          onClick={() => setGuides((value) => !value)}
        >
          <GridIcon />
        </button>
      </div>

      <div
        className={`ws-stage${over ? ' ws-stage-over' : ''}`}
        onDragOver={(event) => {
          if (!hasDragItem(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
        data-testid="ws-stage"
      >
        <div className="ws-canvas-host" ref={session.stageRef}>
          <div data-shotstack-studio />
        </div>
        {guides && <div className="ws-guides" aria-hidden="true" />}
        {session.status === 'loading' && <div className="ws-stage-cover">Abrindo o editor…</div>}
        {session.status === 'failed' && (
          <div className="ws-stage-cover">
            <Alert kind="error">{session.failure}</Alert>
          </div>
        )}
        {empty && <div className="ws-stage-empty">{emptyState}</div>}
        {over && <div className="ws-drop-hint">Solte para colocar na tela</div>}
      </div>

      {session.mode === 'video' && (
        <div className="ws-transport" role="group" aria-label="Reprodução">
          <button
            type="button"
            className="ws-icon-btn"
            aria-label={session.playing ? 'Pausar' : 'Tocar'}
            disabled={!ready}
            onClick={() => (session.playing ? session.pause() : session.play())}
          >
            {session.playing ? <PauseIcon /> : <PlayIcon />}
          </button>
          <span className="mono">
            {clock(session.playbackTime)} / {clock(session.totalDuration)}
          </span>
          <input
            type="range"
            className="ws-scrub"
            aria-label="Posição"
            min={0}
            max={Math.max(session.totalDuration, 0.01)}
            step={0.05}
            value={Math.min(session.playbackTime, session.totalDuration)}
            disabled={!ready}
            onChange={(event) => session.seek(Number(event.target.value))}
          />
        </div>
      )}
    </section>
  );
}
