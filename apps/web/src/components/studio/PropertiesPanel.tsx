import {
  STUDIO_POSITIONS,
  STUDIO_TRANSITIONS,
  type StudioPosition,
  type StudioTransition,
} from '@wings/shared';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui.js';
import { STUDIO_FONTS, clipTypeLabel } from './clips.js';
import type { ClipPatch, StudioSession } from './session.js';

/**
 * Properties of the selected item. Every field writes one undoable command
 * into the core through `updateSelected`; the text box waits for a pause in
 * the typing so a sentence is one command, not thirty.
 */

const POSITION_LABEL: Record<StudioPosition, string> = {
  topLeft: 'Acima à esquerda',
  top: 'Acima',
  topRight: 'Acima à direita',
  left: 'Esquerda',
  center: 'Centro',
  right: 'Direita',
  bottomLeft: 'Abaixo à esquerda',
  bottom: 'Abaixo',
  bottomRight: 'Abaixo à direita',
};

const TRANSITION_LABEL: Record<StudioTransition, string> = {
  none: 'Nenhuma',
  fade: 'Esmaecer',
  fadeSlow: 'Esmaecer lento',
  fadeFast: 'Esmaecer rápido',
};

const WEIGHTS = [300, 400, 500, 600, 700, 800] as const;
const TEXT_DEBOUNCE_MS = 300;

const pct = (value: number) => Math.round(value * 100);

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step,
  unit,
  onCommit,
}: {
  id: string;
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  onCommit: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const next = Number(text.replace(',', '.'));
    if (!Number.isFinite(next) || next === value) return;
    onCommit(next);
  };
  return (
    <label className="studio-prop" htmlFor={id}>
      <span>
        {label}
        {unit ? ` (${unit})` : ''}
      </span>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        value={text}
        min={min}
        max={max}
        step={step}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
        }}
      />
    </label>
  );
}

