import type { ReactNode } from 'react';
import { AudioIcon, CloseIcon, LibraryIcon, ShapesIcon, SparkIcon, TextIcon } from './icons.js';

/**
 * The rail on the left: five doors into the project, one open at a time. A
 * second click on the open one closes its panel and gives the stage the room.
 */

export const RAIL_PANELS = ['library', 'generate', 'text', 'elements', 'audio'] as const;
export type RailPanel = (typeof RAIL_PANELS)[number];

export const RAIL_LABEL: Record<RailPanel, string> = {
  library: 'Biblioteca',
  generate: 'Gerar com IA',
  text: 'Texto',
  elements: 'Elementos',
  audio: 'Áudio',
};

const ICON: Record<RailPanel, () => ReactNode> = {
  library: LibraryIcon,
  generate: SparkIcon,
  text: TextIcon,
  elements: ShapesIcon,
  audio: AudioIcon,
};

export function Rail({
  open,
  onToggle,
}: {
  open: RailPanel | null;
  onToggle: (panel: RailPanel) => void;
}) {
  return (
    <nav className="ws-rail" aria-label="Painéis">
      {RAIL_PANELS.map((panel) => {
        const Icon = ICON[panel];
        return (
          <button
            key={panel}
            type="button"
            className={`ws-rail-btn${open === panel ? ' ws-rail-on' : ''}`}
            aria-pressed={open === panel}
            aria-controls={`ws-panel-${panel}`}
            onClick={() => onToggle(panel)}
          >
            <Icon />
            <span>{RAIL_LABEL[panel]}</span>
          </button>
        );
      })}
    </nav>
  );
}

/** The frame every rail panel sits in: a title, a close button, the content. */
export function RailPanelFrame({
  panel,
  onClose,
  children,
}: {
  panel: RailPanel;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <section className="ws-panel" id={`ws-panel-${panel}`} aria-label={RAIL_LABEL[panel]}>
      <header className="ws-panel-head">
        <h2>{RAIL_LABEL[panel]}</h2>
        <button type="button" className="ws-icon-btn" aria-label="Fechar painel" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      <div className="ws-panel-body">{children}</div>
    </section>
  );
}
