import { STUDIO_TRANSCRIPTION_STATE_LABEL } from '@wings/shared';
import { useState } from 'react';
import { Dialog } from '../../drive/DriveParts.js';
import { Button } from '../../ui.js';
import type { StudioSession } from '../session.js';
import { CaptionsIcon } from './icons.js';

/**
 * Under the stage: the timeline, for a video. An image has nothing here (its
 * layers are ordered from the selected item's properties); the timeline's host
 * stays in the DOM, hidden, because the core keeps its own DOM inside it.
 */

const LANGUAGES = [
  { value: '', label: 'Detectar o idioma' },
  { value: 'pt', label: 'Português' },
  { value: 'en', label: 'Inglês' },
  { value: 'es', label: 'Espanhol' },
];

function CaptionsDialog({ session, onClose }: { session: StudioSession; onClose: () => void }) {
  const spoken = session.assets.filter((asset) => asset.kind === 'video' || asset.kind === 'audio');
  const [assetId, setAssetId] = useState(spoken[0]?.id ?? '');
  const [language, setLanguage] = useState('');
  return (
    <Dialog label="Legendar com Whisper" onClose={onClose}>
      <div className="ws-form">
        <p className="muted">
          A fala do arquivo vira um SRT no Drive, na pasta do próprio arquivo. Depois a legenda
          entra na linha do tempo com um clique. Demora alguns minutos, na fila do worker.
        </p>
        <label className="field">
          <span className="field-label">Arquivo</span>
          <select
            className="control"
            value={assetId}
            onChange={(event) => setAssetId(event.target.value)}
          >
            {spoken.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Idioma</span>
          <select
            className="control"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {LANGUAGES.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <div className="studio-save-actions">
          <Button
            type="button"
            disabled={assetId === ''}
            onClick={() => {
              void session.requestCaptions(assetId, language || undefined);
              onClose();
            }}
          >
            Legendar
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function BottomDock({ session }: { session: StudioSession }) {
  const [asking, setAsking] = useState(false);
  const ready = session.status === 'ready' && session.busy === null;
  const spoken = session.assets.some((asset) => asset.kind === 'video' || asset.kind === 'audio');
  const transcription = session.transcription;
  const video = session.mode === 'video';

  return (
    <section className="ws-dock" aria-label="Linha do tempo" hidden={!video}>
      {video && (
        <div className="ws-dock-tools">
          <Button
            type="button"
            variant="ghost"
            disabled={!ready || !spoken}
            title={
              spoken
                ? 'Transcrever a fala e criar a legenda'
                : 'Coloque um vídeo ou um áudio na linha do tempo para legendar'
            }
            onClick={() => setAsking(true)}
          >
            <CaptionsIcon /> Legendar
          </Button>
          {transcription && (
            <span className="ws-transcription" role="status">
              <strong>{STUDIO_TRANSCRIPTION_STATE_LABEL[transcription.state]}</strong>
              {transcription.state === 'pending' && ' (o worker pega quando estiver livre)'}
              {transcription.state === 'done' && (
                <>
                  {transcription.language && ` · idioma ${transcription.language}`}
                  {transcription.segments !== null && ` · ${transcription.segments} trechos`}{' '}
                  <Button
                    type="button"
                    variant="primary"
                    disabled={!ready}
                    onClick={() => void session.addCaptionsFromTranscription()}
                  >
                    Adicionar legenda à linha do tempo
                  </Button>
                </>
              )}
              {transcription.state === 'failed' && (
                <>
                  {' '}
                  <span className="muted">{transcription.error}</span>{' '}
                  <button type="button" className="link-button" onClick={() => setAsking(true)}>
                    Tentar de novo
                  </button>
                </>
              )}{' '}
              <button
                type="button"
                className="link-button"
                onClick={() => session.dismissTranscription()}
              >
                Fechar
              </button>
            </span>
          )}
        </div>
      )}
      <div
        className="ws-timeline"
        ref={session.timelineRef}
        hidden={!video}
        data-testid="ws-timeline"
      />
      {asking && <CaptionsDialog session={session} onClose={() => setAsking(false)} />}
    </section>
  );
}
