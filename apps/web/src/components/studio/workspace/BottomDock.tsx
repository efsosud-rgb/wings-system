import {
  CAPTION_ZONE_LABEL,
  STUDIO_CAPTION_LAYOUT_STATE_LABEL,
  STUDIO_TRANSCRIPTION_STATE_LABEL,
} from '@wings/shared';
import { useState } from 'react';
import { Dialog } from '../../drive/DriveParts.js';
import { Button } from '../../ui.js';
import { LayersPanel } from '../LayersPanel.js';
import type { StudioSession } from '../session.js';
import { CaptionsIcon } from './icons.js';

/**
 * Under the stage: the timeline for a video, the layers for an image. The
 * timeline's host stays in the DOM in both modes, hidden, because the core
 * keeps its own DOM inside it.
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
  const [smart, setSmart] = useState(true);
  const isVideo = spoken.find((asset) => asset.id === assetId)?.kind === 'video';
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
        {isVideo && (
          <>
            <label className="media-check">
              <input
                type="checkbox"
                checked={smart}
                onChange={(event) => setSmart(event.target.checked)}
              />
              <span>Legenda inteligente: fugir de rostos e de textos do vídeo</span>
            </label>
            <p className="field-hint">
              Nosso servidor olha alguns quadros de cada trecho e põe a legenda embaixo, em cima ou
              no meio, onde estiver livre, sem trocar de lugar por menos de 2 segundos. Sem custo.
              Guarda só a posição escolhida, nunca o rosto.
            </p>
          </>
        )}
        <div className="studio-save-actions">
          <Button
            type="button"
            disabled={assetId === ''}
            onClick={() => {
              void session.requestCaptions(assetId, language || undefined, isVideo && smart);
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
  const layout = transcription?.layout ?? null;
  const video = session.mode === 'video';

  return (
    <section className="ws-dock" aria-label={video ? 'Linha do tempo' : 'Camadas'}>
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
                  {layout && (layout.state === 'pending' || layout.state === 'running') ? (
                    <>
                      · {STUDIO_CAPTION_LAYOUT_STATE_LABEL[layout.state]}…{' '}
                      <button
                        type="button"
                        className="link-button"
                        disabled={!ready}
                        onClick={() => void session.addCaptionsFromTranscription({ plain: true })}
                      >
                        Não esperar: pôr embaixo
                      </button>
                    </>
                  ) : (
                    <>
                      {layout?.state === 'done' && layout.files.length > 0 && (
                        <>
                          · {STUDIO_CAPTION_LAYOUT_STATE_LABEL.done}:{' '}
                          {layout.files
                            .map((file) => CAPTION_ZONE_LABEL[file.zone])
                            .join(', ')}{' '}
                        </>
                      )}
                      {layout?.state === 'failed' && (
                        <span className="muted">
                          · {STUDIO_CAPTION_LAYOUT_STATE_LABEL.failed}, a legenda vai embaixo.{' '}
                        </span>
                      )}
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
      {!video && <LayersPanel session={session} />}
      {asking && <CaptionsDialog session={session} onClose={() => setAsking(false)} />}
    </section>
  );
}