export function PropertiesPanel({ session }: { session: StudioSession }) {
  const { selected, mode } = session;
  const [draftText, setDraftText] = useState(selected?.text?.text ?? '');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A new selection shows its own words; a pending edit of the old one is dropped.
  useEffect(() => {
    setDraftText(selected?.text?.text ?? '');
    if (timer.current) clearTimeout(timer.current);
  }, [selected?.clipId, selected?.text?.text]);

  if (!selected) {
    return (
      <div className="studio-props studio-props-empty">
        <p className="muted">
          Selecione um item na tela ou na linha do tempo para ver as propriedades.
        </p>
      </div>
    );
  }

  const patch = (next: ClipPatch) => void session.updateSelected(next);
  const onText = (value: string) => {
    setDraftText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => patch({ text: { text: value } }), TEXT_DEBOUNCE_MS);
  };
  const isMedia = selected.assetType === 'video' || selected.assetType === 'audio';

  return (
    <div className="studio-props" aria-label="Propriedades do item">
      <header className="studio-props-head">
        <span className="studio-props-kind">{clipTypeLabel(selected.assetType)}</span>
        <strong className="studio-props-name">
          {selected.assetName ?? selected.text?.text ?? ''}
        </strong>
      </header>

      <NumberField
        id="prop-start"
        label="Início"
        unit="s"
        value={Math.round(selected.start * 100) / 100}
        min={0}
        step={0.1}
        onCommit={(value) => patch({ start: value })}
      />
      {mode === 'video' && (
        <NumberField
          id="prop-length"
          label="Duração"
          unit="s"
          value={Math.round(selected.length * 100) / 100}
          min={0.1}
          step={0.1}
          onCommit={(value) => patch({ length: value })}
        />
      )}

      <fieldset className="studio-prop-grid">
        <legend>Posição</legend>
        {STUDIO_POSITIONS.map((position) => (
          <button
            key={position}
            type="button"
            className="studio-prop-cell"
            aria-label={POSITION_LABEL[position]}
            aria-pressed={selected.position === position}
            onClick={() => patch({ position })}
          />
        ))}
      </fieldset>

      <NumberField
        id="prop-offset-x"
        label="Deslocamento X"
        unit="%"
        value={pct(selected.offset.x)}
        min={-100}
        max={100}
        step={1}
        onCommit={(value) => patch({ offset: { x: value / 100, y: selected.offset.y } })}
      />
      <NumberField
        id="prop-offset-y"
        label="Deslocamento Y"
        unit="%"
        value={pct(selected.offset.y)}
        min={-100}
        max={100}
        step={1}
        onCommit={(value) => patch({ offset: { x: selected.offset.x, y: value / 100 } })}
      />
      <NumberField
        id="prop-scale"
        label="Escala"
        unit="%"
        value={pct(selected.scale)}
        min={1}
        max={1000}
        step={1}
        onCommit={(value) => patch({ scale: value / 100 })}
      />
      <NumberField
        id="prop-opacity"
        label="Opacidade"
        unit="%"
        value={pct(selected.opacity)}
        min={0}
        max={100}
        step={1}
        onCommit={(value) => patch({ opacity: value / 100 })}
      />

      {(['in', 'out'] as const).map((side) => (
        <label key={side} className="studio-prop" htmlFor={`prop-transition-${side}`}>
          <span>{side === 'in' ? 'Transição de entrada' : 'Transição de saída'}</span>
          <select
            id={`prop-transition-${side}`}
            value={selected.transition[side]}
            onChange={(event) =>
              patch({ transition: { [side]: event.target.value as StudioTransition } })
            }
          >
            {STUDIO_TRANSITIONS.map((transition) => (
              <option key={transition} value={transition}>
                {TRANSITION_LABEL[transition]}
              </option>
            ))}
          </select>
        </label>
      ))}

      {isMedia && selected.volume !== null && (
        <NumberField
          id="prop-volume"
          label="Volume"
          unit="%"
          value={pct(selected.volume)}
          min={0}
          max={100}
          step={5}
          onCommit={(value) => patch({ volume: value / 100 })}
        />
      )}

      {selected.text && (
        <>
          <label className="studio-prop" htmlFor="prop-text">
            <span>Texto</span>
            <textarea
              id="prop-text"
              rows={3}
              value={draftText}
              onChange={(event) => onText(event.target.value)}
            />
          </label>
          <label className="studio-prop" htmlFor="prop-font">
            <span>Fonte</span>
            <select
              id="prop-font"
              value={selected.text.fontFamily}
              onChange={(event) => patch({ text: { fontFamily: event.target.value } })}
            >
              {[...new Set([selected.text.fontFamily, ...STUDIO_FONTS])].map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            id="prop-font-size"
            label="Tamanho"
            value={selected.text.size}
            min={1}
            max={500}
            step={1}
            onCommit={(value) => patch({ text: { size: value } })}
          />
          <label className="studio-prop" htmlFor="prop-font-weight">
            <span>Peso</span>
            <select
              id="prop-font-weight"
              value={String(selected.text.weight)}
              onChange={(event) => patch({ text: { weight: Number(event.target.value) } })}
            >
              {[...new Set([selected.text.weight, ...WEIGHTS])].map((weight) => (
                <option key={weight} value={String(weight)}>
                  {weight}
                </option>
              ))}
            </select>
          </label>
          <label className="studio-prop" htmlFor="prop-font-color">
            <span>Cor</span>
            <input
              id="prop-font-color"
              type="color"
              value={selected.text.color}
              onChange={(event) => patch({ text: { color: event.target.value } })}
            />
          </label>
          <label className="studio-prop" htmlFor="prop-align-h">
            <span>Alinhamento horizontal</span>
            <select
              id="prop-align-h"
              value={selected.text.horizontal}
              onChange={(event) =>
                patch({ text: { horizontal: event.target.value as 'left' | 'center' | 'right' } })
              }
            >
              <option value="left">Esquerda</option>
              <option value="center">Centro</option>
              <option value="right">Direita</option>
            </select>
          </label>
          <label className="studio-prop" htmlFor="prop-align-v">
            <span>Alinhamento vertical</span>
            <select
              id="prop-align-v"
              value={selected.text.vertical}
              onChange={(event) =>
                patch({ text: { vertical: event.target.value as 'top' | 'middle' | 'bottom' } })
              }
            >
              <option value="top">Acima</option>
              <option value="middle">Meio</option>
              <option value="bottom">Abaixo</option>
            </select>
          </label>
        </>
      )}

      {selected.caption && (
        <fieldset className="studio-prop-group">
          <legend>Legenda</legend>
          <label className="studio-prop" htmlFor="prop-caption-font">
            <span>Fonte</span>
            <select
              id="prop-caption-font"
              value={selected.caption.fontFamily}
              onChange={(event) => patch({ caption: { fontFamily: event.target.value } })}
            >
              {[...new Set([selected.caption.fontFamily, ...STUDIO_FONTS])].map((font) => (
                <option key={font} value={font}>
                  {font}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            id="prop-caption-size"
            label="Tamanho da letra"
            unit="px"
            value={selected.caption.size}
            min={8}
            max={400}
            step={2}
            onCommit={(value) => patch({ caption: { size: value } })}
          />
          <label className="studio-prop" htmlFor="prop-caption-placement">
            <span>Posição</span>
            <select
              id="prop-caption-placement"
              value={selected.caption.placement}
              onChange={(event) =>
                patch({ caption: { placement: event.target.value as 'top' | 'middle' | 'bottom' } })
              }
            >
              <option value="bottom">Terço inferior</option>
              <option value="middle">Centro</option>
              <option value="top">Terço superior</option>
            </select>
          </label>
          <label className="studio-prop" htmlFor="prop-caption-color">
            <span>Cor da letra</span>
            <input
              id="prop-caption-color"
              type="color"
              value={selected.caption.color}
              onChange={(event) => patch({ caption: { color: event.target.value } })}
            />
          </label>
          <label className="studio-prop" htmlFor="prop-caption-background">
            <span>Cor do fundo</span>
            <input
              id="prop-caption-background"
              type="color"
              value={selected.caption.backgroundColor}
              onChange={(event) => patch({ caption: { backgroundColor: event.target.value } })}
            />
          </label>
          <NumberField
            id="prop-caption-background-opacity"
            label="Opacidade do fundo"
            unit="%"
            value={pct(selected.caption.backgroundOpacity)}
            min={0}
            max={100}
            step={5}
            onCommit={(value) => patch({ caption: { backgroundOpacity: value / 100 } })}
          />
        </fieldset>
      )}

      {selected.assetType === 'svg' && (
        <label className="studio-prop" htmlFor="prop-fill">
          <span>Cor</span>
          <input
            id="prop-fill"
            type="color"
            value={selected.fill ?? '#e95228'}
            onChange={(event) => patch({ fill: event.target.value })}
          />
        </label>
      )}

      <Button type="button" variant="ghost" onClick={() => void session.deleteSelected()}>
        Remover
      </Button>
    </div>
  );
}
