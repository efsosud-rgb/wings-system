import {
  STUDIO_ASPECTS,
  STUDIO_ASPECT_KEYS,
  STUDIO_SHORTCUTS,
  type StudioAspect,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { ClientSelect } from '../../media-studio/MediaLibrary.js';
import { Button } from '../../ui.js';
import type { StudioMode, StudioSession } from '../session.js';
import { HelpIcon, RedoIcon, UndoIcon } from './icons.js';

/**
 * The bar across the top: what the piece is (name, client, format, mode) on
 * the left, what happens to it (undo, open, save, export) on the right. The
 * credits line sits between them so the price of the next generation is in
 * view before any panel opens.
 */

export type TopBarDialog = 'new' | 'open' | 'save' | 'export' | 'shortcuts';

export function TopBar({
  session,
  usageLine,
  onDialog,
}: {
  session: StudioSession;
  /** "Kairogen 94 créditos · mês R$ 12,00 de R$ 300,00", or null while unknown. */
  usageLine: string | null;
  onDialog: (dialog: TopBarDialog) => void;
}) {
  const ready = session.status === 'ready' && session.busy === null;
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(session.projectName);
  const nameInput = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editingName) nameInput.current?.select();
  }, [editingName]);

  const commitName = () => {
    const next = draft.trim();
    if (next !== '' && next !== session.projectName) session.setProjectName(next);
    setEditingName(false);
  };

  const changeAspect = (aspect: StudioAspect) => {
    if (session.mode === 'image') void session.cropToAspect(aspect);
    else void session.setAspect(aspect);
  };

  const modeRefused = (mode: StudioMode) =>
    mode === 'image' && session.mode === 'video' && session.assets.some((a) => a.kind !== 'image')
      ? 'Tire o vídeo e o áudio da linha do tempo para editar como imagem.'
      : null;

  return (
    <div className="ws-bar" role="toolbar" aria-label="Projeto">
      <div className="ws-bar-left">
        {editingName ? (
          <input
            ref={nameInput}
            className="ws-name-input"
            aria-label="Nome do projeto"
            value={draft}
            maxLength={120}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitName();
              if (event.key === 'Escape') {
                setDraft(session.projectName);
                setEditingName(false);
              }
            }}
          />
        ) : (
          <button
            type="button"
            className="ws-name"
            title="Renomear o projeto"
            onClick={() => {
              setDraft(session.projectName);
              setEditingName(true);
            }}
          >
            {session.projectName}
            {session.dirty && (
              <span className="ws-dirty" aria-label="alterações não salvas">
                •
              </span>
            )}
          </button>
        )}

        <label className="ws-client">
          <span className="ws-label">Para quem</span>
          <ClientSelect
            value={session.clientId ?? ''}
            allLabel="Wings Company"
            onChange={(next) => session.setClientId(next === '' ? null : next)}
          />
        </label>

        <div className="ws-segment" role="group" aria-label="Formato">
          {STUDIO_ASPECT_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              className={`ws-segment-btn${session.aspect === key ? ' ws-segment-on' : ''}`}
              aria-pressed={session.aspect === key}
              disabled={!ready}
              title={STUDIO_ASPECTS[key].label}
              onClick={() => changeAspect(key)}
            >
              {key}
            </button>
          ))}
        </div>

        <div className="ws-segment" role="group" aria-label="Tipo de peça">
          {(['image', 'video'] as const).map((mode) => {
            const refused = modeRefused(mode);
            return (
              <button
                key={mode}
                type="button"
                className={`ws-segment-btn${session.mode === mode ? ' ws-segment-on' : ''}`}
                aria-pressed={session.mode === mode}
                disabled={!ready || refused !== null}
                title={
                  refused ??
                  (mode === 'image'
                    ? 'Peça estática: camadas e exportação em PNG ou JPG'
                    : 'Peça em vídeo: linha do tempo e exportação em MP4')
                }
                onClick={() => session.setMode(mode)}
              >
                {mode === 'image' ? 'Imagem' : 'Vídeo'}
              </button>
            );
          })}
        </div>
      </div>

      {usageLine && (
        <span className="ws-usage muted" aria-label="Créditos e teto do mês">
          {usageLine}
        </span>
      )}

      <div className="ws-bar-right">
        <span className="ws-group">
          <button
            type="button"
            className="ws-icon-btn"
            aria-label="Desfazer"
            title="Desfazer (Ctrl+Z)"
            disabled={!ready || !session.canUndo}
            onClick={() => void session.undo()}
          >
            <UndoIcon />
          </button>
          <button
            type="button"
            className="ws-icon-btn"
            aria-label="Refazer"
            title="Refazer (Ctrl+Shift+Z)"
            disabled={!ready || !session.canRedo}
            onClick={() => void session.redo()}
          >
            <RedoIcon />
          </button>
        </span>
        <span className="ws-group">
          <Button type="button" variant="ghost" disabled={!ready} onClick={() => onDialog('new')}>
            Novo
          </Button>
          <Button type="button" variant="ghost" disabled={!ready} onClick={() => onDialog('open')}>
            Abrir do Drive
          </Button>
          <Button type="button" variant="ghost" disabled={!ready} onClick={() => onDialog('save')}>
            Salvar no Drive
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!ready}
            onClick={() => onDialog('export')}
          >
            Exportar
          </Button>
        </span>
        <button
          type="button"
          className="ws-icon-btn"
          aria-label="Atalhos do teclado"
          title={`Atalhos: ${STUDIO_SHORTCUTS.map((item) => item.keys).join(', ')}`}
          onClick={() => onDialog('shortcuts')}
        >
          <HelpIcon />
        </button>
      </div>
    </div>
  );
}
